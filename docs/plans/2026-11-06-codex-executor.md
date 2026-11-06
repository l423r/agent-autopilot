# Codex — исполнитель задач автопилота, Claude — голова — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Обычные задачи планов автопилот выполняет через OpenAI Codex CLI (`codex exec`, подписка ChatGPT Plus), а не через Claude. Claude остаётся «головой»: планировщик в пульте (чат), задачи `[planner]` и запасной исполнитель, когда Codex упёрся в лимит. Лимиты Codex (5-часовой и недельный) учитываются при выборе исполнителя и видны в пульте и в `status`.

**Architecture:**
- Исполнитель — новое понятие поверх учёток из плана `2026-11-04-fallback-account.md` (`lib/accounts.mjs`): у записи `accounts` появляется `kind: "claude" | "codex"` (по умолчанию `claude`). Новое поле конфига `executor: "codex"` — кто выполняет обычные задачи.
- Выбор на задачу (`lib/accounts.mjs`, чистая функция): `[planner]`-задача → только учётки `claude`. Обычная задача при `executor: "codex"` → учётка `codex`; если Codex в лимите или не авторизован → учётки `claude` по приоритету; все в лимите → `sleeping` до ближайшего сброса.
- Запуск: `lib/runner.mjs` собирает команду под вид исполнителя — `claude -p …` как сейчас или `codex exec --json … "<prompt>"` с `CODEX_HOME` учётки. Вывод Codex — JSONL-события; `lib/classify.mjs` получает разбор под Codex: успех/ошибка, лимит (с временем сброса из события `rate_limits`, если есть), нет входа (`auth`).
- Промпт: `prompt.md` ссылается на навыки Claude (superpowers), которых у Codex нет. Новый `prompt-codex.md` — тот же порядок работы, но правила (TDD, проверки, отметки, журнал, коммит, без push) написаны прямо в тексте. Шаг «отдельный субагент-ревьюер» для Codex: новая сессия и есть свежий ревьюер — сначала только читать diff и план и записать замечания в журнал, потом исправлять.
- Модели: пометки `haiku | sonnet | opus` переводятся через конфиг `codexModels` в модель и уровень рассуждений Codex; эскалация при неудаче (`haiku → sonnet → opus`) работает как сейчас.
- Лимиты: `web/limits.mjs` и `status` читают последнее событие с `rate_limits` из свежего файла сессий Codex (`$CODEX_HOME/sessions/**/*.jsonl`) — проценты и время сброса 5-часового и недельного окна.

**Tech Stack:** Node 22, `node:test`, `test/fixtures/fake-codex.sh` (новый), `@openai/codex` (npm, глобально).

**Spec:** просьба пользователя 2026-11-06: «Codex использовать и его лимиты учитывать… Claude будет головой, а автопилот на Codex», подписка ChatGPT Plus. План опирается на код плана `2026-11-04-fallback-account.md` (Tasks 1–7 выполнены).

## Global Constraints

- Конфиг: `"executor": "codex"` (нет поля или `"claude"` — всё как сейчас); в `accounts` запись `{ "name": "codex", "kind": "codex", "codexHome": "/root/.codex" }`; `"codexModels": { "haiku": { "model": "<id>", "effort": "low" }, "sonnet": { "model": "<id>", "effort": "medium" }, "opus": { "model": "<id>", "effort": "high" } }`. Идентификаторы моделей и флаги сверить по `codex --help` / `codex exec --help` установленной версии (Task 1) и записать в журнал; в коде — только из конфига, без зашитых имён моделей.
- Без `executor` и без записи `codex` поведение, формат `state.json` и все существующие тесты — как раньше.
- `[planner]`-задачи и чат пульта никогда не идут в Codex.
- Запуск Codex: неинтерактивно, без запросов подтверждений, с полным доступом к файлам проекта (`codex exec` с флагом обхода подтверждений и песочницы, рабочий каталог — `projectDir`), `--json`. Таймаут и убийство группы процессов — как у Claude.
- Строка лога и запись `stats` содержат исполнителя: `run Task N (codex/sonnet, попытка 1)`; `node autopilot.mjs stats` разбивает статистику по исполнителю и модели.
- Переключения исполнителя — как переключения учёток: одно уведомление ntfy на переключение («Лимит Codex до <время>, задачу делает Claude» / «Вернулся на Codex»), возврат на Codex — перед следующей задачей после сброса его лимита.
- Токены из `~/.codex/auth.json` и `.credentials.json` не попадают в лог, уведомления, ответы API и тесты.
- Службы `agent-autopilot` и `agent-autopilot-web` в задачах 1–8 не перезапускать (`agent-autopilot-web` — Task 11, `agent-autopilot` — только планировщик в Task 12: исполнитель работает внутри демона). `git push` в задачах не делать. Журнал — `docs/plans/2026-11-06-codex-executor.progress.md`. Автор коммитов — L423R.

