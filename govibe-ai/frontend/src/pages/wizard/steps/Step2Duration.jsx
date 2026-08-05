import { Calendar } from 'lucide-react';
import IconField from '../../../components/IconField';
import TimeField from '../../../components/TimeField';

/**
 * Today's date as a local YYYY-MM-DD string — deliberately NOT
 * `new Date().toISOString().slice(0, 10)`, which reads the date in UTC and
 * shows the wrong "today" for anyone west of UTC (e.g. it'd flip to
 * tomorrow's date at 7pm in India). Building it from local getters keeps
 * "today" correct for whatever timezone the traveler's device is in.
 */
function todayLocalISODate() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default function Step2Duration({ data, update }) {
  const today = todayLocalISODate();

  const handleStartDateChange = (e) => {
    const newStart = e.target.value;
    const updates = { start_date: newStart };

    // If the trip already had an end date and it's now before the new
    // start date, bump it up to match rather than leaving the form in an
    // invalid state the traveler has to notice and fix themselves.
    if (newStart && data.end_date && data.end_date < newStart) {
      updates.end_date = newStart;
    }
    update(updates);
  };

  return (
    <div>
      <h2 className="font-display font-bold text-2xl text-[#0C3B5E] mb-1">When's the trip?</h2>
      <p className="text-sm text-[#0C3B5E]/55 mb-6">Dates, times, and whether you need a place to stay.</p>

      <div className="grid grid-cols-2 gap-3">
        <IconField
          label="Start date"
          type="date"
          icon={Calendar}
          required
          min={today}
          value={data.start_date || ''}
          onChange={handleStartDateChange}
        />
        <IconField
          label="End date"
          type="date"
          icon={Calendar}
          required
          min={data.start_date || today}
          value={data.end_date || ''}
          onChange={(e) => update({ end_date: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <TimeField
          label="Start time"
          value={data.start_time || ''}
          onChange={(val) => update({ start_time: val })}
        />
        <TimeField
          label="End time"
          value={data.end_time || ''}
          onChange={(val) => update({ end_time: val })}
        />
      </div>

      <div className="flex items-center justify-between p-4 rounded-xl bg-white border border-[#0C3B5E]/10 mt-2">
        <div>
          <p className="text-sm font-medium text-[#0C3B5E]">Need accommodation?</p>
          <p className="text-xs text-[#0C3B5E]/50">We'll set aside budget for a place to stay.</p>
        </div>
        <button
          type="button"
          onClick={() => update({ needs_accommodation: !data.needs_accommodation })}
          className={`w-12 h-7 rounded-full relative transition-colors ${
            data.needs_accommodation !== false ? 'bg-[#2563EB]' : 'bg-[#0C3B5E]/15'
          }`}
        >
          <span
            className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-transform ${
              data.needs_accommodation !== false ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
    </div>
  );
}