import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import type { Hexagram, HexagramTranslation, LineText, HexagramDatabase } from './types.js';

const BASE_URL = 'https://ctext.org';
const DELAY_MIN = 5000;
const DELAY_JITTER = 2000;

// All 64 hexagram slugs in King Wen order, from the ctext.org index
const HEXAGRAM_SLUGS = [
  'qian', 'kun', 'zhun', 'meng', 'xu', 'song', 'shi', 'bi',
  'xiao-xu', 'lv', 'tai', 'pi', 'tong-ren', 'da-you', 'qian2', 'yu',
  'sui', 'gu', 'lin', 'guan', 'shi-he', 'bi2', 'bo', 'fu',
  'wu-wang', 'da-xu', 'yi', 'da-guo', 'kan', 'li',
  'xian', 'heng', 'dun', 'da-zhuang', 'jin', 'ming-yi',
  'jia-ren', 'kui', 'jian', 'jie', 'sun', 'yi2', 'guai', 'gou',
  'cui', 'sheng', 'kun2', 'jing', 'ge', 'ding',
  'zhen', 'gen', 'jian2', 'gui-mei', 'feng', 'lv2', 'xun', 'dui',
  'huan', 'jie2', 'zhong-fu', 'xiao-guo', 'ji-ji', 'wei-ji',
];

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
}

async function scrapeHexagram(
  slug: string,
  hexNumber: number
): Promise<HexagramTranslation> {
  const url = `${BASE_URL}/book-of-changes/${slug}`;
  console.log(`  Fetching ${hexNumber}/64: ${url}`);

  let html = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    html = await res.text();
    if (html.includes('confirm that you are human')) {
      console.warn(`  ⏳ Captcha on attempt ${attempt} for hex ${hexNumber}, waiting 60s...`);
      await sleep(60_000);
      continue;
    }
    break;
  }
  if (html.includes('confirm that you are human')) {
    throw new Error(`Captcha block persisted for ${url} after 3 attempts`);
  }
  const $ = cheerio.load(html);

  // Each content row has id="n{number}"
  // English rows have class="etext" on their td, prefixed with section label
  // e.g. "Kan: ...", "Tuan Zhuan: ...", "Xiang Zhuan: ..."

  // Collect all English text rows in order
  const englishRows: { label: string; text: string }[] = [];

  $('tr[id]').each((_, row) => {
    const etextTd = $(row).find('td.etext');
    if (!etextTd.length) return;

    const raw = cleanText(etextTd.text());
    if (!raw) return;

    // Split on first colon to get label and content
    const colonIdx = raw.indexOf(':');
    if (colonIdx === -1) return;

    const label = raw.slice(0, colonIdx).trim();
    const text = raw.slice(colonIdx + 1).trim();

    if (text) englishRows.push({ label, text });
  });

  // Now parse the rows into our schema.
  // Pattern per hexagram page:
  //   [hexName]:       judgment
  //   Tuan Zhuan:      judgment commentary
  //   Xiang Zhuan:     image text
  //   [hexName]:       line 1 text      ← repeated 6 times
  //   Xiang Zhuan:     line 1 image
  //   ...
  //   [hexName]:       line 6 text
  //   Xiang Zhuan:     line 6 image
  //   (optionally)
  //   [hexName]:       use of nine / use of six  (hex 1 & 2)

  // Identify the hexagram label (first label that isn't "Tuan Zhuan" or "Xiang Zhuan")
  const hexLabel = englishRows.find(
    r => r.label !== 'Tuan Zhuan' && r.label !== 'Xiang Zhuan'
  )?.label ?? '';

  const hexRows = englishRows.filter(r => r.label === hexLabel);
  const tuanZhuan = englishRows.find(r => r.label === 'Tuan Zhuan');
  const xiangRows = englishRows.filter(r => r.label === 'Xiang Zhuan');

  // hexRows[0] = judgment, hexRows[1..6] = lines 1-6, hexRows[7] = use of nine/six if present
  const judgment = hexRows[0]?.text ?? '';
  const judgmentCommentary = tuanZhuan?.text;
  const image = xiangRows[0]?.text ?? '';

  const lines: LineText[] = [];
  for (let i = 1; i <= 6; i++) {
    lines.push({
      number: i as 1 | 2 | 3 | 4 | 5 | 6,
      text: hexRows[i]?.text ?? '',
      imageCommentary: xiangRows[i]?.text,
    });
  }

  const result: HexagramTranslation = {
    source: 'legge',
    name: hexLabel,
    judgment,
    judgmentCommentary,
    image,
    lines,
  };

  // Use of Nine (hex 1) / Use of Six (hex 2)
  if (hexNumber === 1 && hexRows[7]) result.useOfNine = hexRows[7].text;
  if (hexNumber === 2 && hexRows[7]) result.useOfSix = hexRows[7].text;

  // Validate
  const missing = lines.filter(l => !l.text);
  if (missing.length) {
    console.warn(`  ⚠ Hex ${hexNumber}: missing text for lines ${missing.map(l => l.number).join(', ')}`);
  }
  if (!judgment) console.warn(`  ⚠ Hex ${hexNumber}: missing judgment`);
  if (!image) console.warn(`  ⚠ Hex ${hexNumber}: missing image`);

  return result;
}

