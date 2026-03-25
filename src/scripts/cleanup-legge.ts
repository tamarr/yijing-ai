import { readFileSync, writeFileSync } from 'fs';
import type { HexagramDatabase } from './types.js';

const PATH = 'src/data/hexagrams.json';

// ─── Hard corrections for judgments the heuristic cannot clean ────────────────
// These hexagrams have no sentence boundary between oracle text and commentary
// in the OCR, so automatic truncation fails. Values are Legge's actual oracle
// judgment text, transcribed from the structure of the existing parsed data.
const JUDGMENT_CORRECTIONS: Record<number, string> = {
  // Hex 1: OCR section headers ("Explanation of the entire figure by king Wan.")
  // precede the actual oracle text, causing the king-Wan filter to fire too early.
  1:  'Khien (represents) what is great and originating, penetrating, advantageous, correct and firm.',
  // Hex 12: commentary runs on without a period after "correct"
  12: 'In Phi there is the want of good understanding between the (different classes of) men, ' +
      'and its indication is unfavourable to the firm and correct course (of things). ' +
      'We see the great gone and the small come.',
  // Hex 20: commentary begins immediately after "sincerity" with no period
  20: 'Kwan shows (how he whom it represents should be like) the worshipper who has washed his hands, ' +
      'but not (yet) presented his offerings ; — with sincerity and an appearance of dignity ' +
      '(commanding reverent regard).',
  // Hex 47: commentary starts mid-sentence after "firm and"
  47: 'In (the condition denoted by) Khwan there may (yet be) progress and success. ' +
      'For the firm and correct, there will be good fortune. ' +
      'If their words cannot be credited, how can their good fortune be sustained?',
  // Hex 52: commentary begins immediately after "walks" with no period
  52: "When one's resting is like that of the back, and he loses all consciousness of self ; " +
      'when he walks in his courtyard, and does not see any (of the persons) in it, ' +
      'there will be no error.',
  // Hex 43: commentary begins after "appeal (for sym[pathy])" — OCR cuts "sympathy"
  43: 'Kwai requires (in him who would fulfil its meaning) the exhibition (of the culprit\'s guilt) ' +
      'in the royal court, and a sincere and earnest appeal (for sympathy), ' +
      'while the use of arms will bring evil. There will be advantage in whatever direction advance may be made.',
  // Hex 45: "advanof" is OCR run-on for "advantageous of/to"; commentary follows
  45: 'In (the state denoted by) Ts\'ui, the king will repair to his ancestral temple. ' +
      'It will be advantageous to meet with the great man, and then there will be progress and success, ' +
      'though advantage comes through firm correctness. ' +
      'The use of great victims will conduce to good fortune; and in whatever direction movement is made, it will be advantageous.',
  // Hex 51: commentary about wives/concubines is line analysis, not oracle
  51: 'Chên gives the intimation of ease and development. ' +
      'When (the time of) movement (which it indicates) comes, (the subject of the hexagram) will be found ' +
      'looking out with apprehension, and yet smiling and talking cheerfully. ' +
      'When the movement (like a crash of thunder) terrifies all within a hundred li, ' +
      'he will be like the sincere worshipper who is not startled into letting go his ladle and cup of sacrificial spirits.',
  // Hex 62: "attainsubject" is an OCR run-on; oracle text cut off mid-sentence
  62: 'Hsiao Kwo indicates that (in the circumstances which it implies) there will be progress and attainment. ' +
      'But it will be advantageous to be firm and correct. ' +
      '(What the name denotes may be done in) small affairs, but not great affairs.',
};

// ─── Name corrections ─────────────────────────────────────────────────────────
// OCR corruptions from the scanned Legge text, corrected to Legge's own romanizations
const NAME_CORRECTIONS: Record<number, string> = {
  3:  "Chun",
  9:  "Hsiao Ch'u",
  14: "Ta Yu",
  15: "Ch'ien",
  18: "Ku",
  27: "I",
  34: "Ta Chuang",
  35: "Chin",
  36: "Ming I",
  45: "Ts'ui",
  48: "Ching",
  51: "Ch\u00ebn",   // Chên
  53: "Chien",
  56: "L\u00fc",     // Lü
};

// ─── Judgment cleanup ─────────────────────────────────────────────────────────
// Legge's OCR mixes the short oracle judgment with his scholarly footnotes.
// These markers reliably indicate the start of Legge's line-by-line commentary
// and never appear in the oracle judgment text itself.
const COMMENTARY_MARKERS: RegExp[] = [
  /\bking\s+Wan\b/i,
  /\bking\s+Wen\b/i,
  /\bThe\s+subject\s+of\s+(line\s+)?[i1-6]\b/i,
  /\bIts\s+correlate\b/i,
  /\bLine\s+[i1-6]\s+is\b/i,
  /\bLine\s+[i1-6],\b/i,
  /\bbelongs\s+to\s+the\s+trigram\b/i,
  /\b(lower|upper)\s+trigram\b/i,
  /\bThis\s+(explanation|is\s+intended|symbolism)\b/i,
  /\bThe\s+symbolism\b/i,
  /\bis\s+now\s+universally\b/i,
  /\bNew\s+Digest\b/i,
  /\bparaphrase\b/i,
  /\byang\s+line\b|\byin\s+line\b/i,
  /\bweak.*in\s+(an?\s+)?(odd|even)\s+place\b/i,
  /\bstrong.*in\s+(an?\s+)?(odd|even)\s+place\b/i,
  /\bhad\s+in\s+his\s+mind\b/i,
  /\bwhose\s+representative\s+numbers\b/i,
  /^[IVXLC]+\.\s/,                          // footnote headed by Roman numeral
  /\bsee\s+(note\s+)?(on\s+)?paragraph\b/i,
];

