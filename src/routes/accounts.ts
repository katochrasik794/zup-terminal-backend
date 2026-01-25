import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db';
import { authenticateToken } from '../middleware/auth';

const router = Router();

/**
 * GET /api/accounts
 * Get all MT5 accounts for the authenticated user
 */
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const mt5Accounts = await prisma.mT5Account.findMany({
      where: {
        userId: userId,
        archived: false,
      },
      select: {
        id: true,
        accountId: true,
        accountType: true,
        group: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    let defaultAccount: { mt5AccountId: string } | null = null;
    const anyPrisma = prisma as any;
    if (anyPrisma?.defaultMT5Account?.findUnique) {
      try {
        defaultAccount = await anyPrisma.defaultMT5Account.findUnique({
          where: { userId },
          select: { mt5AccountId: true },
        });
      } catch {
        defaultAccount = null;
      }
    }

    const formattedAccounts = mt5Accounts.map(account => ({
      id: account.id,
      accountId: account.accountId,
      displayAccountId: `#${account.accountId}`,
      accountType: account.accountType || 'Live',
      group: account.group || '',
      linkedAt: account.createdAt.toISOString(),
    }));

    const fallbackDefault = formattedAccounts[0]?.accountId;
    const defaultAccountId = defaultAccount?.mt5AccountId || fallbackDefault;

    return res.json({
      success: true,
      data: {
        accounts: formattedAccounts,
        defaultAccountId,
        totalAccounts: formattedAccounts.length,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch accounts',
    });
  }
});

/**
 * GET /api/accounts/:accountId/balance
 * Get balance data for a specific account
 */
router.get('/:accountId/balance', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { accountId } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const mt5Account = await prisma.mT5Account.findFirst({
      where: {
        accountId: accountId as string,
        userId: userId,
        archived: false,
      }
    });

    if (!mt5Account) {
      return res.status(404).json({
        success: false,
        message: 'Account not found',
      });
    }

    const balanceUrl = `https://metaapi.zuperior.com/api/Users/${accountId}/GetClientBalance`;

    try {
      const response = await fetch(balanceUrl);
      const result = await response.json() as any;

      if (result.Success && result.Data) {
        return res.json({
          success: true,
          data: result.Data
        });
      } else {
        return res.status(400).json({
          success: false,
          message: result.Message || 'Failed to fetch balance from MetaAPI'
        });
      }
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Internal server error while fetching balance'
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch account balance',
    });
  }
});

/**
 * POST /api/accounts/:accountId/metaapi-login
 * Authenticate with MetaAPI and get access token for SignalR
 * 
 * IMPORTANT: This route must be defined BEFORE /:accountId/profile to avoid route conflicts
 */
