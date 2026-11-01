#!/bin/sh
# Stand-in for `claude` in the task-models check: prints its flags (without the prompt),
# ticks the boxes of the task named in the prompt in $FAKE_PLAN and prints a JSON result with usage.
# FAKE_PROMPT_OUT: also saves the prompt there. FAKE_MODE=need-human: instead of ticking, appends
# a «НУЖЕН ЧЕЛОВЕК» line to $FAKE_PROGRESS.
prompt=""
flags=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-p" ]; then prompt="$2"; shift 2; else flags="$flags $1"; shift; fi
done
task=$(printf '%s' "$prompt" | grep -o 'Task [0-9][0-9]*' | head -n 1)
echo "task: $task"
[ -n "$FAKE_PROMPT_OUT" ] && printf '%s' "$prompt" > "$FAKE_PROMPT_OUT"
if [ "$FAKE_MODE" = "need-human" ]; then
  # A [planner] run that cannot finish: a line in the project log, no ticks.
  echo "- 2026-11-01 12:00 $task: НЕ СДЕЛАНО — НУЖЕН ЧЕЛОВЕК: нет доступа к серверу" >> "$FAKE_PROGRESS"
  echo '{"type":"result","is_error":false,"result":"need human"}'
  exit 0
fi
echo "args:$flags"
sed -i "/^### $task:/,/^###/ s/- \[ \]/- [x]/" "$FAKE_PLAN"
echo '{"type":"result","is_error":false,"result":"ticked","total_cost_usd":0.42,"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40}}'
