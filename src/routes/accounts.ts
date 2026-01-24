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
    console.error('[Accounts API] Error:', error);
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

    console.log(`[Backend] Incoming balance request for accountId: ${accountId} (User: ${userId})`);

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
      console.warn(`[Backend] Account not found or unauthorized: ${accountId}`);
      return res.status(404).json({
        success: false,
        message: 'Account not found',
      });
    }

    const balanceUrl = `https://metaapi.zuperior.com/api/Users/${accountId}/GetClientBalance`;
    console.log(`[Backend] Proxying to MetaAPI: ${balanceUrl}`);

    try {
      const response = await fetch(balanceUrl);
      const result = await response.json() as any;

      if (result.Success && result.Data) {
        console.log(`[Backend] Success for ${accountId}: Equity=${result.Data.Equity}`);
        return res.json({
          success: true,
          data: result.Data
        });
      } else {
        console.error(`[Backend] MetaAPI Error for ${accountId}:`, result.Message || result.Error);
        return res.status(400).json({
          success: false,
          message: result.Message || 'Failed to fetch balance from MetaAPI'
        });
      }
    } catch (err) {
      console.error(`[Backend] Fetch Error to MetaAPI:`, err);
      return res.status(500).json({
        success: false,
        message: 'Internal server error while fetching balance'
      });
    }
  } catch (error) {
    console.error('[Account Balance API] Global Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch account balance',
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

    const profileUrl = `https://metaapi.zuperior.com/api/Users/${accountId}/GetClientProfile`;

    try {
      const response = await fetch(profileUrl);
      const result = await response.json() as any;

      if (result.Success && result.Data) {
        return res.json({
          success: true,
          data: result.Data
        });
      } else {
        return res.status(400).json({
          success: false,
          message: result.Message || 'Failed to fetch profile from MetaAPI'
        });
      }
    } catch (err) {
      console.error(`[Backend Profile] Fetch Error:`, err);
      return res.status(500).json({
        success: false,
        message: 'Internal server error while fetching profile'
      });
    }
  } catch (error) {
    console.error('[Account Profile API] Global Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch account profile',
    });
  }
});

export default router;
