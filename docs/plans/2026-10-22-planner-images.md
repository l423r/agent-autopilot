# Картинки от планировщика в чате пульта — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Планировщик может показать пользователю картинку прямо в чате (превью иконок, скриншоты): она видна в ответе миниатюрой и открывается тапом. Пользователь может вставить картинку в поле ввода из буфера обмена (Ctrl+V).

**Architecture:** Планировщик публикует файл скриптом `web/share-image.mjs` — тот копирует его в `<stateDir>/web/uploads/<uuid>.<ext>` (уже раздаётся пультом по `GET /uploads/<id>`) и печатает Markdown-строку `![подпись](uploads/<id>)`. `web/markdown.mjs` превращает такие строки (и ссылки `[текст](uploads/<id>)`) в `<img>`/`<a>`; любые другие адреса картинок остаются текстом.

**Tech Stack:** Node 22, `node:test`, ванильный JS.

**Spec:** чат 2026-10-22: превью иконок, отправленное планировщиком ссылкой `uploads/…`, на телефоне не открылось — пульт делает ссылками только `https://`.

## Global Constraints

- Все Global Constraints `docs/plans/2026-10-21-pult-v2.md` в силе; экранирование HTML до Markdown сохраняется.
- Картинка/ссылка допускается только для пути, полностью совпадающего с `^uploads/[0-9a-f-]{36}\.(jpg|png|webp|gif)$`; внешние адреса картинок не рендерятся (никаких запросов на чужие сервера из пульта).
- `git push` в задачах не делать — автопилот пушит сам. Службу `agent-autopilot` не перезапускать (демон не меняется). Журнал — `docs/plans/2026-10-22-planner-images.progress.md`. Автор коммитов — L423R.

## Review Focus

1. `![x](javascript:alert(1))`, `![x](https://evil/x.png)`, `![x](uploads/../state.json)`, `![" onerror="x](uploads/<id>.png)` — ничего не исполняется и не грузится извне.
2. Большая картинка (2000 px) не даёт горизонтальной прокрутки в чате.
3. Картинка, удалённая очисткой загрузок (лимит 200 файлов / «Новый разговор»), — в старом ответе аккуратная заглушка, а не сломанная вёрстка.

---

### Task 1: Картинки и ссылки на загрузки в Markdown

**Files:** Modify `web/markdown.mjs`; Test `test/web-markdown.test.mjs`

- [x] **Step 1:** Падающие тесты:
  - `![Превью](uploads/<uuid>.png)` → `<a href="uploads/<uuid>.png" target="_blank" rel="noopener"><img src="uploads/<uuid>.png" alt="Превью" loading="lazy"></a>`;
  - `[превью](uploads/<uuid>.png)` → `<a href="uploads/<uuid>.png" …>превью</a>`;
  - каждый ввод из Review Focus 1 → без `<img`, без `href="javascript`, без внешнего `src`; кавычки в подписи экранированы.
- [x] **Step 2:** `npm test` → FAIL; **Step 3:** реализовать (тот же механизм `hold/release`, что для `https`-ссылок).
- [x] **Step 4:** `npm test` → PASS. **Commit** — `feat(web): images from uploads in markdown`

### Task 2: Скрипт публикации и правило для планировщика

**Files:** Create `web/share-image.mjs`; Modify `web/planner-prompt.md`, `README.md`; Test `test/web-share-image.test.mjs`

- [x] **Step 1:** Падающий тест: `node web/share-image.mjs <png> "Подпись"` с `AUTOPILOT_CONFIG` на временный конфиг → файл появился в `<stateDir>/web/uploads/` с именем `<uuid>.png` и теми же байтами; stdout — ровно `![Подпись](uploads/<uuid>.png)`; не-картинка (по расширению `jpg|jpeg|png|webp|gif`) или файл > 8 МБ → код 1 и сообщение. Применяется тот же предел «последние 200 файлов», что у `/api/upload` (вынести общую функцию из `web/server.mjs`, если нужно).
- [x] **Step 2:** `npm test` → FAIL; **Step 3:** реализовать.
- [x] **Step 4:** `planner-prompt.md`: «Чтобы показать пользователю картинку (превью, скриншот), выполни `node /root/agent-autopilot/web/share-image.mjs <путь> "<подпись>"` и вставь напечатанную строку в ответ как есть». README — одна строка о том же.
- [x] **Step 5:** `npm test` → PASS. **Commit** — `feat(web): share-image script for the planner`

