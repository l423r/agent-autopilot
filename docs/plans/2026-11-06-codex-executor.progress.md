# Прогресс: codex-executor

## Task 1: вывод Codex CLI

### `codex --help`
```
Codex CLI

If no subcommand is specified, options will be forwarded to the interactive CLI.

Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]

Commands:
  agents            Open the agent command center to browse and switch sessions
  exec              Run Codex non-interactively [aliases: e]
  review            Run a code review non-interactively
  login             Manage login
  logout            Remove stored authentication credentials
  mcp               Manage external MCP servers for Codex
  plugin            Manage Codex plugins
  app-server        [experimental] Run the app server or related tooling
  remote-control    [experimental] Manage the app-server daemon with remote control enabled
  completion        Generate shell completion scripts
  update            Update Codex to the latest version
  doctor            Diagnose local Codex installation, config, auth, and runtime health
  sandbox           Run commands within a Codex-provided sandbox
  debug             Debugging tools
  apply             Apply the latest diff produced by Codex agent as a `git apply` to your local
                    working tree [aliases: a]
  resume            Resume a previous interactive session (picker by default; use --last to continue
                    the most recent)
  queue             Queue a message for an existing session
  archive           Archive a saved session by id or session name
  delete            Permanently delete a saved session by id or session name
  migrate-rollouts  Inspect or migrate legacy local sessions to paginated thread history
  migrate-nfs-db    [experimental] Migrate configured SQLite databases to DELETE mode in place
  unarchive         Unarchive a saved session by id or session name
  fork              Fork a previous interactive session (picker by default; use --last to fork the
                    most recent)
  cloud             [EXPERIMENTAL] Browse tasks from Codex Cloud and apply changes locally
  exec-server       [EXPERIMENTAL] Run the standalone exec-server service
  features          Inspect feature flags
  help              Print this message or the help of the given subcommand(s)

Arguments:
  [PROMPT]
          Optional user prompt to start the session

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.
          
          Examples: - `-c model="o3"` - `-c 'sandbox_permissions=["disk-full-read-access"]'` - `-c
          shell_environment_policy.inherit=all`

      --enable <FEATURE>
          Enable a feature (repeatable). Equivalent to `-c features.<name>=true`

      --disable <FEATURE>
          Disable a feature (repeatable). Equivalent to `-c features.<name>=false`

      --remote <ADDR>
          Connect the TUI to a remote app server endpoint.
          
          Accepted forms: `ws://host:port`, `wss://host:port`, `unix://`, or `unix://PATH`.

      --remote-auth-token-env <ENV_VAR>
          Name of the environment variable containing the bearer token to send to a remote app
          server websocket

      --strict-config
          Error out when config.toml contains fields that are not recognized by this version of
          Codex

  -i, --image <FILE>...
          Optional image(s) to attach to the initial prompt

  -m, --model <MODEL>
          Model the agent should use

      --oss
          Use open-source provider

      --local-provider <OSS_PROVIDER>
          Specify which local provider to use (lmstudio or ollama). If not specified with --oss,
          will use config default or show selection

  -p, --profile <CONFIG_PROFILE_V2>
          Layer $CODEX_HOME/<name>.config.toml on top of the base user config

  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands
          
          [possible values: read-only, workspace-write, danger-full-access]

      --approve-for-me
          Route approval requests through automatic review using the workspace-write sandbox

      --dangerously-bypass-approvals-and-sandbox
          Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY
          DANGEROUS. Intended solely for running in environments that are externally sandboxed

      --dangerously-bypass-hook-trust
          Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
          Intended only for automation that already vets hook sources

  -C, --cd <DIR>
          Tell the agent to use the specified directory as its working root

      --worktree
          Run the session in a new managed Git worktree

      --add-dir <DIR>
          Additional directories that should be writable alongside the primary workspace

  -a, --ask-for-approval <APPROVAL_POLICY>
          Configure when the model requires human approval before executing a command

          Possible values:
          - on-request: The model decides when to ask the user for approval
          - never:      Never ask for user approval Execution failures are immediately returned to
            the model

      --search
          Enable live web search. When enabled, the native Responses `web_search` tool is available
          to the model (no per‑call approval)

      --no-alt-screen
          Disable alternate screen mode
          
          Runs the TUI in inline mode, preserving terminal scrollback history.

      --no-daemon
          Run without the shared background server, even if it is already running

  -h, --help
          Print help (see a summary with '-h')

  -V, --version
          Print version
