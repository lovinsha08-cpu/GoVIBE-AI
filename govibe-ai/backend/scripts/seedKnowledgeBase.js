/**
 * Seeds `faqs` and `kb_documents` with starter content + embeddings, so the
 * RAG layer (rag.service.js) has something to retrieve from day one.
 *
 * Run: node scripts/seedKnowledgeBase.js
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY in
 * backend/.env, and schema.sql + supabase/schema_ai_orchestration.sql
 * already applied.
 *
 * Safe to re-run — it doesn't dedupe, so re-running will insert duplicates;
 * for a real deployment, wrap this in a "delete existing rows first" step
 * or add a unique constraint. Left simple here since it's a starter seed.
 */
import { upsertFaq, upsertKbDocument } from '../src/services/rag.service.js';
import { isSupabaseConfigured } from '../src/config/supabase.js';

const FAQS = [
  { question: 'How do I create a new trip itinerary?', answer: 'Tap "Plan a New Trip" on your dashboard, then walk through the wizard — destination, dates, interests, budget, group size, transport, and food preferences. GoVIBE AI generates a full day-by-day itinerary once you submit.', category: 'itinerary', audience: 'traveler' },
  { question: 'Can I change or swap a stop in my itinerary?', answer: 'Yes — open the AI assistant from your trip and ask it to swap a specific stop, or use the swap button directly on that stop in the itinerary view. It will pick a suitable alternative in the same category.', category: 'itinerary', audience: 'traveler' },
  { question: 'Is GoVIBE free to use?', answer: 'Creating an account, planning trips, and browsing offers on GoVIBE is free for travelers. Individual bookings/experiences are paid directly to the business you book with.', category: 'billing', audience: 'both' },
  { question: 'How do I list my business on GoVIBE?', answer: 'Sign up for a Business account, fill in your business profile (name, category, location, description), and once verified you can add offers that travelers will see in their Offers & Deals tab.', category: 'onboarding', audience: 'business' },
  { question: 'How do I create an offer as a business?', answer: 'From your Business Dashboard, go to "Add New Offer", fill in the title, discount, category, and validity window, then publish. It appears immediately to travelers browsing offers.', category: 'offers', audience: 'business' },
  { question: 'What is a hidden gem on GoVIBE?', answer: 'A hidden gem is a lesser-known spot our ranking flags as high-quality but not yet widely popular (low popularity score, good rating) — a genuine local favorite rather than a typical tourist stop.', category: 'itinerary', audience: 'traveler' },
  { question: 'How do I cancel or delete a trip?', answer: 'Open the trip from "Saved Itineraries" and use the delete option there. This removes the trip and its generated itinerary from your account.', category: 'itinerary', audience: 'traveler' },
  { question: 'Can I download my itinerary as a PDF?', answer: 'Yes — open any generated itinerary and use the "Download PDF" button; it includes the full day-by-day plan, budget breakdown, and emergency contacts.', category: 'itinerary', audience: 'traveler' },
];

const KB_DOCS = [
  {
    title: 'GoVIBE AI itinerary engine — how it works',
    content: 'GoVIBE AI builds itineraries by combining a curated spots database (tourist attractions, restaurants, hotels) with live signals: weather forecasts (to swap outdoor stops on bad-weather days), route optimization (to minimize backtracking within a day), and your stated interests, budget, trip style, and group composition. When a Gemini API key is configured, a full AI-generated itinerary is attempted first; otherwise a heuristic ranking/route-optimization pipeline produces the plan, so the app always works.',
    source: 'platform_docs', category: 'itinerary', audience: 'both',
  },
  {
    title: 'Chennai — travel guide basics',
    content: 'Chennai, the capital of Tamil Nadu, blends colonial-era heritage (Fort St. George, San Thome Basilica) with a long coastline (Marina Beach, one of the world\'s longest urban beaches) and a strong food culture centered on filter coffee, dosa, and Chettinad cuisine. The best time to visit is November to February, avoiding the intense summer heat and the northeast monsoon (Oct–Dec) when heavy rain is common.',
    source: 'travel_guide', category: 'destination', audience: 'traveler', city: 'Chennai',
  },
  {
    title: 'GoVIBE cancellation & refund policy (offers/bookings)',
    content: 'Bookings made through a business\'s offer are governed by that business\'s own cancellation terms, shown at the time of booking. GoVIBE itself does not process payments for third-party bookings; it connects travelers and businesses. For platform-side issues (e.g. an offer that no longer matches its description), contact support through the app.',
    source: 'policy', category: 'billing', audience: 'both',
  },
  {
    title: 'Growing your business on GoVIBE — best practices',
    content: 'Businesses that perform best on GoVIBE typically: keep at least one active, time-bound offer (stale offers get deprioritized), use clear photos and specific descriptions rather than generic copy, respond to reviews, and keep their profile\'s category and location accurate so they surface correctly in traveler searches and "near me" results.',
    source: 'business_docs', category: 'growth', audience: 'business',
  },
  {
    title: 'Understanding your GoVIBE analytics',
    content: 'Business analytics on GoVIBE currently track: offer views (how many times an offer was shown to a traveler), bookings attributed to an offer, and your aggregate review rating. Revenue is calculated from confirmed bookings recorded in the platform. These numbers reflect real activity only — GoVIBE never estimates or projects figures it can\'t measure.',
    source: 'business_docs', category: 'analytics', audience: 'business',
  },
];

async function main() {
  if (!isSupabaseConfigured) {
    console.error('Supabase is not configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) — aborting.');
    process.exit(1);
  }

  console.log(`Seeding ${FAQS.length} FAQs...`);
  for (const faq of FAQS) {
    try {
      await upsertFaq(faq);
      console.log(`  ✓ ${faq.question}`);
    } catch (err) {
      console.error(`  ✗ ${faq.question}:`, err.message);
    }
  }

  console.log(`Seeding ${KB_DOCS.length} knowledge base documents...`);
  for (const doc of KB_DOCS) {
    try {
      await upsertKbDocument(doc);
      console.log(`  ✓ ${doc.title}`);
    } catch (err) {
      console.error(`  ✗ ${doc.title}:`, err.message);
    }
  }

  console.log('Done.');
}

main();