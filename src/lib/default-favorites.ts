/**
 * Utility to add default favorites to users
 */

import { prisma } from './db.js';

// Default favorite pairs for all users
export const DEFAULT_FAVORITES = [
  'EURUSD',
  'XAUUSD',
  'BTCUSD',
  'GBPJPY',
];

/**
 * Add default favorites to a user if they don't have any
 * This is called automatically on user registration and login
 */
export async function ensureDefaultFavorites(userId: string): Promise<boolean> {
  try {
    // Check if user already has favorites
    const existingFavorites = await prisma.userFavorite.count({
      where: { userId },
    });

    // If user has favorites, skip
    if (existingFavorites > 0) {
      console.log('User already has favorites', { userId, count: existingFavorites });
      return false;
    }

    console.log('Adding default favorites to user', { userId });

    let added = 0;

    // Add each default favorite
    for (let i = 0; i < DEFAULT_FAVORITES.length; i++) {
      const symbol = DEFAULT_FAVORITES[i];

      try {
        // Find instrument by symbol (case-insensitive)
        const instrument = await prisma.instrument.findFirst({
          where: {
            symbol: {
              equals: symbol,
              mode: 'insensitive',
            },
            isActive: true,
          },
        });

        if (!instrument) {
          console.warn('Default favorite instrument not found', { symbol });
          continue;
        }

        // Create favorite
        await prisma.userFavorite.create({
          data: {
            userId,
            instrumentId: instrument.id,
            sortOrder: i,
          },
        });

        added++;
      } catch (error) {
        // Ignore duplicate errors
        console.error('Failed to add default favorite', { symbol, error });
      }
    }

    console.log('Default favorites added successfully', { userId, added });
    return true;
  } catch (error) {
    console.error('Failed to ensure default favorites', { userId, error });
    return false;
  }
}

/**
 * Get default favorites for display purposes
 */
export function getDefaultFavoritesList(): string[] {
  return [...DEFAULT_FAVORITES];
}
