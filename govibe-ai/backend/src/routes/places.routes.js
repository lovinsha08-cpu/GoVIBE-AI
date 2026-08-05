import { Router } from 'express';
import { autocomplete } from '../controllers/places.controller.js';

const router = Router();

router.get('/autocomplete', autocomplete);

export default router;