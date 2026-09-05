import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Compass, Search, Gift, Map, Bot, CalendarDays, MapPin, WalletCards, AlertCircle } from "lucide-react";
import AIAssistantChat from "../components/AIAssistantChat";
import VibeMeter from "../components/VibeMeter";
import FloatingAssistantButton from "../components/FloatingAssistantButton";
import { api } from "../lib/api";

const actions = [
  { id:"trip", title:"Plan a New Trip", desc:"Create an AI-powered itinerary based on your interests, budget and travel style.", icon:Compass, path:"/trip/new", accent:"#2563EB", tint:"#DBEAFE" },
  { id:"explore", title:"Explore", desc:"Search places yourself, build a custom itinerary, and save spots to your wishlist for future AI plans.", icon:Search, path:"/explore", accent:"#16A34A", tint:"#DCFCE7" },
  { id:"offers", title:"Offers & Deals", desc:"Find exclusive experiences and deals from local businesses.", icon:Gift, path:"/offers", accent:"#22C55E", tint:"#DBEAFE" },
  { id:"bookings", title:"Booked Itineraries", desc:"View and manage your saved trips and previous journeys.", icon:Map, path:"/itineraries", accent:"#0C3B5E", tint:"#E6F7ED" },
];

function formatDate(value){
  if(!value)return "Date not set";
  const d=new Date(value); return Number.isNaN(d.getTime())?value:d.toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"});
}

