# Пульт: мелкие исправления после v2 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть отложенное после пульта v2: тесты не засоряют `/tmp`, `@Имя` в любом регистре, устойчивость к неполным записям в `projects`/`active.json`, ошибки чата до запуска Claude видны в истории, правило «без шага git push» для будущих планов.

**Architecture:** Точечные правки в `test/*.test.mjs`, `lib/projects.mjs`, `web/chat.mjs`, `web/server.mjs`, `web/planner-prompt.md`, `README.md`. Новых модулей и зависимостей нет.

**Tech Stack:** Node 22, `node:test`.

**Spec:** договорённость в чате 2026-10-21 + строки `minor (отложено)` Task 12 в `docs/plans/2026-10-21-pult-v2.progress.md`. Пер-проектные настройки (`iterationTimeoutMinutes`, `pushAfterTask`) не нужны: у sigaret они совпадают с общими.

## Global Constraints

- Все Global Constraints `docs/plans/2026-10-21-pult-v2.md` в силе. Службы `agent-autopilot` и `agent-autopilot-web` в Task 1–4 не перезапускать.
- `git push` в задачах не делать — автопилот пушит сам после каждой задачи (`pushAfterTask`).
- TDD: сначала падающий тест. Журнал — `docs/plans/2026-10-21-pult-fixes.progress.md`. Автор коммитов — L423R.

## Review Focus

1. После `npm test` (в т.ч. упавшего) в `/tmp` не остаётся новых каталогов тестов.
2. Одна битая запись в `projects` (нет `plansDir`, несуществующая папка) не ломает вкладку «План» для остальных проектов.
3. `@SIGARET`, `@Sigaret`, `@sigaret` дают один и тот же блок; `a@Sigaret.ru` — нет.

---

### Task 1: Тесты убирают за собой временные каталоги

**Files:** Modify все `test/*.test.mjs` с `mkdtempSync`

- [x] **Step 1:** Записать число `ls -d /tmp/ap-* /tmp/*-test-* 2>/dev/null | wc -l` (до), прогнать `npm test`, записать (после) — разница > 0 (воспроизведение), в журнал.
- [x] **Step 2:** В каждом файле с `mkdtempSync` — `afterEach`/`after` с `rmSync(dir, { recursive: true, force: true })` (после остановки серверов и дочерних процессов теста).
- [x] **Step 3:** `npm test` → PASS, и число каталогов после = до. В `test/cli.test.mjs` добавить сценарий со старым конфигом без `projects` во временном каталоге (а не из `config.example.json`): `status` печатает план из `planPath`.
- [x] **Step 4: Commit** — `test: clean up temp dirs; cover config without projects`

### Task 2: Упоминания и неполные записи проектов

**Files:** Modify `lib/projects.mjs`, `web/server.mjs`, `web/index.html`, `web/chat.mjs`; Test `test/projects.test.mjs`, `test/web-server.test.mjs`, `test/web-chat.test.mjs`

- [ ] **Step 1:** Падающие тесты:
  - `mentionContext: регистр не важен` — `@Sigaret` и `@SIGARET` → блок для `sigaret`; `a@Sigaret.ru` → `null`.
  - `/api/projects: битая запись` — второй проект без `plansDir` → 200, первый проект как обычно, у битого `{ name, error: 'Нет plansDir' }` (и для несуществующей папки — `error`).
  - `effectiveConfig: active.json без progressPath` → `progressPath = progressPathFor(project, planPath)` (проект ищется по `projectDir`; не найден — `planPath` с `.progress.md`).
  - `чат: ошибка до запуска Claude в истории` — нечитаемый `promptFile` → запись `{ role: 'error' }` в `/api/history`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Реализовать; страница показывает карточку битого проекта серой с текстом ошибки, без кнопок.
- [ ] **Step 4:** `npm test` → PASS. **Commit** — `fix: case-insensitive mentions, broken project entries, early chat errors`

### Task 3: Правило «без шага git push» в планах

**Files:** Modify `web/planner-prompt.md`, `README.md`

- [ ] **Step 1:** `planner-prompt.md`: «Не включай в планы шаг `git push`: автопилот пушит сам после каждой задачи (`pushAfterTask`), а исполнителю пуш запрещён — такой шаг останавливает автопилот». README, раздел требований к плану — то же одной строкой.
- [ ] **Step 2: Commit** — `docs: plans must not contain git push steps`

### Task 4: Проверка результата

- [ ] **Step 1:** `npm test` дважды подряд → PASS, число каталогов тестов в `/tmp` не растёт; `node scripts/web-screenshots.mjs` → OK, снимок вкладки «План» просмотрен (Read).
- [ ] **Step 2:** Итог в журнал. **Commit** (если были правки) — `test: fixes visual check`

### Task 5: Ревью кода свежим ревьюером

- [ ] **Step 1:** По superpowers:requesting-code-review запустить отдельного субагента-ревьюера (инструмент Agent, самая способная модель, указать явно) на диапазон от коммита перед Task 1 до HEAD; передать этот план с Global Constraints и Review Focus (каждую строку проверить отдельно) и журнал.
- [ ] **Step 2:** Critical и Important — исправить через TDD; Minor — в журнал `minor (отложено): …`; несогласие — `Решение: … — почему — цена ошибки`.
- [ ] **Step 3:** `npm test` → PASS. **Commit** — `fix: fixes review findings`

### Task 6: Финальный артефакт — выкладка пульта

- [ ] **Step 1:** `GET 127.0.0.1:7690/api/history` → `busy: false`, затем `systemctl restart agent-autopilot-web`; `systemctl is-active` → `active`; `/api/projects` → 2 проекта без `error`.
- [ ] **Step 2:** Итог в журнал: что сделано, коммиты, отложенное. Службу `agent-autopilot` не трогать — Task 7.

### Task 7: [manual] Перезапуск демона и проверка

- [ ] **Step 1:** Планировщик перезапускает `agent-autopilot` (автопилот стоит на этой ручной задаче).
- [ ] **Step 2:** С телефона: `@Sigaret` с большой буквы → планировщик сразу знает пути проекта; вкладка «План» как прежде.