async function main() {
  // Load structural data from strobus.json
  const strobus = JSON.parse(readFileSync('strobus.json', 'utf-8'));
  const strobusHexagrams: Record<number, any> = {};
  for (const h of strobus.hexagrams) {
    strobusHexagrams[h.number] = h;
  }

  // Resume from existing file if present
  // Write to a separate file — don't overwrite the hand-edited legge OCR JSON
  const OUTPUT_PATH = 'src/data/hexagrams-ctext.json';
  const existing: Record<number, Hexagram> = {};
  if (existsSync(OUTPUT_PATH)) {
    const prev: HexagramDatabase = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8'));
    for (const h of prev.hexagrams) {
      if (h.translations.length > 0) existing[h.number] = h;
    }
    console.log(`Resuming — ${Object.keys(existing).length} hexagrams already scraped`);
  }

  const hexagrams: Hexagram[] = [];

  for (let i = 0; i < HEXAGRAM_SLUGS.length; i++) {
    const hexNumber = i + 1;
    const slug = HEXAGRAM_SLUGS[i];
    const structural = strobusHexagrams[hexNumber];

    // Skip already-scraped hexagrams
    if (existing[hexNumber]) {
      hexagrams.push(existing[hexNumber]);
      console.log(`  ↩ Hexagram ${hexNumber}: already scraped, skipping`);
      continue;
    }

    try {
      const translation = await scrapeHexagram(slug, hexNumber);

      hexagrams.push({
        number: hexNumber,
        binary: structural.binary,
        chineseName: structural.chineseName,
        pinyin: structural.pinyinName,
        character: structural.character,
        upperTrigram: structural.topTrigram,
        lowerTrigram: structural.bottomTrigram,
        translations: [translation],
      });

      console.log(`  ✓ Hexagram ${hexNumber}: ${translation.name}`);
      // Save incrementally so a crash doesn't lose progress
      const partial: HexagramDatabase = { version: '1.0.0', sources: ['legge'], hexagrams };
      writeFileSync(OUTPUT_PATH, JSON.stringify(partial, null, 2), 'utf-8');
    } catch (err) {
      console.error(`  ✗ Hexagram ${hexNumber} (${slug}): ${err}`);
      // Push a placeholder so we don't lose position
      hexagrams.push({
        number: hexNumber,
        binary: structural?.binary ?? '',
        chineseName: structural?.chineseName ?? '',
        pinyin: structural?.pinyinName ?? '',
        character: structural?.character ?? '',
        upperTrigram: structural?.topTrigram ?? 0,
        lowerTrigram: structural?.bottomTrigram ?? 0,
        translations: [],
      });
    }

    if (i < HEXAGRAM_SLUGS.length - 1) {
      const delay = DELAY_MIN + Math.floor(Math.random() * DELAY_JITTER);
      await sleep(delay);
    }
  }

  const db: HexagramDatabase = {
    version: '1.0.0',
    sources: ['legge'],
    hexagrams,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(db, null, 2), 'utf-8');
  console.log(`\nDone. Wrote ${hexagrams.length} hexagrams to src/data/hexagrams.json`);
}

main().catch(console.error);