// Truncate a Legge judgment at the first sentence that looks like commentary.
// Strategy: split on sentence-ending punctuation, filter by markers.
// For cases where OCR drops the period between oracle and commentary, also
// scan for markers appearing in the raw text and truncate at the last sentence
// boundary BEFORE the marker position — but only for markers that are
// unambiguous enough to safely use positionally (not "king Wan" which can
// appear in section headers before the oracle text).
const POSITIONAL_MARKERS: RegExp[] = [
  /\bThe\s+symbolism\s+of\b/i,
  /\bLine\s+[i1-6]\s+is\b/i,
  /\bLine\s+[i1-6],\b/i,
  /\bIts\s+correlate\b/i,
  /\battain[a-z]{4,}\b/,    // OCR run-on like "attainsubject"
  /\bcross[a-z]{5,}\b/,     // OCR run-on like "crossimportant"
  /[a-z]{4,}[A-Z][a-z]{3,}/, // camelCase artifact (two words joined)
];

function truncateJudgmentAtCommentary(text: string): string {
  // Pass 1: sentence-level filtering
  const sentences = text.split(/(?<=[.?!])\s+/);
  const kept: string[] = [];
  for (const s of sentences) {
    if (/^[a-z]/.test(s.trim()) && kept.length > 0) break;
    if (COMMENTARY_MARKERS.some(r => r.test(s))) break;
    kept.push(s);
  }
  let result = kept.join(' ').trim();

  // Pass 2: positional scan for unambiguous markers that appear mid-sentence
  // (OCR omits the period between oracle text and commentary)
  if (result.length > 200) {
    let cutPos = result.length;
    for (const marker of POSITIONAL_MARKERS) {
      const m = marker.exec(result);
      if (m && m.index > 30 && m.index < cutPos) cutPos = m.index;
    }
    if (cutPos < result.length) {
      // Trim back to the last sentence boundary before the marker
      const beforeCut = result.slice(0, cutPos);
      const lastPeriod = beforeCut.lastIndexOf('.');
      if (lastPeriod > 30) result = result.slice(0, lastPeriod + 1).trim();
    }
  }

  // Hard cap: still too long means residual contamination — truncate at 400 chars
  if (result.length > 400) {
    const cutoff = result.lastIndexOf('. ', 400);
    if (cutoff > 50) result = result.slice(0, cutoff + 1).trim();
  }

  return result.length > 20 ? result : text;
}

// ─── Text cleanup ─────────────────────────────────────────────────────────────

function fixHyphenation(text: string): string {
  // The parser already collapsed newlines to spaces, so broken words look like:
  // "tranquil- lity", "pre- supposes", "develop- ment"
  // Pattern: word char + hyphen + one or more spaces + lowercase letter
  // This reliably identifies scan line-breaks (legitimate hyphens never have trailing spaces)
  return text
    .replace(/(\w)-\s+([a-z])/g, '$1$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanText(text: string | undefined): string {
  if (!text) return '';
  return fixHyphenation(text);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const db: HexagramDatabase = JSON.parse(readFileSync(PATH, 'utf-8'));
  const corrections: string[] = [];

  for (const hexagram of db.hexagrams) {
    for (const t of hexagram.translations) {
      if (t.source !== 'legge') continue;

      // Fix name
      if (NAME_CORRECTIONS[hexagram.number]) {
        const before = t.name;
        t.name = NAME_CORRECTIONS[hexagram.number];
        corrections.push(`Hex ${hexagram.number}: name "${before}" → "${t.name}"`);
      }

      // Apply hard correction or heuristic truncation
      const beforeLen = t.judgment.length;
      let cleanedJudgment: string;
      if (JUDGMENT_CORRECTIONS[hexagram.number]) {
        cleanedJudgment = JUDGMENT_CORRECTIONS[hexagram.number];
        corrections.push(`Hex ${hexagram.number}: judgment hard-corrected ${beforeLen} → ${cleanedJudgment.length} chars`);
      } else {
        cleanedJudgment = truncateJudgmentAtCommentary(t.judgment);
        if (cleanedJudgment.length < beforeLen - 10) {
          corrections.push(`Hex ${hexagram.number}: judgment truncated ${beforeLen} → ${cleanedJudgment.length} chars`);
        }
      }

      // Fix hyphenation in all text fields
      t.judgment = cleanText(cleanedJudgment);
      if (t.image) t.image = cleanText(t.image);
      if (t.judgmentCommentary) t.judgmentCommentary = cleanText(t.judgmentCommentary);
      if (t.useOfNine) t.useOfNine = cleanText(t.useOfNine);
      if (t.useOfSix)  t.useOfSix  = cleanText(t.useOfSix);

      for (const line of t.lines) {
        line.text = cleanText(line.text);
        if (line.imageCommentary) line.imageCommentary = cleanText(line.imageCommentary);
      }
    }
  }

  writeFileSync(PATH, JSON.stringify(db, null, 2), 'utf-8');

  console.log(`Fixed ${corrections.length} name corrections:`);
  corrections.forEach(c => console.log(' ', c));
  console.log('\nHyphenation cleaned across all text fields.');
  console.log(`Written to ${PATH}`);
}

main();
