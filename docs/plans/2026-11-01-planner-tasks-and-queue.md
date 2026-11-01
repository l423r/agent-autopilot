# Задачи планировщика без человека и очередь планов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автопилот больше не стоит, пока планировщику не напишут в чат.
- Задачи `[planner]` (выкладка, правка конфига, проверка на живом сервере) автопилот выполняет сам: отдельный запуск Claude с ролью планировщика.
- Очередь планов: когда план закончен **или** ждёт пользователя (`[manual]`), автопилот сам берёт следующий план из очереди. К ожидающему плану он возвращается, как только пользователь отметит свою задачу.
- В пульте и уведомлениях видно, что ждёт пользователя по всем планам.

**Architecture:**
- **`lib/plan.mjs`** — новая пометка `[planner]`, поле `task.kind: 'auto'|'planner'|'user'` (`[manual]` = `user`).
- **`lib/decide.mjs`** — `planner` запускается как обычная задача, но с другим промптом (`planner-task-prompt.md`): роль планировщика, право запускать то, что перечислено в шаге задачи, обязательная проверка и откат при сбое. `user` → `waiting-user`, как сейчас.
- **`lib/queue.mjs`** — очередь `<stateDir>/queue.json`: `[{ projectDir, planPath, progressPath, addedAt }]` и выбор следующего плана.
- **`autopilot.mjs`**:
  - при `done` или `waiting-user` вызывает `pickNext`;
  - раз в минуту перечитывает ожидающие планы — пользователь мог отметить галочку;
  - `switch.json` ставит план первым и переключает сразу между задачами, как сейчас.
- **Пульт** — блоки «Очередь» и «Ждёт вас».
- **CLI** — `autopilot.mjs queue list|add <projectDir> <planPath>|remove <n>|up <n>`.

**Tech Stack:** Node 22, `node:test`, ванильный JS.

**Spec:** чат 2026-11-01. Пользователь: «автопилот часто останавливается на выкладке… можно ли это автоматизировать? И чтобы, если что-то ждёт меня, а есть активный план, где можно продолжить автопилотом или через тебя, он автоматически продолжал… ты говорил, что автопилот автоматически переключится, но он не переключается». Причина: `switch.json` — одно место, очереди нет. Ручная задача останавливает всё, даже если её мог сделать планировщик.

## Global Constraints

- **Совместимость.** Старые планы без `[planner]` работают как раньше. Нет `queue.json` → поведение прежнее. Формат `switch.json`, `active.json`, `state.json` расширяется, но не ломается: новые поля необязательны.
- **`[planner]`-задача:**
  - промпт = `web/planner-prompt.md` (роль) + `planner-task-prompt.md` (правила);
  - правила:
    - выполнить **только** шаги этой задачи;
    - каждое изменение на сервере — с проверкой из шага;
    - при сбое — откат, описанный в шаге (`--rollback`, резервная копия);
    - отметить галочки, строка в журнал проекта, коммит;
    - **не** трогать то, чего нет в шаге;
    - если шаг требует решения человека или данных, которых нет, — не выдумывать, а записать в журнал «НУЖЕН ЧЕЛОВЕК: …» и выйти без галочки.
  - Повторная неудача → эскалация модели как у обычных задач (по умолчанию `opus`). После `maxAttempts` → `halted` с причиной, как сейчас.
  - Автопилот не перезапускает **сам себя**: шаги с `systemctl restart agent-autopilot` в `[planner]` запрещены. Задача с таким шагом валидируется при разборе плана как `user` с предупреждением в логе.
- **Очередь:**
  - **Порядок выбора:** первый план очереди, у которого следующая задача — не `user` и который не завершён. Если таких нет — `waiting-user` со списком «Ждёт вас», или `done`, если всё завершено.
  - Текущий план, вставший на `user`, остаётся в очереди на своём месте с отметкой `waitingUser: { task, since }`.
  - Завершённый план удаляется из очереди, событие в лог и уведомление «План выполнен: …».
  - **Перепроверка** ожидающих планов — раз в 60 с, и сразу по `resume`. Как только у ожидающего плана, стоящего в очереди **раньше** текущего, следующая задача стала не-`user`, переключение происходит **между задачами** текущего плана. Так «приоритетный» план продолжает первым.
  - `switch.json` = «поставить план первым и переключить».
  - Запись `queue.json` — атомарно (tmp + rename). Битый файл → лог и поведение «без очереди», без падения.
- **Уведомления (ntfy):**
  - «Ждёт вас: <проект> / <план> — Task N: <название>» — один раз на задачу;
  - «Переключено на <план> (тот ждёт вас)».
