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
    res.status(401).json({
      success: false,
      message: 'Unauthorized. Please log in again.',
      error: 'NO_TOKEN',
    });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({
      success: false,
      message: 'Invalid or expired token. Please log in again.',
      error: 'INVALID_TOKEN',
    });
    return;
  }

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
