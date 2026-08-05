import { motion } from 'framer-motion';
import { Eye, CalendarCheck, Gift, ListChecks, Users, Star } from 'lucide-react';
import BusinessPageHeader from '../../components/BusinessPageHeader';
import { getAnalytics } from '../../lib/businessStore';

const STAT_CARDS = [
  { key: 'totalViews', label: 'Total Views', icon: Eye, accent: '#2563EB', tint: '#DBEAFE' },
  { key: 'totalBookings', label: 'Total Bookings', icon: CalendarCheck, accent: '#16A34A', tint: '#DCFCE7' },
  { key: 'totalOffers', label: 'Total Offers', icon: Gift, accent: '#22C55E', tint: '#DBEAFE' },
  { key: 'activeListings', label: 'Active Listings', icon: ListChecks, accent: '#0C3B5E', tint: '#E6F7ED' },
];

export default function BusinessAnalytics() {
  const analytics = getAnalytics();
  const maxVisitors = Math.max(...analytics.monthlyVisitors.map((m) => m.visitors), 1);

  return (
    <main className="min-h-screen bg-[#EAF7EF] px-6 py-10">
      <section className="max-w-5xl mx-auto">
        <BusinessPageHeader
          eyebrow="Analytics"
          title="Your performance"
          subtitle="See how travellers are discovering and engaging with your business."
        />

        {/* Stat cards */}
        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-5">
          {STAT_CARDS.map((card, index) => (
            <motion.div
              key={card.key}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: index * 0.08 }}
              className="rounded-3xl p-6 border border-[#0C3B5E]/10"
              style={{ backgroundColor: card.tint }}
            >
              <div
                className="w-11 h-11 rounded-2xl flex items-center justify-center mb-4"
                style={{ backgroundColor: card.accent }}
              >
                <card.icon size={20} className="text-white" />
              </div>
              <p className="font-display font-bold text-3xl text-[#0C3B5E]">{analytics[card.key]}</p>
              <p className="text-[#0C3B5E]/60 text-sm mt-1">{card.label}</p>
            </motion.div>
          ))}
        </div>

        {/* Monthly visitors chart */}
        <div className="rounded-3xl bg-white border border-[#0C3B5E]/10 p-6 md:p-8 mt-8">
          <div className="flex items-center gap-2 mb-6">
            <Users size={18} className="text-[#16A34A]" />
            <h2 className="font-display font-bold text-xl text-[#0C3B5E]">Monthly visitors</h2>
          </div>

          <div className="flex items-end gap-4 h-48">
            {analytics.monthlyVisitors.map((m, index) => (
              <div key={m.month} className="flex-1 flex flex-col items-center justify-end h-full">
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: `${(m.visitors / maxVisitors) * 100}%` }}
                  transition={{ duration: 0.5, delay: index * 0.08 }}
                  className="w-full rounded-t-xl bg-gradient-to-t from-[#16A34A] to-[#16A34A]/50 min-h-[4px]"
                />
                <span className="text-xs text-[#0C3B5E]/50 mt-2">{m.month}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Popular offer */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mt-8 rounded-3xl p-6 flex items-center gap-5 bg-[#0C3B5E] text-white"
        >
          <div className="w-14 h-14 rounded-2xl bg-[#22C55E] flex items-center justify-center shrink-0">
            <Star size={24} />
          </div>
          <div>
            <p className="text-white/60 text-xs font-mono uppercase tracking-widest">Most popular offer</p>
            <h3 className="font-display font-bold text-2xl mt-1">{analytics.popularOffer}</h3>
          </div>
        </motion.div>
      </section>
    </main>
  );
}