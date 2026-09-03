import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, RefreshCw, MapPin, Loader2, ChevronRight, CheckCircle2, AlertCircle } from 'lucide-react';
import ItineraryResults from './ItineraryResults';
import { api } from '../lib/api';

function ManualPlaceEditor({ tripId }) {
  const [open, setOpen] = useState(false);
  const [itinerary, setItinerary] = useState(null);
  const [activeStop, setActiveStop] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    api.getLatestItinerary(tripId)
      .then((res) => setItinerary(res.itinerary))
      .catch((err) => setError(err.message));
  }, [open, tripId]);

  useEffect(() => {
    if (!open || !activeStop || query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return undefined;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      setError('');
      try {
        const res = await api.searchItineraryPlaces(tripId, query.trim());
        if (!cancelled) setResults(res.places || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 450);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, activeStop, query, tripId]);

  const stops = useMemo(() =>
    (itinerary?.stops || []).filter((stop) => stop.category !== 'accommodation' && stop.meal_type == null),
  [itinerary]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const stop of stops) {
      const day = stop.day || 1;
      if (!map.has(day)) map.set(day, []);
      map.get(day).push(stop);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [stops]);

  const startReplace = (stop) => {
    setActiveStop(stop);
    setQuery('');
    setResults([]);
    setError('');
    setSuccess('');
  };

  const confirmReplacement = async (place) => {
    if (!activeStop) return;
    setReplacing(true);
    setError('');
    setSuccess('');
    try {
      const res = await api.replaceItineraryStop(tripId, activeStop.order, place);
      setItinerary(res.itinerary);
      setActiveStop(null);
      setQuery('');
      setResults([]);
      setSuccess(`${res.previousStopName} was replaced with ${res.replacedStop.name}. Route, timing and budget were recalculated.`);
      // ItineraryResults owns the full timeline state. Reloading after the
      // persisted replacement guarantees every route card, map marker and
      // budget summary reflects the same server-side itinerary.
      window.setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      setError(err.message);
    } finally {
      setReplacing(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed right-5 bottom-5 z-40 flex items-center gap-2 rounded-2xl bg-[#0C3B5E] px-4 py-3 text-sm font-semibold text-white shadow-xl hover:-translate-y-0.5 transition-transform"
      >
        <RefreshCw size={15} /> Edit places
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 bg-[#0C3B5E]/35 backdrop-blur-[2px]"
            />

            <motion.aside
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 280 }}
              className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-xl bg-[#F7F9FC] shadow-2xl flex flex-col"
            >
              <div className="px-5 py-4 border-b border-[#0C3B5E]/10 bg-white flex items-center justify-between gap-4">
                <div>
                  <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-[#2563EB]">Itinerary editor</p>
                  <h2 className="text-xl font-bold text-[#0C3B5E] mt-1">Change a place yourself</h2>
                  <p className="text-xs text-[#0C3B5E]/55 mt-1">Search a place, select it, and GoVIBE recalculates the affected route.</p>
                </div>
                <button onClick={() => setOpen(false)} className="w-9 h-9 rounded-xl bg-[#0C3B5E]/5 flex items-center justify-center text-[#0C3B5E]/65">
                  <X size={18} />
                </button>
              </div>

              {success && (
                <div className="mx-5 mt-4 flex items-start gap-2 rounded-xl bg-[#16A34A]/10 border border-[#16A34A]/20 p-3 text-xs text-[#166534]">
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
                  <span>{success}</span>
                </div>
              )}

              {error && (
                <div className="mx-5 mt-4 flex items-start gap-2 rounded-xl bg-[#DC2626]/8 border border-[#DC2626]/15 p-3 text-xs text-[#B91C1C]">
                  <AlertCircle size={15} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="flex-1 overflow-y-auto p-5">
                {!activeStop ? (
                  <div className="space-y-5">
                    {grouped.map(([day, dayStops]) => (
                      <section key={day}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="w-7 h-7 rounded-lg bg-[#0C3B5E] text-white flex items-center justify-center text-[11px] font-bold">{day}</span>
                          <h3 className="text-sm font-bold text-[#0C3B5E]">Day {day}</h3>
                        </div>
                        <div className="space-y-2">
                          {dayStops.map((stop) => (
                            <div key={`${stop.order}-${stop.name}`} className="rounded-xl bg-white border border-[#0C3B5E]/10 p-3.5 flex items-center gap-3">
                              <div className="w-9 h-9 rounded-lg bg-[#0C3B5E]/5 flex items-center justify-center shrink-0">
                                <MapPin size={16} className="text-[#2563EB]" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-[#0C3B5E] truncate">{stop.name}</p>
                                <p className="text-[11px] text-[#0C3B5E]/50 mt-0.5">
                                  {stop.category?.replace(/_/g, ' ')} · {stop.distance_km_from_prev ?? '—'} km · {stop.travel_minutes_from_prev ?? '—'} min
                                </p>
                              </div>
                              <button
                                onClick={() => startReplace(stop)}
                                className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-[#2563EB]/20 bg-[#2563EB]/5 px-2.5 py-1.5 text-[11px] font-semibold text-[#2563EB] hover:bg-[#2563EB]/10"
                              >
                                Replace <ChevronRight size={12} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </section>
                    ))}
                    {stops.length === 0 && !itinerary && !error && (
                      <div className="py-16 text-center text-sm text-[#0C3B5E]/50">Loading your itinerary…</div>
                    )}
                  </div>
                ) : (
                  <div>
                    <button onClick={() => setActiveStop(null)} className="text-xs font-semibold text-[#2563EB] mb-4">← Back to itinerary places</button>

                    <div className="rounded-2xl bg-[#0C3B5E] text-white p-4 mb-4">
                      <p className="text-[10px] font-mono uppercase tracking-wider text-white/50">Replace this place</p>
                      <p className="text-lg font-bold mt-1">{activeStop.name}</p>
                      <p className="text-xs text-white/65 mt-1">Day {activeStop.day} · Search within {activeStop.day ? 'your destination area' : 'the trip area'}</p>
                    </div>

                    <div className="relative">
                      <Search size={16} className="absolute left-3.5 top-3.5 text-[#0C3B5E]/35" />
                      <input
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search places in your destination…"
                        className="w-full rounded-xl border border-[#0C3B5E]/15 bg-white pl-10 pr-10 py-3 text-sm outline-none focus:border-[#2563EB]/50 focus:ring-2 focus:ring-[#2563EB]/10"
                      />
                      {searching && <Loader2 size={16} className="absolute right-3.5 top-3.5 animate-spin text-[#2563EB]" />}
                    </div>

                    <p className="text-[11px] text-[#0C3B5E]/45 mt-2">Results are filtered to genuine outing/tourist places near the destination and places already in the itinerary are hidden.</p>

                    <div className="mt-4 space-y-2">
                      {results.map((place) => (
                        <button
                          key={`${place.place_id || place.id}-${place.name}`}
                          disabled={replacing}
                          onClick={() => confirmReplacement(place)}
                          className="w-full text-left rounded-xl bg-white border border-[#0C3B5E]/10 p-3.5 hover:border-[#2563EB]/35 hover:bg-[#2563EB]/[0.02] transition disabled:opacity-50"
                        >
                          <div className="flex items-start gap-3">
                            <div className="w-9 h-9 rounded-lg bg-[#22C55E]/10 flex items-center justify-center shrink-0">
                              <MapPin size={15} className="text-[#16A34A]" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold text-[#0C3B5E]">{place.name}</p>
                              <p className="text-[11px] text-[#0C3B5E]/50 mt-0.5 line-clamp-2">{place.display_name || place.address || 'Destination-area place'}</p>
                              <div className="flex flex-wrap gap-2 mt-1.5 text-[10px] text-[#0C3B5E]/55">
                                {place.category && <span className="capitalize">{place.category.replace(/_/g, ' ')}</span>}
                                {place.rating != null && <span>★ {place.rating}</span>}
                                {place.distance_from_destination_km != null && <span>{place.distance_from_destination_km} km from destination</span>}
                              </div>
                            </div>
                            <ChevronRight size={15} className="text-[#0C3B5E]/25 mt-2 shrink-0" />
                          </div>
                        </button>
                      ))}

                      {!searching && query.trim().length >= 2 && results.length === 0 && (
                        <div className="py-10 text-center rounded-xl border border-dashed border-[#0C3B5E]/15 text-xs text-[#0C3B5E]/50">
                          No suitable tourist places found. Try a landmark, museum, beach, park, temple, mall, or attraction name.
                        </div>
                      )}
                    </div>

                    {replacing && (
                      <div className="fixed inset-0 z-[60] bg-[#0C3B5E]/25 flex items-center justify-center">
                        <div className="rounded-2xl bg-white px-5 py-4 shadow-xl flex items-center gap-3 text-sm font-semibold text-[#0C3B5E]">
                          <Loader2 size={18} className="animate-spin text-[#2563EB]" /> Updating your route…
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

export default function ItineraryPage() {
  const { tripId } = useParams();
  return (
    <>
      <ItineraryResults />
      <ManualPlaceEditor tripId={tripId} />
    </>
  );
}