- **Пульт:**
  - блок «Очередь» — список с прогрессом, кнопки «вверх» и «убрать»;
  - блок «Ждёт вас» — все `user`-задачи по планам очереди, с текстом шага.
  - Кнопка «Запустить» во вкладке «План» ставит план первым (как сейчас `switch.json`).
- `git push` в задачах не делать. Службу `agent-autopilot` не перезапускать (Task 9 — человек). Журнал — `docs/plans/2026-11-01-planner-tasks-and-queue.progress.md`. Автор коммитов — L423R.

## Review Focus

1. Два плана ждут пользователя, третий завершён → статус `waiting-user` с обоими в «Ждёт вас», без цикла переключений и без 100% CPU.
2. Пользователь отметил галочку ожидающего плана, стоящего выше текущего, во время выполнения задачи текущего → текущая задача доходит до конца, затем переключение. Состояние попыток текущего плана сохраняется для возврата.
3. `[planner]`-задача, которая не смогла выложить (сбой в шаге) → откат по шагу, `НУЖЕН ЧЕЛОВЕК` или ошибка → после `maxAttempts` `halted`. Галочка не ставится при неудачной проверке.
4. `queue.json` удалён или испорчен руками во время работы → автопилот продолжает текущий план и пишет в лог; `switch.json`, пришедший одновременно с изменением очереди, не теряется.
5. План из очереди удалён с диска → пропускается с уведомлением, а не ломает выбор.

---

### Task 1: Пометка `[planner]` и виды задач · model: sonnet

**Files:** Modify `lib/plan.mjs`; Test `test/plan.test.mjs`

**Interfaces:** Produces: у задачи `kind: 'auto'|'planner'|'user'` (`manual` остаётся — `true` для `user`, для совместимости); `title` без пометок; `warnings[]` у плана (например, `[planner]` с `restart agent-autopilot` → `kind: 'user'`).

- [ ] **Step 1:** Тесты:
  - `### Task 9: [planner] Выкладка · model: opus` → `kind: 'planner'`, `model: 'opus'`;
  - `[manual]` → `user`;
  - без пометки → `auto`;
  - порядок пометок любой;
  - `[planner]` со строкой `systemctl restart agent-autopilot` в шагах → `user` и предупреждение.

  `npm test` → FAIL.
- [ ] **Step 2:** Реализовать. `npm test` → PASS. **Commit** — `feat(plan): [planner] task kind`

### Task 2: Запуск `[planner]`-задач · model: opus

**Files:** Create `planner-task-prompt.md`; Modify `lib/decide.mjs`, `autopilot.mjs` (выбор промпта, модель по умолчанию `opus` для `planner`), `README.md`; Test `test/decide.test.mjs`, `test/cli.test.mjs` (на `fake-claude.sh`)

- [ ] **Step 1:** Тесты:
  - `decide` для `planner` → `run`;
  - `cli`: `[planner]`-задача запускается с промптом, содержащим текст роли планировщика и правила из Global Constraints;
  - модель без пометки — `opus`;
  - fake-claude, вернувший «НУЖЕН ЧЕЛОВЕК», без галочки → попытка не удалась, после `maxAttempts` `halted` с причиной из журнала.

  `npm test` → FAIL.
- [ ] **Step 2:** Реализовать. `planner-task-prompt.md` — правила из Global Constraints дословно по смыслу, коротко. `npm test` → PASS. **Commit** — `feat: run [planner] tasks automatically`

### Task 3: Очередь — данные и выбор · model: opus

**Files:** Create `lib/queue.mjs`; Test `test/queue.test.mjs`

**Interfaces:** Produces:
- `loadQueue(stateDir)` → `{ items, error? }`;
- `saveQueue(stateDir, items)`;
- `enqueue(items, target, { front })`, `removeAt`, `moveUp`;
- `pickNext(items, { readPlan })` → `{ target, waiting: [{ target, task }], doneTargets: [] }` по Global Constraints;
- `shouldPreempt(items, current, { readPlan })` → `target|null` — план выше текущего, который снова можно продолжать.

- [ ] **Step 1:** Тесты:
  - все варианты выбора;
  - Review Focus 1, 4 (битый файл), 5 (нет файла плана);
  - `shouldPreempt` только для планов **выше** текущего;
  - атомарная запись.

  `npm test` → FAIL.
- [ ] **Step 2:** Реализовать (`readPlan` подменяется в тестах). `npm test` → PASS. **Commit** — `feat: plan queue`

### Task 4: Очередь в демоне · model: opus

**Files:** Modify `autopilot.mjs`, `lib/projects.mjs` (`switch.json` → поставить первым в очередь), `lib/notify.mjs`; Test `test/cli.test.mjs`

