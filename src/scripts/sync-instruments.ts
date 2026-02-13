
import 'dotenv/config';
import { prisma } from '../lib/db.js';
import fetch from 'node-fetch';

/**
 * Script to sync instruments (symbols) from MetaAPI for all unique groups found in the database.
 * Usage: npx tsx src/scripts/sync-instruments.ts
 */

const LIVE_API_URL = process.env.LIVE_API_URL || 'https://metaapi.zuperior.com/api';
const CLIENT_LOGIN_PATH = process.env.CLIENT_LOGIN_PATH || '/client/ClientAuth/login';

// Helper to construct login URL correctly
const getLoginUrl = () => {
    let path = CLIENT_LOGIN_PATH;
    if (path.startsWith('/api/')) {
        path = path.replace(/^\/api/, '');
    }

    return path.startsWith('http')
        ? path
        : path.startsWith('/')
            ? `${LIVE_API_URL.replace(/\/$/, '')}${path}`
            : `${LIVE_API_URL.replace(/\/$/, '')}/${path}`;
};

// Helper function to get symbols from MetaAPI
async function fetchSymbolsFromMetaAPI(accountId: string, password: string): Promise<any[]> {
    try {
        // 1. Authenticate to get Token
        const loginUrl = getLoginUrl();
        const accountIdInt = parseInt(accountId, 10);

        console.log(`[Sync] Authenticating for account ${accountId}...`);

        const loginPayload = {
            AccountId: accountIdInt,
            Password: password,
            DeviceId: `script_sync_${Date.now()}`,
            DeviceType: 'web',
        };

        const loginResponse = await fetch(loginUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(loginPayload),
        });

        if (!loginResponse.ok) {
            console.error(`[Sync] Login failed for account ${accountId}: ${loginResponse.statusText}`);
            return [];
        }

        const loginData = await loginResponse.json() as any;
        const accessToken = loginData?.Token || loginData?.accessToken || loginData?.AccessToken || loginData?.token;

        if (!accessToken) {
            console.error(`[Sync] No access token received for account ${accountId}`);
            return [];
        }

        // 2. Fetch Symbols
        // Verified endpoint: /api/symbols
        // We need to ensure we don't double up /api but also respect LIVE_API_URL
        const baseUrl = LIVE_API_URL.endsWith('/api') ? LIVE_API_URL : `${LIVE_API_URL.replace(/\/$/, '')}/api`;
        // If baseUrl is .../api, appending /symbols makes .../api/symbols
        // If baseUrl is .../api/api, it's wrong.

        let symbolsUrl = '';
        if (baseUrl.endsWith('/api')) {
            symbolsUrl = `${baseUrl}/symbols`;
        } else {
            symbolsUrl = `${baseUrl}/api/symbols`;
        }
        // Actually simpler: process.env.LIVE_API_URL is '.../api' usually.
        // My test script used `${baseUrl}${ep}` where ep was `/api/symbols` and baseUrl was without `/api`.
        // So `https://metaapi.zuperior.com/api/symbols` is the target.

        if (LIVE_API_URL.endsWith('/api')) {
            symbolsUrl = `${LIVE_API_URL}/symbols`;
        } else {
            symbolsUrl = `${LIVE_API_URL}/api/symbols`;
        }

        // Add query param for account ID just in case, though header is key
        symbolsUrl = `${symbolsUrl}?account_id=${accountId}`;

        console.log(`[Sync] Fetching symbols from ${symbolsUrl}...`);

        const symbolsResponse = await fetch(symbolsUrl, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'AccountId': accountId,
                'Content-Type': 'application/json',
            },
        });

        if (!symbolsResponse.ok) {
            console.error(`[Sync] Failed to fetch symbols: ${symbolsResponse.statusText}`);
            return [];
        }

        const symbolsData = await symbolsResponse.json() as any;
        // Handle different response structures
        let symbols = symbolsData?.data || symbolsData?.Data || symbolsData;

        if (!Array.isArray(symbols) && (symbols.result || symbols.response)) {
            symbols = symbols.result || symbols.response;
        }

        if (Array.isArray(symbols)) {
            console.log(`[Sync] Retrieved ${symbols.length} symbols for account ${accountId}`);
            return symbols;
        } else {
            console.warn(`[Sync] Unexpected symbols format for account ${accountId}`, typeof symbols);
            return [];
        }
    } catch (error) {
        console.error(`[Sync] Error fetching symbols for account ${accountId}:`, error);
        return [];
    }
}

