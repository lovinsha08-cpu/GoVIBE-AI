# GoVIBE AI

Context-aware tourism planner + local business platform.

## Structure
- `frontend/` — React + Vite + Tailwind v4 + Framer Motion. Landing page built.
- `backend/`  — Node.js + Express + Supabase. Auth routes (traveler/business signup, login, forgot password) built and tested.

## Frontend: run locally
```
cd frontend
npm install
npm run dev
```

## Backend: run locally
```
cd backend
npm install
cp .env.example .env   # fill in your Supabase URL + keys
npm run dev
```
Then run `backend/supabase/schema.sql` in your Supabase project's SQL editor to create the `travelers` and `businesses` tables.

Health check: `GET http://localhost:4000/api/health`

## Status
- [x] Landing page (hero, traveler/business login choice, features)
- [x] Backend scaffold (Express + Supabase, auth routes, schema, middleware)
- [x] Traveler auth UI (login / signup / forgot password) — wired to backend
- [x] Business registration UI (multi-field form) — wired to backend
- [x] Data tables (spots, trips, itineraries, interests, emergency_facilities, offers)
- [x] AI/ML engine: spot matching + ranking, hidden-gem detection, nearest-neighbor route ordering (OSRM + haversine fallback), AI budget split, Gemini reasoning (+ heuristic fallback)
- [x] 8-step trip wizard (destination, duration, interests, budget, people, transport, food) → generates real itinerary
- [x] Itinerary results page (route visualization, stop cards, budget breakdown, regenerate)
- [x] Real map tiles (Leaflet + OpenStreetMap, no API key) on the itinerary page and new `/explore` page
- [x] Real tourism dataset — bundled sample (Jaipur: attractions, hotels, restaurants, hidden gems) + `scripts/seedSpots.js` to pull live OSM data for any city (free, no key)
- [x] `/api/spots` endpoint — browse/filter seeded spots by category or hidden-gem status
- [x] Sample-data fallback — itinerary engine and `/api/spots` work with zero setup even before Supabase is configured
- [x] Live weather API integration (Open-Meteo, free, no key) — per-stop forecast notes + automatic outdoor→indoor swaps when the forecast is unfriendly
- [x] AI trip summary — "why this plan fits you" (Gemini when configured, heuristic sentence otherwise)
- [x] Meal/restaurant suggestions attached after each non-food stop (nearest matching spot in the dataset)
- [x] Public transport suggestions per leg (walk / auto / bus-metro / metro+cab, by distance)
- [x] Hidden gems now include a one-line reason they qualify
- [x] One-click "Regenerate this stop" — `POST /api/itinerary/:tripId/stop/:stopOrder/regenerate` swaps a single stop without rerolling the whole plan
- [x] Live budget tracker on the itinerary page — check off planned costs / add ad-hoc expenses, remaining budget updates instantly (session-only for now)
- [x] Route map visualization (Leaflet + OpenStreetMap) — already in place, unchanged
- [x] Emergency contacts — live nearest hospitals/clinics/police/pharmacies via the free Overpass (OpenStreetMap) API + official national helpline numbers, surfaced in the "Emergency services" panel
- [x] Local events — official public holidays inside the trip's date range via the free Nager.Date API, surfaced in a "Local events" panel with a crowd-impact note
- [x] Packing suggestions — a per-trip packing list generated from the live weather forecast, selected interests, group composition, and trip length
- [x] Best-visiting-time / crowd-avoidance guidance per stop — a best-time window, a specific time to avoid, and a one-line tip, shown on every stop card
- [x] Nearby attractions per stop — "while you're here, also consider..." suggestions pulled from the same spot dataset, within a short radius, ranked by rating
- [x] Personalized learning system — learns favorite interest categories, food prefs, transport priority, average budget/duration from a traveler's own past trips (no new schema — reads existing `trips` history) and softly nudges future itineraries toward them
- [x] AI confidence scores — interest match, budget accuracy, route efficiency, weather suitability, transport optimization, and an overall score, shown per itinerary
- [x] Structured "how the AI decided" explanation — a trip-level bullet list (budget fit, interest prioritization, weather rearrangement, route optimization, meal timing, hidden gems, learned-preference nudges) alongside the existing per-stop reasoning
- [ ] Traveler dashboard (hidden gems tab / saved itineraries / offers / AI assistant)
- [ ] Business dashboard + analytics
- [ ] Business genuineness verification service
- [ ] Direct booking links per spot (schema has `booking_url`, not populated yet)
- [ ] PDF itinerary download
- [ ] Persisted budget tracker (currently client-side/session-only — needs a trip_expenses table)

