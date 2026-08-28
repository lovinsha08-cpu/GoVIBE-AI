import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationContext, intentNeedsTool, validateToolResult } from '../src/services/conversationContext.service.js';

test('general conversation does not qualify for map/live tools', () => {
  const state = buildConversationContext([], 'What else can you do for travelers?');
  assert.equal(state.intent, 'general_help');
  assert.equal(intentNeedsTool(state.intent), false);
});

test('mode-led and conventional transit phrases extract route entities', () => {
  for (const message of ['bus from River Station to Old Town', 'bus to River Station to Old Town']) {
    const state = buildConversationContext([], message);
    assert.equal(state.intent, 'transit_search');
    assert.equal(state.origin, 'River Station');
    assert.equal(state.destination, 'Old Town');
    assert.equal(state.mode, 'bus');
  }
});

test('place follow-ups reuse a prior location without treating the whole message as a place', () => {
  const history = [{ role: 'user', content: 'Find a cafe near Example University, Example City' }];
  const state = buildConversationContext(history, 'Find restaurants instead');
  assert.equal(state.intent, 'place_search');
  assert.equal(state.category, 'restaurant');
  assert.equal(state.location, 'Example University');
});

test('tool-result validation rejects malformed route data and accepts normalized place results', () => {
  assert.equal(validateToolResult('get_route', { distance_km: 2 }).valid, false);
  assert.equal(validateToolResult('find_nearby', { results: [] }).valid, true);
});
