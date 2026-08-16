// The five Hidden Gems filter buckets shown on the Explore page.
// Keep the `key` values in sync with HIDDEN_GEM_CATEGORY_GROUPS in
// backend/src/services/spotMatching.service.js — these are sent as the
// `hiddenGemCategory` query param.
export const HIDDEN_GEM_CATEGORIES = [
  { key: null, label: 'All' },
  { key: 'nature', label: 'Nature & Outdoors' },
  { key: 'food', label: 'Food & Cafés' },
  { key: 'culture', label: 'Culture & Heritage' },
  { key: 'shopping', label: 'Shopping & Local Life' },
  { key: 'offbeat', label: 'Offbeat & Leisure' },
];