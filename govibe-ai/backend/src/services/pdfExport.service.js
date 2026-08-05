import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { env } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';
import { getLiveEmergencyServices } from './emergency.service.js';

/**
 * Renders a complete, branded "Download Itinerary" PDF for a trip.
 * Pure server-side generation (pdfkit) so formatting is identical
 * regardless of the traveler's device/browser — the whole point of a
 * downloadable document.
 *
 * Every optional enrichment (route map image, QR code, emergency
 * contacts) degrades gracefully: if a piece of data or an external image
 * fetch isn't available, that section is skipped with a short note
 * instead of throwing, so a missing API key or a slow network call never
 * blocks the actual download.
 */

// Matches the app's own design system (see ItineraryResults.jsx) so the
// PDF feels like part of the same product rather than a generic export.
const COLORS = {
  navy: '#1A1B3A',
  coral: '#FF6B5B',
  gold: '#FFB84D',
  teal: '#2DD4BF',
  cream: '#FFF8F0',
  muted: '#6B6C87',
};

const PAGE_MARGIN = 42;
const STATIC_MAP_URL = 'https://maps.googleapis.com/maps/api/staticmap';

export async function buildItineraryPdfBuffer({ trip, itinerary }) {
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const stops = itinerary?.stops || [];
  const budget = itinerary?.budget_summary || {};
  const extras = budget.ai_extras || {};

  // 1. Cover
  drawCoverSection(doc, trip, itinerary);
  doc.addPage();

  // 2. Trip Summary
  drawTripSummary(doc, trip, stops, itinerary);
  drawAccommodationSection(doc, extras.accommodation, stops);

  // 3. Day-wise Itinerary
  drawDailyTimeline(doc, stops);

  // 4. Maps
  await drawMapSection(doc, stops);

  // 5. Emergency Services
  await drawEmergencyServicesSection(doc, trip, extras.emergency_contacts);

  // 6. Offers & Deals
  await drawOffersSection(doc, trip);

  // 7. Final Budget Summary
  drawBudgetBreakdown(doc, budget);

  drawTravelTips(doc, extras.travel_tips);
  await drawQrCodeSection(doc, trip);
  drawFooterPageNumbers(doc);

  doc.end();
  return done;
}

// ---------- section renderers ----------

function drawCoverSection(doc, trip, itinerary) {
  // Logo mark: a small rotated "compass" chip echoing the app's navbar icon,
  // built from vector shapes rather than a raster asset so it stays crisp
  // at any print resolution.
  doc.save();
  doc.roundedRect(PAGE_MARGIN, PAGE_MARGIN, 34, 34, 8).fill(COLORS.navy);
  doc.fillColor(COLORS.gold).fontSize(16).font('Helvetica-Bold')
    .text('G', PAGE_MARGIN, PAGE_MARGIN + 8, { width: 34, align: 'center' });
  doc.restore();

  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(18)
    .text('GoVIBE AI', PAGE_MARGIN + 44, PAGE_MARGIN + 3);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
    .text('Your personalized travel itinerary', PAGE_MARGIN + 44, PAGE_MARGIN + 24);

  const generatedOn = new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
  const generatedLine = trip?.traveler_name
    ? `Prepared for ${trip.traveler_name}  ·  ${generatedOn}`
    : `Generated on ${generatedOn}`;
  doc.fillColor(COLORS.muted).fontSize(9)
    .text(generatedLine, PAGE_MARGIN, PAGE_MARGIN + 44, { width: 520, align: 'right' });

  doc.moveTo(PAGE_MARGIN, PAGE_MARGIN + 62).lineTo(552, PAGE_MARGIN + 62)
    .lineWidth(1.5).strokeColor(COLORS.coral).stroke();

  // ---- Cover content: trip title, destination, dates, travelers, budget ----
  const tripTitle = trip?.destination ? `Trip to ${trip.destination}` : 'Your Trip';
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(28)
    .text(tripTitle, PAGE_MARGIN, PAGE_MARGIN + 130, { width: 510, align: 'center' });

  doc.fillColor(COLORS.coral).font('Helvetica-Bold').fontSize(13)
    .text(trip?.destination || '—', PAGE_MARGIN, doc.y + 6, { width: 510, align: 'center' });

  const groupSize = (trip?.adults || 0) + (trip?.kids || 0) + (trip?.elderly || 0) + (trip?.specially_abled || 0);
  const coverRows = [
    ['Travel date', formatDuration(trip?.start_date, trip?.end_date)],
    ['Number of travelers', groupSize ? `${groupSize} traveler(s)` : '—'],
    ['Budget', trip?.total_budget_inr ? `₹${Number(trip.total_budget_inr).toLocaleString('en-IN')}` : '—'],
    ['Generated on', generatedOn],
  ];

  let y = doc.y + 50;
  const boxWidth = 230;
  const gap = 50;
  const startX = PAGE_MARGIN + (510 - (boxWidth * 2 + gap)) / 2;
  coverRows.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = startX + col * (boxWidth + gap);
    const rowY = y + row * 64;
    doc.roundedRect(x, rowY, boxWidth, 48, 8).fill(COLORS.cream);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8).text(label.toUpperCase(), x + 14, rowY + 10, { width: boxWidth - 28 });
    doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(12).text(value, x + 14, rowY + 24, { width: boxWidth - 28 });
  });

  doc.y = y + Math.ceil(coverRows.length / 2) * 64 + 30;
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
    .text(`${(itinerary?.stops || []).length} stops planned across your trip`, PAGE_MARGIN, doc.y, { width: 510, align: 'center' });
}

