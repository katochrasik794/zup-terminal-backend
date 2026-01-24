import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db';
import { authenticateToken } from '../middleware/auth';

const router = Router();

/**
 * GET /api/positions/:accountId
 * Get open positions for a specific account using REST API
 */
router.get('/:accountId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const accountId = String(req.params.accountId);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    // Get MT5 account with password for authentication
    const mt5Account = await prisma.mT5Account.findFirst({
      where: {
        accountId: accountId,
        userId: userId,
        archived: false,
      },
      select: {
        accountId: true,
        password: true,
      }
    });

    if (!mt5Account || !mt5Account.password) {
      console.error(`[Positions API] Account not found or password missing for accountId: ${accountId}`);
      return res.status(404).json({
        success: false,
        message: 'Account not found or password not configured',
      });
    }

    console.log(`[Positions API] Found MT5 account for ${accountId}, proceeding with authentication`);

    // Authenticate with MetaAPI
    const LIVE_API_URL = process.env.LIVE_API_URL || 'https://metaapi.zuperior.com/api';
    const CLIENT_LOGIN_PATH = process.env.CLIENT_LOGIN_PATH || '/client/ClientAuth/login';
    
    // Construct login URL
    let CLIENT_LOGIN_PATH_clean = CLIENT_LOGIN_PATH;
    if (CLIENT_LOGIN_PATH_clean.startsWith('/api/')) {
      CLIENT_LOGIN_PATH_clean = CLIENT_LOGIN_PATH_clean.replace(/^\/api/, '');
    }
    const loginUrl = `${LIVE_API_URL.replace(/\/$/, '')}${CLIENT_LOGIN_PATH_clean}`;
    
    console.log(`[Positions API] Login URL: ${loginUrl}`);
    
    const loginPayload = {
      AccountId: parseInt(accountId, 10),
      Password: mt5Account.password.trim(),
      DeviceId: `web_device_${Date.now()}`,
      DeviceType: 'web',
    };
    
    console.log(`[Positions API] Authenticating with payload:`, {
      AccountId: loginPayload.AccountId,
      Password: '***',
      DeviceId: loginPayload.DeviceId,
      DeviceType: loginPayload.DeviceType,
    });

    const loginController = new AbortController();
    const loginTimeout = setTimeout(() => loginController.abort(), 8000);
    
    let accessToken: string | null = null;
    
    try {
      const loginRes = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginPayload),
        signal: loginController.signal,
      });
      
      clearTimeout(loginTimeout);
      
      if (loginRes.ok) {
        const loginData = await loginRes.json() as any;
        // Check for Token (capital T) first, as that's what the API returns
        accessToken = loginData?.Token || loginData?.accessToken || loginData?.AccessToken || loginData?.data?.accessToken || null;
        console.log(`[Positions API] Successfully authenticated, token obtained: ${accessToken ? 'Yes' : 'No'}`);
      } else {
        const errorText = await loginRes.text().catch(() => '');
        console.error(`[Positions API] Login failed: ${loginRes.status}`, errorText);
        return res.status(loginRes.status).json({
          success: false,
          message: 'Failed to authenticate with MetaAPI',
          data: [],
        });
      }
    } catch (err: any) {
      clearTimeout(loginTimeout);
      if (err.name === 'AbortError') {
        return res.status(504).json({
          success: false,
          message: 'MT5 login timeout',
          data: [],
        });
      }
      console.error(`[Positions API] Login error for ${accountId}:`, err);
      return res.status(500).json({
        success: false,
        message: 'MT5 login error',
        data: [],
      });
    }

    if (!accessToken) {
      return res.status(401).json({
        success: false,
        message: 'No access token received from MetaAPI',
        data: [],
      });
    }

    // Fetch positions from REST API
    const positionsUrl = `${LIVE_API_URL.replace(/\/$/, '')}/client/Positions`;
    console.log(`[Positions API] Fetching positions from: ${positionsUrl}`);

    try {
      const positionsRes = await fetch(positionsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!positionsRes.ok) {
        const errorText = await positionsRes.text().catch(() => '');
        console.error(`[Positions API] Positions fetch failed: ${positionsRes.status}`, errorText);
        return res.status(positionsRes.status).json({
          success: false,
          message: `Failed to fetch positions: ${positionsRes.status}`,
          data: [],
        });
      }

      const positionsData = await positionsRes.json() as any;
      
      // Extract positions from response
      // Response format: { message: "...", accountId: 19876890, positions: [...] }
      const positions = positionsData?.positions || positionsData?.Positions || positionsData?.data || positionsData?.Data || [];

      console.log(`[Positions API] Successfully fetched ${Array.isArray(positions) ? positions.length : 0} positions for account ${accountId}`);
      console.log(`[Positions API] Full response:`, JSON.stringify(positionsData, null, 2));

      // Return response matching the curl format
      return res.json({
        success: true,
        message: positionsData?.message || 'Positions retrieved successfully',
        accountId: positionsData?.accountId || parseInt(accountId, 10),
        positions: positions,
        data: positions, // Also include in data for backward compatibility
      });

    } catch (fetchError: any) {
      console.error(`[Positions API] Error fetching positions:`, fetchError);
      return res.status(500).json({
        success: false,
        message: `Failed to fetch positions: ${fetchError.message}`,
        data: [],
      });
    }

  } catch (error: any) {
    const msg = error instanceof Error ? error.message : 'Failed to fetch positions';
    console.error('[Positions API] Error:', msg);
    return res.status(500).json({
      success: false,
      message: `Could not fetch positions: ${msg}`,
      data: [],
    });
  }
});

export default router;
