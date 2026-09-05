import { supabaseAdmin } from '../config/supabase.js';
import { generateItinerary, regenerateStop } from '../services/itineraryEngine.service.js';
import { buildItineraryPdfBuffer } from '../services/pdfExport.service.js';
import { searchItineraryReplacementPlaces, replaceItineraryStop } from '../services/itineraryEditing.service.js';
import { rescheduleItineraryStops } from '../services/schedule.service.js';

function normalizePlaceName(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}
function buildWishlistSuggestions(wishlist, stops, destination){
  const used=new Set((stops||[]).map(s=>normalizePlaceName(s.name)));
  return (wishlist||[]).filter(w=>w?.name && !used.has(normalizePlaceName(w.name))).filter(w=>{
    if(!destination||!w.address)return true;
    const d=normalizePlaceName(destination); const a=normalizePlaceName(w.address); return a.includes(d)||normalizePlaceName(w.name).includes(d)||!w.address;
  }).slice(0,6).map(w=>({id:w.place_key,name:w.name,category:w.category,rating:w.rating??null,description:w.description||null,address:w.address||null,maps_url:w.maps_url||null,reason:'Saved in your wishlist — consider adding it when it fits your route and interests.'}));
}

export async function generate(req,res,next){
  try{
    const {trip_id}=req.body;if(!trip_id)return res.status(400).json({error:'trip_id is required'});
    const {data:trip,error:tripError}=await supabaseAdmin.from('trips').select('*').eq('id',trip_id).eq('traveler_id',req.user.id).single();
    if(tripError||!trip)return res.status(404).json({error:'Trip not found'});
    const {data:wishlist}=await supabaseAdmin.from('traveler_wishlist').select('*').eq('traveler_id',req.user.id);
    const result=await generateItinerary(trip);
    result.stops=await rescheduleItineraryStops(result.stops,trip);
    const wishlistSuggestions=buildWishlistSuggestions(wishlist,result.stops,trip.destination);
    result.budgetSummary={...result.budgetSummary,ai_extras:{...(result.budgetSummary?.ai_extras||{}),wishlist_suggestions:wishlistSuggestions}};
    const {count}=await supabaseAdmin.from('itineraries').select('id',{count:'exact',head:true}).eq('trip_id',trip_id);const version=(count||0)+1;
    const {data:saved,error:saveError}=await supabaseAdmin.from('itineraries').insert({trip_id,version,stops:result.stops,budget_summary:{...result.budgetSummary,ai_extras:{...(result.budgetSummary?.ai_extras||{}),journey:result.journey}},total_distance_km:result.totalDistanceKm,total_duration_minutes:result.totalDurationMinutes,generated_by:result.generatedBy}).select().single();
    if(saveError)return res.status(400).json({error:saveError.message});
    await supabaseAdmin.from('trips').update({status:'generated'}).eq('id',trip_id);
    res.status(201).json({itinerary:saved,hiddenGems:result.hiddenGems,wishlistSuggestions});
  }catch(err){next(err)}
}

export async function regenerate(req,res,next){try{const {tripId}=req.params;const stopOrder=parseInt(req.params.stopOrder,10);if(!Number.isFinite(stopOrder))return res.status(400).json({error:'stopOrder must be a number'});const {data:trip,error:tripError}=await supabaseAdmin.from('trips').select('*').eq('id',tripId).eq('traveler_id',req.user.id).single();if(tripError||!trip)return res.status(404).json({error:'Trip not found'});const {data:itinerary,error:itinError}=await supabaseAdmin.from('itineraries').select('*').eq('trip_id',tripId).order('version',{ascending:false}).limit(1).single();if(itinError||!itinerary)return res.status(404).json({error:'No itinerary found for this trip'});const {stops,replacedStop,previousStopName}=await regenerateStop(trip,itinerary,stopOrder);const scheduledStops=await rescheduleItineraryStops(stops,trip);const {data:updated,error:updateError}=await supabaseAdmin.from('itineraries').update({stops:scheduledStops}).eq('id',itinerary.id).select().single();if(updateError)return res.status(400).json({error:updateError.message});res.json({itinerary:updated,replacedStop:scheduledStops.find(s=>s.order===replacedStop.order)||replacedStop,previousStopName,routeRecalculated:true,scheduleRecalculated:true})}catch(err){next(err)}}

