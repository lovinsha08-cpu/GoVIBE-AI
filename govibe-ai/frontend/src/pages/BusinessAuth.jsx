import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Store, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AuthLayout from '../components/AuthLayout';
import Field, { Select } from '../components/Field';
import { api } from '../lib/api';

const MODES = { LOGIN: 'login', SIGNUP: 'signup' };

const BUSINESS_MODELS = ['Restaurant / Café', 'Homestay / Hotel', 'Tour Operator', 'Activity / Experience', 'Retail / Shopping', 'Transport Service', 'Other'];
const CATEGORIES = ['Food', 'Stay', 'Activity', 'Shopping', 'Transport', 'Wellness'];

export default function BusinessAuth() {
  const [mode, setMode] = useState(MODES.LOGIN);
  const [form, setForm] = useState({
    email: '', password: '', businessName: '', businessModel: '',
    location: '', category: '', description: '', phone: '',
  });
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
        await api.businessSignup(form);
        setMessage('Registration submitted! Your listing will be reviewed before it goes live.');
        setMode(MODES.LOGIN);
      } else {
        const res = await api.login({ email: form.email, password: form.password });
        localStorage.setItem('govibe_session', JSON.stringify(res.session));
        navigate('/business/dashboard');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      accent="#16A34A"
      tint="#F0FBFA"
      side={
        <>
          <Store size={48} className="mx-auto mb-6 opacity-90" />
          <h2 className="font-display font-bold text-3xl mb-3">Reach travelers already nearby</h2>
          <p className="text-white/80 text-sm leading-relaxed max-w-xs mx-auto">
            Get listed in itineraries, post offers, and track what's actually driving visits — all from one dashboard.
          </p>
        </>
      }
    >
      <div className="w-10 h-10 rounded-2xl bg-[#16A34A]/15 flex items-center justify-center mb-5">
        <Store className="text-[#16A34A]" size={20} />
      </div>

      <h1 className="font-display font-bold text-2xl text-[#0C3B5E] mb-1">
        {mode === MODES.LOGIN ? 'Business login' : 'Register your business'}
      </h1>
      <p className="text-sm text-[#0C3B5E]/55 mb-6">
        {mode === MODES.LOGIN ? 'Access your dashboard and offers.' : 'A few details so travelers can find you.'}
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
              <Field label="Business name" required value={form.businessName} onChange={update('businessName')} placeholder="e.g. Backwater Bites Café" />

              <Select label="Business model" required value={form.businessModel} onChange={update('businessModel')}>
                <option value="">Select one</option>
                {BUSINESS_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>

              <Select label="Category" required value={form.category} onChange={update('category')}>
                <option value="">Select one</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>

              <Field label="Location" required value={form.location} onChange={update('location')} placeholder="City, area" />
              <Field label="Phone" type="tel" value={form.phone} onChange={update('phone')} placeholder="+91 98765 43210" />

              <label className="block mb-4">
                <span className="block text-sm font-medium text-[#0C3B5E]/80 mb-1.5">Description</span>
                <textarea
                  value={form.description}
                  onChange={update('description')}
                  placeholder="What makes this place worth a stop?"
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl border border-[#0C3B5E]/15 bg-white text-[#0C3B5E]
                             placeholder:text-[#0C3B5E]/35 focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40 focus:border-[#16A34A] transition-shadow resize-none"
                />
              </label>
            </>
          )}

          <Field label="Email" type="email" required value={form.email} onChange={update('email')} placeholder="business@example.com" />
          <Field label="Password" type="password" required value={form.password} onChange={update('password')} placeholder="••••••••" minLength={6} />

          {error && <p className="text-sm text-red-500 mb-4">{error}</p>}
          {message && <p className="text-sm text-[#16A34A] mb-4">{message}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 rounded-xl bg-[#0C3B5E] text-white font-semibold
                       flex items-center justify-center gap-2 hover:bg-[#0C3B5E]/90 transition-colors disabled:opacity-60"
          >
            {loading && <Loader2 size={18} className="animate-spin" />}
            {mode === MODES.LOGIN ? 'Log in' : 'Register business'}
          </button>

          {mode === MODES.SIGNUP && (
            <p className="text-xs text-[#0C3B5E]/45 mt-3 text-center">
              Listings go through a verification check before appearing to travelers.
            </p>
          )}
        </motion.form>
      </AnimatePresence>

      <div className="mt-6 text-center text-sm text-[#0C3B5E]/60">
        {mode === MODES.LOGIN ? (
          <>New business? <button onClick={() => setMode(MODES.SIGNUP)} className="text-[#16A34A] font-semibold">Register here</button></>
        ) : (
          <>Already registered? <button onClick={() => setMode(MODES.LOGIN)} className="text-[#16A34A] font-semibold">Log in</button></>
        )}
      </div>
    </AuthLayout>
  );
}
