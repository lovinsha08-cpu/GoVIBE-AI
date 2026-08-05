import { env } from '../config/env.js';

// Amadeus Self-Service "test" environment by default — switch to
// https://api.amadeus.com in production via AMADEUS_BASE_URL.
const TOKEN_URL = `${env.amadeusBaseUrl}/v1/security/oauth2/token`;
const FLIGHT_OFFERS_URL = `${env.amadeusBaseUrl}/v2/shopping/flight-offers`;
const REQUEST_TIMEOUT_MS = 15000;

export const isAmadeusConfigured = Boolean(env.amadeusClientId && env.amadeusClientSecret);

// Simple in-memory token cache — one process-wide token, refreshed shortly
// before it actually expires. Fine for a single backend instance; if this
// ever runs multi-instance, move this to a shared cache (e.g. Supabase/Redis).
let cachedToken = null;
let cachedTokenExpiresAt = 0;

class AmadeusApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'AmadeusApiError';
    this.status = status || 502;
    this.details = details;
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new AmadeusApiError('Amadeus API request timed out', 504);
    }
    throw new AmadeusApiError(`Amadeus API request failed: ${err.message}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}

async function getAccessToken() {
  if (!isAmadeusConfigured) {
    throw new AmadeusApiError(
      'Amadeus API is not configured — set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET.',
      503
    );
  }

  // Reuse the cached token if it still has more than 30s of life left.
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 30000) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.amadeusClientId,
    client_secret: env.amadeusClientSecret,
  });

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new AmadeusApiError(
      'Failed to authenticate with Amadeus API',
      502,
      data
    );
  }

  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (data.expires_in || 1800) * 1000;
  return cachedToken;
}

function toReadableDuration(isoDuration) {
  // Amadeus durations look like "PT2H30M" — convert to "2h 30m".
  if (!isoDuration) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(isoDuration);
  if (!match) return isoDuration;
  const hours = match[1] ? `${match[1]}h` : '';
  const minutes = match[2] ? `${match[2]}m` : '';
  return [hours, minutes].filter(Boolean).join(' ') || isoDuration;
}

function normalizeOffer(offer, dictionaries) {
  const itinerary = offer.itineraries?.[0];
  const segments = itinerary?.segments || [];
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];

  if (!firstSegment || !lastSegment) return null;

  const carrierCode = firstSegment.carrierCode;
  const airlineName = dictionaries?.carriers?.[carrierCode] || carrierCode;

  return {
    airline: airlineName,
    airlineCode: carrierCode,
    flightNumber: `${carrierCode}${firstSegment.number}`,
    departureAirport: firstSegment.departure?.iataCode,
    arrivalAirport: lastSegment.arrival?.iataCode,
    departureTime: firstSegment.departure?.at,
    arrivalTime: lastSegment.arrival?.at,
    duration: toReadableDuration(itinerary?.duration),
    stops: Math.max(segments.length - 1, 0),
    price: offer.price
      ? { total: offer.price.total, currency: offer.price.currency }
      : null,
  };
}

/**
 * Search flight offers via the Amadeus Self-Service Flight Offers Search API.
 * @param {{ origin: string, destination: string, departureDate: string, adults: number }} params
 * @returns {Promise<Array>} normalized flight offers
 */
export async function searchFlightOffers({ origin, destination, departureDate, adults }) {
  const token = await getAccessToken();

  const query = new URLSearchParams({
    originLocationCode: origin,
    destinationLocationCode: destination,
    departureDate,
    adults: String(adults),
    max: '20',
  });

  const res = await fetchWithTimeout(`${FLIGHT_OFFERS_URL}?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Amadeus returns 400 with a structured `errors` array for things like
    // invalid/unknown IATA airport codes or malformed dates.
    const amadeusErrors = data.errors || [];
    const message =
      amadeusErrors[0]?.detail ||
      amadeusErrors[0]?.title ||
      'Amadeus API rejected the flight search request';
    throw new AmadeusApiError(message, res.status === 401 ? 502 : res.status, amadeusErrors);
  }

  const offers = data.data || [];
  return offers
    .map((offer) => normalizeOffer(offer, data.dictionaries))
    .filter(Boolean);
}

export { AmadeusApiError };