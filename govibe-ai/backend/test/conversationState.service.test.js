import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationState,
  isBareDate,
  isCurrentLocationStatement,
  isExplicitWeatherRequest,
  missingPlanningData,
} from '../src/services/conversationState.service.js';

test('keeps destination and updates date across a follow-up', () => {
  const history = [{ role: 'user', content: 'I want to visit Guindy on October 2' }];
  const state = buildConversationState(history, 'September 13');

  assert.equal(state.destination, 'Guindy');
  assert.equal(state.travelDate, 'September 13');
});

test('extracts route origin and destination', () => {
  const state = buildConversationState([], 'Plan a trip from Velachery to Guindy, Chennai');

  assert.equal(state.origin, 'Velachery');
  assert.equal(state.destination, 'Guindy, Chennai');
});

test('keeps current location separate from explicit destination', () => {
  const history = [
    { role: 'user', content: 'I want restaurants near Elliot\'s Beach' },
    { role: 'assistant', content: 'Here are some options.' },
  ];
  const state = buildConversationState(history, 'I am now in Velachery');

  assert.equal(state.currentLocation, 'Velachery');
  assert.equal(state.destination, null);
  assert.equal(state.category, 'restaurants');
});

test('retains discovery category when the next turn only supplies a location', () => {
  const history = [{ role: 'user', content: 'park with a jogging track or a botanical garden' }];
  const state = buildConversationState(history, 'in Chennai');

  assert.equal(state.category, 'nature');
  assert.equal(state.destination, 'Chennai');
});

test('extracts planning fields without confusing a date for weather', () => {
  const state = buildConversationState([], 'Plan a 2 day trip to Chennai on September 13 under ₹1000 for 2 people from Velachery');

  assert.equal(state.destination, 'Chennai');
  assert.equal(state.travelDate, 'September 13');
  assert.equal(state.duration, '2 day');
  assert.equal(state.budget, 1000);
  assert.equal(state.people, 2);
  assert.equal(state.origin, 'Velachery');
  assert.equal(isExplicitWeatherRequest('Plan a trip to Guindy on October 2'), false);
});

test('recognizes date and current-location statements', () => {
  assert.equal(isBareDate('September 13'), true);
  assert.equal(isBareDate('what is the weather on September 13?'), false);
  assert.equal(isCurrentLocationStatement('I am now in Velachery'), true);
});

test('reports only the planning fields that are actually missing', () => {
  const state = buildConversationState(
    [{ role: 'user', content: 'I want to visit Guindy on September 13' }],
    'plan a trip',
  );

  assert.deepEqual(missingPlanningData(state), ['trip duration', 'budget', 'starting location']);
});
