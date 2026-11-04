// Which Claude account runs the next claude process. An account is a Claude Code config dir (CLAUDE_CONFIG_DIR);
// cfg.accounts order is priority, the first is the primary. state.accountLimits maps a name to the ISO time its
// limit resets; state.accountAuth lists names marked as not logged in until resume.
const PRIMARY = 'основная';

export function listAccounts(cfg) {
  if (!cfg.accounts?.length) return [{ name: PRIMARY, configDir: null }];
  const seen = new Set();
  return cfg.accounts.map((a) => {
    if (typeof a.name !== 'string' || !a.name.trim()) throw new Error('accounts: у учётки нет имени');
    if (seen.has(a.name)) throw new Error(`accounts: имя «${a.name}» повторяется`);
    seen.add(a.name);
    return { name: a.name, configDir: a.configDir ?? null };
  });
}

// Env additions for the claude process only; an account without configDir runs as before.
export function accountEnv(account) {
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

export function earliestReset(state) {
  const times = Object.values(state.accountLimits ?? {}).map((t) => new Date(t));
  if (!times.length) return null;
  return new Date(Math.min(...times));
}
