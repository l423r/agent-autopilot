# Управление автопилотом с телефона через ntfy — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автопилот принимает с телефона три команды (статус, пауза, продолжить) — набранные в ntfy или нажатые кнопками прямо в уведомлениях — и отвечает уведомлением.

**Architecture:** Внутри процесса-демона живёт подписчик на канал команд `<ntfyTopic>-cmd` (потоковый `GET …/json` с переподключением). Команда разбирается по белому списку чистой функцией `applyCommand`; всё, что меняет `state.json`, выполняет только основной цикл между итерациями, поэтому гонок записи нет. Если команды включены, остановленный автопилот не завершает процесс, а ждёт команд. Уведомления получают кнопки (ntfy `actions`, тип `http`), которые публикуют команду в канал команд.

**Tech Stack:** Node 22, ESM, без зависимостей; `node:test`; `fetch` с потоковым чтением тела.

**Spec:** договорённость в чате 2026-10-21 («уровень 1»): только фиксированные команды, никакого произвольного текста в shell или Claude; пауза не прерывает идущую задачу.

## Global Constraints

- Без новых npm-зависимостей; тесты — `npm test` (`TZ=UTC node --test`), сеть в тестах только к локальному поддельному серверу.
- Безопасность: текст команды никогда не передаётся в shell, в Claude или в файлы плана; распознаются только слова из белого списка, всё прочее — ответ «неизвестная команда».
- Команды: `статус`/`status`/`?` → status; `пауза`/`pause`/`стоп`/`stop` → pause; `продолжить`/`resume`/`дальше`/`go` → resume. Регистр и пробелы по краям не важны.
- «Пауза» во время итерации не убивает Claude: автопилот встаёт на паузу после текущей задачи.
- `state.json` пишет только основной цикл; подписчик лишь кладёт команды в очередь и отвечает на `status`.
- Повторный запуск демона не выполняет старые команды повторно: id последней обработанной команды хранится в `state/commands.since`; без файла подписка начинается с текущего момента.
- Сбой ntfy не останавливает автопилот: переподключение с паузой 5 → 10 → … → 60 с, без плотного цикла.
- Новые ключи конфига: `ntfyCommands` (bool, по умолчанию false), `ntfyCommandToken` (токен для кнопок: право записи в канал команд). Без `ntfyCommands` поведение прежнее (остановка = выход процесса).
- В уведомлении не больше 3 кнопок. Кнопки — `http`, `method=POST`, тело = команда, заголовок `Authorization=Bearer <ntfyCommandToken>`.
- Тексты для человека — по-русски. Автор коммитов — L423R.

## Review Focus

1. Обрыв и переподключение потока ntfy: команда не выполняется дважды и не теряется (since по id).
2. Команда приходит во время итерации: никакой записи `state.json` из подписчика; пауза применяется после итерации.
3. Перезапуск демона: старые команды из кэша ntfy не исполняются.
4. Мусор в канале: длинный текст, пустое сообщение, не-`message` события (`open`, `keepalive`), битый JSON — без падения, с ответом только на `message`.
5. ntfy недоступен или отвечает 401/403: демон продолжает работу, в лог — одна строка на попытку, не чаще раза в 5 с.

## Предусловия (делает человек/Claude до запуска автопилота)

На сервере ntfy: телефону право записи в `autopilot-*-cmd`, пользователю `autopilot` право чтения `autopilot-*-cmd`; токен телефона для кнопок. В `config.json` автопилота: `ntfyCommandToken`. Проверено curl.

## Структура файлов

- `lib/commands.mjs` — `parseCommand`, `applyCommand`, `statusText` (чистые функции).
- `lib/listen.mjs` — `subscribeCommands` (поток ntfy, переподключение, since).
- `lib/notify.mjs` — + `actions` (кнопки), `buttonsFor`.
- `autopilot.mjs` — очередь команд, ожидание команд в остановленном состоянии, пауза после итерации.
- Тесты: `test/commands.test.mjs`, `test/listen.test.mjs`, дополнения в `test/notify.test.mjs`, `test/cli.test.mjs`.

---

## Этап 1. Команды

### Task 1: Разбор и применение команд

**Files:**
- Create: `lib/commands.mjs`, `test/commands.test.mjs`

**Interfaces:**
- Consumes: `STOPPED`, `resume` из `lib/decide.mjs`; `parsePlan`-результат `{ tasks }`.
- Produces:
  - `parseCommand(text: string): 'status'|'pause'|'resume'|null`
  - `applyCommand(cmd, state, { busy: boolean, summary: string }): { state: object|null, pauseAfterTask: boolean, reply: { title: string, message: string } }` — `state: null` значит «не менять».
  - `statusText(state, plan): string` — 2–4 строки: статус, прогресс x/N, текущая/следующая задача, следующая попытка.

