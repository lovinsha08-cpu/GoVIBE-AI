import { useState } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  Compass,
  Sparkles,
  Gift,
  Map,
  Bot
} from "lucide-react";
import AIAssistantChat from "../components/AIAssistantChat";
import VibeMeter from "../components/VibeMeter";
import FloatingAssistantButton from "../components/FloatingAssistantButton";

const actions = [
  {
    id: "trip",
    title: "Plan a New Trip",
    desc: "Create an AI-powered itinerary based on your interests, budget and travel style.",
    icon: Compass,
    path: "/trip/new",
    accent: "#2563EB",
    tint: "#DBEAFE",
  },
  {
    id: "gems",
    title: "Hidden Gems",
    desc: "Discover unique local experiences and places beyond the usual tourist spots.",
    icon: Sparkles,
    // Deep-links straight into Explore's Hidden Gems filter (and its 5
    // category chips) instead of landing on the generic "All" view.
    path: "/explore?filter=hidden",
    accent: "#16A34A",
    tint: "#DCFCE7",
  },
  {
    id: "offers",
    title: "Offers & Deals",
    desc: "Find exclusive experiences and deals from local businesses.",
    icon: Gift,
    path: "/offers",
    accent: "#22C55E",
    tint: "#DBEAFE",
  },
  {
    id: "bookings",
    title: "Booked Itineraries",
    desc: "View and manage your saved trips and previous journeys.",
    icon: Map,
    path: "/itineraries",
    accent: "#0C3B5E",
    tint: "#E6F7ED",
  },
];


export default function TravelerDashboard() {

  const navigate = useNavigate();
  const [assistantOpen, setAssistantOpen] = useState(false);

  return (
    <main className="min-h-screen bg-[#EAF7EF] px-6 py-10 relative overflow-hidden">


      {/* Floating background shapes */}
      <motion.div
        className="absolute top-20 left-[10%] w-32 h-32 rounded-full bg-[#16A34A]/20 blur-xl"
        animate={{ y:[0,-20,0] }}
        transition={{
          duration:6,
          repeat:Infinity,
          ease:"easeInOut"
        }}
      />

      <motion.div
        className="absolute bottom-20 right-[10%] w-40 h-40 rounded-full bg-[#2563EB]/20 blur-xl"
        animate={{ y:[0,25,0] }}
        transition={{
          duration:7,
          repeat:Infinity,
          ease:"easeInOut"
        }}
      />


      {/* Header */}

      <section className="max-w-5xl mx-auto relative z-10">


        <motion.div
          initial={{opacity:0,y:-15}}
          animate={{opacity:1,y:0}}
          transition={{duration:0.6}}
          className="flex items-center gap-3 mb-10"
        >

          <div className="w-12 h-12 rounded-2xl bg-[#0C3B5E] flex items-center justify-center rotate-[-8deg]">
            <Compass 
              className="text-[#22C55E]"
              size={24}
            />
          </div>

          <span className="font-display font-bold text-2xl text-[#0C3B5E]">
            GoVIBE
          </span>

        </motion.div>



        <motion.p
          initial={{opacity:0}}
          animate={{opacity:1}}
          className="font-mono text-xs tracking-widest uppercase text-[#0C3B5E]/50"
        >
          Traveller Dashboard
        </motion.p>


        <motion.h1
          initial={{opacity:0,y:15}}
          animate={{opacity:1,y:0}}
          transition={{delay:0.1}}
          className="font-display font-bold text-5xl text-[#0C3B5E] mt-3"
        >
          Welcome Explorer 👋
        </motion.h1>


        <p className="text-[#0C3B5E]/60 mt-3 text-lg">
          Plan your next adventure with AI-powered travel experiences.
        </p>

        {/* Vibe Meter */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="mt-10 max-w-xs"
        >
          <VibeMeter />
        </motion.div>

        {/* Action Cards */}

        <div className="grid md:grid-cols-2 gap-6 mt-12">

          {actions.map((item,index)=>(
            
            <motion.button

              key={item.id}

              onClick={()=>{
                if(item.path)
                  navigate(item.path);
                else
                  alert("Coming Soon 🚀");
              }}

              initial={{
                opacity:0,
                y:25,
                rotate:index%2===0?-1:1
              }}

              animate={{
                opacity:1,
                y:0,
                rotate:index%2===0?-1:1
              }}

              whileHover={{
                rotate:0,
                scale:1.03,
                y:-5
              }}

              transition={{
                duration:0.5,
                delay:index*0.1
              }}

              className="text-left rounded-3xl p-8 border border-[#0C3B5E]/10 relative overflow-hidden group spring-active"

              style={{
                backgroundColor:item.tint
              }}

            >

              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6"
                style={{
                  backgroundColor:item.accent
                }}
              >

                <item.icon
                  className="text-white"
                  size={26}
                />

              </div>


              <h2 className="font-display font-bold text-2xl text-[#0C3B5E]">
                {item.title}
              </h2>


              <p className="text-[#0C3B5E]/65 mt-3 text-sm leading-relaxed">
                {item.desc}
              </p>


              <div
                className="mt-6 font-semibold text-sm"
                style={{
                  color:item.accent
                }}
              >
                Open →
              </div>


            </motion.button>

          ))}

        </div>



        {/* AI Assistant */}

        <motion.button

          whileHover={{
            scale:1.03,
            y:-4
          }}

          className="mt-10 w-full rounded-3xl p-6 flex items-center gap-5 bg-[#0C3B5E] text-white"

          onClick={() => setAssistantOpen(true)}

        >

          <div className="w-14 h-14 rounded-2xl bg-[#16A34A] flex items-center justify-center">

            <Bot size={28}/>

          </div>


          <div className="text-left">

            <h3 className="font-display font-bold text-2xl">
              AI Travel Assistant
            </h3>

            <p className="text-white/70 text-sm">
              Ask anything about destinations, routes and travel planning.
            </p>

          </div>


        </motion.button>


      </section>

      <AIAssistantChat
        isOpen={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        mode="traveler"
      />

      <FloatingAssistantButton onClick={() => setAssistantOpen(true)} />

    </main>
  );
}