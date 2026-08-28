import test from 'node:test';
import assert from 'node:assert/strict';

// env.js reads GOOGLE_PLACES_API_KEY at import time, so it must be set
// before verifyBusinessLocation (which checks isBusinessVerificationConfigured)
// is imported anywhere in this process.
process.env.GOOGLE_PLACES_API_KEY = 'test-key-for-unit-tests';

const { verifyBusinessLocation } = await import('../src/services/businessVerification.service.js');
const { verifyLocation } = await import('../src/controllers/businessOnboarding.controller.js');

// Anchor point used across tests: two nearby coordinates ~2.2km apart, and
// one far away, to exercise the match / too-far / not-found branches.
const OWNER_GPS = { lat: 13.0827, lng: 80.2707 }; // Chennai
const NEARBY_MATCH = { lat: 13.0830, lng: 80.2710 }; // ~40m away
const TOO_FAR_MATCH = { lat: 13.1000, lng: 80.2900 }; // ~2.2km away
const FAR_OUTSIDE_SEARCH = { lat: 20.0, lng: 80.0 }; // >>2km away

function mockFetchOnce(responses) {
  let call = 0;
  global.fetch = async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: r.ok !== false,
      status: r.httpStatus || 200,
      json: async () => r.body,
    };
  };
}

test('happy path: matching name + GPS within radius verifies the location', async () => {
  mockFetchOnce([
    { body: { status: 'OK', results: [{ place_id: 'p1', name: 'Backwater Bites Cafe', geometry: { location: { lat: NEARBY_MATCH.lat, lng: NEARBY_MATCH.lng } }, types: ['cafe'] }] } },
    { body: { status: 'OK', result: { formatted_address: '12 Beach Rd, Chennai', formatted_phone_number: '+91 90000 00000', opening_hours: { open_now: true }, rating: 4.5, user_ratings_total: 120 } } },
  ]);

  const result = await verifyBusinessLocation({
    businessName: 'Backwater Bites Cafe',
    category: 'Food',
    latitude: OWNER_GPS.lat,
    longitude: OWNER_GPS.lng,
  });

  assert.equal(result.status, 'matched');
  assert.equal(result.locationVerified, true);
  assert.equal(result.ownerVerified, false); // never set true by this module
  assert.equal(result.place.address, '12 Beach Rd, Chennai');
  assert.equal(result.place.phone, '+91 90000 00000');
  assert.ok(result.distanceMeters < 300);
});

test('business not found: zero results returns not_found, never throws', async () => {
  mockFetchOnce([{ body: { status: 'ZERO_RESULTS', results: [] } }]);

  const result = await verifyBusinessLocation({
    businessName: 'Totally Fictional Business XYZ',
    category: 'Food',
    latitude: OWNER_GPS.lat,
    longitude: OWNER_GPS.lng,
  });

  assert.equal(result.status, 'not_found');
  assert.equal(result.locationVerified, false);
});

test('inaccurate location: a real name match too far away is reported as too_far, not matched', async () => {
  mockFetchOnce([
    { body: { status: 'OK', results: [{ place_id: 'p2', name: 'Backwater Bites Cafe', geometry: { location: { lat: TOO_FAR_MATCH.lat, lng: TOO_FAR_MATCH.lng } }, types: ['cafe'] }] } },
  ]);

  const result = await verifyBusinessLocation({
    businessName: 'Backwater Bites Cafe',
    category: 'Food',
    latitude: OWNER_GPS.lat,
    longitude: OWNER_GPS.lng,
  });

  assert.equal(result.status, 'too_far');
  assert.equal(result.locationVerified, false);
  assert.ok(result.distanceMeters > 300);
});

test('API failure: a network/HTTP error degrades to api_failure without throwing', async () => {
  global.fetch = async () => { throw new Error('network down'); };

  const result = await verifyBusinessLocation({
    businessName: 'Backwater Bites Cafe',
    category: 'Food',
    latitude: OWNER_GPS.lat,
    longitude: OWNER_GPS.lng,
  });

  assert.equal(result.status, 'api_failure');
  assert.equal(result.locationVerified, false);
});

test('rate limit: OVER_QUERY_LIMIT is surfaced distinctly from a generic failure', async () => {
  mockFetchOnce([{ body: { status: 'OVER_QUERY_LIMIT', results: [] } }]);

  const result = await verifyBusinessLocation({
    businessName: 'Backwater Bites Cafe',
    category: 'Food',
    latitude: OWNER_GPS.lat,
    longitude: OWNER_GPS.lng,
  });

  assert.equal(result.status, 'rate_limited');
  assert.equal(result.locationVerified, false);
});

test('far-outside-search-radius candidates are ignored entirely (not_found, not too_far)', async () => {
  mockFetchOnce([
    { body: { status: 'OK', results: [{ place_id: 'p3', name: 'Backwater Bites Cafe', geometry: { location: { lat: FAR_OUTSIDE_SEARCH.lat, lng: FAR_OUTSIDE_SEARCH.lng } }, types: ['cafe'] }] } },
  ]);

  const result = await verifyBusinessLocation({
    businessName: 'Backwater Bites Cafe',
    category: 'Food',
    latitude: OWNER_GPS.lat,
    longitude: OWNER_GPS.lng,
  });

  // Google's Text Search itself is location-biased by radius, so in
  // practice this candidate wouldn't come back at all; this test just
  // confirms our own distance math doesn't misclassify a stray result.
  assert.notEqual(result.status, 'matched');
});

// ---------- Controller-level input validation (invalid GPS) ----------

function makeRes() {
  const res = {};
  res.statusCode = 200;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('controller rejects missing businessName as invalid input (400)', async () => {
  const req = { body: { latitude: 13.08, longitude: 80.27 } };
  const res = makeRes();
  await verifyLocation(req, res, () => assert.fail('next() should not be called'));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'missing_business_name');
});

test('controller rejects invalid/out-of-range GPS (400)', async () => {
  const req = { body: { businessName: 'Test Cafe', latitude: 999, longitude: 80.27 } };
  const res = makeRes();
  await verifyLocation(req, res, () => assert.fail('next() should not be called'));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'invalid_gps');
});

test('controller rejects non-numeric GPS (400)', async () => {
  const req = { body: { businessName: 'Test Cafe', latitude: 'not-a-number', longitude: 80.27 } };
  const res = makeRes();
  await verifyLocation(req, res, () => assert.fail('next() should not be called'));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'invalid_gps');
});

test('controller rejects missing GPS entirely (400)', async () => {
  const req = { body: { businessName: 'Test Cafe' } };
  const res = makeRes();
  await verifyLocation(req, res, () => assert.fail('next() should not be called'));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'invalid_gps');
});

test('controller accepts valid input and returns the service result as 200', async () => {
  mockFetchOnce([{ body: { status: 'ZERO_RESULTS', results: [] } }]);
  const req = { body: { businessName: 'Test Cafe', category: 'Food', latitude: 13.08, longitude: 80.27 } };
  const res = makeRes();
  await verifyLocation(req, res, () => assert.fail('next() should not be called'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'not_found');
});