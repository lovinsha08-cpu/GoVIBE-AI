/**
 * Transport planner.
 *
 * IMPORTANT DATA-INTEGRITY RULE:
 * Only walking/cycling and route-derived driving estimates are calculated
 * locally. Public-transport fares, route numbers, operators and schedules are
 * NOT invented. Until a verified transit feed/provider is available for a
 * city, those fields are returned as unavailable and the traveler is sent to
 * an appropriate official/provider search page where possible.
 */

const BOOKING_LINKS = {
  cab: [
    { provider: 'Uber', url: 'https://www.uber.com/global/en/ride/' },
    { provider: 'Ola', url: 'https://www.olacabs.com/' },
  ],
  bike_taxi: [
    { provider: 'Rapido', url: 'https://www.rapido.bike/' },
    { provider: 'Uber Moto', url: 'https://www.uber.com/global/en/ride/uber-moto/' },
  ],
  auto: [
    { provider: 'Ola Auto', url: 'https://www.olacabs.com/' },
    { provider: 'Uber Auto', url: 'https://www.uber.com/global/en/ride/uber-auto/' },
  ],
  train: [{ provider: 'IRCTC', url: 'https://www.irctc.co.in/nget/train-search' }],
  local_bus: [{ provider: 'Google Maps Transit', url: 'https://www.google.com/maps' }],
  metro: [{ provider: 'Google Maps Transit', url: 'https://www.google.com/maps' }],
  bicycle: [{ provider: 'Google Maps', url: 'https://www.google.com/maps' }],
  ferry: [{ provider: 'Google Maps', url: 'https://www.google.com/maps' }],
};

function bookingFor(mode) {
  return (BOOKING_LINKS[mode] || [])[0] || null;
}

