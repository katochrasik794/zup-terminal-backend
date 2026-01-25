import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db';
import { authenticateToken } from '../middleware/auth';

const router = Router();

/**
 * POST /api/positions/close-all
 * Close all positions for an account
 * NOTE: This route must come BEFORE /:accountId to avoid route conflicts
 */
router.post('/close-all', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { accountId } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    if (!accountId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: accountId',
      });
    }

    // Get MT5 account from database
    const mt5Account = await prisma.mT5Account.findFirst({
      where: {
        userId: userId,
        accountId: String(accountId),
        archived: false,
      },
    });

    if (!mt5Account) {
      return res.status(404).json({
        success: false,
        message: 'MT5 account not found',
      });
    }

    // Authenticate with MetaAPI to get access token
    const LIVE_API_URL = process.env.LIVE_API_URL || 'https://metaapi.zuperior.com/api';
    const CLIENT_LOGIN_PATH = process.env.CLIENT_LOGIN_PATH || '/client/ClientAuth/login';

    let CLIENT_LOGIN_PATH_clean = CLIENT_LOGIN_PATH;
    if (CLIENT_LOGIN_PATH_clean.startsWith('/api/')) {
      CLIENT_LOGIN_PATH_clean = CLIENT_LOGIN_PATH_clean.replace(/^\/api/, '');
    }

    const loginUrl = CLIENT_LOGIN_PATH_clean.startsWith('http')
      ? CLIENT_LOGIN_PATH_clean
      : CLIENT_LOGIN_PATH_clean.startsWith('/')
        ? `${LIVE_API_URL.replace(/\/$/, '')}${CLIENT_LOGIN_PATH_clean}`
        : `${LIVE_API_URL.replace(/\/$/, '')}/${CLIENT_LOGIN_PATH_clean}`;

    let accessToken: string | null = null;
    try {
      if (!mt5Account.password) {
        return res.status(400).json({
          success: false,
          message: 'MT5 account password not found',
        });
      }

      const loginPayload = {
        AccountId: parseInt(accountId, 10),
        Password: mt5Account.password.trim(),
        DeviceId: `web_closeall_${userId}_${Date.now()}`,
        DeviceType: 'web',
      };

      const loginResponse = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginPayload),
      });

      if (loginResponse.ok) {
        const loginData = await loginResponse.json() as any;
        accessToken = loginData?.Token || loginData?.accessToken || loginData?.AccessToken || loginData?.token || null;
      }
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Failed to authenticate with MetaAPI',
      });
    }

    if (!accessToken) {
      return res.status(401).json({
        success: false,
        message: 'Failed to authenticate with MetaAPI',
      });
    }

    // Close all positions via MetaAPI
    // First, get all open positions
    const API_BASE = LIVE_API_URL.endsWith('/api') ? LIVE_API_URL : `${LIVE_API_URL.replace(/\/$/, '')}/api`;
    const positionsUrl = `${API_BASE}/client/Positions`;

    try {
      // Get all positions
      const positionsResponse = await fetch(positionsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'AccountId': String(accountId),
          'Accept': 'application/json',
        },
      });

      if (!positionsResponse.ok) {
        return res.status(positionsResponse.status).json({
          success: false,
          message: 'Failed to fetch positions',
        });
      }

      const positionsData = await positionsResponse.json() as any;
      const positions = positionsData?.positions || positionsData?.data || positionsData || [];

      if (!Array.isArray(positions) || positions.length === 0) {
        return res.json({
          success: true,
          data: { closed: 0, failed: 0 },
          message: 'No positions to close',
        });
      }

      // Close each position
      const closeResults = await Promise.allSettled(
        positions.map(async (pos: any) => {
          const positionId = pos.PositionId || pos.positionId || pos.Id || pos.id;
          if (!positionId) return { success: false, positionId: null, error: 'No position ID' };

          const closeUrl = `${API_BASE}/client/position/${positionId}`;
          try {
            const closeResponse = await fetch(closeUrl, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'AccountId': String(accountId),
                'Accept': 'application/json',
              },
            });

            if (closeResponse.ok || closeResponse.status === 204) {
              return { success: true, positionId };
            } else {
              // Try fallback POST method
              const fallbackUrl = `${API_BASE}/client/position/close`;
              const fallbackResponse = await fetch(fallbackUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${accessToken}`,
                  'AccountId': String(accountId),
                },
                body: JSON.stringify({ positionId }),
              });

              if (fallbackResponse.ok || fallbackResponse.status === 204) {
                return { success: true, positionId };
              }

              const errorText = await fallbackResponse.text().catch(() => '');
              return { success: false, positionId, error: errorText || 'Failed to close' };
            }
          } catch (err) {
            return { success: false, positionId, error: err instanceof Error ? err.message : 'Unknown error' };
          }
        })
      );

      const closed = closeResults.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failed = closeResults.length - closed;

      return res.json({
        success: true,
        data: { closed, failed, total: positions.length },
        message: `Closed ${closed} position${closed !== 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}`,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Failed to close all positions',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/positions/:positionId/close
 * Close a single position
 * NOTE: This route must come BEFORE /:accountId to avoid route conflicts
 */
router.post('/:positionId/close', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { positionId } = req.params;
    const { accountId, symbol, volume } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    if (!accountId || !positionId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: accountId, positionId',
      });
    }

    const positionIdNum = Number(positionId);
    if (!Number.isFinite(positionIdNum) || positionIdNum <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid positionId',
      });
    }

    // Get MT5 account from database
    const mt5Account = await prisma.mT5Account.findFirst({
      where: {
        userId: userId,
        accountId: String(accountId),
        archived: false,
      },
    });

    if (!mt5Account) {
      return res.status(404).json({
        success: false,
        message: 'MT5 account not found',
      });
    }

    // Authenticate with MetaAPI to get access token
    const LIVE_API_URL = process.env.LIVE_API_URL || 'https://metaapi.zuperior.com/api';
    const CLIENT_LOGIN_PATH = process.env.CLIENT_LOGIN_PATH || '/client/ClientAuth/login';

    let CLIENT_LOGIN_PATH_clean = CLIENT_LOGIN_PATH;
    if (CLIENT_LOGIN_PATH_clean.startsWith('/api/')) {
      CLIENT_LOGIN_PATH_clean = CLIENT_LOGIN_PATH_clean.replace(/^\/api/, '');
    }

    const loginUrl = CLIENT_LOGIN_PATH_clean.startsWith('http')
      ? CLIENT_LOGIN_PATH_clean
      : CLIENT_LOGIN_PATH_clean.startsWith('/')
        ? `${LIVE_API_URL.replace(/\/$/, '')}${CLIENT_LOGIN_PATH_clean}`
        : `${LIVE_API_URL.replace(/\/$/, '')}/${CLIENT_LOGIN_PATH_clean}`;

    if (!mt5Account.password) {
      return res.status(400).json({
        success: false,
        message: 'MT5 account password not found',
      });
    }

    let accessToken: string | null = null;
    try {
      const loginPayload = {
        AccountId: parseInt(accountId, 10),
        Password: mt5Account.password.trim(),
        DeviceId: `web_close_${userId}_${Date.now()}`,
        DeviceType: 'web',
      };

      const loginResponse = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginPayload),
      });

      if (loginResponse.ok) {
        const loginData = await loginResponse.json() as any;
        accessToken = loginData?.Token || loginData?.accessToken || loginData?.AccessToken || loginData?.token || null;
      }
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Failed to authenticate with MetaAPI',
      });
    }

    if (!accessToken) {
      return res.status(401).json({
        success: false,
        message: 'Failed to authenticate with MetaAPI',
      });
    }

    // Close position via MetaAPI
    // Helper to fetch with timeout and parse (matching zuperior-terminal)
    const doFetch = async (u: string, init: RequestInit, timeoutMs = 10000): Promise<{ res: globalThis.Response; json: any }> => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let fetchRes: globalThis.Response;
      let text = '';
      try {
        fetchRes = await fetch(u, { ...init, signal: ctrl.signal });
        text = await fetchRes.text().catch(() => '');
      } finally {
        clearTimeout(t);
      }
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { res: fetchRes, json };
    };

    const API_BASE = LIVE_API_URL.endsWith('/api') ? LIVE_API_URL : `${LIVE_API_URL.replace(/\/$/, '')}/api`;
    const hasVolume = volume && Number(volume) > 0;
    const q = new URLSearchParams();
    if (hasVolume) q.set('volume', String(volume));

    const primaryUrl = `${API_BASE}/client/position/${positionIdNum}${q.toString() ? `?${q.toString()}` : ''}`;
    const baseHeaders: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
      ...(accountId ? { 'AccountId': String(accountId) } : {}),
      'Accept': 'application/json',
    };

    // Try primary method first: DELETE /client/position/{positionId}
    const primary = await doFetch(primaryUrl, { method: 'DELETE', headers: baseHeaders }, 10000);

    // If primary succeeds, return immediately
    if (primary.res.ok || primary.res.status === 204) {
      return res.status(primary.res.status).json({
        success: true,
        data: primary.json,
        message: 'Position closed successfully'
      });
    }

    // Fallback 1: POST /client/position/close with JSON payload (camelCase)
    const shouldFallback1 = !primary.res.ok && (primary.res.status === 415 || primary.res.status === 405 || primary.res.status >= 400);
    let fallback1: { res: globalThis.Response; json: any } | null = null;
    if (shouldFallback1) {
      const payload: any = { positionId: Number(positionIdNum) };
      if (hasVolume) payload.volume = Number(volume);
      const f1Url = `${API_BASE}/client/position/close`;
      fallback1 = await doFetch(f1Url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...baseHeaders },
        body: JSON.stringify(payload),
      }, 10000);

      // If fallback1 succeeds, return immediately
      if (fallback1.res.ok || fallback1.res.status === 204) {
        return res.status(fallback1.res.status).json({
          success: true,
          data: fallback1.json,
          message: 'Position closed successfully'
        });
      }
    }

    // Fallback 2: POST /Trading/position/close with PascalCase payload (try if both failed)
    const shouldFallback2 = !primary.res.ok && (!fallback1 || !fallback1.res.ok);
    let fallback2: { res: globalThis.Response; json: any } | null = null;
    if (shouldFallback2) {
      const payload: any = {
        Login: parseInt(String(accountId), 10),
        PositionId: Number(positionIdNum)
      };
      if (hasVolume) payload.Volume = Number(volume);
      const f2Url = `${API_BASE}/Trading/position/close`;
      fallback2 = await doFetch(f2Url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...baseHeaders },
        body: JSON.stringify(payload),
      }, 10000);
    }

    const final = fallback2 ?? fallback1 ?? primary;

    // Check for success - handle both HTTP status and response body (matching zuperior-terminal)
    const isSuccess = final.res.ok || final.res.status === 204 || final.res.status === 200;
    const responseSuccess = final.json?.success || final.json?.Success || final.json?.success === true || final.json?.Success === true;

    // If HTTP is OK but response says failure, treat as failure
    if (isSuccess && responseSuccess !== false) {
      // Success - return immediately
      return res.status(final.res.status).json({
        success: true,
        Success: true, // Include both formats for compatibility
        data: final.json,
        message: 'Position closed successfully'
      });
    }

    // Extract error message from response
    let errorMessage = 'Failed to close position';
    if (final.json) {
      errorMessage = final.json.message || final.json.Message || final.json.error || final.json.Error || errorMessage;
      // If error is a string, use it directly
      if (typeof final.json === 'string') {
        errorMessage = final.json;
      }
    }

    return res.status(final.res.status || 500).json({
      success: false,
      Success: false, // Include both formats for compatibility
      message: errorMessage,
      error: final.json,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * PUT /api/positions/:positionId/modify
 * Modify TP/SL for an open position
 * NOTE: This route must come BEFORE /:accountId to avoid route conflicts
 */
router.put('/:positionId/modify', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { positionId } = req.params;
    const { accountId, stopLoss, takeProfit, comment } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    if (!accountId || !positionId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: accountId, positionId',
      });
    }

    const positionIdNum = Number(positionId);
    if (!Number.isFinite(positionIdNum) || positionIdNum <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid positionId',
      });
    }

    // Get MT5 account from database
    const mt5Account = await prisma.mT5Account.findFirst({
      where: {
        userId: userId,
        accountId: String(accountId),
        archived: false,
      },
    });

    if (!mt5Account || !mt5Account.password) {
      return res.status(404).json({
        success: false,
        message: 'MT5 account not found or password not set',
      });
    }

    // Authenticate with MetaAPI
    const LIVE_API_URL = process.env.LIVE_API_URL || 'https://metaapi.zuperior.com/api';
    const CLIENT_LOGIN_PATH = process.env.CLIENT_LOGIN_PATH || '/client/ClientAuth/login';

    let CLIENT_LOGIN_PATH_clean = CLIENT_LOGIN_PATH;
    if (CLIENT_LOGIN_PATH_clean.startsWith('/api/')) {
      CLIENT_LOGIN_PATH_clean = CLIENT_LOGIN_PATH_clean.replace(/^\/api/, '');
    }

    const loginUrl = CLIENT_LOGIN_PATH_clean.startsWith('http')
      ? CLIENT_LOGIN_PATH_clean
      : CLIENT_LOGIN_PATH_clean.startsWith('/')
        ? `${LIVE_API_URL.replace(/\/$/, '')}${CLIENT_LOGIN_PATH_clean}`
        : `${LIVE_API_URL.replace(/\/$/, '')}/${CLIENT_LOGIN_PATH_clean}`;

    let accessToken: string | null = null;
    try {
      const loginPayload = {
        AccountId: parseInt(accountId, 10),
        Password: mt5Account.password.trim(),
        DeviceId: `web_modify_${userId}_${Date.now()}`,
        DeviceType: 'web',
      };

      const loginResponse = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginPayload),
      });

      if (loginResponse.ok) {
        const loginData = await loginResponse.json() as any;
        accessToken = loginData?.Token || loginData?.accessToken || loginData?.AccessToken || loginData?.token || null;
      }
    } catch (err) {
      console.error('[Positions] MetaAPI login error:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to authenticate with MetaAPI',
      });
    }

    if (!accessToken) {
      return res.status(401).json({
        success: false,
        message: 'Failed to authenticate with MetaAPI',
      });
    }

    // Build payload for modifying position
    const payload: any = {
      positionId: positionIdNum,
      comment: comment || 'Modified via web terminal',
    };
    if (stopLoss !== undefined && stopLoss !== null && Number(stopLoss) > 0) {
      payload.stopLoss = Number(stopLoss);
    }
    if (takeProfit !== undefined && takeProfit !== null && Number(takeProfit) > 0) {
      payload.takeProfit = Number(takeProfit);
    }

    // Helper to perform a fetch with timeout and parse
    const doFetch = async (u: string, init: RequestInit, timeoutMs = 35000): Promise<{ res: globalThis.Response; json: any }> => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let fetchRes: globalThis.Response;
      let text = '';
      try {
        fetchRes = await fetch(u, { ...init, signal: ctrl.signal });
        text = await fetchRes.text().catch(() => '');
      } finally {
        clearTimeout(t);
      }
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { res: fetchRes, json };
    };

    const API_BASE = LIVE_API_URL.endsWith('/api') ? LIVE_API_URL : `${LIVE_API_URL.replace(/\/$/, '')}/api`;

    // Primary attempt: POST /client/position/modify
    const primaryUrl = `${API_BASE}/client/position/modify`;
    const primary = await doFetch(primaryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    }, 35000);

    // If primary succeeds, return immediately
    if (primary.res.ok) {
      return res.json({
        success: true,
        data: primary.json,
      });
    }

    // Fallback: PUT /Trading/position/modify
    const tradingPayload: any = {
      Login: parseInt(String(accountId), 10),
      PositionId: positionIdNum,
      Comment: comment || 'Modified via web terminal',
    };
    if (stopLoss !== undefined && stopLoss !== null && Number(stopLoss) > 0) {
      tradingPayload.StopLoss = Number(stopLoss);
    }
    if (takeProfit !== undefined && takeProfit !== null && Number(takeProfit) > 0) {
      tradingPayload.TakeProfit = Number(takeProfit);
    }

    const secondaryUrl = `${API_BASE}/Trading/position/modify`;
    const secondary = await doFetch(secondaryUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(tradingPayload),
    }, 35000);

    // Choose best response to forward
    const forward = secondary.res.ok ? secondary : primary;
    return res.status(forward.res.status).json({
      success: forward.res.ok,
      data: forward.json,
    });
  } catch (error) {
    console.error('[Positions] Modify position error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/positions/:accountId
 * Get all positions (open, pending, closed) for an account
 * NOTE: This route must come AFTER /close-all, /:positionId/close, and /:positionId/modify to avoid route conflicts
 */
router.get('/:accountId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { accountId } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    if (!accountId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: accountId',
      });
    }

    // Get MT5 account from database
    const mt5Account = await prisma.mT5Account.findFirst({
      where: {
        userId: userId,
        accountId: String(accountId),
        archived: false,
      },
    });

    if (!mt5Account) {
      return res.status(404).json({
        success: false,
        message: 'MT5 account not found',
      });
    }

    // Authenticate with MetaAPI to get access token
    const LIVE_API_URL = process.env.LIVE_API_URL || 'https://metaapi.zuperior.com/api';
    const CLIENT_LOGIN_PATH = process.env.CLIENT_LOGIN_PATH || '/client/ClientAuth/login';

    let CLIENT_LOGIN_PATH_clean = CLIENT_LOGIN_PATH;
    if (CLIENT_LOGIN_PATH_clean.startsWith('/api/')) {
      CLIENT_LOGIN_PATH_clean = CLIENT_LOGIN_PATH_clean.replace(/^\/api/, '');
    }

    const loginUrl = CLIENT_LOGIN_PATH_clean.startsWith('http')
      ? CLIENT_LOGIN_PATH_clean
      : CLIENT_LOGIN_PATH_clean.startsWith('/')
        ? `${LIVE_API_URL.replace(/\/$/, '')}${CLIENT_LOGIN_PATH_clean}`
        : `${LIVE_API_URL.replace(/\/$/, '')}/${CLIENT_LOGIN_PATH_clean}`;

    if (!mt5Account.password) {
      return res.status(400).json({
        success: false,
        message: 'MT5 account password not found',
      });
    }

    let accessToken: string | null = null;
    try {
      const accountIdStr = Array.isArray(accountId) ? accountId[0] : accountId;
      const loginPayload = {
        AccountId: parseInt(accountIdStr, 10),
        Password: mt5Account.password.trim(),
        DeviceId: `web_positions_${userId}_${Date.now()}`,
        DeviceType: 'web',
      };

      const loginResponse = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginPayload),
      });

      if (loginResponse.ok) {
        const loginData = await loginResponse.json() as any;
        accessToken = loginData?.Token || loginData?.accessToken || loginData?.AccessToken || loginData?.token || null;
      }
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Failed to authenticate with MetaAPI',
      });
    }

    if (!accessToken) {
      return res.status(401).json({
        success: false,
        message: 'Failed to authenticate with MetaAPI',
      });
    }

    // Fetch positions from MetaAPI
    const API_BASE = LIVE_API_URL.endsWith('/api') ? LIVE_API_URL : `${LIVE_API_URL.replace(/\/$/, '')}/api`;
    const baseHeaders: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
      'AccountId': String(accountId),
      'Accept': 'application/json',
    };

    try {
      let openPositions: any[] = [];
      let pendingOrders: any[] = [];
      let closedPositions: any[] = [];

      // Fetch open positions
      try {
        const positionsUrl = `${API_BASE}/client/Positions`;
        const positionsResponse = await fetch(positionsUrl, {
          method: 'GET',
          headers: baseHeaders,
        });

        if (positionsResponse.ok) {
          const positionsData = await positionsResponse.json() as any;
          openPositions = positionsData?.positions || positionsData?.data || positionsData || [];
        }
      } catch (err) {
        // Continue with empty array
      }

      // Fetch pending orders
      try {
        const ordersUrl = `${API_BASE}/client/Orders`;
        const ordersResponse = await fetch(ordersUrl, {
          method: 'GET',
          headers: baseHeaders,
        });

        if (ordersResponse.ok) {
          const ordersData = await ordersResponse.json() as any;
          pendingOrders = ordersData?.orders || ordersData?.data || ordersData || [];
        }
      } catch (err) {
        // Continue with empty array
      }

      // Fetch closed positions
      try {
        // Build query parameters - match zuperior-terminal format
        const closedParams = new URLSearchParams();
        closedParams.set('accountId', String(accountId));
        closedParams.set('AccountId', String(accountId));
        closedParams.set('fromDate', '1970-01-01');
        closedParams.set('FromDate', '1970-01-01');
        closedParams.set('toDate', '2100-01-01');
        closedParams.set('ToDate', '2100-01-01');
        closedParams.set('pageSize', '10000');
        closedParams.set('PageSize', '10000');

        const closedUrl = `${API_BASE}/client/tradehistory/trades?${closedParams.toString()}`;

        // Tradehistory API may not require Authorization header (as per zuperior-terminal)
        // Try with auth first, fallback without if needed
        const closedResponse = await fetch(closedUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            ...baseHeaders, // Include auth, but API might not require it
          },
        });

        if (closedResponse.ok) {
          const closedData = await closedResponse.json() as any;
          // Extract trades from response - try multiple possible structures
          let allTrades: any[] = [];
          if (Array.isArray(closedData)) {
            allTrades = closedData;
          } else if (closedData && typeof closedData === 'object') {
            allTrades = closedData.Items ||
              closedData.Data ||
              closedData.data ||
              closedData.trades ||
              closedData.items ||
              closedData.results ||
              closedData.Results ||
              closedData.Trades ||
              closedData.closedTrades ||
              closedData.ClosedTrades ||
              closedData.tradeHistory ||
              closedData.TradeHistory ||
              [];
          }

          // Filter for closed trades - match zuperior-terminal logic
          // A closed position must have:
          // 1. Valid OrderId or DealId > 0
          // 2. Non-empty Symbol
          // 3. Valid Price (not 0 or undefined) - this is the close price
          // 4. Valid VolumeLots or Volume
          // 5. Non-zero P/L (Profit > 0 or Profit < 0)
          // Note: CloseTime is NOT required (as per zuperior-terminal implementation)
          closedPositions = allTrades.filter((trade: any, index: number) => {
            // Get identifiers
            const orderId = trade.OrderId ?? trade.orderId ?? trade.DealId ?? trade.dealId ?? 0;
            const symbol = (trade.Symbol || trade.symbol || '').trim();

            // Get price (could be Price, ClosePrice, or OpenPrice)
            const price = trade.Price ?? trade.price ?? trade.ClosePrice ?? trade.closePrice ?? trade.PriceClose ?? trade.priceClose ?? trade.OpenPrice ?? trade.openPrice ?? 0;

            // Get volume
            const volumeLots = trade.VolumeLots ?? trade.volumeLots ?? trade.Volume ?? trade.volume ?? 0;

            // Get P/L (Profit)
            const profit = trade.Profit ?? trade.profit ?? trade.PnL ?? trade.pnl ?? 0;
            const profitNum = Number(profit);

            // Basic validation for closed positions (matching zuperior-terminal)
            const hasValidOrderId = Number(orderId) > 0 && !isNaN(Number(orderId));
            const hasValidSymbol = symbol && symbol.length > 0;
            const hasValidPrice = Number(price) > 0 && !isNaN(Number(price));
            const hasValidVolume = Number(volumeLots) > 0 && !isNaN(Number(volumeLots));
            // Only include trades with non-zero P/L (Profit > 0 or Profit < 0)
            const hasNonZeroProfit = Number.isFinite(profitNum) && profitNum !== 0;

            return hasValidOrderId && hasValidSymbol && hasValidPrice && hasValidVolume && hasNonZeroProfit;
          });
        }
      } catch (err) {
        // Continue with empty array
      }

      return res.json({
        success: true,
        positions: openPositions,
        pendingOrders: pendingOrders,
        closedPositions: closedPositions,
        accountId: accountId,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch positions',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
