
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function inspectPrisma() {
    try {
        const keys = Object.keys(prisma);
        console.log('All keys:', keys);
        const iKeys = keys.filter(k => k.toLowerCase().startsWith('i'));
        console.log('Keys starting with i:', iKeys);

        // Check specific
        if (prisma.ib_symbol_spreads) console.log('Exists: prisma.ib_symbol_spreads');
        else console.log('Missing: prisma.ib_symbol_spreads');

        if (prisma.ibSymbolSpreads) console.log('Exists: prisma.ibSymbolSpreads');
        else console.log('Missing: prisma.ibSymbolSpreads');

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

inspectPrisma();
