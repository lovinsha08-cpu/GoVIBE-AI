/**
 * Generates backend/src/data/sampleSpots.json from the raw CSV datasets in
 * backend/datasets/. Run this whenever a dataset file in backend/datasets/
 * is added, replaced, or edited:
 *
 *   npm run generate:spots     (from backend/)
 *   node scripts/generateSpots.js
 *
 * This keeps the bundled Chennai spot data (used as the last-resort
 * fallback by spotData.service.js, and as the primary dataset until
 * Supabase/Google Places are configured) in sync with whatever CSVs are
 * dropped into backend/datasets/, instead of a hand-maintained JSON file.
 *
 * Categories/subcategories written here must match the taxonomy in
 * frontend/src/lib/interestCategories.js.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASETS_DIR = path.join(__dirname, '..', 'datasets');
const OUTPUT_PATH = path.join(__dirname, '..', 'src', 'data', 'sampleSpots.json');

// ---------------------------------------------------------------------------
// Minimal RFC4180-ish CSV parser (handles quoted fields, embedded commas,
// embedded newlines, and "" escaped quotes). No external dependency needed.
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function readCSVRecords(filename, { encoding = 'utf8' } = {}) {
  const filePath = path.join(DATASETS_DIR, filename);
  if (!fs.existsSync(filePath)) return [];
  let text = fs.readFileSync(filePath, encoding);
  if (!text || !text.trim()) return [];
  // Fix stray Windows-1252 curly-quote byte (0x92) that latin1 decoding
  // leaves as a raw control char instead of an apostrophe.
  text = text.replace(/\u0092/g, "'").replace(/\u0093|\u0094/g, '"');
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const rec = {};
    header.forEach((h, idx) => { rec[h] = (r[idx] ?? '').trim(); });
    return rec;
  });
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Locality -> approximate lat/lng centroid lookup for Chennai & surrounds.
// Used to geocode rows that carry an area/locality name but no coordinates.
// ---------------------------------------------------------------------------
const AREA_COORDS = {
  'chennai': [13.0827, 80.2707], 'anna salai': [13.0604, 80.2496],
  'mount road': [13.0604, 80.2496], 'anna nagar': [13.0850, 80.2101],
  'anna nagar west': [13.0900, 80.2000], 'anna nagar east': [13.0870, 80.2200],
  'besant nagar': [13.0002, 80.2668], 'adyar': [13.0067, 80.2570],
  'velachery': [12.9756, 80.2207], 't. nagar': [13.0418, 80.2341], 't nagar': [13.0418, 80.2341],
  'egmore': [13.0732, 80.2609], 'nungambakkam': [13.0569, 80.2425],
  'tambaram': [12.9249, 80.1000], 'chromepet': [12.9516, 80.1462],
  'royapettah': [13.0533, 80.2647], 'vadapalani': [13.0503, 80.2121],
  'mylapore': [13.0339, 80.2619], 'aminjikarai': [13.0708, 80.2226],
  'ambattur': [13.1143, 80.1548], 'koyambedu': [13.0694, 80.1948],
  'purasawalkam': [13.0850, 80.2500], 'triplicane': [13.0603, 80.2757],
  'sowcarpet': [13.0940, 80.2790], 'parrys': [13.0919, 80.2870],
  'george town': [13.0939, 80.2870], 'chintadripet': [13.0708, 80.2667],
  'park town': [13.0838, 80.2789], 'alwarpet': [13.0330, 80.2540],
  'guindy': [13.0067, 80.2206], 'injambakkam': [12.9236, 80.2450],
  'thiruvanmiyur': [12.9830, 80.2594], 'muttukadu': [12.8730, 80.2510],
  'muttukadu (ecr)': [12.8730, 80.2510], 'muthukadu (ecr)': [12.8730, 80.2510],
  'chepauk': [13.0577, 80.2822], 'semmancheri': [12.8320, 80.2270],
  'ramapuram': [13.0295, 80.1795], 'kelambakkam': [12.7930, 80.2180],
  'thandalam': [13.0060, 80.0180], 'kalavakkam': [12.8100, 80.1580],
  'arumbakkam': [13.0730, 80.2100], 'arumbakkam (radha regent)': [13.0730, 80.2100],
  'chetpet': [13.0700, 80.2420], 'medavakkam': [12.9200, 80.1880],
  'saidapet': [13.0212, 80.2230], 'taramani': [12.9910, 80.2450],
  'kottivakkam': [12.9530, 80.2570], 'spencer plaza': [13.0616, 80.2606],
  'gopalapuram': [13.0446, 80.2530], 'padi': [13.1080, 80.1930],
  'nandanam': [13.0290, 80.2340], 'ecr': [12.9000, 80.2450],
  'kodambakkam': [13.0500, 80.2240], 'avadi': [13.1147, 80.1027],
  'nerkundram': [13.0620, 80.1830], 'washermanpet': [13.1140, 80.2830],
  'choolai': [13.1010, 80.2650], 'marina beach': [13.0500, 80.2824],
  'nandambakkam': [12.9970, 80.1780], 'chembarambakkam': [13.0000, 80.0500],
  'teynampet': [13.0430, 80.2450], 'greams road': [13.0570, 80.2530],
  'kotturpuram': [13.0170, 80.2400], 'kilpauk': [13.0800, 80.2380],
  'royapuram': [13.1140, 80.2940], 'ra puram': [13.0330, 80.2600],
  'r.a. puram': [13.0330, 80.2600], 'perungudi': [12.9650, 80.2420],
  'sholinganallur': [12.9010, 80.2280], 'thoraipakkam': [12.9420, 80.2370],
  'thoraipakkam (omr)': [12.9420, 80.2370], 'mogappair': [13.0810, 80.1770],
  'omr': [12.9500, 80.2350], 'choolaimedu': [13.0680, 80.2270],
  'west mambalam': [13.0350, 80.2200], 'perambur': [13.1170, 80.2400],
  'villivakkam': [13.1050, 80.2130], 'nanganallur': [12.9800, 80.1900],
  'madipakkam': [12.9600, 80.1980], 'pallavaram': [12.9675, 80.1491],
  'porur': [13.0380, 80.1580], 'poonamallee': [13.0475, 80.1105],
  'sriperumbudur': [12.9675, 79.9430], 'vandalur': [12.8796, 80.0815],
  'guduvancheri': [12.8450, 80.0620], 'navalur': [12.8420, 80.2280],
  'siruseri': [12.8280, 80.2240], 'chengalpattu': [12.6920, 79.9770],
  'thiruvallur': [13.1430, 79.9090], 'pulicat': [13.4160, 80.3180],
  'vedanthangal': [12.5460, 79.8570], 'karikili': [12.5670, 79.9110],
  'fort st. george': [13.0800, 80.2870], 'nandanam ': [13.0290, 80.2340],
  'thousand lights': [13.0562, 80.2530], 'periamet': [13.0827, 80.2759],
  'shenoy nagar': [13.0810, 80.2330], 'ayanavaram': [13.1048, 80.2316],
  'akkarai': [12.9138, 80.2512], 'uthandi': [12.8647, 80.2492],
  'egattur': [12.8429, 80.2278], 'egattur (omr)': [12.8429, 80.2278],
  'neelankarai': [12.9370, 80.2540], 'illalur': [12.7996, 80.0086],
  'palanjur': [12.7460, 79.9950], 'iit madras': [12.9915, 80.2337],
  'kalipattur': [12.8475, 80.2260],
};

function jitter(seedStr, lat, lng, spread = 0.01) {
  const h = crypto.createHash('md5').update(seedStr).digest();
  const a = h.readUInt16BE(0) / 65535;
  const b = h.readUInt16BE(2) / 65535;
  return [lat + (a * 2 - 1) * spread, lng + (b * 2 - 1) * spread];
}

function geocodeArea(areaText, name = '') {
  if (!areaText) return null;
  const key = String(areaText).trim().toLowerCase();
  if (AREA_COORDS[key]) return jitter(name + key, AREA_COORDS[key][0], AREA_COORDS[key][1]);
  for (const part of key.split(/[/,]/)) {
    const p = part.trim();
    if (AREA_COORDS[p]) return jitter(name + key, AREA_COORDS[p][0], AREA_COORDS[p][1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
const spots = [];

function addSpot({
  name, category, subcategory, lat, lng, rating = null, description = null,
  entryFee = null, avgMinutes = 60, popularity = 0.5, source = 'chennai_dataset',
}) {
  if (!name || lat == null || lng == null) return;
  name = String(name).trim();
  if (!name || /^(nan|none)$/i.test(name)) return;
  lat = Number(lat); lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  if (!(lat >= 8 && lat <= 16 && lng >= 78 && lng <= 82)) return;
  spots.push({
    name, category, subcategory,
    latitude: Math.round(lat * 1e5) / 1e5,
    longitude: Math.round(lng * 1e5) / 1e5,
    city: 'Chennai',
    rating: (rating != null && Number.isFinite(Number(rating)) && Number(rating) > 0)
      ? Math.round(Number(rating) * 10) / 10 : null,
    popularity_score: popularity,
    avg_visit_minutes: avgMinutes,
    entry_fee_inr: entryFee,
    opening_hours: null,
    description,
    image_url: null,
    is_hidden_gem: false,
    source,
  });
}

// ===========================================================================
// 1. Religion.csv -> religious_spiritual
// ===========================================================================
const REL_SUBCAT = {
  'Hindu Temples': 'Temples', 'Ashrams': 'Ashrams', 'Gurudwaras': 'Gurudwaras',
  'Jain Temples': 'Jain Temples', 'Mosques': 'Mosques', 'Christian Churches': 'Churches',
};
for (const r of readCSVRecords('Religion.csv')) {
  const lat = num(r.latitude); const lng = num(r.longitude);
  if (lat == null || lng == null) continue;
  const sub = REL_SUBCAT[r.category] || 'Temples';
  addSpot({
    name: r.name, category: 'religious_spiritual', subcategory: sub, lat, lng,
    rating: num(r.rating), description: `${sub === 'Temples' ? 'Place of worship' : sub} in ${r.city || 'Chennai'}.`,
    entryFee: 0, avgMinutes: 45, popularity: (num(r.rating) || 0) >= 4.3 ? 0.6 : 0.4,
    source: 'Religion dataset',
  });
}

// Hand-curated well-known Chennai temples/shrines (most Hindu Temple rows in
// the source dataset lack coordinates), so Religious & Spiritual has strong
// iconic coverage.
const FAMOUS_TEMPLES = [
  ['Kapaleeshwarar Temple', 13.0337, 80.2695, 'Temples', 4.7, 'Ancient Dravidian-style Shiva temple with a towering gopuram, the spiritual heart of Mylapore.'],
  ['Parthasarathy Temple', 13.0554, 80.2758, 'Temples', 4.6, "One of Chennai's oldest temples, dedicated to Lord Krishna as Parthasarathy, in Triplicane."],
  ['Vadapalani Andavar Temple', 13.0503, 80.2121, 'Temples', 4.6, 'Popular Murugan temple known for its daily abhishekam and lively festival processions.'],
  ['Ashtalakshmi Temple', 12.9990, 80.2726, 'Temples', 4.6, 'Seaside temple in Besant Nagar dedicated to the eight forms of Goddess Lakshmi.'],
  ['Marundeeswarar Temple', 12.9833, 80.2593, 'Temples', 4.6, 'Historic Shiva temple in Thiruvanmiyur associated with healing and medicinal legend.'],
  ['Kalikambal Temple', 13.0913, 80.2847, 'Temples', 4.5, 'Centuries-old Kali temple in George Town, a key stop on the Parrys heritage trail.'],
  ['ISKCON Sri Sri Radha Krishnan Temple', 13.0138, 80.2565, 'Temples', 4.6, 'Modern Krishna-Balaram temple in Lattice Bridge Road known for its evening aarti.'],
  ['Thiruvottiyur Thyagarajaswamy Temple', 13.1616, 80.3040, 'Temples', 4.6, 'Grand Chola-era Shiva temple complex in Thiruvottiyur with an expansive temple tank.'],
  ['Santhome Basilica', 13.0338, 80.2775, 'Churches', 4.7, 'Neo-Gothic Catholic basilica built over the tomb of St. Thomas the Apostle.'],
  ["St. Andrew's Kirk", 13.0781, 80.2789, 'Churches', 4.5, 'Colonial-era Scottish church in Egmore, notable for its circular nave and blue-and-gold dome.'],
  ['Thousand Lights Mosque', 13.0562, 80.2530, 'Mosques', 4.5, "One of South India's largest mosques, on Anna Salai."],
  ['Wallajah Mosque (Big Mosque)', 13.0592, 80.2810, 'Mosques', 4.5, 'Historic 18th-century mosque near Chepauk, notable for its distinctive gold-tipped minarets.'],
];
for (const [nm, la, lo, sub, rt, desc] of FAMOUS_TEMPLES) {
  addSpot({ name: nm, category: 'religious_spiritual', subcategory: sub, lat: la, lng: lo, rating: rt, description: desc, entryFee: 0, avgMinutes: 45, popularity: 0.85, source: 'Religion dataset (curated)' });
}

// ===========================================================================
// 2. CulturalHeritage.csv -> heritage_historical (Fort St George complex)
// ===========================================================================
const FORT_LAT = 13.0800; const FORT_LNG = 80.2870;
for (const r of readCSVRecords('CulturalHeritage.csv', { encoding: 'latin1' })) {
  const name = (r['Name of heritage'] || '').trim();
  if (!name) continue;
  const nature = (r['Nature of heritage (open space, monuments, street etc.)'] || '').trim();
  const age = (r['Age of heritage (in Years)'] || '').trim();
  let lat; let lng; let sub;
  if (/megalithic/i.test(name)) {
    [lat, lng] = geocodeArea('nandambakkam', name);
    sub = 'Archaeological Sites';
  } else {
    [lat, lng] = jitter(name, FORT_LAT, FORT_LNG, 0.003);
    sub = /house|mess|block/i.test(name) ? 'Heritage Buildings' : 'Monuments';
  }
  addSpot({
    name, category: 'heritage_historical', subcategory: sub, lat, lng, rating: 4.3,
    description: `${nature} within the Fort St. George heritage precinct, dating to the ${age}.`,
    entryFee: 30, avgMinutes: 30, popularity: 0.55, source: 'CulturalHeritage dataset',
  });
}
addSpot({
  name: 'Fort St. George', category: 'heritage_historical', subcategory: 'Forts', lat: FORT_LAT, lng: FORT_LNG,
  rating: 4.5, description: '17th-century British fort on the Chennai coastline, first English settlement in India, now housing a museum and the Tamil Nadu Legislative Assembly.',
  entryFee: 30, avgMinutes: 90, popularity: 0.85, source: 'CulturalHeritage dataset',
});

// ===========================================================================
// 3. Chennai_Museums.csv -> heritage_historical / arts_culture / science_learning
// ===========================================================================
const MUSEUM_LOCATIONS = {
  'Chennai Rail Museum': ['villivakkam', 'science_learning', 'Educational Museums'],
  'Government Museum': ['egmore', 'heritage_historical', 'Museums'],
  'Fort Museum': ['fort st. george', 'heritage_historical', 'Museums'],
  'B M Birla Planetarium': ['kotturpuram', 'science_learning', 'Planetariums'],
  'Click Art Museum': ['t. nagar', 'arts_culture', 'Art Galleries'],
  'National Art Gallery': ['egmore', 'arts_culture', 'Art Galleries'],
  'Vivekananda House - Multimedia Cultural Museum': ['triplicane', 'heritage_historical', 'Museums'],
  "The Gem'z": ['nungambakkam', 'arts_culture', 'Art Galleries'],
  'The Faraway Tree Gallery': ['adyar', 'arts_culture', 'Art Galleries'],
  'Live Art Museum': ['adyar', 'arts_culture', 'Art Galleries'],
  'Dr MGR Memorial House': ['t. nagar', 'heritage_historical', 'Museums'],
  'Thol Isai Kalanjiyam': ['mylapore', 'arts_culture', 'Cultural Centres'],
  "Dr. Arun's Photography And Vintage Camera Museum": ['mylapore', 'arts_culture', 'Art Galleries'],
  'Subramanya Bharathi Museum': ['triplicane', 'heritage_historical', 'Museums'],
  'M.Rm.Rm. Cultural Foundation': ['kotturpuram', 'arts_culture', 'Cultural Centres'],
  'Art Houz': ['nungambakkam', 'arts_culture', 'Art Galleries'],
  'Focus Art Gallery': ['nungambakkam', 'arts_culture', 'Art Galleries'],
  'Gurubaran Tanjore Art Gallery': ['mylapore', 'arts_culture', 'Art Galleries'],
  'DakshinaChitra': ['muttukadu (ecr)', 'heritage_historical', 'Heritage Buildings'],
  'Ayya Art Gallery': ['alwarpet', 'arts_culture', 'Art Galleries'],
  'Art World Gallery': ['nungambakkam', 'arts_culture', 'Art Galleries'],
  'LIOA Art Gallery': ['egmore', 'arts_culture', 'Art Galleries'],
  'Tamilnadu Science and Technology Centres': ['kotturpuram', 'science_learning', 'Science Centres'],
  'Ethnic Tanjore Arts': ['mylapore', 'arts_culture', 'Art Galleries'],
  'Vinyasa Art Gallery': ['alwarpet', 'arts_culture', 'Art Galleries'],
  'Achalam Art Gallery': ['adyar', 'arts_culture', 'Art Galleries'],
  'Children Museum': ['egmore', 'science_learning', 'Educational Museums'],
  'RuKmini Devi Museum': ['adyar', 'heritage_historical', 'Museums'],
  'Ambur House Art Gallery': ['nungambakkam', 'arts_culture', 'Art Galleries'],
};
for (const r of readCSVRecords('Chennai_Museums.csv')) {
  const name = (r['Museum/Attraction'] || '').trim();
  const info = MUSEUM_LOCATIONS[name];
  if (!name || !info) continue;
  const [area, cat, sub] = info;
  const coords = geocodeArea(area, name);
  if (!coords) continue;
  addSpot({
    name, category: cat, subcategory: sub, lat: coords[0], lng: coords[1], rating: 4.1,
    description: `${sub.endsWith('s') ? sub.slice(0, -1) : sub} in ${area.replace(/\b\w/g, (c) => c.toUpperCase())}, Chennai.`,
    entryFee: 50, avgMinutes: 75, popularity: 0.5, source: 'Chennai Museums dataset',
  });
}

// ===========================================================================
// 4. science.csv -> science_learning
//    (currently empty; loop is a no-op until this dataset is populated)
// ===========================================================================
function sciSubcat(cat) {
  const c = (cat || '').toLowerCase();
  if (c.includes('library')) return 'Libraries';
  if (c.includes('planetarium')) return 'Planetariums';
  if (c.includes('science') || c.includes('observatory')) return 'Science Centres';
  return 'Educational Museums';
}
for (const r of readCSVRecords('science.csv')) {
  const coords = geocodeArea(r.area, r.name);
  if (!coords) continue;
  const sub = sciSubcat(r.category);
  addSpot({
    name: r.name, category: 'science_learning', subcategory: sub, lat: coords[0], lng: coords[1], rating: 3.9,
    description: `${r.category} located in ${r.area}, Chennai.`,
    entryFee: sub === 'Libraries' ? 0 : 20, avgMinutes: sub === 'Libraries' ? 60 : 75,
    popularity: 0.45, source: 'Science dataset',
  });
}

// ===========================================================================
// 5. Shopping.csv -> shopping
// ===========================================================================
const SHOP_SUBCAT = {
  'Book Stores': 'Bookstores', 'Handicraft Stores': 'Handicraft Stores',
  'Textiles & Silk Stores': 'Textile & Silk Stores', 'Street Markets': 'Street Markets',
  'Shopping Malls': 'Shopping Malls', 'Flea Markets': 'Flea Markets',
};
const VERIFIED_PRIORITY = {
  'Known institution/brand - verify current outlet': 0, 'Current business listing': 0,
  'Needs individual verification': 1, 'Directory candidate - verify current branch/details': 2,
};
const ZONE_FALLBACK = {
  'central chennai': 'chennai', 'north chennai': 'george town', 'south chennai': 'adyar',
  'west chennai': 'anna nagar', 'central/south chennai': 't. nagar', 'north/central chennai': 'parrys',
};
{
  const shopRows = readCSVRecords('Shopping.csv').map((r) => ({
    ...r,
    _prio: VERIFIED_PRIORITY[r.Verification_Status] ?? 2,
    _name: r.Store_Name || r.Market_Name || r.Mall_Name,
  })).filter((r) => r._name).sort((a, b) => a._prio - b._prio);

  const CAP_PER_SUBCAT = 30;
  const perSubcatCount = {};
  const seenNames = new Set();
  for (const r of shopRows) {
    const subcat = SHOP_SUBCAT[r.Subcategory] || r.Subcategory;
    const n = perSubcatCount[subcat] || 0;
    if (n >= CAP_PER_SUBCAT) continue;
    const name = r._name.trim();
    if (seenNames.has(name)) continue;
    let coords = null;
    const locality = r.Locality || r.Chennai_Zone;
    if (locality) coords = geocodeArea(locality, name);
    if (!coords && r.Chennai_Zone) coords = geocodeArea(ZONE_FALLBACK[r.Chennai_Zone.toLowerCase()], name);
    if (!coords) continue;
    const descBits = [r.Main_Products, r.Shopping_Categories, r.Store_Type, r.Type].filter(Boolean);
    addSpot({
      name, category: 'shopping', subcategory: subcat, lat: coords[0], lng: coords[1],
      rating: num(r.Rating), description: descBits[0] || `${subcat} in Chennai.`,
      entryFee: 0, avgMinutes: 60, popularity: 0.5, source: 'Shopping dataset',
    });
    perSubcatCount[subcat] = n + 1;
    seenNames.add(name);
  }
}

// ===========================================================================
// 6. sports.csv -> sports_adventure
// ===========================================================================
const SPORTS_SUBCAT = {
  'Stadium': 'Stadiums', 'Sports Complex': 'Sports Complexes', 'Go-Karting': 'Go-Karting',
  'Adventure Park': 'Adventure Parks', 'Indoor Sports': 'Indoor Sports',
};
{
  const seen = new Set();
  for (const r of readCSVRecords('sports.csv')) {
    const lat = num(r.Latitude); const lng = num(r.Longitude);
    if (lat == null || lng == null) continue;
    const name = (r['Place Name'] || '').trim();
    const key = `${name}|${r.Category}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    addSpot({
      name, category: 'sports_adventure', subcategory: SPORTS_SUBCAT[r.Category] || r.Category,
      lat, lng, rating: 4.0, description: `${r.Category} in ${r.Area || 'Chennai'}.`,
      entryFee: 200, avgMinutes: 90, popularity: 0.5, source: 'Sports dataset',
    });
  }
}

// ===========================================================================
// 7. photograhy.csv -> photography_landmarks
// ===========================================================================
const PHOTO_SUBCAT = {
  'Sunrise Spot': 'Sunrise Spots', 'Iconic Landmark': 'Iconic Landmarks',
  'Instagram Spot': 'Instagram Spots', 'Sunset Spot': 'Sunset Spots',
  'Viewpoint': 'Viewpoints', 'Lighthouse': 'Lighthouses',
};
for (const r of readCSVRecords('photograhy.csv')) {
  const lat = num(r.Latitude); const lng = num(r.Longitude);
  if (lat == null || lng == null) continue;
  addSpot({
    name: r['Spot Name'], category: 'photography_landmarks', subcategory: PHOTO_SUBCAT[r.Category] || r.Category,
    lat, lng, rating: 4.2, description: `${r.Category} in ${r.Area || 'Chennai'}, popular for photography.`,
    entryFee: 0, avgMinutes: 40, popularity: 0.6, source: 'Photography dataset',
  });
}

// ===========================================================================
// 8. entertainment.csv -> entertainment_recreation
//    Messy multi-schema file: every block starts with Name, Location/Area,
//    Type, ..., and ends with a Google Rating, regardless of column count,
//    so parse leniently on that shared shape rather than by fixed header.
// ===========================================================================
function entertainmentSubcat(name, type) {
  const n = name.toLowerCase(); const t = (type || '').toLowerCase();
  if (n.includes('trampoline') || n.includes('skyjumper') || n.includes('airborne') || n.includes('dugout')) return 'Trampoline Parks';
  if (t.includes('escape')) return 'Escape Rooms';
  if (t.includes('gaming') || t.includes('bowling')) return 'Gaming Zones';
  if (t.includes('water')) return 'Water Parks';
  if (t.includes('snow') || t.includes('theme')) return 'Theme Parks';
  if (t.includes('amusement')) return 'Amusement Parks';
  return 'Theme Parks';
}
{
  const filePath = path.join(DATASETS_DIR, 'entertainment.csv');
  const seen = new Set();
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    const lines = raw.split('\n').slice(1); // drop header row
    for (const line of lines) {
      if (!line.trim()) continue;
      const fields = parseCSV(line)[0];
      if (!fields || fields.length < 4) continue;
      const [name, location, type, ...rest] = fields;
      if (!name || !name.trim() || name.trim().toLowerCase() === 'park name') continue;
      const ratingRaw = rest[rest.length - 1];
      const rating = num(ratingRaw);
      const key = name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const coords = geocodeArea(location, name) || geocodeArea('chennai', name);
      if (!coords) continue;
      addSpot({
        name: name.trim(), category: 'entertainment_recreation',
        subcategory: entertainmentSubcat(name, type), lat: coords[0], lng: coords[1],
        rating: (rating != null && rating <= 5) ? rating : null,
        description: `${type || 'Entertainment venue'} in ${location || 'Chennai'}.`,
        entryFee: 500, avgMinutes: 180, popularity: 0.55, source: 'Entertainment dataset',
      });
    }
  }
}

// ===========================================================================
// 9. chennai_wildlife.csv -> wildlife
// ===========================================================================
const WILD_SUBCAT = { 'Zoo': 'Zoos', 'Snake Park': 'Snake Parks', 'Wildlife Park': 'Wildlife Parks', 'Aquarium': 'Aquariums', 'Bird Park': 'Wildlife Parks' };
for (const r of readCSVRecords('chennai_wildlife.csv')) {
  const lat = num(r.Latitude); const lng = num(r.Longitude);
  if (lat == null || lng == null) continue;
  addSpot({
    name: r.Name, category: 'wildlife', subcategory: WILD_SUBCAT[r.Category] || 'Wildlife Parks',
    lat, lng, rating: 4.2,
    description: `${r.Subcategory} in ${r.Location || 'Chennai'}, managed by ${r.Managed_By || 'local authorities'}. ${r.Remarks || ''}`.trim(),
    entryFee: 50, avgMinutes: 150, popularity: 0.6, source: 'Wildlife dataset',
  });
}

// ===========================================================================
// 10. nature.csv -> nature_scenic (filtered to Chennai metro-region districts)
// ===========================================================================
const CHENNAI_DISTRICTS = new Set(['chennai', 'chengalpattu', 'thiruvallur', 'kancheepuram', 'kanchipuram']);
const NATURE_SUBCAT = {
  'Bird Sanctuary': 'Bird Sanctuaries', 'Lake': 'Lakes', 'Wetland': 'Rivers & Backwaters',
  'Eco Park': 'Eco Parks', 'Mangrove': 'Mangroves', 'Park': 'Parks', 'Garden': 'Gardens',
};
const KNOWN_NATURE_COORDS = {
  'vedanthangal birds sanctuary': [12.5460, 79.8570], 'karikili birds sanctuary': [12.5670, 79.9110],
  'pulicat lake bird sanctuary': [13.4160, 80.3180], 'pallikaranai marsh': [12.9280, 80.2050],
  'guindy national park': [13.0067, 80.2350], 'semmozhi poonga': [13.0567, 80.2540],
  'adyar poonga': [13.0060, 80.2570], 'elliots beach': [13.0002, 80.2668],
  'marina beach': [13.0500, 80.2824], 'thiruvanmiyur beach': [12.9830, 80.2650],
  'covelong beach': [12.7930, 80.2510], 'ecr beach': [12.6000, 80.2000],
};
{
  let added = 0;
  for (const r of readCSVRecords('nature.csv')) {
    const district = (r.District || '').trim().toLowerCase();
    if (!CHENNAI_DISTRICTS.has(district)) continue;
    const name = (r.Name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    let coords = null;
    for (const [kn, kc] of Object.entries(KNOWN_NATURE_COORDS)) {
      if (key.includes(kn) || kn.includes(key)) { coords = kc; break; }
    }
    if (!coords) coords = geocodeArea(district, name);
    if (!coords) continue;
    const sub = NATURE_SUBCAT[r.Category] || 'Lakes';
    addSpot({
      name, category: 'nature_scenic', subcategory: sub, lat: coords[0], lng: coords[1], rating: 4.0,
      description: `${r.Category} in ${r.District || 'Chennai region'}` + (r.Area_ha ? `, covering ${r.Area_ha} hectares.` : '.'),
      entryFee: 20, avgMinutes: 90, popularity: 0.4, source: 'Nature dataset',
    });
    added += 1;
    if (added >= 60) break;
  }
}
const FAMOUS_NATURE = [
  ['Marina Beach', 13.0500, 80.2824, 'Beaches', 4.5, "One of the world's longest urban beaches, stretching along Chennai's coastline."],
  ["Elliot's Beach (Besant Nagar)", 13.0002, 80.2668, 'Beaches', 4.5, 'Quieter, cleaner beach in Besant Nagar popular for evening walks.'],
  ['Semmozhi Poonga', 13.0567, 80.2540, 'Gardens', 4.4, 'Landscaped botanical garden next to the Chennai Trade Centre on Cathedral Road.'],
  ['Guindy National Park', 13.0067, 80.2350, 'Parks', 4.3, "One of the world's smallest national parks, located within a metropolitan city."],
  ['Adyar Poonga', 13.0060, 80.2570, 'Eco Parks', 4.2, 'Restored eco-park along the Adyar estuary with boardwalks through mangrove wetlands.'],
  ['Pallikaranai Marsh', 12.9280, 80.2050, 'Mangroves', 4.0, "A Ramsar-recognised wetland, one of the city's last major marshlands and bird habitats."],
];
for (const [nm, la, lo, sub, rt, desc] of FAMOUS_NATURE) {
  addSpot({ name: nm, category: 'nature_scenic', subcategory: sub, lat: la, lng: lo, rating: rt, description: desc, entryFee: 0, avgMinutes: 90, popularity: 0.75, source: 'Nature dataset (curated)' });
}

// ===========================================================================
// 11. Chennai_pubs.csv -> nightlife
// ===========================================================================
function pubSubcat(cat) {
  const c = (cat || '').toLowerCase();
  if (c.includes('lounge')) return 'Lounges';
  if (c.includes('live music')) return 'Live Music Venues';
  if (c.includes('bar') || c.includes('pub')) return 'Pubs';
  return 'Bars';
}
for (const r of readCSVRecords('Chennai_pubs.csv')) {
  const coords = geocodeArea(r.Area, r.Name);
  if (!coords) continue;
  addSpot({
    name: r.Name, category: 'nightlife', subcategory: pubSubcat(r.Category), lat: coords[0], lng: coords[1],
    rating: num(r.Rating),
    description: r['Popular For / Features'] || `${r.Category || 'Pub'} in ${r.Area}.`,
    entryFee: num(r['Approx Cost for Two (₹)']),
    avgMinutes: 120, popularity: 0.5, source: 'Chennai Pubs dataset',
  });
}

// ===========================================================================
// 12. arts and culture.csv -> arts_culture
// ===========================================================================
const THEATRE_KW = ['theatre', 'cinema', 'multiplex'];
const EXHIBITION_KW = ['exhibition', 'trade', 'convention', 'fair'];
const CULTURAL_CENTRE_KW = ['cultural centre', 'cultural institution', 'cultural academy', 'cultural organisation', 'cultural and educational', 'heritage cultural', 'heritage & cultural', 'international cultural', "artists' community", 'cultural memorial', 'cultural/public garden', 'classical arts & cultural', 'sabha'];
const MUSIC_DANCE_KW = ['music & dance', 'dance', 'performing arts', 'fine arts and performing', 'fine arts / performing'];
function artsSubcat(cat) {
  const c = (cat || '').toLowerCase();
  if (THEATRE_KW.some((k) => c.includes(k))) return 'Theatres';
  if (EXHIBITION_KW.some((k) => c.includes(k))) return 'Exhibition Centres';
  if (MUSIC_DANCE_KW.some((k) => c.includes(k))) return 'Music & Dance Venues';
  if (CULTURAL_CENTRE_KW.some((k) => c.includes(k))) return 'Cultural Centres';
  return 'Art Galleries';
}
for (const r of readCSVRecords('arts and culture.csv')) {
  const name = r.Name || r.Theatre_Name || r.Gallery_Name || r['Venue / Organisation'] || r['Cultural Centre / Institution'];
  if (!name) continue;
  const area = r.Area || r.Location || r.Zone || r['City / Metro Area'];
  const coords = geocodeArea(area, name);
  if (!coords) continue;
  const cat = r.Category || r.Type || r['Venue Type'] || 'Art Gallery';
  const sub = artsSubcat(cat);
  addSpot({
    name: name.trim(), category: 'arts_culture', subcategory: sub, lat: coords[0], lng: coords[1],
    rating: num(r.Rating), description: `${cat} in ${area || 'Chennai'}.`,
    entryFee: (sub === 'Cultural Centres' || sub === 'Exhibition Centres') ? 0 : 100,
    avgMinutes: 90, popularity: 0.45, source: 'Arts & Culture dataset',
  });
}

// ===========================================================================
// 13. Accommodation (no dedicated dataset supplied — small curated set so
//     the trip engine's accommodation logic has genuine Chennai candidates)
// ===========================================================================
const CHENNAI_STAYS = [
  ['The Leela Palace Chennai', 12.9954, 80.2620, 4.7, 5000, 'Luxury beachfront palace hotel on Adyar Seaface Road.'],
  ['ITC Grand Chola', 13.0106, 80.2223, 4.7, 4500, 'Chola-dynasty-inspired luxury hotel near Guindy.'],
  ['Taj Coromandel', 13.0569, 80.2489, 4.6, 4000, 'Long-standing 5-star hotel in Nungambakkam.'],
  ['Hyatt Regency Chennai', 13.0708, 80.2226, 4.5, 3500, 'Business hotel near Anna Nagar / the airport corridor.'],
  ['GRT Grand Days', 13.0418, 80.2341, 4.2, 2000, 'Mid-range hotel in the heart of T. Nagar shopping district.'],
  ['Zostel Chennai', 12.9830, 80.2594, 4.1, 700, 'Budget backpacker hostel near Thiruvanmiyur beach.'],
];
for (const [nm, la, lo, rt, fee, desc] of CHENNAI_STAYS) {
  addSpot({ name: nm, category: 'stay', subcategory: 'Hotels', lat: la, lng: lo, rating: rt, description: desc, entryFee: fee, avgMinutes: 0, popularity: 0.6, source: 'Accommodation (curated)' });
}

// ===========================================================================
// Dedup and write output.
// ===========================================================================
const seenKeys = new Set();
const final = [];
for (const s of spots) {
  const key = `${s.name.toLowerCase()}|${s.category}`;
  if (seenKeys.has(key)) continue;
  seenKeys.add(key);
  final.push(s);
}

const counts = {};
for (const s of final) counts[s.category] = (counts[s.category] || 0) + 1;

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(final, null, 2), 'utf8');

console.log(`Wrote ${final.length} spots to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
console.table(counts);