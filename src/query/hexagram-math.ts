/**
 * Hexagram arithmetic — compute the resulting hexagram after moving lines.
 *
 * Binary strings are bottom-to-top (index 0 = line 1, index 5 = line 6).
 * Moving lines flip: '0' → '1', '1' → '0'.
 */

import { query } from '../db/client.js';
import type { HexagramContext } from './retrieve.js';

export async function computeResultingHexagram(
  primaryBinary: string,
  movingLines: number[]
): Promise<number | null> {
  if (movingLines.length === 0) return null;

  const bits = primaryBinary.split('');
  for (const lineNum of movingLines) {
    const idx = 6 - lineNum; // binary is MSB-left: index 0 = line 6, index 5 = line 1
    bits[idx] = bits[idx] === '1' ? '0' : '1';
  }
  const resultingBinary = bits.join('');

  const res = await query<{ number: number }>(
    `SELECT number FROM hexagrams WHERE hexagram_binary = $1`,
    [resultingBinary]
  );

  return res.rows[0]?.number ?? null;
}
