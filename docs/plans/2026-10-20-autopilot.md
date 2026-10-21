# Автопилот разработки — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Служба, которая по файлу плана с галочками запускает Claude Code на каждую следующую задачу, переживает исчерпание лимитов, перезагрузки и падения, и останавливается по готовности или при зацикливании.

**Architecture:** Node-скрипт без зависимостей — отдельный репозиторий `agent-autopilot` (https://github.com/l423r/agent-autopilot, локально `/root/agent-autopilot`); разрабатываемый проект (`/root/sigaret-counter`) задаётся в конфиге. Чистые модули (разбор плана, классификация результата запуска, решение «что делать дальше») покрыты `node:test`; тонкий слой ввода-вывода запускает `claude -p` с тайм-аутом и пишет логи; демон крутит цикл «решить → выполнить → поспать». systemd держит демон живым.

**Tech Stack:** Node 20 (ESM, `node:test`, `node:child_process`), systemd, Claude Code 2.1.304 (`claude -p`).

**Spec:** `/root/sigaret-counter/docs/superpowers/specs/2026-10-20-sigaret-counter-design.md` (часть B)

## Global Constraints

- Запуск от root, полные права (решение заказчика). Проверено: `--dangerously-skip-permissions` под root отказывает («cannot be used with root/sudo privileges»). Поэтому итерации идут с `--permission-mode dontAsk --settings <папка автопилота>/claude-settings.json`, где разрешены все нужные инструменты.
- Каждая итерация — свежий `claude -p` без продолжения переписки; источник правды — план с галочками + файл прогресса.
- По умолчанию без пауз; `pauseAfterPhase: true` включает паузу после этапа.
- Неудача одной задачи 3 раза подряд → остановка (`maxAttempts`, по умолчанию 3).
- Повтор, если время сброса лимита неизвестно, — через 15 минут (`retryMinutes`).
- Тайм-аут итерации — 60 минут (`iterationTimeoutMinutes`).
- Ошибка авторизации ≠ лимит: остановка со статусом `auth`.
- Проверяется только собственный дочерний процесс демона; интерактивные сессии заказчика не учитываются.
- Никаких npm-зависимостей у автопилота.
- Автор коммитов git — `L423R`.

## Review Focus

1. **Сообщение о лимите в незнакомом формате** — ожидается: не падение и не горячий цикл, а повтор через `retryMinutes`. Тест в Task 2 (`unknown limit text → limit без resetAt`).
2. **Время сброса уже в прошлом или через > 8 дней** (кривой разбор) — ожидается: не спать «в прошлое» в цикле и не уснуть на месяц; ограничить окном `[now+1 мин, now+8 дней]`, иначе `retryMinutes`. Тест в Task 2.
3. **Демон перезапущен systemd посреди итерации** (осиротевший `claude`) — ожидается: старый дочерний процесс убит по pid-файлу до нового запуска, а не две итерации параллельно. Тест в Task 4.
4. **Вторая копия демона** (ручной запуск при работающей службе) — ожидается: вторая сразу выходит с сообщением, не трогая состояние. Тест в Task 5.
5. **План изменён вручную во время работы** (добавлены задачи, сняты галочки) — ожидается: план перечитывается каждую итерацию, счётчик попыток привязан к id задачи, статус `done` снимается, если появились новые невыполненные задачи и запущен `resume`. Тест в Task 3.

---

## Структура файлов

```
/root/agent-autopilot/
  package.json            # "type":"module", scripts.test = "node --test"
  config.example.json     # пример настроек (в git)
  config.json             # реальные настройки (в .gitignore; путь можно задать AUTOPILOT_CONFIG)
  claude-settings.json    # разрешения для claude -p
  prompt.md               # шаблон промпта итерации
  autopilot.mjs           # CLI: run | once | status | resume
  lib/plan.mjs            # разбор плана
  lib/classify.mjs        # ok | limit | auth | error + время сброса
  lib/decide.mjs          # чистая функция «что делать дальше»
  lib/state.mjs           # state.json + pid/lock файлы
  lib/runner.mjs          # запуск claude -p с тайм-аутом и логом
  systemd/sigaret-autopilot.service
  install.sh
  README.md
  test/*.test.mjs
  test/fixtures/          # примеры планов и выводов claude, fake-claude.mjs
  state/  logs/           # в .gitignore
  .gitignore
```

---

### Task 1: Разбор плана

**Files:**
- Create: `package.json`, `lib/plan.mjs`, `test/plan.test.mjs`, `test/fixtures/plan-sample.md`
- Create: `.gitignore` (`node_modules/`, `state/`, `logs/`, `config.json`)

**Interfaces:**
- Produces:
  - `parsePlan(markdown: string) → { tasks: Task[] }`
  - `type Task = { id: string, title: string, phase: string|null, manual: boolean, done: boolean, lastInPhase: boolean }`
  - `nextTask(plan) → Task|null` — первая задача с `done === false`
  - `allDone(plan) → boolean`

Правила разбора: задача — заголовок `### Task <N>: <title>`; `id` = `"Task <N>"`. Этап — ближайший выше заголовок `## Этап <...>` (иначе `null`). `manual` — в заголовке задачи есть `[manual]`. `done` — у задачи есть хотя бы один чекбокс и все её `- [ ]`/`- [x]` отмечены. Задача без чекбоксов — `done: true`. `lastInPhase` — следующая задача в другом этапе или её нет.

- [x] **Step 1: Фикстура и падающие тесты**

`fixtures/plan-sample.md`: два этапа; «Этап 1» — Task 1 (все `[x]`), Task 2 (один `[ ]`); «Этап 2» — `### Task 3: EAS [manual]` (`[ ]`), Task 4 (`[ ]`).

```js
test('parses tasks with phases', () => {
  const p = parsePlan(sample);
  assert.deepEqual(p.tasks.map(t => t.id), ['Task 1','Task 2','Task 3','Task 4']);
  assert.equal(p.tasks[0].done, true);
  assert.equal(p.tasks[1].done, false);
  assert.equal(p.tasks[1].lastInPhase, true);
  assert.equal(p.tasks[2].manual, true);
  assert.equal(p.tasks[2].phase, 'Этап 2');
});
test('nextTask returns first unfinished', () => assert.equal(nextTask(parsePlan(sample)).id, 'Task 2'));
test('allDone true when every box checked', () => assert.equal(allDone(parsePlan('### Task 1: a\n- [x] s')), true));
test('checkboxes in fenced code blocks are ignored', () => {
  const p = parsePlan('### Task 1: a\n- [x] s\n```md\n- [ ] not a step\n```');
  assert.equal(p.tasks[0].done, true);
});
```

- [x] **Step 2: `node --test` → FAIL (модуль не найден)**
- [x] **Step 3: Реализовать `lib/plan.mjs`** (построчный разбор, флаг «внутри ```»)
- [x] **Step 4: `node --test` → PASS**
- [x] **Step 5: Commit** — `git commit -m "feat(autopilot): plan parser"`

---

### Task 2: Классификация результата запуска

**Files:**
- Create: `lib/classify.mjs`, `test/classify.test.mjs`, `config.example.json` (+ скопировать в `config.json`)

**Interfaces:**
- Produces:
  - `classify({ exitCode: number|null, output: string, timedOut: boolean }, now: Date, cfg) → { kind: 'ok'|'limit'|'auth'|'error'|'timeout', resetAt?: Date }`
  - `parseResetTime(text: string, now: Date) → Date|null`

`config.example.json` (значения из спеки; пути — абсолютные):
```json
{
  "projectDir": "/root/sigaret-counter",
  "planPath": "docs/superpowers/plans/2026-10-20-sigaret-counter-app.md",
  "autopilotDir": "/root/agent-autopilot",
  "progressPath": "docs/superpowers/progress.md",
  "retryMinutes": 15,
  "maxAttempts": 3,
  "iterationTimeoutMinutes": 60,
  "pauseAfterPhase": false,
  "limitPatterns": ["usage limit", "limit reached", "rate limit", "out of extra usage", "resets? (at )?\\d"],
  "authPatterns": ["/login", "not logged in", "invalid api key", "oauth token (has )?expired", "authentication"]
}
```

Порядок: `timedOut` → `timeout`; совпадение `authPatterns` (без учёта регистра) → `auth`; `limitPatterns` → `limit` + `resetAt` из `parseResetTime` (если вне окна `[now+1 мин, now+8 дней]` — без `resetAt`); `exitCode === 0` → `ok`; иначе `error`.

`parseResetTime` понимает: (а) `...|<unix секунды>` (старый формат «Claude AI usage limit reached|1760000000»); (б) «resets 3pm», «resets at 15:00», «resets 3:30am (Europe/Moscow)» — ближайшее будущее такое время; часовой пояс в скобках учитывается через `Intl`, без него — локальное время сервера; (в) «resets Oct 22, 9am» / «resets Oct 22 at 09:00» — дата+время. Точный формат на 2.1.304 не проверен — поэтому шаблоны в конфиге и терпимый разбор.

- [x] **Step 1: Падающие тесты** (`now = new Date('2026-10-20T12:00:00Z')`, `TZ=UTC` в скрипте теста)

```js
test('epoch format', () => assert.equal(parseResetTime('Claude AI usage limit reached|1792512000', now).getTime(), 1792512000*1000));
test('pm today', () => assert.equal(parseResetTime('5-hour limit reached ∙ resets 3pm', now).toISOString(), '2026-10-20T15:00:00.000Z'));
test('time already passed today → tomorrow', () => assert.equal(parseResetTime('resets at 09:00', now).toISOString(), '2026-10-21T09:00:00.000Z'));
test('zone in parens', () => assert.equal(parseResetTime('resets 6pm (Europe/Moscow)', now).toISOString(), '2026-10-20T15:00:00.000Z'));
test('date + time', () => assert.equal(parseResetTime('Weekly limit reached ∙ resets Oct 22, 9am', now).toISOString(), '2026-10-22T09:00:00.000Z'));
test('garbage → null', () => assert.equal(parseResetTime('hello', now), null));
test('unknown limit text → limit без resetAt', () => assert.deepEqual(classify({exitCode:1, output:'Usage limit reached. Try later.', timedOut:false}, now, cfg), {kind:'limit'}));
test('resetAt in the past is dropped', () => assert.equal(classify({exitCode:1, output:'usage limit reached|1700000000', timedOut:false}, now, cfg).resetAt, undefined));
test('auth wins over limit', () => assert.equal(classify({exitCode:1, output:'OAuth token has expired. Please run /login', timedOut:false}, now, cfg).kind, 'auth'));
test('timeout', () => assert.equal(classify({exitCode:null, output:'', timedOut:true}, now, cfg).kind, 'timeout'));
test('ok', () => assert.equal(classify({exitCode:0, output:'{"result":"done"}', timedOut:false}, now, cfg).kind, 'ok'));
```

- [x] **Step 2: `TZ=UTC node --test` → FAIL**
- [x] **Step 3: Реализовать `lib/classify.mjs`**; в `package.json` `"test": "TZ=UTC node --test"`
- [x] **Step 4: `npm test` → PASS**
- [x] **Step 5: Commit** — `git commit -m "feat(autopilot): classify claude results and parse reset time"`

---

### Task 3: Решение «что делать дальше» и состояние

**Files:**
- Create: `lib/decide.mjs`, `lib/state.mjs`, `test/decide.test.mjs`, `test/state.test.mjs`

**Interfaces:**
- Consumes: `parsePlan`, `nextTask`, `allDone` (Task 1); результат `classify` (Task 2)
- Produces:
  - `type State = { status: 'idle'|'running'|'sleeping'|'paused'|'waiting-user'|'done'|'halted'|'auth', currentTask: string|null, attempts: Record<string, number>, nextAttemptAt: string|null, reason: string|null, updatedAt: string }`
  - `decide(state: State, plan, now: Date, cfg) → { action: 'run', task: Task } | { action: 'sleep', until: Date } | { action: 'stop', status: State['status'], reason: string }`
  - `applyResult(state, task, result /* classify */, planAfter, now, cfg) → State`
  - `resume(state) → State` — `paused|waiting-user|halted|auth|done` → `idle`, `attempts` и `reason` очищены
  - `loadState(dir) → State` (нет файла → `idle`), `saveState(dir, state)` — атомарно (tmp + rename)

Правила `decide`:
- `status` ∈ `paused|waiting-user|halted|auth|done` → `stop` с этим статусом (демон ждёт `resume`).
- `status === 'sleeping'` и `now < nextAttemptAt` → `sleep` до `nextAttemptAt`.
- `allDone(plan)` → `stop` `done`.
- `nextTask` с `manual` → `stop` `waiting-user`, reason `"Ручная задача: <title>"`.
- `attempts[task.id] >= maxAttempts` → `stop` `halted`, reason `"<id> не удалась <n> раз подряд"`.
- иначе `run`.

Правила `applyResult`:
- задача отмечена выполненной в `planAfter` → `attempts[id]` удаляется; если `pauseAfterPhase && task.lastInPhase` → `paused`, иначе `idle`. (Выполнение определяется по плану, а не по `kind` — даже если `ok`, но галочки не стоят, это неудача.)
- `limit` → `sleeping`, `nextAttemptAt = resetAt ?? now + retryMinutes`; попытка **не** засчитывается.
- `auth` → `auth`, reason из вывода.
- `ok|error|timeout` без галочек → `attempts[id] += 1`, `idle`.

- [x] **Step 1: Падающие тесты**

```js
test('limit sleeps until resetAt and does not count attempt', ...)  // status 'sleeping', nextAttemptAt === resetAt, attempts['Task 2'] undefined
test('limit without resetAt sleeps retryMinutes', ...)              // nextAttemptAt === now + 15 мин
test('third failure halts', ...)                                    // attempts 2 → error → 3; decide → stop 'halted'
test('done task resets attempts', ...)                              // attempts {'Task 2':2}, planAfter Task 2 done → attempts {}
test('manual task stops with waiting-user', ...)
test('pauseAfterPhase pauses after last task of phase', ...)        // cfg.pauseAfterPhase=true
test('all done → stop done', ...)
test('resume after done re-runs when plan gained new task', ...)    // resume(done) → idle; decide с новым планом → run 'Task 5'
test('state roundtrip and missing file → idle', ...)
```

- [x] **Step 2: `npm test` → FAIL**
- [x] **Step 3: Реализовать `lib/decide.mjs`, `lib/state.mjs`**
- [x] **Step 4: `npm test` → PASS**
- [x] **Step 5: Commit** — `git commit -m "feat(autopilot): decision logic and state store"`

---

### Task 4: Запуск итерации

**Files:**
- Create: `lib/runner.mjs`, `prompt.md`, `claude-settings.json`, `test/runner.test.mjs`, `test/fixtures/fake-claude.mjs`

**Interfaces:**
- Consumes: `Task` (Task 1), `cfg`
- Produces:
  - `buildPrompt(template: string, task: Task, cfg) → string` — подставляет `{{taskId}}`, `{{taskTitle}}`, `{{planPath}}`, `{{progressPath}}`
  - `runIteration({ task, cfg, stateDir, logDir, claudeBin = 'claude', timeoutMs }) → Promise<{ exitCode: number|null, output: string, timedOut: boolean }>`
  - `killOrphan(stateDir) → void` — читает `child.pid`, если процесс жив — SIGTERM, через 10 с SIGKILL; удаляет файл

`runIteration`: `spawn(claudeBin, ['-p', prompt, '--permission-mode', 'dontAsk', '--settings', path.join(cfg.autopilotDir, 'claude-settings.json'), '--output-format', 'json'], { cwd: cfg.projectDir, stdin: 'ignore', detached: true })`; пишет `child.pid`; stdout+stderr → `logs/iter-<ISO>-<taskId>.log` и в `output` (последние 64 КБ); по тайм-ауту убивает группу процессов (`process.kill(-pid)`); удаляет `child.pid` по завершении.

`prompt.md` (смысл, текст — на усмотрение): «Ты работаешь автономно, человека рядом нет. Прочитай `{{planPath}}`, спеку из его заголовка и `{{progressPath}}`. Выполни только `{{taskId}}: {{taskTitle}}` строго по шагам (REQUIRED SUB-SKILL: superpowers:executing-plans), TDD, прогоняй тесты. По завершении: отметь все чекбоксы задачи `[x]`, допиши в прогресс строку `- <дата> {{taskId}}: сделано — <кратко>`, сделай коммит. Если задачу выполнить нельзя — не ставь галочки, допиши в прогресс `- <дата> {{taskId}}: НЕ СДЕЛАНО — <причина>` и заверши работу. Не начинай другие задачи.»

`claude-settings.json`: `{"permissions": {"allow": ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "Skill", "Agent", "TodoWrite"]}}` — полный набор по решению заказчика; точные имена инструментов сверить с `claude --help`/документацией 2.1.304.

`fake-claude.mjs`: читает переменную `FAKE_MODE` (`ok` | `limit` | `hang`), печатает соответствующий вывод/висит.

- [x] **Step 1: Падающие тесты**

```js
test('buildPrompt substitutes placeholders', ...)  // содержит 'Task 2' и путь плана
test('captures output and exit code', ...)         // FAKE_MODE=ok → exitCode 0, output содержит '"result"'; лог-файл создан; child.pid удалён
test('timeout kills process', ...)                 // FAKE_MODE=hang, timeoutMs 500 → timedOut true, процесс мёртв
test('killOrphan kills leftover child', ...)       // запустить fake hang вручную, записать его pid в child.pid → killOrphan → процесс мёртв, файла нет
```

- [x] **Step 2: `npm test` → FAIL**
- [x] **Step 3: Реализовать `lib/runner.mjs`, `prompt.md`, `claude-settings.json`, `fake-claude.mjs`**
- [x] **Step 4: `npm test` → PASS**
- [x] **Step 5: Commit** — `git commit -m "feat(autopilot): iteration runner"`

---

### Task 5: Демон и CLI

**Files:**
- Create: `autopilot.mjs`, `test/cli.test.mjs`

**Interfaces:**
- Consumes: всё выше
- Produces CLI (`node /root/agent-autopilot/autopilot.mjs <cmd>`):
  - `run` — цикл: lock → `killOrphan` → `loop { plan = parsePlan(read); d = decide(...); run → runIteration → classify → applyResult(planAfter перечитан) → save; sleep → ждать до until (просыпаясь не реже раза в 60 с, чтобы ловить `resume`); stop → save, вывести причину, exit 0 }`
  - `once` — один шаг цикла, выход
  - `status` — печатает `status`, `currentTask`, `nextAttemptAt`, `reason`, прогресс `x/N задач`, последнюю строку `APK:` из файла прогресса
  - `resume` — `resume(state)`, сохранить; если служба установлена — `systemctl start agent-autopilot`
- Переменные окружения для тестов: `AUTOPILOT_CONFIG` (путь к конфигу), `AUTOPILOT_CLAUDE` (бинарник вместо `claude`)

Lock: `state/daemon.lock` с pid; если pid жив — вывести «Автопилот уже работает (pid N)» и exit 0; мёртвый — перехватить.
Сводный журнал: `logs/autopilot.log`, одна строка на событие (`<ISO> run Task 3`, `<ISO> limit → sleep until ...`, `<ISO> halted: ...`).

- [x] **Step 1: Падающие тесты** (временная папка: копия `plan-sample.md` с Task 3 без `[manual]`, конфиг с путями туда, `AUTOPILOT_CLAUDE=fake-claude.mjs`)

```js
test('once with FAKE_MODE=limit → status sleeping', ...)
test('run stops with halted after 3 failures', ...)   // fake ok, но галочки не ставит → после 3 итераций exit 0, status 'halted'
test('run completes when fake ticks boxes', ...)      // FAKE_MODE=tick: fake отмечает чекбоксы следующей задачи → status 'done'
test('second daemon exits immediately', ...)          // lock с живым pid → вывод 'уже работает', state не изменён
test('status prints APK line', ...)                   // progress содержит 'APK: https://expo.dev/x' → вывод содержит эту ссылку
```

(добавить `FAKE_MODE=tick` в `fake-claude.mjs`)

- [x] **Step 2: `npm test` → FAIL**
- [x] **Step 3: Реализовать `autopilot.mjs`** (конфиг: `AUTOPILOT_CONFIG` или `<папка скрипта>/config.json`)
- [x] **Step 4: `npm test` → PASS**
- [x] **Step 5: Commit** — `git commit -m "feat(autopilot): daemon loop and CLI"`

---

### Task 6: Служба systemd и боевая проверка

**Files:**
- Create: `systemd/agent-autopilot.service`, `install.sh`, `README.md`; в проекте — `/root/sigaret-counter/docs/superpowers/progress.md`

Юнит: `WorkingDirectory=/root/agent-autopilot`, `ExecStart=/usr/bin/node /root/agent-autopilot/autopilot.mjs run`, `Restart=on-failure`, `RestartSec=30`, `EnvironmentFile=-/root/.config/agent-autopilot.env` (там `EXPO_TOKEN`), `Environment=HOME=/root`, `WantedBy=multi-user.target`. Выход с кодом 0 (done/halted/paused) службу не перезапускает.
`install.sh`: копирует юнит в `/etc/systemd/system/`, `daemon-reload`, `enable` (без `start`).
`README.md` (по-русски): установка, `status`/`resume`, где логи, как включить паузы, что делать при `auth`/`halted`/`waiting-user`.

- [x] **Step 1: Создать файлы, `bash install.sh`; `systemctl is-enabled agent-autopilot` → `enabled`**
- [x] **Step 2: Commit** — `git commit -m "feat(autopilot): systemd service and docs"`
- [x] **Step 3: Боевая проверка (выполняет заказчик или Claude с явного разрешения заказчика)** — `node /root/agent-autopilot/autopilot.mjs once` на плане приложения: проверить, что `claude -p` под root с `--permission-mode dontAsk` реально работает и выполняет Task 1 приложения (галочки + коммит). Если разрешений не хватает — поправить `claude-settings.json` и повторить. Записать в `README.md` фактический вид сообщения о лимите, когда он впервые встретится в `logs/`.
- [x] **Step 4: `systemctl start agent-autopilot`; `node /root/agent-autopilot/autopilot.mjs status` → `running`**
