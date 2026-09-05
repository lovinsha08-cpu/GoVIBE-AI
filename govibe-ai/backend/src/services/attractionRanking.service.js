/**
 * Attraction Ranking & Classification.
 *
 * Attraction importance is separate from hidden-gem status. Major landmarks
 * must win over minor places even when the minor place is slightly closer or
 * has a higher rating. Hidden gems are complementary recommendations, not a
 * substitute for destination highlights.
 */

import { RANKING_WEIGHTS } from '../config/scoringWeights.js';

const CAFE_SUBCATEGORY_KEYWORDS = ['cafe', 'café', 'coffee', 'bakery', 'tea house', 'tea stall'];
const HERITAGE_SIGNIFICANCE_KEYWORDS = ['unesco', 'world heritage', 'heritage site', 'archaeological', 'ancient', 'dynasty', 'centuries old', 'centuries-old', 'monument of national importance'];
const ICONIC_SUBCATEGORY_KEYWORDS = ['forts', 'monuments', 'temples', 'unesco', 'world heritage', 'heritage buildings', 'archaeological sites'];
const MAJOR_NAME_KEYWORDS = ['marina beach', 'gateway of india', 'india gate', 'red fort', 'taj mahal', 'qutub minar', 'victoria memorial', 'charminar', 'golden temple', 'meenakshi temple', 'kapaleeshwarar temple', 'fort st george', 'brihadeeswarar temple', 'shore temple', 'mysore palace', 'hawa mahal', 'kanchipuram temples', 'vivekananda rock memorial'];

function isSightseeingCategory(spot) { return !['food_dining', 'shopping', 'stay'].includes(spot.category); }

export function classifyPlaceType(spot) {
  if (spot.category === 'stay') return 'accommodation';
  if (spot.category === 'shopping') return 'shopping';
  if (spot.category === 'food_dining') {
    const sub = (spot.subcategory || '').toLowerCase();
    const name = (spot.name || '').toLowerCase();
    return CAFE_SUBCATEGORY_KEYWORDS.some((kw) => sub.includes(kw) || name.includes(kw)) ? 'cafe' : 'restaurant';
  }
  if (spot.category === 'transport') return 'transport';
  const tier = classifyAttractionTier(spot);
  if (tier === 'must_visit') return 'Must Visit Landmark';
  if (tier === 'hidden_gem') return 'Hidden Gem';
  if (tier === 'popular') return 'Popular Attraction';
  return 'Local / Standard Attraction';
}

/**
 * Destination importance is evaluated before interest matching. Rating alone
 * can never make a place a landmark. Explicit metadata, iconic identity,
 * review volume, heritage evidence and popularity are the signals used.
 */
export function classifyAttractionTier(spot) {
  if (!isSightseeingCategory(spot)) return null;
  const rating = Number(spot._google?.rating ?? spot.rating) || 0;
  const reviewCount = Number(spot._google?.userRatingCount ?? spot.review_count) || 0;
  const popularity = spot.familiarityScore != null ? Number(spot.familiarityScore) : (spot.popularity_score != null ? Number(spot.popularity_score) : null);
  const name = (spot.name || '').toLowerCase();
  const subcategory = (spot.subcategory || '').toLowerCase();
  const explicitMajor = spot.is_major_attraction === true || spot.attraction_tier === 'must_visit' || spot.tourism_significance === 'iconic';
  const explicitHidden = spot.hidden_gem === true || spot.attraction_tier === 'hidden_gem' || spot.tourism_significance === 'hidden_gem';
  const namedMajor = MAJOR_NAME_KEYWORDS.some((kw) => name.includes(kw));
  const heritageSignal = hasHeritageSignificance(spot);
  const iconicCategory = ICONIC_SUBCATEGORY_KEYWORDS.some((kw) => subcategory.includes(kw));

  if (explicitMajor || namedMajor) return 'must_visit';
  if (reviewCount >= 8000) return 'must_visit';
  if (heritageSignal && rating >= 4.3 && (reviewCount >= 250 || popularity == null || popularity >= 0.35)) return 'must_visit';
  if (iconicCategory && rating >= 4.5 && reviewCount >= 500) return 'must_visit';
  if (rating >= 4.4 && popularity != null && popularity >= 0.75 && reviewCount >= 500) return 'must_visit';
  if (explicitHidden) return 'hidden_gem';
  if (rating >= 4.0 && popularity != null && popularity <= 0.4 && reviewCount < 2500) return 'hidden_gem';
  if (rating >= 3.8 || (popularity != null && popularity >= 0.5)) return 'popular';
  return 'standard';
}

