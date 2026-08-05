/**
 * Real backend "tools" exposed to Gemini function calling (requirement 5),
 * consumed by orchestrator.service.js.
 *
 *   getFunctionDeclarations(role) — the Gemini FunctionDeclaration[] the
 *     model is allowed to call for this role ('traveler' | 'business').
 *   getFunctionHandler(name, role) — looks up the real handler for a
 *     function the model decided to call, scoped to that role (so a
 *     traveler-only function can never be invoked while chatting as a
 *     business, and vice versa).
 *
 * Every handler is `(args, context) => response`, where context is
 * `{ userId, role, lat, lng }` (lat/lng come from the browser's
 * geolocation, forwarded by orchestrator.service.js). Handlers never
 * throw — they catch internally and return `{ error }` so a bad/failed
 * call degrades into a conversational "I couldn't find that" instead of
 * crashing the whole turn.
 */
import { supabaseAdmin, isSupabaseConfigured } from '../config/supabase.js';
import { searchNearby } from './nearbySearch.service.js';
import { getDailyForecast, formatWeatherNote } from './weather.service.js';
import { routeDistance, haversineKm, estimateTravelMinutes } from './geo.service.js';
import { getLiveEmergencyServices } from './emergency.service.js';
import { geocodePlace } from './geocoding.service.js';

// ------------------------------------------------------------
// Small shared helpers
// ------------------------------------------------------------

