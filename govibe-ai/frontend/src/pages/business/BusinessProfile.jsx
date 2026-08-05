import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Store, ImagePlus, CheckCircle2 } from 'lucide-react';
import Field, { Select } from '../../components/Field';
import BusinessPageHeader from '../../components/BusinessPageHeader';
import { getProfile, saveProfile } from '../../lib/businessStore';

const CATEGORIES = ['Food', 'Stay', 'Activity', 'Shopping', 'Transport', 'Wellness'];

export default function BusinessProfile() {
  const [form, setForm] = useState(getProfile);
  const [saved, setSaved] = useState(false);

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleImagePick = () => {
    setForm((f) => ({ ...f, profileImage: 'placeholder' }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    saveProfile(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <main className="min-h-screen bg-[#EAF7EF] px-6 py-10">
      <section className="max-w-3xl mx-auto">
        <BusinessPageHeader
          eyebrow="Profile"
          title="Edit business profile"
          subtitle="Keep your details up to date so travellers know exactly what to expect."
        />

        <form onSubmit={handleSubmit} className="rounded-3xl bg-white border border-[#0C3B5E]/10 p-6 md:p-8">
          <label className="block mb-6">
            <span className="block text-sm font-medium text-[#0C3B5E]/80 mb-1.5">Profile image</span>
            <button
              type="button"
              onClick={handleImagePick}
              className="w-full flex items-center justify-center gap-2 px-4 py-6 rounded-xl border-2 border-dashed border-[#0C3B5E]/15
                         text-[#0C3B5E]/50 hover:border-[#16A34A]/50 hover:text-[#16A34A] transition-colors"
            >
              <ImagePlus size={20} />
              {form.profileImage ? 'Image selected' : 'Upload image'}
            </button>
          </label>

          <div className="grid md:grid-cols-2 gap-x-4">
            <Field label="Business name" required value={form.businessName} onChange={update('businessName')} />
            <Field label="Owner name" required value={form.ownerName} onChange={update('ownerName')} />
          </div>

          <div className="grid md:grid-cols-2 gap-x-4">
            <Field label="Phone number" type="tel" value={form.phone} onChange={update('phone')} />
            <Field label="Email" type="email" required value={form.email} onChange={update('email')} />
          </div>

          <Field label="Address" required value={form.address} onChange={update('address')} />

          <div className="grid md:grid-cols-2 gap-x-4">
            <Select label="Business category" value={form.category} onChange={update('category')}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
            <Field
              label="Opening hours"
              value={form.openingHours}
              onChange={update('openingHours')}
              placeholder="e.g. 9:00 AM – 8:00 PM"
            />
          </div>

          <label className="block mb-6">
            <span className="block text-sm font-medium text-[#0C3B5E]/80 mb-1.5">Business description</span>
            <textarea
              value={form.description}
              onChange={update('description')}
              rows={4}
              className="w-full px-4 py-3 rounded-xl border border-[#0C3B5E]/15 bg-white text-[#0C3B5E]
                         placeholder:text-[#0C3B5E]/35 focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40 focus:border-[#16A34A] transition-shadow resize-none"
            />
          </label>

          <button
            type="submit"
            className="w-full py-3.5 rounded-xl bg-[#0C3B5E] text-white font-semibold hover:bg-[#0C3B5E]/90 transition-colors
                       flex items-center justify-center gap-2"
          >
            <Store size={18} />
            Save changes
          </button>

          <AnimatePresence>
            {saved && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="mt-4 flex items-center gap-2 text-sm font-medium text-[#15803D] bg-[#DCFCE7] rounded-xl px-4 py-3"
              >
                <CheckCircle2 size={16} /> Profile updated successfully.
              </motion.div>
            )}
          </AnimatePresence>
        </form>
      </section>
    </main>
  );
}