function sectionTitle(doc, text) {
  doc.moveDown(0.6);
  doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(13).text(text);
  doc.moveTo(doc.x, doc.y + 2).lineTo(552, doc.y + 2).lineWidth(0.75).strokeColor('#E5E5EA').stroke();
  doc.moveDown(0.5);
}

function drawTripSummary(doc, trip, stops, itinerary) {
  sectionTitle(doc, 'Trip Summary');

  const groupSize = (trip?.adults || 0) + (trip?.kids || 0) + (trip?.elderly || 0) + (trip?.specially_abled || 0);
  const interests = (trip?.interests || []).map((i) => i.category || i).join(', ') || 'General sightseeing';
  const foodPreference = (trip?.food_preferences || []).join(', ') || 'No preference';
  const totalDistanceKm = itinerary?.total_distance_km;
  const totalDurationMinutes = itinerary?.total_duration_minutes;
  const estimatedCostInr = itinerary?.budget_summary?.total_estimated_cost_inr
    ?? itinerary?.budget_summary?.budget_validation?.total_estimated_cost_inr;

  const rows = [
    ['Start location', trip?.start_location || '—'],
    ['Destination', trip?.destination || '—'],
    ['Duration', formatDuration(trip?.start_date, trip?.end_date)],
    ['Travelers', groupSize ? `${groupSize} traveler(s)` : '—'],
    ['Budget', trip?.total_budget_inr ? `₹${Number(trip.total_budget_inr).toLocaleString('en-IN')}` : '—'],
    ['Estimated budget', estimatedCostInr != null ? `₹${Number(estimatedCostInr).toLocaleString('en-IN')}` : '—'],
    ['Total distance', totalDistanceKm != null ? `${totalDistanceKm} km` : '—'],
    ['Estimated travel time', formatMinutes(totalDurationMinutes)],
    ['Transport mode', (trip?.transport_modes || []).join(', ') || trip?.transport_priority || 'No preference'],
    ['Food preference', foodPreference],
    ['Interests', interests],
    ['Total stops', String(stops.length)],
  ];

  drawKeyValueGrid(doc, rows);
  doc.moveDown(0.4);
}

function drawKeyValueGrid(doc, rows) {
  const colWidth = 255;
  const startX = doc.x;
  let startY = doc.y;
  rows.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = startX + col * colWidth;
    const y = startY + row * 30;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8).text(label.toUpperCase(), x, y);
    doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(10).text(String(value), x, y + 11, { width: colWidth - 10 });
  });
  doc.y = startY + Math.ceil(rows.length / 2) * 30 + 4;
}

