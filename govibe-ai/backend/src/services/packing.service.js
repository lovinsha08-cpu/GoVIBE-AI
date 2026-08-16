/**
 * Packing-list suggestions. Pure heuristic (like budget.service.js and
 * routing.service.js's crowd estimate) driven by real trip inputs: the
 * live weather forecast already fetched for this trip, trip length,
 * selected interests, and group composition — so the list actually
 * reflects this specific trip instead of a generic template.
 */
export function buildPackingList({
  forecast,
  dayCount = 1,
  interests = [],
  groupComposition = {},
  needsAccommodation = true,
}) {
  const items = [];
  const add = (item) => { if (!items.includes(item)) items.push(item); };

  // Always-useful basics
  add('Reusable water bottle');
  add('Phone charger + power bank');
  add('ID / travel documents (physical + photo backup)');
  add('Basic first-aid kit (band-aids, pain reliever, motion-sickness tablets)');
  add('Hand sanitizer and wet wipes');

  // Weather-driven
  if (forecast) {
    if (forecast.tempMaxC != null && forecast.tempMaxC >= 30) {
      add('Sunscreen (SPF 30+), sunglasses, and a wide-brim hat');
      add('Light, breathable cotton clothing');
    }
    if (forecast.tempMinC != null && forecast.tempMinC <= 15) {
      add('Light jacket or sweater for cooler mornings/evenings');
    }
    if (forecast.outdoorUnfriendly) {
      add('Compact umbrella or rain poncho');
      add('Waterproof pouch/cover for phone and electronics');
      add('Quick-dry, non-slip footwear');
    }
  } else {
    add('Weather-flexible layers (forecast wasn\'t available — pack for a range of conditions)');
  }

  // Interest-driven
  const categories = new Set((interests || []).map((i) => i.category));
  if (categories.has('sports_adventure') || categories.has('nature_scenic') || categories.has('wildlife')) {
    add('Comfortable walking/hiking shoes');
    add('Insect repellent');
    add('Small daypack for excursions');
  }
  if (categories.has('heritage_historical') || categories.has('religious_spiritual')) {
    add('Modest clothing that covers shoulders/knees (required at many temples/forts)');
  }
  if (categories.has('nightlife')) {
    add('One dressier outfit for evenings out');
  }
  if (categories.has('shopping')) {
    add('A foldable spare tote/duffel for purchases');
  }

  // Group-driven
  if ((groupComposition.kids || 0) > 0) {
    add('Snacks and entertainment for kids during transit');
  }
  if ((groupComposition.elderly || 0) > 0 || (groupComposition.speciallyAbled || 0) > 0) {
    add('Regular medication + prescriptions, packed in carry-on/day bag');
  }

  // Trip-length driven
  if (dayCount >= 4) {
    add('Laundry bag or a few detergent sheets for a longer trip');
  }
  if (needsAccommodation) {
    add('Small padlock for luggage');
  }

  return items;
}