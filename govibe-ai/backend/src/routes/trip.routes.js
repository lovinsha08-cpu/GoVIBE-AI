import { Router } from 'express';
import { createTrip, getTrip, listTrips, getEmergencyServices, deleteTrip } from '../controllers/trip.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);
router.post('/', createTrip);
router.get('/', listTrips);
router.get('/:id', getTrip);
router.get('/:id/emergency', getEmergencyServices);
router.delete('/:id', deleteTrip);

export default router;