function drawAccommodationSection(doc, accommodation, stops) {
  // Prefer the rich recommendation object (name/address/rating/price/
  // check-in/out) saved on generation; fall back to whatever the daily
  // stops carry if that enrichment wasn't stored, so older itineraries
  // still get a section instead of it silently disappearing.
  const fallbackStop = stops.find((s) => s.category === 'accommodation');
  const acc = accommodation || (fallbackStop && {
    name: fallbackStop.name,
    address: fallbackStop.address,
    rating: fallbackStop.rating,
    phone: fallbackStop.phone,
  });

  sectionTitle(doc, 'Accommodation');
  ensureSpace(doc, 90);

  if (!acc) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
      .text('No accommodation was requested or found for this trip.');
    doc.moveDown(0.4);
    return;
  }

  const rows = [
    ['Hotel name', acc.name || '—'],
    ['Address', acc.address || '—'],
    ['Rating', acc.rating != null ? `★ ${acc.rating}` : '—'],
    ['Price per night', acc.price_per_night_inr != null ? `₹${Number(acc.price_per_night_inr).toLocaleString('en-IN')}` : '—'],
    ['Check-in', acc.check_in_time || '—'],
    ['Check-out', acc.check_out_time || '—'],
  ];
  drawKeyValueGrid(doc, rows);
  doc.moveDown(0.4);
}

function drawDailyTimeline(doc, stops) {
  sectionTitle(doc, 'Day-wise Itinerary');

  if (!stops.length) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(10).text('No stops available for this itinerary yet.');
    return;
  }

  const byDay = new Map();
  stops.forEach((s) => {
    const day = s.day ?? 1;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  });

  [...byDay.entries()].sort((a, b) => a[0] - b[0]).forEach(([day, dayStops]) => {
    ensureSpace(doc, 60);
    const dateLabel = dayStops[0]?.date ? ` · ${dayStops[0].date}` : '';
    doc.fillColor(COLORS.coral).font('Helvetica-Bold').fontSize(11).text(`Day ${day}${dateLabel}`);
    doc.moveDown(0.2);

    dayStops.forEach((stop) => {
      ensureSpace(doc, 70);
      const y = doc.y;

      doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(10)
        .text(stop.arrival_time || '—', PAGE_MARGIN, y, { width: 55 });
      doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(10.5)
        .text(stop.name || 'Stop', PAGE_MARGIN + 60, y, { width: 340 });

      let lineY = doc.y + 1;
      if (stop.category) {
        doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(8.5)
          .text(capitalize(stop.category), PAGE_MARGIN + 60, lineY, { width: 340 });
        lineY = doc.y + 1;
      }

      const detailBits = [];
      if (stop.visit_minutes) detailBits.push(`Duration: ${stop.visit_minutes} min`);
      if (stop.travel_minutes_from_prev != null) detailBits.push(`Travel: ${stop.travel_minutes_from_prev} min`);
      if (stop.transport_mode) detailBits.push(`Transport: ${capitalize(stop.transport_mode)}`);
      if (stop.entry_cost_inr != null) detailBits.push(`Entry Fee: ₹${stop.entry_cost_inr}`);
      if (detailBits.length) {
        doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.5)
          .text(detailBits.join('   ·   '), PAGE_MARGIN + 60, lineY, { width: 340 });
        lineY = doc.y + 1;
      }

      // Estimated cost for this stop = entry fee + suggested nearby meal cost,
      // distinct from the entry-fee-only figure above.
      const estimatedStopCost = (stop.entry_cost_inr || 0) + (stop.meal_suggestion?.avg_cost_inr || 0);
      if (estimatedStopCost > 0) {
        doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.5)
          .text(`Estimated Cost: ₹${estimatedStopCost}`, PAGE_MARGIN + 60, lineY, { width: 340 });
        lineY = doc.y + 1;
      }

      if (stop.meal_suggestion?.name) {
        doc.fillColor(COLORS.teal).font('Helvetica-Bold').fontSize(8.5)
          .text(`Nearby Food Recommendation: ${stop.meal_suggestion.name}`, PAGE_MARGIN + 60, lineY, { width: 340 });
        lineY = doc.y + 1;
      }

      if (stop.reasoning || stop.tips) {
        doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(8)
          .text(`Description: ${stop.reasoning || stop.tips}`, PAGE_MARGIN + 60, lineY, { width: 340 });
        lineY = doc.y + 1;
      }

      doc.y = Math.max(doc.y, lineY) + 6;
      doc.moveTo(PAGE_MARGIN, doc.y).lineTo(552, doc.y).lineWidth(0.5).strokeColor('#F0F0F5').stroke();
      doc.moveDown(0.4);
    });
    doc.moveDown(0.3);
  });
}

