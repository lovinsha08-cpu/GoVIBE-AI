import { useState } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  Gift,
  Store,
  BarChart3,
  MapPin,
  Bot
} from "lucide-react";
import AIAssistantChat from "../components/AIAssistantChat";


const actions = [
  {
    id: "offer",
    title: "Add New Offer",
    desc: "Create discounts, packages, and experiences to attract more travellers.",
    icon: Gift,
    path: "/business/offers",
    accent: "#2563EB",
    tint: "#DBEAFE",
  },
  {
    id: "profile",
    title: "Edit Business Profile",
    desc: "Update your details, photos, location, timings, and services.",
    icon: Store,
    path: "/business/profile",
    accent: "#16A34A",
    tint: "#DCFCE7",
  },
  {
    id: "analytics",
    title: "View Analytics",
    desc: "Track traveller interest, profile views, and offer performance.",
    icon: BarChart3,
    path: "/business/analytics",
    accent: "#22C55E",
    tint: "#DBEAFE",
  },
  {
    id: "listing",
    title: "Manage Listings",
    desc: "Showcase your experiences and keep your business presence updated.",
    icon: MapPin,
    path: "/business/listings",
    accent: "#0C3B5E",
    tint: "#E6F7ED",
  },
];


export default function BusinessDashboard() {

  const navigate = useNavigate();
  const [assistantOpen, setAssistantOpen] = useState(false);

  return (
    <main className="min-h-screen bg-[#EAF7EF] px-6 py-10 relative overflow-hidden">


      {/* Floating shapes */}

      <motion.div
        className="absolute top-20 left-[8%] w-32 h-32 rounded-full bg-[#16A34A]/20 blur-xl"
        animate={{y:[0,-20,0]}}
        transition={{
          duration:6,
          repeat:Infinity,
          ease:"easeInOut"
        }}
      />


      <motion.div
        className="absolute bottom-20 right-[10%] w-40 h-40 rounded-full bg-[#2563EB]/20 blur-xl"
        animate={{y:[0,25,0]}}
        transition={{
          duration:7,
          repeat:Infinity,
          ease:"easeInOut"
        }}
      />



      <section className="max-w-5xl mx-auto relative z-10">


        {/* Logo */}

        <motion.div
          initial={{opacity:0,y:-10}}
          animate={{opacity:1,y:0}}
          className="flex items-center gap-3 mb-10"
        >

          <div className="w-12 h-12 rounded-2xl bg-[#0C3B5E] flex items-center justify-center rotate-[-8deg]">
            <Store 
              className="text-[#22C55E]"
              size={25}
            />
          </div>


          <span className="font-display font-bold text-2xl text-[#0C3B5E]">
            GoVIBE
          </span>

        </motion.div>




        <p className="font-mono text-xs tracking-widest uppercase text-[#0C3B5E]/50">
          Business Dashboard
        </p>


        <motion.h1
          initial={{opacity:0,y:15}}
          animate={{opacity:1,y:0}}
          className="font-display font-bold text-5xl text-[#0C3B5E] mt-3"
        >
          Grow your business 🚀
        </motion.h1>


        <p className="text-[#0C3B5E]/60 mt-3 text-lg">
          Connect with travellers and turn local experiences into memorable journeys.
        </p>




        {/* Cards */}

        <div className="grid md:grid-cols-2 gap-6 mt-12">


          {actions.map((item,index)=>(

            <motion.button

              key={item.id}

              onClick={() => navigate(item.path)}

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


              className="text-left rounded-3xl p-8 border border-[#0C3B5E]/10 overflow-hidden group"

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
                  size={26}
                  className="text-white"
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
                Manage →
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
              AI Business Assistant
            </h3>

            <p className="text-white/70 text-sm">
              Get AI suggestions for offers, visibility, and attracting travellers.
            </p>

          </div>


        </motion.button>



      </section>

      <AIAssistantChat
        isOpen={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        mode="business"
      />

    </main>
  );
}