- [ ] **Step 1: Тесты** `test/commands.test.mjs`:
  - `parseCommand`: `' Статус '`→status, `'?'`→status, `'STOP'`→pause, `'дальше'`→resume, `'rm -rf /'`→null, `''`→null, строка 10 000 символов → null.
  - `applyCommand('pause', idle, {busy:false})` → state.status `paused`, reason содержит «по команде»; `busy:true` → state null, pauseAfterTask true, reply упоминает текущую задачу.
  - `applyCommand('pause', {status:'halted'})` → state null, reply «уже остановлен».
  - `applyCommand('resume', halted с attempts)` → status idle, attempts {}; `sleeping` → status idle, nextAttemptAt null; `busy:true` → state null, reply «уже работаю».
  - `applyCommand('status', …)` → state null, reply.message === summary.
  - `applyCommand(null, …)` → state null, reply перечисляет «статус, пауза, продолжить».
  - `statusText` содержит `3/5` и id следующей задачи.
- [ ] **Step 2:** `npm test` → новые тесты FAIL (нет модуля)
- [ ] **Step 3:** Реализовать `lib/commands.mjs`
- [ ] **Step 4:** `npm test` → PASS все
- [ ] **Step 5: Commit** — `git commit -m "feat(autopilot): command parsing and application"`

### Task 2: Подписка на канал команд

**Files:**
- Create: `lib/listen.mjs`, `test/listen.test.mjs`

**Interfaces:**
- Produces: `subscribeCommands(cfg, { sinceFile: string, onMessage: (msg: {id, time, message}) => void|Promise<void>, log: (s) => void }): { stop(): void }` — URL `${ntfyServer}/${ntfyTopic}-cmd/json?since=<id|unix-seconds>`, заголовок `Authorization: Bearer ${ntfyToken}` при наличии. После каждого обработанного `message` записывает его id в `sinceFile` (атомарно). Переподключение с задержкой 5 с, удваивая до 60 с; удачное соединение сбрасывает задержку.

- [ ] **Step 1: Тесты** с локальным HTTP-сервером, отдающим поток строк JSON:
  - доставляет `message`, игнорирует `open`/`keepalive` и битую строку;
  - после обрыва соединения переподключается и запрашивает `since=<id последнего>`; сообщение не доставлено дважды;
  - без `sinceFile` первый запрос — `since=<число секунд ≈ сейчас>`;
  - при 403 пишет в лог и повторяет не раньше чем через задержку (в тесте — укороченную через `cfg.__retryMs`);
  - `stop()` закрывает соединение и прекращает переподключения.
- [ ] **Step 2:** `npm test` → FAIL
- [ ] **Step 3:** Реализовать `lib/listen.mjs` (`fetch` + `AbortController`, чтение `res.body` по строкам)
- [ ] **Step 4:** `npm test` → PASS все
- [ ] **Step 5: Commit** — `git commit -m "feat(autopilot): ntfy command subscription with reconnect"`

## Этап 2. Встраивание

### Task 3: Кнопки в уведомлениях

**Files:**
- Modify: `lib/notify.mjs`, `test/notify.test.mjs`, `autopilot.mjs`

**Interfaces:**
- Produces: `notify(cfg, { …, actions?: Array<{label, command}> })` — параметр `actions` формата ntfy: `http, <label>, <server>/<topic>-cmd, method=POST, body=<command>, headers.Authorization=Bearer <ntfyCommandToken>; …`; без `ntfyCommandToken` или `ntfyCommands` кнопок нет. `buttonsFor(kind: 'done'|'waiting-user'|'halted'|'auth'|'paused'|'limit'|'task'): Array<{label, command}>` — done → [Статус]; waiting-user, halted → [Продолжить, Статус]; auth, paused → [Продолжить]; limit → [Продолжить сейчас]; task → [Пауза].

- [ ] **Step 1: Тесты:** `notify` с actions отправляет параметр `actions` с двумя кнопками в формате выше; без `ntfyCommandToken` параметра нет; `buttonsFor('halted')` — ровно [Продолжить→resume, Статус→status]; ни у одного вида больше 3 кнопок.
- [ ] **Step 2:** `npm test` → FAIL
- [ ] **Step 3:** Реализовать; в `autopilot.mjs` передать `buttonsFor(...)` во все места отправки уведомлений.
- [ ] **Step 4:** `npm test` → PASS все
- [ ] **Step 5: Commit** — `git commit -m "feat(autopilot): action buttons in notifications"`

### Task 4: Команды в демоне

**Files:**
- Modify: `autopilot.mjs`, `test/cli.test.mjs`, `README.md`, `config.example.json`

