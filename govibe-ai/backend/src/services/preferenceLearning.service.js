import { supabaseAdmin, isSupabaseConfigured } from '../config/supabase.js';

/**
 * Personalized learning system. Rather than a separate ML pipeline, this
 * learns directly from the traveler's own trip history already stored in
 * the `trips` table (interests, budget, transport priority, food prefs,
 * destinations) — no new schema needed, and it improves automatically as
 * the traveler plans more trips.
 *
 * Returns null (never throws) when Supabase isn't configured, the
 * traveler has no prior trips, or the query fails — callers should treat
 * "no learned preferences yet" as a normal, expected state for new users.
 */
export async function learnTravelerPreferences(travelerId, excludeTripId) {
  if (!isSupabaseConfigured || !travelerId) return null;

  try {
    let query = supabaseAdmin
      .from('trips')
      .select('interests, total_budget_inr, transport_priority, food_preferences, destination, start_date, end_date')
      .eq('traveler_id', travelerId)
      .order('created_at', { ascending: false })
      .limit(15);
    if (excludeTripId) query = query.neq('id', excludeTripId);

    const { data, error } = await query;
    if (error || !data?.length) return null;

    const categoryCounts = {};
    const foodCounts = {};
    const transportCounts = {};
    const destinationCounts = {};
    let budgetSum = 0, budgetCount = 0, durationSum = 0, durationCount = 0;

    for (const t of data) {
      (t.interests || []).forEach((i) => { if (i?.category) categoryCounts[i.category] = (categoryCounts[i.category] || 0) + 1; });
      (t.food_preferences || []).forEach((f) => { foodCounts[f] = (foodCounts[f] || 0) + 1; });
      if (t.transport_priority) transportCounts[t.transport_priority] = (transportCounts[t.transport_priority] || 0) + 1;
      if (t.destination) destinationCounts[t.destination] = (destinationCounts[t.destination] || 0) + 1;
      if (t.total_budget_inr) { budgetSum += Number(t.total_budget_inr); budgetCount += 1; }
      if (t.start_date && t.end_date) {
        const days = Math.round((new Date(t.end_date) - new Date(t.start_date)) / (1000 * 60 * 60 * 24)) + 1;
        if (days > 0) { durationSum += days; durationCount += 1; }
      }
    }

    if (data.length < 2) return null; // wait for at least a couple of trips before "learning" anything

    return {
      trips_analyzed: data.length,
      favorite_interest_categories: topEntries(categoryCounts, 3),
      preferred_food: topEntries(foodCounts, 2),
      preferred_transport_priority: topEntries(transportCounts, 1)[0] || null,
      frequent_destinations: topEntries(destinationCounts, 3),
      avg_budget_inr: budgetCount ? Math.round(budgetSum / budgetCount) : null,
      avg_trip_duration_days: durationCount ? Math.round(durationSum / durationCount) : null,
    };
  } catch {
    return null;
  }
}

function topEntries(counts, n) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key]) => key);
}

/**
 * Gently nudges this trip's interest list toward categories the traveler
 * has liked across past trips — additive, not a replacement, so an
 * explicit choice this trip always still counts. Spots matching these
 * extra categories score the same as any other interest match
 * (see spotMatching.service.js's scoreSpot), so it's a soft boost rather
 * than a hard override.
 */
export function applyLearnedInterestBoost(interests, learned) {
  if (!learned?.favorite_interest_categories?.length) return interests;
  const existing = new Set((interests || []).map((i) => i.category));
  const boosted = [...(interests || [])];
  for (const category of learned.favorite_interest_categories) {
    if (!existing.has(category)) {
      boosted.push({ category, subcategories: [], learned: true });
    }
  }
  return boosted;
}