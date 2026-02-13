
import 'dotenv/config';
import { prisma } from '../lib/db.js';
import fetch from 'node-fetch';

const LIVE_API_URL = process.env.LIVE_API_URL || 'https://metaapi.zuperior.com/api';
const CLIENT_LOGIN_PATH = process.env.CLIENT_LOGIN_PATH || '/client/ClientAuth/login';

// Hardcode ID from logs
const ACCOUNT_ID = '19876982';

async function testApi() {
    console.log(`Starting probe for account ${ACCOUNT_ID}...`);

    // 1. Get password
    const account = await prisma.mT5Account.findFirst({
        where: {
            OR: [
                { accountId: ACCOUNT_ID },
                { id: ACCOUNT_ID } // In case it's ID
            ]
        }
    });

    if (!account || !account.password) {
        console.error('Account not found in DB or missing password');
        return;
    }

    // 2. Login
    // Handle double /api issue defensively
    const loginPath = CLIENT_LOGIN_PATH.startsWith('/api') ? CLIENT_LOGIN_PATH : `/api${CLIENT_LOGIN_PATH}`;
    const baseUrl = LIVE_API_URL.endsWith('/api') ? LIVE_API_URL.slice(0, -4) : LIVE_API_URL;
    const loginUrl = `${baseUrl}${loginPath}`; // e.g. https://metaapi.zuperior.com/api/client/ClientAuth/login

    console.log(`Logging in to ${loginUrl}...`);

    let token = '';

    try {
        const loginRes = await fetch(loginUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                AccountId: parseInt(account.accountId),
                Password: account.password,
                DeviceId: `probe_${Date.now()}`,
                DeviceType: 'web'
            })
        });

        if (!loginRes.ok) {
            console.error(`Login failed: ${loginRes.status} ${loginRes.statusText}`);
            const text = await loginRes.text();
            console.error('Response:', text);
            return;
        }

        const loginData = await loginRes.json() as any;
        token = loginData.Token || loginData.token || loginData.accessToken;

        if (!token) {
            console.error('Login succeeded but no token returned', loginData);
            return;
        }
        console.log('Login successful.');
    } catch (e) {
        console.error('Login error:', e);
        return;
    }

    // 3. Probe endpoints
    const endpoints = [
        `/api/marketdata/symbols?account_id=${ACCOUNT_ID}`, // From .env
        `/api/Users/${ACCOUNT_ID}/Symbols`, // Initial guess
        `/api/client/symbols?account_id=${ACCOUNT_ID}`,
        `/api/public/symbol_list`,
        `/api/symbols`
    ];

    for (const ep of endpoints) {
        const url = `${baseUrl}${ep}`; // e.g. https://metaapi.zuperior.com/api/marketdata/symbols...
        console.log(`\nProbing: ${url}`);

        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'AccountId': ACCOUNT_ID,
                    'Content-Type': 'application/json'
                }
            });

            console.log(`Status: ${res.status} ${res.statusText}`);
            if (res.ok) {
                const data = await res.json();
                const isArray = Array.isArray(data) || Array.isArray((data as any).data);
                console.log(`SUCCESS! Response is array: ${isArray}`);
                if (isArray) {
                    console.log('Valid symbol list found!');
                    // console.log('Sample:', JSON.stringify(data).slice(0, 100));
                }
            } else {
                if (res.status !== 404) {
                    const text = await res.text();
                    console.log('Error body:', text.slice(0, 200));
                }
            }
        } catch (e) {
            console.error(`Error probing ${url}:`, e.message);
        }
    }
}

testApi()
    .catch(console.error)
    .finally(async () => {
        await prisma.$disconnect();
        process.exit(0);
    });
