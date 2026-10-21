#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json` in web chat tests. Behaviour is chosen by FAKE_STREAM;
// FAKE_ARGV, if set, receives the argv as JSON; FAKE_PARTS, if set, is a JSON array of answer texts,
// each sent as its own assistant message (as real stream-json does around tool calls).
import { writeFileSync } from 'node:fs';

const mode = process.env.FAKE_STREAM ?? 'ok';
const argv = process.argv.slice(2);
if (process.env.FAKE_ARGV) writeFileSync(process.env.FAKE_ARGV, JSON.stringify(argv));
const emit = obj => console.log(JSON.stringify(obj));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const resumeAt = argv.indexOf('--resume');
const sessionId = resumeAt !== -1 ? argv[resumeAt + 1] : `sess-${process.pid}`;
const text = t => emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

if (mode === 'badresume' && resumeAt !== -1) {
  console.error(`No conversation found with session ID: ${sessionId}`);
  process.exit(1);
}

emit({ type: 'system', subtype: 'init', session_id: sessionId, tools: [], model: 'fake' });
if (mode === 'limit') {
  emit({ type: 'result', subtype: 'success', is_error: true, result: 'Claude usage limit reached ∙ resets 3pm', session_id: sessionId });
  process.exit(1);
}
if (mode === 'termlate') {
  // Hangs until SIGTERM, then takes 100 ms to exit on its own.
  process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));
  text('Думаю…');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const parts = process.env.FAKE_PARTS ? JSON.parse(process.env.FAKE_PARTS) : ['Привет.', 'Это планировщик.', 'Чем помочь?'];
for (const p of parts) {
  if (mode === 'slow') await sleep(300);
  text(p);
}
emit({ type: 'result', subtype: 'success', is_error: false, result: parts.at(-1), session_id: sessionId });
// 'linger': the answer is complete, but the process takes a while to exit (a «Стоп» can land in between).
if (mode === 'linger') await sleep(2000);