async function syncInstruments() {
    console.log('Starting instrument sync...');

    try {
        // 1. Get all unique groups from MT5Accounts
        const accounts = await prisma.mT5Account.findMany({
            where: {
                archived: false,
                password: { not: null } // We need password to login
            },
            select: {
                accountId: true,
                password: true,
                group: true
            },
            orderBy: {
                createdAt: 'desc' // Use most recent accounts first
            }
        });

        console.log(`Found ${accounts.length} potential accounts to use for syncing.`);

        // Group accounts by 'group' field
        const accountsByGroup = new Map<string, typeof accounts[0]>();

        for (const acc of accounts) {
            if (acc.group && !accountsByGroup.has(acc.group)) {
                accountsByGroup.set(acc.group, acc);
            }
        }

        console.log(`Identified ${accountsByGroup.size} unique groups:`, Array.from(accountsByGroup.keys()));

        if (accountsByGroup.size === 0) {
            console.log('No groups found with valid credentials. Exiting.');
            return;
        }

        // 2. Process each group
        for (const [groupName, account] of accountsByGroup.entries()) {
            console.log(`\n--- Processing Group: ${groupName} (using account ${account.accountId}) ---`);

            if (!account.password) {
                console.log(`Skipping group ${groupName} - no password available.`);
                continue;
            }

            const symbols = await fetchSymbolsFromMetaAPI(account.accountId, account.password);

            if (symbols.length === 0) {
                console.log(`No symbols found for group ${groupName}.`);
                continue;
            }

            // 3. Upsert symbols into DB
            console.log(`Upserting ${symbols.length} symbols into database...`);

            let successCount = 0;
            let errorCount = 0;

            for (const sym of symbols) {
                try {
                    // Map API response to Prisma model
                    // Adjust field mapping based on actual API response structure
                    const symbolData = {
                        symbol: sym.Symbol || sym.symbol,
                        path: sym.Path || sym.path || '',
                        description: sym.Description || sym.description || '',
                        digits: sym.Digits || sym.digits || 5,
                        contractSize: parseFloat(sym.ContractSize || sym.contractSize || 0),
                        minVolume: parseFloat(sym.VolumeMin || sym.volumeMin || 0.01),
                        maxVolume: parseFloat(sym.VolumeMax || sym.volumeMax || 100),
                        volumeStep: parseFloat(sym.VolumeStep || sym.volumeStep || 0.01),
                        swapLong: parseFloat(sym.SwapLong || sym.swapLong || 0),
                        swapShort: parseFloat(sym.SwapShort || sym.swapShort || 0),
                        group: groupName, // Explicitly set the group we fetched for
                        category: (sym.Path || sym.path || '').split('\\')[0] || 'Forex', // Heuristic category
                        // Other fields as needed
                        updatedAt: new Date(),
                        lastUpdated: new Date()
                    };

                    // Use symbol + group as unique identifier if possible?
                    // The schema has `symbol` as @unique, which means ONE symbol entry per system?
                    // If multiple groups have the same symbol (e.g. EURUSD), they might have different settings.
                    // Schema check: model Instrument { symbol String @unique ... }
                    // This schema limitation means we can only store ONE definition per symbol name.
                    // If 'EURUSD' exists in 'GroupA' and 'GroupB', they conflict.
                    // However, MT5 usually has unique symbols per group like 'EURUSD.m', 'EURUSD.pro' OR relies on path.

                    // Strategy: Upsert by symbol name. Last writer wins.
                    // If groups share exact symbol names (e.g. "EURUSD"), the last group processed will overwrite properties.
                    // This is a known limitation of the current schema if it enforces unique symbol names.

                    await prisma.instrument.upsert({
                        where: { symbol: symbolData.symbol },
                        update: {
                            ...symbolData,
                            // Don't overwrite createdAt
                        },
                        create: {
                            id: symbolData.symbol, // Use symbol as ID for now or generate UUID? Schema says String @id. 
                            // Using symbol as ID is common if unique.
                            ...symbolData,
                            createdAt: new Date()
                        }
                    });

                    successCount++;
                } catch (err) {
                    errorCount++;
                    // console.error(`Failed to upsert symbol ${sym.Symbol}:`, err);
                }
            }

            console.log(`Streamed ${successCount} symbols to DB (${errorCount} errors).`);
        }

    } catch (error) {
        console.error('Fatal error in sync script:', error);
    } finally {
        await prisma.$disconnect();
        console.log('\nSync complete.');
    }
}

// Run (if called directly)
// Check if file is being run directly? In TSX it acts like a script.
syncInstruments();
