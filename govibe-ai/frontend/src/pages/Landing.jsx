import Navbar from '../components/Navbar';
import Hero from '../components/Hero';
import LoginChoice from '../components/LoginChoice';
import Features from '../components/Features';

export default function Landing() {
  return (
    <main className="min-h-screen bg-[#EAF7EF]">
      <Navbar active="Explore" />
      <Hero />
      <LoginChoice />
      <Features />
    </main>
  );
}
