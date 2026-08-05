export default function Field({ label, error, ...props }) {
  return (
    <label className="block mb-4">
      <span className="block text-sm font-medium text-[#1A1B3A]/80 mb-1.5">{label}</span>
      <input
        {...props}
        className="w-full px-4 py-3 rounded-xl border border-[#1A1B3A]/15 bg-white
                   text-[#1A1B3A] placeholder:text-[#1A1B3A]/35
                   focus:outline-none focus:ring-2 focus:ring-[#FF6B5B]/40 focus:border-[#FF6B5B]
                   transition-shadow"
      />
      {error && <span className="block text-xs text-[#FF6B5B] mt-1">{error}</span>}
    </label>
  );
}

export function Select({ label, error, children, ...props }) {
  return (
    <label className="block mb-4">
      <span className="block text-sm font-medium text-[#1A1B3A]/80 mb-1.5">{label}</span>
      <select
        {...props}
        className="w-full px-4 py-3 rounded-xl border border-[#1A1B3A]/15 bg-white
                   text-[#1A1B3A] focus:outline-none focus:ring-2 focus:ring-[#FF6B5B]/40 focus:border-[#FF6B5B]
                   transition-shadow"
      >
        {children}
      </select>
      {error && <span className="block text-xs text-[#FF6B5B] mt-1">{error}</span>}
    </label>
  );
}