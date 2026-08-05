import { useRef } from 'react';

/**
 * Like <Field />, but with a leading icon (calendar/clock) — built as its
 * own component rather than extending Field so every other text/select
 * input across the app doesn't pick up icon padding it doesn't need.
 *
 * Passes every other prop straight through to the underlying <input>, so
 * `type="date"` / `type="time"` plus `min`/`max`/`value`/`onChange` all
 * behave exactly like a plain native input — nothing about the stored
 * value format changes, only how it looks and how it's opened.
 */
export default function IconField({ label, icon: Icon, error, ...props }) {
  const inputRef = useRef(null);

  // Clicking anywhere in the field (not just the tiny native icon) opens
  // the browser's picker — nicer parity with dedicated picker components.
  // showPicker() is Chrome/Edge/Safari-current; falls back to a plain
  // focus (which still opens most native pickers) where it's unsupported.
  const openPicker = () => {
    const el = inputRef.current;
    if (!el || el.disabled) return;
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker();
      } catch {
        el.focus();
      }
    } else {
      el.focus();
    }
  };

  return (
    <label className="block mb-4">
      <span className="block text-sm font-medium text-[#0C3B5E]/80 mb-1.5">{label}</span>
      <div className="relative group" onClick={openPicker}>
        {Icon && (
          <Icon
            size={17}
            strokeWidth={2}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2
                       text-[#0C3B5E]/40 transition-colors group-focus-within:text-[#2563EB]"
          />
        )}
        <input
          ref={inputRef}
          {...props}
          className="w-full pl-10 pr-4 py-3 rounded-xl border border-[#0C3B5E]/15 bg-white
                     text-[#0C3B5E] placeholder:text-[#0C3B5E]/35 cursor-pointer
                     hover:border-[#0C3B5E]/25
                     focus:outline-none focus:ring-2 focus:ring-[#2563EB]/40 focus:border-[#2563EB]
                     transition-all duration-150
                     [color-scheme:light]"
        />
      </div>
      {error && <span className="block text-xs text-[#2563EB] mt-1">{error}</span>}
    </label>
  );
}