/**
 * Interpretation layer — builds the prompt and calls Claude + GPT-4 in parallel.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { semanticSearch } from './retrieve.js';
import type { HexagramContext, SemanticChunk } from './retrieve.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type ResponseMode = 'brief' | 'deep';

export interface Interpretation {
  model: string;
  mode: ResponseMode;
  text: string;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------
function buildPrompt(
  ctx: HexagramContext,
  movingLines: number[],
  question: string | null,
  mode: ResponseMode,
  wisdomChunks: SemanticChunk[]
): string {
  const lines: string[] = [];

  lines.push(`You are steeped in the Yi Jing (I Ching) and the philosophical current it moves within. Your interpretation must be grounded exclusively in the traditional texts provided below.`);
  lines.push(`IMPORTANT: Do not introduce hexagram meanings, line interpretations, trigram attributes, or any Yi Jing content from your training data. Every claim must be traceable to the texts given. If the provided texts do not speak to something, do not speculate.`);
  lines.push(`The Yi thinks in images, in movements, in the dynamic between yielding and pressing forward. It does not prescribe — it illuminates the texture of a moment. Write from within that mode of perception: attend to what is present, what is in motion, what the image asks of the person who encounters it. Do not resolve what the Yi holds open. Paradox and indirection are sometimes the most precise response.`);
  lines.push('');

  // Hexagram identity
  lines.push(`## Hexagram ${ctx.number} — ${ctx.character} ${ctx.chineseName} (${ctx.pinyin})`);
  lines.push('');

  // All translations
  for (const t of ctx.translations) {
    lines.push(`### ${t.source === 'legge' ? 'Legge' : 'Wilhelm'}: ${t.name}`);
    lines.push(`**Judgment:** ${t.judgment}`);
    if (t.judgmentCommentary) {
      lines.push(`**Commentary:** ${t.judgmentCommentary}`);
    }
    lines.push(`**Image:** ${t.image}`);

    if (t.movingLines.length > 0) {
      lines.push('**Moving lines:**');
      for (const ml of t.movingLines) {
        lines.push(`- Line ${ml.lineNumber}: ${ml.text}`);
        if (ml.commentary) {
          lines.push(`  *Commentary:* ${ml.commentary}`);
        }
      }
    }
    lines.push('');
  }

  // Moving lines summary + resulting hexagram
  if (movingLines.length > 0) {
    lines.push(`**Moving lines in this reading:** ${movingLines.join(', ')}`);
    lines.push('');

    if (ctx.resulting) {
      const r = ctx.resulting;
      lines.push(`## Resulting Hexagram — ${r.number}: ${r.character} ${r.chineseName} (${r.pinyin})`);
      lines.push('');
      for (const t of r.translations) {
        lines.push(`### ${t.source === 'legge' ? 'Legge' : 'Wilhelm'}: ${t.name}`);
        lines.push(`**Judgment:** ${t.judgment}`);
        lines.push(`**Image:** ${t.image}`);
        lines.push('');
      }
    }
  }

  // Wisdom corpus — semantically retrieved passages
  if (wisdomChunks.length > 0) {
    lines.push(`## Resonant Texts`);
    lines.push(`The following passages were retrieved from the broader tradition as contextually resonant. They may come from the Yi Jing's own philosophical appendices (Ta Chuan, Shuo Gua), the Tao Te Ching, Chuang Tzu, or the Analects. Let them inform the quality of thinking and the mode of perception — not as direct commentary on the hexagram, but as the wider current of thought within which this reading flows.`);
    lines.push('');
    for (const chunk of wisdomChunks) {
      const chunkLabels: Record<string, string> = {
        tao_te_ching: `Tao Te Ching, Chapter ${chunk.line_number} (Legge)`,
        ta_chuan:     `Ta Chuan (Great Treatise), Chapter ${chunk.line_number} (Legge)`,
        shuo_gua:     `Shuo Gua (Treatise on Trigrams), Chapter ${chunk.line_number} (Legge)`,
        chuang_tzu:   `Chuang Tzu, Chapter ${chunk.line_number} (Giles)`,
        analects:     `Analects of Confucius, Book ${Math.floor(chunk.line_number! / 1000)}, Chapter ${chunk.line_number! % 1000} (Legge)`,
      };
      const label = chunkLabels[chunk.chunk_type] ?? `${chunk.chunk_type}, ${chunk.source}`;
      lines.push(`### ${label}`);
      lines.push(chunk.content);
      lines.push('');
    }
  }

  // User's question
  if (question) {
    lines.push(`## The querent's question`);
    lines.push(question);
    lines.push('');
  }

  // Response instructions
  if (mode === 'brief') {
    lines.push(`## Your response`);
    lines.push(`Write a single paragraph (4–6 sentences) that captures the quality of this moment as the texts reveal it${question ? ' in relation to the question' : ''}. Not a summary of the hexagram — an encounter with it. Let the Image be present. Draw on both Legge and Wilhelm without citing them. Speak as if the reading itself is already the counsel.`);
  } else {
    lines.push(`## Your response`);
    lines.push(`Provide a structured interpretation with the following sections:`);
    lines.push('');
    lines.push(`**The Hexagram** — The nature of this moment as the hexagram reveals it. Not what to do — what is.`);
    lines.push('');
    lines.push(`**The Image** — What the natural image shows about how to hold oneself within this moment.`);
    if (movingLines.length > 0) {
      lines.push('');
      lines.push(`**Moving Lines** — What is in motion, what is turning. Each moving line (${movingLines.join(', ')}) as indicator of where energy is shifting — not instruction, but direction of movement.`);
    }
    lines.push('');
    if (ctx.resulting) {
      lines.push(`**The Resulting Hexagram** — Where the current leads. Interpret on its own terms, then attend to the movement between the two hexagrams — what is being left behind, what is emerging.`);
      lines.push('');
    }
    lines.push(`**The Shape of the Moment** — How the elements of this reading cohere${question ? ' in relation to the question' : ''}. Not a logical argument — a coherent picture. If there is tension, hold it rather than resolve it.`);
    lines.push('');
    lines.push(`**Orientation** — Not a prescription, but a sense of direction: what quality of attention, what mode of being, what the hexagram asks. The Yi does not command — it orients.`);
    lines.push('');
    lines.push(`Draw on both translations without citing them explicitly. Be direct. Avoid generic wisdom-speak.`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// LLM calls
// ---------------------------------------------------------------------------
async function callClaude(prompt: string, mode: ResponseMode): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: mode === 'brief' ? 300 : 1200,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = response.content[0];
  return block.type === 'text' ? block.text : '';
}

async function callGPT4(prompt: string, mode: ResponseMode): Promise<string> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: mode === 'brief' ? 300 : 1200,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.choices[0].message.content ?? '';
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function interpret(
  ctx: HexagramContext,
  movingLines: number[],
  question: string | null,
  mode: ResponseMode,
  options: { claudeOnly?: boolean } = {}
): Promise<{ interpretations: Interpretation[]; prompt: string }> {
  // Two search queries:
  // 1. The question + hexagram identity — finds passages relevant to the querent's situation
  // 2. The hexagram's judgment texts — finds passages resonant with the hexagram's themes
  const questionQuery = [
    question,
    `${ctx.chineseName} ${ctx.pinyin}`,
    ctx.translations.map(t => t.name).join(' '),
  ].filter(Boolean).join('. ');

  const judgmentQuery = ctx.translations
    .map(t => t.judgment)
    .join(' ');

  const wisdomChunks = await semanticSearch([questionQuery, judgmentQuery]);

  const prompt = buildPrompt(ctx, movingLines, question, mode, wisdomChunks);

  const claudeText = await callClaude(prompt, mode);
  const interpretations: Interpretation[] = [
    { model: 'claude-sonnet-4-6', mode, text: claudeText },
  ];

  if (!options.claudeOnly) {
    const gptText = await callGPT4(prompt, mode);
    interpretations.push({ model: 'gpt-4o', mode, text: gptText });
  }

  return { prompt, interpretations };
}
