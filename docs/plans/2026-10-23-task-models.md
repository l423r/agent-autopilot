# Модель на задачу — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автопилот запускает каждую задачу на модели, указанной в её заголовке (`haiku`, `sonnet`, `opus`), при неудачной попытке повышает модель и ведёт журнал запусков (модель, попытка, результат, время, токены, стоимость), чтобы было видно, где слабая модель справляется.

**Architecture:** `lib/plan.mjs` достаёт из заголовка задачи пометку `· model: <имя>` в поле `task.model` и убирает её из названия. Чистая функция `modelFor` в новом `lib/models.mjs` выбирает модель по пометке, `cfg.defaultModel` и номеру попытки. `runIteration` передаёт `--model`. После каждого запуска строка дописывается в `logs/runs.jsonl`, а `node autopilot.mjs stats` сводит её по моделям. Модель видна в статусе, в уведомлениях и в пульте.

**Tech Stack:** Node 22, `node:test` (`npm test`), без новых зависимостей.

**Spec:** этот план. Решение согласовано с пользователем 23.10.2026: вместо второго автопилота — модель на задачу с повышением при неудаче. Модели расставляет планировщик при написании плана.

## Global Constraints

- Допустимые пометки — только `haiku`, `sonnet`, `opus`, без учёта регистра, в конце заголовка: `### Task 4: Заявки · model: sonnet` (разделитель `·` или `|`, пробелы любые). Другой текст после `model:` пометкой не считается и остаётся в названии.
- Лестница повышения: `haiku → sonnet → opus`. Попытка N (с 1) идёт на ступень `базовая + (N − 1)`, но не выше `opus`. Повышают только попытки, которые засчитываются в `attempts` (ошибка, таймаут). Лимит и авторизация попытку не засчитывают, поэтому модель не меняют.
- Нет пометки и нет `cfg.defaultModel` → флаг `--model` не передаётся (как сейчас); повышения нет.
- `cfg.defaultModel` — необязательное поле `config.json`, одно из трёх значений; неверное значение → автопилот не стартует, сообщение «defaultModel: допустимо haiku, sonnet, opus».
- Старые планы без пометок работают как раньше. Все существующие тесты остаются зелёными.
- `git push` в задачах не делать. Журнал — `docs/plans/2026-10-23-task-models.progress.md`.

## Review Focus

1. Заголовок `### Task 9: Выкладка [manual] · model: haiku` → `manual: true`, `model: 'haiku'`, название «Выкладка» (порядок пометок любой). → Task 1.
2. Демон перезапустился посреди попытки (попытка уже засчитана в `markRunning`) → следующая попытка идёт на следующей ступени, а не повторяет прежнюю. → Task 2.
3. Вывод Claude без JSON-результата (таймаут, `spawn error`) → строка в `runs.jsonl` всё равно пишется, `tokens`/`costUsd` = `null`, `stats` не падает. → Task 3.
4. Пометка в плане, который пульт показывает: модель видна в карточке задачи, а в названии её нет. → Task 4.
5. `runs.jsonl` повреждён (обрезанная строка) → `stats` пропускает её и сообщает «пропущено строк: 1». → Task 3.

---

### Task 1: Пометка модели в плане · model: sonnet

**Files:** Modify `lib/plan.mjs`; Test `test/plan.test.mjs`

**Interfaces:** Produces: у каждой задачи `parsePlan` поле `model: 'haiku'|'sonnet'|'opus'|null`; `title` без пометки.

- [x] **Step 1:** Падающие тесты:
  - `### Task 4: Заявки · model: sonnet` → `{ title: 'Заявки', model: 'sonnet' }`;
  - `### Task 5: Фото | MODEL: Opus` → `model: 'opus'`;
  - `### Task 9: Выкладка [manual] · model: haiku` → `manual: true`, `model: 'haiku'`, `title: 'Выкладка'`;
  - `### Task 6: Модель данных` → `model: null`, `title: 'Модель данных'`;
  - `### Task 7: Выбор · model: gpt` → `model: null`, `title` содержит `model: gpt`.
- [x] **Step 2:** `npm test` → FAIL.
- [x] **Step 3:** В `parsePlan` регулярное `/\s*[·|]\s*model:\s*(haiku|sonnet|opus)\s*$/i` применяется к заголовку до разбора `[manual]` и после него (пометки в любом порядке).
- [x] **Step 4:** `npm test` → PASS. **Commit:** `feat: пометка модели в заголовке задачи`

