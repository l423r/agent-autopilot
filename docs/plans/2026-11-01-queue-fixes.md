# Очередь: продолжение после отметки ручной задачи и ложный `[planner]` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ошибки, найденные при включении очереди 2026-11-01 (третья — 2026-11-04, Task 3):
1. Когда **текущий** план стоит в `waiting-user`, а человек отметил галочки ручной задачи, демон не продолжает сам. Он ждёт `resume`, даже если план после отметки полностью выполнен. Перепроверка раз в 60 с работает только для планов очереди выше текущего.
2. Заголовок `### Task 1: Пометка \`[planner]\` и виды задач` распознаётся как `[planner]`-задача: пометка внутри обратных кавычек. Если в её шагах есть `restart agent-autopilot`, в лог пишется ложное предупреждение и задача становится `[manual]`.

**Architecture:** `autopilot.mjs` (перепроверка в `waiting-user`), `lib/plan.mjs` (пометки только вне `` `…` ``). Новых модулей нет.

**Tech Stack:** Node 22, `node:test`.

**Spec:** журнал `docs/plans/2026-11-01-planner-tasks-and-queue.progress.md`, Task 9; лог демона 2026-11-01T16:22:43Z.

## Global Constraints

- Поведение без `queue.json` и без `[planner]` — как раньше, все существующие тесты зелёные.
- Перепроверка `waiting-user` — раз в 60 с, тем же таймером, что очередь. Читается только файл текущего плана. Без лишних уведомлений: «Ждёт вас» по-прежнему один раз на задачу.
- `git push` в задачах не делать. Службу `agent-autopilot` не перезапускать. Журнал — `docs/plans/2026-11-01-queue-fixes.progress.md`. Автор коммитов — L423R.

## Review Focus

1. Галочки ручной задачи отмечены, а следующая задача — тоже `[manual]` → остаётся `waiting-user` с новой причиной (уведомление «Ждёт вас» про новую задачу), без цикла.
2. Отметка сделала план полностью выполненным → `done` / «План выполнен» и переход к следующему плану очереди, без `resume`.
3. `paused` и `halted` не продолжаются сами — только `waiting-user`.

---

### Task 1: Пометки только вне обратных кавычек · model: sonnet

**Files:** Modify `lib/plan.mjs`; Test `test/plan.test.mjs`

- [x] **Step 1:** Тесты:
  - `### Task 1: Пометка \`[planner]\` и виды задач · model: sonnet` → `kind: 'auto'`, `model: 'sonnet'`, `title` с обратными кавычками как есть, предупреждений нет;
  - то же для `` `[manual]` ``;
  - `### Task 2: [planner] Выкладка` → `planner`.

  `npm test` → FAIL.
- [x] **Step 2:** Реализовать: перед поиском пометок вырезать участки `` `…` `` из копии заголовка. `npm test` → PASS. **Commit** — `fix(plan): markers inside backticks are text`

### Task 2: Продолжение после отметки в текущем плане · model: opus

**Files:** Modify `autopilot.mjs`; Test `test/cli.test.mjs`

- [ ] **Step 1:** Сквозные тесты на `fake-claude.sh`:
  - план A: `[manual]` в середине → `waiting-user`; запись галочек в файл A → в пределах 60 с (подменённый таймер) следующая задача A запущена;
  - Review Focus 1, 2 (с очередью из A и B), 3.

  `npm test` → FAIL.
- [ ] **Step 2:** Реализовать: в цикле ожидания при `waiting-user` перечитать текущий план. Если следующая задача уже не `user` или план выполнен — снять `waiting-user` (как `resume`, с записью в лог «Ручная задача отмечена: Task N»). `npm test` → PASS. **Commit** — `fix: continue after a manual task is ticked`

### Task 3: Переключение очередью не наследует `halted` · model: opus

Случай 2026-11-04T11:34:21Z: afan2 дошёл до `[manual]`, очередь переключила демон на `svoydev / 2026-11-01-zhk-polish.md`, и демон сразу встал в `halted: Task 5 не удалась 3 раз подряд` — прежнее состояние этого плана (3 неудачи из-за недельного лимита 2026-11-01) вместе со счётчиком попыток `{"Task 5": 3}`. Задача не запускалась, ожидание длилось до ручного `resume`.

**Files:** Modify `autopilot.mjs` (`switchTo` / `applySwitch`); Test `test/cli.test.mjs`

- [ ] **Step 1:** Сквозной тест на `fake-claude.sh`: план B в очереди, его состояние — `halted` со счётчиком 3 на Task N; план A заканчивается `[manual]` → демон переключается на B и в пределах одного цикла запускает Task N B (попытка 1), `status` — `running`. Отдельно: ручное `switch.json` по-прежнему сбрасывает состояние. `npm test` → FAIL.
- [ ] **Step 2:** Реализовать: при переключении очередью — так же, как при `switch.json`, сбросить `status` в `idle`, счётчики попыток и `nextAttemptAt` (`paused` пользователя сохранять, как сейчас). `npm test` → PASS. **Commit** — `fix: queue switch resets halted state of the target plan`

### Task 4: Проверка и ревью · model: opus

- [ ] **Step 1:** `npm test` → PASS. Ручной прогон на временном `stateDir`: план с `[manual]`, отметка галочки руками → продолжение без `resume`. Лог — в журнал.
- [ ] **Step 2:** По superpowers:requesting-code-review запустить отдельного субагента-ревьюера (инструмент Agent, самая способная модель, указать явно) на диапазон от коммита перед Task 1 до HEAD с этим планом и Review Focus. Critical и Important — исправить через TDD; Minor — в журнал. **Commit** — `fix: queue fixes review findings`

### Task 5: [manual] Включение

- [ ] **Step 1:** Планировщик: дождаться паузы между задачами, `systemctl restart agent-autopilot`, в логе нет ложного предупреждения про Task 1 плана очереди; проверить `status`.
