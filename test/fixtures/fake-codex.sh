#!/bin/sh
# Stand-in for `codex` in the runner check: prints its arguments (the prompt after `--` as «prompt: …»)
# and the account env it got, then the JSONL fixture test/fixtures/codex/$FAKE_MODE.jsonl.
# FAKE_EXIT: exit code (default 0 for ok, 1 otherwise). FAKE_MODE=crash: a panic without JSON, exit 101.
# In the daemon checks: FAKE_CODEX_MODE wins over FAKE_MODE (shared with fake-claude.sh); FAKE_ACCOUNT_LOG
# gets «<task> codex» per run; with FAKE_PLAN an ok run ticks the boxes of the task named in the prompt.
flags=""
prompt=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then prompt="$2"; shift 2; else flags="$flags $1"; shift; fi
done
mode="${FAKE_CODEX_MODE:-${FAKE_MODE:-ok}}"
task=$(printf '%s' "$prompt" | grep -o 'Task [0-9][0-9]*' | head -n 1)
echo "args:$flags"
echo "prompt: $prompt"
echo "env: CODEX_HOME=${CODEX_HOME:--} CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:--}"
[ -n "$FAKE_ACCOUNT_LOG" ] && echo "$task codex" >> "$FAKE_ACCOUNT_LOG"
if [ "$mode" = "crash" ]; then
  echo "thread 'main' panicked at exec/src/lib.rs:1: boom" >&2
  exit 101
fi
[ "$mode" = "ok" ] && [ -n "$FAKE_PLAN" ] && sed -i "/^### $task:/,/^###/ s/- \[ \]/- [x]/" "$FAKE_PLAN"
cat "$(dirname "$0")/codex/$mode.jsonl"
if [ -n "$FAKE_EXIT" ]; then exit "$FAKE_EXIT"; fi
[ "$mode" = "ok" ] && exit 0
exit 1
