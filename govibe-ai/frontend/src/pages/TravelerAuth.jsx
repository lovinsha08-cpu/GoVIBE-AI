import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Backpack, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AuthLayout from '../components/AuthLayout';
import Field from '../components/Field';
import { api } from '../lib/api';

const MODES = { LOGIN: 'login', SIGNUP: 'signup', FORGOT: 'forgot' };

export default function TravelerAuth() {
  const [mode, setMode] = useState(MODES.LOGIN);
  const [form, setForm] = useState({ email: '', password: '', fullName: '', phone: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const navigate = useNavigate();

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      if (mode === MODES.SIGNUP) {
        await api.travelerSignup(form);
        setMessage('Account created! You can log in now.');
        setMode(MODES.LOGIN);
      } else if (mode === MODES.LOGIN) {
        const res = await api.login({ email: form.email, password: form.password });
        localStorage.setItem('govibe_session', JSON.stringify(res.session));
        navigate('/dashboard');
      } else if (mode === MODES.FORGOT) {
        await api.forgotPassword({ email: form.email });
        setMessage('If that email exists, a reset link has been sent.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      accent="#2563EB"
      tint="#EAF7EF"
      side={
        <>
          <Backpack size={48} className="mx-auto mb-6 opacity-90" />
          <h2 className="font-display font-bold text-3xl mb-3">Plan your next trip</h2>
          <p className="text-white/80 text-sm leading-relaxed max-w-xs mx-auto">
            Hidden gems, live conditions, and a budget that adjusts itself — all in one place.
          </p>
        </>
      }
    >
      <div className="w-10 h-10 rounded-2xl bg-[#2563EB]/15 flex items-center justify-center mb-5">
        <Backpack className="text-[#2563EB]" size={20} />
      </div>

      <h1 className="font-display font-bold text-2xl text-[#0C3B5E] mb-1">
        {mode === MODES.LOGIN && 'Welcome back'}
        {mode === MODES.SIGNUP && 'Create your account'}
        {mode === MODES.FORGOT && 'Reset your password'}
      </h1>
      <p className="text-sm text-[#0C3B5E]/55 mb-6">
        {mode === MODES.LOGIN && 'Log in to pick up where you left off.'}
        {mode === MODES.SIGNUP && 'Takes less than a minute.'}
        {mode === MODES.FORGOT && "We'll email you a reset link."}
      </p>

      <AnimatePresence mode="wait">
        <motion.form
          key={mode}
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -8 }}
          transition={{ duration: 0.2 }}
          onSubmit={handleSubmit}
        >
          {mode === MODES.SIGNUP && (
            <>
              <Field label="Full name" required value={form.fullName} onChange={update('fullName')} placeholder="Your name" />
              <Field label="Phone" type="tel" value={form.phone} onChange={update('phone')} placeholder="+91 98765 43210" />
            </>
          )}

          <Field label="Email" type="email" required value={form.email} onChange={update('email')} placeholder="you@example.com" />

          {mode !== MODES.FORGOT && (
            <Field
              label="Password"
              type="password"
              required
              value={form.password}
              onChange={update('password')}
              placeholder="••••••••"
              minLength={6}
            />
          )}

          {mode === MODES.LOGIN && (
            <button
              type="button"
              onClick={() => { setMode(MODES.FORGOT); setError(''); setMessage(''); }}
              className="text-sm text-[#2563EB] font-medium mb-4 -mt-2 block"
            >
              Forgot password?
            </button>
          )}

          {error && <p className="text-sm text-red-500 mb-4">{error}</p>}
          {message && <p className="text-sm text-[#16A34A] mb-4">{message}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 rounded-xl bg-[#0C3B5E] text-white font-semibold
                       flex items-center justify-center gap-2 hover:bg-[#0C3B5E]/90 transition-colors disabled:opacity-60"
          >
            {loading && <Loader2 size={18} className="animate-spin" />}
            {mode === MODES.LOGIN && 'Log in'}
            {mode === MODES.SIGNUP && 'Create account'}
            {mode === MODES.FORGOT && 'Send reset link'}
          </button>
        </motion.form>
      </AnimatePresence>

      <div className="mt-6 text-center text-sm text-[#0C3B5E]/60">
        {mode === MODES.LOGIN && (
          <>New here? <button onClick={() => setMode(MODES.SIGNUP)} className="text-[#2563EB] font-semibold">Create an account</button></>
        )}
        {mode === MODES.SIGNUP && (
          <>Already have an account? <button onClick={() => setMode(MODES.LOGIN)} className="text-[#2563EB] font-semibold">Log in</button></>
        )}
        {mode === MODES.FORGOT && (
          <>Remembered it? <button onClick={() => setMode(MODES.LOGIN)} className="text-[#2563EB] font-semibold">Back to login</button></>
        )}
      </div>
    </AuthLayout>
  );
}
