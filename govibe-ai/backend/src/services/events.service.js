/**
 * Local-events support for the itinerary: surfaces official public
 * holidays that fall inside the traveler's trip dates, powered by the
 * Nager.Date public holiday API — free, no API key required.
 *
 * Knowing a holiday falls inside the trip matters for planning: many
 * attractions run reduced hours (or close entirely) on national holidays,
 * while others (markets, temples, festival grounds) get considerably
 * busier. This never blocks itinerary generation — falls back to an
 * empty list if the API is unreachable or the country isn't covered.
 */

const HOLIDAYS_URL = 'https://date.nager.at/api/v3/PublicHolidays';

let cache = new Map(); // `${year},${countryCode}` -> full-year holiday list (per-process cache)

async function fetchHolidaysForYear(year, countryCode) {
  const key = `${year},${countryCode}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${HOLIDAYS_URL}/${year}/${countryCode}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Nager.Date request failed: ${res.status}`);

    const data = await res.json();
    const holidays = (data || []).map((h) => ({
      name: h.localName || h.name,
      date: h.date,
      note: `Public holiday${h.name && h.name !== h.localName ? ` (${h.name})` : ''} — expect busier attractions, markets, and possible reduced hours at some venues.`,
    }));
    cache.set(key, holidays);
    return holidays;
  } catch {
    cache.set(key, []); // API can be slow/unreachable/country not covered — never break the trip plan over it
    return [];
  }
}

/**
 * Returns every official public holiday that falls between startDate and
 * endDate (inclusive), as { name, date, note }. Handles trips that span a
 * year boundary by fetching each year in range. Returns [] (never throws)
 * if dates are missing or the API is unavailable.
 */
export async function getLocalEvents({ startDate, endDate, countryCode = 'IN' } = {}) {
  if (!startDate || !endDate) return [];

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const years = [];
  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) years.push(y);

  const yearlyResults = await Promise.all(years.map((y) => fetchHolidaysForYear(y, countryCode)));
  const allHolidays = yearlyResults.flat();

  return allHolidays
    .filter((h) => {
      const d = new Date(h.date);
      return d >= start && d <= end;
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}