import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Compass, Gift, Tag, Store, CalendarDays, Loader2, ImageOff } from 'lucide-react';
import { api } from '../lib/api';

const CATEGORIES = ['Food', 'Stay', 'Activity', 'Shopping', 'Transport', 'Wellness'];
const DISCOUNT_FILTERS = [
  { key: '', label: 'Any discount' },
  { key: '10', label: '10%+ off' },
  { key: '25', label: '25%+ off' },
  { key: '50', label: '50%+ off' },
];
const VALIDITY_FILTERS = [
  { key: '', label: 'Any validity' },
  { key: 'active', label: 'Valid now' },
  { key: 'ending_soon', label: 'Ending in 7 days' },
];

function formatDiscount(offer) {
  if (!offer.discountValue) return 'Special offer';
  return offer.discountType === 'flat' ? `₹${offer.discountValue} off` : `${offer.discountValue}% off`;
}

function formatValidity(offer) {
  if (!offer.validFrom && !offer.validUntil) return 'Ongoing';
  return `${offer.validFrom || 'Now'} → ${offer.validUntil || 'Ongoing'}`;
}

export default function TravelerOffers() {
  const navigate = useNavigate();
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [category, setCategory] = useState('');
  const [discountMin, setDiscountMin] = useState('');
  const [validity, setValidity] = useState('');
  const [businessName, setBusinessName] = useState('');

  const loadOffers = () => {
    setLoading(true);
    setError('');
    api.getOffers({ category: category || undefined, minDiscount: discountMin || undefined })
      .then((res) => setOffers(res.offers || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  // Re-fetch whenever server-side filters change (category, discount).
  useEffect(() => {
    loadOffers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, discountMin]);

  // Business name + validity are filtered client-side against the fetched set.
  const visibleOffers = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    return offers.filter((o) => {
      if (businessName && !o.businessName.toLowerCase().includes(businessName.toLowerCase())) return false;
      if (validity === 'active' && o.validUntil && o.validUntil < today) return false;
      if (validity === 'ending_soon' && (!o.validUntil || o.validUntil > in7Days || o.validUntil < today)) return false;
      return true;
    });
  }, [offers, businessName, validity]);

  const businessNames = useMemo(
    () => [...new Set(offers.map((o) => o.businessName))].sort(),
    [offers]
  );

  return (
    <main className="min-h-screen bg-[#EAF7EF] px-4 sm:px-6 py-8 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <button onClick={() => navigate('/dashboard')} className="p-1 -ml-1 text-[#0C3B5E]/60">
          <ArrowLeft size={20} />
        </button>
        <div className="w-9 h-9 rounded-xl bg-[#0C3B5E] flex items-center justify-center rotate-[-8deg]">
          <Compass className="text-[#22C55E]" size={16} strokeWidth={2.5} />
        </div>
        <span className="font-display font-bold text-lg text-[#0C3B5E]">Offers & Deals</span>
      </div>

      <p className="text-[#0C3B5E]/60 mb-6 text-sm">
        Exclusive discounts and experiences from local businesses, updated live.
      </p>

      {/* Filters */}
      <div className="space-y-3 mb-6">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setCategory('')}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
              category === '' ? 'bg-[#0C3B5E] text-white border-[#0C3B5E]' : 'bg-white text-[#0C3B5E]/70 border-[#0C3B5E]/10'
            }`}
          >
            All categories
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
                category === c ? 'bg-[#0C3B5E] text-white border-[#0C3B5E]' : 'bg-white text-[#0C3B5E]/70 border-[#0C3B5E]/10'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <select
            value={discountMin}
            onChange={(e) => setDiscountMin(e.target.value)}
            className="text-xs font-medium px-3 py-2 rounded-xl border border-[#0C3B5E]/15 bg-white text-[#0C3B5E]/80 focus:outline-none focus:ring-2 focus:ring-[#2563EB]/40"
          >
            {DISCOUNT_FILTERS.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>

          <select
            value={validity}
            onChange={(e) => setValidity(e.target.value)}
            className="text-xs font-medium px-3 py-2 rounded-xl border border-[#0C3B5E]/15 bg-white text-[#0C3B5E]/80 focus:outline-none focus:ring-2 focus:ring-[#2563EB]/40"
          >
            {VALIDITY_FILTERS.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>

          <select
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            className="text-xs font-medium px-3 py-2 rounded-xl border border-[#0C3B5E]/15 bg-white text-[#0C3B5E]/80 focus:outline-none focus:ring-2 focus:ring-[#2563EB]/40 col-span-2 sm:col-span-1"
          >
            <option value="">All businesses</option>
            {businessNames.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-[#2563EB]" size={28} />
        </div>
      ) : error ? (
        <p className="text-sm text-[#0C3B5E]/60">{error}</p>
      ) : visibleOffers.length === 0 ? (
        <div className="text-center py-16">
          <Gift className="mx-auto text-[#0C3B5E]/20 mb-3" size={36} />
          <p className="text-[#0C3B5E]/50 text-sm">No offers match your filters right now — check back soon.</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {visibleOffers.map((offer, i) => (
            <motion.div
              key={offer.id}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: i * 0.05 }}
              className="rounded-2xl bg-white border border-[#0C3B5E]/10 overflow-hidden"
            >
              <div className="h-32 bg-gradient-to-br from-[#22C55E] to-[#2563EB]/70 flex items-center justify-center relative">
                {offer.image && offer.image !== 'placeholder' ? (
                  <img src={offer.image} alt={offer.title} className="w-full h-full object-cover" />
                ) : (
                  <ImageOff className="text-white/70" size={28} />
                )}
                <span className="absolute top-3 right-3 text-[10px] font-bold px-2.5 py-1 rounded-full bg-white text-[#2563EB] shadow">
                  {formatDiscount(offer)}
                </span>
              </div>

              <div className="p-5">
                <div className="flex items-center gap-1.5 text-xs text-[#0C3B5E]/50 mb-2">
                  <Store size={13} /> {offer.businessName}
                </div>

                <h3 className="font-display font-bold text-lg text-[#0C3B5E]">{offer.title}</h3>
                <p className="text-[#0C3B5E]/60 text-sm mt-1 leading-relaxed">
                  {offer.description || 'No description added.'}
                </p>

                <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-4 text-xs text-[#0C3B5E]/50">
                  <span className="flex items-center gap-1">
                    <Tag size={12} /> {offer.category || 'General'}
                  </span>
                  <span className="flex items-center gap-1">
                    <CalendarDays size={12} /> {formatValidity(offer)}
                  </span>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </main>
  );
}