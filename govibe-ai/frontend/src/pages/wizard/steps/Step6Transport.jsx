import { Zap, Wallet, Sofa, Bus, Train, Car, Plane, Bike } from 'lucide-react';

const PRIORITIES = [
  { key: 'fastest', label: 'Fastest', icon: Zap },
  { key: 'cheapest', label: 'Cheapest', icon: Wallet },
  { key: 'comfortable', label: 'Comfortable', icon: Sofa },
];

const MODES = [
  { key: 'bus', label: 'Bus', icon: Bus },
  { key: 'train', label: 'Train', icon: Train },
  { key: 'cab', label: 'Cab', icon: Car },
  { key: 'own_vehicle', label: 'Own vehicle', icon: Car },
  { key: 'flight', label: 'Flight', icon: Plane },
  { key: 'bike', label: 'Bike', icon: Bike },
];

export default function Step6Transport({ data, update }) {
  const modes = data.transport_modes || [];

  const toggleMode = (key) => {
    const next = modes.includes(key) ? modes.filter((m) => m !== key) : [...modes, key];
    update({ transport_modes: next });
  };

  return (
    <div>
      <h2 className="font-display font-bold text-2xl text-[#0C3B5E] mb-1">How do you want to get around?</h2>
      <p className="text-sm text-[#0C3B5E]/55 mb-6">Pick a priority, then whichever modes work for you.</p>

      <p className="text-sm font-medium text-[#0C3B5E]/80 mb-2">Priority</p>
      <div className="grid grid-cols-3 gap-2 mb-6">
        {PRIORITIES.map((p) => {
          const selected = data.transport_priority === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => update({ transport_priority: p.key })}
              className={`flex flex-col items-center gap-1.5 py-4 rounded-xl border text-xs font-medium transition-colors ${
                selected ? 'bg-[#0C3B5E] border-[#0C3B5E] text-white' : 'bg-white border-[#0C3B5E]/10 text-[#0C3B5E]/70'
              }`}
            >
              <p.icon size={20} />
              {p.label}
            </button>
          );
        })}
      </div>

      <p className="text-sm font-medium text-[#0C3B5E]/80 mb-2">Available modes</p>
      <div className="grid grid-cols-3 gap-2">
        {MODES.map((m) => {
          const selected = modes.includes(m.key);
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => toggleMode(m.key)}
              className={`flex flex-col items-center gap-1.5 py-4 rounded-xl border text-xs font-medium transition-colors ${
                selected ? 'bg-[#2563EB]/10 border-[#2563EB] text-[#2563EB]' : 'bg-white border-[#0C3B5E]/10 text-[#0C3B5E]/70'
              }`}
            >
              <m.icon size={20} />
              {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
