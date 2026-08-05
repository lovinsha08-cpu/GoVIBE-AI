import { Router } from 'express';
import { chat, getHistory } from '../controllers/assistant.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);
router.post('/chat', chat);
router.get('/history', getHistory);

export default router;