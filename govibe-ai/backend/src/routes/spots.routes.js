import { Router } from 'express';
import { list, categories, hiddenGemCategories } from '../controllers/spots.controller.js';

const router = Router();

router.get('/categories', categories);
router.get('/hidden-gem-categories', hiddenGemCategories);
router.get('/', list);

export default router;