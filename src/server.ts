import 'dotenv/config';
import express, { Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { validateEnv, env } from './lib/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import instrumentRoutes from './routes/instruments.js';
import positionRoutes from './routes/positions.js';
import orderRoutes from './routes/orders.js';
import alertRoutes from './routes/alerts.js';

// Validate environment variables (with error handling)
try {
  validateEnv();
} catch (error) {
  console.error('⚠️ Environment validation failed. Server may not work correctly.');
  console.error('Please check your .env file and ensure all required variables are set.');
  // In development, continue anyway
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}

const app: Express = express();
const PORT = parseInt(env.PORT || '5000', 10);

// Middleware - CORS configuration
// Support multiple origins: Vercel frontend and localhost for development
const allowedOrigins = [
  env.FRONTEND_URL,
  'https://zup-updated-terminal.vercel.app',
  'https://trade.zuperior.com',
  'http://localhost:3000',
  'http://localhost:3001',
].filter(Boolean); // Remove any undefined/null values

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // Log the blocked origin for debugging
      console.warn(`⚠️ CORS blocked origin: ${origin}. Allowed origins: ${allowedOrigins.join(', ')}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Type', 'Authorization'],
  preflightContinue: false,
  optionsSuccessStatus: 204,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/instruments', instrumentRoutes);
app.use('/api/positions', positionRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/alerts', alertRoutes);

// 404 handler
app.use(notFoundHandler);

// Error handler (must be last)
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Environment: ${env.NODE_ENV}`);
  console.log(`🔗 Frontend URL: ${env.FRONTEND_URL}`);
  console.log(`🌐 Allowed CORS origins: ${allowedOrigins.join(', ')}`);
});

export default app;
