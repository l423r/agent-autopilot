# Запасная учётка Claude при лимите основной — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Когда основная учётка Claude упирается в лимит (5-часовой или недельный), автопилот не спит до сброса, а сразу продолжает ту же задачу на запасной учётке. Как только лимит основной сброшен, автопилот возвращается на неё перед следующей задачей. Чат планировщика в пульте работает на той же учётке, что и автопилот. Лимиты в пульте видны по обеим учёткам.

**Architecture:** Учётка — это каталог настроек Claude Code (`CLAUDE_CONFIG_DIR`) со своим `.credentials.json`. Запасной каталог `/root/.claude-alt` повторяет основной через симлинки (`settings.json`, `plugins`, `skills`, `projects` — плагины, навыки и память общие), кроме входа. Новое поле конфига `accounts`; выбор учётки — чистая функция в новом `lib/accounts.mjs`; `decide.mjs` при лимите отмечает учётку и переключает; `runner.mjs` и чат пульта получают `CLAUDE_CONFIG_DIR` выбранной учётки; `web/limits.mjs` читает токен из каталога учётки.

**Tech Stack:** Node 22, `node:test`, `test/fixtures/fake-claude.sh`.

**Spec:** просьба пользователя 2026-11-04: «хочу чтоб автопилот поддерживал использование другой учетки клауд», режим — «запасная, при лимите основной». Данные второй учётки пользователь пришлёт 2026-11-05.

## Global Constraints

- Конфиг: `"accounts": [{ "name": "основная" }, { "name": "запасная", "configDir": "/root/.claude-alt" }]`. Порядок — приоритет: первая — основная. Учётка без `configDir` запускается без `CLAUDE_CONFIG_DIR` (как сейчас: `/root/.claude` + `~/.claude.json`). Нет `accounts` или в нём одна запись — поведение как сейчас, все существующие тесты зелёные.
- Состояние (`state.json`): `account` — имя текущей учётки, `accountLimits: { <имя>: <ISO время сброса> }`. Время сброса — из сообщения о лимите (`classify`), иначе `now + retryMinutes`.
- Лимит на учётке A → записать сброс A; есть учётка без действующего лимита → переключиться на неё и сразу (статус `idle`) повторить ту же задачу. Это не попытка: счётчик попыток не растёт. Все учётки в лимите → `sleeping` до ближайшего сброса.
- Перед каждой задачей: если учётка выше по приоритету, чем текущая, уже без лимита — вернуться на неё. Уведомление ntfy — один раз на каждое переключение: «Лимит «основная» до <время>, продолжаю на «запасная»» / «Вернулся на «основная»». Строка в лог — так же.
- `auth` на запасной: учётка отмечается как недоступная до `resume`, уведомление «Запасная учётка не авторизована». Если основная в лимите — `sleeping` до сброса, а не `auth`. `auth` на основной — как сейчас.
- `resume` и команда «продолжить» не сбрасывают `accountLimits`, у которых время сброса ещё не наступило.
- `status` пишет строку `Учётка: <имя>` и, если есть, `Лимит: <имя> до <время>`.
- Токены и содержимое `.credentials.json` не попадают в лог, уведомления, ответы API и тесты (в тестах — фиктивные файлы во временном каталоге).
- Каталог `/root/.claude-alt` создаёт `scripts/setup-alt-account.sh`. Он делает симлинки на `settings.json`, `plugins`, `skills`, `projects` из `/root/.claude` и не трогает `.credentials.json`. Повторный запуск безопасен. Вход в учётку — отдельной ручной задачей.
- `git push` в задачах не делать. Службы `agent-autopilot` и `agent-autopilot-web` в задачах 1–7 не перезапускать (их перезапуск — задача 9). Журнал — `docs/plans/2026-11-04-fallback-account.progress.md`. Автор коммитов — L423R.

## Review Focus

1. Лимит на основной в середине задачи → та же задача на запасной без роста счётчика попыток и без `sleeping`; лимит на обеих → один `sleeping` до ближайшего сброса, без цикла переключений.
2. Возврат на основную только между задачами и только после её сброса; нет «пинг-понга» при каждом шаге.
3. Без `accounts` поведение и формат `state.json` прежние (старый `state.json` без новых полей читается).
4. Токен нигде не выводится; `CLAUDE_CONFIG_DIR` не утекает в `git push` и другие дочерние процессы, кроме claude.
5. Чат пульта и лимиты в пульте берут учётку из `state.json` демона; при отсутствии `.credentials.json` у запасной — понятная ошибка в блоке лимитов, а не падение.

---

### Task 1: Выбор учётки — lib/accounts.mjs · model: opus

**Files:** Create `lib/accounts.mjs`, `test/accounts.test.mjs`

**Interfaces:** `listAccounts(cfg) -> [{ name, configDir|null }]` (нет `accounts` → `[{ name: 'основная', configDir: null }]`; пустые/повторные имена — ошибка конфига); `accountEnv(account) -> {}` или `{ CLAUDE_CONFIG_DIR }`; `pickAccount(accounts, state, now) -> { name, switched: 'fallback'|'back'|null }` (первая учётка без действующего лимита и не отмеченная `auth`, иначе `null`); `earliestReset(state) -> Date|null`.

- [x] **Step 1:** Падающие тесты на все ветки из Global Constraints (одна учётка; лимит основной → запасная; обе в лимите → `null` и ближайший сброс; сброс основной прошёл → `back`; `auth` у запасной). `npm test` → FAIL.
- [x] **Step 2:** Реализация. `npm test` → PASS. **Commit** — `feat(accounts): choose Claude account by limits`

