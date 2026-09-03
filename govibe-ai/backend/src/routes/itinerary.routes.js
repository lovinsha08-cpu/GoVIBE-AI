import { Router } from 'express';
import { generate, getLatest, regenerate, downloadPdf, searchReplacementPlaces, replace } from '../controllers/itinerary.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);
router.post('/generate', generate);
router.get('/:tripId/latest', getLatest);
router.get('/:tripId/places/search', searchReplacementPlaces);
router.post('/:tripId/stop/:stopOrder/regenerate', regenerate);
router.post('/:tripId/stop/:stopOrder/replace', replace);
router.get('/:tripId/download', downloadPdf);

export default router;