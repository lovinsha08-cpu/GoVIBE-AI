import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Map, MapPin, Plane } from 'lucide-react';
import GlobeMascot from './GlobeMascot';
import VibeMeter from './VibeMeter';

const pins = [
  { label: 'Munnar', x: '14%', y: '28%', delay: 0.2 },
  { label: 'Alleppey', x: '70%', y: '60%', delay: 0.5 },
];

export default function Hero() {
  const navigate = useNavigate();

  return (
    <section className="relative px-6 pt-10 pb-16 vibe-gradient">
      <div className="max-w-7xl mx-auto grid lg:grid-cols-[1.7fr_1fr] gap-6 items-stretch">

        {/* Left card — welcome copy + mini app preview */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="rounded-[40px] bg-[#EAF7EF]/70 backdrop-blur-md border border-white/40 p-8 sm:p-12 grid md:grid-cols-2 gap-8 items-center overflow-hidden"
        >
          {/* Copy */}
          <div>
            <h1 className="font-display font-bold text-5xl sm:text-6xl leading-[0.95] text-[#0C3B5E]">
              Welcome
              <br />
              Explorer
            </h1>
            <p className="mt-5 text-[#0C3B5E]/70 text-lg max-w-sm">
              Ready to find your next vibe? Our AI helps you discover destinations
              that match your energy, your mood, and your dreams.
            </p>
            <button
              onClick={() => navigate('/trip/new')}
              className="mt-8 inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-6 py-3.5 rounded-full shadow-lg shadow-[#2563EB]/25 transition-colors spring-active"
            >
              <Map size={18} strokeWidth={2.5} />
              Plan a Trip
            </button>
          </div>

          {/* Mini "app preview" frame with mascot + flight path */}
          <motion.div
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="relative rounded-3xl bg-white/80 border border-[#0C3B5E]/10 shadow-xl p-5 h-64 sm:h-72 overflow-hidden"
          >
            {/* fake browser dots */}
            <div className="flex items-center gap-1.5 mb-3">
              <span className="w-2 h-2 rounded-full bg-[#2563EB]/30" />
              <span className="w-2 h-2 rounded-full bg-[#22C55E]/30" />
              <span className="w-2 h-2 rounded-full bg-[#16A34A]/30" />
            </div>

            <svg viewBox="0 0 300 160" className="absolute inset-0 top-10 w-full h-[calc(100%-2.5rem)] overflow-visible opacity-40">
              <motion.path
                d="M 20 110 C 80 40, 140 150, 180 70 S 260 30, 280 80"
                fill="none"
                stroke="#0C3B5E"
                strokeWidth="2"
                strokeDasharray="5 7"
                strokeLinecap="round"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 1.8, delay: 0.4, ease: 'easeInOut' }}
              />
            </svg>
            {pins.map((pin) => (
              <motion.div
                key={pin.label}
                className="absolute flex flex-col items-center gap-0.5"
                style={{ left: pin.x, top: pin.y }}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: [0, -4, 0] }}
                transition={{
                  opacity: { duration: 0.4, delay: pin.delay },
                  y: { duration: 3, repeat: Infinity, ease: 'easeInOut', delay: pin.delay },
                }}
              >
                <MapPin className="text-[#2563EB] fill-[#22C55E]/30" size={18} />
                <span className="font-mono text-[9px] text-[#0C3B5E]/50 whitespace-nowrap">{pin.label}</span>
              </motion.div>
            ))}
            <motion.div
              className="absolute"
              style={{ left: '6%', top: '58%' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, x: [0, 220, 0], y: [0, -18, 0] }}
              transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
            >
              <Plane className="text-[#0C3B5E] rotate-90" size={14} />
            </motion.div>

            <motion.div
              animate={{ y: [0, -8, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute bottom-2 right-2 w-28 h-28 sm:w-32 sm:h-32"
            >
              <GlobeMascot className="w-full h-full" floating={false} />
            </motion.div>
          </motion.div>
        </motion.div>

        {/* Right card — Travel Vibe meter */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15 }}
        >
          <VibeMeter />
        </motion.div>
      </div>
    </section>
  );
}
