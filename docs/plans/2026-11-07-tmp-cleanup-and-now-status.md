# Автоочистка временных файлов и понятный статус «Сейчас» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
1. Временные файлы задач больше не забивают память сервера. 2026-11-07 `/tmp` (tmpfs, лежит в ОЗУ) был заполнен на 95% остатками тестов, и OOM трижды убил задачу.
2. Пульт одной фразой отвечает, работает ли автопилот, над чем именно и почему стоит. Сейчас это непонятно из-за очереди: «Статус: running», рядом список «ждёт вас», а текущий план назван именем файла.

**Architecture:**
- **Очистка:**
  - у каждого запуска исполнителя свой `TMPDIR` на диске, `/var/tmp/autopilot/<run>`. Его удаляют после запуска, тесты проектов (`os.tmpdir()`) пишут туда;
  - перед каждой задачей — проверка `/tmp`: если занято больше 70%, удаляются записи верхнего уровня старше 12 ч, кроме исключений;
  - системное правило `systemd-tmpfiles` чистит `/tmp` от записей старше 1 дня.
- **Статус:**
  - демон пишет в `state.json` сердцебиение (`heartbeatAt`) и описание текущего запуска (`run`);
  - чистая функция `nowView()` превращает состояние, очередь и время в одну фразу с деталями;
  - пульт показывает её блоком «Сейчас» вверху вкладки «Статус» и коротко в шапке; `status` в CLI начинается с неё же.

**Tech Stack:** Node 22, `node:test`, systemd-tmpfiles.

**Spec:** просьба пользователя 2026-11-07: «нужно добивать автоочистку и нужно ещё более понятное описание, над чем агент работает и работает ли вообще, сейчас это особо непонятно из-за очереди». Тексты и правила ниже — решения планировщика.

## Global Constraints

- **Очистка `/tmp`, исключения** (никогда не трогать): `systemd-private-*`, `.X*`, `.ICE*`, `tmux-*`, `claude-*`, `org.chromium.*`, сокеты, а также всё, что моложе 12 ч. Порог — 70% занятости `/tmp` (`statfs`). Каждое удаление — строка в лог демона: `очистка /tmp: удалено N записей, освобождено X МБ`.
- **`TMPDIR` запуска:** `/var/tmp/autopilot/<stamp>-<taskId>`, создаётся перед запуском, передаётся в `env` и Claude, и Codex, удаляется после завершения (в любом исходе, включая таймаут и убийство группы). Остатки старше 1 дня в `/var/tmp/autopilot/` демон удаляет при старте.
- **`state.json`, новые поля** (старые поля и их смысл не меняются):
  - `heartbeatAt` — ISO-время, демон обновляет на каждом цикле (не реже раза в минуту), в том числе в `waiting-user`/`halted`/`sleeping`;
  - `run`: `{ project, planPath, planTitle, taskId, taskTitle, done, total, executor, model, attempt, maxAttempts, startedAt, lastOutputAt }` — пока идёт запуск, иначе `null`. `lastOutputAt` обновляется не чаще раза в 15 с.
