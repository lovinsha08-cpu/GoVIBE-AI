import { classifyAttractionTier } from './attractionRanking.service.js';

const TIER_ORDER = ['must_visit', 'popular', 'standard', 'hidden_gem'];

/**
 * Enforce the product hierarchy after candidate scoring:
 * Major/Must Visit -> Popular -> Local/Standard -> Hidden Gems.
 *
 * The selector never invents places. It only chooses from the supplied
 * candidate pool and uses the existing tier classifier as the source of
 * truth. Interests are used within a tier; they cannot demote a genuine
 * must-visit landmark below a lower-tier place.
 */
export function selectByAttractionHierarchy(candidates, {
  limit = 8,
  interests = [],
  scoreFn,
  includeHiddenGems = true,
} = {}) {
  if (!Array.isArray(candidates) || limit <= 0) return [];

  const requestedCategories = new Set(
    (interests || []).map((interest) => interest?.category).filter(Boolean),
  );

  const scored = candidates.map((spot, index) => {
    const tier = classifyAttractionTier(spot);
    const interestMatch = requestedCategories.has(spot.category) ? 1 : 0;
    const score = typeof scoreFn === 'function' ? Number(scoreFn(spot)) || 0 : 0;
    return { spot, tier, interestMatch, score, index };
  });

  const byTier = new Map(TIER_ORDER.map((tier) => [tier, []]));
  for (const item of scored) {
    if (!includeHiddenGems && item.tier === 'hidden_gem') continue;
    byTier.get(item.tier)?.push(item);
  }

  for (const items of byTier.values()) {
    items.sort((a, b) => (
      b.interestMatch - a.interestMatch
      || b.score - a.score
      || a.index - b.index
    ));
  }

  // Reserve major attractions first. For short itineraries, at least one
  // major is guaranteed whenever one exists. For longer itineraries, major
  // attractions receive roughly 40% of sightseeing slots before lower tiers
  // are allowed to fill the route.
  const major = byTier.get('must_visit') || [];
  const majorQuota = major.length
    ? Math.min(major.length, Math.max(1, Math.ceil(limit * 0.4)))
    : 0;

  const selected = [];
  const used = new Set();
  const add = (item) => {
    if (!item || selected.length >= limit || used.has(item.spot.id)) return false;
    selected.push(item.spot);
    used.add(item.spot.id);
    return true;
  };

  for (let i = 0; i < majorQuota; i += 1) add(major[i]);

  // Fill remaining slots in strict tier order. This makes hidden gems
  // supplementary rather than allowing them to replace famous attractions.
  for (const tier of ['must_visit', 'popular', 'standard', 'hidden_gem']) {
    for (const item of byTier.get(tier) || []) {
      if (selected.length >= limit) break;
      add(item);
    }
    if (selected.length >= limit) break;
  }

  return selected;
}
