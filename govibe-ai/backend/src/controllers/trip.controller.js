import { supabaseAdmin } from '../config/supabase.js';
import { geocodePlace } from '../services/geocoding.service.js';
import { getLiveEmergencyServices } from '../services/emergency.service.js';

async function resolveCoords(placeName, existingLat, existingLng) {
  if (existingLat != null && existingLng != null) {
    return { lat: existingLat, lng: existingLng, geocode_source: 'client_provided' };
  }
  if (!placeName) {
    return { lat: null, lng: null, geocode_source: 'skipped_empty' };
  }
  const result = await geocodePlace(placeName);
  return { lat: result.lat, lng: result.lng, geocode_source: result.source };
}

// POST /api/trips  — saves the wizard's 8 steps of input as a trip
export async function createTrip(req, res, next) {
  try {
    const b = req.body;
    if (!b.destination || !b.start_date || !b.end_date || !b.total_budget_inr) {
      return res.status(400).json({
        error: 'destination, start_date, end_date, and total_budget_inr are required',
      });
    }

    const [startCoords, destCoords, endCoords] = await Promise.all([
      resolveCoords(b.start_location, b.start_lat, b.start_lng),
      resolveCoords(b.destination, b.destination_lat, b.destination_lng),
      resolveCoords(b.end_location, b.end_lat, b.end_lng),
    ]);

    const geocodeWarnings = [];
    if (b.start_location && startCoords.lat == null) geocodeWarnings.push(`Couldn't locate "${b.start_location}"`);
    if (b.destination && destCoords.lat == null) geocodeWarnings.push(`Couldn't locate "${b.destination}"`);
    if (b.end_location && endCoords.lat == null) geocodeWarnings.push(`Couldn't locate "${b.end_location}"`);

    // The destination MUST have coordinates — without them every spot's
    // distance-from-anchor calculation comes out NaN, which silently drops
    // every candidate spot later in itineraryEngine.service.js and surfaces
    // as a confusing "No matching spots found" error at generation time
    // instead of here, where the real cause (geocoding failed) is clear.
    if (destCoords.lat == null || destCoords.lng == null) {
      return res.status(422).json({
        error: `Couldn't locate "${b.destination}". Please pick it from the suggestions dropdown instead of typing it freely, or try a nearby well-known place name.`,
      });
    }

    const { data, error } = await supabaseAdmin
      .from('trips')
      .insert({
        traveler_id: req.user.id,
        start_location: b.start_location,
        start_lat: startCoords.lat,
        start_lng: startCoords.lng,
        destination: b.destination,
        destination_lat: destCoords.lat,
        destination_lng: destCoords.lng,
        end_location: b.end_location,
        end_lat: endCoords.lat,
        end_lng: endCoords.lng,
        start_date: b.start_date,
        end_date: b.end_date,
        start_time: b.start_time,
        end_time: b.end_time,
        trip_name: b.trip_name || null,
        needs_accommodation: b.needs_accommodation ?? true,
        interests: b.interests || [],
        trip_style: b.trip_style || null,
        total_budget_inr: b.total_budget_inr,
        adults: b.adults ?? 1,
        kids: b.kids ?? 0,
        elderly: b.elderly ?? 0,
        specially_abled: b.specially_abled ?? 0,
        transport_priority: b.transport_priority,
        transport_modes: b.transport_modes || [],
        food_preferences: b.food_preferences || [],
        status: 'draft',
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ trip: data, geocodeWarnings });
  } catch (err) {
    next(err);
  }
}

// GET /api/trips/:id
export async function getTrip(req, res, next) {
  try {
    const { data, error } = await supabaseAdmin
      .from('trips')
      .select('*')
      .eq('id', req.params.id)
      .eq('traveler_id', req.user.id)
      .single();

    if (error) return res.status(404).json({ error: 'Trip not found' });
    res.json({ trip: data });
  } catch (err) {
    next(err);
  }
}

const SORTABLE_COLUMNS = {
  newest: { column: 'created_at', ascending: false },
  oldest: { column: 'created_at', ascending: true },
  budget_high: { column: 'total_budget_inr', ascending: false },
  budget_low: { column: 'total_budget_inr', ascending: true },
};