- **Название плана:** первая строка `# …` без хвоста « — план реализации». Нет заголовка — имя файла без `.md`. Это название используется везде в пульте вместо имени файла (очередь, карточки, «Ждёт вас»); имя файла остаётся во всплывающей подсказке.
- **`nowView({ state, queue, now })` → `{ kind, title, details: string[], action: 'resume' | null }`, тексты дословно:**

  | kind | Условие | title | details |
  |------|---------|-------|---------|
  | `down` | `heartbeatAt` старше 3 мин или нет | `Автопилот не отвечает с <ЧЧ:ММ>` | `Служба остановлена или зависла. Напиши планировщику «проверь автопилот».` |
  | `working` | `status: running` и `run` | `Работает: <project> — «<planTitle>»` | `<taskId> из <total>: <taskTitle>`; `<Codex\|Claude> <model> · попытка <attempt> из <maxAttempts> · идёт <N мин>`; `Последний вывод <N с\|N мин> назад` |
  | `working` + предупреждение | то же, `lastOutputAt` старше 10 мин | то же | плюс `⚠ Давно нет вывода — возможно, задача зависла` |
  | `limit` | `status: sleeping` | `Ждёт лимит до <ЧЧ:ММ>, дальше продолжит сам` | `Следующая: <project> — <taskId>: <taskTitle>` |
  | `user` | `status: waiting-user` | `Ничего не делает: все планы в очереди ждут тебя (<N>)` | по строке на ожидание: `<project> — «<planTitle>», <taskId>: <taskTitle>` |
  | `stuck` | `status: halted` | `Остановился: <reason>` | `Задача <taskId> в «<planTitle>»`; action `resume` |
  | `paused` | `status: paused` | `На паузе` | `Продолжит после кнопки «Продолжить»`; action `resume` |
  | `idle` | `done`/`idle` и очередь пуста | `Ничего не делает: очередь пуста` | — |
  | `auth` | `status: auth` | `Нужен вход в учётку` | `reason` |

  Время — местное время сервера `ЧЧ:ММ`; если дата не сегодня — `7 нояб., ЧЧ:ММ`.
- **Пульт:**
  - блок «Сейчас» — первым во вкладке «Статус»: иконка по `kind` (▶ работает, ⏳ лимит, 🙋 ждёт тебя, ⛔ остановился, ⏸ пауза, 💤 очередь пуста, ❗ не отвечает), `title` крупно, `details` строками, кнопка «Продолжить» при `action: 'resume'` (команда `resume`, как в канале команд);
  - ниже — «Дальше по очереди» (планы, которые не ждут тебя) и «Ждут тебя» (как сейчас);
  - шапка: точка цвета `kind` и короткий текст — `работает · <project> <taskId>`, `ждёт лимит до ЧЧ:ММ`, `ждёт тебя (N)`, `остановился`, `пауза`, `не отвечает`, `очередь пуста`;
  - обновление — каждые 15 с, пока вкладка видима.
- `node autopilot.mjs status` — первые строки: `title` и `details` из `nowView`, дальше как сейчас.
- Не перезапускать службы `agent-autopilot` и `agent-autopilot-web` в обычных задачах (исполнитель работает внутри демона); перезапуск — только Tasks 6 и 9. `git push` в задачах не делать. Журнал — `docs/plans/2026-11-07-tmp-cleanup-and-now-status.progress.md`. Автор коммитов — L423R.

## Review Focus

1. Задача падает по таймауту или её группа убита сигналом → её `TMPDIR` всё равно удалён, `run` в `state.json` сброшен в `null`, `nowView` не показывает «Работает» по устаревшему `run`.
2. Очистка `/tmp` не удаляет то, чем пользуется живой процесс: сокеты, профиль Chromium, каталог Claude, запись моложе 12 ч. Ошибка доступа к одной записи не прерывает очистку и задачу.
3. Демон жив, но давно в `waiting-user` → `heartbeatAt` свежий, `nowView` — `user`, а не `down`. Демон убит OOM → через 3 мин пульт пишет «не отвечает».
4. Старый `state.json` без новых полей (сразу после обновления) → пульт и `status` не падают, `nowView` даёт осмысленную фразу (`down` до первого сердцебиения допустим).
5. Узкий экран 360 px: длинное название плана и задачи переносится, блок «Сейчас» не вылезает за край; шапка обрезает текст многоточием.

---

### Task 1: Свой TMPDIR на запуск и очистка /tmp · model: sonnet

**Files:** Create `lib/tmpclean.mjs`; Modify `lib/runner.mjs`, `autopilot.mjs`; Test `test/tmpclean.test.mjs`, `test/runner.test.mjs`.

