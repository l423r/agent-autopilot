// Planner chat: each message is one `claude -p` that resumes the same planner session; the answer streams
// to a listener and is written to history.jsonl when the process ends, whether or not anyone still listens.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidRecord, livePid } from '../lib/pidfile.mjs';

const HISTORY_LIMIT = 500;
const KILL_GRACE_MS = 10_000;
const STDERR_TAIL = 2000;
const PROMPT_FILE = fileURLToPath(new URL('./planner-prompt.md', import.meta.url));

const INTERRUPTED = 'Ответ прерван перезапуском пульта.';

export function createChat({
  cfg, dir, claudeBin = process.env.AUTOPILOT_CLAUDE ?? 'claude',
  promptFile = PROMPT_FILE, killGraceMs = KILL_GRACE_MS, kill = process.kill.bind(process),
}) {
  mkdirSync(dir, { recursive: true });
  const historyFile = join(dir, 'history.jsonl');
  const sessionFile = join(dir, 'session.json');
  const pidFile = join(dir, 'child.pid');
  let child = null;
  let running = false;
  let stopped = false;
  let killTimer = null;

  const readSession = () => {
    try { return JSON.parse(readFileSync(sessionFile, 'utf8')).sessionId ?? null; } catch { return null; }
  };

  function history() {
    let text;
    try { text = readFileSync(historyFile, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }

  function append(role, text, fields = {}) {
    appendFileSync(historyFile, JSON.stringify({ role, text, ...fields, at: new Date().toISOString() }) + '\n');
    const entries = history();
    if (entries.length > HISTORY_LIMIT) {
      writeFileSync(historyFile, entries.slice(-HISTORY_LIMIT).map(e => JSON.stringify(e)).join('\n') + '\n');
    }
  }

  // The previous server died mid-answer: its question is the last entry and nobody will answer it.
  if (history().at(-1)?.role === 'user' && livePid(pidFile) === null) {
    rmSync(pidFile, { force: true });
    append('error', INTERRUPTED);
  }

  // `extra` goes to the planner after the text but not into history; `images` (upload ids) go into history.
  async function send(text, onEvent, { extra, images } = {}) {
    if (running) throw new Error('busy');
    running = true;
    stopped = false;
    try {
      await answer(text, onEvent, extra, images);
    } finally {
      running = false;
    }
  }

  async function answer(text, onEvent, extra, images) {
    const emit = event => { try { onEvent(event); } catch { /* listener gone; the answer is still saved */ } };
    append('user', text, images?.length ? { images } : {});

    let systemPrompt;
    try {
      systemPrompt = readFileSync(promptFile, 'utf8');
    } catch (err) {
      const error = `Не удалось запустить Claude: ${err.message}`;
      append('error', error);
      emit({ type: 'error', text: error });
      return;
    }
    const sessionId = readSession();
    const args = [
      '-p', [text, extra].filter(Boolean).join('\n\n'),
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'dontAsk',
      '--settings', join(cfg.autopilotDir, 'claude-settings.json'),
      '--append-system-prompt', systemPrompt,
    ];
    if (sessionId) args.push('--resume', sessionId);

    let reply = '';
    let result = null;
    let initSeen = false;
    let stderr = '';
    let buffered = '';
    let spawnError = null;

    const onLine = line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        initSeen = true;
        writeFileSync(sessionFile, JSON.stringify({ sessionId: msg.session_id }));
      } else if (msg.type === 'assistant') {
        // Each assistant message is a whole turn (text before and after tool calls): keep them apart.
        let delta = (msg.message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
        if (delta) {
          if (reply) delta = '\n\n' + delta;
          reply += delta;
          emit({ type: 'delta', text: delta });
        }
      } else if (msg.type === 'result') {
        result = msg;
      }
    };

    await new Promise(resolve => {
      child = spawn(claudeBin, args, {
        cwd: '/root',
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // own process group, so «Стоп» kills everything claude started
      });
      if (child.pid) writeFileSync(pidFile, pidRecord(child.pid));
      child.stdout.on('data', chunk => {
        buffered += chunk.toString();
        const lines = buffered.split('\n');
        buffered = lines.pop();
        lines.forEach(onLine);
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL); });
      child.on('error', err => { spawnError = err; resolve(); });
      child.on('close', () => { if (buffered) onLine(buffered); resolve(); });
    });

    clearTimeout(killTimer);
    killTimer = null;
    child = null;
    rmSync(pidFile, { force: true });
    let error = null;
    if (stopped && !result) {
      error = 'Остановлено кнопкой «Стоп».';
    } else if (result && !result.is_error) {
      const full = reply || String(result.result ?? '');
      append('assistant', full);
      emit({ type: 'done', text: full });
    } else if (result?.is_error) {
      error = `Ошибка Claude: ${result.result ?? 'без текста'}`;
    } else {
      error = `Claude завершился без ответа: ${spawnError?.message ?? (stderr.trim() || 'без вывода')}`;
    }
    if (error) {
      // No init means the session could not even start (bad --resume, login): begin anew next time.
      if (!initSeen && !stopped) {
        rmSync(sessionFile, { force: true });
        error += '\nСледующее сообщение начнёт новый разговор.';
      }
      append('error', error);
      emit({ type: 'error', text: error });
    }
  }

  function stop() {
    if (!child?.pid) return;
    stopped = true;
    const pid = child.pid;
    killGroup(kill, pid, 'SIGTERM');
    clearTimeout(killTimer);
    killTimer = setTimeout(() => killGroup(kill, pid, 'SIGKILL'), killGraceMs);
    killTimer.unref();
  }

  function reset() {
    if (running) throw new Error('busy');
    rmSync(historyFile, { force: true });
    rmSync(sessionFile, { force: true });
  }

  return { busy: () => running, history, send, stop, reset };
}

function killGroup(kill, pid, signal) {
  try {
    kill(-pid, signal);
  } catch {
    try { kill(pid, signal); } catch { /* already gone */ }
  }
}
