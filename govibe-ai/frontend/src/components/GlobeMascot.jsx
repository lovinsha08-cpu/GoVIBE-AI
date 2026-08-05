import { motion } from 'framer-motion';

/**
 * Friendly globe traveler mascot — the app's signature illustration.
 * Rendered as inline SVG so it inherits the app's blue/green "vibe" palette
 * and needs no external image assets.
 */
export default function GlobeMascot({ className = '', floating = true }) {
  const Wrapper = floating ? motion.div : 'div';
  const floatProps = floating
    ? {
        animate: { y: [0, -12, 0] },
        transition: { duration: 4, repeat: Infinity, ease: 'easeInOut' },
      }
    : {};

  return (
    <Wrapper className={className} {...floatProps}>
      <svg viewBox="0 0 320 320" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
        {/* soft ground shadow */}
        <ellipse cx="160" cy="292" rx="76" ry="14" fill="#0C3B5E" opacity="0.08" />

        {/* globe body */}
        <circle cx="160" cy="150" r="92" fill="#2563EB" />
        <circle cx="160" cy="150" r="92" fill="url(#globeShade)" />

        {/* land masses */}
        <path d="M96 96c10-14 30-18 42-8 8 6 6 16-2 20-10 5-8 14 2 18 14 6 10 20-4 24-16 4-20-6-32-4-14 2-22-8-16-20 4-8 2-16 10-30z" fill="#22C55E" />
        <path d="M188 92c12-6 30-2 36 10 5 10-4 18-16 16-10-2-18 6-14 16 5 12-8 22-20 14-10-6-8-18 0-26 6-6 2-14-6-16-12-4-12-10 0-14z" fill="#16A34A" />
        <path d="M150 190c14-4 30 2 34 14 4 10-6 20-18 18-8-2-14 4-12 12 3 10-8 16-16 8-6-6-4-16 2-22 5-5 2-12-6-14-10-3-10-12 0-16z" fill="#22C55E" />

        {/* latitude/longitude lines */}
        <ellipse cx="160" cy="150" rx="92" ry="30" fill="none" stroke="#EAF7EF" strokeOpacity="0.35" strokeWidth="2" />
        <path d="M68 150a92 92 0 0 1 184 0" fill="none" stroke="#EAF7EF" strokeOpacity="0.25" strokeWidth="2" />
        <line x1="160" y1="58" x2="160" y2="242" stroke="#EAF7EF" strokeOpacity="0.25" strokeWidth="2" />

        {/* face */}
        <circle cx="132" cy="146" r="7" fill="#0C3B5E" />
        <circle cx="188" cy="146" r="7" fill="#0C3B5E" />
        <path d="M136 172q24 16 48 0" fill="none" stroke="#0C3B5E" strokeWidth="5" strokeLinecap="round" />
        <circle cx="112" cy="160" r="9" fill="#2563EB" opacity="0.35" />
        <circle cx="208" cy="160" r="9" fill="#2563EB" opacity="0.35" />

        {/* headphones */}
        <path d="M96 138a64 64 0 0 1 128 0" fill="none" stroke="#0C3B5E" strokeWidth="8" strokeLinecap="round" />
        <rect x="84" y="132" width="20" height="34" rx="10" fill="#0C3B5E" />
        <rect x="216" y="132" width="20" height="34" rx="10" fill="#0C3B5E" />

        {/* arms */}
        <path d="M74 190q-24 10-28 34" fill="none" stroke="#2563EB" strokeWidth="10" strokeLinecap="round" />
        <circle cx="44" cy="228" r="11" fill="#DBEAFE" stroke="#0C3B5E" strokeWidth="3" />
        <path d="M246 190q24 10 28 34" fill="none" stroke="#2563EB" strokeWidth="10" strokeLinecap="round" />
        <circle cx="278" cy="228" r="11" fill="#DBEAFE" stroke="#0C3B5E" strokeWidth="3" />

        {/* legs */}
        <path d="M136 236q-6 24 -16 40" fill="none" stroke="#0C3B5E" strokeWidth="10" strokeLinecap="round" />
        <path d="M184 236q6 24 16 40" fill="none" stroke="#0C3B5E" strokeWidth="10" strokeLinecap="round" />
        <ellipse cx="116" cy="280" rx="14" ry="8" fill="#22C55E" />
        <ellipse cx="204" cy="280" rx="14" ry="8" fill="#22C55E" />

        {/* orbiting travel icons */}
        <g opacity="0.9">
          <circle cx="248" cy="86" r="16" fill="#DBEAFE" />
          <path d="M240 86l6-6 10 6-10 6z" fill="#0C3B5E" />
          <circle cx="66" cy="76" r="14" fill="#D1FAE5" />
          <path d="M60 82l4-12 8 4-4 10z" fill="#0C3B5E" />
        </g>

        <defs>
          <radialGradient id="globeShade" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#60A5FA" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#1D4ED8" stopOpacity="0" />
          </radialGradient>
        </defs>
      </svg>
    </Wrapper>
  );
}
