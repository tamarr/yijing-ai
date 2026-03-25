/**
 * Ingests the Analects of Confucius (Legge) from the Gutenberg text.
 * One chunk per Book (20 books).
 *
 * Run: npx tsx src/scripts/ingest-analects.ts
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import OpenAI from 'openai';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEXT_PATH = join(__dirname, '../data/analects-legge.txt');
const BATCH_SIZE = 40;
const MODEL = 'text-embedding-3-small';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

interface AnalectsChunk {
  book: number;
  bookTitle: string;
  chapter: number;
  text: string;
}

function parseChapters(raw: string): AnalectsChunk[] {
  const start = raw.indexOf('*** START OF THE PROJECT GUTENBERG');
  const end = raw.indexOf('*** END OF THE PROJECT GUTENBERG');
  const body = raw.slice(start, end !== -1 ? end : undefined);

  const romanToInt: Record<string, number> = {};
  ['I','II','III','IV','V','VI','VII','VIII','IX','X',
   'XI','XII','XIII','XIV','XV','XVI','XVII','XVIII','XIX','XX',
   'XXI','XXII','XXIII','XXIV','XXV','XXVI','XXVII','XXVIII','XXIX','XXX']
    .forEach((r, i) => romanToInt[r] = i + 1);

  // Find book boundaries first
  const bookRegex = /^BOOK ([IVXLC]+)\.\s+([^\n]+)/gm;
  const books: { index: number; number: number; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = bookRegex.exec(body)) !== null) {
    const num = romanToInt[m[1]];
    if (num) books.push({ index: m.index, number: num, title: m[2].trim() });
  }

  // Find all chapter boundaries
  const chapRegex = /^\s+(?:CHAPTER|CHAP\.)\s+([IVXLC]+)\./gm;
  const chaps: { index: number; roman: string }[] = [];
  while ((m = chapRegex.exec(body)) !== null) {
    chaps.push({ index: m.index, roman: m[1] });
  }

  const chunks: AnalectsChunk[] = [];

  for (let i = 0; i < chaps.length; i++) {
    const { index, roman } = chaps[i];
    const chapter = romanToInt[roman];
    if (!chapter) continue;

    // Find which book this chapter belongs to
    let book = books[0];
    for (const b of books) {
      if (b.index <= index) book = b;
      else break;
    }

    const nextIndex = chaps[i + 1]?.index ?? body.length;
    const text = body.slice(index, nextIndex)
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (text.length > 20) {
      chunks.push({ book: book.number, bookTitle: book.title, chapter, text });
    }
  }

  return chunks;
}

const raw = readFileSync(TEXT_PATH, 'utf-8');
const chapters = parseChapters(raw);
console.log(`Parsed ${chapters.length} chapters across 20 books.`);

const embedTexts = chapters.map(c =>
  `Analects of Confucius, Book ${c.book} (${c.bookTitle}), Chapter ${c.chapter} (Legge):\n${c.text}`
);
const embeddings: number[][] = [];

console.log(`Embedding ${chapters.length} chapters...`);
for (let i = 0; i < embedTexts.length; i += BATCH_SIZE) {
  const batch = embedTexts.slice(i, i + BATCH_SIZE);
  const res = await openai.embeddings.create({ model: MODEL, input: batch });
  embeddings.push(...res.data.sort((a, b) => a.index - b.index).map(d => d.embedding));
  process.stdout.write(`  embedded ${Math.min(i + BATCH_SIZE, chapters.length)}/${chapters.length}\r`);
}
console.log();

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`DELETE FROM corpus_chunks WHERE chunk_type = 'analects'`);

  for (let i = 0; i < chapters.length; i++) {
    const { book, chapter, text } = chapters[i];
    const embeddingLiteral = `[${embeddings[i].join(',')}]`;
    // store book*1000+chapter as line_number for unique identification
    await client.query(
      `INSERT INTO corpus_chunks
         (hexagram_number, source, chunk_type, line_number, content, embedding)
       VALUES (NULL, 'legge', 'analects', $1, $2, $3::vector)`,
      [book * 1000 + chapter, text, embeddingLiteral]
    );
  }

  await client.query('COMMIT');
  console.log(`Inserted ${chapters.length} Analects chapters.`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  client.release();
  await pool.end();
}