**Interfaces:**
- Consumes: Task 1–3.
- Produces: при `ntfyCommands: true` демон в `run` запускает `subscribeCommands`; очередь команд; флаг `busy` на время `runIteration`; `pauseAfterTask` в памяти процесса.

- [ ] **Step 1: CLI-тесты** (поддельный ntfy принимает публикации и отдаёт поток команд):
  - `status` во время итерации (FAKE_MODE `hang` с коротким тайм-аутом не годится — добавить в fake-claude режим `slow`: ждёт 2 с, затем как `tick`) → ответное уведомление приходит до конца итерации, `state.json` подписчиком не тронут;
  - `pause` во время итерации → итерация доходит до конца, затем статус `paused`, следующая задача не запускается;
  - автопилот в `halted` с `ntfyCommands` не выходит; `resume` → задача снова запускается;
  - `sleeping` после лимита + `resume` → запуск без ожидания `nextAttemptAt`;
  - перезапуск демона при уже обработанной команде в кэше сервера → она не выполняется второй раз;
  - без `ntfyCommands` остановленный демон завершается как раньше (существующие тесты зелёные).
- [ ] **Step 2:** `npm test` → FAIL
- [ ] **Step 3:** Реализовать в `autopilot.mjs`; ожидание команд в остановленном/спящем состоянии — тем же циклом с шагом ≤1 с, просыпаясь по новой команде.
- [ ] **Step 4:** README: раздел «Управление с телефона» (команды, кнопки, ключи `ntfyCommands`/`ntfyCommandToken`, права на сервере ntfy); `config.example.json`: `"ntfyCommands": false`, `"ntfyCommandToken": ""`.
- [ ] **Step 5:** `npm test` → PASS все
- [ ] **Step 6: Commit** — `git commit -m "feat(autopilot): phone commands in the daemon"`

## Этап 3. Проверка и ревью

### Task 5: Живая проверка на настоящем сервере ntfy

**Files:**
- Create: `scripts/live-check.mjs`

- [ ] **Step 1:** Скрипт `scripts/live-check.mjs`: временный проект с маленьким планом (2 задачи), конфиг с настоящим `ntfyServer`/`ntfyToken`/`ntfyCommandToken` из `config.json`, но тема `<ntfyTopic>-livecheck`, `AUTOPILOT_CLAUDE` = `test/fixtures/fake-claude.mjs` в режиме `slow`; запускает `autopilot.mjs run` отдельным процессом (свой `stateDir`, служба не трогается). Затем от имени телефона (`ntfyCommandToken`, curl/fetch) публикует `статус`, `пауза`, `продолжить` и проверяет по `…-livecheck/json?poll=1` ответы и состояние. Падает с понятным сообщением при любом расхождении.
- [ ] **Step 2:** Запустить `node scripts/live-check.mjs` → все проверки OK; проверить, что опубликованное уведомление содержит `actions` (из `poll=1`) и что кнопка из него, отправленная как есть (url, тело, заголовок), принимается сервером (200).
- [ ] **Step 3:** Итог (что проверено, ответы сервера) — в журнал `docs/plans/2026-10-21-ntfy-commands.progress.md`
- [ ] **Step 4: Commit** — `git commit -m "test(autopilot): live check of phone commands"`

### Task 6: Ревью кода

- [ ] **Step 1:** По superpowers:requesting-code-review запустить отдельного субагента-ревьюера (инструмент Agent, самая способная модель, указать явно) на диапазон от коммита перед Task 1 до HEAD. Передать этот план с Global Constraints и Review Focus (каждую строку проверить отдельно) и журнал прогресса.
- [ ] **Step 2:** Critical и Important — исправить за один проход, каждое через TDD (тест, воспроизводящий находку, сначала падает). Minor — в журнал строками `minor (отложено): …`; несогласие с находкой — `Решение: … — почему — цена ошибки`.
- [ ] **Step 3:** `npm test` → PASS; `node scripts/live-check.mjs` → OK; итог ревью в журнал
- [ ] **Step 4: Commit** — `git commit -m "fix(autopilot): review findings for phone commands"`

### Task 7: [manual] Включение и проверка с телефона

- [ ] **Step 1:** Вернуть `config.json` на проект sigaret-counter, включить `ntfyCommands: true`, перезапустить службу (`systemctl restart agent-autopilot`) — она остаётся работать в статусе `done`, ожидая команд.
- [ ] **Step 2:** С телефона: написать в канал `<ntfyTopic>-cmd` слово `статус` → пришёл ответ; нажать кнопку «Статус» в уведомлении → пришёл ответ.
- [ ] **Step 3:** Отметить галочки, запушить.
