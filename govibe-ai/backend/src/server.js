import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { checkSupabaseConnection } from './config/supabase.js';
import routes from './routes/index.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

const app=express();
app.disable('x-powered-by');
app.set('trust proxy',1);
app.use(helmet());
app.use(cors({origin:env.corsOrigin,credentials:true}));
app.use(express.json({limit:'1mb'}));
app.use(morgan(env.nodeEnv==='production'?'combined':'dev'));
app.use(rateLimit({windowMs:15*60*1000,max:300,standardHeaders:true,legacyHeaders:false}));

// Render/Vercel smoke tests can use this endpoint without authentication.
// It reports process health only; database/API credentials are never exposed.
app.get('/health',(req,res)=>res.status(200).json({status:'ok',service:'govibe-ai-backend',environment:env.nodeEnv}));

app.use('/api',routes);
app.use(notFound);
app.use(errorHandler);

app.listen(env.port,()=>{
  console.log(`GoVIBE AI backend listening on port ${env.port}`);
  checkSupabaseConnection();
});
