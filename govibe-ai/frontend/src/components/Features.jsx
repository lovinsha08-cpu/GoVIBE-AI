import { motion } from 'framer-motion';
import { Gem, Wallet, Radar, ShieldPlus, Sparkles, Store } from 'lucide-react';

const features = [
  { icon: Gem, title: 'Hidden gems', desc: 'Low-crowd, high-rated spots the guidebooks skip — surfaced by real ratings, not ads.', accent: '#2563EB' },
  { icon: Wallet, title: 'Budget-aware planning', desc: 'Enter one number in ₹ and the AI builds your itinerary to fit inside it.', accent: '#22C55E' },
  { icon: Radar, title: 'Live conditions', desc: 'Crowd levels, traffic, and weather folded into your route order — not a static list.', accent: '#16A34A' },
  { icon: ShieldPlus, title: 'Emergency-ready', desc: 'Every stop comes with the nearest clinic, hospital, and emergency contact attached.', accent: '#2563EB' },
  { icon: Sparkles, title: 'AI trip assistant', desc: 'Ask it to reorder your day, swap a spot, or explain why a place was picked.', accent: '#22C55E' },
  { icon: Store, title: 'Verified local business', desc: 'Every listed business passes a genuineness check before it can post offers.', accent: '#16A34A' },
];

export default function Features() {
  return (
    <section className="px-6 py-20 max-w-6xl mx-auto">
      <motion.h2
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="font-display font-bold text-3xl md:text-4xl text-center text-[#0C3B5E] mb-14"
      >
        Built for how trips actually happen
      </motion.h2>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {features.map((f, i) => (
          <motion.div
            key={f.title}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45, delay: (i % 3) * 0.08 }}
            whileHover={{ y: -6 }}
            className="rounded-2xl p-6 bg-white border border-[#0C3B5E]/8 shadow-sm"
          >
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center mb-4"
              style={{ backgroundColor: `${f.accent}1A` }}
            >
              <f.icon style={{ color: f.accent }} size={22} />
            </div>
            <h3 className="font-display font-bold text-lg text-[#0C3B5E] mb-1.5">{f.title}</h3>
            <p className="text-sm text-[#0C3B5E]/60 leading-relaxed">{f.desc}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}