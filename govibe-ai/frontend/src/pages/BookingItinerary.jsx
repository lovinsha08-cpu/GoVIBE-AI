import { useState, useEffect, useMemo } from 'react';
import { useParams, useLocation, useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Compass, Loader2, ArrowLeft, ExternalLink, Bus, Car, Train, TrainFront,
  Ship, Bike, Footprints, Ticket, UtensilsCrossed, Hotel, IndianRupee, Wallet,
  Search, MapPinned, Star, CalendarDays,
} from 'lucide-react';
import { api } from '../lib/api';
import { useBudgetExpenses } from '../lib/useBudgetExpenses';

const TYPE_META = {
  transport: { icon: Bus, label: 'Transport' },
  attraction_entry: { icon: Ticket, label: 'Attraction entry' },
  restaurant_reservation: { icon: UtensilsCrossed, label: 'Restaurant reservation' },
  hotel_booking: { icon: Hotel, label: 'Hotel' },
};

const CATEGORY_BY_TYPE = {
  transport: 'Travel',
  attraction_entry: 'Experience',
  restaurant_reservation: 'Food',
  hotel_booking: 'Accommodation',
};

function expenseIdFor(tripId, item, index) {
  return `itinerary-${tripId}-${index}-${item.type}`;
}

const MODE_ICON = {
  walk: Footprints, bicycle: Bike, bike_taxi: Bike, auto: Car, cab: Car,
  metro: TrainFront, local_bus: Bus, train: Train, ferry: Ship,
};

