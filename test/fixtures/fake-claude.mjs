#!/usr/bin/env node
// Stand-in for the `claude` binary in tests. Behaviour is chosen by FAKE_MODE.
const mode = process.env.FAKE_MODE ?? 'ok';
const result = (isError, text) => console.log(JSON.stringify({ type: 'result', is_error: isError, result: text }));

if (mode === 'ok') {
  result(false, 'done');
} else if (mode === 'limit') {
  result(true, 'Claude usage limit reached ∙ resets 3pm');
  process.exitCode = 1;
} else if (mode === 'hang') {
  console.log('working...');
  setInterval(() => {}, 1000);
}
