import { readFileSync, writeFileSync } from 'fs';
import type { Hexagram, HexagramTranslation, LineText, HexagramDatabase } from './types.js';

const INPUT = process.env.LEGGE_OCR_PATH ?? 'sacredbooksofchi16conf_djvu.txt';
const OUTPUT = 'src/data/hexagrams.json';

// ─── OCR pre-processing ───────────────────────────────────────────────────────

function fixOcrArtifacts(text: string): string {
  return text
    // Fix split Roman numerals for hex 52 & 53
    .replace(/\bLI\s{1,3}I\.\s/g, 'LII. ')
    .replace(/\bLI\s{1,3}1\s{0,2}1\.\s/g, 'LIII. ')
    // Fix split "Hexagram" at page boundaries (3 known cases)
    .replace(/Hexagr\s*\n+\s*AM\./g, 'Hexagram.')
    .replace(/Hexagr;\s*\n+\s*A\.M\./g, 'Hexagram.')
    .replace(/Hexagr\s*$/gm, 'Hexagram.')
    // Fix "TlJE" -> "THE" (hex 60 header)
    .replace(/TlJE/g, 'THE')
    // Strip running page headers:
    //   "SECT.  I.  THE  KHAN  HEXAGRAM.  119"
    //   "119  THE  YI  KING.  TEXT."
    .replace(/SECT\.\s+I{1,3}\.\s+THE\s+.{2,50}HEXAGRAM\.?\s+\d+/gi, ' ')
    .replace(/\d{1,3}\s+THE\s+Y[iI!l]\s+KING\.?\s+TEXT\.?/gi, ' ')
    .replace(/THE\s+Y[iI!l]\s+KING\.\s+TEXT\./gi, ' ');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSpaces(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function collapseToSingleLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function romanToInt(r: string): number {
  const vals: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let total = 0;
  const up = r.toUpperCase().replace(/\s+/g, '');
  for (let i = 0; i < up.length; i++) {
    const cur = vals[up[i]] ?? 0;
    const next = vals[up[i + 1]] ?? 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

interface ParsedHexagram {
  name: string;
  judgment: string;
  lines: string[];       // index 0 = line 1 ... index 5 = line 6; index 6 = use of nine/six
  commentary: string;    // Legge's footnotes — valuable for vector store
}

function parseText(raw: string): Map<number, ParsedHexagram> {
  // Find start of actual Yi Jing text in the raw text first
  const textStart = raw.search(/TEXT\.\s+SECTION\s+I\./);
  if (textStart === -1) throw new Error('Could not find TEXT. SECTION I. in raw text');

  // The 64 hexagrams span two canonical sections (Section I = hex 1-30, Section II = hex 31-64).
  // The appendices begin after hexagram 64 with "APPENDIX    I."
  // We must stop there — the appendices reuse Roman numerals with a different mapping.
  const appendixStart = raw.search(/\nAPPENDIX\s+I\.\s*\n/);
  const textEnd = appendixStart !== -1 ? appendixStart : raw.length;

  // Apply OCR fixes only to the body (avoids index drift between raw and fixed)
  const body = fixOcrArtifacts(raw.slice(textStart, textEnd));

  // Locate all hexagram headers
  // Pattern: ROMAN_NUMERAL.  (multiple spaces)  The  NAME  Hexagram.
  const headerRe = /\b([IVXLC]+)\.\s{2,}(?:THE\s+)?The\s+(.+?)\s+Hexagram\./gi;

  // Collect ALL candidate header matches (including appendix cross-references)
  const allCandidates: Array<{ index: number; num: number; name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(body)) !== null) {
    const num = romanToInt(m[1]);
    if (num >= 1 && num <= 64) {
      allCandidates.push({ index: m.index, num, name: collapseToSingleLine(m[2]) });
    }
  }

  // Greedily pick exactly one header per hexagram number 1–64, in strictly increasing
  // position order. This eliminates appendix cross-references which reuse Roman numerals
  // with a different hexagram mapping.
  const headers: Array<{ index: number; num: number; name: string }> = [];
  let minPos = 0;
  for (let n = 1; n <= 64; n++) {
    const candidate = allCandidates.find(c => c.num === n && c.index >= minPos);
    if (candidate) {
      headers.push(candidate);
      minPos = candidate.index + 1;
    }
  }

  // Line anchor regex — matches all Legge OCR line formats:
  //   "1. The first line, divided,"       — standard
  //   "i. In the first (or lowest) line," — hex 1/2/14 variant
  //   "6. In the topmost line, undivided,"— topmost variant
  //   "3- The third line, divided,"       — OCR dash instead of period (hex 40+)
  //   "I. The first line, divided,"       — OCR uppercase I for line 1 (hex 32)
  //   "i. From the first line, divided,"  — hex 39 variant
  //   "7. (The lines of this hexagram"    — Use of Nine/Six (hex 1 & 2)
  const lineRe = /(?:^|\n)\s*([1-7iI])[.\-]\s{1,6}(?:(?:In|From)\s+)?(?:\([^)]+\)\s+)?[Tt]he\s+(?:first|second|third|fourth|fifth|sixth|topmost)\s+(?:\([^)]+\)\s+)?line,\s+(?:divided|undivided)|(?:^|\n)\s*([1-7i])\.\s{1,6}\(The\s+lines\s+of\s+this\s+hexagram/gm;

  const result = new Map<number, ParsedHexagram>();

  for (let i = 0; i < headers.length; i++) {
    const { num, name } = headers[i];
    const blockStart = headers[i].index;
    const blockEnd = headers[i + 1]?.index ?? body.length;
    const block = body.slice(blockStart, blockEnd);

    // Find all line anchors within this block
    const lineAnchors: Array<{ index: number; lineNum: number }> = [];
    let lm: RegExpExecArray | null;
    lineRe.lastIndex = 0;
    while ((lm = lineRe.exec(block)) !== null) {
      const captured = lm[1] ?? lm[2]; // two capture groups in the regex
      const rawNum = (captured === 'i' || captured === 'I') ? 1 : parseInt(captured, 10);
      // Accept lines in ascending order only (prevents duplicate/out-of-order matches)
      const lastFound = lineAnchors[lineAnchors.length - 1]?.lineNum ?? 0;
      if (rawNum > lastFound && rawNum <= 7) {
        lineAnchors.push({ index: lm.index, lineNum: rawNum });
      }
    }

    // Judgment: text from end of header to start of line 1
    const headerEndIdx = block.indexOf('\n');
    const line1Idx = lineAnchors[0]?.index ?? block.length;
    const judgmentRaw = block.slice(headerEndIdx, line1Idx);
    const judgment = extractMainText(judgmentRaw);

    // Extract each line's text (stop before the next line anchor)
    const lines: string[] = [];
    for (let j = 0; j < lineAnchors.length; j++) {
      const lStart = lineAnchors[j].index;
      const lEnd = lineAnchors[j + 1]?.index ?? block.length;
      const lineBlock = block.slice(lStart, lEnd);
      lines.push(extractMainText(lineBlock));
    }

    // Commentary = everything else in the block (Legge's scholarly footnotes)
    const commentary = collapseToSingleLine(
      block
        .replace(judgmentRaw, ' ')
        .replace(lines.map((_, j) => block.slice(lineAnchors[j].index, lineAnchors[j+1]?.index ?? block.length)).join(''), ' ')
    );

    result.set(num, { name, judgment, lines, commentary });
  }

  return result;
}

// Extract the main oracular text from a block that may contain interleaved footnotes.
// Heuristic: main text paragraphs are shorter and more oracular; footnotes are long prose.
// Strategy: split on blank lines, keep paragraphs that don't look like pure footnotes.
function extractMainText(block: string): string {
  // Remove page headers embedded in block
  const cleaned = block
    .replace(/SECT\.\s+I{1,3}\.\s+THE\s+.{2,50}HEXAGRAM\.?\s+\d+/gi, '\n')
    .replace(/\d{1,3}\s+THE\s+Y[iI!l]\s+KING\.?\s+TEXT\.?/gi, '\n');

  // Split into paragraphs (separated by blank lines)
  const paragraphs = cleaned.split(/\n\s*\n/).map(p => collapseToSingleLine(p)).filter(Boolean);

  // Keep paragraphs that look like main text:
  // - Not too long (footnotes tend to be very long)
  // - OR start with lowercase (continuation of a sentence split at a page break)
  // - Skip paragraphs that are purely explanatory (start with "The " followed by long analysis)
  const kept: string[] = [];
  for (const p of paragraphs) {
    if (!p) continue;
    // Skip if it looks like a standalone footnote (long, starts with capital, clearly analytical)
    if (p.length > 400 && /^[A-Z]/.test(p) && !p.match(/^\d+\.|^[i]\./)) continue;
    kept.push(p);
  }

  return collapseToSingleLine(kept.join(' '));
}

// ─── Build database ──────────────────────────────────────────────────────────

function main() {
  const raw = readFileSync(INPUT, 'utf-8');
  const strobus = JSON.parse(readFileSync('src/data/strobus.json', 'utf-8'));
  const strobusMap: Record<number, any> = {};
  for (const h of strobus.hexagrams) strobusMap[h.number] = h;

  console.log('Parsing Legge text...');
  const parsed = parseText(raw);
  console.log(`Found ${parsed.size} hexagrams in text`);

  const hexagrams: Hexagram[] = [];
  const errors: string[] = [];

  for (let n = 1; n <= 64; n++) {
    const p = parsed.get(n);
    const s = strobusMap[n];

    if (!p) {
      errors.push(`Hexagram ${n}: NOT FOUND`);
      continue;
    }

    const expectedLines = n <= 2 ? 7 : 6;
    if (p.lines.length !== expectedLines) {
      errors.push(`Hexagram ${n} (${p.name}): expected ${expectedLines} lines, got ${p.lines.length}`);
    }
    if (!p.judgment) {
      errors.push(`Hexagram ${n} (${p.name}): missing judgment`);
    }

    const lineTexts: LineText[] = p.lines.slice(0, 6).map((text, idx) => ({
      number: (idx + 1) as 1 | 2 | 3 | 4 | 5 | 6,
      text,
    }));

    const translation: HexagramTranslation = {
      source: 'legge',
      name: p.name,
      judgment: p.judgment,
      image: '',
      lines: lineTexts,
    };

    if (n === 1 && p.lines[6]) translation.useOfNine = p.lines[6];
    if (n === 2 && p.lines[6]) translation.useOfSix = p.lines[6];

    hexagrams.push({
      number: n,
      binary: s?.binary ?? '',
      chineseName: s?.chineseName ?? '',
      pinyin: s?.pinyinName ?? '',
      character: s?.character ?? '',
      upperTrigram: s?.topTrigram ?? 0,
      lowerTrigram: s?.bottomTrigram ?? 0,
      translations: [translation],
    });
  }

  if (errors.length) {
    console.warn(`\n${errors.length} issues found:`);
    errors.forEach(e => console.warn(' ⚠', e));
  } else {
    console.log('\n✅ All 64 hexagrams parsed cleanly');
  }

  const db: HexagramDatabase = {
    version: '1.0.0',
    sources: ['legge'],
    hexagrams,
  };

  writeFileSync(OUTPUT, JSON.stringify(db, null, 2), 'utf-8');
  console.log(`Wrote ${hexagrams.length} hexagrams to ${OUTPUT}`);
}

main();
