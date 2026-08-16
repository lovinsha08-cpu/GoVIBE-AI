/**
 * Weather-aware itinerary support, powered by Open-Meteo — a free,
 * no-API-key weather API. We use it for two things:
 *  1. A short human-readable forecast note attached to the trip / each stop.
 *  2. A machine-readable "isOutdoorUnfriendly" signal the itinerary engine
 *     uses to swap outdoor spots for indoor alternatives.
 *
 * Falls back to a neutral placeholder if the API is unreachable or the
 * trip date is outside Open-Meteo's forecast window (>16 days out) —
 * weather should never block itinerary generation.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// WMO weather codes -> { label, outdoorUnfriendly }
// https://open-meteo.com/en/docs (WMO Weather interpretation codes)
const WMO_CODES = {
  0: { label: 'Clear sky', outdoorUnfriendly: false },
  1: { label: 'Mainly clear', outdoorUnfriendly: false },
  2: { label: 'Partly cloudy', outdoorUnfriendly: false },
  3: { label: 'Overcast', outdoorUnfriendly: false },
  45: { label: 'Foggy', outdoorUnfriendly: true },
  48: { label: 'Depositing rime fog', outdoorUnfriendly: true },
  51: { label: 'Light drizzle', outdoorUnfriendly: false },
  53: { label: 'Moderate drizzle', outdoorUnfriendly: true },
  55: { label: 'Dense drizzle', outdoorUnfriendly: true },
  61: { label: 'Slight rain', outdoorUnfriendly: false },
  63: { label: 'Moderate rain', outdoorUnfriendly: true },
  65: { label: 'Heavy rain', outdoorUnfriendly: true },
  71: { label: 'Slight snow', outdoorUnfriendly: true },
  73: { label: 'Moderate snow', outdoorUnfriendly: true },
  75: { label: 'Heavy snow', outdoorUnfriendly: true },
  80: { label: 'Slight rain showers', outdoorUnfriendly: false },
  81: { label: 'Moderate rain showers', outdoorUnfriendly: true },
  82: { label: 'Violent rain showers', outdoorUnfriendly: true },
  95: { label: 'Thunderstorm', outdoorUnfriendly: true },
  96: { label: 'Thunderstorm with hail', outdoorUnfriendly: true },
  99: { label: 'Thunderstorm with heavy hail', outdoorUnfriendly: true },
};

let cache = new Map(); // `${lat},${lng},${date}` -> forecast (per-process cache, cleared never — fine for a demo)

/**
 * Fetches a daily forecast for a lat/lng + date (YYYY-MM-DD).
 * Returns null (never throws) if unavailable, so callers always have a
 * clean fallback path.
 */
export async function getDailyForecast({ lat, lng, date }) {
  if (lat == null || lng == null || !date) return null;
  const key = `${lat},${lng},${date}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const url = new URL(FORECAST_URL);
    url.searchParams.set('latitude', lat);
    url.searchParams.set('longitude', lng);
    url.searchParams.set('daily', 'weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('start_date', date);
    url.searchParams.set('end_date', date);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Open-Meteo request failed: ${res.status}`);

    const data = await res.json();
    const d = data.daily;
    if (!d || !d.time?.length) throw new Error('No forecast data for this date');

    const code = d.weathercode?.[0];
    const meta = WMO_CODES[code] || { label: 'Weather unavailable', outdoorUnfriendly: false };
    const precipProb = d.precipitation_probability_max?.[0] ?? null;

    const forecast = {
      date,
      label: meta.label,
      tempMaxC: d.temperature_2m_max?.[0] ?? null,
      tempMinC: d.temperature_2m_min?.[0] ?? null,
      precipitationProbability: precipProb,
      outdoorUnfriendly: meta.outdoorUnfriendly || (precipProb != null && precipProb >= 60),
      source: 'open-meteo',
    };
    cache.set(key, forecast);
    return forecast;
  } catch {
    return null; // trip date outside forecast range, network issue, etc. — never breaks generation
  }
}

/** Human-readable one-liner for a stop's weather note. */
export function formatWeatherNote(forecast) {
  if (!forecast) return 'Live forecast not available for this date — check closer to your travel date.';
  const temp = forecast.tempMaxC != null ? `${Math.round(forecast.tempMinC)}–${Math.round(forecast.tempMaxC)}°C` : '';
  const rain = forecast.precipitationProbability != null ? `, ${forecast.precipitationProbability}% chance of rain` : '';
  return `${forecast.label}${temp ? `, ${temp}` : ''}${rain}`.trim();
}

const OUTDOOR_CATEGORIES = new Set(['nature_scenic', 'sports_adventure', 'wildlife', 'photography_landmarks']);

export function isOutdoorSpot(spot) {
  return OUTDOOR_CATEGORIES.has(spot.category);
}