export async function searchReplacementPlaces(req,res,next){try{const {tripId}=req.params;const query=String(req.query.q||'').trim();if(query.length<2)return res.status(400).json({error:'Search query must contain at least 2 characters.'});const {data:trip,error:tripError}=await supabaseAdmin.from('trips').select('*').eq('id',tripId).eq('traveler_id',req.user.id).single();if(tripError||!trip)return res.status(404).json({error:'Trip not found'});const {data:itinerary,error:itinError}=await supabaseAdmin.from('itineraries').select('stops').eq('trip_id',tripId).order('version',{ascending:false}).limit(1).single();if(itinError||!itinerary)return res.status(404).json({error:'No itinerary found for this trip'});res.json({places:await searchItineraryReplacementPlaces(trip,query,itinerary.stops||[])})}catch(err){next(err)}}

export async function replace(req,res,next){try{const {tripId}=req.params;const stopOrder=parseInt(req.params.stopOrder,10);if(!Number.isFinite(stopOrder))return res.status(400).json({error:'stopOrder must be a number'});if(!req.body?.place)return res.status(400).json({error:'place is required'});const {data:trip,error:tripError}=await supabaseAdmin.from('trips').select('*').eq('id',tripId).eq('traveler_id',req.user.id).single();if(tripError||!trip)return res.status(404).json({error:'Trip not found'});const {data:itinerary,error:itinError}=await supabaseAdmin.from('itineraries').select('*').eq('trip_id',tripId).order('version',{ascending:false}).limit(1).single();if(itinError||!itinerary)return res.status(404).json({error:'No itinerary found for this trip'});const result=await replaceItineraryStop(trip,itinerary,stopOrder,req.body.place);result.stops=await rescheduleItineraryStops(result.stops,trip);const {data:updated,error:updateError}=await supabaseAdmin.from('itineraries').update({stops:result.stops,budget_summary:result.budgetSummary,total_distance_km:result.totalDistanceKm,total_duration_minutes:result.totalDurationMinutes}).eq('id',itinerary.id).select().single();if(updateError)return res.status(400).json({error:updateError.message});res.json({itinerary:updated,replacedStop:result.replacedStop,previousStopName:result.previousStopName,routeRecalculated:true,scheduleRecalculated:true})}catch(err){next(err)}}

export async function getLatest(req,res,next){try{const {data,error}=await supabaseAdmin.from('itineraries').select('*, trips!inner(traveler_id)').eq('trip_id',req.params.tripId).eq('trips.traveler_id',req.user.id).order('version',{ascending:false}).limit(1).single();if(error)return res.status(404).json({error:'No itinerary found for this trip'});res.json({itinerary:data})}catch(err){next(err)}}

export async function downloadPdf(req,res,next){try{const {tripId}=req.params;const {data:trip,error:tripError}=await supabaseAdmin.from('trips').select('*').eq('id',tripId).eq('traveler_id',req.user.id).single();if(tripError||!trip)return res.status(404).json({error:'Trip not found'});const {data:itinerary,error:itinError}=await supabaseAdmin.from('itineraries').select('*').eq('trip_id',tripId).order('version',{ascending:false}).limit(1).single();if(itinError||!itinerary)return res.status(404).json({error:'No itinerary found for this trip'});const {data:traveler}=await supabaseAdmin.from('travelers').select('full_name').eq('id',req.user.id).single();const pdfBuffer=await buildItineraryPdfBuffer({trip:{...trip,traveler_name:traveler?.full_name||null},itinerary});const safeDestination=(trip.destination||'itinerary').replace(/[^a-z0-9]+/gi,'-');res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="GoVIBE-${safeDestination}.pdf"`);res.setHeader('Content-Length',pdfBuffer.length);res.send(pdfBuffer)}catch(err){next(err)}}
