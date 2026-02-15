
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkSymbol() {
    try {
        const symbol = 'BTCUSD';
        const symbolM = 'BTCUSDm';

        console.log(`Checking ${symbol} and ${symbolM}...`);

        const instrument = await prisma.instrument.findFirst({
            where: { symbol: { in: [symbol, symbolM] } }
        });
        console.log('Instrument Table:', instrument);

        const symbolWithCat = await prisma.symbols_with_categories.findFirst({
            where: { symbol: { in: [symbol, symbolM] } }
        });
        console.log('symbols_with_categories Table:', symbolWithCat);

        // Check for any other table with similar name if possible?
        // Listing all tables is not easy with prisma client directly without raw query

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

checkSymbol();
