import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, splitSuggestion } from '../web/markdown.mjs';

test('heading → h3', () => {
  assert.equal(renderMarkdown('# Заголовок'), '<h3>Заголовок</h3>');
  assert.equal(renderMarkdown('### Ниже'), '<h3>Ниже</h3>');
});
test('bold, italic, inline code', () => {
  assert.equal(renderMarkdown('**b** и *i* и `c`'), '<p><strong>b</strong> и <em>i</em> и <code>c</code></p>');
});
test('inline code is not further formatted', () => {
  assert.equal(renderMarkdown('`**x**`'), '<p><code>**x**</code></p>');
});
test('unordered list', () => {
  assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
});
test('ordered list', () => {
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
});
test('checkbox items', () => {
  assert.equal(renderMarkdown('- [x] t\n- [ ] u'),
    '<ul><li class="task done"><input type="checkbox" checked disabled> t</li>' +
    '<li class="task"><input type="checkbox" disabled> u</li></ul>');
});
test('code block keeps indentation and escapes contents', () => {
  const src = '```js\nif (a < b) {\n    x = "<b>";\n}\n```';
  assert.equal(renderMarkdown(src), '<pre><code>if (a &lt; b) {\n    x = &quot;&lt;b&gt;&quot;;\n}</code></pre>');
});
test('code block is not formatted as markdown', () => {
  assert.equal(renderMarkdown('```\n# no\n- no **no**\n```'), '<pre><code># no\n- no **no**</code></pre>');
});
test('https link', () => {
  assert.equal(renderMarkdown('[t](https://x)'), '<p><a href="https://x" target="_blank" rel="noopener">t</a></p>');
});
test('paragraphs split by blank line, lines joined with <br>', () => {
  assert.equal(renderMarkdown('a\nb\n\nc'), '<p>a<br>b</p><p>c</p>');
});

test('XSS: script tag stays text', () => {
  const out = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!out.includes('<script'), out);
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), out);
});
test('XSS: img onerror stays text', () => {
  const out = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'), out);
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), out);
});
test('XSS: javascript: link is not a link', () => {
  const out = renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!out.includes('<a'), out);
  assert.ok(!/href/i.test(out), out);
});
test('XSS: quotes in link url cannot break out of href', () => {
  const out = renderMarkdown('[x](https://a" onmouseover="alert(1))');
  assert.ok(!/<a [^>]*onmouseover/.test(out), out);
});
test('XSS: html inside headings, lists and links stays text', () => {
  const out = renderMarkdown('# <b>h</b>\n- <i>l</i>\n[<img src=x>](https://x)');
  assert.ok(!/<(b|i|img)[ >]/.test(out), out);
});

test('200 KB renders under 200 ms', () => {
  const chunk = '# Заголовок\nТекст с **жирным**, *курсивом* и `кодом` [ссылка](https://x).\n- [x] пункт\n1. номер\n\n```\ncode <b>\n```\n';
  const src = chunk.repeat(Math.ceil(200 * 1024 / chunk.length));
  renderMarkdown(src);
  const t0 = performance.now();
  renderMarkdown(src);
  const ms = performance.now() - t0;
  assert.ok(ms < 200, `${ms} ms`);
});
test('pathological input renders fast', () => {
  const src = '*'.repeat(50000) + '`'.repeat(50000) + '['.repeat(50000) + '](' .repeat(20000);
  const t0 = performance.now();
  renderMarkdown(src);
  assert.ok(performance.now() - t0 < 200);
});

test('markdown: код внутри ссылки', () => {
  const out = renderMarkdown('[`a`](https://x.y)');
  assert.match(out, /<a href="https:\/\/x\.y"[^>]*><code>a<\/code><\/a>/);
  assert.ok(!out.includes('\u0000'), JSON.stringify(out));
});

test('suggestion: last line is cut, text trimmed', () => {
  assert.deepEqual(splitSuggestion('Готово.\n\n<!-- suggest:   Да, запускай  -->\n'),
    { body: 'Готово.', suggestion: 'Да, запускай' });
});
test('suggestion: line in the middle is left alone', () => {
  const text = 'a\n<!-- suggest: Да -->\nb';
  assert.deepEqual(splitSuggestion(text), { body: text, suggestion: null });
});
test('suggestion: no line → null', () => {
  assert.deepEqual(splitSuggestion('Просто ответ'), { body: 'Просто ответ', suggestion: null });
});
test('suggestion: empty → null', () => {
  const text = 'Ответ\n<!-- suggest:   -->';
  assert.deepEqual(splitSuggestion(text), { body: text, suggestion: null });
});
test('suggestion: longer than 200 chars → null', () => {
  const text = `Ответ\n<!-- suggest: ${'я'.repeat(201)} -->`;
  assert.deepEqual(splitSuggestion(text), { body: text, suggestion: null });
});
test('suggestion: markup stays plain text', () => {
  assert.deepEqual(splitSuggestion('Ответ\n<!-- suggest: <b>x</b> -->'),
    { body: 'Ответ', suggestion: '<b>x</b>' });
});
