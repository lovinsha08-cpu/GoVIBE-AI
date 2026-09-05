import { useState, useEffect, useMemo } from 'react';
import { useParams, useLocation, useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Clock, Car, RefreshCw, Ticket, ShieldPlus, Download,
  Wallet, ChevronDown, Gem, Loader2, Compass, CloudRain, Sun, Cloud,
  UtensilsCrossed, Bus, Sparkles, Plus, X, Trash2,
  Phone, MapPinned, CalendarHeart, Luggage, TimerReset, ListChecks, Gauge,
  Flag, ArrowDown, Route, Footprints, Bike, Train, TrainFront, Ship,
  ExternalLink, TicketCheck, BadgeCheck, Zap, IndianRupee, Building2, Star,
} from 'lucide-react';
import { api } from '../lib/api';
import { buildGoogleMapsNavigationUrl, openInGoogleMaps } from '../lib/googleMapsNavigation';
import RealMap from '../components/RealMap';

const CROWD_COLOR = { low: '#16A34A', moderate: '#22C55E', high: '#2563EB' };

/** A start-of-journey or end-of-journey marker card (the bookends of the timeline). */
function JourneyEndpoint({ icon: Icon, label, location, time, timeLabel }) {
  if (!location) return null;
  return (
    <div className="rounded-2xl bg-[#0C3B5E] text-white p-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center shrink-0">
        <Icon size={16} className="text-[#22C55E]" />
      </div>
      <div>
        <p className="text-[10px] font-mono uppercase tracking-wide text-white/50">{label}</p>
        <p className="font-display font-bold text-sm">{location}</p>
        {time && <p className="text-xs text-white/70 mt-0.5">{timeLabel}: {time}</p>}
      </div>
    </div>
  );
}

