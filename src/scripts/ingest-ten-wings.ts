/**
 * Ingests Ta Chuan (Great Treatise, Appendix III) and Shuo Gua (Treatise on
 * Trigrams, Appendix V) from the Legge OCR file into corpus_chunks.
 *
 * Chunking: one chunk per chapter within each appendix.
 *   - chunk_type: 'ta_chuan' or 'shuo_gua'
 *   - line_number: chapter number
 *   - hexagram_number: null (wisdom corpus)
 *
 * Run: npx tsx src/scripts/ingest-ten-wings.ts
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import OpenAI from 'openai';
import pg from 'pg';

const OCR_PATH = process.env.LEGGE_OCR_PATH ?? 'sacredbooksofchi16conf_djvu.txt';
const BATCH_SIZE = 40;
const MODEL = 'text-embedding-3-small';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractNumberedParagraphs(text: string): string {
  // Fix OCR hyphenation first
  text = text.replace(/(\w)-\s*\n\s*([a-z])/g, '$1$2');
  text = text.replace(/[ \t]+/g, ' ');

  // Split into lines, then reconstruct numbered paragraph blocks.
  // The actual text paragraphs are numbered: "66.", "67.", etc.
  // Chapter headings embed the first paragraph: "Chapter XI. 66. The Master said..."
  // Everything else (between numbered paragraphs) is Legge's footnotes — discard.

  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inNumbered = false;

  for (const line of lines) {
    const t = line.trim();

    // Chapter heading with embedded first paragraph: "Chapter XI. 66. text..."
    const chapterStart = t.match(/^Chapter\s+[IVX]+\.\s+(\d+)\.\s+(.+)/);
    if (chapterStart) {
      if (current.length > 0) blocks.push(current.join(' ').trim());
      current = [`${chapterStart[1]}. ${chapterStart[2]}`];
      inNumbered = true;
      continue;
    }

    // Numbered paragraph: "67. text..." or "2,2. text..." (OCR comma for period)
    const numberedLine = t.match(/^(\d+)[.,]\s+\S/);
    if (numberedLine) {
      if (current.length > 0) blocks.push(current.join(' ').trim());
      current = [t.replace(/^(\d+),/, '$1.')]; // fix OCR comma
      inNumbered = true;
      continue;
    }

    // Continuation of a numbered paragraph (non-empty, in numbered context)
    if (inNumbered && t.length > 0) {
      // Skip page headers — stay in numbered mode so we don't lose mid-paragraph text
      if (/^\d+\s+THE\s+APPENDIXES/i.test(t)) { continue; }
      if (/^\^?\d+\s+THE/.test(t)) { continue; }
      if (/^CHAP\./i.test(t)) { continue; }
      if (/^SECT\./i.test(t)) { continue; }
      if (/^[A-Z]\s+[a-z]\s+\d/.test(t)) { continue; } // "B b 2" OCR artifact
      // Skip footnote reference lines: "1 See...", "^2 Compare...", "3 The word..."
      // These are superscript footnote numbers rendered as plain digits by OCR.
      // Pattern: optional ^ + 1-3 digits + space + capital letter (but no period after digits,
      // which would make it a numbered paragraph instead).
      if (/^\^?\d{1,3} [A-Z]/.test(t) && !/^\d{1,3}\. /.test(t)) { continue; }
      // Legge's chapter-level commentary header — signals end of numbered text
      if (/^Chapter\s+[IVX]+,\s+paragraph/i.test(t)) { inNumbered = false; continue; }
      current.push(t);
    }
  }
  if (current.length > 0) blocks.push(current.join(' ').trim());

  // Strip footnote sentences absorbed into paragraph blocks.
  // Footnote sentences contain scholarly apparatus markers.
  function stripFootnoteSentences(text: string): string {
    return text
      .split(/(?<=[.!?"])\s+/)
      .filter(sentence => {
        const s = sentence.trim();
        if (/[Pp]aragraph[s]?\s+\d+/.test(s)) return false;
        // tortoise-shell in scholarly/etymological context only (not "stalks and the tortoise-shell")
        if (/tortoise.shell/.test(s) && !/stalks\s+and\s+the\s+tortoise/.test(s)) return false;
        if (/\bpu-shih\b/.test(s)) return false;
        if (/\bKu\s+Hsi\b|\biTu\s+Hsi\b|\bA[fF]u\s+Hsi\b/.test(s)) return false;
        if (/whose\s+representative\s+numbers/.test(s)) return false;
        if (/cloud-land/.test(s)) return false;
        if (/intercalar/.test(s)) return false;
        // Footnote phrases about composition of the Appendixes
        if (/composition\s+of\s+(these|the)\s+Appendix/i.test(s)) return false;
        // Sentences that are pure scholar apparatus (short, start with footnote number pattern)
        if (/^\^?\d{1,3}\s+/.test(s) && s.length < 200) return false;
        // Legge's editorial asides about translation choices
        if (/\bLegge\b.*\btranslat/i.test(s)) return false;
        if (/the\s+Chinese\s+character/i.test(s)) return false;
        // Legge's editorial voice commenting on the text
        if (/\bthe\s+writer\b/.test(s)) return false;
        if (/\bSpirit\s+of\s+God\b/.test(s)) return false;
        if (/\bcontrived\s+it\b/.test(s)) return false;
        if (/\bI\s+have\s+closed\s+the\s+quotation\b/.test(s)) return false;
        // Short quoted-term sentences used as footnote section headers: "' Divination '"
        if (/^'\s*[\w\s]+\s*'$/.test(s) && s.length < 40) return false;
        // Legge's claim that the sages authored the Yi
        if (/\bmade\s+the\s+Yi\b/.test(s)) return false;
        return true;
      })
      .join(' ')
      .trim();
  }

  return blocks
    .map(stripFootnoteSentences)
    .filter(b => b.length > 10)
    .join('\n\n')
    // Fix OCR name mangling of Khien (乾)
    .replace(/\bAY[^\s,;.()\]]*ien\b/g, 'Khien')
    .replace(/\bAV[^\s,;.()\]]*ien\b/g, 'Khien')
    .replace(/\bK\/[^\s,;.()\]]*ien\b/g, 'Khien')
    .replace(/\bA[Kk][^\s,;.()\]]*ien\b/g, 'Khien')
    // Fix common OCR substitutions
    .replace(/\bei\^ht\b/g, 'eight')
    .replace(/\bTricrrams?\b/gi, (m) => m[0] === 'T' ? 'Trigrams' : 'trigrams')
    .replace(/\bYl\b/g, 'Yi')
    .replace(/\bmakine\b/g, 'making')
    .replace(/\bknowleclge\b/gi, 'knowledge')
    .replace(/\bcharacte r\b/g, 'character')
    .trim();
}

function normalizeOcrText(text: string): string {
  return extractNumberedParagraphs(text);
}

function extractSection(raw: string, startLine: number, endLine: number): string {
  const lines = raw.split('\n');
  return lines.slice(startLine - 1, endLine - 1).join('\n');
}

function parseChapters(
  body: string,
  label: string
): { number: number; text: string }[] {
  // Match "Chapter I.", "Chapter II." etc. — OCR may use Roman numerals
  // Also handle "Chapter  I." with extra spaces
  const chapterRegex = /^Chapter\s+(XV|XIV|XIII|XII|XI|IX|VIII|VII|VI|IV|III|II|X|V|I)\./gm;

  const romanToInt: Record<string, number> = {
    I:1, II:2, III:3, IV:4, V:5, VI:6, VII:7, VIII:8, IX:9,
    X:10, XI:11, XII:12, XIII:13, XIV:14, XV:15,
  };

  const matches: { index: number; number: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = chapterRegex.exec(body)) !== null) {
    const roman = match[1].replace(/\s+/g, '');
    const num = romanToInt[roman];
    if (num) matches.push({ index: match.index, number: num });
  }

  // Deduplicate — keep first occurrence per chapter number
  const seen = new Set<number>();
  const unique = matches.filter(m => {
    if (seen.has(m.number)) return false;
    seen.add(m.number);
    return true;
  }).sort((a, b) => a.index - b.index);

  return unique.map((m, i) => {
    const nextIndex = unique[i + 1]?.index ?? body.length;
    const raw = body.slice(m.index, nextIndex);
    return { number: m.number, text: normalizeOcrText(raw) };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const raw = readFileSync(OCR_PATH, 'utf-8');
const lines = raw.split('\n');
const totalLines = lines.length;

// Locate appendix boundaries by line number
// Appendix III: 18023 → 20742, Appendix V: 21374 → 21854
const taChuanBody = extractSection(raw, 18023, 20742);
const shuoGuaBody = extractSection(raw, 21374, 21854);

const taChuanChapters = parseChapters(taChuanBody, 'Ta Chuan');
const shuoGuaChapters = parseChapters(shuoGuaBody, 'Shuo Gua');

console.log(`Ta Chuan: ${taChuanChapters.length} chapters`);
console.log(`Shuo Gua: ${shuoGuaChapters.length} chapters`);

type ChunkRecord = {
  chunkType: string;
  number: number;
  part: number;       // 1 for unsplit chunks, 1/2/3... for split ones
  text: string;
  label: string;
};

// ~8000 token limit — estimate 4 chars per token, stay well under
const MAX_CHARS = 24000;

function splitIfNeeded(
  text: string,
  chunkType: string,
  number: number,
  baseLabelFn: (n: number, part: number) => string
): ChunkRecord[] {
  if (text.length <= MAX_CHARS) {
    return [{ chunkType, number, part: 1, text, label: baseLabelFn(number, 0) }];
  }

  // Split on double newlines (paragraph boundaries)
  const paragraphs = text.split(/\n\n+/);
  const parts: ChunkRecord[] = [];
  let current = '';
  let partNum = 1;

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > MAX_CHARS && current.length > 0) {
      parts.push({ chunkType, number, part: partNum, text: current.trim(), label: baseLabelFn(number, partNum) });
      current = para;
      partNum++;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) {
    parts.push({ chunkType, number, part: partNum, text: current.trim(), label: baseLabelFn(number, partNum) });
  }
  return parts;
}

const allChunks: ChunkRecord[] = [
  ...taChuanChapters.flatMap(c => splitIfNeeded(
    c.text, 'ta_chuan', c.number,
    (n, p) => `Ta Chuan (Great Treatise), Chapter ${n}${p > 1 ? ', Part ' + p : ''} (Legge)`
  )),
  ...shuoGuaChapters.flatMap(c => splitIfNeeded(
    c.text, 'shuo_gua', c.number,
    (n, p) => `Shuo Gua (Treatise on Trigrams), Chapter ${n}${p > 1 ? ', Part ' + p : ''} (Legge)`
  )),
];

console.log(`Embedding ${allChunks.length} chunks...`);
const embedTexts = allChunks.map(c => `${c.label}:\n${c.text}`);
const embeddings: number[][] = [];

for (let i = 0; i < embedTexts.length; i += BATCH_SIZE) {
  const batch = embedTexts.slice(i, i + BATCH_SIZE);
  const res = await openai.embeddings.create({ model: MODEL, input: batch });
  embeddings.push(...res.data.sort((a, b) => a.index - b.index).map(d => d.embedding));
  process.stdout.write(`  embedded ${Math.min(i + BATCH_SIZE, allChunks.length)}/${allChunks.length}\r`);
}
console.log();

const client = await pool.connect();
try {
  await client.query('BEGIN');

  await client.query(
    `DELETE FROM corpus_chunks WHERE chunk_type IN ('ta_chuan', 'shuo_gua')`
  );

  for (let i = 0; i < allChunks.length; i++) {
    const { chunkType, number, part, text } = allChunks[i];
    // Encode chapter + part as a decimal: chapter 8 part 2 → line_number = 8 (part stored in content header)
    const embeddingLiteral = `[${embeddings[i].join(',')}]`;
    const content = part > 1 ? `[Part ${part}]\n${text}` : text;
    await client.query(
      `INSERT INTO corpus_chunks
         (hexagram_number, source, chunk_type, line_number, content, embedding)
       VALUES (NULL, 'legge', $1, $2, $3, $4::vector)`,
      [chunkType, number, content, embeddingLiteral]
    );
  }

  await client.query('COMMIT');
  console.log(`Inserted ${allChunks.length} Ten Wings chunks.`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  client.release();
  await pool.end();
}
