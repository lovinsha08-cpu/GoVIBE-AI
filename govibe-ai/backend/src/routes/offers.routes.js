import { Router } from 'express';
import { listPublicOffers } from '../controllers/offers.controller.js';

const router = Router();

// GET /api/offers — all active offers, for the Traveler Dashboard
router.get('/', listPublicOffers);

export default router;