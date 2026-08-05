import { useCallback, useEffect, useState } from 'react';
import { readExpenses, upsertExpense, removeExpense, subscribeToExpenses } from './budgetTracker';

/**
 * Live Budget Tracker hook — gives any page a synced, persisted view of a
 * trip's recorded expenses (from itinerary checkboxes and manual entries).
 */
export function useBudgetExpenses(tripId) {
  const [expenses, setExpenses] = useState(() => readExpenses(tripId));

  useEffect(() => {
    setExpenses(readExpenses(tripId));
    const unsubscribe = subscribeToExpenses(tripId, () => setExpenses(readExpenses(tripId)));
    return unsubscribe;
  }, [tripId]);

  const addExpense = useCallback((expense) => {
    if (!tripId) return;
    upsertExpense(tripId, expense);
  }, [tripId]);

  const removeExpenseById = useCallback((id) => {
    if (!tripId) return;
    removeExpense(tripId, id);
  }, [tripId]);

  const isTracked = useCallback((id) => expenses.some((e) => e.id === id), [expenses]);

  return { expenses, addExpense, removeExpense: removeExpenseById, isTracked };
}