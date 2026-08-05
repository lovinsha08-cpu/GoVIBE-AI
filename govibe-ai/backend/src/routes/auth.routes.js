import { Router } from 'express';
import {
  travelerSignup, businessSignup, login, forgotPassword, getMe,
} from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.post('/traveler/signup', travelerSignup);
router.post('/business/signup', businessSignup);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.get('/me', requireAuth, getMe);

export default router;