export default function TravelerDashboard(){
  const navigate=useNavigate();
  const [assistantOpen,setAssistantOpen]=useState(false);
  const [trips,setTrips]=useState([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");

  useEffect(()=>{
    let active=true;
    (async()=>{
      try{
        const result=await api.listTrips({sort:"newest"});
        if(active)setTrips(Array.isArray(result?.trips)?result.trips:[]);
      }catch(err){ if(active)setError(err.message||"Could not load your trips."); }
      finally{ if(active)setLoading(false); }
    })();
    return()=>{active=false};
  },[]);

  const generatedCount=trips.filter(t=>t.summary?.has_itinerary||t.status==="generated").length;
  const upcoming=trips.filter(t=>t.start_date&&new Date(t.start_date)>=new Date(new Date().toDateString())).slice(0,3);

  return <main className="min-h-screen bg-[#EAF7EF] px-6 py-10 relative overflow-hidden">
    <motion.div className="absolute top-20 left-[10%] w-32 h-32 rounded-full bg-[#16A34A]/20 blur-xl" animate={{y:[0,-20,0]}} transition={{duration:6,repeat:Infinity,ease:"easeInOut"}}/>
    <motion.div className="absolute bottom-20 right-[10%] w-40 h-40 rounded-full bg-[#2563EB]/20 blur-xl" animate={{y:[0,25,0]}} transition={{duration:7,repeat:Infinity,ease:"easeInOut"}}/>
    <section className="max-w-5xl mx-auto relative z-10">
      <motion.div initial={{opacity:0,y:-15}} animate={{opacity:1,y:0}} transition={{duration:.6}} className="flex items-center gap-3 mb-10"><div className="w-12 h-12 rounded-2xl bg-[#0C3B5E] flex items-center justify-center rotate-[-8deg]"><Compass className="text-[#22C55E]" size={24}/></div><span className="font-display font-bold text-2xl text-[#0C3B5E]">GoVIBE</span></motion.div>
      <motion.p initial={{opacity:0}} animate={{opacity:1}} className="font-mono text-xs tracking-widest uppercase text-[#0C3B5E]/50">Traveller Dashboard</motion.p>
      <motion.h1 initial={{opacity:0,y:15}} animate={{opacity:1,y:0}} transition={{delay:.1}} className="font-display font-bold text-5xl text-[#0C3B5E] mt-3">Welcome Explorer 👋</motion.h1>
      <p className="text-[#0C3B5E]/60 mt-3 text-lg">Plan with AI or take control and build your own adventure.</p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-8">
        {[{label:"Trips planned",value:trips.length,icon:Map},{label:"AI itineraries",value:generatedCount,icon:CalendarDays},{label:"Upcoming trips",value:upcoming.length,icon:MapPin}].map(({label,value,icon:Icon})=><div key={label} className="rounded-2xl bg-white/70 border border-[#0C3B5E]/10 p-5 flex items-center gap-4"><div className="w-10 h-10 rounded-xl bg-[#0C3B5E] text-white flex items-center justify-center"><Icon size={19}/></div><div><div className="text-2xl font-bold text-[#0C3B5E]">{loading?"—":value}</div><div className="text-xs text-[#0C3B5E]/55">{label}</div></div></div>)}
      </div>

      <motion.div initial={{opacity:0}} animate={{opacity:1}} className="mt-8 max-w-xs"><VibeMeter/></motion.div>

      {error && <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex gap-3"><AlertCircle size={18}/><span>{error}</span></div>}

      <div className="grid md:grid-cols-2 gap-6 mt-12">
        {actions.map((item,index)=><motion.button key={item.id} onClick={()=>navigate(item.path)} initial={{opacity:0,y:25,rotate:index%2===0?-1:1}} animate={{opacity:1,y:0,rotate:index%2===0?-1:1}} whileHover={{rotate:0,scale:1.03,y:-5}} transition={{duration:.5,delay:index*.1}} className="text-left rounded-3xl p-8 border border-[#0C3B5E]/10 relative overflow-hidden group spring-active" style={{backgroundColor:item.tint}}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6" style={{backgroundColor:item.accent}}><item.icon className="text-white" size={26}/></div>
          <h2 className="font-display font-bold text-2xl text-[#0C3B5E]">{item.title}</h2><p className="text-[#0C3B5E]/65 mt-3 text-sm leading-relaxed">{item.desc}</p><div className="mt-6 font-semibold text-sm" style={{color:item.accent}}>Open →</div>
        </motion.button>)}
      </div>

      <section className="mt-10 rounded-3xl bg-white/70 border border-[#0C3B5E]/10 p-7">
        <div className="flex items-center justify-between gap-4 mb-5"><div><p className="font-mono text-[10px] uppercase tracking-widest text-[#0C3B5E]/45">Your trips</p><h2 className="font-display font-bold text-2xl text-[#0C3B5E] mt-1">Recent journeys</h2></div><button onClick={()=>navigate("/itineraries")} className="text-sm font-semibold text-[#16A34A]">View all →</button></div>
        {loading?<div className="py-8 text-center text-sm text-[#0C3B5E]/50">Loading your trips…</div>:trips.length===0?<div className="py-8 text-center"><p className="font-semibold text-[#0C3B5E]">No trips yet</p><p className="text-sm text-[#0C3B5E]/55 mt-1">Start planning and your journeys will appear here.</p><button onClick={()=>navigate("/trip/new")} className="mt-4 rounded-xl bg-[#0C3B5E] text-white px-5 py-2.5 text-sm font-semibold">Plan your first trip</button></div>:<div className="space-y-3">{trips.slice(0,3).map(trip=><button key={trip.id} onClick={()=>navigate(`/itineraries/${trip.id}`)} className="w-full text-left rounded-2xl border border-[#0C3B5E]/10 bg-white/70 p-4 flex items-center justify-between gap-4 hover:bg-white transition"><div className="min-w-0"><p className="font-semibold text-[#0C3B5E] truncate">{trip.trip_name||trip.destination||"Untitled trip"}</p><p className="text-xs text-[#0C3B5E]/50 mt-1">{trip.destination} · {formatDate(trip.start_date)}</p></div><div className="flex items-center gap-2 text-xs text-[#0C3B5E]/55"><WalletCards size={15}/>{trip.total_budget_inr?`₹${Number(trip.total_budget_inr).toLocaleString("en-IN")}`:"Budget not set"}</div></button>)}</div>}
      </section>

      <motion.button whileHover={{scale:1.03,y:-4}} className="mt-10 w-full rounded-3xl p-6 flex items-center gap-5 bg-[#0C3B5E] text-white" onClick={()=>setAssistantOpen(true)}><div className="w-14 h-14 rounded-2xl bg-[#16A34A] flex items-center justify-center"><Bot size={28}/></div><div className="text-left"><h3 className="font-display font-bold text-2xl">AI Travel Assistant</h3><p className="text-white/70 text-sm">Ask anything about destinations, routes and travel planning.</p></div></motion.button>
    </section>
    <AIAssistantChat isOpen={assistantOpen} onClose={()=>setAssistantOpen(false)} mode="traveler"/><FloatingAssistantButton onClick={()=>setAssistantOpen(true)}/>
  </main>
}
