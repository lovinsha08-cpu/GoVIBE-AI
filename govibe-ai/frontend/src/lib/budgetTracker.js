/**
 * Live Budget Tracker — shared expense store.
 *
 * Expenses recorded by checking off items on the Booking Itinerary page
 * (source: "Itinerary") and expenses added manually on the Budget Tracker
 * page (source: "Manual") are kept in localStorage, namespaced per trip,
 * so that:
 *  - both pages read/write the same data,
 *  - progress survives a page refresh,
 *  - both pages update instantly when the data changes (via a same-tab
 *    CustomEvent — the native `storage` event only fires in *other* tabs).
 *
 * This is intentionally self-contained (no other file's behaviour changes)
 * so it can be dropped in without touching PDF export, maps, itinerary
 * generation, emergency services, or auth.
 */

const STORAGE_PREFIX = 'govibe_budget_expenses_';
const EVENT_NAME = 'govibe-budget-updated';

/** Categories a payable itinerary item can map to. */
export const EXPENSE_CATEGORIES = ['Food', 'Travel', 'Accommodation', 'Experience'];

/** Categories offered on the manual "Add Expense" form (includes "Other"). */
export const MANUAL_EXPENSE_CATEGORIES = [...EXPENSE_CATEGORIES, 'Other'];

function storageKey(tripId) {
  return `${STORAGE_PREFIX}${tripId}`;
}

function safeParse(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Reads all recorded expenses for a trip. */
export function readExpenses(tripId) {
  if (!tripId || typeof window === 'undefined') return [];
  return safeParse(window.localStorage.getItem(storageKey(tripId)));
}

function writeExpenses(tripId, expenses) {
  if (!tripId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(tripId), JSON.stringify(expenses));
  } catch {
    // Storage unavailable (private browsing / quota exceeded) — the UI still
    // works for the current session via React state, it just won't persist.
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { tripId } }));
}

/**
 * Adds or updates (by id) a single expense for a trip.
 * Using upsert-by-id is what makes repeated checkbox clicks idempotent —
 * re-checking an already-tracked item just overwrites the same record
 * instead of creating a duplicate.
 */
export function upsertExpense(tripId, expense) {
  if (!tripId || !expense?.id) return readExpenses(tripId);
  const current = readExpenses(tripId);
  const idx = current.findIndex((e) => e.id === expense.id);
  const next = idx >= 0
    ? current.map((e, i) => (i === idx ? { ...e, ...expense } : e))
    : [...current, expense];
  writeExpenses(tripId, next);
  return next;
}

/** Removes a single expense by id. */
export function removeExpense(tripId, id) {
  if (!tripId) return readExpenses(tripId);
  const next = readExpenses(tripId).filter((e) => e.id !== id);
  writeExpenses(tripId, next);
  return next;
}

/** Subscribes to changes for a given trip's expenses. Returns an unsubscribe fn. */
export function subscribeToExpenses(tripId, callback) {
  if (typeof window === 'undefined') return () => {};
  const handleCustom = (evt) => {
    if (!tripId || evt?.detail?.tripId === tripId) callback();
  };
  const handleStorage = (evt) => {
    if (!evt.key || evt.key === storageKey(tripId)) callback();
  };
  window.addEventListener(EVENT_NAME, handleCustom);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, handleCustom);
    window.removeEventListener('storage', handleStorage);
  };
}

/** Sums the amount of every recorded expense. */
export function totalSpent(expenses) {
  return expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
}

/** Groups expenses by category, returning { category: { items, subtotal } }. */
export function groupByCategory(expenses) {
  const groups = {};
  expenses.forEach((e) => {
    const cat = e.category || 'Other';
    if (!groups[cat]) groups[cat] = { items: [], subtotal: 0 };
    groups[cat].items.push(e);
    groups[cat].subtotal += Number(e.amount) || 0;
  });
  return groups;
}