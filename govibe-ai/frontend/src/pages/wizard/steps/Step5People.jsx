import { Minus, Plus } from 'lucide-react';

const GROUPS = [
  { key: 'adults', label: 'Adults', desc: 'Age 18–59' },
  { key: 'kids', label: 'Kids', desc: 'Under 18' },
  { key: 'elderly', label: 'Elderly', desc: 'Age 60+' },
  { key: 'specially_abled', label: 'Specially-abled', desc: 'Any age, needs accessibility' },
];

export default function Step5People({ data, update }) {
  const adjust = (key, delta) => {
    const current = data[key] ?? (key === 'adults' ? 1 : 0);
    const next = Math.max(key === 'adults' ? 1 : 0, current + delta);
    update({ [key]: next });
  };

  return (
    <div>
      <h2 className="font-display font-bold text-2xl text-[#0C3B5E] mb-1">Who's traveling?</h2>
      <p className="text-sm text-[#0C3B5E]/55 mb-6">Helps us estimate group costs and accessibility needs accurately.</p>

      <div className="space-y-3">
        {GROUPS.map((g) => (
          <div key={g.key} className="flex items-center justify-between p-4 rounded-xl bg-white border border-[#0C3B5E]/10">
            <div>
              <p className="text-sm font-medium text-[#0C3B5E]">{g.label}</p>
              <p className="text-xs text-[#0C3B5E]/50">{g.desc}</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => adjust(g.key, -1)}
                className="w-8 h-8 rounded-full border border-[#0C3B5E]/15 flex items-center justify-center text-[#0C3B5E]/60"
              >
                <Minus size={14} />
              </button>
              <span className="w-6 text-center font-mono font-semibold text-[#0C3B5E]">
                {data[g.key] ?? (g.key === 'adults' ? 1 : 0)}
              </span>
              <button
                type="button"
                onClick={() => adjust(g.key, 1)}
                className="w-8 h-8 rounded-full bg-[#0C3B5E] flex items-center justify-center text-white"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
