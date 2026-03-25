import 'dotenv/config';
import http from 'http';
import { fetchHexagramContext } from './query/retrieve.js';
import { interpret } from './query/interpret.js';

const PORT = process.env.PORT ?? 3000;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Yi Jing</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Georgia, serif;
    background: #f7f3ee;
    color: #3d3530;
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 48px 16px;
  }
  .container { width: 100%; max-width: 640px; background: #faf8f4; border: 1.5px solid #c4b8e0; border-radius: 8px; padding: 28px 32px 36px; box-shadow: 0 2px 24px rgba(112, 96, 168, 0.08); }
  h1 { font-size: 1.6rem; font-weight: normal; letter-spacing: 0.14em; margin-bottom: 32px; color: #7060a8; }
  label { display: block; font-size: 0.75rem; letter-spacing: 0.09em; color: #9c8878; margin-bottom: 6px; text-transform: uppercase; }
  input[type="number"] {
    width: 80px;
    background: #fff;
    border: 1px solid #ddd3c8;
    color: #3d3530;
    padding: 8px 10px;
    font-family: Georgia, serif;
    font-size: 1rem;
    border-radius: 3px;
  }
  input[type="number"]:focus { outline: none; border-color: #b09888; box-shadow: 0 0 0 3px #e8ddd5; }
  .hex-row { display: grid; grid-template-columns: auto 1fr; column-gap: 32px; row-gap: 6px; align-items: center; }
  .hex-row > label { align-self: start; }
  .lines-group { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 4px; }
  .line-check { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .line-check input[type="checkbox"] { width: 15px; height: 15px; accent-color: #9b7e6a; cursor: pointer; }
  .line-check span { font-size: 0.85rem; color: #7a6858; }
  textarea {
    width: 100%;
    background: #fff;
    border: 1px solid #ddd3c8;
    color: #3d3530;
    padding: 10px 12px;
    font-family: Georgia, serif;
    font-size: 0.95rem;
    line-height: 1.6;
    border-radius: 3px;
    resize: vertical;
    min-height: 80px;
  }
  textarea:focus { outline: none; border-color: #b09888; box-shadow: 0 0 0 3px #e8ddd5; }
  .field { margin-bottom: 24px; }
  button {
    background: #7060a8;
    border: none;
    color: #fff;
    padding: 10px 30px;
    font-family: Georgia, serif;
    font-size: 0.9rem;
    letter-spacing: 0.06em;
    cursor: pointer;
    border-radius: 3px;
    transition: background 0.15s;
  }
  button:hover { background: #5d4e92; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  #result { margin-top: 44px; }
  .hex-header { margin-bottom: 20px; }
  .hex-number { font-size: 0.72rem; letter-spacing: 0.1em; color: #a08878; text-transform: uppercase; }
  .hex-title { font-size: 1.35rem; margin-top: 4px; color: #3d3530; }
  .hex-char { font-size: 1.8rem; color: #7060a8; margin-right: 6px; vertical-align: middle; }
  .hex-resulting { margin-top: 14px; padding-top: 14px; border-top: 1px solid #e0d4cb; }
  .hex-resulting .hex-number { color: #b8a898; }
  .hex-resulting .hex-title { font-size: 1.05rem; color: #6a5848; }
  .interpretation { margin-top: 28px; line-height: 1.85; font-size: 0.97rem; color: #4a3e38; padding-top: 24px; border-top: 1px solid #e0d4cb; }
  .error { color: #b05050; font-size: 0.9rem; margin-top: 24px; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #e8ddd5; border-top-color: #7060a8; border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle; margin-right: 8px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .about { margin-bottom: 36px; }
  .about summary { font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: #9c8878; cursor: pointer; user-select: none; }
  .about summary:hover { color: #7060a8; }
  .about { margin-top: 48px; }
  .about p { margin-top: 12px; font-size: 0.88rem; line-height: 1.75; color: #6a5e55; }
  .about p + p { margin-top: 8px; }
  .about .privacy { margin-top: 12px; font-size: 0.78rem; line-height: 1.6; color: #b0a090; font-style: italic; }
</style>
</head>
<body>
<div class="container">
  <h1>易經</h1>
  <form id="form">
    <div class="field">
      <label for="question">Question <span style="color:#7060a8">(optional)</span></label>
      <textarea id="question" name="question" placeholder="What is present in this moment…"></textarea>
    </div>
    <div class="field hex-row">
      <label for="hexNum">Hexagram</label>
      <label>Moving lines</label>
      <input type="number" id="hexNum" name="hexNum" min="1" max="64" placeholder="1–64" required>
      <div class="lines-group">
        ${[1,2,3,4,5,6].map(n => `<label class="line-check"><input type="checkbox" name="line" value="${n}"><span>${n}</span></label>`).join('')}
      </div>
    </div>
    <button type="submit" id="submitBtn">Interpret</button>
  </form>
  <div id="result"></div>
  <details class="about">
    <summary>About</summary>
    <p>The Yi Jing (I Ching) is one of the oldest texts in the world — a Chinese classic of divination and philosophy, composed over centuries, that maps sixty-four hexagrams onto the whole range of human situations. Each hexagram is built from two trigrams (natural images: water, fire, mountain, wind) and carries a judgment, an image, and readings for each of its six lines.</p>
    <p>This tool interprets a hexagram you have already cast. Enter your hexagram number, mark any moving lines (lines that transform, pointing toward a resulting hexagram), and optionally a question. The interpretation is generated by Claude, grounded exclusively in two classical translations: James Legge (1882) and Richard Wilhelm (1923), supplemented by semantically retrieved passages from the Ta Chuan, Shuo Gua, Tao Te Ching, Chuang Tzu, and the Analects.</p>
    <p>The AI does not invent — it reads. But it can be wrong. Bring your own discernment.</p>
    <p class="privacy">Your questions and interpretations are your own — nothing is stored or logged.</p>
  </details>
</div>
<script>
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  const resultEl = document.getElementById('result');
  btn.disabled = true;
  resultEl.innerHTML = '<span class="spinner"></span>';

  const hexNum = parseInt(document.getElementById('hexNum').value, 10);
  const movingLines = [...document.querySelectorAll('input[name="line"]:checked')].map(el => parseInt(el.value, 10));
  const question = document.getElementById('question').value.trim();

  try {
    const res = await fetch('/api/reading', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hexNum, movingLines, question: question || null }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Unknown error');

    let html = '<div class="hex-header">';
    html += \`<div class="hex-number">Hexagram \${data.primary.number}</div>\`;
    html += \`<div class="hex-title"><span class="hex-char">\${data.primary.character}</span>\${data.primary.chineseName} — \${data.primary.name}</div>\`;
    if (data.resulting) {
      html += '<div class="hex-resulting">';
      html += \`<div class="hex-number">Resulting · Hexagram \${data.resulting.number}</div>\`;
      html += \`<div class="hex-title"><span class="hex-char">\${data.resulting.character}</span>\${data.resulting.chineseName} — \${data.resulting.name}</div>\`;
      html += '</div>';
    }
    html += '</div>';
    html += \`<div class="interpretation">\${data.text.replace(/\\n/g, '<br>')}</div>\`;
    resultEl.innerHTML = html;
  } catch (err) {
    resultEl.innerHTML = \`<div class="error">\${err.message}</div>\`;
  } finally {
    btn.disabled = false;
  }
});
</script>
</body>
</html>`;

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleReading(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = '';
  for await (const chunk of req) body += chunk;

  let hexNum: number, movingLines: number[], question: string | null;
  try {
    const parsed = JSON.parse(body);
    hexNum = parsed.hexNum;
    movingLines = Array.isArray(parsed.movingLines) ? parsed.movingLines : [];
    question = parsed.question ?? null;
    if (!Number.isInteger(hexNum) || hexNum < 1 || hexNum > 64) throw new Error('hexNum must be 1–64');
  } catch (err: any) {
    return sendJson(res, 400, { error: err.message });
  }

  try {
    const ctx = await fetchHexagramContext(hexNum, movingLines);
    const { interpretations } = await interpret(ctx, movingLines, question, 'brief', { claudeOnly: true });
    const claudeText = interpretations[0]?.text ?? '';

    // Get Wilhelm name (preferred) or Legge name for primary hex
    const primaryTrans = ctx.translations.find(t => t.source === 'wilhelm') ?? ctx.translations[0];
    const resultingTrans = ctx.resulting
      ? (ctx.resulting.translations.find(t => t.source === 'wilhelm') ?? ctx.resulting.translations[0])
      : null;

    sendJson(res, 200, {
      primary: {
        number: ctx.number,
        character: ctx.character,
        chineseName: ctx.chineseName,
        name: primaryTrans?.name ?? '',
      },
      resulting: ctx.resulting ? {
        number: ctx.resulting.number,
        character: ctx.resulting.character,
        chineseName: ctx.resulting.chineseName,
        name: resultingTrans?.name ?? '',
      } : null,
      text: claudeText,
    });
  } catch (err: any) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    const buf = Buffer.from(HTML, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/reading') {
    handleReading(req, res).catch(err => {
      console.error(err);
      sendJson(res, 500, { error: 'Internal error' });
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Yi Jing server listening on http://localhost:${PORT}`);
});
