#!/bin/sh
# Stand-in for `codex` in the runner check: prints its arguments (the prompt after `--` as «prompt: …»)
# and the account env it got, then the JSONL fixture test/fixtures/codex/$FAKE_MODE.jsonl.
# FAKE_EXIT: exit code (default 0 for ok, 1 otherwise). FAKE_MODE=crash: a panic without JSON, exit 101.
flags=""
prompt=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then prompt="$2"; shift 2; else flags="$flags $1"; shift; fi
done
echo "args:$flags"
echo "prompt: $prompt"
echo "env: CODEX_HOME=${CODEX_HOME:--} CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:--}"
if [ "$FAKE_MODE" = "crash" ]; then
  echo "thread 'main' panicked at exec/src/lib.rs:1: boom" >&2
  exit 101
fi
cat "$(dirname "$0")/codex/${FAKE_MODE:-ok}.jsonl"
if [ -n "$FAKE_EXIT" ]; then exit "$FAKE_EXIT"; fi
[ "${FAKE_MODE:-ok}" = "ok" ] && exit 0
exit 1
