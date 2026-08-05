import { Router } from 'express';
import authRoutes from './auth.routes.js';
import tripRoutes from './trip.routes.js';
import itineraryRoutes from './itinerary.routes.js';
import spotsRoutes from './spots.routes.js';
import placesRoutes from './places.routes.js';
import offersRoutes from './offers.routes.js';
import businessRoutes from './business.routes.js';
import flightsRoutes from './flights.routes.js';
import assistantRoutes from './assistant.routes.js';

const router = Router();

router.get('/health', (req, res) => res.json({ status: 'ok', service: 'govibe-ai-backend' }));
router.use('/auth', authRoutes);
router.use('/trips', tripRoutes);
router.use('/itinerary', itineraryRoutes);
router.use('/spots', spotsRoutes);
router.use('/places', placesRoutes);
router.use('/offers', offersRoutes);
router.use('/business', businessRoutes);
router.use('/flights', flightsRoutes);
router.use('/assistant', assistantRoutes);

export default router;