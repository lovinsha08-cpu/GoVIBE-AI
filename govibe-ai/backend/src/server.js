import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { checkSupabaseConnection } from './config/supabase.js';
import routes from './routes/index.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json());
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));

// Basic rate limiting — tighten per-route later, especially AI/maps endpoints
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`GoVIBE AI backend running on http://localhost:${env.port}`);
  // Fire-and-forget: logs a clear, specific reason at boot if Supabase is
  // unreachable (paused project, bad URL, or no outbound internet) instead
  // of waiting for the first signup/login attempt to surface a vague error.
  checkSupabaseConnection();
});