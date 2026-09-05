/**
 * Safety wrapper around the canonical conversation context model.
 *
 * The general context model is intentionally broad because it serves many
 * assistant intents. Planning has a stricter rule: a trip destination must
 * never be mistaken for the traveler's current location. This wrapper keeps
 * those concepts separate before the deterministic router consumes context.
 */
import { buildConversationContext } from './conversationContext.service.js';

function explicitCurrentLocation(history = [], currentMessage = '') {
  const turns = [...(Array.isArray(history) ? history : []), { role: 'user', content: currentMessage }];
  for (const turn of [...turns].reverse()) {
    if (turn?.role !== 'user') continue;
    const match = String(turn.content || '').match(/^\s*(?:i(?:'m| am)|we(?:'re| are))\s+(?:now\s+)?(?:in|at)\s+(.+?)\s*[.!]?\s*$/i);
    if (match?.[1]) return match[1].replace(/\s+/g, ' ').trim();
  }
  return null;
}

export function buildConversationRoutingContext(history = [], message = '', role = 'traveler') {
  const context = buildConversationContext(history, message, role);
  const currentLocation = explicitCurrentLocation(history, message);

  if (context.intent === 'trip_planning') {
    return {
      ...context,
      // During trip planning, "visit Guindy on October 2" means destination,
      // not current location. Only an explicit "I am now in ..." can populate
      // the current-location slot.
      location: currentLocation,
    };
  }

  return context;
}
