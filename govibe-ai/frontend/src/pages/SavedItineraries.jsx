import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Compass, ArrowLeft, Search, MapPin, CalendarDays, IndianRupee,
  Eye, Download, Trash2, Loader2, X, SlidersHorizontal,
} from 'lucide-react';
import { api } from '../lib/api';

const SORT_OPTIONS = [
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'budget_high', label: 'Highest budget' },
  { key: 'budget_low', label: 'Lowest budget' },
];

const STATUS_STYLES = {
  draft: { label: 'Draft', bg: '#E6F7ED', fg: '#0C3B5E' },
  generated: { label: 'Generated', bg: '#DCFCE7', fg: '#15803D' },
  booked: { label: 'Booked', bg: '#DBEAFE', fg: '#1D4ED8' },
  completed: { label: 'Completed', bg: '#DBEAFE', fg: '#2563EB' },
};

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function TripCard({ trip, onDelete, downloadingId, onDownload }) {
  const navigate = useNavigate();
  const status = STATUS_STYLES[trip.status] || STATUS_STYLES.draft;
  const title = trip.trip_name || trip.destination;
  const days = trip.summary?.day_count;
  const isDownloading = downloadingId === trip.id;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="rounded-3xl bg-white border border-[#0C3B5E]/10 overflow-hidden"
    >
      <div className="h-24 bg-gradient-to-br from-[#0C3B5E] to-[#16A34A]/70 flex items-end p-4 relative">
        <span
          className="absolute top-3 right-3 text-[10px] font-semibold px-2.5 py-1 rounded-full"
          style={{ backgroundColor: status.bg, color: status.fg }}
        >
          {status.label}
        </span>
        <div className="flex items-center gap-1.5 text-white">
          <MapPin size={14} />
          <p className="font-display font-bold text-base leading-none">{title}</p>
        </div>
      </div>

      <div className="p-4">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-[#0C3B5E]/60 mb-4">
          <span className="flex items-center gap-1"><CalendarDays size={12} /> {days ? `${days} day${days > 1 ? 's' : ''}` : formatDate(trip.start_date)}</span>
          <span className="flex items-center gap-1"><IndianRupee size={12} /> {Number(trip.total_budget_inr).toLocaleString('en-IN')}</span>
          <span>Created {formatDate(trip.created_at)}</span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => navigate(`/trip/${trip.id}/itinerary`)}
            className="flex items-center justify-center gap-1.5 text-xs font-semibold text-white bg-[#0C3B5E] rounded-xl py-2.5"
          >
            <Eye size={13} /> View
          </button>
          <button
            onClick={() => onDownload(trip.id)}
            disabled={isDownloading}
            className="flex items-center justify-center gap-1.5 text-xs font-semibold text-[#0C3B5E] bg-[#E6F7ED] rounded-xl py-2.5 disabled:opacity-60"
          >
            {isDownloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} PDF
          </button>
          <button
            onClick={() => onDelete(trip)}
            className="flex items-center justify-center gap-1.5 text-xs font-semibold text-[#2563EB] bg-[#DBEAFE] rounded-xl py-2.5"
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>
    </motion.div>
  );
}

