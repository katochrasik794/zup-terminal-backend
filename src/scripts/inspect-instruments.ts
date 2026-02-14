
import 'dotenv/config';
import { prisma } from '../lib/db';

async function inspect() {
    const total = await prisma.instrument.count();
    console.log(`Total Instruments: ${total}`);

    const categories = await prisma.instrument.groupBy({
        by: ['category'],
        _count: { symbol: true }
    });
    console.log('\nCategories:', categories);

    // const groups = await prisma.instrument.groupBy({
    //     by: ['group'],
    //     _count: { symbol: true }
    // });
    // console.log('\nGroups in Instrument table:', groups);


    const samples = await prisma.instrument.findMany({
        take: 10,
        select: { symbol: true, category: true, path: true, group: true }
    });
    console.log('\nSample Instruments:', samples);

    // Check for common Forex symbols
    const forex = await prisma.instrument.findMany({
        where: {
            symbol: { in: ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD'] }
        },
        select: { symbol: true, category: true, group: true }
    });
    console.log('\nCommon Symbols Check:', forex);
}

inspect().then(() => prisma.$disconnect());
