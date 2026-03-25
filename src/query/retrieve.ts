/**
 * Retrieval layer — two-track:
 * 1. Deterministic SQL: structured hexagram data (judgment, image, moving lines)
 * 2. Semantic vector search: related corpus_chunks via pgvector
 */

import { query } from '../db/client.js';
import { computeResultingHexagram } from './hexagram-math.js';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const EMBED_MODEL = 'text-embedding-3-small';

export interface HexagramContext {
  number: number;
  chineseName: string;
  pinyin: string;
  character: string;
  hexagramBinary: string;
  translations: {
    source: string;
    name: string;
    judgment: string;
    judgmentCommentary: string | null;
    image: string;
    movingLines: { lineNumber: number; text: string; commentary: string | null }[];
  }[];
  resulting?: HexagramContext; // populated when there are moving lines
}

export interface SemanticChunk {
  hexagram_number: number;
  source: string;
  chunk_type: string;
  line_number: number | null;
  content: string;
  similarity: number;
}

// ---------------------------------------------------------------------------
// 1. Deterministic fetch
// ---------------------------------------------------------------------------
export async function fetchHexagramContext(
  hexNumber: number,
  movingLines: number[] = []
): Promise<HexagramContext> {
  const hexRes = await query(
    `SELECT number, chinese_name, pinyin, character, hexagram_binary FROM hexagrams WHERE number = $1`,
    [hexNumber]
  );
  if (hexRes.rows.length === 0) throw new Error(`Hexagram ${hexNumber} not found`);
  const hex = hexRes.rows[0];

  const transRes = await query(
    `SELECT id, source, name, judgment, judgment_commentary, image
     FROM hexagram_translations
     WHERE hexagram_number = $1
     ORDER BY source`,
    [hexNumber]
  );

  const translations = await Promise.all(
    transRes.rows.map(async (t) => {
      let movingLineRows: { line_number: number; text: string }[] = [];
      if (movingLines.length > 0) {
        const linesRes = await query(
          `SELECT line_number, text, image_commentary FROM lines
           WHERE translation_id = $1 AND line_number = ANY($2)
           ORDER BY line_number`,
          [t.id, movingLines]
        );
        movingLineRows = linesRes.rows;
      }
      return {
        source: t.source,
        name: t.name,
        judgment: t.judgment,
        judgmentCommentary: t.judgment_commentary ?? null,
        image: t.image,
        movingLines: movingLineRows.map((l: { line_number: number; text: string; image_commentary: string | null }) => ({
          lineNumber: l.line_number,
          text: l.text,
          commentary: l.image_commentary ?? null,
        })),
      };
    })
  );

  const ctx: HexagramContext = {
    number: hex.number,
    chineseName: hex.chinese_name,
    pinyin: hex.pinyin,
    character: hex.character,
    hexagramBinary: hex.hexagram_binary,
    translations,
  };

  if (movingLines.length > 0) {
    const resultingNumber = await computeResultingHexagram(hex.hexagram_binary, movingLines);
    if (resultingNumber && resultingNumber !== hexNumber) {
      ctx.resulting = await fetchHexagramContext(resultingNumber);
    }
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// 2. Semantic search — wisdom corpus only (hexagram_number IS NULL)
// ---------------------------------------------------------------------------
export async function semanticSearch(
  queries: string[],   // multiple queries — results merged and deduplicated
  topKPerQuery = 5
): Promise<SemanticChunk[]> {
  // Embed all queries in one API call
  const embRes = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: queries,
  });
  const embeddings = embRes.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);

  // Run searches in parallel
  const resultSets = await Promise.all(
    embeddings.map(embedding => {
      const embeddingLiteral = `[${embedding.join(',')}]`;
      return query<SemanticChunk>(
        `SELECT hexagram_number, source, chunk_type, line_number, content,
                1 - (embedding <=> $1::vector) AS similarity
         FROM corpus_chunks
         WHERE hexagram_number IS NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [embeddingLiteral, topKPerQuery]
      ).then(r => r.rows);
    })
  );

  // Merge, deduplicate by content, keep highest similarity score
  const seen = new Map<string, SemanticChunk>();
  for (const rows of resultSets) {
    for (const row of rows) {
      const key = `${row.chunk_type}:${row.line_number}`;
      const existing = seen.get(key);
      if (!existing || row.similarity > existing.similarity) {
        seen.set(key, row);
      }
    }
  }

  // Sort by similarity, enforce max 2 chunks per chunk_type for diversity
  const sorted = [...seen.values()].sort((a, b) => b.similarity - a.similarity);
  const typeCount = new Map<string, number>();
  const diverse: SemanticChunk[] = [];
  for (const chunk of sorted) {
    const count = typeCount.get(chunk.chunk_type) ?? 0;
    if (count < 2) {
      diverse.push(chunk);
      typeCount.set(chunk.chunk_type, count + 1);
    }
    if (diverse.length >= topKPerQuery + 2) break;
  }
  return diverse;
}