/** A travel leg connecting two points on the journey timeline: from → to, distance, time, mode. */
function TravelSegment({ from, to, distanceKm, minutes, mode }) {
  if (distanceKm == null && minutes == null && !mode) return null;
  return (
    <div className="flex items-stretch gap-3 py-2">
      <div className="w-9 flex flex-col items-center shrink-0">
        <span className="w-px flex-1 bg-[#0C3B5E]/15" />
        <ArrowDown size={13} className="text-[#0C3B5E]/35 my-1" />
        <span className="w-px flex-1 bg-[#0C3B5E]/15" />
      </div>
      <div className="flex-1 rounded-xl bg-[#0C3B5E]/[0.03] border border-dashed border-[#0C3B5E]/20 px-3 py-2 my-1">
        {from && (
          <p className="text-[11px] text-[#0C3B5E]/50 mb-1">{from} → {to}</p>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[#0C3B5E]/70">
          {distanceKm != null && <span className="flex items-center gap-1"><MapPinned size={11} /> {distanceKm} km</span>}
          {minutes != null && <span className="flex items-center gap-1"><Clock size={11} /> {minutes} min</span>}
          {mode && <span className="flex items-center gap-1 capitalize"><Car size={11} /> {mode}</span>}
        </div>
      </div>
    </div>
  );
}

function WeatherIcon({ note, size = 12 }) {
  const lower = (note || '').toLowerCase();
  if (lower.includes('rain') || lower.includes('drizzle') || lower.includes('storm')) return <CloudRain size={size} />;
  if (lower.includes('cloud') || lower.includes('overcast') || lower.includes('fog')) return <Cloud size={size} />;
  return <Sun size={size} />;
}

const MODE_ICON = {
  walk: Footprints,
  bicycle: Bike,
  bike_taxi: Bike,
  auto: Car,
  cab: Car,
  metro: TrainFront,
  local_bus: Bus,
  train: Train,
  ferry: Ship,
};

function ModeIcon({ mode, size = 13, className = '' }) {
  const Icon = MODE_ICON[mode] || Car;
  return <Icon size={size} className={className} />;
}

/** One alternative transport option row inside the expanded comparison list. */
function AlternativeOptionRow({ option }) {
  return (
    <div className="flex items-start gap-2.5 py-2 border-b border-[#0C3B5E]/5 last:border-0">
      <div className="w-7 h-7 rounded-lg bg-[#0C3B5E]/[0.04] flex items-center justify-center shrink-0 mt-0.5">
        <ModeIcon mode={option.mode} className="text-[#0C3B5E]/60" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-semibold text-[#0C3B5E]">{option.label}</span>
          {option.tag === 'fastest' && (
            <span className="flex items-center gap-0.5 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-full bg-[#16A34A]/15 text-[#15803D]">
              <Zap size={9} /> Fastest
            </span>
          )}
          {option.tag === 'cheapest' && (
            <span className="flex items-center gap-0.5 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-full bg-[#22C55E]/20 text-[#1D4ED8]">
              <IndianRupee size={9} /> Cheapest
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[#0C3B5E]/55 mt-0.5">
          <span>₹{option.fare_per_person}/person{option.total_fare ? ` · ₹${option.total_fare} total` : ''}</span>
          <span>{option.duration_minutes} min</span>
          <span>{option.distance_km} km</span>
        </div>
        {option.reason && <p className="text-[11px] text-[#0C3B5E]/50 mt-1 leading-snug">{option.reason}</p>}
        {option.booking_url && (
          <a
            href={option.booking_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-[#2563EB] mt-1"
          >
            Book via {option.booking_provider} <ExternalLink size={10} />
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * AI Smart Transit Planner leg card — the flagship feature. For every hop
 * between two itinerary stops this shows the AI-recommended transport mode
 * (with full mode-specific details: bus number/stop, train number/class,
 * metro line/station, cab type, etc.), why it was picked, the fare for the
 * whole group, and every ranked alternative for comparison — embedded
 * directly in the timeline rather than a separate page.
 */
function TransportLegCard({ transport, from, to }) {
  const [expanded, setExpanded] = useState(false);
  if (!transport) return null;

  const modeDetailLine = () => {
    switch (transport.recommended_mode) {
      case 'local_bus':
        return `${transport.vehicle_name || 'Bus'} ${transport.vehicle_number || ''} · ${transport.boarding_point} → ${transport.destination_point}`;
      case 'train':
        return `${transport.vehicle_name || 'Train'} (${transport.vehicle_number || ''}) · ${transport.boarding_point} → ${transport.destination_point}`;
      case 'metro':
        return `${transport.details?.metro_line || 'Metro'} · ${transport.details?.boarding_station} → ${transport.details?.destination_station} (${transport.details?.number_of_stops} stops)`;
      case 'cab':
        return transport.details?.recommended_cab_type ? `Recommended: ${transport.details.recommended_cab_type}` : null;
      case 'walk':
        return transport.details?.calories_burned_estimate ? `~${transport.details.calories_burned_estimate} kcal burned` : null;
      default:
        return null;
    }
  };

  return (
    <div className="flex items-stretch gap-3 py-2">
      <div className="w-9 flex flex-col items-center shrink-0">
        <span className="w-px flex-1 bg-[#0C3B5E]/15" />
        <div className="w-7 h-7 rounded-full bg-[#0C3B5E] flex items-center justify-center my-1">
          <ModeIcon mode={transport.recommended_mode} size={13} className="text-[#22C55E]" />
        </div>
        <span className="w-px flex-1 bg-[#0C3B5E]/15" />
      </div>
      <div className="flex-1 rounded-xl bg-white border border-[#0C3B5E]/10 px-3.5 py-3 my-1">
        <div className="flex items-center justify-between gap-2 mb-1">
          <p className="text-[11px] text-[#0C3B5E]/50">{from} → {to}</p>
          <span className="flex items-center gap-1 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-full bg-[#8B7FD6]/15 text-[#6B5FB6] shrink-0">
            <BadgeCheck size={10} /> AI recommended
          </span>
        </div>

        <p className="text-sm font-semibold text-[#0C3B5E] capitalize mb-1">
          {transport.recommended_label || transport.recommended_mode?.replace('_', ' ')}
        </p>

        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#0C3B5E]/65 mb-1.5">
          <span className="flex items-center gap-1"><MapPinned size={11} /> {transport.distance} km</span>
          <span className="flex items-center gap-1"><Clock size={11} /> {transport.duration} min</span>
          <span className="flex items-center gap-1">
            <IndianRupee size={11} /> ₹{transport.fare_per_person}/person
            {transport.travellers > 1 && ` · ₹${transport.total_fare} total (${transport.travellers} travellers)`}
          </span>
        </div>

        {modeDetailLine() && (
          <p className="text-[11px] text-[#0C3B5E]/50 mb-1.5">{modeDetailLine()}</p>
        )}

        {(transport.departure_time || transport.arrival_time) && (
          <p className="text-[11px] text-[#0C3B5E]/50 mb-1.5">
            Departs {transport.departure_time} · Arrives {transport.arrival_time}
          </p>
        )}

        {transport.recommendation_reason && (
          <p className="text-xs text-[#0C3B5E]/70 leading-relaxed mb-2 italic">"{transport.recommendation_reason}"</p>
        )}

        {transport.late_night_note && (
          <div className="flex items-start gap-1.5 text-[11px] text-[#2563EB] bg-[#2563EB]/8 rounded-lg px-2.5 py-1.5 mb-2">
            <Clock size={11} className="mt-0.5 shrink-0" /> {transport.late_night_note}
          </div>
        )}
        {transport.weather_note && (
          <div className="flex items-start gap-1.5 text-[11px] text-[#8B7FD6] bg-[#8B7FD6]/10 rounded-lg px-2.5 py-1.5 mb-2">
            <CloudRain size={11} className="mt-0.5 shrink-0" /> {transport.weather_note}
          </div>
        )}

        <div className="flex items-center gap-3">
          {transport.booking_url && (
            <a
              href={transport.booking_url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-[11px] font-semibold text-white bg-[#0C3B5E] rounded-lg px-2.5 py-1.5"
            >
              Book via {transport.booking_provider} <ExternalLink size={10} />
            </a>
          )}
          {transport.alternative_options?.length > 0 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-medium text-[#0C3B5E]/55 hover:text-[#2563EB]"
            >
              {transport.alternative_options.length} more option{transport.alternative_options.length > 1 ? 's' : ''}
              <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>

        <AnimatePresence>
          {expanded && transport.alternative_options?.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="mt-2 pt-2 border-t border-[#0C3B5E]/8">
                {transport.alternative_options.map((opt) => (
                  <AlternativeOptionRow key={opt.mode} option={opt} />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default function ItineraryResults() {
  const { tripId } = useParams();
  const routerLocation = useLocation();
  const navigate = useNavigate();
  const [itinerary, setItinerary] = useState(routerLocation.state?.itinerary || null);
  const [hiddenGems, setHiddenGems] = useState(routerLocation.state?.hiddenGems || []);
  const [loading, setLoading] = useState(!routerLocation.state?.itinerary);
  const [regenerating, setRegenerating] = useState(false);
  const [regeneratingStop, setRegeneratingStop] = useState(null); // stop order currently regenerating
  const [activePanel, setActivePanel] = useState(null);
  const [error, setError] = useState('');
  const [stopError, setStopError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  useEffect(() => {
    if (itinerary) return;
    api.getLatestItinerary(tripId)
      .then((res) => setItinerary(res.itinerary))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [tripId]);

  const handleRegenerate = async () => {
    setRegenerating(true);
    setError('');
    try {
      const res = await api.generateItinerary(tripId);
      setItinerary(res.itinerary);
      setHiddenGems(res.hiddenGems || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setRegenerating(false);
    }
  };

  const handleDownloadPdf = async () => {
    setDownloading(true);
    setDownloadError('');
    try {
      const { blob, filename } = await api.downloadItineraryPdf(tripId);
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err.message);
    } finally {
      setDownloading(false);
    }
  };

  const handleRegenerateStop = async (stopOrder) => {
    setRegeneratingStop(stopOrder);
    setStopError('');
    try {
      const res = await api.regenerateStop(tripId, stopOrder);
      setItinerary(res.itinerary);
    } catch (err) {
      setStopError(err.message);
    } finally {
      setRegeneratingStop(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#EAF7EF] flex items-center justify-center">
        <Loader2 className="animate-spin text-[#2563EB]" size={32} />
      </div>
    );
  }

  if (error && !itinerary) {
    return (
      <div className="min-h-screen bg-[#EAF7EF] flex flex-col items-center justify-center px-6 text-center">
        <p className="text-[#0C3B5E]/70 mb-4">{error}</p>
        <button onClick={() => navigate(-1)} className="text-[#2563EB] font-semibold text-sm">Go back</button>
      </div>
    );
  }

  const stops = itinerary?.stops || [];
  // Group stops by day (falls back to a single "Day 1" group for older
  // saved itineraries generated before day-by-day tagging existed).
  const dayGroups = useMemo(() => {
    const map = new Map();
    stops.forEach((stop) => {
      const day = stop.day ?? 1;
      if (!map.has(day)) map.set(day, { day, date: stop.date || null, stops: [] });
      map.get(day).stops.push(stop);
    });
    return [...map.values()].sort((a, b) => a.day - b.day);
  }, [stops]);
  const budget = itinerary?.budget_summary || {};
  const aiSummary = budget.ai_extras?.summary || budget.ai_extras?.final_ai_summary || null;
  const packingList = budget.ai_extras?.packing_list || [];
  const localEvents = budget.ai_extras?.local_events || [];
  const decisionExplanation = budget.ai_extras?.decision_explanation || [];
  const confidenceScores = budget.ai_extras?.confidence_scores || null;
  const learnedPreferences = budget.ai_extras?.learned_preferences || null;
  const journey = budget.ai_extras?.journey || null;
  const routeSummary = journey?.route_summary || null;
  const accommodation = budget.ai_extras?.accommodation || null;
  const navigationUrl = useMemo(() => buildGoogleMapsNavigationUrl(journey, stops), [journey, stops]);
  // The itinerary location handed off to the Emergency Services page: the
  // first stop on the plan (real coordinates, so the new page can skip an
  // extra geocode round-trip), falling back to the journey's end point,
  // and finally to nothing — the page still works with just the trip ID,
  // the backend falls back to the trip's destination coordinates.
  const primaryLocation = stops[0]
    ? { name: stops[0].name, lat: stops[0].latitude, lng: stops[0].longitude }
    : journey?.end?.location
      ? { name: journey.end.location, lat: journey.end.latitude, lng: journey.end.longitude }
      : null;

  return (
    <div className="min-h-screen bg-[#EAF7EF] px-4 sm:px-6 py-8 max-w-2xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <div className="w-9 h-9 rounded-xl bg-[#0C3B5E] flex items-center justify-center rotate-[-8deg]">
          <Compass className="text-[#22C55E]" size={16} strokeWidth={2.5} />
        </div>
        <span className="font-display font-bold text-lg text-[#0C3B5E]">GoVIBE</span>
      </div>

      <h1 className="font-display font-bold text-2xl text-[#0C3B5E] mb-1">Your optimized itinerary</h1>
      <p className="text-sm text-[#0C3B5E]/55 mb-1">
        {routeSummary?.number_of_stops ?? stops.length} stops · {routeSummary?.total_distance_km ?? itinerary?.total_distance_km ?? 0} km · ~{Math.round((routeSummary?.total_travel_minutes ?? itinerary?.total_duration_minutes ?? 0) / 60)}h travel
      </p>
      {routeSummary?.estimated_total_trip_duration_minutes != null && (
        <p className="flex items-center gap-1.5 text-xs text-[#0C3B5E]/45 mb-4">
          <Route size={12} /> Full journey (travel + time at each stop): ~{Math.round(routeSummary.estimated_total_trip_duration_minutes / 60)}h total
        </p>
      )}
      {!routeSummary && <div className="mb-4" />}

      {/* Recommended Stay — accommodation the itinerary treats as the day-start/day-end base */}
      {accommodation && (
        <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4 mb-6">
          <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wide text-[#0C3B5E]/45 mb-3">
            <Building2 size={13} /> Recommended Stay
          </p>
          <div className="flex items-start justify-between gap-3 mb-1.5">
            <p className="font-display font-bold text-[15px] text-[#0C3B5E]">{accommodation.name}</p>
            {accommodation.rating != null && (
              <span className="flex items-center gap-1 shrink-0 text-xs font-semibold text-[#0C3B5E] bg-[#22C55E]/20 px-2 py-0.5 rounded-full">
                <Star size={11} className="fill-[#22C55E] text-[#22C55E]" /> {accommodation.rating}
              </span>
            )}
          </div>
          {accommodation.address && (
            <p className="text-xs text-[#0C3B5E]/55 mb-2">{accommodation.address}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#0C3B5E]/70 mb-2">
            <span className="font-semibold text-[#0C3B5E]">Current price · check live price for your dates</span>
            {accommodation.distance_km_from_center != null && (
              <span>{accommodation.distance_km_from_center} km from destination center</span>
            )}
            <span>Check-in {accommodation.check_in_time} · Check-out {accommodation.check_out_time}</span>
          </div>
          {accommodation.reason && (
            <p className="text-xs text-[#0C3B5E]/60 italic mb-2">{accommodation.reason}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {accommodation.price_check_url && (
              <a href={accommodation.price_check_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-[#0C3B5E] rounded-lg px-3 py-2">
                Check Current Price <ExternalLink size={11} />
              </a>
            )}
            {accommodation.website_url && (
              <a href={accommodation.website_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563EB] border border-[#2563EB]/20 rounded-lg px-3 py-2">
                Hotel Website <ExternalLink size={11} />
              </a>
            )}
            {accommodation.maps_url && (
              <a
                href={accommodation.maps_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs font-semibold text-[#2563EB]"
              >
                <ExternalLink size={12} /> View on Google Maps
              </a>
            )}
            {accommodation.phone && (
              <a href={`tel:${accommodation.phone}`} className="flex items-center gap-1 text-xs font-semibold text-[#16A34A]">
                <Phone size={12} /> {accommodation.phone}
              </a>
            )}
          </div>
        </div>
      )}

      {/* AI trip summary */}
      {aiSummary && (
        <div className="rounded-2xl bg-[#0C3B5E] text-white p-4 mb-6 flex gap-3">
          <Sparkles size={18} className="text-[#22C55E] shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-mono uppercase tracking-wide text-white/50 mb-1">Why this plan fits you</p>
            <p className="text-sm leading-relaxed text-white/90">{aiSummary}</p>
          </div>
        </div>
      )}

      {decisionExplanation.length > 0 && (
        <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4 mb-6">
          <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wide text-[#0C3B5E]/45 mb-2">
            <ListChecks size={13} /> How the AI decided
          </p>
          <ul className="space-y-1.5">
            {decisionExplanation.map((line, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-[#0C3B5E]/70">
                <span className="mt-1.5 w-1 h-1 rounded-full bg-[#8B7FD6] shrink-0" />
                {line}
              </li>
            ))}
          </ul>
          {learnedPreferences && (
            <p className="mt-3 pt-3 border-t border-[#0C3B5E]/5 text-[11px] text-[#0C3B5E]/45">
              Personalized using patterns from your last {learnedPreferences.trips_analyzed} trips.
            </p>
          )}
        </div>
      )}

      {confidenceScores && (
        <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wide text-[#0C3B5E]/45">
              <Gauge size={13} /> AI confidence
            </p>
            <span className="text-sm font-bold text-[#0C3B5E]">{confidenceScores.overall}%</span>
          </div>
          <div className="space-y-2">
            {[
              ['Interest match', confidenceScores.interest_match],
              ['Budget accuracy', confidenceScores.budget_accuracy],
              ['Route efficiency', confidenceScores.route_efficiency],
              ['Weather suitability', confidenceScores.weather_suitability],
              ['Transport optimization', confidenceScores.transport_optimization],
            ].map(([label, value]) => (
              <div key={label}>
                <div className="flex justify-between text-[11px] text-[#0C3B5E]/60 mb-0.5">
                  <span>{label}</span>
                  <span className="font-mono">{value}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-[#0C3B5E]/8 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[#16A34A]"
                    style={{ width: `${value}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {stops[0]?.weather_note && (
        <div className="flex items-center gap-2 text-xs text-[#0C3B5E]/60 mb-6 -mt-2">
          <WeatherIcon note={stops[0].weather_note} size={13} />
          <span>{stops[0].weather_note}</span>
        </div>
      )}

      {/* Map */}
      {stops.length > 0 && (
        <div className="rounded-2xl overflow-hidden border border-[#0C3B5E]/10 mb-6">
          <RealMap
            spots={stops.map((s) => ({
              latitude: s.latitude,
              longitude: s.longitude,
              name: s.name,
              category: s.category,
              order: s.order,
              rating: s.rating,
              entry_fee_inr: s.entry_cost_inr,
              opening_hours: s.opening_hours,
            }))}
            showRoute
            height={260}
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mb-2">
        <button
          onClick={handleRegenerate}
          disabled={regenerating}
          className="flex items-center gap-1.5 text-xs font-semibold text-[#0C3B5E] bg-white border border-[#0C3B5E]/15 rounded-xl px-3 py-2 disabled:opacity-50"
        >
          <RefreshCw size={13} className={regenerating ? 'animate-spin' : ''} />
          {regenerating ? 'Regenerating…' : 'Regenerate itinerary'}
        </button>
        <button
          onClick={handleDownloadPdf}
          disabled={downloading}
          className="flex items-center gap-1.5 text-xs font-semibold text-[#0C3B5E] bg-white border border-[#0C3B5E]/15 rounded-xl px-3 py-2 disabled:opacity-50"
        >
          <Download size={13} />
          {downloading ? 'Preparing…' : 'Download PDF'}
        </button>
        {navigationUrl && (
          <button
            onClick={() => openInGoogleMaps(navigationUrl)}
            className="flex items-center gap-1.5 text-xs font-semibold text-[#0C3B5E] bg-white border border-[#0C3B5E]/15 rounded-xl px-3 py-2"
          >
            <Route size={13} />
            Navigate full trip
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-500 mb-4">{error}</p>}
      {downloadError && <p className="text-xs text-red-500 mb-4">{downloadError}</p>}
      {stopError && <p className="text-xs text-red-500 mb-4">{stopError}</p>}
      <div className="mb-4" />

      {/* Day-by-day timeline */}
      {dayGroups.map((group, groupIdx) => {
        const isFirstDay = groupIdx === 0;
        const isLastDay = groupIdx === dayGroups.length - 1;
        return (
          <div key={group.day} className="mb-6">
            <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wide text-[#0C3B5E]/45 mb-2">
              <CalendarHeart size={13} /> Day {group.day}{group.date ? ` · ${group.date}` : ''}
            </p>

            {isFirstDay && (
              <JourneyEndpoint
                icon={Flag}
                label="Start"
                location={journey?.start?.location}
                time={journey?.start?.start_time_display}
                timeLabel="Departure"
              />
            )}

            {group.stops.map((stop) => (
              <div key={stop.order ?? stop.name}>
                {stop.transport ? (
                  <TransportLegCard
                    transport={stop.transport}
                    from={stop.from_location_name}
                    to={stop.name}
                  />
                ) : (
                  <TravelSegment
                    from={stop.from_location_name}
                    to={stop.name}
                    distanceKm={stop.distance_km_from_prev}
                    minutes={stop.travel_minutes_from_prev}
                    mode={stop.transport_mode}
                  />
                )}

                <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4 my-1">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div>
                      <p className="font-display font-bold text-[15px] text-[#0C3B5E]">
                        {stop.order != null ? `${stop.order}. ` : ''}{stop.name}
                      </p>
                      {stop.category && (
                        <span className="inline-block text-[10px] font-mono uppercase tracking-wide text-[#0C3B5E]/45 capitalize mt-0.5">
                          {stop.category}
                        </span>
                      )}
                    </div>
                    {stop.rating != null && (
                      <span className="flex items-center gap-1 shrink-0 text-xs font-semibold text-[#0C3B5E] bg-[#22C55E]/20 px-2 py-0.5 rounded-full">
                        <Star size={11} className="fill-[#22C55E] text-[#22C55E]" /> {stop.rating}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#0C3B5E]/70 mb-1.5">
                    {stop.arrival_time && (
                      <span className="flex items-center gap-1"><Clock size={11} /> {stop.arrival_time}{stop.departure_time ? ` – ${stop.departure_time}` : ''}</span>
                    )}
                    {stop.visit_minutes != null && (
                      <span className="flex items-center gap-1"><TimerReset size={11} /> {stop.visit_minutes} min</span>
                    )}
                    {stop.entry_cost_inr != null && (
                      <span className="flex items-center gap-1"><IndianRupee size={11} /> {stop.entry_cost_inr > 0 ? `₹${stop.entry_cost_inr}` : 'Free entry'}</span>
                    )}
                  </div>

                  {(stop.reasoning || stop.tips) && (
                    <p className="text-xs text-[#0C3B5E]/60 italic mb-2">{stop.reasoning || stop.tips}</p>
                  )}

                  {stop.meal_suggestion?.name && (
                    <p className="flex items-center gap-1.5 text-xs text-[#0C3B5E]/70 mb-2">
                      <UtensilsCrossed size={12} /> {stop.meal_suggestion.name}
                      {stop.meal_suggestion.avg_cost_inr != null && ` · ~₹${stop.meal_suggestion.avg_cost_inr}`}
                    </p>
                  )}

                  {stop.weather_note && groupIdx !== 0 && (
                    <p className="flex items-center gap-1.5 text-[11px] text-[#0C3B5E]/50 mb-2">
                      <WeatherIcon note={stop.weather_note} size={11} /> {stop.weather_note}
                    </p>
                  )}

                  <button
                    onClick={() => handleRegenerateStop(stop.order)}
                    disabled={regeneratingStop === stop.order}
                    className="flex items-center gap-1 text-[11px] font-medium text-[#0C3B5E]/55 hover:text-[#2563EB] disabled:opacity-50"
                  >
                    <RefreshCw size={11} className={regeneratingStop === stop.order ? 'animate-spin' : ''} />
                    {regeneratingStop === stop.order ? 'Swapping…' : 'Swap this stop'}
                  </button>
                </div>
              </div>
            ))}

            {isLastDay && journey?.end?.location && (
              <>
                {journey.end.transport ? (
                  <TransportLegCard
                    transport={journey.end.transport}
                    from={journey.end.from_location_name}
                    to={journey.end.location}
                  />
                ) : (
                  <TravelSegment
                    from={journey.end.from_location_name}
                    to={journey.end.location}
                    distanceKm={journey.end.distance_km_from_prev}
                    minutes={journey.end.travel_minutes_from_prev}
                    mode={journey.end.transport_mode}
                  />
                )}
                <JourneyEndpoint
                  icon={Flag}
                  label="End"
                  location={journey.end.location}
                  time={journey.end.estimated_completion_time}
                  timeLabel="Estimated arrival"
                />
              </>
            )}
          </div>
        );
      })}

      {/* Hidden gems */}
      {hiddenGems.length > 0 && (
        <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4 mb-6">
          <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wide text-[#0C3B5E]/45 mb-3">
            <Gem size={13} /> Hidden gems nearby
          </p>
          <div className="space-y-3">
            {hiddenGems.map((gem) => (
              <div key={gem.id} className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-[#0C3B5E]">{gem.name}</p>
                  {gem.reason && <p className="text-xs text-[#0C3B5E]/55 mt-0.5">{gem.reason}</p>}
                </div>
                {gem.rating != null && (
                  <span className="flex items-center gap-1 shrink-0 text-xs font-semibold text-[#0C3B5E] bg-[#22C55E]/20 px-2 py-0.5 rounded-full">
                    <Star size={11} className="fill-[#22C55E] text-[#22C55E]" /> {gem.rating}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Packing list */}
      {packingList.length > 0 && (
        <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4 mb-6">
          <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wide text-[#0C3B5E]/45 mb-3">
            <Luggage size={13} /> Packing list
          </p>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
            {packingList.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-[#0C3B5E]/70">
                <span className="mt-1.5 w-1 h-1 rounded-full bg-[#0C3B5E]/40 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Local events */}
      {localEvents.length > 0 && (
        <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4 mb-6">
          <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wide text-[#0C3B5E]/45 mb-3">
            <CalendarHeart size={13} /> Local events during your trip
          </p>
          <div className="space-y-2">
            {localEvents.map((ev, i) => (
              <div key={i}>
                <p className="text-sm font-semibold text-[#0C3B5E]">{ev.name} <span className="font-normal text-[#0C3B5E]/50">· {ev.date}</span></p>
                {ev.note && <p className="text-xs text-[#0C3B5E]/55 mt-0.5">{ev.note}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick links to the rest of the trip toolkit */}
      <div className="grid grid-cols-3 gap-2 mb-6">
        <Link
          to={`/trip/${tripId}/budget`}
          state={{ itinerary }}
          className="flex flex-col items-center gap-1.5 rounded-2xl bg-white border border-[#0C3B5E]/10 py-3 text-center"
        >
          <Wallet size={18} className="text-[#16A34A]" />
          <span className="text-[11px] font-semibold text-[#0C3B5E]">Budget Tracker</span>
        </Link>
        <Link
          to={`/trip/${tripId}/emergency-services`}
          state={{ location: primaryLocation }}
          className="flex flex-col items-center gap-1.5 rounded-2xl bg-white border border-[#0C3B5E]/10 py-3 text-center"
        >
          <ShieldPlus size={18} className="text-[#2563EB]" />
          <span className="text-[11px] font-semibold text-[#0C3B5E]">Emergency Services</span>
        </Link>
        <Link
          to={`/trip/${tripId}/booking`}
          state={{ itinerary }}
          className="flex flex-col items-center gap-1.5 rounded-2xl bg-white border border-[#0C3B5E]/10 py-3 text-center"
        >
          <Ticket size={18} className="text-[#8B7FD6]" />
          <span className="text-[11px] font-semibold text-[#0C3B5E]">Bookings</span>
        </Link>
      </div>
    </div>
  );
}