## New AI/"wow" features
- **Weather-aware adjustments** (`backend/src/services/weather.service.js`) — calls Open-Meteo's free forecast API for the destination + trip start date. If the forecast is rain/storm/snow, outdoor-category stops (`nature`, `adventure`) are automatically swapped for a nearby indoor alternative, and the swap is explained on the stop card. Falls back to a neutral note if the API is unreachable or the date is outside the 16-day forecast window — never blocks generation.
- **Meal suggestions between attractions** — after each non-food/non-lodging stop, the nearest food spot in the dataset (within 3km) is attached with distance, rating, and average cost.
- **Public transport recommendations** — each leg gets a distance-based suggestion (walk / shared auto / bus-metro / metro+cab combo) as a budget-friendly alternative to the trip's primary transport mode.
- **Hidden gems with reasons** — each hidden gem now ships a one-line explanation (rating vs. popularity score) instead of just a name and star rating.
- **Regenerate this stop** — new endpoint swaps a single stop for another same-category candidate nearby, keeping the rest of the itinerary untouched, instead of rerolling everything.
- **Live budget tracker** — an interactive panel on the itinerary page: check off the AI-estimated cost categories as you actually spend them, add custom expenses, and watch remaining budget update in real time via an animated progress bar.
- **AI trip summary** — a short "why this plan fits you" paragraph, either from Gemini (when `GEMINI_API_KEY` is set) or a heuristic equivalent, shown at the top of the itinerary.
- **Emergency contacts** (`backend/src/services/emergency.service.js`) — official national emergency helpline numbers (e.g. India: 112 all-in-one, 100 police, 101 fire, 102 ambulance, 1363 tourist helpline) plus the nearest real hospitals, clinics, police stations, and pharmacies around the destination, fetched live from OpenStreetMap's free Overpass API. Falls back to numbers-only if Overpass is slow/unreachable.
- **Local events** (`backend/src/services/events.service.js`) — any official public holiday that falls inside the trip's dates, via the free Nager.Date API (aggregates real government holiday calendars, no key needed). Flagged with a note that holidays usually mean bigger crowds and possible closures.
- **Packing suggestions** (`backend/src/services/packing.service.js`) — a packing list generated per trip from the live weather forecast (heat/cold/rain gear), the traveler's selected interests (hiking shoes for adventure/nature, modest clothing for heritage sites), group composition (medication reminders, kids' entertainment), and trip length.
- **Best visiting time + crowd avoidance** (`backend/src/services/routing.service.js`) — each stop gets a specific best-time window, a specific time to avoid, and a one-line tip (e.g. "arrive within the first hour to beat tour buses"), instead of just a crowd-level badge.
- **Nearby attractions** — each stop surfaces up to 3 nearby spots (within ~2.5km, ranked by rating) worth a detour, pulled from the same dataset used for the main route.
- **Personalized learning system** (`backend/src/services/preferenceLearning.service.js`) — reads a traveler's own past trips (needs 2+ to activate) and surfaces their favorite interest categories, food preferences, transport priority, average budget, and average trip length. Favorite categories get a soft scoring boost in future itinerary generation — additive to, never a replacement for, what the traveler explicitly picks that trip.
- **AI confidence scores** (`backend/src/services/confidenceScore.service.js`) — every itinerary is graded 0-100 on interest match, budget accuracy, route efficiency, weather suitability, and transport optimization, each derived from the actual generation output, plus a weighted overall score.
- **"How the AI decided" explanation** (`backend/src/services/decisionExplanation.service.js`) — a trip-level bullet list explaining the cross-cutting decisions (budget fit, interest prioritization, weather-driven rearrangement, route optimization, meal timing, hidden gems, learned-preference nudges), shown above the itinerary alongside the existing per-stop reasoning sentences.

## Maps + data seeding
Maps use Leaflet with free OpenStreetMap tiles — no Google Maps/Mapbox key needed.
The `spots` table can be empty; `/api/spots` and the itinerary engine both fall back
automatically to `backend/src/data/sampleSpots.json` (a real, curated Jaipur dataset)
so the app is demoable with zero setup. To seed real data for another city once you
have Supabase configured:
```
cd backend
node scripts/seedSpots.js --sample          # load the bundled sample dataset
node scripts/seedSpots.js "Udaipur, India"   # pull live OSM data for any city
```
Note: trip creation, auth, and saved itineraries still require a configured
Supabase project — only spot browsing and itinerary generation have a no-setup path.
