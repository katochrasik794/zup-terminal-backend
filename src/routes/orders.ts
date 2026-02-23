import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { tokenCache } from '../lib/tokenCache.js';

const router = Router();

// Test route to verify router is working
router.get('/test', (req: Request, res: Response) => {
  res.json({ success: true, message: 'Orders router is working' });
});

/**
 * Helper to determine the volume for pending orders sent to the C# MT5 API bridge.
 * The broker's bridge expects exact lots (float) for most symbols (Forex, Metals),
 * but expects lots * 100 for Crypto symbols like BTC/ETH.
 */
function getPendingOrderVolume(symbol: string, volume: number): number {
  const sym = (symbol || '').toUpperCase();
  if (sym.includes('BTC') || sym.includes('ETH')) {
    return Math.round(parseFloat(String(volume)) * 100);
  }
  // The broker's bridge puts a 10x multiplier natively on Forex pending orders.
  // So to place 0.01 lots, we must send 0.001.
  return Number((parseFloat(String(volume)) / 10).toFixed(4));
}

/**
 * POST /api/orders/market
 * Place a market order (buy or sell)
 */
router.post('/market', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { accountId, symbol, side, volume, stopLoss, takeProfit } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    if (!accountId || !symbol || !side || !volume) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: accountId, symbol, side, volume',
      });
    }

    // Validate side
    if (side !== 'buy' && side !== 'sell') {
      return res.status(400).json({
        success: false,
        message: 'Invalid side. Must be "buy" or "sell"',
      });
    }

    // Get MT5 account from database
    const mt5Account = await prisma.mT5Account.findFirst({
      where: {
        userId: userId,
        OR: [
          { id: String(accountId) },
          { accountId: String(accountId) }
        ],
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

    let accessToken: string | null = tokenCache.get(String(accountId));
    const actualMt5AccountId = mt5Account.accountId;
    try {
      if (!accessToken) {
        const loginPayload = {
          AccountId: parseInt(actualMt5AccountId, 10),
          Password: mt5Account.password?.trim() || '',
          DeviceId: `web_order_${userId}_${Date.now()}`,
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
          if (accessToken) {
            tokenCache.set(String(accountId), accessToken, 3600);
          }
        }
      }
    } catch (err) {
      console.error('[Orders] MetaAPI login error:', err);
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

    // Place market order via MetaAPI
    // Normalize symbol (remove / if present)
    const normalizedSymbol = symbol.replace('/', '');

    // The MetaAPI C# backend expects volume * 100 for ALL symbols in Market Orders
    const volumeInUnits = Math.round(parseFloat(volume) * 100);

    // Use different endpoints for buy vs sell (as per zuperior-terminal)
    // Buy: /client/trade, Sell: /client/trade-sell
    // The endpoint itself determines buy vs sell, no Action field needed
    // AccountId is passed as query parameter, not in body
    const tradePath = side === 'sell' ? 'trade-sell' : 'trade';
    const orderUrl = `${LIVE_API_URL.replace(/\/$/, '')}/client/${tradePath}?account_id=${encodeURIComponent(accountId)}`;

    // Build payload matching zuperior-terminal format (lowercase field names, no Action/AccountId fields)
    const orderPayload: any = {
      symbol: normalizedSymbol,
      volume: volumeInUnits,
      price: 0, // Market orders use price: 0
    };

    // Add TP/SL if provided (use 0 if not set, matching zuperior-terminal)
    const hasSL = stopLoss !== undefined && stopLoss !== null && parseFloat(String(stopLoss)) > 0;
    const hasTP = takeProfit !== undefined && takeProfit !== null && parseFloat(String(takeProfit)) > 0;
    orderPayload.stopLoss = hasSL ? parseFloat(String(stopLoss)) : 0;
    orderPayload.takeProfit = hasTP ? parseFloat(String(takeProfit)) : 0;

    // Add comment (optional)
    orderPayload.comment = side === 'sell' ? 'Sell' : 'Buy';

    try {
      const orderResponse = await fetch(orderUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(orderPayload),
      });

      let orderData: any;
      try {
        orderData = await orderResponse.json();
      } catch (e) {
        // If response is not JSON, use text
        const text = await orderResponse.text();
        orderData = { message: text || 'Unknown error' };
      }

      if (!orderResponse.ok) {
        // Handle 10012 return code (Request Placed) - treated as success in terminal
        const returnCode = orderData?.returnCode || orderData?.ReturnCode;
        if (returnCode === 10012) {
          // console.log('[Orders] Market order: Request Placed (10012) - treating as success');
          return res.json({
            success: true,
            data: orderData,
            message: 'Order initiated. Processing on server.',
            status: 'placed'
          });
        }

        console.error('[Orders] Market order failed:', {
          status: orderResponse.status,
          statusText: orderResponse.statusText,
          data: orderData,
          payload: orderPayload,
        });
        return res.status(orderResponse.status).json({
          success: false,
          message: orderData?.message || orderData?.Message || orderData?.error || 'Failed to place market order',
          error: orderData,
        });
      }

      // console.log('[Orders] Market order placed successfully:', orderData);

      return res.json({
        success: true,
        data: orderData,
      });
    } catch (err) {
      console.error('[Orders] Market order error:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to place market order',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  } catch (error) {
    console.error('[Orders] Market order error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/orders/pending
 * Place a pending order (limit or stop)
 */
router.post('/pending', authenticateToken, async (req: Request, res: Response) => {
  // console.log('[Orders] POST /api/orders/pending hit', { body: req.body });
  try {
    const userId = req.user?.userId;
    const { accountId, symbol, side, volume, price, orderType, stopLoss, takeProfit } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    if (!accountId || !symbol || !side || !volume || !price || !orderType) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: accountId, symbol, side, volume, price, orderType',
      });
    }

    // Validate side
    if (side !== 'buy' && side !== 'sell') {
      return res.status(400).json({
        success: false,
        message: 'Invalid side. Must be "buy" or "sell"',
      });
    }

    // Validate orderType: 'limit' = Buy Limit (2) or Sell Limit (3), 'stop' = Buy Stop (4) or Sell Stop (5)
    // Map: buy + limit = 2, sell + limit = 3, buy + stop = 4, sell + stop = 5
    let type: number;
    if (side === 'buy' && orderType === 'limit') {
      type = 2; // Buy Limit
    } else if (side === 'sell' && orderType === 'limit') {
      type = 3; // Sell Limit
    } else if (side === 'buy' && orderType === 'stop') {
      type = 4; // Buy Stop
    } else if (side === 'sell' && orderType === 'stop') {
      type = 5; // Sell Stop
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid orderType. Must be "limit" or "stop"',
      });
    }

    // Get MT5 account from database
    const mt5Account = await prisma.mT5Account.findFirst({
      where: {
        userId: userId,
        OR: [
          { id: String(accountId) },
          { accountId: String(accountId) }
        ],
        archived: false,
      },
    });

    if (!mt5Account) {
      return res.status(404).json({
        success: false,
        message: 'MT5 account not found',
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

    let accessToken: string | null = tokenCache.get(String(accountId));
    const actualMt5AccountId = mt5Account.accountId;
    try {
      if (!accessToken) {
        const loginPayload = {
          AccountId: parseInt(actualMt5AccountId, 10),
          Password: mt5Account.password?.trim() || '',
          DeviceId: `web_pending_${userId}_${Date.now()}`,
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
          if (accessToken) {
            tokenCache.set(String(accountId), accessToken, 3600);
          }
        }
      }
    } catch (err) {
      console.error('[Orders] MetaAPI login error:', err);
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

    // Place pending order via MetaAPI
    // Use symbol as-is (matching zuperior-terminal - they use String(symbol) without normalization)
    const symbolStr = String(symbol);

    // The MetaAPI C# backend expects exact lots for Forex/Metals Pending Orders, but 100x for Crypto Pending
    const volumeToSend = getPendingOrderVolume(symbolStr, parseFloat(volume));

    // Build payload matching zuperior-terminal format exactly
    // Always include all fields, even if 0 (matching zuperior-terminal)
    const orderPayload: any = {
      Symbol: symbolStr,
      Price: Number(price),
      Volume: volumeToSend,
      StopLoss: Number(stopLoss || 0),
      TakeProfit: Number(takeProfit || 0),
      Expiration: '0001-01-01T00:00:00', // Default expiration (no expiration)
      Comment: '', // Empty comment
    };

    // Use specific endpoints for each order type (matching zuperior-terminal)
    const endpointMap: Record<number, string> = {
      2: 'buy-limit',    // Buy Limit
      3: 'sell-limit',   // Sell Limit
      4: 'buy-stop',     // Buy Stop
      5: 'sell-stop',    // Sell Stop
    };

    const endpoint = endpointMap[type];
    if (!endpoint) {
      return res.status(400).json({
        success: false,
        message: `Invalid order type: ${type}`,
      });
    }

    // Add account_id as query parameter (matching zuperior-terminal pattern)
    const orderUrl = `${LIVE_API_URL.replace(/\/$/, '')}/client/${endpoint}?account_id=${encodeURIComponent(accountId)}`;

    // Log the request for debugging (especially for stop orders)
    // console.log('[Orders] Placing pending order:', {
    //   endpoint,
    //   url: orderUrl,
    //   payload: orderPayload,
    //   orderType: orderType,
    //   side: side,
    // });

    try {
      const orderResponse = await fetch(orderUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(orderPayload),
      });

      const responseText = await orderResponse.text().catch(() => '');
      let orderData: any = null;

      if (responseText && responseText.trim()) {
        try {
          orderData = JSON.parse(responseText);
        } catch (parseErr) {
          // If JSON parsing fails, use the raw text
          orderData = {
            message: responseText || orderResponse.statusText || 'Failed to parse response',
            rawResponse: responseText,
          };
        }
      } else {
        // Empty response
        if (orderResponse.ok) {
          return res.json({
            success: true,
            data: {},
          });
        } else {
          orderData = { message: orderResponse.statusText || 'Empty response from server' };
        }
      }

      // Log the full response for debugging
      // console.log('[Orders] API Response:', {
      //   status: orderResponse.status,
      //   statusText: orderResponse.statusText,
      //   endpoint,
      //   responseData: orderData,
      // });

      if (!orderResponse.ok) {
        // Handle 10012 return code (Request Placed) - treated as success in terminal
        const returnCode = orderData?.returnCode || orderData?.ReturnCode;
        if (returnCode === 10012) {
          // console.log('[Orders] Pending order: Request Placed (10012) - treating as success');
          return res.json({
            success: true,
            data: orderData,
            message: 'Order initiated. Processing on server.',
            status: 'placed'
          });
        }

        console.error('[Orders] Pending order API error:', {
          status: orderResponse.status,
          statusText: orderResponse.statusText,
          endpoint,
          orderType: orderType,
          side: side,
          responseData: orderData,
          payload: orderPayload,
        });

        // Extract error message from various possible fields
        const errorMessage = orderData?.message ||
          orderData?.Message ||
          orderData?.error ||
          orderData?.Error ||
          orderData?.ErrorMessage ||
          orderData?.errorMessage ||
          orderResponse.statusText ||
          'Failed to place pending order';

        return res.status(orderResponse.status).json({
          success: false,
          message: errorMessage,
          error: orderData,
        });
      }

      return res.json({
        success: true,
        data: orderData,
      });
    } catch (err) {
      console.error('[Orders] Pending order error:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to place pending order',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  } catch (error) {
    console.error('[Orders] Pending order error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * PUT /api/orders/pending/:orderId
 * Modify a pending order
 */
router.put('/pending/:orderId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { orderId } = req.params;
    const { accountId, price, stopLoss, takeProfit, volume } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    if (!accountId || !orderId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: accountId, orderId',
      });
    }

    // Get MT5 account from database
    const mt5Account = await prisma.mT5Account.findFirst({
      where: {
        userId: userId,
        OR: [
          { id: String(accountId) },
          { accountId: String(accountId) }
        ],
        archived: false,
      },
    });

    if (!mt5Account) {
      return res.status(404).json({
        success: false,
        message: 'MT5 account not found',
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

    let accessToken: string | null = tokenCache.get(String(accountId));
    const actualMt5AccountId = mt5Account.accountId;
    try {
      if (!accessToken) {
        const loginPayload = {
          AccountId: parseInt(actualMt5AccountId, 10),
          Password: mt5Account.password?.trim() || '',
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
          if (accessToken) {
            tokenCache.set(String(accountId), accessToken, 3600);
          }
        }
      }
    } catch (err) {
      console.error('[Orders] MetaAPI login error:', err);
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

    // Modify pending order via MetaAPI
    const modifyPayload: any = {
      OrderId: parseInt(Array.isArray(orderId) ? orderId[0] : orderId, 10),
    };

    if (price !== undefined) {
      modifyPayload.Price = parseFloat(price);
    }
    if (volume !== undefined) {
      // The MetaAPI C# backend expects exact lots for Forex/Metals, but 100x for Crypto
      // If symbol is missing from modify payload, we can't reliably adjust volume here easily without fetching order first,
      // but usually modify doesn't change volume, or passes it correctly. Assuming 1 isn't safe if it's crypto.
      // modify endpoint likely doesn't support changing volume anyway, but if it does:
      modifyPayload.Volume = Number(volume); // Let's pass it exactly as lots as fallback
    }
    if (takeProfit !== undefined) {
      modifyPayload.TakeProfit = takeProfit === null || takeProfit === 0 ? 0 : parseFloat(takeProfit);
    }
    if (stopLoss !== undefined) {
      modifyPayload.StopLoss = stopLoss === null || stopLoss === 0 ? 0 : parseFloat(stopLoss);
    }

    const modifyUrl = `${LIVE_API_URL.replace(/\/$/, '')}/client/Orders/ModifyPendingOrder`;

    try {
      const modifyResponse = await fetch(modifyUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(modifyPayload),
      });

      const modifyData = await modifyResponse.json();

      if (!modifyResponse.ok) {
        return res.status(modifyResponse.status).json({
          success: false,
          message: (modifyData as any)?.message || (modifyData as any)?.Message || 'Failed to modify pending order',
          error: modifyData,
        });
      }

      return res.json({
        success: true,
        data: modifyData,
      });
    } catch (err) {
      console.error('[Orders] Modify order error:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to modify pending order',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  } catch (error) {
    console.error('[Orders] Modify order error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