function round(value, dp = 0) {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

function addMinutesToClock(clockStr, minutes) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((clockStr || '').trim());
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;

  const total = hour * 60 + minute + minutes;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  const displayHour = h % 12 || 12;
  return `${displayHour}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function walkingOption(distanceKm) {
  const duration = Math.max(1, Math.round((distanceKm / 4.5) * 60));
  return {
    mode: 'walk',
    label: 'Walking',
    distance_km: round(distanceKm, 2),
    duration_minutes: duration,
    fare_per_person: 0,
    total_fare: 0,
    fare_status: 'free',
    data_source: 'route_estimate',
    details: {
      estimated_walking_time_minutes: duration,
      fare_status: 'free',
    },
    booking: null,
    available: distanceKm <= 3,
  };
}

function bicycleOption(distanceKm, travellers) {
  const duration = Math.max(1, Math.round((distanceKm / 12) * 60) + 2);
  return {
    mode: 'bicycle',
    label: 'Bicycle',
    distance_km: round(distanceKm, 2),
    duration_minutes: duration,
    fare_per_person: null,
    total_fare: null,
    fare_status: 'unavailable',
    data_source: 'route_estimate',
    details: {
      note: 'Rental price depends on the local provider. Own bicycle: no transport fare.',
      fare_status: 'unavailable',
      travellers,
    },
    booking: bookingFor('bicycle'),
    available: distanceKm <= 8,
  };
}

function roadVehicleOption(mode, distanceKm, travellers) {
  const profiles = {
    bike_taxi: { label: 'Bike Taxi', speed: 28, base: 15, perKm: 6, seats: 1 },
    auto: { label: 'Auto', speed: 22, base: 25, perKm: 14, seats: 3 },
    cab: { label: 'Cab', speed: 26, base: 40, perKm: 13, seats: 4 },
  };
  const profile = profiles[mode];
  const duration = Math.max(1, Math.round((distanceKm / profile.speed) * 60) + 4);
  const vehicles = Math.max(1, Math.ceil(travellers / profile.seats));
  const baseFare = Math.round(profile.base + distanceKm * profile.perKm);
  const totalFare = baseFare * vehicles;

  return {
    mode,
    label: profile.label,
    distance_km: round(distanceKm, 2),
    duration_minutes: duration,
    fare_per_person: Math.round(totalFare / travellers),
    total_fare: totalFare,
    fare_status: 'estimated',
    data_source: 'route_distance_plus_estimate',
    details: {
      estimated_fare: totalFare,
      fare_status: 'estimated',
      disclaimer: 'Estimated only. Final provider fare may vary with traffic, demand, tolls, waiting and provider pricing.',
      vehicles_needed: vehicles,
    },
    booking: bookingFor(mode),
    available: true,
  };
}

function unavailableTransitOption(mode, distanceKm, travellers, fromName, toName) {
  const labels = {
    metro: 'Metro',
    local_bus: 'Local Bus',
    train: 'Train',
    ferry: 'Ferry',
  };
  const provider = bookingFor(mode);
  return {
    mode,
    label: labels[mode],
    distance_km: round(distanceKm, 2),
    duration_minutes: null,
    fare_per_person: null,
    total_fare: null,
    fare_status: 'unavailable',
    data_source: 'no_verified_transit_feed',
    boarding_point: null,
    destination_point: null,
    departure_time: null,
    arrival_time: null,
    vehicle_number: null,
    vehicle_name: null,
    details: {
      transit_data_status: 'unavailable',
      message: `No verified live ${labels[mode].toLowerCase()} route/fare feed is configured for this leg. GoVIBE will not invent a route number, operator, schedule or fare.`,
      from: fromName,
      to: toName,
      travellers,
      fare_status: 'unavailable',
    },
    booking: provider,
    available: false,
  };
}

function scoreOption(option, ctx) {
  const { priority, isLateNight, isBadWeather } = ctx;
  if (option.fare_status === 'unavailable') return Infinity;

  let score = option.duration_minutes / 60;
  if (option.fare_status === 'estimated') score += (option.total_fare || 0) / 200;
  if (priority === 'cheapest') score += (option.total_fare || 0) / 100;
  if (priority === 'fastest' || priority === 'comfortable') score -= option.duration_minutes / 180;
  if (isLateNight && ['walk', 'bicycle'].includes(option.mode) && option.distance_km > 0.6) score += 3;
  if (isLateNight && ['local_bus', 'metro', 'train'].includes(option.mode)) score += 5;
  if (isBadWeather && ['walk', 'bicycle'].includes(option.mode) && option.distance_km > 0.6) score += 3;
  return score;
}

function reason(option, ctx) {
  if (option.mode === 'walk' && option.distance_km < 0.5) return 'Under 500m — walking is the simplest option.';
  if (ctx.isBadWeather && ['walk', 'bicycle'].includes(option.mode)) return 'Weather conditions make a covered vehicle preferable.';
  if (ctx.isLateNight && ['cab', 'auto'].includes(option.mode)) return 'Late-night travel: a motorized option is more reliable.';
  if (option.fare_status === 'estimated') return 'Route time is based on routing data; fare is an estimate and may change at booking time.';
  return 'Best available verified option for this leg.';
}

export function buildTransportPlan({
  distanceKm,
  fromName,
  toName,
  travellers = 1,
  allowedModes = [],
  transportPriority,
  departureClock = '9:00 AM',
  arrivalHour = 9,
  isWeatherBad = false,
  hasMetro = false,
  longDistanceLeg = false,
  hasFerryRoute = false,
}) {
  const isLateNight = arrivalHour >= 22 || arrivalHour < 5;
  const roadOptions = [
    walkingOption(distanceKm),
    bicycleOption(distanceKm, travellers),
    roadVehicleOption('bike_taxi', distanceKm, travellers),
    roadVehicleOption('auto', distanceKm, travellers),
    roadVehicleOption('cab', distanceKm, travellers),
  ].filter((o) => o.available !== false);

  // Public transport is deliberately NOT added to the selectable candidates
  // without a verified feed. This prevents fake bus/train/metro data from
  // becoming the recommendation. The unavailable options are still exposed
  // separately so the UI can explain why live transit details are missing.
  const transitOptions = [
    ...(hasMetro ? [unavailableTransitOption('metro', distanceKm, travellers, fromName, toName)] : []),
    unavailableTransitOption('local_bus', distanceKm, travellers, fromName, toName),
    ...(longDistanceLeg ? [unavailableTransitOption('train', distanceKm, travellers, fromName, toName)] : []),
    ...(hasFerryRoute ? [unavailableTransitOption('ferry', distanceKm, travellers, fromName, toName)] : []),
  ];

  const ctx = { priority: transportPriority, isLateNight, isBadWeather: isWeatherBad };
  const preferred = roadOptions.filter((o) => allowedModes.includes(o.mode));
  const pool = preferred.length ? preferred : roadOptions;
  const recommended = [...pool].sort((a, b) => scoreOption(a, ctx) - scoreOption(b, ctx))[0];

  const cheapest = [...roadOptions].sort((a, b) => (a.total_fare ?? Infinity) - (b.total_fare ?? Infinity))[0];
  const fastest = [...roadOptions].sort((a, b) => a.duration_minutes - b.duration_minutes)[0];

  const alternatives = [...roadOptions, ...transitOptions]
    .filter((o) => o !== recommended)
    .sort((a, b) => scoreOption(a, ctx) - scoreOption(b, ctx))
    .map((o) => ({
      mode: o.mode,
      label: o.label,
      tag: o === fastest ? 'fastest' : o === cheapest ? 'cheapest' : o.fare_status === 'unavailable' ? 'live data unavailable' : null,
      fare_per_person: o.fare_per_person,
      total_fare: o.total_fare,
      fare_status: o.fare_status,
      duration_minutes: o.duration_minutes,
      distance_km: o.distance_km,
      reason: o.fare_status === 'unavailable' ? o.details.message : reason(o, ctx),
      details: o.details,
      booking_provider: o.booking?.provider || null,
      booking_url: o.booking?.url || null,
    }));

  return {
    recommended_mode: recommended.mode,
    recommended_label: recommended.label,
    recommendation_reason: reason(recommended, ctx),
    distance: recommended.distance_km,
    duration: recommended.duration_minutes,
    fare_per_person: recommended.fare_per_person,
    total_fare: recommended.total_fare,
    fare_status: recommended.fare_status,
    data_source: recommended.data_source,
    travellers,
    boarding_point: recommended.boarding_point || null,
    destination_point: recommended.destination_point || null,
    departure_time: recommended.departure_time || null,
    arrival_time: recommended.arrival_time || null,
    vehicle_number: recommended.vehicle_number || null,
    vehicle_name: recommended.vehicle_name || null,
    booking_provider: recommended.booking?.provider || null,
    booking_url: recommended.booking?.url || null,
    details: recommended.details || null,
    late_night_note: isLateNight ? 'Late-night leg — public transport availability is not assumed without verified live data.' : null,
    weather_note: isWeatherBad ? 'Weather looks rough for this leg — a covered vehicle is preferred over walking/cycling.' : null,
    alternative_options: alternatives,
    transit_data_status: 'live_feed_not_configured',
  };
}

export function buildBookingItinerary(stops, journey) {
  const items = [];

  for (const stop of stops || []) {
    const t = stop.transport;
    if (t?.booking_url && ['cab', 'bike_taxi', 'auto', 'train', 'local_bus'].includes(t.recommended_mode)) {
      items.push({
        type: 'transport',
        mode: t.recommended_mode,
        label: t.recommended_label,
        title: `${t.recommended_label} — ${stop.from_location_name || 'Start'} → ${stop.name}`,
        estimated_cost_inr: t.total_fare ?? null,
        cost_status: t.fare_status || 'unavailable',
        provider: t.booking_provider,
        booking_url: t.booking_url,
        details: {
          vehicle_number: t.vehicle_number,
          vehicle_name: t.vehicle_name,
          departure_time: t.departure_time,
          arrival_time: t.arrival_time,
        },
      });
    }

    if (stop.entry_cost_inr > 0) {
      items.push({
        type: 'attraction_entry',
        title: `Entry ticket — ${stop.name}`,
        estimated_cost_inr: stop.entry_cost_inr,
        provider: 'Official / on-site',
        booking_url: `https://www.google.com/search?q=${encodeURIComponent(stop.name + ' official ticket booking')}`,
        details: { day: stop.day, date: stop.date },
      });
    }
  }

  const endTransport = journey?.end?.transport;
  if (endTransport?.booking_url) {
    items.push({
      type: 'transport',
      mode: endTransport.recommended_mode,
      label: endTransport.recommended_label,
      title: `${endTransport.recommended_label} — ${journey.end.from_location_name} → ${journey.end.location}`,
      estimated_cost_inr: endTransport.total_fare ?? null,
      cost_status: endTransport.fare_status || 'unavailable',
      provider: endTransport.booking_provider,
      booking_url: endTransport.booking_url,
      details: {
        vehicle_number: endTransport.vehicle_number,
        vehicle_name: endTransport.vehicle_name,
        departure_time: endTransport.departure_time,
        arrival_time: endTransport.arrival_time,
      },
    });
  }

  return items;
}

// This is only a capability hint, not proof that a specific route exists.
// Actual metro routing must come from a verified transit provider/feed.
const METRO_CITIES = [
  'delhi', 'mumbai', 'bengaluru', 'bangalore', 'chennai', 'kolkata', 'hyderabad',
  'kochi', 'nagpur', 'pune', 'ahmedabad', 'jaipur', 'lucknow', 'noida', 'gurugram', 'gurgaon',
];

export function destinationHasMetro(destinationName) {
  const lower = (destinationName || '').toLowerCase();
  return METRO_CITIES.some((city) => lower.includes(city));
}
