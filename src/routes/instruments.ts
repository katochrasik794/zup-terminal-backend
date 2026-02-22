
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

        // Use raw query to avoid Prisma Client generation/property name issues
        const [instruments, ibSpreads] = await Promise.all([
            prisma.instrument.findMany({
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
                            mt5AccountId: accountId as string || null
                        }
                    }
                }
            }),
            prisma.$queryRaw`SELECT * FROM ib_symbol_spreads` as Promise<any[]>
        ]);

        // console.log('[Instruments API] Loaded ibSpreads:', ibSpreads.length);
        // if (ibSpreads.length > 0) {
        //     console.log('[Instruments API] First spread sample keys:', Object.keys(ibSpreads[0]));
        //     // Sample: { id, symbol, startup_spread, ... }
        // }

        // Create a map for quick lookup from ib_symbol_spreads
        // DB symbols are "BTCUSD" (no suffix)
        const spreadMap = new Map();
        ibSpreads.forEach(spread => {
            spreadMap.set(spread.symbol, spread);
        });

        // Determine which spread column to use based on group
        // If group has 'Pro', use pro_spread. Else default to startup_spread?
        // User request says: "check the spread and contract size from this , for the pairs according to the group"
        const useProSpread = (group as string).includes('Pro');

        // Helper to normalize symbol
        const normalize = (sym: string) => {
            return sym.replace(/m$/, '').replace(/\.pro$/, '').replace(/\.ecn$/, '');
        };

        // Flatten favorite status and sort order AND merge details
        const data = instruments.map(inst => {
            const fav = inst.UserFavorite[0];

            // Normalize current instrument symbol to find match in DB
            const cleanSymbol = normalize(inst.symbol);
            const cleanUpper = cleanSymbol.toUpperCase();

            // Try explicit match, then clean match, then case-insensitive clean match
            // spreadMap keys might be arbitrary case? My seed used "BTCUSD". 
            // Query result keys depend on DB.
            let spreadData = spreadMap.get(inst.symbol) || spreadMap.get(cleanSymbol);

            // Fallback: search map by value symbol manually if needed (expensive but safe for small list)
            if (!spreadData) {
                for (const [key, val] of spreadMap.entries()) {
                    if (val.symbol.toUpperCase() === cleanUpper) {
                        spreadData = val;
                        break;
                    }
                }
            }

            // if (inst.symbol.includes('BTC') && !spreadData) {
            //     console.log('[Instruments API] WARNING: BTC symbol not found in spreads. Inst:', inst.symbol, 'Clean:', cleanSymbol);
            // }

            // Determine contract size
            // Default logic: If spreadData has it, use it.
            // If NOT, check if it's Crypto (BTC/ETH) and default to 1 instead of 100000 which is crazy for BTC.
            let contractSize = spreadData?.contract_size || inst.contractSize;

            if (!contractSize) {
                // Heuristic fallbacks if DB missing
                if (cleanUpper.includes('BTC') || cleanUpper.includes('ETH') || cleanUpper.includes('XAU')) {
                    contractSize = 1;
                    if (cleanUpper.includes('XAU')) contractSize = 100; // Gold usually 100
                } else {
                    contractSize = 100000;
                }
            }

            // Spread selection
            let spreadVal = inst.spread; // default from instrument table
            if (spreadData) {
                const dbSpread = useProSpread ? spreadData.pro_spread : spreadData.startup_spread;
                if (dbSpread) {
                    spreadVal = Number(dbSpread);
                }
            }

            return {
                ...inst,
                favorite: !!fav,
                sortOrder: fav?.sortOrder ?? 99999, // default to end
                UserFavorite: undefined, // remove join data

                // Merged fields
                contractSize: contractSize,
                spread: spreadVal,
                commission: 0,
                pipValue: spreadData?.pip_value ? Number(spreadData.pip_value) : undefined // Use DB pip_value if available
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
