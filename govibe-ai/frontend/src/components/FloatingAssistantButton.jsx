import { Bot } from 'lucide-react';

// Fixed bottom-right launcher, adapted from the uploaded template's
// floating chat button. Reuses the project's indigo/teal palette.
export default function FloatingAssistantButton({ onClick, tooltip = 'Need trip ideas? Ask VibeBot!' }) {
  return (
    <button
      onClick={onClick}
      className="fixed bottom-8 right-8 z-50 w-16 h-16 bg-[#0C3B5E] rounded-full shadow-2xl flex items-center justify-center hover:scale-110 spring-active transition-all group"
    >
      <div className="absolute -top-12 right-0 bg-white px-4 py-2 rounded-2xl shadow-lg border border-[#0C3B5E]/10 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <p className="text-xs font-bold text-[#0C3B5E] font-mono">{tooltip}</p>
      </div>
      <Bot className="text-[#16A34A]" size={28} />
    </button>
  );
}