```

### `codex exec --help`
```
Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]

Commands:
  resume  Resume a previous session by id or pick the most recent with --last
  fork    Fork a previous session by id into a new session
  review  Run a code review against the current repository
  help    Print this message or the help of the given subcommand(s)

Arguments:
  [PROMPT]
          Initial instructions for the agent. If not provided as an argument (or if `-` is used),
          instructions are read from stdin. If stdin is piped and a prompt is also provided, stdin
          is appended as a `<stdin>` block

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.
          
          Examples: - `-c model="o3"` - `-c 'sandbox_permissions=["disk-full-read-access"]'` - `-c
          shell_environment_policy.inherit=all`

      --enable <FEATURE>
          Enable a feature (repeatable). Equivalent to `-c features.<name>=true`

      --disable <FEATURE>
          Disable a feature (repeatable). Equivalent to `-c features.<name>=false`

      --strict-config
          Error out when config.toml contains fields that are not recognized by this version of
          Codex

  -i, --image <FILE>...
          Optional image(s) to attach to the initial prompt

  -m, --model <MODEL>
          Model the agent should use

      --oss
          Use open-source provider

      --local-provider <OSS_PROVIDER>
          Specify which local provider to use (lmstudio or ollama). If not specified with --oss,
          will use config default or show selection

  -p, --profile <CONFIG_PROFILE_V2>
          Layer $CODEX_HOME/<name>.config.toml on top of the base user config

  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands
          
          [possible values: read-only, workspace-write, danger-full-access]

      --approve-for-me
          Route approval requests through automatic review using the workspace-write sandbox

      --dangerously-bypass-approvals-and-sandbox
          Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY
          DANGEROUS. Intended solely for running in environments that are externally sandboxed

      --dangerously-bypass-hook-trust
          Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
          Intended only for automation that already vets hook sources

  -C, --cd <DIR>
          Tell the agent to use the specified directory as its working root

      --worktree
          Run the session in a new managed Git worktree

      --add-dir <DIR>
          Additional directories that should be writable alongside the primary workspace

      --thread-source <SOURCE>
          Source classification for newly created or forked threads

      --cyber-access-program <PROGRAM>
          Request an experimental Cyber access program for this turn (OpenAI provider only). Omit to
          use server defaults. Not supported with review; fork requires a prompt
          
          [possible values: standard, daybreak_blue, daybreak_red]

      --skip-git-repo-check
          Allow running Codex outside a Git repository

      --ephemeral
          Run without persisting session files to disk

      --ignore-user-config
          Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`

      --ignore-rules
          Do not load user or project execpolicy `.rules` files

      --output-schema <FILE>
          Path to a JSON Schema file describing the model's final response shape

      --color <COLOR>
          Specifies color settings for use in the output
          
          [default: auto]
          [possible values: always, never, auto]

      --json
          Print events to stdout as JSONL

  -o, --output-last-message <FILE>
          Specifies file where the last message from the agent should be written

  -h, --help
          Print help (see a summary with '-h')

  -V, --version
          Print version
```

### `codex login --help`
```
Manage login

Usage: codex login [OPTIONS] [COMMAND]

Commands:
  status  Show login status
  help    Print this message or the help of the given subcommand(s)

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.
          
          Examples: - `-c model="o3"` - `-c 'sandbox_permissions=["disk-full-read-access"]'` - `-c
          shell_environment_policy.inherit=all`

      --with-api-key
          Read the API key from stdin (e.g. `printenv OPENAI_API_KEY | codex login --with-api-key`)

      --enable <FEATURE>
          Enable a feature (repeatable). Equivalent to `-c features.<name>=true`

      --with-access-token
          Read the access token from stdin (e.g. `printenv CODEX_ACCESS_TOKEN | codex login
          --with-access-token`)

      --disable <FEATURE>
          Disable a feature (repeatable). Equivalent to `-c features.<name>=false`

      --device-auth
          

  -h, --help
          Print help (see a summary with '-h')
```

### README пакета (модели)
```
bin
node_modules
package.json
README.md
```

