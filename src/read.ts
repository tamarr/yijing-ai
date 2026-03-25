/**
 * CLI entry point for a Yi Jing reading.
 *
 * Usage:
 *   npx tsx src/read.ts <hexagram> [moving lines] [--deep] [--question "..."]
 *
 * Examples:
 *   npx tsx src/read.ts 29
 *   npx tsx src/read.ts 29 2,4
 *   npx tsx src/read.ts 29 2,4 --deep
 *   npx tsx src/read.ts 29 2,4 --deep --question "Should I take this new role?"
 */

import 'dotenv/config';
import { fetchHexagramContext } from './query/retrieve.js';
import { interpret, type ResponseMode } from './query/interpret.js';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: npx tsx src/read.ts <hexagram> [moving lines] [--deep] [--question "..."]');
  process.exit(1);
}

const hexNumber = parseInt(args[0]);
if (isNaN(hexNumber) || hexNumber < 1 || hexNumber > 64) {
  console.error('Hexagram must be a number between 1 and 64');
  process.exit(1);
}

const movingLines: number[] = args[1] && !args[1].startsWith('--')
  ? args[1].split(',').map(n => parseInt(n.trim())).filter(n => n >= 1 && n <= 6)
  : [];

const mode: ResponseMode = args.includes('--deep') ? 'deep' : 'brief';
const debug = args.includes('--debug');

const questionIdx = args.indexOf('--question');
const question = questionIdx !== -1 ? args[questionIdx + 1] ?? null : null;

console.log(`\nHexagram ${hexNumber}${movingLines.length > 0 ? `, moving lines: ${movingLines.join(', ')}` : ''}`);
console.log(`Mode: ${mode}${question ? ` | Question: "${question}"` : ''}`);
console.log('Fetching context and generating interpretations...\n');

const ctx = await fetchHexagramContext(hexNumber, movingLines);
console.log(`Primary:   ${ctx.character} ${ctx.chineseName} (${ctx.pinyin}) — Hexagram ${ctx.number}`);
if (ctx.resulting) {
  console.log(`Resulting: ${ctx.resulting.character} ${ctx.resulting.chineseName} (${ctx.resulting.pinyin}) — Hexagram ${ctx.resulting.number}`);
}
console.log();

const { prompt, interpretations } = await interpret(ctx, movingLines, question, mode);

if (debug) {
  console.log(`${'═'.repeat(60)}`);
  console.log('PROMPT SENT TO LLMs');
  console.log(`${'═'.repeat(60)}`);
  console.log(prompt);
  console.log(`${'═'.repeat(60)}\n`);
}

for (const result of interpretations) {
  console.log(`${'─'.repeat(60)}`);
  console.log(`${result.model.toUpperCase()}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(result.text);
  console.log();
}

process.exit(0);
