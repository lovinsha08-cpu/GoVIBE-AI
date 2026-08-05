import { useState, useEffect, useMemo } from 'react';
import { useParams, useLocation, useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Compass, Loader2, ArrowLeft, Plus, X, Trash2, Wallet, IndianRupee,
  UtensilsCrossed, Bus, Hotel, Ticket, MoreHorizontal, FlagOff, ListChecks,
} from 'lucide-react';
import { api } from '../lib/api';
import { useBudgetExpenses } from '../lib/useBudgetExpenses';
import { EXPENSE_CATEGORIES, MANUAL_EXPENSE_CATEGORIES, totalSpent, groupByCategory } from '../lib/budgetTracker';

const CATEGORY_META = {
  Food: { icon: UtensilsCrossed, color: '#2563EB' },
  Travel: { icon: Bus, color: '#16A34A' },
  Accommodation: { icon: Hotel, color: '#22C55E' },
  Experience: { icon: Ticket, color: '#8B7FE8' },
  Other: { icon: MoreHorizontal, color: '#0C3B5E' },
};

/** Order categories are displayed in — the four fixed ones first, "Other" last (only if used). */
const DISPLAY_ORDER = [...EXPENSE_CATEGORIES, 'Other'];

export default function BudgetTracker() {
  const { tripId } = useParams();
  const routerLocation = useLocation();
  const navigate = useNavigate();
  const [itinerary, setItinerary] = useState(routerLocation.state?.itinerary || null);
  const [loading, setLoading] = useState(!routerLocation.state?.itinerary);
  const [error, setError] = useState('');

  useEffect(() => {
    if (itinerary) return;
    api.getLatestItinerary(tripId)
      .then((res) => setItinerary(res.itinerary))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [tripId]);

  const budget = itinerary?.budget_summary || {};
  const totalBudget = budget.total_budget_inr || 0;

  const { expenses, addExpense, removeExpense } = useBudgetExpenses(tripId);

  const spentSoFar = useMemo(() => totalSpent(expenses), [expenses]);
  const remaining = totalBudget - spentSoFar;
  const pctSpent = totalBudget > 0 ? Math.min(100, Math.round((spentSoFar / totalBudget) * 100)) : 0;
  const grouped = useMemo(() => groupByCategory(expenses), [expenses]);
  const categoriesToShow = DISPLAY_ORDER.filter((cat) => grouped[cat]?.items.length);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newCategory, setNewCategory] = useState('Food');
  const [newNotes, setNewNotes] = useState('');

  const handleAddExpense = () => {
    const amount = Number(newAmount);
    if (!newName.trim() || !amount || amount <= 0) return;
    addExpense({
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: newName.trim(),
      category: newCategory,
      amount,
      notes: newNotes.trim() || null,
      dateTime: new Date().toISOString(),
      source: 'Manual',
      recordedAt: new Date().toISOString(),
    });
    setNewName('');
    setNewAmount('');
    setNewCategory('Food');
    setNewNotes('');
    setShowAddForm(false);
  };

  const [showSummary, setShowSummary] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#EAF7EF] flex items-center justify-center">
        <Loader2 className="animate-spin text-[#2563EB]" size={32} />
      </div>
    );
  }

  if (error && !itinerary) {
    return (
      <div className="min-h-screen bg-[#EAF7EF] flex flex-col items-center justify-center px-6 text-center">
        <p className="text-[#0C3B5E]/70 mb-4">{error}</p>
        <button onClick={() => navigate(-1)} className="text-[#2563EB] font-semibold text-sm">Go back</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#EAF7EF] px-4 sm:px-6 py-8 max-w-2xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <div className="w-9 h-9 rounded-xl bg-[#0C3B5E] flex items-center justify-center rotate-[-8deg]">
          <Compass className="text-[#22C55E]" size={16} strokeWidth={2.5} />
        </div>
        <span className="font-display font-bold text-lg text-[#0C3B5E]">GoVIBE</span>
      </div>

      <Link
        to={`/trip/${tripId}/booking`}
        state={{ itinerary }}
        className="flex items-center gap-1.5 text-xs font-medium text-[#0C3B5E]/55 hover:text-[#2563EB] mb-3"
      >
        <ArrowLeft size={13} /> Back to Booking Itinerary
      </Link>

      <div className="flex items-center gap-2 mb-1">
        <Wallet size={20} className="text-[#2563EB]" />
        <h1 className="font-display font-bold text-2xl text-[#0C3B5E]">Live Budget Tracker</h1>
      </div>
      <p className="text-sm text-[#0C3B5E]/55 mb-6">
        Everything you've checked off as paid on the Booking Itinerary, plus anything you add manually — all in one place.
      </p>

      {/* Trip Budget / Spent / Remaining */}
      <div className="rounded-2xl bg-[#0C3B5E] text-white p-4 mb-4">
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wide text-white/50">Trip budget</p>
            <p className="font-display font-bold text-base">₹{totalBudget.toLocaleString('en-IN')}</p>
          </div>
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wide text-white/50">Total spent</p>
            <p className="font-display font-bold text-base text-[#22C55E]">₹{spentSoFar.toLocaleString('en-IN')}</p>
          </div>
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wide text-white/50">Remaining</p>
            <p className={`font-display font-bold text-base ${remaining < 0 ? 'text-[#2563EB]' : 'text-[#16A34A]'}`}>
              ₹{remaining.toLocaleString('en-IN')}
            </p>
          </div>
        </div>
        <div className="h-2 rounded-full bg-white/10 overflow-hidden">
          <motion.div
            className="h-full rounded-full"
            style={{ backgroundColor: remaining < 0 ? '#2563EB' : '#16A34A' }}
            initial={{ width: 0 }}
            animate={{ width: `${pctSpent}%` }}
            transition={{ duration: 0.4 }}
          />
        </div>
        <p className="text-[11px] text-white/50 mt-1.5">{pctSpent}% of trip budget spent</p>
      </div>

      {/* Category-wise expenses */}
      {categoriesToShow.length === 0 ? (
        <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-6 text-center mb-4">
          <p className="text-sm text-[#0C3B5E]/60">
            No expenses recorded yet — check off paid items on the Booking Itinerary, or add one manually below.
          </p>
        </div>
      ) : (
        <div className="space-y-3 mb-4">
          {categoriesToShow.map((cat) => (
            <CategoryBlock
              key={cat}
              category={cat}
              items={grouped[cat].items}
              subtotal={grouped[cat].subtotal}
              onRemove={removeExpense}
            />
          ))}
        </div>
      )}

      {/* Manual expense entry */}
      <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4 mb-4">
        <AnimatePresence>
          {showAddForm && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="space-y-2 pb-3">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Expense name (e.g. souvenir shopping)"
                  className="w-full text-sm rounded-lg border border-[#0C3B5E]/10 px-2.5 py-1.5 outline-none focus:border-[#2563EB]"
                />
                <div className="flex gap-2">
                  <input
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value)}
                    placeholder="Amount (₹)"
                    type="number"
                    min="0"
                    className="flex-1 text-sm rounded-lg border border-[#0C3B5E]/10 px-2.5 py-1.5 outline-none focus:border-[#2563EB]"
                  />
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    className="text-sm rounded-lg border border-[#0C3B5E]/10 px-2.5 py-1.5 outline-none focus:border-[#2563EB] bg-white"
                  >
                    {MANUAL_EXPENSE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <input
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  placeholder="Notes (optional)"
                  className="w-full text-sm rounded-lg border border-[#0C3B5E]/10 px-2.5 py-1.5 outline-none focus:border-[#2563EB]"
                />
                <button
                  onClick={handleAddExpense}
                  className="w-full text-sm font-semibold text-white bg-[#0C3B5E] rounded-lg py-2"
                >
                  Save expense
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <button
          onClick={() => setShowAddForm((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold text-[#2563EB]"
        >
          {showAddForm ? <X size={13} /> : <Plus size={13} />}
          {showAddForm ? 'Cancel' : 'Add Expense'}
        </button>
      </div>

      {/* Journey Complete */}
      <button
        onClick={() => setShowSummary(true)}
        className="w-full flex items-center justify-center gap-2 text-sm font-semibold text-white bg-[#2563EB] rounded-xl py-3 mb-4"
      >
        <FlagOff size={15} /> Journey Complete
      </button>

      <AnimatePresence>
        {showSummary && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-5"
          >
            <div className="flex items-center gap-2 mb-3">
              <ListChecks size={16} className="text-[#2563EB]" />
              <p className="font-display font-bold text-base text-[#0C3B5E]">Trip Summary</p>
            </div>

            <div className="space-y-1.5 mb-3 text-sm">
              <div className="flex justify-between">
                <span className="text-[#0C3B5E]/60">Original trip budget</span>
                <span className="font-mono text-[#0C3B5E]">₹{totalBudget.toLocaleString('en-IN')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#0C3B5E]/60">Total spent</span>
                <span className="font-mono text-[#0C3B5E]">₹{spentSoFar.toLocaleString('en-IN')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#0C3B5E]/60">Remaining budget</span>
                <span className={`font-mono font-semibold ${remaining < 0 ? 'text-[#2563EB]' : 'text-[#16A34A]'}`}>
                  ₹{remaining.toLocaleString('en-IN')}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#0C3B5E]/60">Recorded expenses</span>
                <span className="font-mono text-[#0C3B5E]">{expenses.length}</span>
              </div>
            </div>

            <p className="text-[11px] font-semibold text-[#0C3B5E]/60 mb-2">Category-wise spending</p>
            <div className="space-y-1 mb-1">
              {DISPLAY_ORDER.filter((cat) => grouped[cat]?.items.length).map((cat) => (
                <div key={cat} className="flex justify-between text-xs">
                  <span className="text-[#0C3B5E]/70">{cat}</span>
                  <span className="font-mono text-[#0C3B5E]">₹{grouped[cat].subtotal.toLocaleString('en-IN')}</span>
                </div>
              ))}
              {expenses.length === 0 && (
                <p className="text-xs text-[#0C3B5E]/45">No expenses were recorded on this trip.</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CategoryBlock({ category, items, subtotal, onRemove }) {
  const meta = CATEGORY_META[category] || CATEGORY_META.Other;
  const Icon = meta.icon;
  return (
    <div className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-4">
      <div className="flex items-center justify-between mb-2.5">
        <span className="flex items-center gap-2 text-sm font-semibold text-[#0C3B5E]">
          <Icon size={15} style={{ color: meta.color }} /> {category}
        </span>
        <span className="font-mono text-sm font-semibold text-[#0C3B5E]">₹{subtotal.toLocaleString('en-IN')}</span>
      </div>
      <div className="space-y-1">
        {items.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-2 py-1 border-t border-[#0C3B5E]/5 first:border-0 first:pt-0">
            <div className="min-w-0">
              <p className="text-xs text-[#0C3B5E]/75 truncate">{item.name}</p>
              <p className="text-[10px] text-[#0C3B5E]/40">
                {item.source === 'Itinerary' ? 'From Booking Itinerary' : 'Added manually'}
              </p>
            </div>
            <span className="flex items-center gap-2 shrink-0">
              <span className="flex items-center font-mono text-xs text-[#0C3B5E]">
                <IndianRupee size={10} /> {Number(item.amount).toLocaleString('en-IN')}
              </span>
              {item.source === 'Manual' && (
                <button onClick={() => onRemove(item.id)} className="text-[#0C3B5E]/30 hover:text-[#2563EB]">
                  <Trash2 size={12} />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}