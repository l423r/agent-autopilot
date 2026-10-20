// Pid files that survive a reboot must not be trusted blindly: a recorded pid is only "ours"
// if it was written in this boot and the process with that pid started at the recorded time.
import { readFileSync } from 'node:fs';

function bootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

function startTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // fields after the ")" of the command name; starttime is field 22 overall
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

export function pidRecord(pid) {
  return `${pid} ${bootId()} ${startTime(pid) ?? 'unknown'}`;
}

// Returns the pid if the record still describes a live process from this boot, else null.
export function livePid(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
  const [pidStr, boot, start] = text.split(/\s+/);
  const pid = Number(pidStr);
  if (!(pid > 0) || boot !== bootId()) return null;
  const now = startTime(pid);
  if (now === null || (start !== 'unknown' && now !== start)) return null;
  return pid;
}
