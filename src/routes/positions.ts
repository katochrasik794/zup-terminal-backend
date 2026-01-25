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

    // Fetch open positions, pending orders, and closed positions from REST API
    const positionsUrl = `${LIVE_API_URL.replace(/\/$/, '')}/client/Positions`;
    const pendingOrdersUrl = `${LIVE_API_URL.replace(/\/$/, '')}/client/Orders`;
    // Use tradehistory/trades endpoint for closed positions (same as zuperior-terminal)
    // Build query params with accountId (both cases for compatibility) and date range
    const historyParams = new URLSearchParams();
    historyParams.set('accountId', accountId);
    historyParams.set('AccountId', accountId);
    // Add date range: 1970-01-01 to 2100-01-01 to get all trades
    historyParams.set('fromDate', '1970-01-01');
    historyParams.set('FromDate', '1970-01-01');
    historyParams.set('toDate', '2100-01-01');
    historyParams.set('ToDate', '2100-01-01');
    // Add pageSize to get all trades (optional, API may have defaults)
    historyParams.set('pageSize', '10000'); // Large page size to get all trades
    historyParams.set('PageSize', '10000');
    const closedPositionsUrl = `${LIVE_API_URL.replace(/\/$/, '')}/client/tradehistory/trades?${historyParams.toString()}`;
    
    console.log(`[Positions API] Fetching data from: ${positionsUrl}, ${pendingOrdersUrl}, ${closedPositionsUrl}`);

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    
    // TradeHistory endpoint uses Accept header only (same as zuperior-terminal)
    // The endpoint doesn't require Bearer token authentication
    const historyHeaders = {
      'Accept': 'application/json',
    };

    try {
      // Fetch all three types in parallel
      const [positionsRes, pendingRes, closedRes] = await Promise.allSettled([
        fetch(positionsUrl, { method: 'GET', headers }),
        fetch(pendingOrdersUrl, { method: 'GET', headers }),
        fetch(closedPositionsUrl, { method: 'GET', headers: historyHeaders }),
      ]);

      // Process open positions
      let positions: any[] = [];
      if (positionsRes.status === 'fulfilled' && positionsRes.value.ok) {
        const positionsData = await positionsRes.value.json() as any;
        positions = positionsData?.positions || positionsData?.Positions || positionsData?.data || positionsData?.Data || [];
        console.log(`[Positions API] Successfully fetched ${positions.length} open positions`);
      } else {
        console.warn(`[Positions API] Failed to fetch open positions:`, positionsRes.status === 'rejected' ? positionsRes.reason : positionsRes.value?.status);
      }

      // Process pending orders
      let pendingOrders: any[] = [];
      if (pendingRes.status === 'fulfilled' && pendingRes.value.ok) {
        const pendingData = await pendingRes.value.json() as any;
        pendingOrders = pendingData?.orders || pendingData?.Orders || pendingData?.data || pendingData?.Data || [];
        console.log(`[Positions API] Successfully fetched ${pendingOrders.length} pending orders`);
      } else {
        console.warn(`[Positions API] Failed to fetch pending orders:`, pendingRes.status === 'rejected' ? pendingRes.reason : pendingRes.value?.status);
      }

      // Process closed positions from tradehistory/trades endpoint (same as zuperior-terminal)
      let closedPositions: any[] = [];
      if (closedRes.status === 'fulfilled' && closedRes.value.ok) {
        const closedData = await closedRes.value.json() as any;
        // The tradehistory/trades endpoint returns trades array
        // Response format: { Items: [...] } or { data: [...] } or { trades: [...] } or just array
        let allTrades: any[] = [];
        
        if (Array.isArray(closedData)) {
          allTrades = closedData;
        } else if (closedData && typeof closedData === 'object') {
          // Try all possible response formats (same as zuperior-terminal)
          allTrades = closedData.Items || closedData.Data || closedData.data || 
                     closedData.trades || closedData.Trades || closedData.items ||
                     closedData.results || closedData.Results || 
                     closedData.closedTrades || closedData.ClosedTrades ||
                     closedData.tradeHistory || closedData.TradeHistory || [];
        }
        
        console.log(`[Positions API] Fetched ${allTrades.length} total trades from tradehistory endpoint`);
        
        // Apply filters (same as zuperior-terminal)
        // 1. Filter zero profit trades (default: true, can be controlled via env)
        const DEFAULT_FILTER_ZERO_PROFIT = process.env.TRADE_HISTORY_FILTER_ZERO_PROFIT !== 'false'; // Default true
        let filteredTrades = allTrades;
        
        if (DEFAULT_FILTER_ZERO_PROFIT) {
          filteredTrades = allTrades.filter((trade: any) => {
            const profit = trade.Profit ?? trade.profit ?? trade.PnL ?? trade.pnl ?? 0;
            const n = Number(profit);
            return Number.isFinite(n) && n !== 0;
          });
          console.log(`[Positions API] Filtered ${filteredTrades.length} non-zero P/L trades from ${allTrades.length} total`);
        }
        
        // 2. Filter invalid trades (same validation as zuperior-terminal)
        // A closed position must have:
        // - Valid OrderId or DealId > 0
        // - Non-empty Symbol
        // - Valid Price (close price) > 0
        // - Valid VolumeLots or Volume > 0
        closedPositions = filteredTrades.filter((trade: any) => {
          const orderId = trade.OrderId ?? trade.orderId ?? trade.DealId ?? trade.dealId ?? 0;
          const symbol = (trade.Symbol || trade.symbol || '').trim();
          const price = trade.Price ?? trade.price ?? trade.ClosePrice ?? trade.closePrice ?? trade.PriceClose ?? trade.priceClose ?? 0;
          const volumeLots = trade.VolumeLots ?? trade.volumeLots ?? trade.Volume ?? trade.volume ?? 0;
          
          const hasValidOrderId = Number(orderId) > 0 && !isNaN(Number(orderId));
          const hasValidSymbol = symbol && symbol.length > 0;
          const hasValidPrice = Number(price) > 0 && !isNaN(Number(price));
          const hasValidVolume = Number(volumeLots) > 0 && !isNaN(Number(volumeLots));
          
          return hasValidOrderId && hasValidSymbol && hasValidPrice && hasValidVolume;
        });
        
        console.log(`[Positions API] Successfully filtered ${closedPositions.length} valid closed positions`);
        if (closedPositions.length > 0) {
          // Log volume information for debugging
          const sampleTrade = closedPositions[0];
          console.log(`[Positions API] Closed positions sample with volume info:`, {
            OrderId: sampleTrade.OrderId ?? sampleTrade.orderId,
            DealId: sampleTrade.DealId ?? sampleTrade.dealId,
            Symbol: sampleTrade.Symbol ?? sampleTrade.symbol,
            VolumeLots: sampleTrade.VolumeLots ?? sampleTrade.volumeLots,
            Volume: sampleTrade.Volume ?? sampleTrade.volume,
            allVolumeFields: Object.keys(sampleTrade).filter(k => k.toLowerCase().includes('volume')),
            fullTrade: JSON.stringify(sampleTrade, null, 2)
          });
        }
      } else {
        const errorText = closedRes.status === 'rejected' 
          ? String(closedRes.reason)
          : (closedRes.value?.status ? `Status ${closedRes.value.status}` : 'Unknown error');
        console.warn(`[Positions API] Failed to fetch closed positions:`, errorText);
      }

      // Return all three types
      return res.json({
        success: true,
        message: 'Positions retrieved successfully',
        accountId: parseInt(accountId, 10),
        positions: positions,
        pendingOrders: pendingOrders,
        closedPositions: closedPositions,
        data: positions, // Also include in data for backward compatibility
      });

    } catch (fetchError: any) {
      console.error(`[Positions API] Error fetching positions:`, fetchError);
      return res.status(500).json({
        success: false,
        message: `Failed to fetch positions: ${fetchError.message}`,
        data: [],
        pendingOrders: [],
        closedPositions: [],
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
