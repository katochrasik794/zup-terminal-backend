
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkTables() {
    try {
        console.log('Checking for table ib_spread_symbols...');
        const result = await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_name = 'ib_spread_symbols'`;
        console.log('Result:', result);

        console.log('Checking symbols_with_categories for BTCUSD...');
        const btc = await prisma.$queryRaw`SELECT * FROM symbols_with_categories WHERE symbol LIKE 'BTCUSD%'`;
        console.log('BTC Data:', btc);

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

checkTables();
