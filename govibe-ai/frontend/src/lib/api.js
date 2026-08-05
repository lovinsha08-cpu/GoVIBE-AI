const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

function getAuthHeaders() {
  try {
    const session = JSON.parse(localStorage.getItem('govibe_session') || 'null');
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
  } catch {
    return {};
  }
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...options.headers },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  travelerSignup: (payload) =>
    request('/auth/traveler/signup', { method: 'POST', body: JSON.stringify(payload) }),
  businessSignup: (payload) =>
    request('/auth/business/signup', { method: 'POST', body: JSON.stringify(payload) }),
  login: (payload) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  forgotPassword: (payload) =>
    request('/auth/forgot-password', { method: 'POST', body: JSON.stringify(payload) }),

  createTrip: (payload) =>
    request('/trips', { method: 'POST', body: JSON.stringify(payload) }),
  getTrip: (id) => request(`/trips/${id}`),
  listTrips: ({ q, sort, minBudget, maxBudget, startDate, endDate } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (sort) params.set('sort', sort);
    if (minBudget) params.set('minBudget', String(minBudget));
    if (maxBudget) params.set('maxBudget', String(maxBudget));
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    const qs = params.toString();
    return request(`/trips${qs ? `?${qs}` : ''}`);
  },
  deleteTrip: (id) => request(`/trips/${id}`, { method: 'DELETE' }),

  generateItinerary: (tripId) =>
    request('/itinerary/generate', { method: 'POST', body: JSON.stringify({ trip_id: tripId }) }),
  getLatestItinerary: (tripId) => request(`/itinerary/${tripId}/latest`),
  regenerateStop: (tripId, stopOrder) =>
    request(`/itinerary/${tripId}/stop/${stopOrder}/regenerate`, { method: 'POST' }),

  // AI trip assistant chat — ask it to reorder a day, swap a spot, or
  // explain why a place was picked. `history` is the recent turns of this
  // chat session ([{ role: 'user'|'assistant', content }]) so the assistant
  // has short context; for trip-scoped chats it's kept in memory only.
  // For the general assistant (no tripId), the backend now persists
  // conversation history itself (see getAssistantHistory below), so
  // `history` is optional there. `location` is an optional { lat, lng }
  // from the browser's geolocation — used for "near me"/emergency queries.
  // `mode` is UI-only (controls the widget's copy/greeting) and isn't part
  // of the backend contract, so it's intentionally not sent.
  assistantChat: ({ tripId, message, history = [], location = null }) =>
    request('/assistant/chat', {
      method: 'POST',
      body: JSON.stringify({ trip_id: tripId, message, history, location }),
    }),

  // Restores the general assistant's persisted conversation (requirement:
  // "conversation history" survives a reload). Trip-scoped chats stay
  // session-only by design.
  getAssistantHistory: () => request('/assistant/history'),

  // Live categorized "Emergency Services" (hospitals/clinics/police/pharmacies)
  // around the trip's destination — or around lat/lng if the caller has a
  // more specific anchor (e.g. current GPS position or a selected stop).
  getEmergencyServices: (tripId, { lat, lng, anchorName } = {}) => {
    const params = new URLSearchParams();
    if (lat != null) params.set('lat', String(lat));
    if (lng != null) params.set('lng', String(lng));
    if (anchorName) params.set('anchor_name', anchorName);
    const qs = params.toString();
    return request(`/trips/${tripId}/emergency${qs ? `?${qs}` : ''}`);
  },

  // Binary response — bypasses request()'s JSON parsing. Returns a Blob
  // plus the filename the server suggested via Content-Disposition.
  downloadItineraryPdf: async (tripId) => {
    const res = await fetch(`${BASE_URL}/itinerary/${tripId}/download`, { headers: getAuthHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Download failed (${res.status})`);
    }
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    return { blob: await res.blob(), filename: match?.[1] || 'itinerary.pdf' };
  },

  getSpots: ({ city, category, hiddenGems } = {}) => {
    const params = new URLSearchParams();
    if (city) params.set('city', city);
    if (category) params.set('category', category);
    if (hiddenGems) params.set('hiddenGems', 'true');
    const qs = params.toString();
    return request(`/spots${qs ? `?${qs}` : ''}`);
  },
  getSpotCategories: () => request('/spots/categories'),

  // Powers LocationAutocomplete — returns { suggestions: [...] }.
  autocompletePlaces: (query, { limit, signal } = {}) => {
    const params = new URLSearchParams({ q: query });
    if (limit) params.set('limit', String(limit));
    return request(`/places/autocomplete?${params.toString()}`, { signal });
  },

  // ---------- Offers & Deals ----------
  // Traveler-facing — public, no auth required. Returns every ACTIVE offer.
  getOffers: ({ category, businessName, discountType, minDiscount } = {}) => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (businessName) params.set('businessName', businessName);
    if (discountType) params.set('discountType', discountType);
    if (minDiscount) params.set('minDiscount', String(minDiscount));
    const qs = params.toString();
    return request(`/offers${qs ? `?${qs}` : ''}`);
  },

  // Business-facing — authenticated, scoped to the logged-in business.
  getMyOffers: () => request('/business/offers'),
  createOffer: (payload) => request('/business/offers', { method: 'POST', body: JSON.stringify(payload) }),
  updateOffer: (id, payload) => request(`/business/offers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  setOfferStatus: (id, isActive) =>
    request(`/business/offers/${id}/status`, { method: 'PATCH', body: JSON.stringify({ isActive }) }),
  deleteOffer: (id) => request(`/business/offers/${id}`, { method: 'DELETE' }),
};

// Lazily asks the browser for the user's current position (only called when
// a query actually needs it, e.g. "juice shop near me" or emergency
// services) — never requested on page load. Resolves to { lat, lng } or
// null if permission is denied/unavailable, so callers always have a safe
// fallback rather than an unhandled rejection.
export function getCurrentLocation({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: timeoutMs, maximumAge: 5 * 60 * 1000 }
    );
  });
}

// Quick heuristic used by the chat UI to decide whether a message likely
// needs the user's location before sending (so we only prompt for
// geolocation permission when it's actually relevant).
export function messageNeedsLocation(text) {
  return /\b(near me|nearby|around me|close by|current location)\b/i.test(text);
}