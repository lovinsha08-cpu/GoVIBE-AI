import { Leaf, Beef, Sprout, Fish, Utensils } from 'lucide-react';

const FOOD_OPTIONS = [
  { key: 'veg', label: 'Vegetarian', icon: Leaf },
  { key: 'non_veg', label: 'Non-vegetarian', icon: Beef },
  { key: 'vegan', label: 'Vegan', icon: Sprout },
  { key: 'seafood', label: 'Seafood', icon: Fish },
  { key: 'multi_cuisine', label: 'Open to anything', icon: Utensils },
];

export default function Step7Food({ data, update }) {
  const prefs = data.food_preferences || [];

  const toggle = (key) => {
    const next = prefs.includes(key) ? prefs.filter((p) => p !== key) : [...prefs, key];
    update({ food_preferences: next });
  };

  return (
    <div>
      <h2 className="font-display font-bold text-2xl text-[#0C3B5E] mb-1">What do you eat?</h2>
      <p className="text-sm text-[#0C3B5E]/55 mb-6">Select all that apply — we'll match nearby eating spots.</p>

      <div className="grid grid-cols-2 gap-2">
        {FOOD_OPTIONS.map((f) => {
          const selected = prefs.includes(f.key);
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => toggle(f.key)}
              className={`flex items-center gap-3 px-4 py-3.5 rounded-xl border text-sm font-medium transition-colors ${
                selected ? 'bg-[#2563EB]/10 border-[#2563EB] text-[#2563EB]' : 'bg-white border-[#0C3B5E]/10 text-[#0C3B5E]/70'
              }`}
            >
              <f.icon size={18} />
              {f.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
