import express, { Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

// In-memory storage for price alerts (replace with database in production)
interface PriceAlert {
  id: string;
  userId: string;
  accountId: string;
  symbol: string;
  targetPrice: number;
  condition: 'above' | 'below'; // 'above' means alert when price goes above targetPrice, 'below' means alert when price goes below
  isActive: boolean;
  createdAt: string;
  triggeredAt?: string;
  notificationSent: boolean;
}

// In-memory storage (replace with database)
const alerts: Map<string, PriceAlert> = new Map();
let alertIdCounter = 1;

/**
 * GET /api/alerts
 * Get all price alerts for the authenticated user
 */
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const accountId = req.query.accountId as string;
    
    // Filter alerts by userId and optionally accountId
    const userAlerts = Array.from(alerts.values()).filter(alert => {
      if (alert.userId !== userId) return false;
      if (accountId && alert.accountId !== accountId) return false;
      return true;
    });

    res.json({
      success: true,
      data: userAlerts,
    });
  } catch (error: any) {
    console.error('[GET /api/alerts] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch alerts',
      error: error.message,
    });
  }
});

/**
 * POST /api/alerts
 * Create a new price alert
 */
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const { accountId, symbol, targetPrice, condition } = req.body;

    // Validation
    if (!accountId || !symbol || !targetPrice || !condition) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: accountId, symbol, targetPrice, condition',
      });
    }

    if (condition !== 'above' && condition !== 'below') {
      return res.status(400).json({
        success: false,
        message: 'condition must be either "above" or "below"',
      });
    }

    if (typeof targetPrice !== 'number' || targetPrice <= 0) {
      return res.status(400).json({
        success: false,
        message: 'targetPrice must be a positive number',
      });
    }

    // Create alert
    const alert: PriceAlert = {
      id: `alert_${alertIdCounter++}`,
      userId,
      accountId,
      symbol: symbol.toUpperCase(),
      targetPrice,
      condition,
      isActive: true,
      createdAt: new Date().toISOString(),
      notificationSent: false,
    };

    alerts.set(alert.id, alert);

    res.status(201).json({
      success: true,
      data: alert,
    });
  } catch (error: any) {
    console.error('[POST /api/alerts] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create alert',
      error: error.message,
    });
  }
});

/**
 * PUT /api/alerts/:id
 * Update an existing price alert
 */
router.put('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const { id } = req.params;
    const alert = alerts.get(id);

    if (!alert) {
      return res.status(404).json({
        success: false,
        message: 'Alert not found',
      });
    }

    if (alert.userId !== userId) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update this alert',
      });
    }

    // Update allowed fields
    const { targetPrice, condition, isActive } = req.body;

    if (targetPrice !== undefined) {
      if (typeof targetPrice !== 'number' || targetPrice <= 0) {
        return res.status(400).json({
          success: false,
          message: 'targetPrice must be a positive number',
        });
      }
      alert.targetPrice = targetPrice;
    }

    if (condition !== undefined) {
      if (condition !== 'above' && condition !== 'below') {
        return res.status(400).json({
          success: false,
          message: 'condition must be either "above" or "below"',
        });
      }
      alert.condition = condition;
    }

    if (isActive !== undefined) {
      alert.isActive = Boolean(isActive);
    }

    alerts.set(id, alert);

    res.json({
      success: true,
      data: alert,
    });
  } catch (error: any) {
    console.error('[PUT /api/alerts/:id] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update alert',
      error: error.message,
    });
  }
});

/**
 * DELETE /api/alerts/:id
 * Delete a price alert
 */
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const { id } = req.params;
    const alert = alerts.get(id);

    if (!alert) {
      return res.status(404).json({
        success: false,
        message: 'Alert not found',
      });
    }

    if (alert.userId !== userId) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to delete this alert',
      });
    }

    alerts.delete(id);

    res.json({
      success: true,
      message: 'Alert deleted successfully',
    });
  } catch (error: any) {
    console.error('[DELETE /api/alerts/:id] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete alert',
      error: error.message,
    });
  }
});

/**
 * POST /api/alerts/:id/trigger
 * Mark an alert as triggered (called by monitoring service)
 */
router.post('/:id/trigger', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const alert = alerts.get(id);

    if (!alert) {
      return res.status(404).json({
        success: false,
        message: 'Alert not found',
      });
    }

    if (!alert.notificationSent) {
      alert.triggeredAt = new Date().toISOString();
      alert.notificationSent = true;
      // Optionally deactivate after triggering
      // alert.isActive = false;
      alerts.set(id, alert);
    }

    res.json({
      success: true,
      data: alert,
    });
  } catch (error: any) {
    console.error('[POST /api/alerts/:id/trigger] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger alert',
      error: error.message,
    });
  }
});

export default router;

