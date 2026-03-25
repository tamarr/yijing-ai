/**
 * Seed the database from src/data/hexagrams.json (Legge translation + structural data)
 * and src/data/strobus.json (trigram metadata).
 *
 * Run: npx tsx src/scripts/seed.ts
 *
 * Idempotent: uses ON CONFLICT DO NOTHING / DO UPDATE so it's safe to re-run.
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';
import type { HexagramDatabase, Hexagram, HexagramTranslation } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '../data');

// ---------------------------------------------------------------------------
// Load source files
// ---------------------------------------------------------------------------
interface StrobusData {
  trigrams: {
    number: number;
    chineseName: string;
    pinyinName: string;
    character: string;
    binary: string;
    attribute: string;
    images: string[];
    chineseImage: string;
    pinyinImage: string;
    familyRelationship: string;
  }[];
}

const strobusData: StrobusData = JSON.parse(
  readFileSync(join(dataDir, 'strobus.json'), 'utf-8')
);
const hexData: HexagramDatabase = JSON.parse(
  readFileSync(join(dataDir, 'hexagrams.json'), 'utf-8')
);

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // -----------------------------------------------------------------------
    // 1. Trigrams
    // -----------------------------------------------------------------------
    console.log('Seeding trigrams...');
    for (const t of strobusData.trigrams) {
      await client.query(
        `INSERT INTO trigrams
           (number, chinese_name, pinyin, character, trigram_binary, attribute,
            images, chinese_image, pinyin_image, family_rel)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (number) DO UPDATE SET
           chinese_name   = EXCLUDED.chinese_name,
           pinyin         = EXCLUDED.pinyin,
           character      = EXCLUDED.character,
           trigram_binary = EXCLUDED.trigram_binary,
           attribute      = EXCLUDED.attribute,
           images         = EXCLUDED.images,
           chinese_image  = EXCLUDED.chinese_image,
           pinyin_image   = EXCLUDED.pinyin_image,
           family_rel     = EXCLUDED.family_rel`,
        [
          t.number, t.chineseName, t.pinyinName, t.character,
          t.binary, t.attribute, t.images, t.chineseImage,
          t.pinyinImage, t.familyRelationship,
        ]
      );
    }
    console.log(`  ${strobusData.trigrams.length} trigrams done.`);

    // -----------------------------------------------------------------------
    // 2. Hexagrams
    // -----------------------------------------------------------------------
    console.log('Seeding hexagrams...');
    for (const h of hexData.hexagrams) {
      await client.query(
        `INSERT INTO hexagrams
           (number, hexagram_binary, chinese_name, pinyin, character, upper_trigram, lower_trigram)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (number) DO UPDATE SET
           hexagram_binary = EXCLUDED.hexagram_binary,
           chinese_name    = EXCLUDED.chinese_name,
           pinyin          = EXCLUDED.pinyin,
           character       = EXCLUDED.character,
           upper_trigram   = EXCLUDED.upper_trigram,
           lower_trigram   = EXCLUDED.lower_trigram`,
        [h.number, h.binary, h.chineseName, h.pinyin, h.character,
         h.upperTrigram, h.lowerTrigram]
      );
    }
    console.log(`  ${hexData.hexagrams.length} hexagrams done.`);

    // -----------------------------------------------------------------------
    // 3. Translations + lines
    // -----------------------------------------------------------------------
    console.log('Seeding translations and lines...');
    let translationCount = 0;
    let lineCount = 0;

    for (const h of hexData.hexagrams) {
      for (const t of h.translations) {
        const res = await client.query<{ id: number }>(
          `INSERT INTO hexagram_translations
             (hexagram_number, source, name, judgment, judgment_commentary,
              image, use_of_nine, use_of_six)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (hexagram_number, source) DO UPDATE SET
             name                 = EXCLUDED.name,
             judgment             = EXCLUDED.judgment,
             judgment_commentary  = EXCLUDED.judgment_commentary,
             image                = EXCLUDED.image,
             use_of_nine          = EXCLUDED.use_of_nine,
             use_of_six           = EXCLUDED.use_of_six
           RETURNING id`,
          [
            h.number, t.source, t.name, t.judgment,
            t.judgmentCommentary ?? null, t.image,
            t.useOfNine ?? null, t.useOfSix ?? null,
          ]
        );

        const translationId = res.rows[0].id;
        translationCount++;

        for (const line of t.lines) {
          await client.query(
            `INSERT INTO lines
               (translation_id, line_number, text, image_commentary)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (translation_id, line_number) DO UPDATE SET
               text             = EXCLUDED.text,
               image_commentary = EXCLUDED.image_commentary`,
            [translationId, line.number, line.text, line.imageCommentary ?? null]
          );
          lineCount++;
        }
      }
    }
    console.log(`  ${translationCount} translations, ${lineCount} lines done.`);

    await client.query('COMMIT');
    console.log('Seed complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
