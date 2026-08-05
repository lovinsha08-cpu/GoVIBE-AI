const STEPS = ['Destination', 'Duration', 'Interests', 'Trip Style', 'Budget', 'People', 'Transport', 'Food'];

export default function WizardProgress({ current }) {
  return (
    <div className="flex items-center gap-1.5 mb-8">
      {STEPS.map((label, i) => (
        <div key={label} className="flex-1">
          <div
            className={`h-1.5 rounded-full transition-colors ${
              i <= current ? 'bg-[#2563EB]' : 'bg-[#0C3B5E]/10'
            }`}
          />
        </div>
      ))}
      <span className="ml-3 font-mono text-xs text-[#0C3B5E]/50 whitespace-nowrap">
        {current + 1}/{STEPS.length}
      </span>
    </div>
  );
}

export { STEPS };