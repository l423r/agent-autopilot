# Модель на задачу — журнал

- 2026-10-29 09:20 Task 1: сделано — parsePlan достаёт пометку `· model: haiku|sonnet|opus` (до и после [manual]) в task.model и убирает из названия; 2 новых теста, npm test 228/228
- 2026-10-29 09:25 Task 2: сделано — lib/models.mjs (modelFor с лестницей haiku→sonnet→opus, validateModelConfig), --model в runIteration, currentModel в markRunning, step() считает попытку до markRunning и пишет «run Task N (модель, попытка K)», модель в уведомлении «готова»; npm test 242/242
- 2026-10-29 09:30 Task 3: сделано — usageOf в classify, lib/runs.mjs (appendRun, summarizeRuns, statsText), запись logs/runs.jsonl после каждого запуска в step() (вкл. неудачные, tokens/costUsd null без JSON), команда stats [--plan], README; npm test 248/248
- 2026-10-29 12:52 Task 3: сделано — код из c854ccf проверен (RED на 4c271b1: нет usageOf; npm test 248/248), галочки Task 3 поставлены, из плана убран дубль строк 15–69, ошибочно вставленный в c854ccf
- 2026-10-29 12:54 Task 4: сделано — statusText пишет «Текущая задача: Task 4 (sonnet)» по state.currentModel (он же идёт в блок статуса пульта через /api/status), в карточке задачи meta «3/5 шагов · sonnet · вручную»; тест /api/plan прошёл сразу (сервер уже отдаёт task.model из Task 1) — оставлен как регрессионный; npm test 250/250
