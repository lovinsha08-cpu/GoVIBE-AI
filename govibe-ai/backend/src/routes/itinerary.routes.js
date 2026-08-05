import { Router } from 'express';
import { generate, getLatest, regenerate, downloadPdf } from '../controllers/itinerary.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);
router.post('/generate', generate);
router.get('/:tripId/latest', getLatest);
router.post('/:tripId/stop/:stopOrder/regenerate', regenerate);
router.get('/:tripId/download', downloadPdf);

export default router;