/**
 * Ingests Legge's Tao Te Ching (Project Gutenberg #216) into corpus_chunks.
 *
 * Each of the 81 chapters becomes one chunk:
 *   - hexagram_number: null (wisdom corpus, not hexagram-specific)
 *   - source: 'legge'
 *   - chunk_type: 'tao_te_ching'
 *   - line_number: chapter number (1–81)
 *
 * Embed text is prefixed with chapter number for retrieval context.
 * Idempotent: deletes existing tao_te_ching chunks before inserting.
 *
 * Run: npx tsx src/scripts/ingest-tao-te-ching.ts
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import OpenAI from 'openai';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEXT_PATH = join(__dirname, '../data/tao-te-ching-legge.txt');
const BATCH_SIZE = 40;
const MODEL = 'text-embedding-3-small';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ---------------------------------------------------------------------------
// Parse chapters from the Gutenberg plain text
// ---------------------------------------------------------------------------
function parseChapters(raw: string): { number: number; text: string }[] {
  // Strip Gutenberg header/footer
  const start = raw.indexOf('*** START OF THE PROJECT GUTENBERG');
  const end = raw.indexOf('*** END OF THE PROJECT GUTENBERG');
  const body = raw.slice(start, end !== -1 ? end : undefined);

  const chapters: { number: number; text: string }[] = [];

  // Chapter boundaries — four formats found in this file:
  //   Ch. 1. 1.      — chapter 1 (has "Ch." prefix and dot after number)
  //   N. 1.          — chapters with multiple numbered verses
  //   N.\n           — single-verse chapters (number then blank line)
  //   N. [Uppercase] — chapters that go straight to text without verse numbering
  const chapterRegex = /^(?:Ch\.\s+)?(\d+)\.\s*(?=1\.|[A-Z\n\r])/gm;

  const matches: { index: number; number: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = chapterRegex.exec(body)) !== null) {
    const num = parseInt(match[1]);
    if (num >= 1 && num <= 81) {
      matches.push({ index: match.index, number: num });
    }
  }

  // Deduplicate — keep first occurrence of each chapter number (verse numbers
  // within chapters can look like chapter starts, e.g. "2." in chapter body)
  const seen = new Set<number>();
  const uniqueMatches = matches.filter(m => {
    if (seen.has(m.number)) return false;
    seen.add(m.number);
    return true;
  });
  matches.length = 0;
  matches.push(...uniqueMatches.sort((a, b) => a.index - b.index));

  for (let i = 0; i < matches.length; i++) {
    const { index, number } = matches[i];
    const nextIndex = matches[i + 1]?.index ?? body.length;
    const chapterRaw = body.slice(index, nextIndex).trim();

    // Clean up: collapse multiple spaces/newlines, remove verse numbering (e.g. "1.", "2.")
    const cleaned = chapterRaw
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')        // collapse inline spaces
      .replace(/\n{3,}/g, '\n\n')     // max two consecutive newlines
      .trim();

    chapters.push({ number, text: cleaned });
  }

  return chapters;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const raw = readFileSync(TEXT_PATH, 'utf-8');
const chapters = parseChapters(raw);

if (chapters.length !== 81) {
  console.warn(`Warning: expected 81 chapters, got ${chapters.length}`);
} else {
  console.log(`Parsed ${chapters.length} chapters.`);
}

const client = await pool.connect();
try {
  // Embed all chapters
  const embedTexts = chapters.map(c => `Tao Te Ching, Chapter ${c.number} (Legge):\n${c.text}`);
  const embeddings: number[][] = [];

  console.log(`Embedding ${chapters.length} chapters...`);
  for (let i = 0; i < embedTexts.length; i += BATCH_SIZE) {
    const batch = embedTexts.slice(i, i + BATCH_SIZE);
    const res = await openai.embeddings.create({ model: MODEL, input: batch });
    embeddings.push(...res.data.sort((a, b) => a.index - b.index).map(d => d.embedding));
    process.stdout.write(`  embedded ${Math.min(i + BATCH_SIZE, chapters.length)}/${chapters.length}\r`);
  }
  console.log();

  await client.query('BEGIN');

  // Clear existing
  await client.query(
    `DELETE FROM corpus_chunks WHERE chunk_type = 'tao_te_ching' AND source = 'legge'`
  );

  // Insert
  for (let i = 0; i < chapters.length; i++) {
    const { number, text } = chapters[i];
    const embedding = embeddings[i];
    const embeddingLiteral = `[${embedding.join(',')}]`;

    await client.query(
      `INSERT INTO corpus_chunks
         (hexagram_number, source, chunk_type, line_number, content, embedding)
       VALUES (NULL, 'legge', 'tao_te_ching', $1, $2, $3::vector)`,
      [number, text, embeddingLiteral]
    );
  }

  await client.query('COMMIT');
  console.log(`Inserted ${chapters.length} Tao Te Ching chapters into corpus_chunks.`);

} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  client.release();
  await pool.end();
}
