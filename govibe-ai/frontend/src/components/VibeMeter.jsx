import { motion } from 'framer-motion';

// Circular progress "vibe" ring, styled to match GoVIBE's
// blue / green / navy palette (see src/index.css :root vars).
export default function VibeMeter({
  percent = 74,
  label = 'Active Explorer',
  message = "You're peaking! Time to check out those",
  highlight = 'hidden gems',
  messageSuffix = 'in Bali.',
}) {
  const radius = 85;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;

  return (
    <div className="glass-panel rounded-[32px] p-8 flex flex-col items-center justify-center text-center">
      <h3 className="font-display font-bold text-lg text-[#0C3B5E] mb-6">
        Travel Vibe
      </h3>

      <div className="relative flex items-center justify-center w-48 h-48">
        <svg className="w-48 h-48 -rotate-90" viewBox="0 0 200 200">
          <circle
            cx="100"
            cy="100"
            r={radius}
            fill="transparent"
            stroke="#0C3B5E1A"
            strokeWidth="12"
          />
          <motion.circle
            cx="100"
            cy="100"
            r={radius}
            fill="transparent"
            stroke="url(#vibeGradient)"
            strokeWidth="14"
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 1, ease: 'easeInOut' }}
          />
          <defs>
            <linearGradient id="vibeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#2563EB" />
              <stop offset="50%" stopColor="#22C55E" />
              <stop offset="100%" stopColor="#16A34A" />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display font-bold text-4xl text-[#0C3B5E]">
            {percent}%
          </span>
          <span className="font-mono text-[10px] tracking-widest uppercase text-[#0C3B5E]/50 mt-1">
            {label}
          </span>
        </div>
      </div>

      <p className="mt-6 text-sm text-[#0C3B5E]/60 px-2">
        {message}{' '}
        {highlight && <span className="font-bold text-[#16A34A]">{highlight}</span>}{' '}
        {messageSuffix}
      </p>
    </div>
  );
}