function drawBudgetBreakdown(doc, budget) {
  sectionTitle(doc, 'Final Budget Summary');
  ensureSpace(doc, 140);

  const byCategory = budget.by_category || {};
  const rows = [
    ['Transport', byCategory.transport],
    ['Food', budget.estimated_food_cost_inr],
    ['Accommodation', byCategory.accommodation],
    ['Entry fees', budget.entry_fees_total_inr],
    ['Shopping', byCategory.shopping],
    ['Buffer', byCategory.buffer],
  ].filter(([, val]) => val != null);

  const total = rows.reduce((sum, [, val]) => sum + Number(val || 0), 0);

  rows.forEach(([label, val]) => {
    const y = doc.y;
    doc.fillColor(COLORS.navy).font('Helvetica').fontSize(10).text(label, PAGE_MARGIN, y, { width: 200 });
    doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(10)
      .text(`₹${Number(val).toLocaleString('en-IN')}`, PAGE_MARGIN, y, { width: 510, align: 'right' });
    doc.moveDown(0.5);
  });

  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(552, doc.y).lineWidth(0.75).strokeColor(COLORS.navy).stroke();
  doc.moveDown(0.3);
  const y = doc.y;
  doc.fillColor(COLORS.coral).font('Helvetica-Bold').fontSize(11).text('Total estimated cost', PAGE_MARGIN, y, { width: 200 });
  doc.fillColor(COLORS.coral).font('Helvetica-Bold').fontSize(11)
    .text(`₹${total.toLocaleString('en-IN')}`, PAGE_MARGIN, y, { width: 510, align: 'right' });
  doc.moveDown(0.3);

  if (budget.total_budget_inr) {
    const remaining = Number(budget.total_budget_inr) - total;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
      .text(`Budget: ₹${Number(budget.total_budget_inr).toLocaleString('en-IN')}  ·  Remaining: ₹${remaining.toLocaleString('en-IN')}`);
  }
  doc.moveDown(0.5);
}

async function drawEmergencyServicesSection(doc, trip, emergencyContacts) {
  sectionTitle(doc, 'Emergency Services');
  ensureSpace(doc, 80);

  // National helpline numbers — the lightweight snapshot saved at
  // itinerary-generation time. Always safe to print (works anywhere in the
  // country), so this stays even if the live lookup below fails.
  if (emergencyContacts?.national_numbers?.length) {
    emergencyContacts.national_numbers.forEach((n) => {
      ensureSpace(doc, 16);
      const y = doc.y;
      doc.fillColor(COLORS.navy).font('Helvetica').fontSize(9).text(n.label, PAGE_MARGIN, y, { width: 380 });
      doc.fillColor(COLORS.coral).font('Helvetica-Bold').fontSize(9).text(n.number, PAGE_MARGIN, y, { width: 510, align: 'right' });
      doc.moveDown(0.35);
    });
    doc.moveDown(0.3);
  } else {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
      .text('National emergency numbers were not available when this itinerary was generated.');
    doc.moveDown(0.3);
  }

  // Live categorized facilities (hospitals/clinics/police/pharmacies) around
  // the destination — same service that powers the in-app Emergency
  // Services panel. Never blocks the PDF: any failure just falls back to a
  // graceful "not found" note per category.
  let live = null;
  try {
    if (trip?.destination_lat != null && trip?.destination_lng != null) {
      live = await getLiveEmergencyServices({ lat: trip.destination_lat, lng: trip.destination_lng });
    }
  } catch {
    live = null;
  }

  const categories = [
    ['hospitals', 'Hospitals'],
    ['clinics', 'Clinics'],
    ['police', 'Police Stations'],
    ['medical_stores', 'Pharmacies'],
  ];

  categories.forEach(([key, label]) => {
    ensureSpace(doc, 30);
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(8.5).text(label.toUpperCase());
    doc.moveDown(0.2);

    const items = live?.[key] || [];
    if (!items.length) {
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
        .text(`No ${label.toLowerCase()} found nearby for this destination.`);
      doc.moveDown(0.3);
      return;
    }

    items.forEach((f) => {
      ensureSpace(doc, 34);
      const y = doc.y;
      doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9.5)
        .text(f.name || 'Facility', PAGE_MARGIN, y, { width: 340 });
      if (f.distance_km != null) {
        doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
          .text(`${f.distance_km} km`, PAGE_MARGIN, y, { width: 510, align: 'right' });
      }
      let lineY = doc.y + 1;
      if (f.address) {
        doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.5)
          .text(f.address, PAGE_MARGIN, lineY, { width: 340 });
        lineY = doc.y + 1;
      }
      if (f.phone) {
        doc.fillColor(COLORS.coral).font('Helvetica-Bold').fontSize(8.5)
          .text(`Tel: ${f.phone}`, PAGE_MARGIN, lineY, { width: 340 });
      }
      const mapsUrl = f.maps_url || (f.latitude != null && f.longitude != null
        ? `https://www.google.com/maps/search/?api=1&query=${f.latitude},${f.longitude}`
        : null);
      if (mapsUrl) {
        doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(8.5)
          .text('Open in Google Maps', PAGE_MARGIN + 350, y + 12, { width: 160, align: 'right', link: mapsUrl, underline: true });
      }
      doc.y = Math.max(doc.y, lineY) + 6;
    });
    doc.moveDown(0.2);
  });
  doc.moveDown(0.3);
}

