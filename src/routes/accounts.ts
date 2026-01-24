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

    // Find all MT5 accounts for the user (exclude archived accounts)
    const mt5Accounts = await prisma.mT5Account.findMany({
      where: {
        userId: userId,
        archived: false,
      },
      select: {
        id: true,
        accountId: true,
        accountType: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // Find default account for user (if any)
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

    // Format accounts with # prefix
    const formattedAccounts = mt5Accounts.map(account => ({
      id: account.id,
      accountId: account.accountId,
      displayAccountId: `#${account.accountId}`,
      accountType: account.accountType || 'Live',
      linkedAt: account.createdAt.toISOString(),
    }));

    // Determine default: DB default if exists; fallback to first
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

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    // Verify the account belongs to the user
    const mt5Account = await prisma.mT5Account.findFirst({
      where: {
        accountId: accountId,
        userId: userId,
        archived: false,
      },
      select: {
        accountId: true,
        balance: true,
        equity: true,
        margin: true,
        marginFree: true,
        marginLevel: true,
        profit: true,
        credit: true,
        leverage: true,
        nameOnAccount: true,
        group: true,
        accountType: true,
        currency: true,
      },
    });

    if (!mt5Account) {
      return res.status(404).json({
        success: false,
        message: 'Account not found',
      });
    }

    // Determine account type
    const groupLower = (mt5Account.group || '').toLowerCase();
    let accountType: 'Demo' | 'Live' = 'Live';
    if (groupLower.includes('demo')) {
      accountType = 'Demo';
    } else if (groupLower.includes('live')) {
      accountType = 'Live';
    } else {
      accountType = (mt5Account.accountType === 'Live' ? 'Live' : 'Demo') as 'Demo' | 'Live';
    }

    // Handle null/undefined values from database
    const balance = mt5Account.balance != null ? Number(mt5Account.balance) : 0;
    const equity = mt5Account.equity != null ? Number(mt5Account.equity) : balance; // Default to balance if equity is null
    const margin = mt5Account.margin != null ? Number(mt5Account.margin) : 0;
    const freeMargin = mt5Account.marginFree != null ? Number(mt5Account.marginFree) : (equity - margin);
    const credit = mt5Account.credit != null ? Number(mt5Account.credit) : 0;
    const totalPL = equity - balance;
    const profit = mt5Account.profit != null ? Number(mt5Account.profit) : totalPL;

    const balanceData = {
      balance,
      equity,
      margin,
      freeMargin,
      marginLevel: Number(mt5Account.marginLevel) || 0,
      profit,
      leverage: mt5Account.leverage ? `1:${mt5Account.leverage}` : '1:200',
      totalPL: parseFloat(totalPL.toFixed(2)),
      credit,
      accountType,
      name: mt5Account.nameOnAccount || 'Test',
      accountGroup: (mt5Account.group || '').split('\\').pop()?.toLowerCase() || 'standard',
      groupName: mt5Account.group || '',
    };

    return res.json({
      success: true,
      data: balanceData,
    });
  } catch (error) {
    console.error('[Account Balance API] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch account balance',
    });
  }
});

export default router;