export default function SavedItineraries() {
  const navigate = useNavigate();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [showFilters, setShowFilters] = useState(false);
  const [minBudget, setMinBudget] = useState('');
  const [maxBudget, setMaxBudget] = useState('');
  const [downloadingId, setDownloadingId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const fetchTrips = useCallback(() => {
    setLoading(true);
    setError('');
    api.listTrips({ q: query || undefined, sort, minBudget: minBudget || undefined, maxBudget: maxBudget || undefined })
      .then((res) => setTrips(res.trips || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [query, sort, minBudget, maxBudget]);

  useEffect(() => {
    const timeout = setTimeout(fetchTrips, 300); // debounce search/filter typing
    return () => clearTimeout(timeout);
  }, [fetchTrips]);

  const handleDownload = async (tripId) => {
    setDownloadingId(tripId);
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
      setError(err.message);
    } finally {
      setDownloadingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteTrip(pendingDelete.id);
      setTrips((prev) => prev.filter((t) => t.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#EAF7EF] px-4 sm:px-6 py-8 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <button onClick={() => navigate('/dashboard')} className="p-1 -ml-1 text-[#0C3B5E]/60">
          <ArrowLeft size={20} />
        </button>
        <div className="w-9 h-9 rounded-xl bg-[#0C3B5E] flex items-center justify-center rotate-[-8deg]">
          <Compass className="text-[#22C55E]" size={16} strokeWidth={2.5} />
        </div>
        <span className="font-display font-bold text-lg text-[#0C3B5E]">Booked Itineraries</span>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 flex items-center gap-2 rounded-xl bg-white border border-[#0C3B5E]/10 px-3 py-2.5">
          <Search size={15} className="text-[#0C3B5E]/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by destination or trip name"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-[#0C3B5E]/35"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-[#0C3B5E]/30">
              <X size={14} />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowFilters((v) => !v)}
          className={`p-2.5 rounded-xl border ${showFilters ? 'bg-[#0C3B5E] text-white border-[#0C3B5E]' : 'bg-white text-[#0C3B5E]/60 border-[#0C3B5E]/10'}`}
        >
          <SlidersHorizontal size={15} />
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {SORT_OPTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSort(s.key)}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
              sort === s.key ? 'bg-[#0C3B5E] text-white border-[#0C3B5E]' : 'bg-white text-[#0C3B5E]/60 border-[#0C3B5E]/10'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden mb-4"
          >
            <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4 flex gap-3">
              <div className="flex-1">
                <label className="text-[10px] font-mono uppercase tracking-wide text-[#0C3B5E]/40">Min budget (₹)</label>
                <input
                  type="number"
                  value={minBudget}
                  onChange={(e) => setMinBudget(e.target.value)}
                  className="w-full mt-1 text-sm border border-[#0C3B5E]/10 rounded-lg px-2 py-1.5 outline-none"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] font-mono uppercase tracking-wide text-[#0C3B5E]/40">Max budget (₹)</label>
                <input
                  type="number"
                  value={maxBudget}
                  onChange={(e) => setMaxBudget(e.target.value)}
                  className="w-full mt-1 text-sm border border-[#0C3B5E]/10 rounded-lg px-2 py-1.5 outline-none"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && <p className="text-xs text-[#2563EB] mb-4">{error}</p>}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-[#0C3B5E]/40">
          <Loader2 size={24} className="animate-spin" />
        </div>
      ) : trips.length === 0 ? (
        <div className="rounded-3xl bg-white border border-[#0C3B5E]/10 p-10 text-center">
          <p className="text-sm font-semibold text-[#0C3B5E] mb-1">No saved itineraries yet</p>
          <p className="text-xs text-[#0C3B5E]/50 mb-4">Trips you generate will show up here automatically.</p>
          <button
            onClick={() => navigate('/trip/new')}
            className="text-sm font-semibold text-white bg-[#0C3B5E] rounded-xl px-5 py-2.5"
          >
            Plan a new trip
          </button>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          <AnimatePresence>
            {trips.map((trip) => (
              <TripCard key={trip.id} trip={trip} onDelete={setPendingDelete} onDownload={handleDownload} downloadingId={downloadingId} />
            ))}
          </AnimatePresence>
        </div>
      )}

      <AnimatePresence>
        {pendingDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#0C3B5E]/40 flex items-end sm:items-center justify-center p-4 z-50"
            onClick={() => !deleting && setPendingDelete(null)}
          >
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full sm:max-w-sm rounded-3xl bg-white p-6"
            >
              <p className="font-display font-bold text-lg text-[#0C3B5E] mb-1">Delete this itinerary?</p>
              <p className="text-xs text-[#0C3B5E]/55 mb-5">
                This permanently removes {pendingDelete.trip_name || pendingDelete.destination} and its saved PDF/route data. This can't be undone.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setPendingDelete(null)}
                  disabled={deleting}
                  className="text-sm font-semibold text-[#0C3B5E] bg-[#E6F7ED] rounded-xl py-2.5"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDelete}
                  disabled={deleting}
                  className="flex items-center justify-center gap-1.5 text-sm font-semibold text-white bg-[#2563EB] rounded-xl py-2.5 disabled:opacity-60"
                >
                  {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}