const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

function getAuthHeaders(){
  try{const s=JSON.parse(localStorage.getItem('govibe_session')||'null');return s?.access_token?{Authorization:`Bearer ${s.access_token}`}:{}}catch{return {}}
}

async function request(path,options={}){
  let res;
  try{
    res=await fetch(`${BASE_URL}${path}`,{headers:{'Content-Type':'application/json',...getAuthHeaders(),...options.headers},...options});
  }catch(err){
    const e=new Error(`Can't reach the GoVIBE backend at ${BASE_URL}. Make sure the backend server is running and VITE_API_URL points at the right API.`);
    e.code='NETWORK_ERROR'; e.status=0; e.cause=err; throw e;
  }

  const contentType=res.headers.get('content-type')||'';
  const data=contentType.includes('application/json')?await res.json().catch(()=>({})):{};
  if(!res.ok){
    const e=new Error(data.error||data.message||`Request failed (${res.status})`);
    e.code=data.code||`HTTP_${res.status}`;
    e.status=res.status;
    e.details=data.details||null;
    throw e;
  }
  return data;
}

export const api={
 travelerSignup:(p)=>request('/auth/traveler/signup',{method:'POST',body:JSON.stringify(p)}),
 businessSignup:(p)=>request('/auth/business/signup',{method:'POST',body:JSON.stringify(p)}),
 login:(p)=>request('/auth/login',{method:'POST',body:JSON.stringify(p)}),
 forgotPassword:(p)=>request('/auth/forgot-password',{method:'POST',body:JSON.stringify(p)}),
 createTrip:(p)=>request('/trips',{method:'POST',body:JSON.stringify(p)}),
 getTrip:(id)=>request(`/trips/${id}`),
 listTrips:(o={})=>{const p=new URLSearchParams();Object.entries(o).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')p.set(k,String(v))});const q=p.toString();return request(`/trips${q?`?${q}`:''}`)},
 deleteTrip:(id)=>request(`/trips/${id}`,{method:'DELETE'}),
 generateItinerary:(id)=>request('/itinerary/generate',{method:'POST',body:JSON.stringify({trip_id:id})}),
 getLatestItinerary:(id)=>request(`/itinerary/${id}/latest`),
 regenerateStop:(id,o)=>request(`/itinerary/${id}/stop/${o}/regenerate`,{method:'POST'}),
 searchItineraryPlaces:(id,q)=>request(`/itinerary/${id}/places/search?q=${encodeURIComponent(q)}`),
 replaceItineraryStop:(id,o,place)=>request(`/itinerary/${id}/stop/${o}/replace`,{method:'POST',body:JSON.stringify({place})}),
 assistantChat:({tripId,message,history=[],location=null})=>request('/assistant/chat',{method:'POST',body:JSON.stringify({trip_id:tripId,message,history,location})}),
 getAssistantHistory:()=>request('/assistant/history'),
 getEmergencyServices:(id,{lat,lng,anchorName}={})=>{const p=new URLSearchParams();if(lat!=null)p.set('lat',String(lat));if(lng!=null)p.set('lng',String(lng));if(anchorName)p.set('anchor_name',anchorName);const q=p.toString();return request(`/trips/${id}/emergency${q?`?${q}`:''}`)},
 downloadItineraryPdf:async(id)=>{let r;try{r=await fetch(`${BASE_URL}/itinerary/${id}/download`,{headers:getAuthHeaders()})}catch(err){const e=new Error('Unable to reach the GoVIBE backend.');e.code='NETWORK_ERROR';e.status=0;e.cause=err;throw e}if(!r.ok){const d=await r.json().catch(()=>({}));const e=new Error(d.error||`Download failed (${r.status})`);e.code=d.code||`HTTP_${r.status}`;e.status=r.status;throw e}const m=(r.headers.get('Content-Disposition')||'').match(/filename="([^"]+)"/);return{blob:await r.blob(),filename:m?.[1]||'itinerary.pdf'}},
 getSpots:({city,category,hiddenGems,hiddenGemCategory}={})=>{const p=new URLSearchParams();if(city)p.set('city',city);if(hiddenGems){p.set('hiddenGems','true');if(hiddenGemCategory)p.set('hiddenGemCategory',hiddenGemCategory)}else if(category)p.set('category',category);const q=p.toString();return request(`/spots${q?`?${q}`:''}`)},
 getSpotCategories:()=>request('/spots/categories'),getHiddenGemCategories:()=>request('/spots/hidden-gem-categories'),
 searchExplore:(query,destination)=>request(`/explore/search?q=${encodeURIComponent(query)}&destination=${encodeURIComponent(destination||'')}`),
 getWishlist:()=>request('/explore/wishlist'),addWishlist:(place)=>request('/explore/wishlist',{method:'POST',body:JSON.stringify({place})}),removeWishlist:(key)=>request(`/explore/wishlist/${encodeURIComponent(key)}`,{method:'DELETE'}),saveExploreItinerary:(payload)=>request('/explore/itineraries',{method:'POST',body:JSON.stringify(payload)}),getExploreItineraries:()=>request('/explore/itineraries'),
 autocompletePlaces:(query,{limit,signal}={})=>{const p=new URLSearchParams({q:query});if(limit)p.set('limit',String(limit));return request(`/places/autocomplete?${p.toString()}`,{signal})},
 verifyBusinessLocation:(p)=>request('/business-onboarding/verify-location',{method:'POST',body:JSON.stringify(p)}),
 getOffers:(o={})=>{const p=new URLSearchParams();Object.entries(o).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')p.set(k,String(v))});const q=p.toString();return request(`/offers${q?`?${q}`:''}`)},
 getMyOffers:()=>request('/business/offers'),createOffer:(p)=>request('/business/offers',{method:'POST',body:JSON.stringify(p)}),updateOffer:(id,p)=>request(`/business/offers/${id}`,{method:'PUT',body:JSON.stringify(p)}),setOfferStatus:(id,a)=>request(`/business/offers/${id}/status`,{method:'PATCH',body:JSON.stringify({isActive:a})}),deleteOffer:(id)=>request(`/business/offers/${id}`,{method:'DELETE'})
};

export function getCurrentLocation({timeoutMs=8000}={}){return new Promise(resolve=>{if(!navigator.geolocation)return resolve(null);navigator.geolocation.getCurrentPosition(p=>resolve({lat:p.coords.latitude,lng:p.coords.longitude}),()=>resolve(null),{timeout:timeoutMs,maximumAge:300000})})}
export function getPreciseLocation({timeoutMs=10000}={}){return new Promise((resolve,reject)=>{if(!navigator.geolocation)return reject({code:'unsupported',message:'Your browser does not support location access.'});navigator.geolocation.getCurrentPosition(p=>resolve({lat:p.coords.latitude,lng:p.coords.longitude,accuracyMeters:p.coords.accuracy??null}),e=>reject({code:e.code===e.PERMISSION_DENIED?'permission_denied':e.code===e.TIMEOUT?'timeout':'position_unavailable',message:e.message||'Could not get your location.'}),{enableHighAccuracy:true,timeout:timeoutMs,maximumAge:0})})}
export function messageNeedsLocation(text){return /\b(near me|nearby|around me|close by|current location)\b/i.test(text)}
