/**
 * Turns a complete conversational trip state into the same real itinerary
 * pipeline used by the Trip Wizard. No fake itinerary is generated here:
 * geocoding, database persistence and itinerary generation are all real.
 */
import { supabaseAdmin, isSupabaseConfigured } from '../config/supabase.js';
import { geocodePlace } from './geocoding.service.js';
import { generateItinerary } from './itineraryEngine.service.js';
import { rescheduleItineraryStops } from './schedule.service.js';

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function parseTripDate(value) {
  const raw = String(value || '').trim().replace(/(st|nd|rd|th)\b/gi, '');
  const match = raw.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i);
  if (!match) return null;
  const year = Number(match[3] || new Date().getFullYear());
  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function durationDays(value) {
  const match = String(value || '').match(/(\d{1,2})\s*(?:day|days)/i);
  return match ? Math.max(1, Number(match[1])) : null;
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizeInterests(interests = []) {
  const values = Array.isArray(interests) ? interests : [];
  const map = {
    nature: 'nature', beach: 'beaches', beaches: 'beaches', heritage: 'heritage',
    history: 'heritage', historical: 'heritage', culture: 'arts_culture',
    museum: 'heritage', museums: 'heritage', shopping: 'shopping',
    food: 'food_dining', restaurants: 'food_dining', wildlife: 'wildlife',
    photography: 'photography', adventure: 'adventure', spiritual: 'religious',
    temple: 'religious', church: 'religious', nightlife: 'nightlife',
    entertainment: 'entertainment', park: 'nature', parks: 'nature',
    garden: 'nature', gardens: 'nature', jogging: 'nature',
  };
  return [...new Set(values.map((x) => map[String(x).toLowerCase()] || x).filter(Boolean))]
    .map((category) => ({ category }));
}

export async function buildTripFromConversation({ userId, state }) {
  if (!isSupabaseConfigured || !userId) {
    return { ok: false, code: 'DATABASE_UNAVAILABLE', message: 'I need the trip database connection before I can create and save your itinerary.' };
  }

  const startDate = parseTripDate(state.travelDate);
  const days = durationDays(state.duration);
  if (!startDate || !days || !state.destination || !state.budget || !(state.origin || state.currentLocation)) {
    return { ok: false, code: 'INCOMPLETE_STATE', message: 'I still need a valid destination, date, duration, budget and starting location.' };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const requested = new Date(`${startDate}T00:00:00`);
  if (requested < today) {
    return { ok: false, code: 'PAST_DATE', message: `The requested trip date ${state.travelDate} has already passed. Please give me a future date.` };
  }

  const endDate = addDays(startDate, days - 1);
  const originName = state.origin || state.currentLocation;
  const [originGeo, destinationGeo] = await Promise.all([
    geocodePlace(originName),
    geocodePlace(state.destination),
  ]);

  if (destinationGeo.lat == null || destinationGeo.lng == null) {
    return { ok: false, code: 'DESTINATION_NOT_FOUND', message: `I couldn't reliably locate **${state.destination}**. Please give me a more specific place or city.` };
  }
  if (originGeo.lat == null || originGeo.lng == null) {
    return { ok: false, code: 'ORIGIN_NOT_FOUND', message: `I couldn't reliably locate your starting point **${originName}**. Please give me a nearby landmark or area.` };
  }

  const tripPayload = {
    traveler_id: userId,
    start_location: originName,
    start_lat: originGeo.lat,
    start_lng: originGeo.lng,
    destination: state.destination,
    destination_lat: destinationGeo.lat,
    destination_lng: destinationGeo.lng,
    end_location: originName,
    end_lat: originGeo.lat,
    end_lng: originGeo.lng,
    start_date: startDate,
    end_date: endDate,
    start_time: '09:00:00',
    end_time: '21:00:00',
    trip_name: `GoVIBE trip to ${state.destination}`,
    needs_accommodation: false,
    interests: normalizeInterests(state.interests),
    trip_style: null,
    total_budget_inr: Number(state.budget),
    adults: Number(state.people) || 1,
    kids: 0,
    elderly: 0,
    specially_abled: 0,
    transport_priority: null,
    transport_modes: [],
    food_preferences: [],
    status: 'draft',
  };

  const { data: trip, error: tripError } = await supabaseAdmin
    .from('trips')
    .insert(tripPayload)
    .select()
    .single();
  if (tripError || !trip) {
    return { ok: false, code: 'TRIP_SAVE_FAILED', message: `I couldn't save the trip yet: ${tripError?.message || 'unknown database error'}` };
  }

  try {
    const generated = await generateItinerary(trip);
    generated.stops = await rescheduleItineraryStops(generated.stops, trip);
    const { count } = await supabaseAdmin.from('itineraries').select('id', { count: 'exact', head: true }).eq('trip_id', trip.id);
    const version = (count || 0) + 1;
    const { data: itinerary, error: saveError } = await supabaseAdmin
      .from('itineraries')
      .insert({
        trip_id: trip.id,
        version,
        stops: generated.stops,
        budget_summary: { ...generated.budgetSummary, ai_extras: { ...(generated.budgetSummary?.ai_extras || {}), journey: generated.journey } },
        total_distance_km: generated.totalDistanceKm,
        total_duration_minutes: generated.totalDurationMinutes,
        generated_by: generated.generatedBy,
      })
      .select()
      .single();

    if (saveError || !itinerary) {
      await supabaseAdmin.from('trips').delete().eq('id', trip.id).eq('traveler_id', userId);
      return { ok: false, code: 'ITINERARY_SAVE_FAILED', message: `The trip was created, but I couldn't save the generated itinerary: ${saveError?.message || 'unknown database error'}` };
    }

    await supabaseAdmin.from('trips').update({ status: 'generated' }).eq('id', trip.id).eq('traveler_id', userId);
    return { ok: true, trip, itinerary, generated };
  } catch (error) {
    await supabaseAdmin.from('trips').delete().eq('id', trip.id).eq('traveler_id', userId);
    return { ok: false, code: 'ITINERARY_GENERATION_FAILED', message: `I couldn't generate a reliable itinerary for **${state.destination}** yet. ${error.message}` };
  }
}

export function formatGeneratedTripReply(result) {
  const stops = result?.itinerary?.stops || [];
  const days = [...new Set(stops.map((s) => s.day).filter(Boolean))].length || 1;
  const namedStops = stops.filter((s) => s.category !== 'accommodation').slice(0, 8).map((s) => s.name).filter(Boolean);
  const total = result?.itinerary?.budget_summary?.budget_validation?.total_estimated_cost_inr
    ?? result?.itinerary?.budget_summary?.total_budget_inr;
  const lines = [
    `Done — I created your **${result.trip.destination}** trip for **${result.trip.start_date} to ${result.trip.end_date}**.`,
    `It covers **${days} day${days === 1 ? '' : 's'}** with ${namedStops.length ? namedStops.join(', ') : 'the best verified attractions available'}.`,
  ];
  if (total != null) lines.push(`Estimated known trip cost: **₹${Number(total).toLocaleString('en-IN')}**.`);
  lines.push(`Your saved itinerary is ready to open from trip **${result.trip.id}**.`);
  return lines.join('\n\n');
}
