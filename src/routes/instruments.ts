
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/instruments
 * Get all instruments filtered by MT5 account group
 */
router.get('/', authenticateToken, async (req: Request, res: Response) => {
    try {
        const userId = req.user?.userId;
        const { group, accountId } = req.query;

        if (!group || typeof group !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'Account group is required',
            });
        }

        let targetGroup = group;
        if (group.includes('\\Bbook\\Pro\\')) {
            targetGroup = group.replace('\\Bbook\\Pro\\', '\\LP\\Pro\\');
        } else if (group.includes('\\Bbook\\Startup\\')) {
            targetGroup = group.replace('\\Bbook\\Startup\\', '\\NLP\\Start-up\\');
        } else if (group.includes('\\Bbook\\')) {
            targetGroup = group.replace('\\Bbook\\', '\\LP\\');
        }

        const instruments = await prisma.instrument.findMany({
            where: {
                OR: [
                    { group: targetGroup },
                    { group: group }
                ],
                isActive: true,
            },
            include: {
                UserFavorite: {
                    where: {
                        userId,
                        // If accountId is provided, filter by it, otherwise global favorites?
                        // Schema says mt5AccountId is optional.
                        mt5AccountId: accountId as string || null
                    }
                }
            }
        });

        // Flatten favorite status and sort order
        const data = instruments.map(inst => {
            const fav = inst.UserFavorite[0];
            return {
                ...inst,
                favorite: !!fav,
                sortOrder: fav?.sortOrder ?? 99999, // default to end
                UserFavorite: undefined // remove join data
            };
        }).sort((a, b) => {
            // Sort by sortOrder first, then by symbol
            if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
            return a.symbol.localeCompare(b.symbol);
        });

        return res.json({
            success: true,
            data,
            count: data.length,
            mappedGroup: targetGroup
        });
    } catch (error) {
        console.error('[Instruments API] Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch instruments',
        });
    }
});

/**
 * POST /api/instruments/favorites/toggle
 * Toggle favorite status for an instrument
 */
router.post('/favorites/toggle', authenticateToken, async (req: Request, res: Response) => {
    try {
        const userId = req.user?.userId;
        const { instrumentId, mt5AccountId } = req.body;

        if (!userId || !instrumentId) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const existing = await prisma.userFavorite.findUnique({
            where: {
                userId_instrumentId_mt5AccountId: {
                    userId,
                    instrumentId,
                    mt5AccountId: mt5AccountId || null
                }
            }
        });

        if (existing) {
            await prisma.userFavorite.delete({
                where: { id: existing.id }
            });
            return res.json({ success: true, favorite: false });
        } else {
            await prisma.userFavorite.create({
                data: {
                    userId,
                    instrumentId,
                    mt5AccountId: mt5AccountId || null,
                    sortOrder: 0
                }
            });
            return res.json({ success: true, favorite: true });
        }
    } catch (error) {
        console.error('[Favorites Toggle] Error:', error);
        return res.status(500).json({ success: false, message: 'Internal error' });
    }
});

/**
 * POST /api/instruments/reorder
 * Bulk update sort order for instruments (Drag & Drop)
 */
router.post('/reorder', authenticateToken, async (req: Request, res: Response) => {
    try {
        const userId = req.user?.userId;
        const { orders, mt5AccountId } = req.body; // orders: [{ instrumentId, sortOrder }, ...]

        if (!userId || !Array.isArray(orders)) {
            return res.status(400).json({ success: false, message: 'Invalid payload' });
        }

        // Use transaction for consistency
        await prisma.$transaction(
            orders.map(order => prisma.userFavorite.upsert({
                where: {
                    userId_instrumentId_mt5AccountId: {
                        userId,
                        instrumentId: order.instrumentId,
                        mt5AccountId: mt5AccountId || null
                    }
                },
                update: { sortOrder: order.sortOrder },
                create: {
                    userId,
                    instrumentId: order.instrumentId,
                    mt5AccountId: mt5AccountId || null,
                    sortOrder: order.sortOrder
                }
            }))
        );

        return res.json({ success: true });
    } catch (error) {
        console.error('[Reorder API] Error:', error);
        return res.status(500).json({ success: false, message: 'Internal error' });
    }
});

export default router;
