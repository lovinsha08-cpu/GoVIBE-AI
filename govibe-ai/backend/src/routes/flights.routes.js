import { Router } from 'express';
import { searchFlights } from '../controllers/flights.controller.js';

const router = Router();

router.get('/search', searchFlights);

export default router;