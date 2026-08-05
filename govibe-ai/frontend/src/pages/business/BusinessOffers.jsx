import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Gift, ImagePlus, Trash2, CheckCircle2, Power, Pencil, Loader2 } from 'lucide-react';
import Field, { Select } from '../../components/Field';
import BusinessPageHeader from '../../components/BusinessPageHeader';
import { api } from '../../lib/api';

const CATEGORIES = ['Food', 'Stay', 'Activity', 'Shopping', 'Transport', 'Wellness'];

const EMPTY_FORM = {
  title: '',
  description: '',
  discountType: 'percent',
  discountValue: '',
  validFrom: '',
  validUntil: '',
  category: '',
  image: '',
};

export default function BusinessOffers() {
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const loadOffers = () => {
    setLoading(true);
    setLoadError('');
    api.getMyOffers()
      .then((res) => setOffers(res.offers || []))
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadOffers();
  }, []);

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleImagePick = () => {
    // Placeholder upload — no backend file storage yet.
    setForm((f) => ({ ...f, image: 'placeholder' }));
  };

  const startEdit = (offer) => {
    setEditingId(offer.id);
    setForm({
      title: offer.title || '',
      description: offer.description || '',
      discountType: offer.discountType || 'percent',
      discountValue: offer.discountValue ?? '',
      validFrom: offer.validFrom || '',
      validUntil: offer.validUntil || '',
      category: offer.category || '',
      image: offer.image || '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!form.title.trim() || !form.discountValue || !form.category) {
      setError('Please fill in the offer title, discount, and category.');
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        const res = await api.updateOffer(editingId, form);
        setOffers((prev) => prev.map((o) => (o.id === editingId ? res.offer : o)));
      } else {
        const res = await api.createOffer(form);
        setOffers((prev) => [res.offer, ...prev]);
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.deleteOffer(id);
      setOffers((prev) => prev.filter((o) => o.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleToggle = async (offer) => {
    try {
      const res = await api.setOfferStatus(offer.id, !offer.isActive);
      setOffers((prev) => prev.map((o) => (o.id === offer.id ? res.offer : o)));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <main className="min-h-screen bg-[#EAF7EF] px-6 py-10">
      <section className="max-w-3xl mx-auto">
        <BusinessPageHeader
          eyebrow="Offers"
          title={editingId ? 'Edit offer' : 'Add a new offer'}
          subtitle="Create discounts and experiences travellers will spot on your listing."
        />

        <form
          onSubmit={handleSubmit}
          className="rounded-3xl bg-white border border-[#0C3B5E]/10 p-6 md:p-8"
        >
          <Field
            label="Offer title"
            required
            value={form.title}
            onChange={update('title')}
            placeholder="e.g. Weekend Brunch Special"
          />

          <label className="block mb-4">
            <span className="block text-sm font-medium text-[#0C3B5E]/80 mb-1.5">Description</span>
            <textarea
              value={form.description}
              onChange={update('description')}
              rows={3}
              placeholder="What does this offer include?"
              className="w-full px-4 py-3 rounded-xl border border-[#0C3B5E]/15 bg-white text-[#0C3B5E]
                         placeholder:text-[#0C3B5E]/35 focus:outline-none focus:ring-2 focus:ring-[#2563EB]/40 focus:border-[#2563EB] transition-shadow resize-none"
            />
          </label>

          <div className="grid grid-cols-2 gap-4">
            <Select label="Discount type" value={form.discountType} onChange={update('discountType')}>
              <option value="percent">Percentage (%)</option>
              <option value="flat">Flat amount (₹)</option>
            </Select>

            <Field
              label={form.discountType === 'percent' ? 'Discount (%)' : 'Discount (₹)'}
              required
              type="number"
              min="0"
              value={form.discountValue}
              onChange={update('discountValue')}
              placeholder={form.discountType === 'percent' ? 'e.g. 20' : 'e.g. 200'}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Valid from" type="date" value={form.validFrom} onChange={update('validFrom')} />
            <Field label="Valid until" type="date" value={form.validUntil} onChange={update('validUntil')} />
          </div>

          <Select label="Category" required value={form.category} onChange={update('category')}>
            <option value="">Select one</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>

          <label className="block mb-6">
            <span className="block text-sm font-medium text-[#0C3B5E]/80 mb-1.5">Offer image</span>
            <button
              type="button"
              onClick={handleImagePick}
              className="w-full flex items-center justify-center gap-2 px-4 py-6 rounded-xl border-2 border-dashed border-[#0C3B5E]/15
                         text-[#0C3B5E]/50 hover:border-[#2563EB]/40 hover:text-[#2563EB] transition-colors"
            >
              <ImagePlus size={20} />
              {form.image ? 'Image selected' : 'Upload image'}
            </button>
          </label>

          {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-3.5 rounded-xl bg-[#0C3B5E] text-white font-semibold hover:bg-[#0C3B5E]/90 transition-colors
                         flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Gift size={18} />}
              {editingId ? 'Save changes' : 'Save offer'}
            </button>

            {editingId && (
              <button
                type="button"
                onClick={cancelEdit}
                className="px-4 py-3.5 rounded-xl border border-[#0C3B5E]/15 text-[#0C3B5E]/70 hover:bg-[#E6F7ED] transition-colors"
              >
                Cancel
              </button>
            )}
          </div>

          <AnimatePresence>
            {saved && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="mt-4 flex items-center gap-2 text-sm font-medium text-[#15803D] bg-[#DCFCE7] rounded-xl px-4 py-3"
              >
                <CheckCircle2 size={16} /> Offer saved successfully.
              </motion.div>
            )}
          </AnimatePresence>
        </form>

        {/* Existing offers */}
        <div className="mt-10">
          <h2 className="font-display font-bold text-2xl text-[#0C3B5E] mb-4">Your offers</h2>

          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="animate-spin text-[#2563EB]" size={24} />
            </div>
          ) : loadError ? (
            <p className="text-sm text-red-500">{loadError}</p>
          ) : offers.length === 0 ? (
            <p className="text-[#0C3B5E]/50 text-sm">No offers yet — add your first one above.</p>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {offers.map((offer) => (
                <motion.div
                  layout
                  key={offer.id}
                  className="rounded-2xl bg-white border border-[#0C3B5E]/10 p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-[#DBEAFE] text-[#2563EB]">
                          {offer.category || 'General'}
                        </span>
                        <span
                          className="text-[10px] font-semibold px-2.5 py-1 rounded-full"
                          style={{
                            backgroundColor: offer.isActive ? '#DCFCE7' : '#E6F7ED',
                            color: offer.isActive ? '#15803D' : '#0C3B5E',
                          }}
                        >
                          {offer.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                      <h3 className="font-display font-bold text-lg text-[#0C3B5E] mt-2">{offer.title}</h3>
                      <p className="text-[#0C3B5E]/60 text-sm mt-1 leading-relaxed">{offer.description || 'No description added.'}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#0C3B5E]/50 mt-4">
                    <span>
                      {offer.discountValue
                        ? `${offer.discountType === 'percent' ? `${offer.discountValue}% off` : `₹${offer.discountValue} off`}`
                        : 'No discount set'}
                    </span>
                    {(offer.validFrom || offer.validUntil) && (
                      <span>{offer.validFrom || '—'} to {offer.validUntil || '—'}</span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 mt-4">
                    <button
                      onClick={() => startEdit(offer)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border border-[#0C3B5E]/15 text-sm font-medium text-[#0C3B5E]/80 hover:bg-[#E6F7ED] transition-colors"
                    >
                      <Pencil size={14} /> Edit
                    </button>
                    <button
                      onClick={() => handleToggle(offer)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border border-[#0C3B5E]/15 text-sm font-medium text-[#0C3B5E]/80 hover:bg-[#E6F7ED] transition-colors"
                    >
                      <Power size={14} /> {offer.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => handleDelete(offer.id)}
                      className="px-3 py-2.5 rounded-lg text-[#0C3B5E]/40 hover:text-[#2563EB] hover:bg-[#DBEAFE] transition-colors shrink-0"
                      aria-label="Delete offer"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}