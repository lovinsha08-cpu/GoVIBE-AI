import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Backpack, Store, ArrowUpRight } from 'lucide-react';

const cards = [
  {
    id: 'traveler',
    path: '/traveler',
    icon: Backpack,
    title: 'I\'m a Traveler',
    desc: 'Plan trips, uncover hidden gems, and get an itinerary built around your budget and pace.',
    accent: '#2563EB',
    tint: '#DBEAFE',
  },
  {
    id: 'business',
    path: '/business',
    icon: Store,
    title: 'I run a Business',
    desc: 'List your place, reach travelers actively planning nearby trips, and track what\'s working.',
    accent: '#16A34A',
    tint: '#DCFCE7',
  },
];

export default function LoginChoice() {
  const navigate = useNavigate();

  return (
    <section className="px-6 py-20 max-w-5xl mx-auto">
      <motion.p
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        className="font-mono text-xs tracking-widest uppercase text-[#0C3B5E]/50 text-center mb-3"
      >
        Two sides of the same trip
      </motion.p>
      <motion.h2
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="font-display font-bold text-3xl md:text-4xl text-center text-[#0C3B5E] mb-12"
      >
        Where do you fit in?
      </motion.h2>

      <div className="grid md:grid-cols-2 gap-6">
        {cards.map((card, i) => (
          <motion.button
            key={card.id}
            onClick={() => navigate(card.path)}
            initial={{ opacity: 0, y: 24, rotate: i === 0 ? -1.5 : 1.5 }}
            whileInView={{ opacity: 1, y: 0, rotate: i === 0 ? -1.5 : 1.5 }}
            whileHover={{ rotate: 0, scale: 1.02, y: -4 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: i * 0.12 }}
            className="text-left rounded-3xl p-8 border border-[#0C3B5E]/10 relative overflow-hidden group"
            style={{ backgroundColor: card.tint }}
          >
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6"
              style={{ backgroundColor: card.accent }}
            >
              <card.icon className="text-white" size={26} />
            </div>
            <h3 className="font-display font-bold text-2xl text-[#0C3B5E] mb-2">{card.title}</h3>
            <p className="text-[#0C3B5E]/65 text-sm leading-relaxed mb-6 max-w-xs">{card.desc}</p>
            <div className="flex items-center gap-1.5 font-semibold text-sm" style={{ color: card.accent }}>
              Continue <ArrowUpRight size={16} className="group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
            </div>
          </motion.button>
        ))}
      </div>
    </section>
  );
}
