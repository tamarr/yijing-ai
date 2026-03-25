/**
 * Ingests Chuang Tzu (Giles, 1889) from the downloaded Gutenberg text.
 * One chunk per chapter (33 chapters).
 *
 * Run: npx tsx src/scripts/ingest-chuang-tzu.ts
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import OpenAI from 'openai';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEXT_PATH = join(__dirname, '../data/chuang-tzu-giles.txt');
const BATCH_SIZE = 40;
const MODEL = 'text-embedding-3-small';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function parseChapters(raw: string): { number: number; title: string; text: string }[] {
  const start = raw.indexOf('*** START OF THE PROJECT GUTENBERG');
  const end = raw.indexOf('*** END OF THE PROJECT GUTENBERG');
  const body = raw.slice(start, end !== -1 ? end : undefined);

  // Chapters are marked as "CHAPTER I.\n\nTITLE" or "CHAPTER I.\n\nParagraph..."
  const chapterRegex = /^CHAPTER ([IVXLC]+)\./gm;
  const romanToInt: Record<string, number> = {};
  // Build roman numeral map up to 40
  const romans = ['I','II','III','IV','V','VI','VII','VIII','IX','X',
    'XI','XII','XIII','XIV','XV','XVI','XVII','XVIII','XIX','XX',
    'XXI','XXII','XXIII','XXIV','XXV','XXVI','XXVII','XXVIII','XXIX','XXX',
    'XXXI','XXXII','XXXIII'];
  romans.forEach((r, i) => romanToInt[r] = i + 1);

  const matches: { index: number; number: number; roman: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = chapterRegex.exec(body)) !== null) {
    const num = romanToInt[match[1]];
    if (num) matches.push({ index: match.index, number: num, roman: match[1] });
  }

  return matches.map((m, i) => {
    const nextIndex = matches[i + 1]?.index ?? body.length;
    const chapterRaw = body.slice(m.index, nextIndex);

    // Extract title — first non-empty line after "CHAPTER N."
    const titleMatch = chapterRaw.match(/^CHAPTER [IVXLC]+\.\s*\n+([^\n]+)/);
    const title = titleMatch?.[1]?.trim() ?? '';

    const text = chapterRaw
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return { number: m.number, title, text };
  });
}

// Target ~1500 chars per chunk — small enough for precise retrieval
const TARGET_CHARS = 1500;

function splitIntoParagraphChunks(number: number, text: string) {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 20);
  const chunks: { number: number; part: number; text: string }[] = [];
  let current = '';
  let partNum = 1;

  for (const para of paragraphs) {
    const candidate = current ? current + '\n\n' + para : para;
    if (candidate.length > TARGET_CHARS && current.length > 0) {
      chunks.push({ number, part: partNum++, text: current.trim() });
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push({ number, part: partNum, text: current.trim() });
  return chunks;
}

const raw = readFileSync(TEXT_PATH, 'utf-8');
const chapters = parseChapters(raw);
console.log(`Parsed ${chapters.length} chapters.`);

const chunks = chapters.flatMap(c => splitIntoParagraphChunks(c.number, c.text));
console.log(`Split into ${chunks.length} chunks.`);

const embedTexts = chunks.map(c =>
  `Chuang Tzu, Chapter ${c.number}${c.part > 1 ? ' Part ' + c.part : ''} (Giles):\n${c.text}`
);
const embeddings: number[][] = [];

console.log(`Embedding ${chunks.length} chunks...`);
for (let i = 0; i < embedTexts.length; i += BATCH_SIZE) {
  const batch = embedTexts.slice(i, i + BATCH_SIZE);
  const res = await openai.embeddings.create({ model: MODEL, input: batch });
  embeddings.push(...res.data.sort((a, b) => a.index - b.index).map(d => d.embedding));
  process.stdout.write(`  embedded ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}\r`);
}
console.log();

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`DELETE FROM corpus_chunks WHERE chunk_type = 'chuang_tzu'`);

  for (let i = 0; i < chunks.length; i++) {
    const { number, part, text } = chunks[i];
    const content = part > 1 ? `[Part ${part}]\n${text}` : text;
    const embeddingLiteral = `[${embeddings[i].join(',')}]`;
    await client.query(
      `INSERT INTO corpus_chunks
         (hexagram_number, source, chunk_type, line_number, content, embedding)
       VALUES (NULL, 'giles', 'chuang_tzu', $1, $2, $3::vector)`,
      [number, content, embeddingLiteral]
    );
  }

  await client.query('COMMIT');
  console.log(`Inserted ${chunks.length} Chuang Tzu chunks.`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  client.release();
  await pool.end();
}
