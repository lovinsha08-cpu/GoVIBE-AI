import { Router } from 'express';
import { list, categories } from '../controllers/spots.controller.js';

const router = Router();

router.get('/categories', categories);
router.get('/', list);

export default router;