// ---------- Offers & Deals ----------

async function fetchRelevantOffers(destination) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabaseAdmin
      .from('offers')
      .select('*, businesses(business_name, location)')
      .eq('is_active', true)
      .or(`valid_until.is.null,valid_until.gte.${today}`)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error || !data) return [];

    const needle = (destination || '').toLowerCase();
    const matching = needle
      ? data.filter((o) => (o.businesses?.location || '').toLowerCase().includes(needle))
      : [];

    // Prefer offers from businesses located in the trip destination; if none
    // match, fall back to the most recent active offers overall so the
    // section is still useful rather than always empty.
    return (matching.length ? matching : data).slice(0, 8);
  } catch {
    return [];
  }
}

async function drawOffersSection(doc, trip) {
  sectionTitle(doc, 'Offers & Deals');
  ensureSpace(doc, 40);

  const offers = await fetchRelevantOffers(trip?.destination);
  if (!offers.length) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
      .text('No active business offers are available for this destination right now.');
    doc.moveDown(0.4);
    return;
  }

  offers.forEach((o) => {
    ensureSpace(doc, 40);
    const y = doc.y;
    const discountLabel = o.discount_value != null
      ? (o.discount_type === 'flat' ? `₹${o.discount_value} off` : `${o.discount_value}% off`)
      : 'Special offer';

    doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(9.5)
      .text(o.title || 'Offer', PAGE_MARGIN, y, { width: 340 });
    doc.fillColor(COLORS.coral).font('Helvetica-Bold').fontSize(9.5)
      .text(discountLabel, PAGE_MARGIN, y, { width: 510, align: 'right' });

    let lineY = doc.y + 1;
    const businessName = o.businesses?.business_name;
    if (businessName) {
      doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(8.5)
        .text(businessName, PAGE_MARGIN, lineY, { width: 340 });
      lineY = doc.y + 1;
    }
    if (o.description) {
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.5)
        .text(o.description, PAGE_MARGIN, lineY, { width: 470 });
      lineY = doc.y + 1;
    }
    if (o.valid_until) {
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
        .text(`Valid until ${o.valid_until}`, PAGE_MARGIN, lineY, { width: 340 });
      lineY = doc.y + 1;
    }

    doc.y = Math.max(doc.y, lineY) + 6;
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(552, doc.y).lineWidth(0.5).strokeColor('#F0F0F5').stroke();
    doc.moveDown(0.4);
  });
}

