import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { INTEREST_CATEGORIES } from '../../../lib/interestCategories';

export default function Step3Interests({ data, update }) {
  const [expanded, setExpanded] = useState(null);
  const interests = data.interests || [];

  const getCategoryEntry = (slug) => interests.find((i) => i.category === slug);

  const toggleCategory = (slug) => {
    setExpanded(expanded === slug ? null : slug);
  };

  const toggleSubcategory = (categorySlug, sub) => {
    const existing = getCategoryEntry(categorySlug);
    let next;
    if (!existing) {
      next = [...interests, { category: categorySlug, subcategories: [sub] }];
    } else {
      const has = existing.subcategories.includes(sub);
      const updatedSubs = has
        ? existing.subcategories.filter((s) => s !== sub)
        : [...existing.subcategories, sub];
      if (updatedSubs.length === 0) {
        next = interests.filter((i) => i.category !== categorySlug);
      } else {
        next = interests.map((i) => (i.category === categorySlug ? { ...i, subcategories: updatedSubs } : i));
      }
    }
    update({ interests: next });
  };

  const totalSelected = interests.reduce((sum, i) => sum + i.subcategories.length, 0);

  return (
    <div>
      <h2 className="font-display font-bold text-2xl text-[#1A1B3A] mb-1">What are you into?</h2>
      <p className="text-sm text-[#1A1B3A]/55 mb-6">Pick as many categories and subcategories as you like.</p>

      <div className="space-y-2">
        {INTEREST_CATEGORIES.map((cat) => {
          const entry = getCategoryEntry(cat.slug);
          const isOpen = expanded === cat.slug;
          const count = entry?.subcategories.length || 0;

          return (
            <div key={cat.slug} className="rounded-xl border border-[#1A1B3A]/10 bg-white overflow-hidden">
              <button
                type="button"
                onClick={() => toggleCategory(cat.slug)}
                className="w-full flex items-center justify-between px-4 py-3.5"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-[#1A1B3A]">
                  {cat.emoji && <span aria-hidden="true">{cat.emoji}</span>}
                  {cat.label}
                  {count > 0 && (
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded-full bg-[#FF6B5B]/15 text-[#FF6B5B]">{count}</span>
                  )}
                </span>
                <ChevronDown size={18} className={`text-[#1A1B3A]/40 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
              </button>

              {isOpen && (
                <div className="px-4 pb-4 flex flex-wrap gap-2">
                  {cat.subcategories.map((sub) => {
                    const selected = entry?.subcategories.includes(sub);
                    return (
                      <button
                        key={sub}
                        type="button"
                        onClick={() => toggleSubcategory(cat.slug, sub)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                          selected
                            ? 'bg-[#FF6B5B] border-[#FF6B5B] text-white'
                            : 'bg-transparent border-[#1A1B3A]/15 text-[#1A1B3A]/70'
                        }`}
                      >
                        {sub}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {totalSelected === 0 && (
        <p className="text-xs text-[#1A1B3A]/40 mt-3">Select at least one to continue.</p>
      )}
    </div>
  );
}