export default function BookingItinerary() {
  const { tripId } = useParams();
  const routerLocation = useLocation();
  const navigate = useNavigate();
  const [itinerary, setItinerary] = useState(routerLocation.state?.itinerary || null);
  const [loading, setLoading] = useState(!routerLocation.state?.itinerary);
  const [error, setError] = useState('');

  useEffect(() => {
    if (itinerary) return;
    api.getLatestItinerary(tripId)
      .then((res) => setItinerary(res.itinerary))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [tripId]);

  const items = useMemo(
    () => itinerary?.budget_summary?.ai_extras?.booking_itinerary || [],
    [itinerary]
  );

  const accommodation = itinerary?.budget_summary?.ai_extras?.accommodation || null;
  const totalEstimatedCost = items.reduce((sum, i) => sum + (Number(i.estimated_cost_inr) || 0), 0);

  const { isTracked, addExpense, removeExpense } = useBudgetExpenses(tripId);

  const handleTogglePaid = (item, index) => {
    const id = expenseIdFor(tripId, item, index);
    if (isTracked(id)) {
      removeExpense(id);
      return;
    }
    addExpense({
      id,
      name: item.title,
      category: CATEGORY_BY_TYPE[item.type] || 'Other',
      amount: Number(item.estimated_cost_inr) || 0,
      dateTime: item.details?.departure_time || item.details?.arrival_time || null,
      source: 'Itinerary',
      recordedAt: new Date().toISOString(),
    });
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

  return (
    <div className="min-h-screen bg-[#EAF7EF] px-4 sm:px-6 py-8 max-w-2xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <div className="w-9 h-9 rounded-xl bg-[#0C3B5E] flex items-center justify-center rotate-[-8deg]">
          <Compass className="text-[#22C55E]" size={16} strokeWidth={2.5} />
        </div>
        <span className="font-display font-bold text-lg text-[#0C3B5E]">GoVIBE</span>
      </div>

      <Link
        to={`/trip/${tripId}/itinerary`}
        state={{ itinerary }}
        className="flex items-center gap-1.5 text-xs font-medium text-[#0C3B5E]/55 hover:text-[#2563EB] mb-3"
      >
        <ArrowLeft size={13} /> Back to itinerary
      </Link>

      <div className="flex items-start justify-between gap-3 mb-1">
        <h1 className="font-display font-bold text-2xl text-[#0C3B5E]">Booking Itinerary</h1>
        <Link
          to={`/trip/${tripId}/budget`}
          state={{ itinerary }}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-white bg-[#0C3B5E] rounded-lg px-2.5 py-1.5 shrink-0 whitespace-nowrap"
        >
          <Wallet size={12} /> Budget Tracker
        </Link>
      </div>
      <p className="text-sm text-[#0C3B5E]/55 mb-6">
        Every bookable item generated for this trip, in one place — transport, tickets, meals, and your recommended stay.
        Tick an item once you've paid for it to log it in your Live Budget Tracker.
      </p>

      {accommodation && (
        <AccommodationBookingCard accommodation={accommodation} itinerary={itinerary} />
      )}

      {items.length === 0 ? (
        <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-6 text-center">
          <p className="text-sm text-[#0C3B5E]/60">
            No other bookable items yet — your accommodation links are shown above when a stay is recommended.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-2xl bg-[#0C3B5E] text-white p-4 mb-6 flex items-center justify-between">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wide text-white/50">Bookable items</p>
              <p className="font-display font-bold text-lg">{items.length}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] font-mono uppercase tracking-wide text-white/50">Estimated total cost</p>
              <p className="flex items-center justify-end gap-0.5 font-display font-bold text-lg text-[#22C55E]">
                <IndianRupee size={15} /> {totalEstimatedCost.toLocaleString('en-IN')}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {items.map((item, i) => (
              <BookingCard
                key={i}
                item={item}
                index={i}
                paid={isTracked(expenseIdFor(tripId, item, i))}
                onTogglePaid={() => handleTogglePaid(item, i)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AccommodationBookingCard({ accommodation, itinerary }) {
  const trip = itinerary?.trip || itinerary?.trip_data || {};
  const price = Number(accommodation.price_per_night_inr);
  const total = Number(accommodation.estimated_total_stay_inr);

  return (
    <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4 mb-6">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <p className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wide text-[#0C3B5E]/45 mb-1">
            <Hotel size={12} /> Recommended stay
          </p>
          <h2 className="font-display font-bold text-base text-[#0C3B5E]">{accommodation.name}</h2>
        </div>
        {accommodation.rating != null && (
          <span className="flex items-center gap-1 shrink-0 text-xs font-semibold text-[#0C3B5E] bg-[#22C55E]/20 px-2 py-0.5 rounded-full">
            <Star size={11} className="fill-[#22C55E] text-[#22C55E]" /> {accommodation.rating}
          </span>
        )}
      </div>

      {accommodation.address && (
        <p className="text-xs text-[#0C3B5E]/55 mb-2">{accommodation.address}</p>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#0C3B5E]/65 mb-3">
        {Number.isFinite(price) && price > 0 && (
          <span className="flex items-center gap-1"><IndianRupee size={11} /> ~₹{price.toLocaleString('en-IN')}/night</span>
        )}
        {Number.isFinite(total) && total > 0 && (
          <span className="flex items-center gap-1"><IndianRupee size={11} /> ~₹{total.toLocaleString('en-IN')} estimated stay</span>
        )}
        {accommodation.distance_km_from_center != null && (
          <span className="flex items-center gap-1"><MapPinned size={11} /> {accommodation.distance_km_from_center} km from destination center</span>
        )}
      </div>

      <div className="rounded-xl bg-[#0C3B5E]/[0.035] border border-[#0C3B5E]/8 p-3 mb-3">
        <p className="text-[11px] font-semibold text-[#0C3B5E] mb-1">Check the current price before booking</p>
        <p className="text-[10px] leading-relaxed text-[#0C3B5E]/50">
          GoVIBE's displayed amount is only an estimate. The price-check link opens an external search with your trip dates and guest count so you can verify the live room rate.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {accommodation.price_check_url && (
          <a
            href={accommodation.price_check_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] font-semibold text-white bg-[#2563EB] rounded-lg px-3 py-2"
          >
            <Search size={12} /> Check live price
          </a>
        )}
        {accommodation.compare_prices_url && (
          <a
            href={accommodation.compare_prices_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] font-semibold text-[#0C3B5E] bg-white border border-[#0C3B5E]/15 rounded-lg px-3 py-2"
          >
            <Search size={12} /> Compare prices
          </a>
        )}
        {accommodation.website_url && (
          <a
            href={accommodation.website_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] font-semibold text-[#16A34A] bg-[#16A34A]/10 rounded-lg px-3 py-2"
          >
            <ExternalLink size={12} /> Hotel website
          </a>
        )}
        {accommodation.booking_url && accommodation.booking_url !== accommodation.website_url && (
          <a
            href={accommodation.booking_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] font-semibold text-[#0C3B5E] bg-white border border-[#0C3B5E]/15 rounded-lg px-3 py-2"
          >
            <ExternalLink size={12} /> Book / check availability
          </a>
        )}
        {accommodation.maps_url && (
          <a
            href={accommodation.maps_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] font-medium text-[#2563EB] px-1 py-2"
          >
            <MapPinned size={12} /> Maps
          </a>
        )}
      </div>

      {accommodation.price_estimate_note && (
        <p className="text-[10px] text-[#0C3B5E]/35 mt-3">{accommodation.price_estimate_note}</p>
      )}
    </div>
  );
}

function BookingCard({ item, index, paid, onTogglePaid }) {
  const meta = TYPE_META[item.type] || TYPE_META.transport;
  const Icon = item.type === 'transport' ? (MODE_ICON[item.mode] || Bus) : meta.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className={`rounded-2xl bg-white border p-4 transition-colors ${paid ? 'border-[#16A34A]/40' : 'border-[#0C3B5E]/10'}`}
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-[#0C3B5E]/[0.05] flex items-center justify-center shrink-0">
          <Icon size={16} className="text-[#0C3B5E]/70" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <span className="text-[10px] font-mono uppercase tracking-wide text-[#0C3B5E]/40">{meta.label}</span>
            {item.estimated_cost_inr != null && (
              <span className="text-sm font-semibold text-[#0C3B5E] shrink-0">₹{Number(item.estimated_cost_inr).toLocaleString('en-IN')}</span>
            )}
          </div>
          <p className="font-display font-semibold text-sm text-[#0C3B5E] mb-1">{item.title}</p>

          {item.type === 'transport' && (item.details?.departure_time || item.details?.vehicle_number) && (
            <p className="text-[11px] text-[#0C3B5E]/50 mb-1.5">
              {item.details.vehicle_name} {item.details.vehicle_number ? `· ${item.details.vehicle_number}` : ''}
              {item.details.departure_time ? ` · Departs ${item.details.departure_time}` : ''}
              {item.details.arrival_time ? ` · Arrives ${item.details.arrival_time}` : ''}
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[#0C3B5E]/45">Provider: {item.provider || '—'}</span>
            <div className="flex items-center gap-2 shrink-0">
              <label
                className="flex items-center gap-1.5 text-[11px] font-medium text-[#0C3B5E]/60 cursor-pointer select-none"
                title="Mark as paid — logs this expense in your Live Budget Tracker"
              >
                <input
                  type="checkbox"
                  checked={!!paid}
                  onChange={onTogglePaid}
                  className="accent-[#16A34A] w-3.5 h-3.5"
                />
                Paid
              </label>
              {item.booking_url && (
                <a
                  href={item.booking_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-[11px] font-semibold text-white bg-[#0C3B5E] rounded-lg px-2.5 py-1.5 shrink-0"
                >
                  Book Now <ExternalLink size={10} />
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
