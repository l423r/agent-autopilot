// Safe Markdown → HTML for planner replies and plans. No dependencies: the same
// file runs in Node (tests, server) and in the browser (served as a module).
// Every piece of source text is HTML-escaped before any markup is added.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = s => s.replace(/[&<>"']/g, c => ESC[c]);

// Placeholder marker; stripped from the input so it can't be forged.
const MARK = '\u0000';

function inline(raw) {
  const held = [];
  const hold = html => `${MARK}${held.push(html) - 1}${MARK}`;
  let s = escapeHtml(raw.replaceAll(MARK, ''));
  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`));
  // Only http(s) links; the text part excludes '[' so scanning stays linear.
  s = s.replace(/\[([^\[\]\n]*)\]\((https?:\/\/[^\s()]+)\)/g,
    (_, t, url) => hold(`<a href="${url}" target="_blank" rel="noopener">${t}</a>`));
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  return s.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i) => held[i]);
}

function listItem(text) {
  const m = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (!m) return `<li>${inline(text)}</li>`;
  return m[1] === ' '
    ? `<li class="task"><input type="checkbox" disabled> ${inline(m[2])}</li>`
    : `<li class="task done"><input type="checkbox" checked disabled> ${inline(m[2])}</li>`;
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag: 'ul'|'ol', items: [] }

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`);
    list = null;
  };
  const flush = () => { flushPara(); flushList(); };
  const addItem = (tag, text) => {
    flushPara();
    if (list && list.tag !== tag) flushList();
    if (!list) list = { tag, items: [] };
    list.items.push(listItem(text));
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^\s*```/.test(line)) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    } else if ((m = /^#{1,6}\s+(.*)$/.exec(line))) {
      flush();
      out.push(`<h3>${inline(m[1])}</h3>`);
    } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      addItem('ul', m[1]);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      addItem('ol', m[1]);
    } else if (!line.trim()) {
      flush();
    } else {
      flushList();
      para.push(line);
    }
  }
  flush();
  return out.join('');
}