### Task 3: Вид на странице

**Files:** Modify `web/index.html`, `scripts/web-screenshots.mjs`

- [x] **Step 1:** Стили: картинка в ответе — `max-width: 100%`, высота до 60vh, скругление как у миниатюр пользователя; `onerror` не используется — сломанная картинка заменяется заглушкой «Картинка удалена» через обработчик события `error`, навешанный JS после рендера.
- [x] **Step 2:** Скрипт скриншотов: поддельный Claude отвечает строкой с картинкой 2000×1200 из загрузок и строкой с удалённой картинкой → снимок `web-planner-image.png`; проверки скрипта (нет горизонтальной прокрутки и т. д.) проходят.
- [x] **Step 3:** Просмотреть снимок (Read). **Commit** — `feat(web): planner images on the page`

### Task 4: Вставка картинки из буфера обмена (Ctrl+V)

**Files:** Modify `web/index.html`, `scripts/web-screenshots.mjs`, `README.md`

- [x] **Step 1:** Проверка в `scripts/web-screenshots.mjs` (Playwright), сейчас падает: фокус в поле ввода, событие `paste` с `DataTransfer`, в котором PNG-файл и текст → в поле ввода текст **не** вставлен дважды, появилась миниатюра, ушёл `POST api/upload`, кнопка отправки активна после загрузки; `paste` только с текстом → обычная вставка текста, миниатюр нет; вставка 5 картинок при лимите `MAX_IMAGES` → сообщение «Можно до N картинок в сообщении.», лишние не добавлены.
- [x] **Step 2:** Вынести из обработчика `#file-input` общую `addFiles(files)` (фильтр `image/*`, лимит `MAX_IMAGES`, `addImage`); обработчик `paste` на поле ввода: картинки из `clipboardData.files` (или `items` с `kind === 'file'`) → `addFiles`, `preventDefault()` только если картинки были. Не-картинки из буфера игнорируются (сервер принимает только jpg/png/webp/gif). Подсказка в `placeholder`/`title` поля на компьютере: «…или вставьте картинку (Ctrl+V)». README — одна строка.
- [x] **Step 3:** `node scripts/web-screenshots.mjs` → OK; `npm test` → PASS. **Commit** — `feat(web): paste images from clipboard`

### Task 5: Проверка результата

- [x] **Step 1:** `npm test` → PASS; `node scripts/web-screenshots.mjs` → OK; все снимки просмотрены (Read), регрессий v2 нет. Итог в журнал.

### Task 6: Ревью кода свежим ревьюером

- [x] **Step 1:** По superpowers:requesting-code-review запустить отдельного субагента-ревьюера (инструмент Agent, самая способная модель, указать явно) на диапазон от коммита перед Task 1 до HEAD; передать этот план с Global Constraints и Review Focus (каждую строку проверить отдельно) и журнал.
- [x] **Step 2:** Critical и Important — исправить через TDD; Minor — в журнал `minor (отложено): …`. `npm test` → PASS. **Commit** — `fix(web): planner images review findings`

### Task 7: Финальный артефакт — выкладка пульта

- [x] **Step 1:** `GET 127.0.0.1:7690/api/history` → `busy: false`, затем `systemctl restart agent-autopilot-web`; `is-active` → `active`. Итог в журнал.

### Task 8: [manual] Проверка с телефона и компьютера

- [x] **Step 1:** Планировщик публикует `/root/sigaret-counter/assets/icon-src/preview.png` скриптом и вставляет в ответ; пользователь видит превью в чате и открывает его тапом.
- [x] **Step 2:** Пользователь на компьютере копирует скриншот и вставляет его в поле чата Ctrl+V → миниатюра появилась, сообщение с картинкой отправляется, планировщик её видит.