**Interfaces:** Produces:
- `cleanTmp({ dir = '/tmp', threshold = .7, minAgeMs = 12 * 3600e3, now, statfs, log })` → `{ removed, freedBytes, skipped }`. `statfs` и `dir` подставляются в тестах;
- `runTmpDir(base, stamp, taskId)` → путь;
- `removeStale(base, maxAgeMs)`.

- [x] **Step 1:** Тесты (FAIL):
  - во временном каталоге-фикстуре с поддельным `statfs` (75% занято) удаляются старые записи и не трогаются исключения из Global Constraints, свежие и сокет; при 60% не удаляется ничего;
  - запись без прав (`chmod 000` у родителя вложенной папки) → `skipped`, исключения нет (Review Focus 2);
  - runner с поддельным исполнителем (`test/fixtures`) видит `TMPDIR` внутри `/var/tmp/autopilot/` (в тесте — подменённая база). После выхода каталога нет: и при обычном выходе, и при таймауте с убийством группы (Review Focus 1).
- [x] **Step 2:** Реализовать. `cleanTmp` вызывается в демоне перед каждым запуском задачи, `removeStale` — при старте демона. `npm test` → PASS. **Commit** — `feat: per-run TMPDIR and /tmp cleanup before tasks`.

### Task 2: Сердцебиение и описание запуска в state.json · model: sonnet

**Files:** Modify `autopilot.mjs`, `lib/runner.mjs`, `lib/state.mjs`; Test `test/tick.test.mjs`, `test/state.test.mjs`.

**Interfaces:** Produces — поля `heartbeatAt` и `run` по Global Constraints; `planTitle(markdown, path)` → строка (в `lib/plan.mjs`).

- [x] **Step 1:** Тесты (FAIL):
  - каждый цикл обновляет `heartbeatAt` во всех статусах;
  - на время запуска `run` заполнен всеми полями, после — `null`, в том числе после ошибки и таймаута;
  - `lastOutputAt` двигается при выводе, но не чаще раза в 15 с;
  - `planTitle`: «# Пример X — план реализации» → «Пример X»; без заголовка → имя файла без `.md`;
  - старый `state.json` без полей читается (Review Focus 4).
- [x] **Step 2:** Реализовать, `npm test` → PASS. **Commit** — `feat: heartbeat and current run in state`.

### Task 3: nowView и status в CLI · model: opus

**Files:** Create `lib/now.mjs`; Modify `lib/commands.mjs` (`statusText`), `web/server.mjs` (`GET /api/now` → `nowView` с очередью и названиями планов); Test `test/now.test.mjs`, `test/commands.test.mjs`, `test/web-server.test.mjs`.

**Interfaces:** Consumes — Task 2. Produces — `nowView({ state, queue, now })` по таблице Global Constraints; `GET /api/now` → `{ kind, title, details, action, short }`, где `short` — текст для шапки.

- [x] **Step 1:** Тесты (FAIL): каждая строка таблицы, тексты дословно; предупреждение «Давно нет вывода» на 10 мин 1 с и его отсутствие на 9 мин 59 с; Review Focus 3 и 4; время другой даты — `7 нояб., ЧЧ:ММ`; `statusText` начинается с `title`.
- [x] **Step 2:** Реализовать, `npm test` → PASS. **Commit** — `feat: one-line "now" status for panel and CLI`.

### Task 4: Блок «Сейчас», очередь и шапка в пульте · model: sonnet

**Files:** Modify `web/index.html`; Test `test/web-server.test.mjs` (разметка), снимки через Playwright.

- [ ] **Step 1:** Тест (FAIL): в `index.html` есть `#now` первым в `#tab-status`, блоки «Дальше по очереди» и «Ждут тебя», шапка берёт текст из `/api/now`.
- [ ] **Step 2:** Реализовать по Global Constraints «Пульт»: названия планов вместо имён файлов во всех списках, кнопка «Продолжить», обновление раз в 15 с. `npm test` → PASS.
- [ ] **Step 3:** Снимки вкладки «Статус» на 360 и 390 px для `working`, `user`, `stuck`, `down` (подставные ответы `/api/now` и `/api/queue` через `page.route`) — `docs/plans/2026-11-07-now-*.png`. Просмотреть (Read): Review Focus 5. **Commit** — `feat(pult): "now" block, queue sections, header`.

