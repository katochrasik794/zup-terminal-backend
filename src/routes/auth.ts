import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db';
import {
  comparePassword,
  generateToken,
  hashPassword,
  isValidEmail,
  isValidPassword,
  verifyToken,
} from '../lib/auth';
import { ensureDefaultFavorites } from '../lib/default-favorites';
import { authenticateToken } from '../middleware/auth';

const router = Router();

/**
 * POST /api/auth/login
 * User login endpoint
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.',
      });
    }

    // Validate email format
    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format.',
      });
    }

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // Check if user is active
    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: `Account is ${user.status}. Please contact support.`,
      });
    }

    // Verify password
    const isPasswordValid = await comparePassword(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // Update last login time
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Generate JWT token
    const token = generateToken({
      userId: user.id,
      email: user.email,
      clientId: user.clientId,
    });

    // Get user's MT5 account
    const mt5Account = await prisma.mT5Account.findFirst({
      where: { userId: user.id },
      select: {
        id: true,
        accountId: true,
      },
    });

    // Set session cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7 * 1000, // 7 days
      path: '/',
    });

    // Ensure user has default favorites (async, don't wait)
    ensureDefaultFavorites(user.id).catch((err) => {
      console.error('Failed to add default favorites:', err);
    });

    // Return success response with MT5 account info
    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      user: {
        id: user.id,
        clientId: user.clientId,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        emailVerified: user.emailVerified,
      },
      mt5Account: mt5Account
        ? {
            id: mt5Account.id,
            accountId: mt5Account.accountId,
          }
        : null,
      token,
    });
  } catch (error) {
    console.error('Login API Error:', error);
    return res.status(500).json({
      success: false,
      message: 'An internal server error occurred.',
    });
  }
});

/**
 * POST /api/auth/register
 * User registration endpoint
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name, phone } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.',
      });
    }

    // Validate email format
    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format.',
      });
    }

    // Validate password strength
    const passwordValidation = isValidPassword(password);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Password does not meet requirements.',
        errors: passwordValidation.errors,
      });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
      });
    }

    // Hash password
    const hashedPassword = await hashPassword(password);

    // Create new user
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        password: hashedPassword,
        name: name || null,
        phone: phone || null,
      },
    });

    // Generate JWT token
    const token = generateToken({
      userId: user.id,
      email: user.email,
    });

    // Set session cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7 * 1000, // 7 days
      path: '/',
    });

    // Add default favorites to new user (async, don't wait)
    ensureDefaultFavorites(user.id).catch((err) => {
      console.error('Failed to add default favorites:', err);
    });

    // Return success response
    return res.status(201).json({
      success: true,
      message: 'Registration successful.',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
      },
      token,
    });
  } catch (error) {
    console.error('Registration API Error:', error);
    return res.status(500).json({
      success: false,
      message: 'An internal server error occurred.',
    });
  }
});

/**
 * GET /api/auth/me
 * Get current authenticated user
 */
router.get('/me', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated.',
      });
    }

    // Fetch user details from database
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        id: true,
        clientId: true,
        email: true,
        name: true,
        phone: true,
        country: true,
        role: true,
        status: true,
        emailVerified: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: `Account is ${user.status}.`,
      });
    }

    return res.status(200).json({
      success: true,
      user,
    });
  } catch (error) {
    console.error('Get Current User API Error:', error);
    return res.status(500).json({
      success: false,
      message: 'An internal server error occurred.',
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout endpoint
 */
router.post('/logout', (req: Request, res: Response) => {
  try {
    // Clear the session cookie
    res.clearCookie('token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });

    return res.status(200).json({
      success: true,
      message: 'Logout successful.',
    });
  } catch (error) {
    console.error('Logout API Error:', error);
    return res.status(500).json({
      success: false,
      message: 'An internal server error occurred.',
    });
  }
});

/**
 * POST /api/auth/sso-login
 * SSO Login endpoint - accepts token and clientId from main CRM app
 */
router.post('/sso-login', async (req: Request, res: Response) => {
  try {
    const { token, clientId } = req.body;

    // Validate input
    if (!token || !clientId) {
      return res.status(400).json({
        success: false,
        message: 'Token and clientId are required.',
      });
    }

    // Find user by clientId
    const user = await prisma.user.findUnique({
      where: { clientId: clientId },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    // Check if user is active
    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: `Account is ${user.status}. Please contact support.`,
      });
    }

    // Update last login time
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Generate JWT token for terminal
    const terminalToken = generateToken({
      userId: user.id,
      email: user.email,
      clientId: user.clientId,
    });

    // Get user's MT5 account
    const mt5Account = await prisma.mT5Account.findFirst({
      where: { userId: user.id },
      select: {
        id: true,
        accountId: true,
      },
    });

    // Set session cookie
    res.cookie('token', terminalToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7 * 1000, // 7 days
      path: '/',
    });

    // Return success response
    return res.status(200).json({
      success: true,
      message: 'SSO login successful.',
      user: {
        id: user.id,
        clientId: user.clientId,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        emailVerified: user.emailVerified,
      },
      mt5Account: mt5Account
        ? {
            id: mt5Account.id,
            accountId: mt5Account.accountId,
          }
        : null,
      token: terminalToken,
    });
  } catch (error) {
    console.error('SSO Login API Error:', error);
    return res.status(500).json({
      success: false,
      message: 'An internal server error occurred.',
    });
  }
});

export default router;
