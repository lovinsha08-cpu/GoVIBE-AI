import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Compass, ArrowLeft, Gem, Star, Ticket, Clock } from 'lucide-react';
import { api } from '../lib/api';
import RealMap from '../components/RealMap';
import { HIDDEN_GEM_CATEGORIES } from '../lib/hiddenGemCategories';

const FILTERS = [
  { key: null, label: 'All' },
  { key: 'heritage', label: 'Attractions' },
  { key: 'stay', label: 'Hotels' },
  { key: 'food', label: 'Restaurants' },
  { key: 'hidden', label: 'Hidden gems' },
];

export default function Explore() {
  const navigate = useNavigate();
  // Lets entry points like the Traveler Dashboard's "Hidden Gems" card
  // deep-link straight into this filter (/explore?filter=hidden) instead
  // of landing on "All" and requiring an extra tap.
  const [searchParams] = useSearchParams();
  const initialFilter = searchParams.get('filter') === 'hidden' ? 'hidden' : null;
  const [spots, setSpots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeFilter, setActiveFilter] = useState(initialFilter);
  const [hiddenGemCategory, setHiddenGemCategory] = useState(null);
  const [source, setSource] = useState('sample');
  const isHiddenGems = activeFilter === 'hidden';

  useEffect(() => {
    setLoading(true);
    setError('');
    const params = isHiddenGems
      ? { hiddenGems: true, hiddenGemCategory }
      : { category: activeFilter };
    api.getSpots(params)
      .then((res) => {
        setSpots(res.spots || []);
        setSource(res.source);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [activeFilter, hiddenGemCategory]);

  return (
    <div className="min-h-screen bg-[#EAF7EF] px-4 sm:px-6 py-8 max-w-2xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <button onClick={() => navigate(-1)} className="p-1 -ml-1 text-[#0C3B5E]/60">
          <ArrowLeft size={20} />
        </button>
        <div className="w-9 h-9 rounded-xl bg-[#0C3B5E] flex items-center justify-center rotate-[-8deg]">
          <Compass className="text-[#22C55E]" size={16} strokeWidth={2.5} />
        </div>
        <span className="font-display font-bold text-lg text-[#0C3B5E]">Explore</span>
      </div>

      {source === 'sample' && (
        <p className="text-[10px] font-mono text-[#0C3B5E]/40 mb-3">
          Showing bundled sample data — connect Supabase and run the seed script for live data.
        </p>
      )}

      <div className="flex flex-wrap gap-2 mb-5">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => {
              setActiveFilter(f.key);
              if (f.key !== 'hidden') setHiddenGemCategory(null);
            }}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
              activeFilter === f.key
                ? 'bg-[#0C3B5E] text-white border-[#0C3B5E]'
                : 'bg-white text-[#0C3B5E]/70 border-[#0C3B5E]/10'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isHiddenGems && (
        <div className="flex flex-wrap gap-2 mb-5 -mt-2">
          {HIDDEN_GEM_CATEGORIES.map((c) => (
            <button
              key={c.label}
              onClick={() => setHiddenGemCategory(c.key)}
              className={`flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
                hiddenGemCategory === c.key
                  ? 'bg-[#22C55E] text-white border-[#22C55E]'
                  : 'bg-white text-[#0C3B5E]/60 border-[#0C3B5E]/10'
              }`}
            >
              {c.key && <Gem size={10} />}
              {c.label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-[#2563EB]" size={28} />
        </div>
      ) : error ? (
        <p className="text-sm text-[#0C3B5E]/60">{error}</p>
      ) : (
        <>
          <RealMap spots={spots} height={280} />
          <p className="text-center text-[10px] text-[#0C3B5E]/35 font-mono mt-2 mb-5">
            Map data © OpenStreetMap contributors
          </p>

          <div className="space-y-3">
            {spots.map((s) => (
              <div key={s.id} className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4">
                <div className="flex items-start justify-between mb-1">
                  <h3 className="font-display font-bold text-[#0C3B5E] text-sm">{s.name}</h3>
                  {s.is_hidden_gem && <Gem size={14} className="text-[#22C55E] shrink-0 mt-0.5" />}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#0C3B5E]/60">
                  {s.rating != null && (
                    <span className="flex items-center gap-1"><Star size={11} /> {s.rating}</span>
                  )}
                  {s.opening_hours && (
                    <span className="flex items-center gap-1"><Clock size={11} /> {s.opening_hours}</span>
                  )}
                  <span className="flex items-center gap-1">
                    <Ticket size={11} /> {s.entry_fee_inr > 0 ? `₹${s.entry_fee_inr}` : 'Free'}
                  </span>
                </div>
                {s.description && <p className="text-xs text-[#0C3B5E]/60 mt-2 leading-relaxed">{s.description}</p>}
              </div>
            ))}
            {spots.length === 0 && (
              <p className="text-sm text-[#0C3B5E]/50 text-center py-8">No spots match this filter yet.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}