### Task 2: Выбор модели и повышение при неудаче · model: opus

**Files:** Create `lib/models.mjs`, `test/models.test.mjs`. Modify `lib/runner.mjs`, `lib/decide.mjs` (`markRunning`), `autopilot.mjs` (`step`, `loadConfig`), `test/runner.test.mjs`, `test/decide.test.mjs`.

**Interfaces:**
- Produces:
  - `MODELS = ['haiku', 'sonnet', 'opus']`;
  - `modelFor(task, attempt: number, cfg): string|null` — `attempt` — номер текущей попытки с 1;
  - `validateModelConfig(cfg): void` — бросает `Error('defaultModel: допустимо haiku, sonnet, opus')`;
  - `runIteration({ ..., model })` — при `model` добавляет `'--model', model` в аргументы;
  - `markRunning(state, task, now, model)` — сохраняет `state.currentModel = model`;
  - `step()` вычисляет `attempt = (state.attempts[task.id] ?? 0) + 1` (до `markRunning`), `model = modelFor(task, attempt, cfg)`. Лог: `run Task 4 (sonnet, попытка 2): Заявки`, без модели — как сейчас.
- Уведомление «Task N готова»: в тексте добавляется `· <модель>`, если модель была.

- [x] **Step 1:** Падающие тесты:
  - `modelFor({ model: 'haiku' }, 1, {}) === 'haiku'`, попытка 2 → `'sonnet'`, попытка 3 → `'opus'`, попытка 5 → `'opus'`;
  - `modelFor({ model: 'sonnet' }, 2, {}) === 'opus'`;
  - `modelFor({ model: null }, 3, {}) === null`; `modelFor({ model: null }, 1, { defaultModel: 'sonnet' }) === 'sonnet'`, попытка 2 → `'opus'`;
  - `validateModelConfig({ defaultModel: 'gpt' })` бросает с текстом; `{}` — не бросает;
  - `runIteration` с `model: 'haiku'` и подставным `claudeBin` (скрипт, печатающий свои аргументы) → в выводе есть `--model haiku`; без `model` — нет `--model`;
  - рестарт посреди попытки: состояние `attempts: { 'Task 4': 1 }` (попытка 1 засчитана `markRunning`, демон умер) → следующий запуск `attempt = 2` → модель на ступень выше.
- [x] **Step 2:** FAIL. **Step 3:** Реализовать. **Step 4:** `npm test` → PASS. **Commit:** `feat: модель на задачу с повышением при неудаче`

### Task 3: Журнал запусков и `stats` · model: sonnet

**Files:** Create `lib/runs.mjs`, `test/runs.test.mjs`. Modify `lib/classify.mjs` (экспорт `usageOf`), `autopilot.mjs` (запись после запуска, команда `stats`), `README.md` (раздел «Логи» и «Команды»).