### Итоги Task 1
- Установлено: codex-cli 0.167.0 (`npm i -g @openai/codex`, основной реестр сработал).
- Неинтерактивный запуск: `codex exec --json -C <projectDir> -m <model> -c model_reasoning_effort="<low|medium|high>" --dangerously-bypass-approvals-and-sandbox "<prompt>"`; `--skip-git-repo-check` опционален.
- Вход по коду устройства: `codex login --device-auth` (Task 10). Вход не выполнялся.
- Список моделей для Plus в `codex --help` и README пакета отсутствует (в пакете только package.json). Предложение для `codexModels` — сверить в Task 10/11 после входа; черновик: haiku → {model: "<быстрая>", effort: "low"}, sonnet → {"<основная>", "medium"}, opus → {"<основная>", "high"}. Идентификаторы не выдумываю.
- Формат JSONL для фикстур Task 3: по документации, «сверить в Task 11».
- 2026-11-06 12:27 Task 1: сделано — Codex CLI 0.167.0 установлен, флаги и вывод help записаны в журнал (вход не выполнялся; идентификаторы моделей сверить после входа)

### Заметки Task 2
- RED: `node --test test/accounts.test.mjs` → SyntaxError: нет экспорта `pickExecutor`; docs.test — deepEqual без `kind`/`codexHome`. GREEN: `npm test` → 405/405.
- Решение: `listAccounts` по интерфейсу плана теперь отдаёт `kind` и `codexHome`, поэтому ожидания в `test/accounts.test.mjs` и `test/docs.test.mjs` дополнены этими полями (поведение прежнее; эквивалентность `pickExecutor` без `executor` и `pickAccount` проверена тестом). Неизвестный `kind` — ошибка конфига.
- Решение: `switched` считается внутри кандидатов; `state.account` вне их (planner-задача после codex) = первый кандидат, т.е. без ложного переключения. Для Task 5: если planner-прогон на Claude перезапишет `state.account`, следующая обычная задача на Codex даст `switched: 'back'` — демону стоит не считать это возвратом из лимита (или не перезаписывать `account` planner-прогоном).
- Для Task 5: «без роста счётчика попыток» и «один sleeping до ближайшего сброса» — в `lib/decide.mjs` (`moveAccount`/`applyResult`), в Task 2 покрыт только выбор (`pickExecutor` → null, `earliestReset` — ближайший сброс среди всех, включая codex). `decide.mjs` пока вызывает `pickAccount` и не знает о codex.
- 2026-11-06 12:32 Task 2: сделано — listAccounts с kind/codexHome, accountEnv с CODEX_HOME, pickExecutor (planner → только Claude, обычная → Codex, затем Claude по приоритету, всё в лимите → null); npm test 405/405

