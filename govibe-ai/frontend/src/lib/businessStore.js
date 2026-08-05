// Lightweight local-storage backed store for the Business Dashboard MVP.
// The backend doesn't yet expose endpoints for offers/profile/listings/analytics,
// so these are persisted locally per browser. Swapping this for real API calls
// later only means editing the functions in this file.

const KEYS = {
  profile: 'govibe_business_profile',
  offers: 'govibe_business_offers',
  listings: 'govibe_business_listings',
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota / serialization errors — non-critical for this MVP
  }
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- Profile ----------

const DEFAULT_PROFILE = {
  businessName: 'Backwater Bites Café',
  ownerName: 'Anitha Raman',
  phone: '+91 98765 43210',
  email: 'business@example.com',
  address: 'Lake View Road, Ooty, Tamil Nadu',
  category: 'Food',
  description: 'A cosy lakeside café serving local Nilgiri specialties and fresh filter coffee.',
  openingHours: '8:00 AM – 9:00 PM',
  profileImage: '',
};

export function getProfile() {
  return read(KEYS.profile, DEFAULT_PROFILE);
}

export function saveProfile(profile) {
  write(KEYS.profile, profile);
  return profile;
}

// ---------- Offers ----------

const SEED_OFFERS = [
  {
    id: uid(),
    title: 'Weekend Brunch Special',
    description: '20% off on all brunch combos, every Saturday and Sunday.',
    discountType: 'percent',
    discountValue: '20',
    validFrom: '',
    validUntil: '',
    category: 'Food',
    image: '',
    createdAt: new Date().toISOString(),
  },
];

export function getOffers() {
  return read(KEYS.offers, SEED_OFFERS);
}

export function addOffer(offer) {
  const offers = getOffers();
  const next = [{ ...offer, id: uid(), createdAt: new Date().toISOString() }, ...offers];
  write(KEYS.offers, next);
  return next;
}

export function deleteOffer(id) {
  const next = getOffers().filter((o) => o.id !== id);
  write(KEYS.offers, next);
  return next;
}

// ---------- Listings ----------

const SEED_LISTINGS = [
  {
    id: uid(),
    name: 'Backwater Bites Café',
    category: 'Food',
    address: 'Lake View Road, Ooty, Tamil Nadu',
    image: '',
    status: 'Active',
  },
  {
    id: uid(),
    name: 'Bites Rooftop Terrace',
    category: 'Food',
    address: 'Charing Cross, Ooty, Tamil Nadu',
    image: '',
    status: 'Inactive',
  },
];

export function getListings() {
  return read(KEYS.listings, SEED_LISTINGS);
}

export function addListing(listing) {
  const next = [{ ...listing, id: uid(), status: listing.status || 'Active' }, ...getListings()];
  write(KEYS.listings, next);
  return next;
}

export function updateListing(id, updates) {
  const next = getListings().map((l) => (l.id === id ? { ...l, ...updates } : l));
  write(KEYS.listings, next);
  return next;
}

export function deleteListing(id) {
  const next = getListings().filter((l) => l.id !== id);
  write(KEYS.listings, next);
  return next;
}

export function toggleListingStatus(id) {
  const next = getListings().map((l) =>
    l.id === id ? { ...l, status: l.status === 'Active' ? 'Inactive' : 'Active' } : l
  );
  write(KEYS.listings, next);
  return next;
}

// ---------- Analytics ----------
// Derived from the same local data + light mock numbers, since there's no
// analytics pipeline on the backend yet.

export function getAnalytics() {
  const offers = getOffers();
  const listings = getListings();
  const activeListings = listings.filter((l) => l.status === 'Active').length;

  return {
    totalViews: 1284,
    totalBookings: 96,
    totalOffers: offers.length,
    activeListings,
    monthlyVisitors: [
      { month: 'Feb', visitors: 210 },
      { month: 'Mar', visitors: 260 },
      { month: 'Apr', visitors: 310 },
      { month: 'May', visitors: 355 },
      { month: 'Jun', visitors: 420 },
      { month: 'Jul', visitors: 480 },
    ],
    popularOffer: offers[0]?.title || 'No offers yet',
  };
}