**Interfaces:**
- Produces:
  - `usageOf(output: string): { tokens: { input, output, cacheRead, cacheWrite } | null, costUsd: number|null }` — из последнего `{"type":"result"...}` (поля `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, `total_cost_usd`); нет JSON → `null`ы;
  - `appendRun(logDir, run)` — строка JSON в `logs/runs.jsonl`: `{ at, project, plan, task, title, model, attempt, result, done, durationSec, tokens, costUsd }`; `model` — `null`, если флаг не передавался;
  - `summarizeRuns(lines: string[]): { byModel: { [model|'по умолчанию']: { runs, ok, done, avgDurationSec, totalCostUsd, tokensOut } }, skipped: number }`;
  - `node autopilot.mjs stats [--plan <имя файла плана>]` — таблица по моделям: запусков, успешных (задача закрыта), средняя длительность, стоимость, выходные токены; в конце «пропущено строк: N», если N > 0.

- [x] **Step 1:** Падающие тесты:
  - `usageOf` на фикстуре `{"type":"result","is_error":false,"total_cost_usd":0.42,"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40}}` → `costUsd: 0.42`, `tokens.output: 20`; на `spawn error: ENOENT` → `{ tokens: null, costUsd: null }`;
  - `summarizeRuns` на трёх строках (haiku ok+done, haiku error, sonnet ok+done) → `haiku.runs = 2`, `haiku.done = 1`, `sonnet.done = 1`; обрезанная строка → `skipped: 1`;
  - `stats` на пустом журнале печатает «Запусков пока нет».
- [x] **Step 2:** FAIL. **Step 3:** Реализовать. Запись в журнал — в `step()` после `classify`, для каждого запуска, включая неудачные. **Step 4:** PASS. **Commit:** `feat: журнал запусков по моделям и команда stats`

### Task 4: Модель в статусе и в пульте · model: sonnet

**Files:** Modify `lib/commands.mjs` (`statusText`), `web/index.html` (`renderTasks`, блок статуса), `web/server.mjs` (если статус отдаётся отдельно), `test/commands.test.mjs`, `test/web-server.test.mjs`.

**Interfaces:** Consumes: `task.model` (Task 1), `state.currentModel` (Task 2).

- [x] **Step 1:** Падающие тесты:
  - `statusText` при `status: 'running'`, `currentTask: 'Task 4'`, `currentModel: 'sonnet'` → строка `Текущая задача: Task 4 (sonnet)`; без модели — как сейчас;
  - `GET /api/plan` для плана с пометками → у задачи `model: 'sonnet'`, `title` без пометки.
- [x] **Step 2:** FAIL. **Step 3:** В карточке задачи пульта в строке `meta`: `3/5 шагов · sonnet` (и `· вручную`). В статусе — модель текущей задачи. **Step 4:** PASS. **Commit:** `feat: модель задачи в статусе и пульте`

### Task 5: Правила для планировщика · model: haiku

**Files:** Modify `web/planner-prompt.md`, `README.md` (раздел «Требования к плану»).

- [x] **Step 1:** Дописать в оба файла один и тот же блок «Модель на задачу»:
  - формат пометки (`### Task N: Название · model: sonnet`);
  - правило выбора: `haiku` — механика по готовым образцам и точным указаниям (данные, тексты, документация, скриншоты); `sonnet` — обычная разработка, когда план задаёт интерфейсы, тесты и значения; `opus` — сложная логика без готового решения, безопасность, ревью свежим ревьюером, исправления после ревью, всё, где ошибка дорогая;
  - пометку ставят каждой задаче, кроме `[manual]`; при сомнении — ступень выше;
  - при неудаче автопилот сам повышает модель; статистика — `node autopilot.mjs stats`.
- [x] **Step 2:** `npm test` → PASS (тексты не ломают тесты пульта). **Commit:** `docs: правила выбора модели для планов`

### Task 6: Проверка результата · model: sonnet

- [x] **Step 1:** Подставной `claude` (скрипт `test/fixtures/fake-claude.sh`, печатает аргументы и JSON-результат с `usage`, ставит галочки задачи через `sed`) + временный план из трёх задач с пометками `haiku`, `sonnet`, без пометки. Прогон `AUTOPILOT_CLAUDE=<скрипт> AUTOPILOT_CONFIG=<временный конфиг> node autopilot.mjs once` три раза. Проверить: в логе `run … (haiku, попытка 1)`, в `runs.jsonl` три строки с нужными моделями, `stats` выводит таблицу. Вывод записать в progress.
- [x] **Step 2:** Поднять пульт на временном порту с этим планом (как в `test/web-server.test.mjs`), снять скриншоты карточек задач при ширине 360 и 1366 px (playwright-core, `/usr/bin/chromium`), просмотреть: пометка модели видна в `meta`, в названии её нет, вёрстка не съехала. **Commit:** `test: проверка модели на задачу`

### Task 7: Ревью свежим ревьюером · model: opus

- [x] **Step 1:** superpowers:requesting-code-review — отдельный субагент на изменения этого плана (`git diff` от коммита до Task 1). Фокус — Review Focus выше и обратная совместимость со старыми планами и `state.json` без `currentModel`.
- [x] **Step 2:** Critical/Important — через TDD, Minor — в progress. `npm test` → PASS. **Commit:** `fix: замечания ревью`

### Task 8: [manual] Включение

Выполняет планировщик (автопилот не перезапускает сам себя):

- [x] **Step 1:** Дождаться паузы между задачами, `systemctl restart agent-autopilot agent-autopilot-web`, проверить `node autopilot.mjs status` и карточки задач в пульте.
- [x] **Step 2:** Расставить пометки моделей в незавершённых задачах очередных планов (svoydev `docs/superpowers/plans/2026-10-28-domain-seo-content.md`), обновить память (правила выбора модели).
