import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Compass } from 'lucide-react';

const NAV_LINKS = [
  { label: 'Explore', to: '/explore' },
  { label: 'Planner', to: '/trip/new' },
  { label: 'Community', to: null }, // no route yet — shown, not wired
];

export default function Navbar({ active = 'Explore' }) {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);

  return (
    <header className="sticky top-0 z-40 bg-[#EAF7EF]/90 backdrop-blur-md border-b border-[#0C3B5E]/8">
      <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-4">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-[#2563EB] flex items-center justify-center rotate-[-8deg]">
            <Compass className="text-white" size={18} strokeWidth={2.5} />
          </div>
          <span className="font-display font-bold text-xl tracking-tight text-[#0C3B5E]">
            GoVIBE AI
          </span>
        </Link>

        {/* Nav links */}
        <nav className="hidden md:flex items-center gap-8">
          {NAV_LINKS.map((link) => {
            const isActive = link.label === active;
            const className = `relative text-sm font-semibold transition-colors ${
              isActive ? 'text-[#2563EB]' : 'text-[#0C3B5E]/60 hover:text-[#0C3B5E]'
            } ${!link.to ? 'cursor-default' : ''}`;

            const content = (
              <>
                {link.label}
                {isActive && (
                  <motion.span
                    layoutId="nav-underline"
                    className="absolute -bottom-1 left-0 right-0 h-0.5 rounded-full bg-[#2563EB]"
                  />
                )}
              </>
            );

            return link.to ? (
              <Link key={link.label} to={link.to} className={className}>
                {content}
              </Link>
            ) : (
              <span key={link.label} className={className}>
                {content}
              </span>
            );
          })}
        </nav>

        {/* CTA */}
        <button
          onClick={() => navigate('/traveler')}
          className="bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-bold px-5 py-2.5 rounded-full shadow-lg shadow-[#2563EB]/20 transition-colors spring-active"
        >
          Start Your Adventure
        </button>
      </div>
    </header>
  );
}
