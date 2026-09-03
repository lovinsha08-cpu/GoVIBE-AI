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
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...options.headers },
      ...options,
    });
  } catch (networkErr) {
    throw new Error(
      `Can't reach the GoVIBE backend at ${BASE_URL}. Make sure the backend server is running (cd backend && npm run dev) and that VITE_API_URL points at the right port.`
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  travelerSignup: (payload) => request('/auth/traveler/signup', { method: 'POST', body: JSON.stringify(payload) }),
  businessSignup: (payload) => request('/auth/business/signup', { method: 'POST', body: JSON.stringify(payload) }),
  login: (payload) => request('/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  forgotPassword: (payload) => request('/auth/forgot-password', { method: 'POST', body: JSON.stringify(payload) }),

  createTrip: (payload) => request('/trips', { method: 'POST', body: JSON.stringify(payload) }),
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

  generateItinerary: (tripId) => request('/itinerary/generate', { method: 'POST', body: JSON.stringify({ trip_id: tripId }) }),
  getLatestItinerary: (tripId) => request(`/itinerary/${tripId}/latest`),
  regenerateStop: (tripId, stopOrder) => request(`/itinerary/${tripId}/stop/${stopOrder}/regenerate`, { method: 'POST' }),
  searchItineraryPlaces: (tripId, query) => {
    const params = new URLSearchParams({ q: query });
    return request(`/itinerary/${tripId}/places/search?${params.toString()}`);
  },
  replaceItineraryStop: (tripId, stopOrder, place) =>
    request(`/itinerary/${tripId}/stop/${stopOrder}/replace`, {
      method: 'POST',
      body: JSON.stringify({ place }),
    }),

  assistantChat: ({ tripId, message, history = [], location = null }) =>
    request('/assistant/chat', {
      method: 'POST',
      body: JSON.stringify({ trip_id: tripId, message, history, location }),
    }),
  getAssistantHistory: () => request('/assistant/history'),

  getEmergencyServices: (tripId, { lat, lng, anchorName } = {}) => {
    const params = new URLSearchParams();
    if (lat != null) params.set('lat', String(lat));
    if (lng != null) params.set('lng', String(lng));
    if (anchorName) params.set('anchor_name', anchorName);
    const qs = params.toString();
    return request(`/trips/${tripId}/emergency${qs ? `?${qs}` : ''}`);
  },

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

  getSpots: ({ city, category, hiddenGems, hiddenGemCategory } = {}) => {
    const params = new URLSearchParams();
    if (city) params.set('city', city);
    if (hiddenGems) {
      params.set('hiddenGems', 'true');
      if (hiddenGemCategory) params.set('hiddenGemCategory', hiddenGemCategory);
    } else if (category) {
      params.set('category', category);
    }
    const qs = params.toString();
    return request(`/spots${qs ? `?${qs}` : ''}`);
  },
  getSpotCategories: () => request('/spots/categories'),
  getHiddenGemCategories: () => request('/spots/hidden-gem-categories'),

  autocompletePlaces: (query, { limit, signal } = {}) => {
    const params = new URLSearchParams({ q: query });
    if (limit) params.set('limit', String(limit));
    return request(`/places/autocomplete?${params.toString()}`, { signal });
  },

  verifyBusinessLocation: ({ businessName, category, latitude, longitude }) =>
    request('/business-onboarding/verify-location', {
      method: 'POST',
      body: JSON.stringify({ businessName, category, latitude, longitude }),
    }),

  getOffers: ({ category, businessName, discountType, minDiscount } = {}) => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (businessName) params.set('businessName', businessName);
    if (discountType) params.set('discountType', discountType);
    if (minDiscount) params.set('minDiscount', String(minDiscount));
    const qs = params.toString();
    return request(`/offers${qs ? `?${qs}` : ''}`);
  },
  getMyOffers: () => request('/business/offers'),
  createOffer: (payload) => request('/business/offers', { method: 'POST', body: JSON.stringify(payload) }),
  updateOffer: (id, payload) => request(`/business/offers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  setOfferStatus: (id, isActive) => request(`/business/offers/${id}/status`, { method: 'PATCH', body: JSON.stringify({ isActive }) }),
  deleteOffer: (id) => request(`/business/offers/${id}`, { method: 'DELETE' }),
};

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

export function getPreciseLocation({ timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject({ code: 'unsupported', message: 'Your browser does not support location access.' });
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyMeters: pos.coords.accuracy ?? null }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) reject({ code: 'permission_denied', message: 'Location access was denied. Please allow location access and try again.' });
        else if (err.code === err.POSITION_UNAVAILABLE) reject({ code: 'position_unavailable', message: 'Your current location could not be determined. Please try again or check your device’s GPS/location settings.' });
        else if (err.code === err.TIMEOUT) reject({ code: 'timeout', message: 'Getting your location took too long. Please try again.' });
        else reject({ code: 'position_unavailable', message: 'Could not get your location. Please try again.' });
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}

export function messageNeedsLocation(text) {
  return /\b(near me|nearby|around me|close by|current location)\b/i.test(text);
}