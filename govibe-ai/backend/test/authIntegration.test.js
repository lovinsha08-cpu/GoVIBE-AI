import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_URL = 'http://localhost:8000';
process.env.SUPABASE_ANON_KEY = 'dummy-key';

const { requireAuth, optionalAuth } = await import('../src/middleware/requireAuth.js');
const { supabaseAdmin } = await import('../src/config/supabase.js');

function mockReqRes(headers = {}) {
  const req = { headers };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  return { req, res };
}

test('requireAuth rejects requests without Authorization header', async () => {
  const { req, res } = mockReqRes();
  await requireAuth(req, res, () => assert.fail('next() called on unauthenticated request'));
  assert.equal(res.statusCode, 401);
});

test('requireAuth rejects invalid Bearer tokens', async () => {
  const { req, res } = mockReqRes({ authorization: 'Bearer invalid_token' });
  const originalGetUser = supabaseAdmin.auth.getUser;
  supabaseAdmin.auth.getUser = async () => ({ data: { user: null }, error: new Error('Invalid token') });
  
  try {
    await requireAuth(req, res, () => assert.fail('next() called on invalid token'));
    assert.equal(res.statusCode, 401);
  } finally {
    supabaseAdmin.auth.getUser = originalGetUser;
  }
});

test('requireAuth accepts valid Bearer tokens and sets req.user', async () => {
  const { req, res } = mockReqRes({ authorization: 'Bearer valid_token' });
  const mockUser = { id: 'test-user', email: 'test@example.com' };
  
  const originalGetUser = supabaseAdmin.auth.getUser;
  supabaseAdmin.auth.getUser = async () => ({ data: { user: mockUser }, error: null });
  
  let nextCalled = false;
  try {
    await requireAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.deepEqual(req.user, mockUser);
  } finally {
    supabaseAdmin.auth.getUser = originalGetUser;
  }
});

test('optionalAuth proceeds without user if header is missing', async () => {
  const { req, res } = mockReqRes();
  let nextCalled = false;
  await optionalAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.user, null);
});
