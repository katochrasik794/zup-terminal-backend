
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const symbol = 'BTCUSD';
        console.log(`Upserting ${symbol}...`);

        // Upsert BTCUSD with spread 16 and contract size 1
        const result = await prisma.ib_symbol_spreads.upsert({
            where: { symbol: symbol },
            update: {
                startup_spread: 16.0,
                pro_spread: 14.0,
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

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