function hasHeritageSignificance(spot) {
  const haystack = `${spot.subcategory || ''} ${spot.description || ''}`.toLowerCase();
  if ((spot.category === 'heritage_historical' || spot.category === 'religious_spiritual') && ICONIC_SUBCATEGORY_KEYWORDS.some((kw) => (spot.subcategory || '').toLowerCase().includes(kw))) return true;
  return HERITAGE_SIGNIFICANCE_KEYWORDS.some((kw) => haystack.includes(kw));
}

export function annotateFamiliarityAndQuality(spots) {
  const reviewCounts = spots.map((s) => Number(s._google?.userRatingCount ?? s.review_count) || 0);
  const maxReviewCount = Math.max(1, ...reviewCounts);
  return spots.map((spot) => {
    const reviewCount = Number(spot._google?.userRatingCount ?? spot.review_count) || 0;
    const hasReviewData = spot._google?.userRatingCount != null || spot.review_count != null;
    const familiarityScore = hasReviewData ? Math.max(0, Math.min(1, Math.log(1 + reviewCount) / Math.log(1 + maxReviewCount))) : null;
    const rating = spot._google?.rating ?? spot.rating;
    const hasRating = rating != null;
    const qualityScore = hasRating ? Math.max(0, Math.min(1, Number(rating) / 5)) : 0.5;
    return { ...spot, familiarityScore, qualityScore, _enrichmentConfidence: hasReviewData && hasRating ? 'high' : (hasReviewData || hasRating ? 'medium' : 'low') };
  });
}

export function computeQualityScore(spot) {
  const rating = spot._google?.rating ?? spot.rating;
  return rating != null ? Math.max(0, Math.min(1, Number(rating) / 5)) : 0.5;
}

export function computeAttractionWeight(spot, { interestCategories = new Set(), interestSubcats = new Set() } = {}) {
  const rating = Number(spot._google?.rating ?? spot.rating) || 0;
  const popularity = spot.popularity_score != null ? Number(spot.popularity_score) : 0.5;
  const familiarityScore = spot.familiarityScore != null ? Number(spot.familiarityScore) : popularity;
  const qualityScore = spot.qualityScore != null ? Number(spot.qualityScore) : rating / 5;
  const heritageScore = hasHeritageSignificance(spot) ? 1 : (['heritage_historical', 'religious_spiritual'].includes(spot.category) ? 0.5 : 0);
  let interestScore = 0;
  if (interestCategories.has(spot.category)) interestScore += 0.7;
  if (spot.subcategory && interestSubcats.has(spot.subcategory)) interestScore += 0.3;
  interestScore = Math.min(1, interestScore);
  const tier = classifyAttractionTier(spot);
  const tierBonus = tier === 'must_visit' ? 8.0 : tier === 'popular' ? 1.5 : tier === 'hidden_gem' ? -0.75 : 0;
  const weighted = interestScore * RANKING_WEIGHTS.interestMatch + familiarityScore * RANKING_WEIGHTS.familiarity + qualityScore * RANKING_WEIGHTS.quality + heritageScore * RANKING_WEIGHTS.categoryDiversityContext;
  return Math.round((weighted + tierBonus) * 1000) / 1000;
}

export function rankAttractionsByImportance(spots, { interests = [], anchor, maxRadiusKm = 60 } = {}) {
  const interestCategories = new Set(interests.map((i) => i.category));
  const interestSubcats = new Set(interests.flatMap((i) => i.subcategories || []));
  const tierRank = { must_visit: 4, popular: 3, standard: 2, hidden_gem: 1 };
  return spots.map((spot) => {
    const weight = computeAttractionWeight(spot, { interestCategories, interestSubcats });
    let distanceBonus = 0;
    let outOfRange = false;
    if (anchor && Number.isFinite(spot.latitude) && Number.isFinite(spot.longitude)) {
      const dist = haversine(anchor.lat, anchor.lng, spot.latitude, spot.longitude);
      if (dist > maxRadiusKm) outOfRange = true;
      distanceBonus = Math.max(0, (maxRadiusKm - dist) / maxRadiusKm) * 0.05;
    }
    return { ...spot, _tier: classifyAttractionTier(spot), _weight: weight + distanceBonus, _outOfRange: outOfRange };
  }).filter((s) => !s._outOfRange).sort((a, b) => (tierRank[b._tier] - tierRank[a._tier]) || (b._weight - a._weight));
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}