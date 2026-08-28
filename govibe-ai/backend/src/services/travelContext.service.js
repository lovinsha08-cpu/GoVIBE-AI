/**
 * Durable Travel Context Layer for GoVIBE AI Assistant.
 *
 * The dashboard assistant normally receives a message without a trip_id.
 * This service loads the traveler's most relevant saved trip and latest
 * itinerary so the AI Travel Agent can understand follow-up messages
 * without requiring the user to repeat their trip information.
 *
 * Example:
 *
 * User:
 * "I'm planning Chennai for 2 days with my parents."
 *
 * User:
 * "Find peaceful places."
 *
 * User:
 * "Something cheaper."
 *
 * The third message can use the saved/current travel context together with
 * the conversation context.
 *
 * Current conversation context always has higher priority than this
 * background context.
 */

import {
  supabaseAdmin,
  isSupabaseConfigured
} from '../config/supabase.js';

// ------------------------------------------------------------
// Group size
// ------------------------------------------------------------

function groupSize(trip = {}) {
  const explicit =
    Number(
      trip.number_of_people ??
        trip.group_size ??
        0
    );

  if (explicit > 0) {
    return explicit;
  }

  return [
    'adults',
    'kids',
    'children',
    'elderly',
    'specially_abled'
  ].reduce(
    (sum, key) =>
      sum +
      Number(
        trip[key] || 0
      ),
    0
  );
}

// ------------------------------------------------------------
// Itinerary stop normalization
// ------------------------------------------------------------

function normalizeStops(
  stops = []
) {
  if (!Array.isArray(stops)) {
    return [];
  }

  return stops.map(
    (stop, index) => ({
      day:
        stop.day ??
        stop.day_number ??
        null,

      order:
        stop.order ??
        stop.sequence ??
        index + 1,

      name:
        stop.name ??
        stop.title ??
        stop.place_name ??
        null,

      category:
        stop.category ??
        stop.type ??
        null,

      arrival_time:
        stop.arrival_time ??
        stop.start_time ??
        stop.startTime ??
        null,

      departure_time:
        stop.departure_time ??
        stop.end_time ??
        stop.endTime ??
        null,

      duration_minutes:
        stop.duration_minutes ??
        stop.duration ??
        null,

      travel_time_minutes:
        stop.travel_time_minutes ??
        stop.travelTimeMinutes ??
        null,

      distance_km:
        stop.distance_km ??
        stop.distanceKm ??
        null,

      entry_cost_inr:
        stop.entry_cost_inr ??
        stop.entry_fee_inr ??
        stop.entryFee ??
        null
    })
  );
}

// ------------------------------------------------------------
// Get active / recent travel context
// ------------------------------------------------------------

/**
 * Loads the most relevant trip for a traveler.
 *
 * Priority:
 *
 * 1. Explicit trip_id passed by caller
 * 2. Earliest upcoming/current non-completed trip
 * 3. Most recently created trip
 */
export async function getActiveTravelContext(
  userId,
  tripHint = null
) {
  if (
    !isSupabaseConfigured ||
    !userId
  ) {
    return null;
  }

  try {
    let trip = null;

    // --------------------------------------------------------
    // 1. Explicit trip context
    // --------------------------------------------------------

    if (
      typeof tripHint ===
        'string' &&
      tripHint.trim()
    ) {
      const { data } =
        await supabaseAdmin
          .from('trips')
          .select('*')
          .eq(
            'id',
            tripHint.trim()
          )
          .eq(
            'traveler_id',
            userId
          )
          .maybeSingle();

      trip =
        data || null;
    }

    // Caller may also pass an already loaded trip object.
    if (
      !trip &&
      tripHint &&
      typeof tripHint ===
        'object'
    ) {
      trip = tripHint;
    }

    // --------------------------------------------------------
    // 2. Upcoming / current trip
    // --------------------------------------------------------

    if (!trip) {
      const { data } =
        await supabaseAdmin
          .from('trips')
          .select('*')
          .eq(
            'traveler_id',
            userId
          )
          .neq(
            'status',
            'completed'
          )
          .order(
            'start_date',
            {
              ascending: true,
              nullsFirst:
                false
            }
          )
          .limit(1)
          .maybeSingle();

      trip =
        data || null;
    }

    // --------------------------------------------------------
    // 3. Most recently created trip
    // --------------------------------------------------------

    if (!trip) {
      const { data } =
        await supabaseAdmin
          .from('trips')
          .select('*')
          .eq(
            'traveler_id',
            userId
          )
          .order(
            'created_at',
            {
              ascending: false,
              nullsFirst:
                false
            }
          )
          .limit(1)
          .maybeSingle();

      trip =
        data || null;
    }

    if (!trip) {
      return null;
    }

    // --------------------------------------------------------
    // Load latest itinerary
    // --------------------------------------------------------

    const { data: itinerary } =
      await supabaseAdmin
        .from('itineraries')
        .select(
          'id, version, stops, budget_summary, total_distance_km, total_duration_minutes, created_at'
        )
        .eq(
          'trip_id',
          trip.id
        )
        .order(
          'version',
          {
            ascending: false
          }
        )
        .limit(1)
        .maybeSingle();

    return {
      trip,
      itinerary:
        itinerary || null,

      source: tripHint
        ? 'explicit-trip-context'
        : 'active-or-recent-trip'
    };
  } catch (error) {
    console.error(
      '[travelContext] Failed to load context:',
      error.message
    );

    return null;
  }
}

