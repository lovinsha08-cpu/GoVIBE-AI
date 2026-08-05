// Mirrors backend/supabase/schema.sql interest_categories seed data.
// Slugs are kept backward-compatible with backend spot.category values
// (see backend/src/services/spotMatching.service.js) so existing scoring
// logic keeps working: 'heritage' = Culture & Heritage, 'nightlife' =
// Entertainment. 'photography' and 'hidden_gems' are cross-cutting picks
// matched by spot traits rather than a literal category (see
// spotMatching.service.js).
export const INTEREST_CATEGORIES = [
  {
    slug: 'nature',
    label: 'Nature & Outdoors',
    emoji: '🌿',
    subcategories: ['Beaches', 'Parks & Gardens', 'Lakes & Rivers', 'Waterfalls', 'Hills & Viewpoints', 'Wildlife Sanctuaries', 'Botanical Gardens'],
  },
  {
    slug: 'heritage',
    label: 'Culture & Heritage',
    emoji: '🏛',
    subcategories: ['Temples', 'Churches', 'Mosques', 'Forts & Palaces', 'Museums', 'Monuments', 'Art Galleries', 'Heritage Walks'],
  },
  {
    slug: 'adventure',
    label: 'Adventure',
    emoji: '🎢',
    subcategories: ['Trekking', 'Hiking', 'Camping', 'Cycling', 'Water Sports', 'Adventure Parks', 'Rock Climbing'],
  },
  {
    slug: 'food',
    label: 'Food & Dining',
    emoji: '🍽',
    subcategories: ['Street Food', 'Local Cuisine', 'Fine Dining', 'Cafés', 'Dessert Spots', 'Rooftop Restaurants'],
  },
  {
    slug: 'shopping',
    label: 'Shopping',
    emoji: '🛍',
    subcategories: ['Local Markets', 'Handicrafts', 'Souvenirs', 'Flea Markets', 'Shopping Malls'],
  },
  {
    slug: 'family',
    label: 'Family & Kids',
    emoji: '👨‍👩‍👧',
    subcategories: ['Zoos', 'Aquariums', 'Science Centers', "Children's Parks", 'Theme Parks'],
  },
  {
    slug: 'nightlife',
    label: 'Entertainment',
    emoji: '🌃',
    subcategories: ['Live Music', 'Cultural Shows', 'Movie Theatres', 'Gaming & VR', 'Nightlife'],
  },
  {
    slug: 'relaxation',
    label: 'Relaxation',
    emoji: '🧘',
    subcategories: ['Resorts', 'Spas', 'Beach Walks', 'Picnic Spots', 'Sunset Points'],
  },
  {
    slug: 'photography',
    label: 'Photography',
    emoji: '📸',
    subcategories: ['Scenic Viewpoints', 'Sunrise Spots', 'Sunset Spots', 'Architecture', 'Instagram-worthy Places'],
  },
  {
    slug: 'hidden_gems',
    label: 'Hidden Gems',
    emoji: '💎',
    subcategories: ['Offbeat Attractions', 'Secret Beaches', 'Lesser-known Temples', 'Local Markets', 'Hidden Cafés'],
  },
];