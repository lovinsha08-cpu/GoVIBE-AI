import { useEffect, useState } from 'react';
import { useParams, useLocation, useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Compass, Loader2, ShieldPlus, Hospital, Siren, Pill,
  MapPin, Navigation, PhoneCall, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { api } from '../lib/api';
import { openInGoogleMaps } from '../lib/googleMapsNavigation';

// ---------------------------------------------------------------------
// Simple in-memory cache: avoids re-hitting Overpass/Google (and the
// loading spinner) every time the traveler navigates back to this page
// for the same trip + location within a short window. Module-scoped, so
// it survives across mounts for the lifetime of the tab but never
// persists to disk — a stale "nearest hospital" is never worth caching
// for long, so entries expire after CACHE_TTL_MS.
// ---------------------------------------------------------------------
const emergencyCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(tripId, lat, lng) {
  return `${tripId}|${lat ?? ''}|${lng ?? ''}`;
}

// Fixed, always-available national helpline numbers — shown regardless of
// whether live nearby-facility lookups succeed.
const NATIONAL_HELPLINES = [
  { number: '112', label: 'National Emergency' },
  { number: '108', label: 'Ambulance' },
  { number: '100', label: 'Police' },
  { number: '101', label: 'Fire' },
  { number: '1091', label: "Women's Helpline" },
];

// The three categories this page surfaces, in display order, each mapped
// to the matching key in the /trips/:id/emergency response.
const CATEGORIES = [
  { key: 'hospitals', label: 'Hospital', Icon: Hospital },
  { key: 'police', label: 'Police Station', Icon: Siren },
  { key: 'medical_stores', label: 'Pharmacy', Icon: Pill },
];

function mapsUrlFor(facility) {
  if (facility.maps_url) return facility.maps_url;
  if (facility.latitude != null && facility.longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${facility.latitude},${facility.longitude}`;
  }
  return null;
}

/** One category card — the nearest facility of that type, or a "Not Available" placeholder. */
function FacilityCategoryCard({ label, Icon, facility }) {
  const mapsUrl = facility ? mapsUrlFor(facility) : null;

  return (
    <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded-xl bg-[#2563EB]/10 flex items-center justify-center shrink-0">
          <Icon size={16} className="text-[#2563EB]" />
        </div>
        <p className="text-sm font-semibold text-[#0C3B5E]">{label}</p>
      </div>

      {facility ? (
        <div>
          <p className="text-sm font-semibold text-[#0C3B5E] leading-snug">{facility.name}</p>
          <p className="text-xs text-[#0C3B5E]/55 mt-1 leading-snug">
            {facility.address || 'Address not available'}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 text-xs text-[#0C3B5E]/70">
            <span className="flex items-center gap-1">
              <MapPin size={12} />
              {facility.distance_km != null ? `${facility.distance_km} km away` : 'Distance not available'}
            </span>
            <span className="flex items-center gap-1">
              <Navigation size={12} />
              {facility.travel_minutes != null ? `~${facility.travel_minutes} min` : 'Travel time not available'}
            </span>
          </div>
          {facility.phone && (
            <a
              href={`tel:${facility.phone}`}
              className="flex items-center gap-1 text-xs font-mono font-medium text-[#2563EB] mt-2"
            >
              <PhoneCall size={12} /> {facility.phone}
            </a>
          )}
          {mapsUrl && (
            <a
              href={mapsUrl}
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault();
                openInGoogleMaps(mapsUrl);
              }}
              className="flex items-center justify-center gap-1.5 text-xs font-semibold text-white bg-[#0C3B5E] rounded-xl py-2 mt-3"
            >
              <MapPin size={13} /> View on Map
            </a>
          )}
        </div>
      ) : (
        <p className="text-xs text-[#0C3B5E]/45 italic">Not Available</p>
      )}
    </div>
  );
}

export default function EmergencyServices() {
  const { tripId } = useParams();
  const routerLocation = useLocation();
  const navigate = useNavigate();
  const initialLocation = routerLocation.state?.location || null;

  const [data, setData] = useState(null);
  const [anchorName, setAnchorName] = useState(initialLocation?.name || null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = (force = false) => {
    const lat = initialLocation?.lat ?? null;
    const lng = initialLocation?.lng ?? null;
    const key = cacheKey(tripId, lat, lng);

    if (!force) {
      const cached = emergencyCache.get(key);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        setData(cached.data);
        setAnchorName(cached.data.anchor || initialLocation?.name || null);
        setLoading(false);
        setError('');
        return;
      }
    }

    setLoading(true);
    setError('');
    api.getEmergencyServices(tripId, { lat, lng, anchorName: initialLocation?.name })
      .then((res) => {
        emergencyCache.set(key, { data: res, fetchedAt: Date.now() });
        setData(res);
        setAnchorName(res.anchor || initialLocation?.name || null);
      })
      .catch((err) => {
        setError(err.message || 'Could not load nearby emergency services right now.');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  return (
    <div className="min-h-screen bg-[#EAF7EF] px-4 sm:px-6 py-8 max-w-2xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <div className="w-9 h-9 rounded-xl bg-[#0C3B5E] flex items-center justify-center rotate-[-8deg]">
          <Compass className="text-[#22C55E]" size={16} strokeWidth={2.5} />
        </div>
        <span className="font-display font-bold text-lg text-[#0C3B5E]">GoVIBE</span>
      </div>

      <button
        onClick={() => navigate(`/trip/${tripId}/itinerary`)}
        className="flex items-center gap-1.5 text-xs font-medium text-[#0C3B5E]/55 hover:text-[#2563EB] mb-3"
      >
        <ArrowLeft size={13} /> Back to Itinerary
      </button>

      <div className="flex items-center gap-2 mb-1">
        <ShieldPlus size={20} className="text-[#2563EB]" />
        <h1 className="font-display font-bold text-2xl text-[#0C3B5E]">Emergency Services</h1>
      </div>
      <p className="text-sm text-[#0C3B5E]/55 mb-6">
        Nearest help near <span className="font-semibold text-[#0C3B5E]/80">{anchorName || 'your itinerary location'}</span>
      </p>

      {loading && (
        <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-8 flex flex-col items-center justify-center gap-2 mb-4">
          <Loader2 className="animate-spin text-[#2563EB]" size={26} />
          <p className="text-xs text-[#0C3B5E]/50">Finding the nearest hospital, police station & pharmacy…</p>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-2xl bg-[#DBEAFE] border border-[#2563EB]/20 p-4 flex items-start gap-2.5 mb-4">
          <AlertTriangle size={16} className="text-[#2563EB] shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-[#2563EB] font-medium">{error}</p>
            <p className="text-[11px] text-[#0C3B5E]/50 mt-0.5">
              The national helpline numbers below still work anywhere.
            </p>
          </div>
          <button
            onClick={() => load(true)}
            className="flex items-center gap-1 text-[11px] font-semibold text-[#0C3B5E] bg-white border border-[#0C3B5E]/10 rounded-lg px-2 py-1 shrink-0"
          >
            <RefreshCw size={11} /> Retry
          </button>
        </div>
      )}

      {!loading && (
        <div className="space-y-3 mb-6">
          {CATEGORIES.map(({ key, label, Icon }) => (
            <FacilityCategoryCard
              key={key}
              label={label}
              Icon={Icon}
              facility={data?.[key]?.[0] || null}
            />
          ))}
        </div>
      )}

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="rounded-2xl bg-[#0C3B5E] text-white p-5"
      >
        <p className="text-sm font-semibold mb-3">National Emergency Helplines</p>
        <div className="grid grid-cols-2 gap-2">
          {NATIONAL_HELPLINES.map((h) => (
            <a
              key={h.number}
              href={`tel:${h.number}`}
              className="rounded-xl bg-white/10 hover:bg-white/15 transition-colors px-3 py-2.5"
            >
              <p className="text-[10px] text-white/60">{h.label}</p>
              <p className="flex items-center gap-1.5 text-base font-mono font-bold text-[#16A34A]">
                <PhoneCall size={13} /> {h.number}
              </p>
            </a>
          ))}
        </div>
      </motion.div>
    </div>
  );
}