/**
 * Merges Wilhelm/Baynes translation into hexagrams.json as source 'wilhelm'.
 * Wilhelm line comments are stored as imageCommentary on each line.
 * wilhelm_symbolic goes into judgmentCommentary.
 *
 * NOTE: Wilhelm/Baynes English is NOT public domain until ~2045.
 * This is for local development only — do not ship in a commercial product.
 *
 * Run: npx tsx src/scripts/add-wilhelm.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { HexagramDatabase, HexagramTranslation, LineText } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '../data');
const hexagramsPath = join(dataDir, 'hexagrams.json');

// Dynamic import for the JS module
const { default: wilhelmRaw } = await import('../data/wilhelm.js');

const db: HexagramDatabase = JSON.parse(readFileSync(hexagramsPath, 'utf-8'));

let added = 0;
let skipped = 0;

for (const hexagram of db.hexagrams) {
  const w = wilhelmRaw[String(hexagram.number)];
  if (!w) {
    console.warn(`No Wilhelm data for hexagram ${hexagram.number}`);
    skipped++;
    continue;
  }

  // Remove existing wilhelm entry if re-running
  hexagram.translations = hexagram.translations.filter(t => t.source !== 'wilhelm');

  const lines: LineText[] = Object.entries(w.wilhelm_lines as Record<string, { text: string; comments: string }>)
    .map(([num, line]) => ({
      number: parseInt(num) as LineText['number'],
      text: line.text,
      imageCommentary: line.comments,
    }))
    .sort((a, b) => a.number - b.number);

  const translation: HexagramTranslation = {
    source: 'wilhelm',
    name: w.english,
    judgment: w.wilhelm_judgment.text,
    judgmentCommentary: [w.wilhelm_symbolic, w.wilhelm_judgment.comments]
      .filter(Boolean)
      .join('\n\n') || undefined,
    image: w.wilhelm_image.text,
    lines,
  };

  hexagram.translations.push(translation);
  added++;
}

// Keep sources list in sync
if (!db.sources.includes('wilhelm')) {
  db.sources.push('wilhelm');
}

writeFileSync(hexagramsPath, JSON.stringify(db, null, 2));
console.log(`Done. Added Wilhelm to ${added} hexagrams, skipped ${skipped}.`);