async function drawMapSection(doc, stops) {
  sectionTitle(doc, 'Maps');

  const points = stops.filter((s) => s.latitude != null && s.longitude != null);
  if (!points.length) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text('No coordinates available to render a route map.');
    doc.moveDown(0.4);
    return;
  }

  let mapImageDrawn = false;
  if (env.googlePlacesApiKey) {
    try {
      const imageBuffer = await fetchStaticMapImage(points);
      if (!imageBuffer) throw new Error('empty map image');
      ensureSpace(doc, 260);
      // `fit` scales the image to stay inside the box while preserving its
      // aspect ratio, so it can never crop or stretch/overlap surrounding text.
      doc.image(imageBuffer, PAGE_MARGIN, doc.y, { width: 510, height: 240, fit: [510, 240] });
      doc.moveDown(12.5);
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5)
        .text('Map data © Google Maps · Numbered pins follow the stop order above.', { align: 'center' });
      mapImageDrawn = true;
    } catch {
      mapImageDrawn = false;
    }
  }

  if (!mapImageDrawn) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
      .text('A route map image is unavailable in this export — use the direct navigation links below, or view the interactive map inside the GoVIBE app.');
  }

  // Per-destination fallback/complement: a direct, clickable Google Maps
  // navigation link for every stop, so the traveler can always open
  // turn-by-turn directions even without the static map image.
  doc.moveDown(0.5);
  ensureSpace(doc, 20);
  doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(8.5).text('OPEN EACH DESTINATION IN GOOGLE MAPS');
  doc.moveDown(0.3);

  points.forEach((stop, i) => {
    ensureSpace(doc, 16);
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${stop.latitude},${stop.longitude}`;
    const y = doc.y;
    doc.fillColor(COLORS.navy).font('Helvetica').fontSize(9)
      .text(`${i + 1}. ${stop.name || 'Stop'}`, PAGE_MARGIN, y, { width: 340 });
    doc.fillColor(COLORS.coral).font('Helvetica-Bold').fontSize(8.5)
      .text('Open in Google Maps', PAGE_MARGIN + 350, y, { width: 160, align: 'right', link: mapsUrl, underline: true });
    doc.moveDown(0.35);
  });
  doc.moveDown(0.4);
}

async function fetchStaticMapImage(points) {
  // Google Static Maps allows a generous but finite URL/marker count —
  // cap at 20 numbered stops so a long multi-day trip never breaks the
  // request; the path still traces every stop in order.
  const capped = points.slice(0, 20);
  const markerParams = capped
    .map((p, i) => `markers=color:0x1A1B3A%7Clabel:${i + 1}%7C${p.latitude},${p.longitude}`)
    .join('&');
  const pathParam = `path=color:0xFF6B5BCC%7Cweight:3%7C${capped.map((p) => `${p.latitude},${p.longitude}`).join('%7C')}`;
  const url = `${STATIC_MAP_URL}?size=1000x480&scale=1&${markerParams}&${pathParam}&key=${env.googlePlacesApiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timeout);
  }
}

async function drawQrCodeSection(doc, trip) {
  if (!trip?.id) return;
  sectionTitle(doc, 'Open In GoVIBE');

  try {
    const appUrl = `${env.corsOrigin}/trip/${trip.id}/results`;
    const dataUrl = await QRCode.toDataURL(appUrl, { margin: 1, width: 200 });
    const base64 = dataUrl.split(',')[1];
    const imageBuffer = Buffer.from(base64, 'base64');
    ensureSpace(doc, 110);
    doc.image(imageBuffer, PAGE_MARGIN, doc.y, { width: 90, height: 90 });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
      .text('Scan to reopen this itinerary inside GoVIBE AI on your phone.', PAGE_MARGIN + 104, doc.y - 60, { width: 350 });
    doc.y += 40;
  } catch {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text('QR code unavailable for this download.');
  }
  doc.moveDown(0.4);
}

function drawTravelTips(doc, travelTips) {
  sectionTitle(doc, 'Travel Tips');
  ensureSpace(doc, 60);

  const tips = travelTips?.length
    ? travelTips
    : ['Carry a printed or offline copy of this itinerary in case of poor network coverage.',
       'Keep some cash on hand — not every stop accepts cards.',
       'Save the emergency contacts above to your phone before you set off.'];

  tips.forEach((tip) => {
    ensureSpace(doc, 20);
    doc.fillColor(COLORS.coral).font('Helvetica-Bold').fontSize(9).text('•  ', PAGE_MARGIN, doc.y, { continued: true, width: 20 });
    doc.fillColor(COLORS.navy).font('Helvetica').fontSize(9).text(tip, { width: 495 });
    doc.moveDown(0.25);
  });
}

function drawFooterPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text(`GoVIBE AI  ·  Page ${i + 1} of ${range.count}`, PAGE_MARGIN, 800, { width: 510, align: 'center' });
  }
}

// ---------- small helpers ----------

function ensureSpace(doc, neededHeight) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottom) doc.addPage();
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).replace(/_/g, ' ');
}

function formatDuration(startDate, endDate) {
  if (!startDate || !endDate) return '—';
  const start = new Date(startDate);
  const end = new Date(endDate);
  const days = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
  return `${days} day(s) · ${startDate} to ${endDate}`;
}

function formatMinutes(totalMinutes) {
  if (totalMinutes == null || !Number.isFinite(Number(totalMinutes))) return '—';
  const minutes = Math.round(Number(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours <= 0) return `${remainder} min`;
  return remainder > 0 ? `${hours} hr ${remainder} min` : `${hours} hr`;
}