## Review Focus

1. Выбор исполнителя: `[planner]` → только Claude; обычная → Codex; Codex в лимите → Claude без роста счётчика попыток; всё в лимите → один `sleeping` до ближайшего сброса; возврат на Codex только между задачами.
2. Разбор вывода Codex: лимит не принимается за ошибку (и наоборот), нет входа → `auth` только для Codex (Claude продолжает), сбой без JSON — обычная ошибка с хвостом вывода в логе.
3. `prompt-codex.md` не ссылается на навыки и инструменты, которых у Codex нет; правила отметок, журнала и коммита те же, что в `prompt.md`.
4. Без `executor` поведение прежнее; старый `state.json` читается.
5. Лимиты Codex в пульте: нет каталога сессий или событий — понятное «нет данных», а не падение.

---

### Task 1: [planner] Установка Codex CLI · model: sonnet

- [ ] **Step 1:** `npm i -g @openai/codex` (при недоступности npm — зеркало `--registry https://registry.npmmirror.com`). `codex --version`, `codex --help`, `codex exec --help`, `codex login --help` — сохранить вывод в журнал (флаги неинтерактивного запуска, JSON-вывода, рабочего каталога, модели и уровня рассуждений, вход по коду устройства). Список доступных на Plus моделей — из документации `codex` (`codex --help`, README пакета в `$(npm root -g)/@openai/codex`) — в журнал с предложением для `codexModels`. Вход не выполнять (Task 10). **Commit** — `docs: codex CLI installed, flags noted` (только журнал)

### Task 2: Выбор исполнителя · model: opus

**Files:** Modify `lib/accounts.mjs`; Test `test/accounts.test.mjs`

**Interfaces:** `listAccounts(cfg)` → `[{ name, kind, configDir|null, codexHome|null }]`; `pickExecutor(accounts, state, task, cfg, now) -> { name, kind, switched } | null` (правила — Review Focus 1); `accountEnv(account)` → `{ CLAUDE_CONFIG_DIR }` / `{ CODEX_HOME }` / `{}`.

- [ ] **Step 1:** Падающие тесты на все ветки Review Focus 1 и 4. `npm test` → FAIL.
- [ ] **Step 2:** Реализация. `npm test` → PASS. **Commit** — `feat(accounts): codex executor kind and task-aware choice`

### Task 3: Запуск и разбор вывода Codex · model: opus

**Files:** Modify `lib/runner.mjs`, `lib/classify.mjs`, `lib/models.mjs`; Create `test/fixtures/fake-codex.sh`, фикстуры JSONL в `test/fixtures/codex/`; Test `test/runner.test.mjs`, `test/classify.test.mjs`, `test/models.test.mjs`

- [ ] **Step 1:** Фикстуры JSONL по формату установленной версии (из `codex exec --json` документации/исходников пакета; если вход ещё не выполнен — по документации, с пометкой в журнале «сверить в Task 11»): успех, ошибка, лимит с `rate_limits`, лимит без времени, нет входа. Падающие тесты: аргументы команды Codex (модель и уровень из `codexModels`, рабочий каталог, JSON, без подтверждений), `CODEX_HOME` только у процесса codex, разбор всех фикстур (Review Focus 2). `npm test` → FAIL.
- [ ] **Step 2:** Реализация. `npm test` → PASS. **Commit** — `feat(runner): run tasks through codex exec`

### Task 4: Промпт для Codex · model: sonnet

**Files:** Create `prompt-codex.md`; Modify `autopilot.mjs` (`promptTemplate` по виду исполнителя); Test `test/cli.test.mjs`

- [ ] **Step 1:** `prompt-codex.md` по Global Constraints и Review Focus 3: порядок шагов как в `prompt.md`; TDD явными словами (сначала падающий тест, запуск, потом код, запуск); «каждую проверку из плана запусти и сверь вывод»; шаг ревью — свежий ревьюер в этой же сессии (сначала только чтение diff и плана, замечания по пунктам Review Focus в журнал, потом исправления). Тест: обычная задача на Codex получает `prompt-codex.md`, `[planner]` — прежний промпт планировщика. `npm test` → PASS. **Commit** — `feat: codex prompt`

### Task 5: Демон — исполнитель на задачу · model: opus

**Files:** Modify `autopilot.mjs`, `lib/decide.mjs`, `lib/runs.mjs`, `lib/notify.mjs`; Test `test/cli.test.mjs`, `test/decide.test.mjs`, `test/runs.test.mjs`

