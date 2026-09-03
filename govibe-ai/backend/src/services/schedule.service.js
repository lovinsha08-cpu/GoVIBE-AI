import { routeDistance, haversineKm, estimateTravelMinutes } from './geo.service.js';

const MEAL_WINDOWS = {
  breakfast: { start: 360, end: 600, visit: 30 },
  lunch: { start: 690, end: 870, visit: 60 },
  cafe: { start: 960, end: 1080, visit: 30 },
  dinner: { start: 1140, end: 1260, visit: 60 },
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Rebuilds the generated stop timeline against the user's exact start/end
 * times and known opening hours. It is intentionally a post-generation
 * guard: both Gemini and heuristic itineraries pass through the same
 * scheduler before being persisted, and replacement operations can reuse it.
 */
export async function rescheduleItineraryStops(stops, trip) {
  if (!Array.isArray(stops) || !stops.length) return stops || [];

  const byDay = new Map();
  for (const stop of stops) {
    const day = Number(stop.day) || 1;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(stop);
  }

  const result = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const date = addDays(trip.start_date, day - 1);
    const dayStops = byDay.get(day).map((s) => ({ ...s, date }));
    const startMin = parseTime(day === 1 ? trip.start_time : (trip.start_time || '09:00')) ?? 540;
    const endMin = parseTime(trip.end_time) ?? 1260;
    result.push(...await scheduleDay(dayStops, trip, { date, startMin, endMin }));
  }

  result.forEach((s, i) => { s.order = i + 1; });
  return result;
}

async function scheduleDay(stops, trip, { date, startMin, endMin }) {
  const out = [];
  let clock = startMin;
  let previous = null;
  let remaining = [...stops];

  while (remaining.length) {
    const choice = await chooseNextStop(remaining, previous, trip, clock, endMin, date);
    if (!choice) {
      for (const stop of remaining) {
        out.push({
          ...stop,
          date,
          schedule_status: 'not_scheduled',
          schedule_warning: `Cannot fit this stop before the selected end time (${formatClock(endMin)}), or its opening hours are unavailable in the remaining window.`,
        });
      }
      break;
    }

    const { stop, leg, arrival, departure } = choice;
    remaining = remaining.filter((s) => s !== stop);
    out.push({
      ...stop,
      date,
      arrival_time: formatClock(arrival),
      departure_time: formatClock(departure),
      distance_km_from_prev: leg.distanceKm,
      travel_minutes_from_prev: leg.minutes,
      route_source: leg.source,
      schedule_status: 'scheduled',
      schedule_warning: null,
      from_location_name: previous?.name || trip.start_location || trip.destination,
      to_location_name: stop.name,
    });
    clock = departure;
    previous = out[out.length - 1];
  }
  return out;
}

async function chooseNextStop(remaining, previous, trip, clock, endMin, date) {
  const from = previous && Number.isFinite(previous.latitude) && Number.isFinite(previous.longitude)
    ? { lat: previous.latitude, lng: previous.longitude }
    : { lat: trip.start_lat ?? trip.destination_lat, lng: trip.start_lng ?? trip.destination_lng };
  if (!Number.isFinite(from.lat) || !Number.isFinite(from.lng)) return null;

  const choices = [];
  for (const stop of remaining) {
    if (!Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)) continue;
    const to = { lat: stop.latitude, lng: stop.longitude };
    const mode = stop.transport_mode || 'cab';
    const result = await routeDistance(from, to, mode);
    const fallbackMinutes = estimateTravelMinutes(haversineKm(from.lat, from.lng, to.lat, to.lng), mode);
    const travel = Math.max(Number(result.durationMinutes) || fallbackMinutes || 0, from.lat === to.lat && from.lng === to.lng ? 0 : 2);
    let arrival = clock + travel;

    const meal = MEAL_WINDOWS[stop.meal_type];
    if (meal) {
      if (arrival < meal.start) arrival = meal.start;
      if (arrival > meal.end) continue;
    }

    const opening = parseOpeningHours(stop.opening_hours, date);
    if (opening.closed) continue;
    if (opening.windows.length) {
      const fit = findOpeningSlot(opening.windows, arrival, visitDuration(stop));
      if (!fit) continue;
      arrival = fit.start;
    }

    const departure = arrival + visitDuration(stop);
    if (departure > endMin) continue;
    if (meal && departure > meal.end) continue;

    const openingPriority = opening.windows.length ? 0 : 1;
    const mealPriority = meal ? 0 : 1;
    choices.push({
      stop,
      leg: {
        distanceKm: Math.round((Number(result.distanceKm) || haversineKm(from.lat, from.lng, to.lat, to.lng)) * 10) / 10,
        minutes: Math.round(travel),
        source: result.source || 'routing',
      },
      arrival,
      departure,
      score: mealPriority * 100000 + openingPriority * 10000 + (arrival - clock) + (Number(result.distanceKm) || 0) * 10,
    });
  }

  choices.sort((a, b) => a.score - b.score);
  return choices[0] || null;
}

function visitDuration(stop) {
  return Math.max(15, Number(stop.visit_minutes) || MEAL_WINDOWS[stop.meal_type]?.visit || 60);
}

function findOpeningSlot(windows, arrival, duration) {
  for (const [start, end] of windows) {
    const candidate = Math.max(arrival, start);
    if (candidate + duration <= end) return { start, end };
  }
  return null;
}

function parseOpeningHours(value, date) {
  if (!value || typeof value !== 'string') return { windows: [], closed: false };
  const dayName = DAY_NAMES[new Date(date).getDay()];
  let text = value.trim();
  const daySpecific = new RegExp(`${dayName}\\s*[:\\-]\\s*([^;|]+)`, 'i').exec(text);
  if (daySpecific) text = daySpecific[1];
  else if (/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/i.test(text)) return { windows: [], closed: true };
  if (/closed/i.test(text)) return { windows: [], closed: true };

  const windows = [];
  for (const part of text.split(/[,;|]/)) {
    const matches = [...part.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/gi)];
    for (const m of matches) {
      const start = clockPart(m[1], m[2], m[3]);
      const end = clockPart(m[4], m[5], m[6] || m[3]);
      if (start != null && end != null && end > start) windows.push([start, end]);
    }
  }
  return { windows, closed: false };
}

function clockPart(h, m, period) {
  let hour = Number(h);
  const minute = Number(m || 0);
  if (period) {
    const p = period.toUpperCase();
    if (p === 'PM' && hour !== 12) hour += 12;
    if (p === 'AM' && hour === 12) hour = 0;
  }
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : null;
}

function parseTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const sql = /^(\d{1,2}):(\d{2})/.exec(text);
  if (sql) return Number(sql[1]) * 60 + Number(sql[2]);
  const clock = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(text);
  return clock ? clockPart(clock[1], clock[2], clock[3]) : null;
}

function formatClock(minutes) {
  const h24 = Math.floor(Math.max(0, minutes) / 60) % 24;
  const minute = Math.max(0, minutes) % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const hour = h24 % 12 || 12;
  return `${hour}:${String(minute).padStart(2, '0')} ${period}`;
}

function addDays(startDate, offset) {
  const d = new Date(startDate);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
