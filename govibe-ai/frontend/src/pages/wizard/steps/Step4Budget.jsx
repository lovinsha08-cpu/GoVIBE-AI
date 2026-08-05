export default function Step4Budget({ data, update }) {
  return (
    <div>
      <h2 className="font-display font-bold text-2xl text-[#0C3B5E] mb-1">What's your budget?</h2>
      <p className="text-sm text-[#0C3B5E]/55 mb-6">Enter a total in ₹ — the AI itinerary will be planned to fit within it.</p>

      <label className="block mb-5">
        <span className="block text-sm font-medium text-[#0C3B5E]/80 mb-1.5">Total budget (₹)</span>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#0C3B5E]/50 font-medium">₹</span>
          <input
            type="number"
            min="0"
            value={data.total_budget_inr || ''}
            onChange={(e) => update({ total_budget_inr: Number(e.target.value) })}
            placeholder="20000"
            className="w-full pl-8 pr-4 py-3 rounded-xl border border-[#0C3B5E]/15 bg-white text-[#0C3B5E]
                       focus:outline-none focus:ring-2 focus:ring-[#2563EB]/40 focus:border-[#2563EB]"
          />
        </div>
      </label>
    </div>
  );
}