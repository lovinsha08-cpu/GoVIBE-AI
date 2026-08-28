import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyLocation } from '../controllers/businessOnboarding.controller.js';

const router = Router();

// Tighter than the app-wide limiter in server.js (300/15min) — this route
// calls a paid, quota-limited third-party API, and unlike /places/autocomplete
// it's not fired on every keystroke, so a much lower ceiling is appropriate.
const verifyLocationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many location verification attempts. Please try again in a few minutes.', code: 'rate_limited' },
});

router.post('/verify-location', verifyLocationLimiter, verifyLocation);

export default router;