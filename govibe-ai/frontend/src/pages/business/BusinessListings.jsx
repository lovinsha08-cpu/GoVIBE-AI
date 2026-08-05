import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MapPin, Plus, Pencil, Trash2, Power, X, Store } from 'lucide-react';
import Field, { Select } from '../../components/Field';
import BusinessPageHeader from '../../components/BusinessPageHeader';
import {
  getListings,
  addListing,
  updateListing,
  deleteListing,
  toggleListingStatus,
} from '../../lib/businessStore';

const CATEGORIES = ['Food', 'Stay', 'Activity', 'Shopping', 'Transport', 'Wellness'];

const EMPTY_FORM = { name: '', category: '', address: '', image: '', status: 'Active' };

export default function BusinessListings() {
  const [listings, setListings] = useState(getListings);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const openAddModal = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const openEditModal = (listing) => {
    setEditingId(listing.id);
    setForm({ name: listing.name, category: listing.category, address: listing.address, image: listing.image, status: listing.status });
    setModalOpen(true);
  };

  const closeModal = () => setModalOpen(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.address.trim()) return;

    if (editingId) {
      setListings(updateListing(editingId, form));
    } else {
      setListings(addListing(form));
    }
    setModalOpen(false);
  };

  const handleDelete = (id) => {
    setListings(deleteListing(id));
  };

  const handleToggle = (id) => {
    setListings(toggleListingStatus(id));
  };

  return (
    <main className="min-h-screen bg-[#EAF7EF] px-6 py-10">
      <section className="max-w-5xl mx-auto">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <BusinessPageHeader
            eyebrow="Listings"
            title="Manage listings"
            subtitle="Every location and experience travellers can discover, in one place."
          />

          <button
            onClick={openAddModal}
            className="flex items-center gap-2 px-5 py-3 rounded-xl bg-[#0C3B5E] text-white font-semibold hover:bg-[#0C3B5E]/90 transition-colors shrink-0"
          >
            <Plus size={18} /> Add new listing
          </button>
        </div>

        {listings.length === 0 ? (
          <p className="text-[#0C3B5E]/50 text-sm mt-6">No listings yet — add your first one above.</p>
        ) : (
          <div className="grid md:grid-cols-2 gap-5 mt-4">
            {listings.map((listing) => (
              <motion.div
                layout
                key={listing.id}
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-3xl bg-white border border-[#0C3B5E]/10 overflow-hidden"
              >
                <div className="h-28 bg-gradient-to-br from-[#0C3B5E] to-[#16A34A]/70 flex items-center justify-between p-5 relative">
                  <div className="flex items-center gap-2 text-white">
                    <Store size={18} />
                    <span className="font-display font-bold text-lg">{listing.name}</span>
                  </div>
                  <span
                    className="text-[10px] font-semibold px-2.5 py-1 rounded-full"
                    style={{
                      backgroundColor: listing.status === 'Active' ? '#DCFCE7' : '#E6F7ED',
                      color: listing.status === 'Active' ? '#15803D' : '#0C3B5E',
                    }}
                  >
                    {listing.status}
                  </span>
                </div>

                <div className="p-5">
                  <span className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-[#DBEAFE] text-[#2563EB]">
                    {listing.category || 'General'}
                  </span>

                  <p className="flex items-center gap-1.5 text-sm text-[#0C3B5E]/60 mt-3">
                    <MapPin size={14} /> {listing.address}
                  </p>

                  <div className="flex items-center gap-2 mt-5">
                    <button
                      onClick={() => openEditModal(listing)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border border-[#0C3B5E]/15 text-sm font-medium text-[#0C3B5E]/80 hover:bg-[#E6F7ED] transition-colors"
                    >
                      <Pencil size={14} /> Edit
                    </button>
                    <button
                      onClick={() => handleToggle(listing.id)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border border-[#0C3B5E]/15 text-sm font-medium text-[#0C3B5E]/80 hover:bg-[#E6F7ED] transition-colors"
                    >
                      <Power size={14} /> {listing.status === 'Active' ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => handleDelete(listing.id)}
                      className="px-3 py-2.5 rounded-xl border border-[#0C3B5E]/15 text-[#0C3B5E]/50 hover:text-[#2563EB] hover:bg-[#DBEAFE] transition-colors"
                      aria-label="Delete listing"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </section>

      {/* Add / Edit modal */}
      <AnimatePresence>
        {modalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#0C3B5E]/40 backdrop-blur-sm flex items-center justify-center p-6 z-50"
            onClick={closeModal}
          >
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.98 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-3xl bg-white p-6 md:p-8 relative"
            >
              <button
                onClick={closeModal}
                className="absolute top-5 right-5 text-[#0C3B5E]/40 hover:text-[#0C3B5E]"
                aria-label="Close"
              >
                <X size={20} />
              </button>

              <h2 className="font-display font-bold text-2xl text-[#0C3B5E] mb-6">
                {editingId ? 'Edit listing' : 'Add new listing'}
              </h2>

              <form onSubmit={handleSubmit}>
                <Field label="Business name" required value={form.name} onChange={update('name')} />
                <Select label="Category" required value={form.category} onChange={update('category')}>
                  <option value="">Select one</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </Select>
                <Field label="Address" required value={form.address} onChange={update('address')} />
                <Select label="Status" value={form.status} onChange={update('status')}>
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </Select>

                <button
                  type="submit"
                  className="w-full py-3.5 rounded-xl bg-[#0C3B5E] text-white font-semibold hover:bg-[#0C3B5E]/90 transition-colors mt-2"
                >
                  {editingId ? 'Save changes' : 'Add listing'}
                </button>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}