### Task 2: Демон — лимит переключает учётку · model: opus

**Files:** Modify `lib/decide.mjs`, `lib/runner.mjs`, `lib/state.mjs`, `autopilot.mjs`; Test `test/decide.test.mjs`, `test/cli.test.mjs`

- [ ] **Step 1:** Падающие тесты: `decide` при `limit` с двумя учётками → `idle`, `account` = запасная, `accountLimits` с временем сброса, `attempts` без изменений; с одной учёткой — как сейчас. Сквозные на `fake-claude.sh` (новый режим: печатает сообщение о лимите, если `CLAUDE_CONFIG_DIR` пуст; иначе успех): задача выполняется на запасной в том же цикле; в логе — строка о переключении; после подмены времени (сброс прошёл) следующая задача — на основной; Review Focus 1–3. `npm test` → FAIL.
- [ ] **Step 2:** Реализация: `runIteration` получает `env` из `accountEnv` выбранной учётки (только для процесса claude); уведомления и строки лога по Global Constraints; `status` — строки «Учётка» и «Лимит». `npm test` → PASS. **Commit** — `feat: fall back to the spare Claude account on limit`

### Task 3: Пульт — чат и лимиты по учёткам · model: sonnet

**Files:** Modify `web/server.mjs`, `web/limits.mjs`, чат пульта (модуль, где запускается `claude` для планировщика), `web/index.html`; Test `test/web-limits.test.mjs`, `test/web-chat.test.mjs`

- [ ] **Step 1:** Падающие тесты: `fetchLimits({ credentialsFile })` для каждой учётки (`<configDir>/.credentials.json`, у основной — `/root/.claude/.credentials.json`); `GET /api/limits` → `{ accounts: [{ name, active, fiveHour, week } | { name, error }] }`; чат запускает claude с `CLAUDE_CONFIG_DIR` текущей учётки из `state.json`. `npm test` → FAIL.
- [ ] **Step 2:** Реализация; в пульте блок лимитов — по строке на учётку, активная помечена. Без `accounts` — как сейчас (одна строка). `npm test` → PASS. **Commit** — `feat(web): per-account limits, planner chat on the active account`

### Task 4: Скрипт каталога запасной учётки · model: sonnet

**Files:** Create `scripts/setup-alt-account.sh`; Test `test/setup-alt-account.test.mjs`

- [ ] **Step 1:** Тест на временных каталогах (`SRC`/`DST` через переменные окружения): создаёт симлинки по Global Constraints, `.credentials.json` не копирует и не трогает, повторный запуск не ломает и не дублирует, существующий не-симлинк в `DST` не перезаписывает (ошибка с понятным текстом). `npm test` → FAIL → реализация → PASS. **Commit** — `feat: setup script for the spare account config dir`

### Task 5: Проверка результата · model: sonnet

- [ ] **Step 1:** `npm test` → PASS. Ручной прогон на временном `stateDir` с `fake-claude.sh` и двумя «учётками» во временных каталогах: план из трёх задач, лимит на основной на 2-й задаче → 2-я и 3-я на запасной; затем сдвиг времени сброса в прошлое → `resume` демона, следующая задача на основной. Лог и вывод `status` — в журнал.
- [ ] **Step 2:** Найденное — исправить через TDD. **Commit** — `fix: fallback account по итогам проверки` (если были правки)

### Task 6: Ревью свежим ревьюером · model: opus

- [ ] **Step 1:** По superpowers:requesting-code-review отдельный субагент-ревьюер (инструмент Agent, самая способная модель, указать явно) на диапазон от коммита перед Task 1 до HEAD; передать план с Global Constraints и Review Focus (каждую строку проверить отдельно).
- [ ] **Step 2:** Critical и Important — исправить (тест → FAIL → PASS); Minor — в журнал `minor (отложено): …`. `npm test` → PASS. **Commit** — `fix: замечания ревью запасной учётки`

### Task 7: Финальный артефакт — документация · model: haiku

**Files:** Modify `README.md`, `config.example.json`

- [ ] **Step 1:** README: раздел «Запасная учётка» — как работает переключение и возврат, поле `accounts`, `scripts/setup-alt-account.sh`, вход (`CLAUDE_CONFIG_DIR=/root/.claude-alt claude`, затем `/login`), строки `status`, блок лимитов в пульте. `config.example.json` — пример `accounts`. **Commit** — `docs: spare Claude account`

### Task 8: [manual] Вход во вторую учётку

- [ ] **Step 1:** Планировщик запускает `bash scripts/setup-alt-account.sh`, затем в терминале пульта `CLAUDE_CONFIG_DIR=/root/.claude-alt claude` → `/login`; пользователь открывает ссылку входа с телефона под второй учёткой и присылает код. Проверка: `CLAUDE_CONFIG_DIR=/root/.claude-alt claude -p "ответь ок"` → «ок»; `/root/.claude-alt/.credentials.json` есть, основной `/root/.claude/.credentials.json` не изменился.

### Task 9: [planner] Включение · model: sonnet

- [ ] **Step 1:** Дождаться паузы между задачами (`status` — не `running`). В `config.json` добавить `accounts` по Global Constraints. Перезапустить `agent-autopilot` и `agent-autopilot-web`. `status` показывает «Учётка: основная», в пульте — лимиты двух учёток. Итог — в журнал.