// GET /api/trips?q=&sort=newest|oldest|budget_high|budget_low
//   &minBudget=&maxBudget=&startDate=&endDate=
// Powers both the plain trip list and the "View Booked Itineraries" page —
// the latter additionally wants a day-count/cover-image/status summary per
// card, which is assembled here from the latest saved itinerary per trip
// rather than making the frontend fan out into N follow-up requests.
export async function listTrips(req, res, next) {
  try {
    const { q, sort, minBudget, maxBudget, startDate, endDate } = req.query;

    let query = supabaseAdmin.from('trips').select('*').eq('traveler_id', req.user.id);

    if (q) {
      const term = q.replace(/[%,]/g, '');
      query = query.or(`destination.ilike.%${term}%,trip_name.ilike.%${term}%`);
    }
    if (minBudget) query = query.gte('total_budget_inr', Number(minBudget));
    if (maxBudget) query = query.lte('total_budget_inr', Number(maxBudget));
    if (startDate) query = query.gte('start_date', startDate);
    if (endDate) query = query.lte('end_date', endDate);

    const { column, ascending } = SORTABLE_COLUMNS[sort] || SORTABLE_COLUMNS.newest;
    query = query.order(column, { ascending });

    const { data: trips, error } = await query;
    if (error) return res.status(400).json({ error: error.message });

    const summaries = await buildTripSummaries(trips);
    res.json({ trips: trips.map((t) => ({ ...t, summary: summaries[t.id] || null })) });
  } catch (err) {
    next(err);
  }
}

// Latest itinerary per trip (day count, total cost, a representative
// stop image) — best-effort: a lookup failure never blocks the trip list
// itself, it just means that trip's card shows without extra detail.
async function buildTripSummaries(trips) {
  if (!trips?.length) return {};
  const tripIds = trips.map((t) => t.id);

  const { data: itineraries } = await supabaseAdmin
    .from('itineraries')
    .select('trip_id, stops, budget_summary, total_duration_minutes, version, created_at')
    .in('trip_id', tripIds)
    .order('version', { ascending: false });

  const latestByTrip = new Map();
  (itineraries || []).forEach((it) => {
    if (!latestByTrip.has(it.trip_id)) latestByTrip.set(it.trip_id, it);
  });

  const summaries = {};
  for (const trip of trips) {
    const itinerary = latestByTrip.get(trip.id);
    const stops = itinerary?.stops || [];
    const dayCount = stops.reduce((max, s) => Math.max(max, s.day || 1), 0) || null;
    const extras = itinerary?.budget_summary?.ai_extras || {};
    const totalCost = extras.total_estimated_cost_inr ?? itinerary?.budget_summary?.total_budget_inr ?? null;
    const coverSpotName = stops.find((s) => s.category && s.category !== 'accommodation')?.name || null;

    summaries[trip.id] = {
      has_itinerary: Boolean(itinerary),
      day_count: dayCount,
      total_cost_inr: totalCost,
      cover_spot_name: coverSpotName,
    };
  }
  return summaries;
}

// DELETE /api/trips/:id — removes the trip and (via ON DELETE CASCADE)
// every saved itinerary version generated for it.
export async function deleteTrip(req, res, next) {
  try {
    const { data: existing, error: findError } = await supabaseAdmin
      .from('trips')
      .select('id')
      .eq('id', req.params.id)
      .eq('traveler_id', req.user.id)
      .single();
    if (findError || !existing) return res.status(404).json({ error: 'Trip not found' });

    const { error } = await supabaseAdmin
      .from('trips')
      .delete()
      .eq('id', req.params.id)
      .eq('traveler_id', req.user.id);
    if (error) return res.status(400).json({ error: error.message });

    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
}

// GET /api/trips/:id/emergency?lat=&lng=&anchor_name=
// Powers the "Emergency Services" button. Prefers the caller's live GPS
// coords (?lat/?lng, sent by the frontend after a successful geolocation
// permission grant); if those are missing/denied, falls back to the
// coordinates of whichever itinerary stop the traveler currently has
// selected (also passed as lat/lng by the frontend), and finally to the
// trip's destination coordinates if neither is available.
export async function getEmergencyServices(req, res, next) {
  try {
    const { data: trip, error } = await supabaseAdmin
      .from('trips')
      .select('id, destination, destination_lat, destination_lng')
      .eq('id', req.params.id)
      .eq('traveler_id', req.user.id)
      .single();
    if (error || !trip) return res.status(404).json({ error: 'Trip not found' });

    const queryLat = parseFloat(req.query.lat);
    const queryLng = parseFloat(req.query.lng);
    const hasQueryCoords = Number.isFinite(queryLat) && Number.isFinite(queryLng);

    const lat = hasQueryCoords ? queryLat : trip.destination_lat;
    const lng = hasQueryCoords ? queryLng : trip.destination_lng;
    const anchorSource = hasQueryCoords ? (req.query.anchor_name || 'current location') : trip.destination;

    const services = await getLiveEmergencyServices({ lat, lng, areaHint: anchorSource });
    res.json({ ...services, anchor: anchorSource, anchor_lat: lat, anchor_lng: lng });
  } catch (err) {
    next(err);
  }
}