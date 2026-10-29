#!/bin/sh
# Stand-in for `claude` in the task-models check: prints its flags (without the prompt),
# ticks the boxes of the task named in the prompt in $FAKE_PLAN and prints a JSON result with usage.
prompt=""
flags=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-p" ]; then prompt="$2"; shift 2; else flags="$flags $1"; shift; fi
done
task=$(printf '%s' "$prompt" | grep -o 'Task [0-9][0-9]*' | head -n 1)
echo "task: $task"
echo "args:$flags"
sed -i "/^### $task:/,/^###/ s/- \[ \]/- [x]/" "$FAKE_PLAN"
echo '{"type":"result","is_error":false,"result":"ticked","total_cost_usd":0.42,"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40}}'
