import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export default function BusinessPageHeader({ eyebrow, title, subtitle }) {
  const navigate = useNavigate();

  return (
    <div className="mb-10">
      <button
        onClick={() => navigate('/business/dashboard')}
        className="flex items-center gap-1.5 text-sm font-medium text-[#0C3B5E]/60 hover:text-[#0C3B5E] mb-6 transition-colors"
      >
        <ArrowLeft size={16} /> Back to dashboard
      </button>

      {eyebrow && (
        <p className="font-mono text-xs tracking-widest uppercase text-[#0C3B5E]/50">{eyebrow}</p>
      )}

      <motion.h1
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="font-display font-bold text-4xl md:text-5xl text-[#0C3B5E] mt-3"
      >
        {title}
      </motion.h1>

      {subtitle && <p className="text-[#0C3B5E]/60 mt-3 text-lg">{subtitle}</p>}
    </div>
  );
}