router.post('/:accountId/metaapi-login', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const accountId = String(req.params.accountId);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    // Get MT5 account with password
    const mt5Account = await prisma.mT5Account.findFirst({
      where: {
        accountId: accountId,
        userId: userId,
        archived: false,
      },
      select: {
        id: true,
        accountId: true,
        password: true,
        userId: true,
      }
    });

    if (!mt5Account || !mt5Account.password) {
      return res.status(404).json({
        success: false,
        message: 'Account not found or password not configured',
      });
    }

    // Trim password to remove any whitespace
    const cleanedPassword = mt5Account.password.trim();

    // Authenticate with MetaAPI
    // LIVE_API_URL should already include /api (e.g., https://metaapi.zuperior.com/api)
    const LIVE_API_URL = process.env.LIVE_API_URL || 'https://metaapi.zuperior.com/api';
    // CLIENT_LOGIN_PATH should be /client/ClientAuth/login (without /api prefix)
    // If env has /api/client/ClientAuth/login, we'll strip the /api part
    let CLIENT_LOGIN_PATH = process.env.CLIENT_LOGIN_PATH || '/client/ClientAuth/login';
    // Remove /api prefix if present (since LIVE_API_URL already has it)
    if (CLIENT_LOGIN_PATH.startsWith('/api/')) {
      CLIENT_LOGIN_PATH = CLIENT_LOGIN_PATH.replace(/^\/api/, '');
    }
    const loginUrl = CLIENT_LOGIN_PATH.startsWith('http') 
      ? CLIENT_LOGIN_PATH 
      : CLIENT_LOGIN_PATH.startsWith('/')
        ? `${LIVE_API_URL.replace(/\/$/, '')}${CLIENT_LOGIN_PATH}`
        : `${LIVE_API_URL.replace(/\/$/, '')}/${CLIENT_LOGIN_PATH}`;

    // Parse accountId as integer
    const accountIdInt = parseInt(accountId, 10);
    if (isNaN(accountIdInt)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid account ID format',
      });
    }

    // Use device ID format matching curl example
    const deviceId = `web_device_${Date.now()}`;
    const deviceType = 'web';

    try {
      const requestBody = {
        AccountId: accountIdInt,
        Password: cleanedPassword,
        DeviceId: deviceId,
        DeviceType: deviceType,
      };

      const loginResponse = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (loginResponse.ok) {
        const loginData = await loginResponse.json() as any;
        
        // Check for Token (capital T) first, as that's what the API returns
        const accessToken = loginData?.Token || loginData?.accessToken || loginData?.AccessToken || loginData?.data?.accessToken || loginData?.token;

        if (accessToken) {
          return res.json({
            success: true,
            data: {
              accessToken,
              accountId: accountId,
            },
          });
        }
      }

      return res.status(401).json({
        success: false,
        message: 'Failed to authenticate with MetaAPI',
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Failed to authenticate with MetaAPI',
      });
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

/**
 * GET /api/accounts/:accountId/profile
 * Get full client profile data for a specific account
 */
router.get('/:accountId/profile', authenticateToken, async (req: Request, res: Response) => {
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
        accountId: accountId as string,
        userId: userId,
        archived: false,
      },
      select: {
        accountId: true,
        password: true,
        balance: true,
        equity: true,
        margin: true,
        marginFree: true,
        marginLevel: true,
        profit: true,
        credit: true,
        leverage: true,
        nameOnAccount: true,
        currency: true,
        group: true,
        accountType: true,
      }
    });

    if (!mt5Account) {
      return res.status(404).json({
        success: false,
        message: 'Account not found',
      });
    }

    if (!mt5Account.password) {
      // Return database data if no password
      const accountType = (mt5Account.group || '').toLowerCase().includes('demo') ? 'Demo' : 'Live';
      return res.json({
        success: true,
        data: {
          Balance: mt5Account.balance ?? 0,
          balance: mt5Account.balance ?? 0,
          Equity: mt5Account.equity ?? 0,
          equity: mt5Account.equity ?? 0,
          Margin: mt5Account.margin ?? 0,
          margin: mt5Account.margin ?? 0,
          MarginUsed: mt5Account.margin ?? 0,
          marginUsed: mt5Account.margin ?? 0,
          FreeMargin: mt5Account.marginFree ?? 0,
          freeMargin: mt5Account.marginFree ?? 0,
          MarginLevel: mt5Account.marginLevel ?? 0,
          marginLevel: mt5Account.marginLevel ?? 0,
          Profit: mt5Account.profit ?? 0,
          profit: mt5Account.profit ?? 0,
          Credit: mt5Account.credit ?? 0,
          credit: mt5Account.credit ?? 0,
          Leverage: mt5Account.leverage ? `1:${mt5Account.leverage}` : '1:200',
          leverage: mt5Account.leverage ? `1:${mt5Account.leverage}` : '1:200',
          Name: mt5Account.nameOnAccount || 'Account',
          name: mt5Account.nameOnAccount || 'Account',
          Group: mt5Account.group || '',
          group: mt5Account.group || '',
          AccountType: accountType,
          accountType: accountType,
          Currency: mt5Account.currency || 'USD',
          currency: mt5Account.currency || 'USD',
        }
      });
    }

    // Get client access token from MetaAPI
    const LIVE_API_URL = process.env.LIVE_API_URL || 'https://metaapi.zuperior.com/api';
    const CLIENT_LOGIN_PATH = process.env.CLIENT_LOGIN_PATH || '/client/ClientAuth/login';
    
    // Remove /api prefix if present (since LIVE_API_URL already has it)
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
        DeviceId: `web_device_${Date.now()}`,
        DeviceType: 'web',
      };
      
      const loginResponse = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginPayload),
      });

      if (loginResponse.ok) {
        const loginData = await loginResponse.json() as any;
        // Check for Token (capital T) first, as that's what the API returns
        accessToken = loginData?.Token || loginData?.accessToken || loginData?.AccessToken || loginData?.token || null;
      }
    } catch (err) {
      // Silent fail - will use database data
    }

    // Try to fetch from MetaAPI if we have a token
    if (accessToken) {
      const profileUrl = `https://metaapi.zuperior.com/api/Users/${accountId}/GetClientBalance`;
      
      try {
        const response = await fetch(profileUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'AccountId': accountId,
            'Content-Type': 'application/json',
          },
        });

        if (response.ok) {
          const result = await response.json() as any;
          
          // Handle different response formats
          let balanceData = result?.data || result?.Data || result;
          if (balanceData && typeof balanceData === 'object' && !balanceData.Balance && !balanceData.balance) {
            balanceData = balanceData.result || balanceData.response || balanceData;
          }

          if (balanceData && (balanceData.Balance !== undefined || balanceData.balance !== undefined)) {
            // Merge with database metadata
            const accountType = (mt5Account.group || '').toLowerCase().includes('demo') ? 'Demo' : 'Live';
            return res.json({
              success: true,
              data: {
                Balance: balanceData.Balance ?? balanceData.balance ?? mt5Account.balance ?? 0,
                balance: balanceData.Balance ?? balanceData.balance ?? mt5Account.balance ?? 0,
                Equity: balanceData.Equity ?? balanceData.equity ?? mt5Account.equity ?? 0,
                equity: balanceData.Equity ?? balanceData.equity ?? mt5Account.equity ?? 0,
                Margin: balanceData.Margin ?? balanceData.margin ?? mt5Account.margin ?? 0,
                margin: balanceData.Margin ?? balanceData.margin ?? mt5Account.margin ?? 0,
                MarginUsed: balanceData.MarginUsed ?? balanceData.marginUsed ?? balanceData.Margin ?? balanceData.margin ?? mt5Account.margin ?? 0,
                marginUsed: balanceData.MarginUsed ?? balanceData.marginUsed ?? balanceData.Margin ?? balanceData.margin ?? mt5Account.margin ?? 0,
                FreeMargin: balanceData.FreeMargin ?? balanceData.freeMargin ?? mt5Account.marginFree ?? 0,
                freeMargin: balanceData.FreeMargin ?? balanceData.freeMargin ?? mt5Account.marginFree ?? 0,
                MarginLevel: balanceData.MarginLevel ?? balanceData.marginLevel ?? mt5Account.marginLevel ?? 0,
                marginLevel: balanceData.MarginLevel ?? balanceData.marginLevel ?? mt5Account.marginLevel ?? 0,
                Profit: balanceData.Profit ?? balanceData.profit ?? mt5Account.profit ?? 0,
                profit: balanceData.Profit ?? balanceData.profit ?? mt5Account.profit ?? 0,
                Credit: balanceData.Credit ?? balanceData.credit ?? mt5Account.credit ?? 0,
                credit: balanceData.Credit ?? balanceData.credit ?? mt5Account.credit ?? 0,
                Leverage: balanceData.Leverage ?? balanceData.leverage ?? (mt5Account.leverage ? `1:${mt5Account.leverage}` : '1:200'),
                leverage: balanceData.Leverage ?? balanceData.leverage ?? (mt5Account.leverage ? `1:${mt5Account.leverage}` : '1:200'),
                Name: (balanceData.Name ?? balanceData.name ?? mt5Account.nameOnAccount) || 'Account',
                name: (balanceData.Name ?? balanceData.name ?? mt5Account.nameOnAccount) || 'Account',
                Group: mt5Account.group || '',
                group: mt5Account.group || '',
                AccountType: accountType,
                accountType: accountType,
                Currency: (balanceData.Currency ?? balanceData.currency ?? mt5Account.currency) || 'USD',
                currency: (balanceData.Currency ?? balanceData.currency ?? mt5Account.currency) || 'USD',
              }
            });
          }
        }
      } catch (err) {
        // Silent fail - use database data
      }
    }

    // Fallback to database data
    const accountType = (mt5Account.group || '').toLowerCase().includes('demo') ? 'Demo' : 'Live';
    return res.json({
      success: true,
      data: {
        Balance: mt5Account.balance ?? 0,
        balance: mt5Account.balance ?? 0,
        Equity: mt5Account.equity ?? 0,
        equity: mt5Account.equity ?? 0,
        Margin: mt5Account.margin ?? 0,
        margin: mt5Account.margin ?? 0,
        MarginUsed: mt5Account.margin ?? 0,
        marginUsed: mt5Account.margin ?? 0,
        FreeMargin: mt5Account.marginFree ?? 0,
        freeMargin: mt5Account.marginFree ?? 0,
        MarginLevel: mt5Account.marginLevel ?? 0,
        marginLevel: mt5Account.marginLevel ?? 0,
        Profit: mt5Account.profit ?? 0,
        profit: mt5Account.profit ?? 0,
        Credit: mt5Account.credit ?? 0,
        credit: mt5Account.credit ?? 0,
        Leverage: mt5Account.leverage ? `1:${mt5Account.leverage}` : '1:200',
        leverage: mt5Account.leverage ? `1:${mt5Account.leverage}` : '1:200',
        Name: mt5Account.nameOnAccount || 'Account',
        name: mt5Account.nameOnAccount || 'Account',
        Group: mt5Account.group || '',
        group: mt5Account.group || '',
        AccountType: accountType,
        accountType: accountType,
        Currency: mt5Account.currency || 'USD',
        currency: mt5Account.currency || 'USD',
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch account profile',
    });
  }
});

export default router;
