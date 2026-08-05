import { Zap, Coffee, Camera, UtensilsCrossed, Users, Wallet, Gem, Sparkles } from 'lucide-react';
import { TRIP_STYLES } from '../../../lib/tripStyles';

const ICONS = { Zap, Coffee, Camera, UtensilsCrossed, Users, Wallet, Gem, Sparkles };

export default function StepTripStyle({ data, update }) {
  return (
    <div>
      <h2 className="font-display font-bold text-2xl text-[#0C3B5E] mb-1">Choose Your Trip Style</h2>
      <p className="text-sm text-[#0C3B5E]/55 mb-6">Pick the one that best matches how you want this trip to feel.</p>

      <div className="grid grid-cols-2 gap-3">
        {TRIP_STYLES.map((style) => {
          const Icon = ICONS[style.icon];
          const selected = data.trip_style === style.slug;
          return (
            <button
              key={style.slug}
              type="button"
              onClick={() => update({ trip_style: style.slug })}
              className={`text-left flex flex-col gap-2 p-4 rounded-xl border transition-colors ${
                selected
                  ? 'bg-[#0C3B5E] border-[#0C3B5E] text-white'
                  : 'bg-white border-[#0C3B5E]/10 text-[#0C3B5E] hover:border-[#2563EB]/40'
              }`}
            >
              <Icon size={20} className={selected ? 'text-[#22C55E]' : 'text-[#2563EB]'} />
              <span className="text-sm font-semibold">{style.label}</span>
              <span className={`text-xs leading-snug ${selected ? 'text-white/70' : 'text-[#0C3B5E]/55'}`}>
                {style.description}
              </span>
            </button>
          );
        })}
      </div>

      {!data.trip_style && (
        <p className="text-xs text-[#0C3B5E]/40 mt-3">Select one to continue.</p>
      )}
    </div>
  );
}