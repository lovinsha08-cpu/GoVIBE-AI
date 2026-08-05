import { Router } from 'express';
import {
  createOffer,
  listMyOffers,
  updateOffer,
  setOfferStatus,
  deleteOffer,
} from '../controllers/offers.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);

router.get('/offers', listMyOffers);
router.post('/offers', createOffer);
router.put('/offers/:id', updateOffer);
router.patch('/offers/:id/status', setOfferStatus);
router.delete('/offers/:id', deleteOffer);

export default router;