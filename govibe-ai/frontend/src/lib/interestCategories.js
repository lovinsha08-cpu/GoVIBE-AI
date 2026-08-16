// GoVIBE AI – Master Categories & Subcategories.
// Slugs are the internal spot.category values used across the backend
// (see backend/src/services/spotMatching.service.js,
// attractionFilter.service.js, itineraryEngine.service.js, etc.) so
// picking a category here directly drives which spots get scored/selected.
// 'stay' is an internal-only category (accommodation) and isn't shown here.
export const INTEREST_CATEGORIES = [
  {
    slug: 'religious_spiritual',
    label: 'Religious & Spiritual',
    emoji: '🛕',
    subcategories: ['Temples', 'Churches', 'Mosques', 'Jain Temples', 'Gurudwaras', 'Ashrams'],
  },
  {
    slug: 'heritage_historical',
    label: 'Heritage & Historical',
    emoji: '🏛',
    subcategories: ['Forts', 'Memorials', 'Museums', 'Heritage Buildings', 'Monuments', 'Archaeological Sites'],
  },
  {
    slug: 'nature_scenic',
    label: 'Nature & Scenic',
    emoji: '🌿',
    subcategories: ['Beaches', 'Parks', 'Gardens', 'Lakes', 'Rivers & Backwaters', 'Eco Parks', 'Bird Sanctuaries', 'Mangroves'],
  },
  {
    slug: 'wildlife',
    label: 'Wildlife',
    emoji: '🐘',
    subcategories: ['Zoos', 'Aquariums', 'Snake Parks', 'Wildlife Parks'],
  },
  {
    slug: 'entertainment_recreation',
    label: 'Entertainment & Recreation',
    emoji: '🎢',
    subcategories: ['Amusement Parks', 'Water Parks', 'Theme Parks', 'Gaming Zones', 'Escape Rooms', 'Bowling Centres', 'Trampoline Parks'],
  },
  {
    slug: 'arts_culture',
    label: 'Arts & Culture',
    emoji: '🎨',
    subcategories: ['Art Galleries', 'Cultural Centres', 'Music & Dance Venues', 'Theatres', 'Exhibition Centres'],
  },
  {
    slug: 'science_learning',
    label: 'Science & Learning',
    emoji: '🔬',
    subcategories: ['Science Centres', 'Planetariums', 'Libraries', 'Educational Museums'],
  },
  {
    slug: 'shopping',
    label: 'Shopping',
    emoji: '🛍',
    subcategories: ['Shopping Malls', 'Street Markets', 'Flea Markets', 'Handicraft Stores', 'Textile & Silk Stores', 'Bookstores'],
  },
  {
    slug: 'food_dining',
    label: 'Food & Dining',
    emoji: '🍽',
    subcategories: ['Restaurants', 'Cafés', 'Street Food', 'Bakeries', 'Fine Dining', 'Rooftop Dining', 'Food Courts'],
  },
  {
    slug: 'photography_landmarks',
    label: 'Photography & Landmarks',
    emoji: '📸',
    subcategories: ['Lighthouses', 'Viewpoints', 'Sunrise Spots', 'Sunset Spots', 'Iconic Landmarks', 'Instagram Spots'],
  },
  {
    slug: 'sports_adventure',
    label: 'Sports & Adventure',
    emoji: '🏟',
    subcategories: ['Stadiums', 'Sports Complexes', 'Go-Karting', 'Adventure Parks', 'Indoor Sports'],
  },
  {
    slug: 'wellness_leisure',
    label: 'Wellness & Leisure',
    emoji: '🧘',
    subcategories: ['Spas', 'Yoga Centres', 'Meditation Centres', 'Wellness Retreats'],
  },
  {
    slug: 'nightlife',
    label: 'Nightlife',
    emoji: '🌃',
    subcategories: ['Pubs', 'Lounges', 'Bars', 'Night Cafés', 'Live Music Venues'],
  },
];