/**
 * In-memory cache for MetaAPI tokens to reduce login overhead.
 */
class TokenCache {
    private cache: Map<string, { token: string; expiresAt: number }> = new Map();

    /**
     * Get a token from the cache if it's still valid.
     * @param accountId MT5 account ID
     */
    get(accountId: string): string | null {
        const entry = this.cache.get(accountId);
        if (!entry) return null;

        // Check if the token is still valid (with a 2-minute safety buffer)
        if (Date.now() < entry.expiresAt - 120000) {
            return entry.token;
        }

        // Token expired or near expiry
        this.cache.delete(accountId);
        return null;
    }

    /**
     * Store a token in the cache.
     * @param accountId MT5 account ID
     * @param token Access token
     * @param ttlSeconds TTL in seconds (default: 3600 = 1 hour)
     */
    set(accountId: string, token: string, ttlSeconds: number = 3600): void {
        this.cache.set(accountId, {
            token,
            expiresAt: Date.now() + ttlSeconds * 1000,
        });
    }

    /**
     * Clear the cache for an account.
     */
    clear(accountId: string): void {
        this.cache.delete(accountId);
    }
}

export const tokenCache = new TokenCache();
