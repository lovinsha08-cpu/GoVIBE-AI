import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Compass, Search, Heart, Plus, Trash2, Save, MapPin, Star, Clock3, Route, Loader2, ExternalLink, X } from 'lucide-react';
import { api } from '../lib/api';

function sessionExists(){try{return Boolean(JSON.parse(localStorage.getItem('govibe_session')||'null')?.access_token)}catch{return false}}
function placeKey(p){return p.place_key || p.id || `place:${p.name}`}

export default function Explore(){
  const navigate=useNavigate();
  const [destination,setDestination]=useState('');
  const [query,setQuery]=useState('');
  const [places,setPlaces]=useState([]);
  const [wishlist,setWishlist]=useState([]);
  const [builder,setBuilder]=useState([]);
  const [selected,setSelected]=useState(null);
  const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');

  useEffect(()=>{ if(sessionExists()) api.getWishlist().then(r=>setWishlist(r.places||[])).catch(()=>{}); },[]);
  const wishlistKeys=useMemo(()=>new Set(wishlist.map(placeKey)),[wishlist]);
  const builderKeys=useMemo(()=>new Set(builder.map(placeKey)),[builder]);

  async function search(){
    if(query.trim().length<2) return;
    setLoading(true);setError('');setMessage('');
    try{const r=await api.searchExplore(query.trim(),destination.trim());setPlaces(r.places||[]);if(!(r.places||[]).length)setMessage('No matching places found. Try a landmark, museum, beach, park or attraction name.');}
    catch(e){setError(e.message)}finally{setLoading(false)}
  }
  async function toggleWishlist(p){
    if(!sessionExists()){setError('Please sign in as a traveler to save places to your wishlist.');return}
    setError('');
    try{if(wishlistKeys.has(placeKey(p))){await api.removeWishlist(placeKey(p));setWishlist(x=>x.filter(v=>placeKey(v)!==placeKey(p)));setMessage(`${p.name} removed from wishlist.`)}else{const r=await api.addWishlist(p);setWishlist(x=>[r.place||p,...x.filter(v=>placeKey(v)!==placeKey(p))]);setMessage(`${p.name} added to wishlist. It can influence your future AI itineraries.`)}}catch(e){setError(e.message)}
  }
  function addToItinerary(p){if(builderKeys.has(placeKey(p)))return;setBuilder(x=>[...x,p]);setMessage(`${p.name} added to your itinerary.`)}
  function removeFromItinerary(p){setBuilder(x=>x.filter(v=>placeKey(v)!==placeKey(p)))}
  async function saveItinerary(){
    if(!sessionExists()){setError('Please sign in as a traveler to save your itinerary.');return}
    if(!builder.length){setError('Add at least one place before saving.');return}
    setSaving(true);setError('');
    try{const r=await api.saveExploreItinerary({title:`${destination||'My'} Explore Itinerary`,destination:destination||null,stops:builder});setMessage('Your custom itinerary is saved. Open Booked Itineraries to view it.');setBuilder(r.itinerary?.stops||builder)}catch(e){setError(e.message)}finally{setSaving(false)}
  }
  return <main className="min-h-screen bg-[#EAF7EF] text-[#0C3B5E] px-4 sm:px-6 py-6">
    <div className="max-w-6xl mx-auto">
      <header className="flex items-center gap-3 mb-7">
        <button onClick={()=>navigate(-1)} className="p-2 rounded-xl hover:bg-white"><ArrowLeft size={20}/></button>
        <div className="w-10 h-10 rounded-xl bg-[#0C3B5E] flex items-center justify-center"><Compass className="text-[#22C55E]" size={20}/></div>
        <div><p className="font-display font-bold text-xl">Explore</p><p className="text-xs text-[#0C3B5E]/50">Discover places. Build your own trip. Save what you love.</p></div>
      </header>

      <section className="rounded-3xl bg-[#0C3B5E] text-white p-5 sm:p-7 shadow-sm">
        <p className="text-xs uppercase tracking-[.2em] text-[#22C55E] font-semibold">Your discovery space</p>
        <h1 className="font-display text-3xl sm:text-4xl font-bold mt-2">Search anywhere, plan your way.</h1>
        <div className="grid md:grid-cols-[1fr_2fr_auto] gap-3 mt-6">
          <input value={destination} onChange={e=>setDestination(e.target.value)} placeholder="Destination (e.g. Chennai)" className="rounded-2xl px-4 py-3 bg-white/10 border border-white/15 outline-none placeholder:text-white/45"/>
          <div className="relative"><Search className="absolute left-4 top-3.5 text-white/40" size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==='Enter'&&search()} placeholder="Search a place, landmark, beach, museum..." className="w-full rounded-2xl pl-11 pr-4 py-3 bg-white/10 border border-white/15 outline-none placeholder:text-white/45"/></div>
          <button onClick={search} disabled={loading} className="rounded-2xl px-6 py-3 bg-[#22C55E] text-[#062b19] font-bold flex items-center justify-center gap-2">{loading?<Loader2 className="animate-spin" size={18}/>:<Search size={18}/>} Search</button>
        </div>
      </section>

      {(error||message)&&<div className={`mt-4 rounded-2xl px-4 py-3 text-sm ${error?'bg-red-50 text-red-700':'bg-white text-[#0C3B5E]/70'}`}>{error||message}</div>}

      <div className="grid lg:grid-cols-[1fr_360px] gap-6 mt-6">
        <section>
          <div className="flex items-center justify-between mb-3"><h2 className="font-display font-bold text-xl">Discover places</h2><span className="text-xs text-[#0C3B5E]/45">{places.length} results</span></div>
          <div className="space-y-3">
            {places.map(p=><article key={placeKey(p)} className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4">
              <div className="flex gap-4">
                {p.image_url?<img src={p.image_url} alt="" className="w-24 h-24 rounded-xl object-cover shrink-0"/>:<div className="w-24 h-24 rounded-xl bg-[#EAF7EF] flex items-center justify-center shrink-0"><Compass size={24} className="text-[#22C55E]"/></div>}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2"><h3 className="font-display font-bold">{p.name}</h3><button onClick={()=>toggleWishlist(p)} className={`p-2 rounded-xl ${wishlistKeys.has(placeKey(p))?'bg-[#DCFCE7] text-[#16A34A]':'bg-[#EAF7EF] text-[#0C3B5E]/50'}`} title="Wishlist"><Heart size={17} fill={wishlistKeys.has(placeKey(p))?'currentColor':'none'}/></button></div>
                  <div className="flex flex-wrap gap-3 text-xs text-[#0C3B5E]/55 mt-1">{p.rating!=null&&<span className="flex gap-1 items-center"><Star size={11}/> {p.rating}{p.review_count?` (${p.review_count})`:''}</span>}<span>{p.category?.replaceAll('_',' ')}</span></div>
                  {p.description&&<p className="text-sm text-[#0C3B5E]/65 mt-2 line-clamp-2">{p.description}</p>}
                  {p.address&&<p className="text-xs text-[#0C3B5E]/45 mt-2 flex gap-1"><MapPin size={12}/>{p.address}</p>}
                  <div className="flex flex-wrap gap-2 mt-3"><button onClick={()=>setSelected(p)} className="px-3 py-1.5 rounded-xl bg-[#0C3B5E] text-white text-xs font-semibold">View details</button><button onClick={()=>addToItinerary(p)} disabled={builderKeys.has(placeKey(p))} className="px-3 py-1.5 rounded-xl border border-[#0C3B5E]/15 text-xs font-semibold disabled:opacity-40"><Plus size={13} className="inline mr-1"/>{builderKeys.has(placeKey(p))?'Added':'Add to itinerary'}</button>{p.maps_url&&<a href={p.maps_url} target="_blank" rel="noreferrer" className="px-3 py-1.5 rounded-xl border border-[#0C3B5E]/15 text-xs"><ExternalLink size={12} className="inline mr-1"/>Map</a>}</div>
                </div>
              </div>
            </article>)}
            {!places.length&&!loading&&<div className="rounded-2xl border border-dashed border-[#0C3B5E]/15 p-10 text-center text-sm text-[#0C3B5E]/45">Search for a place to start building your own itinerary.</div>}
          </div>
        </section>

        <aside className="lg:sticky lg:top-5 h-fit space-y-4">
          <section className="rounded-3xl bg-white border border-[#0C3B5E]/10 p-5"><div className="flex justify-between items-center"><div><p className="text-xs uppercase tracking-wider text-[#0C3B5E]/40">My itinerary</p><h2 className="font-display font-bold text-xl">Build your trip</h2></div><Route className="text-[#22C55E]"/></div>
            {builder.length?<div className="mt-4 space-y-2">{builder.map((p,i)=><div key={placeKey(p)} className="flex items-center gap-3 rounded-xl bg-[#EAF7EF] p-3"><span className="w-7 h-7 rounded-full bg-[#0C3B5E] text-white text-xs flex items-center justify-center">{i+1}</span><div className="flex-1 min-w-0"><p className="font-semibold text-sm truncate">{p.name}</p><p className="text-[11px] text-[#0C3B5E]/45">{p.category?.replaceAll('_',' ')||'Place'}</p></div><button onClick={()=>removeFromItinerary(p)}><Trash2 size={15} className="text-red-500"/></button></div>)}<p className="text-xs text-[#0C3B5E]/45 mt-3">Save will optimize the order and calculate route distance and travel time.</p><button onClick={saveItinerary} disabled={saving} className="w-full mt-3 rounded-xl bg-[#22C55E] py-3 font-bold flex justify-center gap-2">{saving?<Loader2 className="animate-spin" size={17}/>:<Save size={17}/>} Save itinerary</button></div>:<p className="text-sm text-[#0C3B5E]/45 mt-5">Add places from search results. You control what goes into the trip.</p>}
          </section>
          <section className="rounded-3xl bg-[#0C3B5E] text-white p-5"><div className="flex items-center gap-2"><Heart className="text-[#22C55E]" fill="currentColor" size={18}/><h3 className="font-display font-bold">Wishlist</h3></div><p className="text-xs text-white/55 mt-2">Places you save become a personalization signal for future AI itineraries.</p>{wishlist.length?<div className="mt-4 space-y-2">{wishlist.slice(0,5).map(p=><div key={placeKey(p)} className="flex items-center gap-2 text-sm"><span className="w-1.5 h-1.5 rounded-full bg-[#22C55E]"/><span className="truncate">{p.name}</span></div>)}{wishlist.length>5&&<p className="text-xs text-white/40">+ {wishlist.length-5} more saved</p>}</div>:<p className="text-xs text-white/35 mt-4">Your wishlist is empty.</p>}</section>
        </aside>
      </div>
    </div>

    {selected&&<div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={()=>setSelected(null)}><div className="bg-white rounded-3xl max-w-lg w-full p-6" onClick={e=>e.stopPropagation()}><div className="flex justify-between gap-3"><div><p className="text-xs uppercase tracking-wider text-[#0C3B5E]/40">Place details</p><h2 className="font-display font-bold text-2xl mt-1">{selected.name}</h2></div><button onClick={()=>setSelected(null)}><X/></button></div><div className="flex flex-wrap gap-3 text-sm text-[#0C3B5E]/60 mt-3">{selected.rating!=null&&<span className="flex gap-1"><Star size={14}/> {selected.rating}</span>}<span>{selected.category?.replaceAll('_',' ')}</span></div><p className="text-sm leading-relaxed text-[#0C3B5E]/65 mt-4">{selected.description||'Explore this place and decide whether it belongs in your trip.'}</p>{selected.address&&<p className="text-sm text-[#0C3B5E]/55 mt-4"><MapPin size={14} className="inline mr-1"/>{selected.address}</p>}<div className="flex gap-2 mt-6"><button onClick={()=>{addToItinerary(selected);setSelected(null)}} className="flex-1 rounded-xl bg-[#0C3B5E] text-white py-3 font-semibold">Add to itinerary</button><button onClick={()=>toggleWishlist(selected)} className="rounded-xl border border-[#0C3B5E]/15 px-4"><Heart size={18}/></button></div></div></div>}
  </main>
}