- [ ] **Step 1:** Сквозные тесты на `fake-codex.sh` и `fake-claude.sh`: план из обычной задачи, `[planner]`-задачи и ещё одной обычной → исполнители codex, claude, codex; лимит Codex на 1-й → она же сразу на Claude, без роста попыток, уведомление одно; сдвиг времени сброса → следующая обычная снова на Codex; лог и `stats` с исполнителем. `npm test` → FAIL.
- [ ] **Step 2:** Реализация. `npm test` → PASS. **Commit** — `feat: codex executes tasks, claude stays the head`

### Task 6: Лимиты Codex в пульте и status · model: sonnet

**Files:** Modify `web/limits.mjs`, `web/server.mjs`, `web/index.html`, `autopilot.mjs` (`status`); Test `test/web-limits.test.mjs`

- [ ] **Step 1:** Падающие тесты на временном `CODEX_HOME` с файлами сессий: берётся самое свежее событие с `rate_limits` → `{ fiveHour: { percent, resetsAt }, week: {…} }`; нет каталога/событий → `{ error: 'Нет данных о лимитах Codex' }` (Review Focus 5); `/api/limits` отдаёт строку «Codex» с пометкой «исполнитель». `npm test` → FAIL → реализация → PASS.
- [ ] **Step 2:** `status`: строка `Исполнитель: codex (5 ч: N %, неделя: M %)`. Скриншот блока лимитов во временном экземпляре пульта в 390 px (Read). **Commit** — `feat(web): codex limits`

### Task 7: Проверка результата · model: sonnet

- [ ] **Step 1:** `npm test` → PASS. Ручной прогон на временном `stateDir` с `fake-codex.sh` и `fake-claude.sh`: план из 4 задач (обычная, `[planner]`, обычная, обычная), лимит Codex на 3-й → 3-я и 4-я на Claude; затем сдвиг сброса и `resume` → следующая на Codex. Лог, `status`, `stats` — в журнал.
- [ ] **Step 2:** Найденное — исправить через TDD. **Commit** — `fix: codex executor по итогам проверки` (если были правки)

### Task 8: Ревью свежим ревьюером · model: opus

- [ ] **Step 1:** По superpowers:requesting-code-review отдельный субагент-ревьюер (инструмент Agent, самая способная модель, указать явно) на диапазон от коммита перед Task 2 до HEAD; передать план с Global Constraints и Review Focus (каждую строку проверить отдельно).
- [ ] **Step 2:** Critical и Important — исправить (тест → FAIL → PASS); Minor — в журнал `minor (отложено): …`. `npm test` → PASS. **Commit** — `fix: замечания ревью codex`

### Task 9: Финальный артефакт — документация · model: haiku

**Files:** Modify `README.md`, `config.example.json`, `web/planner-prompt.md`

- [ ] **Step 1:** README: раздел «Codex — исполнитель» (кто что делает, поля `executor`, `accounts[kind=codex]`, `codexModels`, выбор и возврат, лимиты в пульте, вход `codex login --device-auth`, `stats` по исполнителям). `config.example.json` — пример. `web/planner-prompt.md`: одна строка — «обычные задачи выполняет Codex без навыков Claude: шаги плана пиши явно (команды, ожидаемый вывод), ревью — „свежий ревьюер в новой сессии“». **Commit** — `docs: codex executor`

### Task 10: [manual] Вход в Codex под ChatGPT Plus

- [ ] **Step 1:** Планировщик запускает `codex login --device-auth` в терминале пульта (https://151-243-245-85.sslip.io/term/, tmux-сессия `phone`) и присылает пользователю ссылку и код из вывода. Пользователь открывает ссылку с телефона, входит в аккаунт ChatGPT с подпиской Plus и вводит код. Проверка (планировщик): `codex exec --json "ответь одним словом: ок"` → в выводе «ок»; `~/.codex/auth.json` есть. Этот шаг отмечает пользователь (или планировщик по его «вошёл»).

### Task 11: [planner] Включение · model: sonnet

- [ ] **Step 1:** Сверить фикстуры Task 3 с реальным выводом `codex exec --json` (успех; событие с `rate_limits`) — расхождения исправить через TDD, `npm test` → PASS. Дождаться, пока `status` — не `running`. В `config.json`: `executor: "codex"`, запись `codex` в `accounts`, `codexModels` из журнала Task 1. Перезапустить `agent-autopilot-web` (не `agent-autopilot`: исполнитель работает внутри него). В журнал — строку `НУЖЕН ПЕРЕЗАПУСК agent-autopilot` (его делает планировщик в Task 12).

### Task 12: [manual] Перезапуск демона и проверка

- [ ] **Step 1:** Планировщик в чате пульта, когда `status` — не `running`: `systemctl restart agent-autopilot`; `status` показывает `Исполнитель: codex` и лимиты Codex; первая следующая обычная задача в логе — `run Task N (codex/…)`. Итог — пользователю и в журнал; шаг отмечает планировщик.
