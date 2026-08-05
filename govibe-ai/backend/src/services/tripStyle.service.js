/**
 * Trip Style definitions shared by the heuristic itinerary engine and the
 * full-Gemini prompt builder, so both paths reshape the itinerary the same
 * way for a given style instead of drifting apart.
 */

export const TRIP_STYLES = {
  fast_paced: {
    label: 'Fast-Paced Explorer',
    stopsPerDayMultiplier: 1.5, // more stops
    visitMinutesMultiplier: 0.7, // less time at each
    promptGuidance: 'Visit as many attractions as realistically possible each day. Spend less time at each stop and prioritize the most efficient route — this traveler wants to see the most in the least time.',
  },
  relaxed: {
    label: 'Relaxed Leisure',
    stopsPerDayMultiplier: 0.65, // fewer stops
    visitMinutesMultiplier: 1.5, // more time at each
    promptGuidance: 'Visit fewer places per day and allocate generous time at each attraction. Keep travel intensity low — avoid tight back-to-back scheduling and build in rest time.',
  },
  scenic: {
    label: 'Scenic & Photography',
    stopsPerDayMultiplier: 1,
    visitMinutesMultiplier: 1,
    promptGuidance: 'Prioritize beaches, scenic viewpoints, lakes, notable architecture, scenic roads, and sunrise/sunset spots. Schedule golden-hour stops (sunrise/sunset viewpoints) at the appropriate time of day.',
  },
  food_explorer: {
    label: 'Food Explorer',
    stopsPerDayMultiplier: 1,
    visitMinutesMultiplier: 1,
    promptGuidance: 'Weave famous restaurants, cafés, and street food naturally throughout every day — not just as an afterthought meal suggestion, but as featured stops in their own right.',
  },
  family_friendly: {
    label: 'Family Friendly',
    stopsPerDayMultiplier: 0.85,
    visitMinutesMultiplier: 1.1,
    promptGuidance: 'Prefer parks, zoos, museums, aquariums, and other child-friendly attractions. Avoid overly tiring schedules — build in breaks and avoid nightlife-oriented stops.',
  },
  budget_friendly: {
    label: 'Budget Friendly',
    stopsPerDayMultiplier: 1,
    visitMinutesMultiplier: 1,
    promptGuidance: 'Prefer free or low-cost attractions and minimize transport costs where practical (favor walking/public transport over cabs). Flag any higher-cost stop only if there is no reasonable free/cheap alternative.',
  },
  luxury: {
    label: 'Luxury Experience',
    stopsPerDayMultiplier: 0.9,
    visitMinutesMultiplier: 1.2,
    promptGuidance: 'Recommend premium attractions, fine-dining restaurants, and higher-end hotels where applicable, while still staying within the traveler\'s total budget.',
  },
  hidden_gems_only: {
    label: 'Hidden Gems Only',
    stopsPerDayMultiplier: 1,
    visitMinutesMultiplier: 1,
    promptGuidance: 'Prioritize lesser-known, offbeat attractions over crowded tourist hotspots whenever a genuinely comparable option exists. Include a brief note on why each pick is a hidden gem.',
  },
};

export function getTripStylePacing(tripStyleSlug) {
  return TRIP_STYLES[tripStyleSlug] || { stopsPerDayMultiplier: 1, visitMinutesMultiplier: 1, promptGuidance: null, label: null };
}

export function getTripStylePromptGuidance(tripStyleSlug) {
  const style = TRIP_STYLES[tripStyleSlug];
  if (!style) return 'No specific Trip Style selected — use a balanced pace and a broad mix of attraction types.';
  return `Trip Style: ${style.label}. ${style.promptGuidance}`;
}