- [ ] **Step 1:** Сквозные тесты на `fake-claude.sh` и трёх временных планах:
  - A с `user`-задачей в середине, B обычный, C завершён;
  - старт → A до `user` → переключение на B → C удалён из очереди («План выполнен») → по отметке галочки в A (запись файла) A продолжается после текущей задачи B (Review Focus 2) → всё сделано → `done`;
  - уведомления «Ждёт вас» по одному разу;
  - `switch.json` во время работы — план первым;
  - без `queue.json` — поведение как раньше (существующие тесты зелёные).

  `npm test` → FAIL.
- [ ] **Step 2:** Реализовать:
  - `waitUntil` будит раз в 60 с для перепроверки ожидающих (без лишних чтений, если `queue.json` нет);
  - `state.json` хранит попытки по плану: `attemptsByPlan[planKey]`, чтобы возврат к плану не сбрасывал счётчики.

  `npm test` → PASS. **Commit** — `feat: daemon follows the plan queue`

### Task 5: CLI и статус · model: sonnet

**Files:** Modify `autopilot.mjs` (`queue list|add|remove|up`, `status` показывает очередь и «Ждёт вас»), `README.md`; Test `test/cli.test.mjs`

- [ ] **Step 1:** Тесты:
  - `queue add` с несуществующим планом → ошибка;
  - `list` — номера, проект, план, прогресс, отметка «ждёт вас: Task N»;
  - `up` и `remove` по номеру;
  - `status` — блоки «Очередь» и «Ждёт вас».

  `npm test` → FAIL.
- [ ] **Step 2:** Реализовать. `npm test` → PASS. **Commit** — `feat(cli): queue commands`

### Task 6: Пульт — «Очередь» и «Ждёт вас» · model: sonnet

**Files:** Modify `web/server.mjs` (`GET /api/queue`, `POST /api/queue/up|remove`, «Запустить» ставит первым), `web/index.html`, `scripts/web-screenshots.mjs`; Test `test/web-server.test.mjs`

- [ ] **Step 1:** Тесты API: формат ответа, `up` и `remove`, CSRF и авторизация, как у остальных POST. `npm test` → FAIL.
- [ ] **Step 2:** Реализовать:
  - блок «Ждёт вас» вверху вкладки «Статус» (только если есть), у каждой задачи текст шага;
  - блок «Очередь» во вкладке «План»;
  - снимки `web-queue.png` и `web-waiting.png` просмотрены (Read).

  `npm test` → PASS. **Commit** — `feat(web): queue and waiting-for-you`

### Task 7: Правила для планировщика · model: haiku

**Files:** Modify `web/planner-prompt.md`, `README.md` («Требования к плану»)

- [ ] **Step 1:** Добавить:
  - **`[planner]`** — всё, что раньше делал планировщик: выкладка тестированным скриптом с откатом, конфиг из уже известных данных, Bot API, проверки на живом сервере;
  - **`[manual]`** — только то, что требует человека: решения, покупки, аккаунты, проверка с телефона;
  - у каждой задачи — хотя бы одна галочка;
  - новый план добавлять в очередь (`autopilot.mjs queue add`), «срочно» — кнопкой «Запустить» или `switch.json`;
  - не обещать «переключится сам», если план не в очереди.

  `npm test` → PASS. **Commit** — `docs: planner rules for [planner] tasks and queue`

### Task 8: Проверка результата и ревью · model: opus

- [ ] **Step 1:** `npm test` → PASS; `node scripts/web-screenshots.mjs` → OK, снимки просмотрены. Ручной прогон на временном `stateDir` с тремя планами из Task 4 через настоящий `autopilot.mjs run` и `fake-claude.sh` — лог событий в журнал.
- [ ] **Step 2:** По superpowers:requesting-code-review запустить отдельного субагента-ревьюера (инструмент Agent, самая способная модель, указать явно) на диапазон от коммита перед Task 1 до HEAD с этим планом, Global Constraints и Review Focus (каждую строку проверить отдельно). Critical и Important — исправить через TDD; Minor — в журнал. **Commit** — `fix: queue review findings`

### Task 9: [manual] Включение

- [ ] **Step 1:** Планировщик (автопилот не перезапускает сам себя):
  - дождаться паузы между задачами, `systemctl restart agent-autopilot agent-autopilot-web`, `status`;
  - собрать очередь:
    1. svoydev `docs/superpowers/plans/2026-11-01-zhk-polish.md`;
    2. svoydev `docs/superpowers/plans/2026-10-31-drafts-generator.md`;
    3. svoydev `docs/superpowers/plans/2026-10-28-domain-seo-content.md` (стоит на покупке домена — `user`);
  - в этих планах ручные задачи выкладки переименовать в `[planner]`.
- [ ] **Step 2:** Обновить память планировщика (правила `[planner]` и очередь), проверить в пульте блоки «Очередь» и «Ждёт вас».