### Task 5: Проверка результата · model: sonnet

- [ ] **Step 1:** `npm test` → PASS. Вручную на копии каталога состояния:
  - `node autopilot.mjs status` при `waiting-user`, `sleeping`, `halted` — первая строка совпадает с таблицей;
  - `cleanTmp` на настоящем `/tmp` в режиме «только показать» (`dryRun: true` в вызове из `node -e`) — список кандидатов не содержит исключений.

  Итог — в журнал. **Commit** — `test: cleanup and now-status checks`.

### Task 6: [planner] Правило systemd-tmpfiles и перезапуск пульта · model: sonnet

- [ ] **Step 1:** Создать `/etc/tmpfiles.d/autopilot-tmp.conf`:
  ```
  # /tmp живёт в памяти: записи старше суток удаляются (исключения — как в lib/tmpclean.mjs)
  e /tmp - - - 1d
  x /tmp/systemd-private-*
  x /tmp/.X*
  x /tmp/tmux-*
  x /tmp/claude-*
  x /tmp/org.chromium.*
  e /var/tmp/autopilot - - - 1d
  ```
  Сначала `systemd-tmpfiles --cat-config | grep -n ' /tmp '`: если у `/tmp` уже есть строка (например, в `/usr/lib/tmpfiles.d/tmp.conf`), дубль путей systemd-tmpfiles игнорирует — тогда вместо `e /tmp` положить `/etc/tmpfiles.d/tmp.conf` (копия системного с возрастом `1d`; одноимённый файл в `/etc` заменяет системный), а `x`-строки и `/var/tmp/autopilot` оставить в `autopilot-tmp.conf`. Затем `systemd-tmpfiles --clean --dry-run 2>&1 | head` (если флаг не поддерживается — `systemd-tmpfiles --cat-config | grep autopilot-tmp`) — правило прочитано без ошибок. `systemctl list-timers systemd-tmpfiles-clean.timer` — таймер активен. При ошибке файл удалить.
- [ ] **Step 2:** `systemctl restart agent-autopilot-web`. Затем `curl -s localhost:<порт пульта>/api/now` → JSON с `kind`. В журнал, коммит.

### Task 7: Ревью свежим ревьюером · model: opus

- [ ] **Step 1:** Свежий ревьюер в новой сессии (отдельный субагент на самой способной модели, указать явно), диапазон — от коммита перед Task 1 до HEAD. Передать этот план; каждую строку Review Focus проверить отдельно, с попыткой воспроизвести. Снимки Task 4 — с вопросом «понятно ли с телефона за 2 секунды, работает ли автопилот и над чем». Critical и Important — исправить через TDD, Minor — в журнал. `npm test` → PASS. **Commit** — `fix: cleanup and now-status review findings`.

### Task 8: Финальный артефакт — документация · model: haiku

- [ ] **Step 1:** README: раздел «Что сейчас делает автопилот» — блок «Сейчас», его варианты из таблицы, поля `heartbeatAt`/`run`; раздел «Временные файлы» — `TMPDIR` запуска, очистка `/tmp`, правило tmpfiles. `npm test` (`docs.test.mjs`) → PASS. **Commit** — `docs: now-status and tmp cleanup`.

### Task 9: [manual] Перезапуск демона и проверка с телефона

- [ ] Планировщик в чате пульта, когда автопилот **не** в состоянии `running` (`node autopilot.mjs status`): `systemctl restart agent-autopilot`; через минуту `state.json` содержит `heartbeatAt`, `/api/now` не `down`. Итог — пользователю и в журнал; шаг отмечает планировщик.
- [ ] Ты: открыть пульт → «Статус». Всё ок, если первой строкой сразу понятно, работает ли автопилот и над чем (проект, план, задача), а в шапке видно то же коротко.
