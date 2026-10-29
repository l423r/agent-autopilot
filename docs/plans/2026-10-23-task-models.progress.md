# Модель на задачу — журнал

- 2026-10-29 09:20 Task 1: сделано — parsePlan достаёт пометку `· model: haiku|sonnet|opus` (до и после [manual]) в task.model и убирает из названия; 2 новых теста, npm test 228/228
- 2026-10-29 09:25 Task 2: сделано — lib/models.mjs (modelFor с лестницей haiku→sonnet→opus, validateModelConfig), --model в runIteration, currentModel в markRunning, step() считает попытку до markRunning и пишет «run Task N (модель, попытка K)», модель в уведомлении «готова»; npm test 242/242
