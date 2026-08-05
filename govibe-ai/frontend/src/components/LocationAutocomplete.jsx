import { useState, useRef, useEffect, useCallback } from 'react';
import { MapPin, Loader2, Building2, Plane, TrainFront, Landmark, Hotel, Bus } from 'lucide-react';
import { api } from '../lib/api';

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/** Small icon per place type so the dropdown reads at a glance, like Google Maps/Uber. */
function PlaceIcon({ placeType, size = 15 }) {
  const type = (placeType || '').toLowerCase();
  const cls = 'text-[#0C3B5E]/40 shrink-0';
  if (type.includes('airport')) return <Plane size={size} className={cls} />;
  if (type.includes('railway') || type.includes('station')) return <TrainFront size={size} className={cls} />;
  if (type.includes('bus')) return <Bus size={size} className={cls} />;
  if (type.includes('hotel')) return <Hotel size={size} className={cls} />;
  if (type.includes('landmark')) return <Landmark size={size} className={cls} />;
  if (type.includes('city') || type.includes('town') || type.includes('village') || type.includes('state')) {
    return <Building2 size={size} className={cls} />;
  }
  return <MapPin size={size} className={cls} />;
}

/**
 * A reusable, Google-Maps-style location search box: type a place, get a
 * debounced dropdown of suggestions from the backend's /places/autocomplete
 * endpoint, pick one, and the parent gets back both a readable name and
 * coordinates. Meant to be dropped in anywhere a place needs to be picked —
 * start location, destination, hotel search, restaurant search, etc.
 *
 * Controlled like the existing <Field />: the parent owns `value` (the text
 * shown in the input) and is told about every change via `onChangeText`
 * (free typing) and `onSelect` (a suggestion was picked, coords included).
 *
 * Props:
 *   label           - field label, same as <Field label=.../>
 *   value           - current input text (controlled)
 *   onChangeText(text)      - called on every keystroke; the parent should
 *                              also clear any previously-selected lat/lng
 *                              here, since free-typed text may no longer
 *                              match the coordinates from an earlier pick.
 *   onSelect({ name, lat, lng, display_name, place_type }) - called when a
 *                              suggestion is chosen (click or Enter).
 *   placeholder, required, error - same meaning as <Field />.
 *   rightAdornment  - optional element rendered inside the input on the
 *                      right (e.g. a "use current location" button), kept
 *                      clear of the loading spinner automatically.
 */
export default function LocationAutocomplete({
  label,
  value,
  onChangeText,
  onSelect,
  placeholder,
  required = false,
  error,
  rightAdornment = null,
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searched, setSearched] = useState(false); // true once a real (non-empty) search has completed, so "No locations found" only shows after an actual attempt

  const containerRef = useRef(null);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);
  const requestIdRef = useRef(0);

  const runSearch = useCallback(async (query) => {
    // Cancel any in-flight request so a slow earlier keystroke can't
    // overwrite the results of a later one (classic race condition with
    // fast typing + debounce).
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;

    setLoading(true);
    try {
      const res = await api.autocompletePlaces(query, { limit: 8, signal: controller.signal });
      if (requestId !== requestIdRef.current) return; // a newer request already superseded this one
      setSuggestions(res.suggestions || []);
      setSearched(true);
      setActiveIndex(-1);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (requestId !== requestIdRef.current) return;
      setSuggestions([]);
      setSearched(true);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  const handleChange = (e) => {
    const text = e.target.value;
    onChangeText(text);
    setOpen(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = text.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      // Below the search threshold — clear any stale dropdown instead of
      // querying the backend with a near-empty string.
      abortRef.current?.abort();
      requestIdRef.current += 1; // invalidate any in-flight request
      setSuggestions([]);
      setSearched(false);
      setLoading(false);
      return;
    }

    debounceRef.current = setTimeout(() => runSearch(trimmed), DEBOUNCE_MS);
  };

  const selectSuggestion = (place) => {
    onChangeText(place.name);
    onSelect(place);
    setOpen(false);
    setSuggestions([]);
    setActiveIndex(-1);
  };

  const handleKeyDown = (e) => {
    if (!open || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0) {
        e.preventDefault();
        selectSuggestion(suggestions[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  // Close the dropdown on outside click.
  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Clean up any pending debounce/in-flight request on unmount.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
  }, []);

  const showDropdown = open && (value || '').trim().length >= MIN_QUERY_LENGTH;

  return (
    <div className="relative mb-4" ref={containerRef}>
      {label && (
        <span className="block text-sm font-medium text-[#0C3B5E]/80 mb-1.5">
          {label}{required && <span className="text-[#2563EB]"> *</span>}
        </span>
      )}

      <div className="relative">
        <input
          type="text"
          value={value || ''}
          onChange={handleChange}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
          autoComplete="off"
          className="w-full px-4 py-3 pr-10 rounded-xl border border-[#0C3B5E]/15 bg-white
                     text-[#0C3B5E] placeholder:text-[#0C3B5E]/35
                     focus:outline-none focus:ring-2 focus:ring-[#2563EB]/40 focus:border-[#2563EB]
                     transition-shadow"
        />

        {/* Loading spinner takes priority over rightAdornment while a search is in flight */}
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
          {loading ? (
            <Loader2 size={16} className="animate-spin text-[#0C3B5E]/40" />
          ) : (
            rightAdornment
          )}
        </div>
      </div>

      {error && <span className="block text-xs text-[#2563EB] mt-1">{error}</span>}

      {showDropdown && (
        <div
          className="absolute z-30 mt-1.5 w-full max-h-72 overflow-y-auto
                     rounded-2xl bg-white border border-[#0C3B5E]/10 shadow-xl shadow-[#0C3B5E]/10
                     divide-y divide-[#0C3B5E]/5"
          role="listbox"
        >
          {suggestions.length > 0 ? (
            suggestions.map((place, i) => (
              <button
                type="button"
                key={`${place.lat}-${place.lng}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => e.preventDefault()} // keep input focused so onBlur doesn't beat the click
                onClick={() => selectSuggestion(place)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`w-full flex items-start gap-2.5 px-4 py-2.5 text-left transition-colors
                            first:rounded-t-2xl last:rounded-b-2xl
                            ${i === activeIndex ? 'bg-[#2563EB]/8' : 'hover:bg-[#0C3B5E]/[0.03]'}`}
              >
                <span className="mt-0.5"><PlaceIcon placeType={place.place_type} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-[#0C3B5E] truncate">📍 {place.name}</span>
                  <span className="block text-xs text-[#0C3B5E]/50 truncate">{place.display_name}</span>
                </span>
                {place.place_type && (
                  <span className="shrink-0 mt-0.5 text-[10px] font-mono uppercase tracking-wide text-[#0C3B5E]/35">
                    {place.place_type}
                  </span>
                )}
              </button>
            ))
          ) : !loading && searched ? (
            <p className="px-4 py-3 text-sm text-[#0C3B5E]/45">No locations found — try a different spelling.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}