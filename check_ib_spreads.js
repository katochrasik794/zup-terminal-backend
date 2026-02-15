
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkIBSymbols() {
    try {
        console.log('Checking ib_symbol_spreads table...');
        const spreads = await prisma.ib_symbol_spreads.findMany({});
        console.log('Found records:', spreads.length);
        if (spreads.length > 0) {
            console.log('First 5 records:', spreads.slice(0, 5));
            const btc = spreads.find(s => s.symbol.includes('BTC'));
            console.log('BTC Record:', btc);
        } else {
            console.log('Table is empty.');
        }
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

checkIBSymbols();
