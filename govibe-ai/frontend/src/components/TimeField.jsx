import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';

// 12 hour labels placed around the dial, in clock order starting at 12 (top).
const HOUR_MARKS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
// 12 minute marks at 5-minute increments, same dial positions as the hours.
const MINUTE_MARKS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

const CENTER = 110;
const NUMBER_RADIUS = 82;

/** Position of dial index 0..11 (0 = 12 o'clock / top, going clockwise). */
function polarPoint(index) {
  const angle = (index * 30 - 90) * (Math.PI / 180);
  return {
    x: CENTER + NUMBER_RADIUS * Math.cos(angle),
    y: CENTER + NUMBER_RADIUS * Math.sin(angle),
  };
}

/**
 * Splits a stored 24-hour "HH:MM" string (railway time) into 12-hour parts,
 * so the clock face always reads in familiar Indian format (e.g. "6:30 PM")
 * no matter what the browser's locale would otherwise default to.
 */
function to12Hour(value) {
  if (!value) return { hour: '', minute: '', period: 'AM' };
  const [hStr, mStr] = value.split(':');
  let h = parseInt(hStr, 10);
  const period = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return { hour: String(h), minute: mStr || '00', period };
}

/**
 * Combines 12-hour parts back into the 24-hour "HH:MM" string that the rest
 * of the app — and the backend, which parses this with `.split(':')` — expects.
 * Keeping the stored value in this format means no backend changes are needed.
 */
function to24Hour(hour, minute, period) {
  let h = parseInt(hour, 10) % 12;
  if (period === 'PM') h += 12;
  return `${String(h).padStart(2, '0')}:${minute}`;
}

export default function TimeField({ label, value, onChange, required }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('hour'); // 'hour' | 'minute' — which ring the dial shows
  const containerRef = useRef(null);

  const { hour, minute, period } = to12Hour(value);

  // Close the dial when clicking anywhere outside it.
  useEffect(() => {
    if (!open) return;
    const handleOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  const openPicker = () => {
    setMode('hour');
    setOpen(true);
  };

  // Tapping an hour on the dial fills it in and moves straight to the
  // minute ring — mirrors how native round clock pickers flow.
  const pickHour = (h) => {
    onChange(to24Hour(h, minute || '00', period));
    setMode('minute');
  };

  const pickMinute = (m) => {
    onChange(to24Hour(hour || '12', m, period));
    setOpen(false);
  };

  const pickPeriod = (p) => {
    onChange(to24Hour(hour || '12', minute || '00', p));
  };

  const displayText = value ? `${hour}:${minute} ${period}` : '';
  const selectedHourIndex = hour ? parseInt(hour, 10) % 12 : null;
  const selectedMinuteIndex = minute !== '' ? (Math.round(parseInt(minute, 10) / 5) % 12) : null;
  const activeIndex = mode === 'hour' ? selectedHourIndex : selectedMinuteIndex;
  const handPoint = activeIndex !== null ? polarPoint(activeIndex) : null;

  return (
    <div className="relative mb-4" ref={containerRef}>
      <span className="block text-sm font-medium text-[#0C3B5E]/80 mb-1.5">
        {label}
        {required && <span className="text-[#2563EB]"> *</span>}
      </span>

      <button
        type="button"
        onClick={openPicker}
        className={`w-full flex items-center gap-2.5 pl-3.5 pr-4 py-3 rounded-xl border text-left
          bg-white hover:border-[#0C3B5E]/25 transition-all duration-150
          focus:outline-none focus:ring-2 focus:ring-[#2563EB]/40
          ${open ? 'border-[#2563EB] ring-2 ring-[#2563EB]/40' : 'border-[#0C3B5E]/15'}`}
      >
        <Clock size={17} strokeWidth={2} className="text-[#0C3B5E]/40 shrink-0" />
        <span className={displayText ? 'text-[#0C3B5E]' : 'text-[#0C3B5E]/35'}>
          {displayText || 'Select time'}
        </span>
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-[260px] rounded-2xl bg-white border border-[#0C3B5E]/10 shadow-xl p-4">
          {/* Digital readout + AM/PM toggle */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-baseline gap-1 font-mono text-2xl font-semibold text-[#0C3B5E]">
              <button
                type="button"
                onClick={() => setMode('hour')}
                className={`px-1.5 rounded-lg transition-colors ${mode === 'hour' ? 'bg-[#2563EB]/15 text-[#2563EB]' : ''}`}
              >
                {hour || '--'}
              </button>
              <span>:</span>
              <button
                type="button"
                onClick={() => setMode('minute')}
                className={`px-1.5 rounded-lg transition-colors ${mode === 'minute' ? 'bg-[#2563EB]/15 text-[#2563EB]' : ''}`}
              >
                {minute || '--'}
              </button>
            </div>
            <div className="flex flex-col rounded-lg overflow-hidden border border-[#0C3B5E]/15">
              <button
                type="button"
                onClick={() => pickPeriod('AM')}
                className={`px-2.5 py-1 text-xs font-semibold transition-colors ${period === 'AM' ? 'bg-[#0C3B5E] text-white' : 'bg-white text-[#0C3B5E]/60'}`}
              >
                AM
              </button>
              <button
                type="button"
                onClick={() => pickPeriod('PM')}
                className={`px-2.5 py-1 text-xs font-semibold transition-colors ${period === 'PM' ? 'bg-[#0C3B5E] text-white' : 'bg-white text-[#0C3B5E]/60'}`}
              >
                PM
              </button>
            </div>
          </div>

          {/* Round clock face */}
          <svg viewBox="0 0 220 220" className="w-full h-auto select-none">
            <circle cx={CENTER} cy={CENTER} r={98} fill="#0C3B5E0D" />
            <circle cx={CENTER} cy={CENTER} r={3.5} fill="#0C3B5E" />

            {handPoint && (
              <line
                x1={CENTER}
                y1={CENTER}
                x2={handPoint.x}
                y2={handPoint.y}
                stroke="#2563EB"
                strokeWidth={2}
              />
            )}

            {mode === 'hour'
              ? HOUR_MARKS.map((h) => {
                  const idx = h % 12;
                  const { x, y } = polarPoint(idx);
                  const active = selectedHourIndex === idx;
                  return (
                    <g key={h} onClick={() => pickHour(h)} className="cursor-pointer">
                      <circle cx={x} cy={y} r={16} fill={active ? '#2563EB' : 'transparent'} />
                      <text
                        x={x}
                        y={y}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={15}
                        fontWeight={active ? 700 : 500}
                        fill={active ? '#fff' : '#0C3B5E'}
                      >
                        {h}
                      </text>
                    </g>
                  );
                })
              : MINUTE_MARKS.map((m, idx) => {
                  const { x, y } = polarPoint(idx);
                  const active = selectedMinuteIndex === idx;
                  const label = String(m).padStart(2, '0');
                  return (
                    <g key={m} onClick={() => pickMinute(label)} className="cursor-pointer">
                      <circle cx={x} cy={y} r={16} fill={active ? '#2563EB' : 'transparent'} />
                      <text
                        x={x}
                        y={y}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={15}
                        fontWeight={active ? 700 : 500}
                        fill={active ? '#fff' : '#0C3B5E'}
                      >
                        {label}
                      </text>
                    </g>
                  );
                })}
          </svg>

          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-3 w-full py-2 rounded-xl bg-[#0C3B5E] text-white text-sm font-medium"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}