// ------------------------------------------------------------
// Convert context into AI-readable prompt
// ------------------------------------------------------------

export function buildTravelContextForPrompt(
  context
) {
  if (!context?.trip) {
    return '';
  }

  const trip =
    context.trip;

  const itinerary =
    context.itinerary;

  const lines = [];

  lines.push(
    'SAVED / ACTIVE TRAVEL CONTEXT:'
  );

  // ----------------------------------------------------------
  // Trip information
  // ----------------------------------------------------------

  if (trip.trip_name) {
    lines.push(
      `Trip name: ${trip.trip_name}`
    );
  }

  if (trip.destination) {
    lines.push(
      `Destination: ${trip.destination}`
    );
  }

  if (trip.origin) {
    lines.push(
      `Origin: ${trip.origin}`
    );
  }

  if (
    trip.start_date ||
    trip.end_date
  ) {
    lines.push(
      `Dates: ${
        trip.start_date || '?'
      } to ${
        trip.end_date || '?'
      }`
    );
  }

  if (
    trip.total_budget_inr !=
    null
  ) {
    lines.push(
      `Budget: ₹${Number(
        trip.total_budget_inr
      ).toLocaleString(
        'en-IN'
      )}`
    );
  }

  // ----------------------------------------------------------
  // Group
  // ----------------------------------------------------------

  const people =
    groupSize(trip);

  if (people > 0) {
    lines.push(
      `Group size: ${people}`
    );
  }

  // ----------------------------------------------------------
  // Transport
  // ----------------------------------------------------------

  const transport =
    trip.transport_modes
      ?.length
      ? trip.transport_modes.join(
          ', '
        )
      : trip.transport_priority;

  if (transport) {
    lines.push(
      `Transport preference: ${transport}`
    );
  }

  // ----------------------------------------------------------
  // Food
  // ----------------------------------------------------------

  if (
    trip.food_preferences
      ?.length
  ) {
    lines.push(
      `Food preference: ${trip.food_preferences.join(
        ', '
      )}`
    );
  }

  // ----------------------------------------------------------
  // Interests
  // ----------------------------------------------------------

  if (
    trip.interests?.length
  ) {
    lines.push(
      `Interests: ${trip.interests.join(
        ', '
      )}`
    );
  }

  // ----------------------------------------------------------
  // Trip style
  // ----------------------------------------------------------

  if (
    trip.trip_style
  ) {
    lines.push(
      `Trip style: ${trip.trip_style}`
    );
  }

  // ----------------------------------------------------------
  // Accommodation
  // ----------------------------------------------------------

  if (
    trip.accommodation_required !=
    null
  ) {
    lines.push(
      `Accommodation required: ${
        trip.accommodation_required
          ? 'yes'
          : 'no'
      }`
    );
  }

  // ----------------------------------------------------------
  // Itinerary
  // ----------------------------------------------------------

  if (itinerary) {
    lines.push(
      `Latest itinerary version: ${
        itinerary.version ??
        'unknown'
      }`
    );

    if (
      Number.isFinite(
        Number(
          itinerary.total_distance_km
        )
      )
    ) {
      lines.push(
        `Itinerary distance: ${itinerary.total_distance_km} km`
      );
    }

    if (
      Number.isFinite(
        Number(
          itinerary.total_duration_minutes
        )
      )
    ) {
      lines.push(
        `Itinerary duration: ${itinerary.total_duration_minutes} minutes`
      );
    }

    // --------------------------------------------------------
    // Itinerary stops
    // --------------------------------------------------------

    const stops =
      normalizeStops(
        itinerary.stops
      ).slice(0, 40);

    if (stops.length) {
      lines.push(
        'CURRENT ITINERARY STOPS:'
      );

      for (
        const stop of stops
      ) {
        const parts = [
          stop.day != null
            ? `Day ${stop.day}`
            : null,

          stop.order != null
            ? `#${stop.order}`
            : null,

          stop.name,

          stop.category,

          stop.arrival_time
            ? `${stop.arrival_time}${
                stop.departure_time
                  ? `-${stop.departure_time}`
                  : ''
              }`
            : null,

          stop.distance_km !=
          null
            ? `${stop.distance_km} km`
            : null,

          stop.travel_time_minutes !=
          null
            ? `${stop.travel_time_minutes} min travel`
            : null,

          stop.entry_cost_inr !=
          null
            ? `₹${stop.entry_cost_inr}`
            : null
        ].filter(Boolean);

        if (parts.length) {
          lines.push(
            `- ${parts.join(
              ' | '
            )}`
          );
        }
      }
    } else {
      lines.push(
        'CURRENT ITINERARY STOPS: none available.'
      );
    }

    // --------------------------------------------------------
    // Budget summary
    // --------------------------------------------------------

    if (
      itinerary.budget_summary
    ) {
      lines.push(
        `ITINERARY BUDGET SUMMARY: ${JSON.stringify(
          itinerary.budget_summary
        )}`
      );
    }
  } else {
    lines.push(
      'No saved itinerary has been generated for this trip yet.'
    );
  }

  lines.push(
    `Context source: ${context.source}`
  );

  return lines.join('\n');
}