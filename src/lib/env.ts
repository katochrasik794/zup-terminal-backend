import { z } from 'zod';

const envSchema = z.object({
  // Node environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Server
  PORT: z.string().default('5000'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Redis (optional for development)
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  NEXT_PUBLIC_JWT_SECRET: z.string().optional(),

  // MT5 API
  NEXT_PUBLIC_API_BASE_URL: z.string().url('Invalid API_BASE_URL'),
  LIVE_API_URL: z.string().url('Invalid LIVE_API_URL').default('http://18.130.5.209:5003/api'),
  NEXT_PUBLIC_WS_URL: z.string().default('/ws-proxy'),
  MANAGER_USERNAME: z.string().min(1, 'MANAGER_USERNAME is required'),
  MANAGER_PASSWORD: z.string().min(1, 'MANAGER_PASSWORD is required'),
  MANAGER_SERVER_IP: z.string().min(1, 'MANAGER_SERVER_IP is required'),
  MANAGER_PORT: z.string().min(1, 'MANAGER_PORT is required'),
  MANAGER_LOGIN_PATH: z.string().min(1, 'MANAGER_LOGIN_PATH is required'),
  CLIENT_LOGIN_PATH: z.string().optional(),
  MARKET_DATA_SYMBOLS_PATH: z.string().min(1, 'MARKET_DATA_SYMBOLS_PATH is required'),

  // App URL
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),

  // CORS
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
});

// Type for validated environment
export type Env = z.infer<typeof envSchema>;

// Validate environment variables
export function validateEnv(): Env {
  try {
    const validated = envSchema.parse(process.env);
    validatedEnv = validated;
    console.log('✅ Environment variables validated successfully');
    return validated;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Invalid environment variables:');
      error.errors.forEach((err) => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
      
      // In production, fail hard. In development, warn but continue
      if (process.env.NODE_ENV === 'production') {
        process.exit(1);
      } else {
        console.warn('⚠️ Continuing with invalid environment variables in development');
        // Try to get partial validation with defaults
        try {
          validatedEnv = envSchema.partial().parse(process.env) as Env;
        } catch {
          // Ignore
        }
      }
    }
    // Don't throw in development, return partial env
    if (process.env.NODE_ENV !== 'production') {
      return validatedEnv || ({} as Env);
    }
    throw error;
  }
}

// Safe environment accessor with fallbacks
let validatedEnv: Env | null = null;

export const env = new Proxy(process.env as any as Env, {
  get(target, prop: string) {
    // Always check process.env first
    const value = process.env[prop];
    if (value !== undefined && value !== '') {
      return value;
    }
    
    // If validated env exists, use that
    if (validatedEnv) {
      const validatedValue = validatedEnv[prop as keyof Env];
      if (validatedValue !== undefined) {
        return validatedValue;
      }
    }
    
    // Return undefined - let the schema defaults handle it during validation
    return value;
  },
});

// Validate on module load in production
// In development, validation happens when server starts
if (process.env.NODE_ENV === 'production') {
  validateEnv();
}
