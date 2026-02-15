
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    try {
        const symbol = 'BTCUSD';
        console.log(`Upserting ${symbol}...`);

        // Upsert BTCUSD with spread 16 and contract size 1
        // Using simple spread value roughly matching user screenshot ($16 spread target)
        // If user screenshot showed "Fees: 0.16 USD" for "0.01 Lots", means Fees/Vol = 16.
        // Fees = Spread * Vol * Contract. 
        // 0.16 = Spread * 0.01 * 1 => Spread = 16.

        const result = await prisma.ib_symbol_spreads.upsert({
            where: { symbol: symbol },
            update: {
                startup_spread: 16.0,
                pro_spread: 14.0, // Pro gets better spread
                contract_size: 1,
                group_name: 'Crypto',
                category: 'Crypto'
            },
            create: {
                symbol: symbol,
                startup_spread: 16.0,
                pro_spread: 14.0,
                contract_size: 1,
                group_name: 'Crypto',
                category: 'Crypto'
            }
        });
        console.log('Upserted BTCUSD:', result);

        // Suggest also seeding 'BTCUSDm' just in case normalization fails or logic specific
        // But we implemented normalization in instruments.ts

        // Check EURUSD
        // Standard contract 100,000. Spread ~ 1.5 pips? = 0.00015
        // Fees for 1 lot = 1.5 * 1 * 100000 = 15 USD? 
        // Or if Spread is in points (15 points)?
        // User logic: "check out in the web how we calculate P/L and fees"

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
