import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Compass, ArrowLeft } from 'lucide-react';

export default function AuthLayout({ accent = '#2563EB', tint = '#DBEAFE', children, side }) {
  return (
    <div className="min-h-screen flex" style={{ backgroundColor: tint }}>
      {/* Left: form */}
      <div className="w-full lg:w-[55%] flex flex-col px-6 sm:px-12 py-10">
        <div className="flex items-center justify-between mb-10">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-2xl bg-[#0C3B5E] flex items-center justify-center rotate-[-8deg]">
              <Compass className="text-[#22C55E]" size={18} strokeWidth={2.5} />
            </div>
            <span className="font-display font-bold text-lg text-[#0C3B5E]">GoVIBE</span>
          </Link>
          <Link to="/" className="flex items-center gap-1.5 text-sm text-[#0C3B5E]/60 hover:text-[#0C3B5E] transition-colors">
            <ArrowLeft size={16} /> Back home
          </Link>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="w-full max-w-md"
          >
            {children}
          </motion.div>
        </div>
      </div>

      {/* Right: decorative panel */}
      <div
        className="hidden lg:flex w-[45%] items-center justify-center relative overflow-hidden"
        style={{ backgroundColor: accent }}
      >
        <motion.div
          className="absolute w-72 h-72 rounded-full bg-white/10"
          animate={{ scale: [1, 1.15, 1], rotate: [0, 20, 0] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute w-40 h-40 rounded-full bg-white/10 top-20 right-16"
          animate={{ y: [0, 24, 0] }}
          transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
        />
        <div className="relative z-10 text-white px-12 text-center">{side}</div>
      </div>
    </div>
  );
}
