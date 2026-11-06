// Which account runs the next task. A claude account is a Claude Code config dir (CLAUDE_CONFIG_DIR), a codex
// account a Codex CLI home (CODEX_HOME); cfg.accounts order is priority, the first is the primary. state.accountLimits maps a name to the ISO time its
// limit resets; state.accountAuth lists names marked as not logged in until resume.
const PRIMARY = 'основная';
const KINDS = ['claude', 'codex'];

// Claude is the head ([planner] tasks, fallback for codex), so a list without a claude account gets the
// primary one in front.
export function listAccounts(cfg) {
  const primary = { name: PRIMARY, kind: 'claude', configDir: null, codexHome: null };
  if (!cfg.accounts?.length) return [primary];
  const seen = new Set();
  const accounts = cfg.accounts.map((a) => {
    if (typeof a.name !== 'string' || !a.name.trim()) throw new Error('accounts: у учётки нет имени');
    if (seen.has(a.name)) throw new Error(`accounts: имя «${a.name}» повторяется`);
    seen.add(a.name);
    const kind = a.kind ?? 'claude';
    if (!KINDS.includes(kind)) throw new Error(`accounts: у «${a.name}» неизвестный kind «${kind}»`);
    return { name: a.name, kind, configDir: a.configDir ?? null, codexHome: a.codexHome ?? null };
  });
  if (accounts.some((a) => a.kind === 'claude')) return accounts;
  if (seen.has(PRIMARY)) throw new Error(`accounts: нет учётки Claude, а имя «${PRIMARY}» занято учёткой codex`);
  return [primary, ...accounts];
}

// Env additions for the account's own process only; an account without its dir runs as before.
export function accountEnv(account) {
  if (account.kind === 'codex') return account.codexHome ? { CODEX_HOME: account.codexHome } : {};
  return account.configDir ? { CLAUDE_CONFIG_DIR: account.configDir } : {};
}

function limited(state, name, now) {
  const until = state.accountLimits?.[name];
  return until !== undefined && new Date(until) > now;
}

// First account neither limited nor marked auth, or null when all are out. switched compares it with
// state.account (missing or unknown = the primary): 'fallback' to a lower priority, 'back' to a higher one.
export function pickAccount(accounts, state, now) {
  const free = accounts.findIndex((a) => !limited(state, a.name, now) && !state.accountAuth?.includes(a.name));
  if (free === -1) return null;
  const current = Math.max(accounts.findIndex((a) => a.name === state.account), 0);
  const switched = free > current ? 'fallback' : free < current ? 'back' : null;
  return { name: accounts[free].name, switched };
}

// Who runs this task. With cfg.executor 'codex' an ordinary task goes to the codex accounts first, then to
// the claude ones by priority; a [planner] task, or no executor, only to the claude ones. The pick is made
// before every task, so the return to codex after its reset happens between tasks. switched is measured
// within those candidates: state.account outside them (a [planner] task after codex) counts as the first.
export function pickExecutor(accounts, state, task, cfg, now) {
  const claude = accounts.filter((a) => a.kind !== 'codex');
  const codex = accounts.filter((a) => a.kind === 'codex');
  const candidates = cfg.executor === 'codex' && task.kind !== 'planner' ? [...codex, ...claude] : claude;
  const pick = pickAccount(candidates, state, now);
  if (!pick) return null;
  const { kind } = candidates.find((a) => a.name === pick.name);
  return { name: pick.name, kind, switched: pick.switched };
}

export function earliestReset(state) {
  const times = Object.values(state.accountLimits ?? {}).map((t) => new Date(t));
  if (!times.length) return null;
  return new Date(Math.min(...times));
}
