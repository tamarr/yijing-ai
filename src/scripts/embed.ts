/**
 * Embedding pipeline — chunks hexagram translation data and stores embeddings
 * in corpus_chunks using OpenAI text-embedding-3-small.
 *
 * Chunk types per translation:
 *   - judgment        (+ judgmentCommentary if present)
 *   - image
 *   - line x6         (+ imageCommentary if present)
 *
 * Hierarchy: line chunks point to their judgment chunk via parent_id.
 * This lets the query layer fetch a line and always include its judgment as context.
 *
 * Embedding text is enriched with hexagram context for better retrieval,
 * but content stored is the clean source text.
 *
 * Idempotent: clears existing chunks for each (hexagram, source) before inserting.
 *
 * Run: npx tsx src/scripts/embed.ts
 * Run single source: npx tsx src/scripts/embed.ts legge
 */

import 'dotenv/config';
import OpenAI from 'openai';
import pg from 'pg';

const BATCH_SIZE = 100; // texts per OpenAI embeddings request
const MODEL = 'text-embedding-3-small';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TranslationRow {
  id: number;
  hexagram_number: number;
  chinese_name: string;
  pinyin: string;
  source: string;
  translation_name: string;
  judgment: string;
  judgment_commentary: string | null;
  image: string;
}

interface LineRow {
  translation_id: number;
  line_number: number;
  text: string;
  image_commentary: string | null;
}

interface ChunkInput {
  hexagram_number: number;
  source: string;
  chunk_type: string;
  line_number: number | null;
  content: string;
  embed_text: string;   // richer text sent to OpenAI — not stored
  parent_ref?: string;  // temporary key to link lines → judgment after insert
  ref_key?: string;     // temporary key identifying this chunk
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hexLabel(row: TranslationRow): string {
  return `Hexagram ${row.hexagram_number} (${row.pinyin} / ${row.translation_name})`;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const response = await openai.embeddings.create({ model: MODEL, input: texts });
  return response.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const sourceFilter = process.argv[2] ?? null;

const client = await pool.connect();
try {
  // Load all translations (optionally filtered by source)
  const translationsRes = await client.query<TranslationRow>(
    `SELECT
       t.id, t.hexagram_number, h.chinese_name, h.pinyin,
       t.source, t.name AS translation_name,
       t.judgment, t.judgment_commentary, t.image
     FROM hexagram_translations t
     JOIN hexagrams h ON h.number = t.hexagram_number
     ${sourceFilter ? 'WHERE t.source = $1' : ''}
     ORDER BY t.hexagram_number, t.source`,
    sourceFilter ? [sourceFilter] : []
  );
  const translations = translationsRes.rows;

  // Load all lines for those translations
  const translationIds = translations.map(t => t.id);
  const linesRes = await client.query<LineRow>(
    `SELECT translation_id, line_number, text, image_commentary
     FROM lines
     WHERE translation_id = ANY($1)
     ORDER BY translation_id, line_number`,
    [translationIds]
  );
  const linesByTranslation = new Map<number, LineRow[]>();
  for (const line of linesRes.rows) {
    if (!linesByTranslation.has(line.translation_id)) {
      linesByTranslation.set(line.translation_id, []);
    }
    linesByTranslation.get(line.translation_id)!.push(line);
  }

  console.log(`Processing ${translations.length} translations...`);

  // Build chunks for all translations
  const allChunks: ChunkInput[] = [];

  for (const t of translations) {
    const label = hexLabel(t);
    const judgmentRefKey = `${t.hexagram_number}:${t.source}:judgment`;

    // Judgment chunk (include commentary in embed text if present)
    const judgmentEmbedText = [
      `${label} — Judgment (${t.source}):`,
      t.judgment,
      t.judgment_commentary ?? '',
    ].filter(Boolean).join('\n');

    allChunks.push({
      hexagram_number: t.hexagram_number,
      source: t.source,
      chunk_type: 'judgment',
      line_number: null,
      content: t.judgment + (t.judgment_commentary ? '\n\n' + t.judgment_commentary : ''),
      embed_text: judgmentEmbedText,
      ref_key: judgmentRefKey,
    });

    // Image chunk
    allChunks.push({
      hexagram_number: t.hexagram_number,
      source: t.source,
      chunk_type: 'image',
      line_number: null,
      content: t.image,
      embed_text: `${label} — Image (${t.source}):\n${t.image}`,
    });

    // Line chunks
    const lines = linesByTranslation.get(t.id) ?? [];
    for (const line of lines) {
      const lineContent = line.text + (line.image_commentary ? '\n\n' + line.image_commentary : '');
      allChunks.push({
        hexagram_number: t.hexagram_number,
        source: t.source,
        chunk_type: 'line',
        line_number: line.line_number,
        content: lineContent,
        embed_text: `${label} — Line ${line.line_number} (${t.source}):\n${line.text}`,
        parent_ref: judgmentRefKey,
      });
    }
  }

  console.log(`Built ${allChunks.length} chunks. Embedding in batches of ${BATCH_SIZE}...`);

  // Embed all chunks in batches
  const embeddings: number[][] = [];
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const batchEmbeddings = await embedBatch(batch.map(c => c.embed_text));
    embeddings.push(...batchEmbeddings);
    process.stdout.write(`  embedded ${Math.min(i + BATCH_SIZE, allChunks.length)}/${allChunks.length}\r`);
  }
  console.log();

  // Insert into DB — clear existing chunks first for idempotency
  await client.query('BEGIN');

  const hexSourcePairs = [...new Set(allChunks.map(c => `${c.hexagram_number}:${c.source}`))];
  for (const pair of hexSourcePairs) {
    const [hexNum, src] = pair.split(':');
    await client.query(
      'DELETE FROM corpus_chunks WHERE hexagram_number = $1 AND source = $2',
      [hexNum, src]
    );
  }

  // Insert all chunks and collect id → ref_key mapping for parent linking
  const refKeyToId = new Map<string, number>();

  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    const embedding = embeddings[i];
    const embeddingLiteral = `[${embedding.join(',')}]`;

    const res = await client.query<{ id: number }>(
      `INSERT INTO corpus_chunks
         (hexagram_number, source, chunk_type, line_number, content, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)
       RETURNING id`,
      [chunk.hexagram_number, chunk.source, chunk.chunk_type,
       chunk.line_number, chunk.content, embeddingLiteral]
    );
    const id = res.rows[0].id;
    if (chunk.ref_key) refKeyToId.set(chunk.ref_key, id);
  }

  // Second pass: set parent_id on line chunks
  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    if (chunk.parent_ref && refKeyToId.has(chunk.parent_ref)) {
      // We need to identify the row we just inserted — re-query by unique attributes
      await client.query(
        `UPDATE corpus_chunks
         SET parent_id = $1
         WHERE hexagram_number = $2 AND source = $3
           AND chunk_type = 'line' AND line_number = $4`,
        [refKeyToId.get(chunk.parent_ref), chunk.hexagram_number, chunk.source, chunk.line_number]
      );
    }
  }

  await client.query('COMMIT');
  console.log(`Inserted ${allChunks.length} chunks with embeddings.`);

} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  client.release();
  await pool.end();
}