/** Resolves a place name (or an explicit lat/lng pair) down to coordinates. Falls back to the caller's current location (context) when neither is given. */
async function resolveLocation({ place, lat, lng }, context) {
  if (lat != null && lng != null) return { lat, lng, label: place || 'that location', source: 'provided' };
  if (place) {
    const geo = await geocodePlace(place);
    if (geo.lat != null) return { lat: geo.lat, lng: geo.lng, label: place, source: geo.source };
    return null;
  }
  if (context?.lat != null && context?.lng != null) {
    return { lat: context.lat, lng: context.lng, label: 'your current location', source: 'device_gps' };
  }
  return null;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ------------------------------------------------------------
// Traveler handlers
// ------------------------------------------------------------

/** Lists the logged-in traveler's own trips, optionally filtered by status. */
async function handleGetMyTrips(args, context) {
  if (!isSupabaseConfigured) return { error: 'Database not configured' };
  if (!context.userId) return { error: 'No logged-in traveler for this session.' };

  let query = supabaseAdmin
    .from('trips')
    .select('id, trip_name, destination, start_date, end_date, total_budget_inr, status, created_at')
    .eq('traveler_id', context.userId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (args?.status) query = query.eq('status', args.status);

  const { data, error } = await query;
  if (error) return { error: error.message };
  return { trips: data || [], count: data?.length || 0 };
}

/** Resolves a trip_id (or, if omitted, the traveler's most recent trip) plus its latest saved itinerary summary. */
async function loadTripAndLatestItinerary(tripId, userId) {
  let tripQuery = supabaseAdmin.from('trips').select('*').eq('traveler_id', userId);
  tripQuery = tripId ? tripQuery.eq('id', tripId) : tripQuery.order('created_at', { ascending: false });
  const { data: trip, error: tripError } = await tripQuery.limit(1).maybeSingle();
  if (tripError || !trip) return { trip: null };

  const { data: itinerary } = await supabaseAdmin
    .from('itineraries')
    .select('stops, budget_summary, total_distance_km, total_duration_minutes, version, created_at')
    .eq('trip_id', trip.id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  return { trip, itinerary: itinerary || null };
}

/** The traveler's day-by-day itinerary for a trip (defaults to their most recent trip). */
async function handleGetTripItinerary(args, context) {
  if (!isSupabaseConfigured) return { error: 'Database not configured' };
  if (!context.userId) return { error: 'No logged-in traveler for this session.' };

  const { trip, itinerary } = await loadTripAndLatestItinerary(args?.trip_id, context.userId);
  if (!trip) return { error: args?.trip_id ? 'Trip not found.' : "You don't have any trips yet." };
  if (!itinerary) return { trip_id: trip.id, destination: trip.destination, message: 'No itinerary has been generated for this trip yet.' };

  const stops = (itinerary.stops || []).map((s) => ({
    day: s.day, order: s.order, name: s.name, category: s.category,
    arrival_time: s.arrival_time || null, entry_cost_inr: s.entry_cost_inr ?? null,
  }));

  return {
    trip_id: trip.id,
    destination: trip.destination,
    start_date: trip.start_date,
    end_date: trip.end_date,
    total_distance_km: itinerary.total_distance_km,
    total_duration_minutes: itinerary.total_duration_minutes,
    stops,
  };
}

/** Budget breakdown for a trip (defaults to their most recent trip). */
async function handleGetTripBudget(args, context) {
  if (!isSupabaseConfigured) return { error: 'Database not configured' };
  if (!context.userId) return { error: 'No logged-in traveler for this session.' };

  const { trip, itinerary } = await loadTripAndLatestItinerary(args?.trip_id, context.userId);
  if (!trip) return { error: args?.trip_id ? 'Trip not found.' : "You don't have any trips yet." };

  return {
    trip_id: trip.id,
    destination: trip.destination,
    total_budget_inr: trip.total_budget_inr,
    budget_summary: itinerary?.budget_summary || null,
  };
}

/** The logged-in traveler's own profile. */
async function handleGetTravelerProfile(_args, context) {
  if (!isSupabaseConfigured) return { error: 'Database not configured' };
  if (!context.userId) return { error: 'No logged-in traveler for this session.' };
  const { data, error } = await supabaseAdmin
    .from('travelers').select('full_name, phone, created_at').eq('id', context.userId).maybeSingle();
  if (error || !data) return { error: 'Profile not found.' };
  return data;
}

// ------------------------------------------------------------
// Business handlers
// ------------------------------------------------------------

/** Offers belonging to the logged-in business, optionally filtered by active/inactive status. */
async function handleGetMyOffers(args, context) {
  if (!isSupabaseConfigured) return { error: 'Database not configured' };
  if (!context.userId) return { error: 'No logged-in business for this session.' };

  let query = supabaseAdmin.from('offers').select('*').eq('business_id', context.userId).order('created_at', { ascending: false });
  if (args?.status === 'active') query = query.eq('is_active', true);
  if (args?.status === 'inactive') query = query.eq('is_active', false);

  const { data, error } = await query;
  if (error) return { error: error.message };
  return {
    offers: (data || []).map((o) => ({
      id: o.id, title: o.title, category: o.category, discount_type: o.discount_type,
      discount_value: o.discount_value, valid_until: o.valid_until, is_active: o.is_active,
      views: o.views ?? null, bookings_attributed: o.bookings_attributed ?? null,
    })),
    count: data?.length || 0,
  };
}

/** Aggregate performance (views / attributed bookings) across the business's own offers — the closest thing this platform has to "analytics"/"revenue" data. */
async function handleGetOfferPerformance(_args, context) {
  if (!isSupabaseConfigured) return { error: 'Database not configured' };
  if (!context.userId) return { error: 'No logged-in business for this session.' };

  const { data, error } = await supabaseAdmin
    .from('offers').select('title, is_active, views, bookings_attributed').eq('business_id', context.userId);
  if (error) return { error: error.message };
  if (!data?.length) return { message: 'No offers yet.', offers: [] };

  const totals = data.reduce((acc, o) => ({
    views: acc.views + (o.views || 0),
    bookings_attributed: acc.bookings_attributed + (o.bookings_attributed || 0),
  }), { views: 0, bookings_attributed: 0 });

  return {
    total_offers: data.length,
    active_offers: data.filter((o) => o.is_active).length,
    totals,
    by_offer: data.map((o) => ({ title: o.title, views: o.views ?? null, bookings_attributed: o.bookings_attributed ?? null })),
  };
}

/** The logged-in business's own profile/listing. */
async function handleGetBusinessProfile(_args, context) {
  if (!isSupabaseConfigured) return { error: 'Database not configured' };
  if (!context.userId) return { error: 'No logged-in business for this session.' };
  const { data, error } = await supabaseAdmin
    .from('businesses')
    .select('business_name, business_model, location, category, description, phone, verified, created_at')
    .eq('id', context.userId).maybeSingle();
  if (error || !data) return { error: 'Profile not found.' };
  return data;
}

// ------------------------------------------------------------
// Shared handlers (both roles)
// ------------------------------------------------------------

/** Active, currently-valid offers across all businesses (what a traveler sees on the Offers tab; a business can use it to check the competitive landscape). */
async function handleGetOffers(args) {
  if (!isSupabaseConfigured) return { error: 'Database not configured' };
  const today = todayIso();

  let query = supabaseAdmin
    .from('offers')
    .select('title, description, category, discount_type, discount_value, valid_until, businesses(business_name)')
    .eq('is_active', true)
    .or(`valid_until.is.null,valid_until.gte.${today}`)
    .order('created_at', { ascending: false })
    .limit(15);
  if (args?.category) query = query.eq('category', args.category);
  if (args?.min_discount_value) query = query.gte('discount_value', Number(args.min_discount_value));

  const { data, error } = await query;
  if (error) return { error: error.message };

  let offers = (data || []).map((o) => ({
    title: o.title, description: o.description, category: o.category,
    discount_type: o.discount_type, discount_value: o.discount_value,
    valid_until: o.valid_until, business_name: o.businesses?.business_name || 'Local business',
  }));
  if (args?.business_name) {
    const needle = args.business_name.toLowerCase();
    offers = offers.filter((o) => o.business_name.toLowerCase().includes(needle));
  }
  return { offers, count: offers.length };
}

/** "X near me" — restaurants/hotels/ATMs/hospitals/etc. near the caller's current location or a named place. */
async function handleFindNearby(args, context) {
  const loc = await resolveLocation({ place: args?.near }, context);
  if (!loc) return { error: "I need a location to search near — please share your current location or name a place." };

  const result = await searchNearby({ lat: loc.lat, lng: loc.lng, query: args?.query, radiusMeters: args?.radius_meters });
  return {
    searched_near: loc.label,
    resolved_category: result.resolvedCategory,
    results: result.results.map((r) => ({
      name: r.business_name || r.name, category: r.category || null,
      distance_km: r.distanceKm, rating: r.rating ?? null,
      is_govibe_partner: Boolean(r.isGovibePartner), address: r.location || r.address || null,
    })),
    source: result.source,
  };
}

/** Weather forecast for a date at a place name or lat/lng (defaults to the caller's current location). */
async function handleGetWeather(args, context) {
  const loc = await resolveLocation({ place: args?.location, lat: args?.lat, lng: args?.lng }, context);
  if (!loc) return { error: "I need a location — please name a place or share your current location." };

  const date = args?.date || todayIso();
  const forecast = await getDailyForecast({ lat: loc.lat, lng: loc.lng, date });
  if (!forecast) return { location: loc.label, date, error: 'Forecast unavailable for that date/location (Open-Meteo only covers roughly the next 16 days).' };

  return { location: loc.label, ...forecast, summary: formatWeatherNote(forecast) };
}

/** Distance/route/travel-time between two places (or from the caller's current location to a named place). */
async function handleGetRoute(args, context) {
  const from = await resolveLocation({ place: args?.origin }, context);
  const to = await resolveLocation({ place: args?.destination }, context);
  if (!from) return { error: `Couldn't locate the starting point${args?.origin ? ` "${args.origin}"` : ''}.` };
  if (!to) return { error: `Couldn't locate the destination${args?.destination ? ` "${args.destination}"` : ''}.` };

  const mode = args?.mode || 'cab';
  const route = await routeDistance({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }, mode);
  const distanceKm = route?.distanceKm ?? haversineKm(from.lat, from.lng, to.lat, to.lng);
  const durationMinutes = route?.durationMinutes ?? estimateTravelMinutes(distanceKm, mode);

  return {
    from: from.label, to: to.label, mode,
    distance_km: Number(distanceKm.toFixed(1)),
    duration_minutes: durationMinutes,
    source: route?.source || 'estimated',
  };
}

/** Live emergency services (hospitals, clinics, police, pharmacies) near the caller's current location or a named place. */
async function handleGetEmergencyServices(args, context) {
  const loc = await resolveLocation({ place: args?.near }, context);
  if (!loc) return { error: "I need a location — please share your current location or name a place." };

  const services = await getLiveEmergencyServices({ lat: loc.lat, lng: loc.lng, areaHint: loc.label });
  return { near: loc.label, ...services };
}

// ------------------------------------------------------------
// Declarations (Gemini function-calling schema) + registry
// ------------------------------------------------------------

const SHARED_DECLARATIONS = [
  {
    name: 'find_nearby',
    description: "Finds real places (restaurants, cafes, hotels, ATMs, hospitals, pharmacies, petrol pumps, shopping, activities, GoVIBE partner businesses) near the traveler's current location or a named place. ALWAYS call this for any '[thing] near me' / 'nearby [thing]' question.",
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: "What to search for, e.g. 'juice shop', 'hospital', 'ATM', 'restaurant'." },
        near: { type: 'STRING', description: 'Optional named place to search near. Omit to use the current location already available to this tool.' },
        radius_meters: { type: 'NUMBER', description: 'Search radius in meters. Defaults to 3000.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_weather_forecast',
    description: 'Gets the weather forecast for a date at a place. Use for any weather/forecast/"will it rain" question.',
    parameters: {
      type: 'OBJECT',
      properties: {
        location: { type: 'STRING', description: 'Place name, e.g. "Ooty" or "Chennai". Omit to use the current location.' },
        date: { type: 'STRING', description: 'Date in YYYY-MM-DD format. Defaults to today. Only near-term dates (~16 days out) are supported.' },
      },
      required: [],
    },
  },
  {
    name: 'get_route',
    description: 'Gets distance, travel time, and mode between two places (or from the current location to a place). Use for route/distance/directions/"how far" questions.',
    parameters: {
      type: 'OBJECT',
      properties: {
        origin: { type: 'STRING', description: 'Starting place name. Omit to use the current location.' },
        destination: { type: 'STRING', description: 'Destination place name.' },
        mode: { type: 'STRING', enum: ['walk', 'bike', 'cab', 'car', 'bus', 'train'], description: 'Travel mode. Defaults to cab.' },
      },
      required: ['destination'],
    },
  },
  {
    name: 'get_emergency_services',
    description: 'Finds live nearby emergency services — hospitals, clinics, police, pharmacies — near the current location or a named place. Use for any emergency/hospital/pharmacy/police question.',
    parameters: {
      type: 'OBJECT',
      properties: {
        near: { type: 'STRING', description: 'Optional named place. Omit to use the current location.' },
      },
      required: [],
    },
  },
  {
    name: 'get_offers',
    description: "Lists currently active GoVIBE offers/deals from local businesses. Use when asked about deals, discounts, or offers (traveler's own offers feed, or a business checking what's currently live on the platform).",
    parameters: {
      type: 'OBJECT',
      properties: {
        category: { type: 'STRING', description: "Offer category, e.g. 'food', 'stay', 'activity', 'shopping'." },
        business_name: { type: 'STRING', description: 'Filter by (partial) business name.' },
        min_discount_value: { type: 'NUMBER', description: 'Minimum discount value to include.' },
      },
      required: [],
    },
  },
];

const TRAVELER_DECLARATIONS = [
  ...SHARED_DECLARATIONS,
  {
    name: 'get_my_trips',
    description: "Lists the traveler's own saved trips. Use for 'my trips'/'my bookings' questions.",
    parameters: {
      type: 'OBJECT',
      properties: {
        status: { type: 'STRING', enum: ['draft', 'generated', 'booked', 'completed'], description: 'Optional status filter.' },
      },
      required: [],
    },
  },
  {
    name: 'get_trip_itinerary',
    description: "Gets the day-by-day itinerary (stops, order, timing) for one of the traveler's trips. Defaults to their most recent trip if trip_id is omitted.",
    parameters: {
      type: 'OBJECT',
      properties: {
        trip_id: { type: 'STRING', description: "The trip's id. Omit to use the traveler's most recent trip." },
      },
      required: [],
    },
  },
  {
    name: 'get_trip_budget',
    description: "Gets the budget breakdown for one of the traveler's trips (total budget + per-category spend). Defaults to their most recent trip if trip_id is omitted.",
    parameters: {
      type: 'OBJECT',
      properties: {
        trip_id: { type: 'STRING', description: "The trip's id. Omit to use the traveler's most recent trip." },
      },
      required: [],
    },
  },
  {
    name: 'get_my_profile',
    description: "Gets the traveler's own GoVIBE profile.",
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
];

const BUSINESS_DECLARATIONS = [
  ...SHARED_DECLARATIONS,
  {
    name: 'get_my_offers',
    description: "Lists the offers/deals the logged-in business has posted on GoVIBE.",
    parameters: {
      type: 'OBJECT',
      properties: {
        status: { type: 'STRING', enum: ['active', 'inactive', 'all'], description: 'Optional status filter. Defaults to all.' },
      },
      required: [],
    },
  },
  {
    name: 'get_offer_performance',
    description: "Gets performance numbers (views, attributed bookings) across the business's own offers — the platform's analytics/revenue-signal data.",
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'get_my_profile',
    description: "Gets the business's own GoVIBE profile/listing.",
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
];

// name -> role -> handler
const HANDLERS = {
  find_nearby: { traveler: handleFindNearby, business: handleFindNearby },
  get_weather_forecast: { traveler: handleGetWeather, business: handleGetWeather },
  get_route: { traveler: handleGetRoute, business: handleGetRoute },
  get_emergency_services: { traveler: handleGetEmergencyServices, business: handleGetEmergencyServices },
  get_offers: { traveler: handleGetOffers, business: handleGetOffers },
  get_my_trips: { traveler: handleGetMyTrips },
  get_trip_itinerary: { traveler: handleGetTripItinerary },
  get_trip_budget: { traveler: handleGetTripBudget },
  get_my_offers: { business: handleGetMyOffers },
  get_offer_performance: { business: handleGetOfferPerformance },
  get_my_profile: { traveler: handleGetTravelerProfile, business: handleGetBusinessProfile },
};

/** Returns the Gemini function-calling tool set for a role. */
export function getFunctionDeclarations(role) {
  return role === 'business' ? BUSINESS_DECLARATIONS : TRAVELER_DECLARATIONS;
}

/** Looks up the real handler for a function call the model made, scoped to the caller's role. Returns null if the function doesn't exist or isn't available to this role. */
export function getFunctionHandler(name, role) {
  const entry = HANDLERS[name];
  if (!entry) return null;
  return entry[role === 'business' ? 'business' : 'traveler'] || null;
}