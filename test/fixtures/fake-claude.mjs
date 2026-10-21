#!/usr/bin/env node
// Stand-in for the `claude` binary in tests. Behaviour is chosen by FAKE_MODE.
let mode = process.env.FAKE_MODE ?? 'ok';
const result = (isError, text) => console.log(JSON.stringify({ type: 'result', is_error: isError, result: text }));

// `slow`: a long iteration — waits 2 s, then behaves like `tick`.
if (mode === 'slow') {
  await new Promise(r => setTimeout(r, 2000));
  mode = 'tick';
}

if (mode === 'ok') {
  result(false, 'done');
} else if (mode === 'limit') {
  result(true, 'Claude usage limit reached ∙ resets 3pm');
  process.exitCode = 1;
} else if (mode === 'tick') {
  // Tick every box of the first unfinished task in FAKE_PLAN, like a successful real run.
  const { readFileSync, writeFileSync } = await import('node:fs');
  const lines = readFileSync(process.env.FAKE_PLAN, 'utf8').split('\n');
  const first = lines.findIndex(l => l.startsWith('- [ ]'));
  if (first !== -1) {
    let start = first;
    while (start > 0 && !lines[start].startsWith('### ')) start--;
    for (let i = start + 1; i < lines.length && !lines[i].startsWith('#'); i++) lines[i] = lines[i].replace('- [ ]', '- [x]');
    writeFileSync(process.env.FAKE_PLAN, lines.join('\n'));
  }
  result(false, 'ticked');
} else if (mode === 'killparent') {
  process.kill(process.ppid, 'SIGKILL');
} else if (mode === 'hang') {
  console.log('working...');
  setInterval(() => {}, 1000);
}
