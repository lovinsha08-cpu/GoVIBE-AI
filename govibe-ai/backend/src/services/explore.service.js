import { env } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';
import { loadSpots } from './spotData.service.js';
import { haversineKm, estimateTravelMinutes } from './geo.service.js';

const GOOGLE_TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const EXCLUDED_TYPES = new Set(['local_government_office','city_hall','courthouse','police','fire_station','hospital','doctor','school','university','bank','atm','post_office','embassy','storage','car_repair','car_dealer','train_station','transit_station','subway_station','bus_station']);
const TOURISM_TYPES = new Set(['tourist_attraction','museum','art_gallery','park','zoo','aquarium','amusement_park','church','hindu_temple','mosque','synagogue','stadium','spa','movie_theater','night_club','bar','natural_feature','point_of_interest']);
const TOURISM_WORDS = ['museum','fort','palace','temple','church','mosque','park','beach','lake','garden','gallery','monument','memorial','zoo','aquarium','planetarium','heritage','waterfall','viewpoint','dam','sanctuary','amusement','theme park','theatre','theater','stadium','promenade','market','mall','shopping','art','cultural'];

function clean(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function tourismPlace(p) {
  const types = p.types || [];
  if (types.some(t => EXCLUDED_TYPES.has(t))) return false;
  if (types.some(t => TOURISM_TYPES.has(t))) return true;
  const hay = `${p.name || ''} ${p.formatted_address || ''}`.toLowerCase();
  return TOURISM_WORDS.some(w => hay.includes(w));
}
function categoryFrom(p) {
  const t = new Set(p.types || []);
  if (t.has('museum') || t.has('art_gallery')) return 'arts_culture';
  if (t.has('church') || t.has('hindu_temple') || t.has('mosque') || t.has('synagogue')) return 'religious_spiritual';
  if (t.has('park') || t.has('natural_feature')) return 'nature_scenic';
  if (t.has('zoo') || t.has('aquarium')) return 'wildlife';
  if (t.has('amusement_park') || t.has('movie_theater') || t.has('stadium')) return 'entertainment_recreation';
  if (t.has('shopping_mall')) return 'shopping';
  if (t.has('spa')) return 'wellness_leisure';
  if (t.has('night_club') || t.has('bar')) return 'nightlife';
  return 'heritage_historical';
}
function normalizeGoogle(p, destination) {
  const lat = p.geometry?.location?.lat, lng = p.geometry?.location?.lng;
  if (!p.name || !Number.isFinite(lat) || !Number.isFinite(lng) || !tourismPlace(p)) return null;
  return { id:`google:${p.place_id}`, place_key:`google:${p.place_id}`, source:'google_places', place_id:p.place_id, name:p.name, category:categoryFrom(p), subcategory:null, description:null, address:p.formatted_address || p.vicinity || null, latitude:lat, longitude:lng, rating:p.rating ?? null, review_count:p.user_ratings_total ?? 0, image_url:null, maps_url:p.place_id ? `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(p.place_id)}` : null, website_url:null, destination };
}
async function googleSearch(q, destination) {
  if (!env.googlePlacesApiKey) return [];
  const url = `${GOOGLE_TEXT_SEARCH_URL}?query=${encodeURIComponent(`${q}, ${destination}`)}&key=${env.googlePlacesApiKey}`;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
  try { const r = await fetch(url,{signal:controller.signal}); if(!r.ok) return []; const d=await r.json(); return d.status === 'OK' ? d.results || [] : []; } catch { return []; } finally { clearTimeout(timer); }
}
export async function searchExplorePlaces({ query, destination }) {
  const q = String(query || '').trim(); const city = String(destination || '').trim();
  if (q.length < 2) return [];
  const out = [];
  for (const p of await googleSearch(q, city)) { const n=normalizeGoogle(p,city); if(n) out.push(n); }
  const { spots=[] } = await loadSpots({ city: city || undefined });
  const nq=clean(q); const seen=new Set(out.map(x=>clean(x.name)));
  for (const s of spots) {
    if (!s?.name || seen.has(clean(s.name))) continue;
    const hay=clean(`${s.name} ${s.category||''} ${s.subcategory||''} ${s.description||''}`);
    if (!hay.includes(nq) && !nq.split(' ').every(t=>hay.includes(t))) continue;
    seen.add(clean(s.name)); out.push({ ...s, id:s.id, place_key:`spot:${s.id}`, source:s.source||'govibe_dataset', review_count:s.review_count ?? null, image_url:s.image_url||null, maps_url:s.latitude&&s.longitude ? `https://www.google.com/maps/search/?api=1&query=${s.latitude},${s.longitude}` : null, website_url:s.booking_url||null });
  }
  return out.slice(0,20);
}
export async function getWishlist(travelerId) {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin.from('traveler_wishlist').select('*').eq('traveler_id', travelerId).order('created_at',{ascending:false});
  if(error) throw error; return data || [];
}
export async function addWishlist(travelerId, place) {
  if (!supabaseAdmin) throw new Error('Supabase is not configured');
  const payload={traveler_id:travelerId, place_key:place.place_key || place.id || `place:${clean(place.name)}`, source:place.source||null, place_id:place.place_id||null, name:place.name, category:place.category||null, subcategory:place.subcategory||null, description:place.description||null, address:place.address||null, latitude:Number.isFinite(place.latitude)?place.latitude:null, longitude:Number.isFinite(place.longitude)?place.longitude:null, rating:place.rating ?? null, review_count:place.review_count ?? null, image_url:place.image_url||null, maps_url:place.maps_url||null, website_url:place.website_url||null};
  const { data,error }=await supabaseAdmin.from('traveler_wishlist').upsert(payload,{onConflict:'traveler_id,place_key'}).select().single();
  if(error) throw error; return data;
}
export async function removeWishlist(travelerId, placeKey) {
  const { error }=await supabaseAdmin.from('traveler_wishlist').delete().eq('traveler_id',travelerId).eq('place_key',placeKey); if(error) throw error;
}
export async function listExploreItineraries(travelerId) {
  const { data,error }=await supabaseAdmin.from('explore_itineraries').select('*').eq('traveler_id',travelerId).order('updated_at',{ascending:false}); if(error) throw error; return data||[];
}
function optimize(stops) {
  const remaining=stops.filter(s=>Number.isFinite(s.latitude)&&Number.isFinite(s.longitude)).map(s=>({...s})); const ordered=[]; let current=null;
  while(remaining.length) { let idx=0; if(current){ let best=Infinity; remaining.forEach((s,i)=>{const d=haversineKm(current.latitude,current.longitude,s.latitude,s.longitude); if(d<best){best=d;idx=i;}}); } const next=remaining.splice(idx,1)[0]; ordered.push(next); current=next; }
  let distance=0, travel=0; ordered.forEach((s,i)=>{ if(i){ const d=Math.round(haversineKm(ordered[i-1].latitude,ordered[i-1].longitude,s.latitude,s.longitude)*10)/10; const mins=Math.max(2,Math.round(estimateTravelMinutes(d,'car'))); distance+=d; travel+=mins; s.distance_km_from_prev=d; s.travel_minutes_from_prev=mins; } else { s.distance_km_from_prev=0; s.travel_minutes_from_prev=0; }});
  return {stops:ordered,total_distance_km:Math.round(distance*10)/10,total_travel_minutes:travel};
}
export async function saveExploreItinerary(travelerId,payload) {
  const optimized=optimize(Array.isArray(payload.stops)?payload.stops:[]);
  const row={traveler_id:travelerId,title:payload.title||'My Explore Itinerary',destination:payload.destination||null,start_date:payload.start_date||null,end_date:payload.end_date||null,transport_mode:payload.transport_mode||'car',stops:optimized.stops,total_distance_km:optimized.total_distance_km,total_travel_minutes:optimized.total_travel_minutes,updated_at:new Date().toISOString()};
  const {data,error}=await supabaseAdmin.from('explore_itineraries').insert(row).select().single(); if(error) throw error; return data;
}
