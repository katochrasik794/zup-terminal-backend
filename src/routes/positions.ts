import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db';
import { authenticateToken } from '../middleware/auth';

const router = Router();

/**
 * GET /api/positions/:accountId
 * Get all positions (open, pending, closed) for an account
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
    
    let accessToken: string | null = null;
    try {
      const loginPayload = {
        AccountId: parseInt(accountId, 10),
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

/**
 * POST /api/positions/close-all
 * Close all positions for an account
 * NOTE: This route must come BEFORE /:positionId/close to avoid route conflicts
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
    // Try DELETE /client/position/{positionId} first
    const API_BASE = LIVE_API_URL.endsWith('/api') ? LIVE_API_URL : `${LIVE_API_URL.replace(/\/$/, '')}/api`;
    const hasVolume = volume && Number(volume) > 0;
    const q = new URLSearchParams();
    if (hasVolume) q.set('volume', String(volume));
    
    const primaryUrl = `${API_BASE}/client/position/${positionIdNum}${q.toString() ? `?${q.toString()}` : ''}`;
    const baseHeaders: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
      'AccountId': String(accountId),
      'Accept': 'application/json',
    };

    try {
      // Try primary method: DELETE (fastest)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout
      
      const primaryResponse = await fetch(primaryUrl, {
        method: 'DELETE',
        headers: baseHeaders,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (primaryResponse.ok || primaryResponse.status === 204) {
        return res.json({
          success: true,
          message: 'Position closed successfully',
        });
      }

      // Only try fallback for specific error codes
      if (primaryResponse.status === 415 || primaryResponse.status === 405) {
        const fallback1Url = `${API_BASE}/client/position/close`;
        const fallback1Payload: any = { positionId: positionIdNum };
        if (hasVolume) fallback1Payload.volume = Number(volume);

        const controller2 = new AbortController();
        const timeoutId2 = setTimeout(() => controller2.abort(), 3000);
        
        const fallback1Response = await fetch(fallback1Url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...baseHeaders,
          },
          body: JSON.stringify(fallback1Payload),
          signal: controller2.signal,
        });
        clearTimeout(timeoutId2);

        if (fallback1Response.ok || fallback1Response.status === 204) {
          return res.json({
            success: true,
            message: 'Position closed successfully',
          });
        }
      }

      // Return error immediately
      const errorText = await primaryResponse.text().catch(() => '');
      const errorMessage = errorText ? errorText.substring(0, 200) : 'Failed to close position';
      
      return res.status(primaryResponse.status || 500).json({
        success: false,
        message: errorMessage,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Failed to close position',
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
