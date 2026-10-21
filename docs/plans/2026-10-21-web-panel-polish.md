# Пульт: доработки по отложенным замечаниям ревью — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть 8 minor-замечаний, отложенных в Task 7 плана `2026-10-21-web-panel.md` (см. журнал `2026-10-21-web-panel.progress.md`), не меняя поведение пульта для пользователя.

**Architecture:** Точечные правки в `web/chat.mjs`, `web/server.mjs`, `web/index.html`, `web/markdown.mjs`, `scripts/setup-web.sh`. Новых модулей и зависимостей нет.

**Tech Stack:** Node 22, ванильный JS, тесты `node:test`, скриншоты — `scripts/web-screenshots.mjs`.

**Spec:** договорённость в чате 2026-10-21: собрать план из отложенных minor, выполнять позже.

## Global Constraints

- Все Global Constraints плана `2026-10-21-web-panel.md` остаются в силе (127.0.0.1, без runtime-зависимостей, экранирование до Markdown, один ответ одновременно, русский интерфейс).
- Каждое исправление — сначала падающий тест (TDD), где это проверяемо.
- Служба `agent-autopilot-web` перезапускается только в финальной задаче; во время работы планировщик может быть занят — перед перезапуском проверить, что ответа в процессе нет.
- Автор коммитов — L423R.

## Review Focus

1. После любого исключения в `send()` пульт снова принимает сообщения без перезапуска.
2. «Стоп» и завершение процесса не убивают чужой процесс по повторно выданному pid; готовый ответ не теряется.
3. `/api/history` и `/api/command` не вводят пользователя в заблуждение и не отдают десятки мегабайт.
4. `setup-web.sh` при ошибке оставляет Caddyfile в исходном виде.

### Task 1: Надёжность чата (`web/chat.mjs`)

**Files:** Modify `web/chat.mjs`, тесты рядом с существующими тестами чата

- [ ] **Step 1:** Исключение в `send()` (нет `planner-prompt.md`, ошибка записи истории) снимает флаг занятости — `try/finally`; тест: удалить prompt-файл → ошибка в ответе, следующее сообщение не получает 409.
- [ ] **Step 2:** Таймер SIGKILL после «Стоп» снимается при завершении процесса; тест с поддельным Claude: после выхода процесса таймер не срабатывает.
- [ ] **Step 3:** «Стоп», пришедший, когда процесс уже завершился с готовым ответом, не выбрасывает ответ — ответ пишется в историю; тест.
- [ ] **Step 4:** При старте сервера, если в истории последняя запись — `user` без ответа, а процесса нет, добавить запись `error` «Ответ прерван перезапуском»; тест.
- [ ] **Step 5:** `npm test` → PASS; **Commit** — `fix(web): chat busy flag, stop timer, interrupted answers`

### Task 2: API и страница (`web/server.mjs`, `web/index.html`)

**Files:** Modify `web/server.mjs`, `web/index.html`, тесты сервера

- [ ] **Step 1:** `/api/history` отдаёт не больше ~1 МБ — самые свежие записи целиком; тест на 500 записях по 100 КБ.
- [ ] **Step 2:** `/api/command` возвращает предупреждение, если в конфиге автопилота `ntfyCommands` выключен (команду никто не исполнит); страница показывает его в итоге кнопки; тест.
- [ ] **Step 3:** Сообщение пользователя не показывается дважды при гонке SSE `busy` и ответа POST — дедупликация по `at`/тексту на странице; тест страницы или проверка в скрипте скриншотов.
- [ ] **Step 4:** `npm test` → PASS; **Commit** — `fix(web): history size limit, command warning, no duplicate message`

### Task 3: Markdown и установщик

**Files:** Modify `web/markdown.mjs`, `scripts/setup-web.sh`, тесты markdown

- [ ] **Step 1:** `` [`код`](https://…) `` рендерится как ссылка с `<code>` внутри, без NUL-заглушки в выводе; тест (плюс прежние XSS-тесты остаются зелёными).
- [ ] **Step 2:** `setup-web.sh`: при провале `caddy validate` восстановить Caddyfile из резервной копии и выйти с ошибкой; без строки `terminal` в ntfy-credentials — понятное сообщение и ненулевой код. Проверить на копии Caddyfile (живую систему не трогать).
- [ ] **Step 3:** `npm test` → PASS; **Commit** — `fix(web): markdown code in links, setup-web rollback`

### Task 4: Проверка результата

- [ ] **Step 1:** `npm test` → PASS; `node scripts/web-screenshots.mjs` → OK.
- [ ] **Step 2:** Просмотреть свежие PNG (Read): вёрстка не сломана, предупреждение `/api/command` (если видно) читаемо.
- [ ] **Step 3:** Дефекты — исправить (сначала тест), переснять; итог в журнал. **Commit** — `test(web): polish visual check`

### Task 5: Ревью кода свежим ревьюером

- [ ] **Step 1:** По superpowers:requesting-code-review запустить отдельного субагента-ревьюера (инструмент Agent, самая способная модель, указать явно) на диапазон от коммита перед Task 1 до HEAD. Передать этот план с Global Constraints и Review Focus (каждую строку проверить отдельно) и журнал прогресса.
- [ ] **Step 2:** Critical и Important — исправить через TDD. Minor — в журнал `minor (отложено): …`; несогласие — `Решение: … — почему — цена ошибки`.
- [ ] **Step 3:** `npm test` → PASS; `node scripts/web-screenshots.mjs` → OK; **Commit** — `fix(web): polish review findings`

### Task 6: Финальный артефакт — выкладка

- [ ] **Step 1:** Убедиться, что планировщик не отвечает (нет активного ответа), перезапустить `agent-autopilot-web`; `systemctl is-active` → active; `curl` к `127.0.0.1:<webPort>/api/status` → 200.
- [ ] **Step 2:** Итог в журнал: что исправлено, коммиты, что осталось отложенным. `git push`.