### Заметки Task 3
- Формат JSONL: `auth.jsonl` — с реального прогона `codex exec --json` без входа (временный CODEX_HOME): `thread.started`, `turn.started`, `error` «Reconnecting… 401 Unauthorized», итог `turn.failed` {error.message}, exit 1. Остальные фикстуры (`turn.completed` с usage, тексты лимита «You've hit your usage limit… try again at Oct 22nd, 2026 9:00 AM», событие с `rate_limits` {primary/secondary: used_percent, window_minutes, resets_at (epoch с)}) — по строкам бинарника 0.167.0 и документации; **сверить в Task 11** (особенно: приходит ли `rate_limits` в exec-JSONL и под каким type).
- `--` перед промптом проверен на реальном codex: промпт, начинающийся с «-», не принимается за флаг.
- Интерфейсы для Task 5: `runIteration({ …, executor: 'codex', codexBin, model: '<haiku|sonnet|opus>' })` — модель/effort берёт сам из `cfg.codexModels` (`codexModelFor`; нет записи → без `-m`); `classify(raw, now, cfg, 'codex')` → ok | limit{resetAt?} | auth | error{detail} | timeout, `detail` — сообщение `turn.failed` или хвост вывода (≤500 символов) для строки лога; `usageOf(output, 'codex')` → токены из `turn.completed`, costUsd null. `validateModelConfig` проверяет `codexModels`.
- Решение: правила auth/limit для Codex — константы в `lib/classify.mjs` (не `cfg.*Patterns`, те про Claude). Ищутся только в тексте сбоя (turn.failed / последнее error / сырой вывод без JSON), не в ответе агента. Цена ошибки: новый текст ошибки Codex попадёт в error вместо limit/auth — дописать паттерн.
- Решение: runner убирает у codex-процесса CLAUDE_CONFIG_DIR, у claude-процесса — CODEX_HOME, даже если они есть у демона. В fake-claude.mjs добавлен режим `env`.
- RED: 11 падений (нет `codexModelFor`, нет ветки codex). GREEN: `npm test` → 423/423.
- 2026-11-06 12:39 Task 3: сделано — runner запускает `codex exec --json -C <проект> --dangerously-bypass-approvals-and-sandbox [-m/-c effort из codexModels] -- <промпт>` с CODEX_HOME только у codex, classify/usageOf разбирают JSONL Codex (ok/limit с rate_limits или «try again at»/auth/error с хвостом), фикстуры + fake-codex.sh; npm test 423/423

### Заметки Task 4
- RED: `test/cli.test.mjs` → Cannot find module `lib/prompt.mjs`. GREEN: `npm test` → 424/424.
- Решение: `promptTemplate(task, executor)` вынесена из `autopilot.mjs` в `lib/prompt.mjs` (autopilot.mjs исполняет CLI при импорте, тестировать там нельзя); `autopilot.mjs` импортирует её, вызов `promptTemplate(d.task)` пока без executor (Claude) — **Task 5** должен передать вид исполнителя.
- 2026-11-06 12:50 Task 4: сделано — prompt-codex.md (TDD, проверки, ревью свежим ревьюером, отметки/журнал/коммит, без push, без навыков), promptTemplate(task, executor) в lib/prompt.mjs; npm test 424/424
- 2026-11-06 12:50 CET Task 10: сделано планировщиком — вход `codex login --device-auth` (ChatGPT, «Logged in using ChatGPT»), `~/.codex/auth.json` есть. Smoke: `codex exec --skip-git-repo-check --json "…" < /dev/null` → agent_message «ок», exit 0. ВАЖНО: без закрытого stdin `codex exec` висит («Reading additional input from stdin…») — запускать со stdin=ignore. Лимиты: в `~/.codex/sessions/**/*.jsonl` событие с `"rate_limits":{"limit_id":"codex","primary":{"used_percent","window_minutes":300,"resets_at":<unix>},"secondary":{…,"window_minutes":10080,…}}` — сверить фикстуры Task 3/6 с этим форматом.

### Заметки Task 5
- RED (на коде HEAD): decide.test — нет экспорта `preRun`; runs.test — summarizeRuns без executor/model; cli.test — 4 сквозных codex-теста падают. GREEN: `npm test` → 436/436.
- Решение: `state.taskAccount` — учётка последней обычной задачи в режиме codex; planner-прогон на Claude её не трогает, поэтому следующая обычная задача на Codex не считается «возвратом» (gotcha из Task 2). Без `executor` поле не пишется, state.json прежний.
- Решение: `auth` останавливает автопилот только на первой claude-учётке; codex без входа помечается в `accountAuth`, задачу продолжает Claude (уведомление «Codex не авторизован…»).
- Решение: строка лога результата дополнена `detail` (хвост ≤200 символов) — сбой Codex без JSON виден в логе.
- 2026-11-06 14:14 Task 5: сделано — демон выбирает исполнителя на задачу (обычная → codex, [planner] → claude, лимит/нет входа Codex → та же задача на Claude без роста попыток, одно уведомление, возврат на Codex между задачами), prompt/classify/usage по исполнителю, лог и runs.jsonl/stats с executor; npm test 436/436

### Заметки Task 6
- RED: web-limits.test — нет экспорта `fetchCodexLimits`; cli.test — в `status` нет строки «Исполнитель». GREEN: `npm test` → 441/441.
- Решение: `fetchCodexLimits({codexHome})` (синхронная) читает до 20 самых свежих `sessions/**/*.jsonl`, берёт последнее событие `rate_limits` (`payload.rate_limits`, также `rate_limits`/`msg.rate_limits`), `resets_at` (unix с) → ISO; нет каталога/событий → `{ error: 'Нет данных о лимитах Codex' }`. `/api/limits` для `kind: codex` не ходит в сеть; строка получает `executor: true`, если `cfg.executor === 'codex'`. Заголовок вкладки «Лимиты Claude» → «Лимиты». Снимок 390 px проверен вручную (временный экземпляр).
- 2026-11-06 14:40 Task 6: сделано — лимиты Codex из логов сессий в пульте (строка «исполнитель») и в `status` («Исполнитель: codex (5 ч: N %, неделя: M %)»), без данных — понятное сообщение; npm test 441/441
