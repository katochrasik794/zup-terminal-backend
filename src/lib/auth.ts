import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from './env.js';

const JWT_SECRET = env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const JWT_EXPIRES_IN = '7d'; // Token expires in 7 days

export interface JWTPayload {
  userId?: string;
  id?: string;
  email?: string;
  clientId?: string;
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

/**
 * Compare a plain text password with a hashed password
 */
export async function comparePassword(
  password: string,
  hashedPassword: string
): Promise<boolean> {
  return bcrypt.compare(password, hashedPassword);
}

/**
 * Generate a JWT token
 */
export function generateToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): JWTPayload | null {
  try {
    // Strip 'Bearer ' prefix if present
    if (token.startsWith('Bearer ')) {
      token = token.slice(7, token.length);
    }

    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
    return decoded;
  } catch (error: any) {
    // Categorize error for better debugging
    let errorType = 'UNKNOWN_ERROR';
    if (error.name === 'TokenExpiredError') {
      errorType = 'EXPIRED';
    } else if (error.name === 'JsonWebTokenError') {
      if (error.message.includes('signature')) {
        errorType = 'INVALID_SIGNATURE (Secret Mismatch?)';
      } else {
        errorType = 'INVALID_TOKEN';
      }
    }

    console.error(`[Auth] ❌ Token verification failed!`);
    console.error(`  - Error Type: ${errorType}`);
    console.error(`  - Message: ${error.message}`);
    console.error(`  - Secret used: ${JWT_SECRET.substring(0, 5)}... (Length: ${JWT_SECRET.length})`);
    console.error(`  - Token start: ${token.substring(0, 15)}...`);

    return null;
  }
}

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate password strength
 * Requirements:
 * - 8-15 characters
 * - At least one uppercase and one lowercase letter
 * - At least one number
 * - At least one special character
 */
export function isValidPassword(password: string): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (password.length < 8 || password.length > 15) {
    errors.push('Password must be between 8-15 characters');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (!/\d/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
