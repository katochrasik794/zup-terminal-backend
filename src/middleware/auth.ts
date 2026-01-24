import { Request, Response, NextFunction } from 'express';
import { verifyToken, JWTPayload } from '../lib/auth';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

/**
 * JWT Authentication Middleware
 * Verifies JWT token from Authorization header or cookie
 */
export function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Get token from header or cookie
  const authHeader = req.headers.authorization;
  const token =
    authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : req.cookies?.token;

  if (!token) {
    console.error('[Auth Middleware] No token provided. Headers:', req.headers.authorization, 'Cookies:', req.cookies);
    res.status(401).json({
      success: false,
      message: 'Unauthorized. Please log in again.',
      error: 'NO_TOKEN',
    });
    return;
  }

  console.log('[Auth Middleware] Token received, verifying...');
  const payload = verifyToken(token);
  if (!payload) {
    console.error('[Auth Middleware] Token verification failed. Token:', token.substring(0, 20) + '...');
    res.status(401).json({
      success: false,
      message: 'Invalid or expired token. Please log in again.',
      error: 'INVALID_TOKEN',
    });
    return;
  }

  console.log('[Auth Middleware] Token verified successfully. UserId:', payload.userId);

  // Attach user to request
  req.user = payload;
  next();
}

/**
 * Optional authentication middleware
 * Attaches user if token is present, but doesn't fail if missing
 */
export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  const token =
    authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : req.cookies?.token;

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.user = payload;
    }
  }

  next();
}
