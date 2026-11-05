# Журнал: Ручные задачи в пульте (docs/plans/2026-11-05-manual-tasks-ui.md)

- 2026-11-05 13:58 CET Task 1: сделано — tickStep(markdown, taskId, step) в lib/plan.mjs (общий проход с parsePlan, только [ ]→[x], CRLF/вложенные/fenced учтены), тесты test/tick.test.mjs; npm test 371/371
- 2026-11-05 14:04 CET Task 2: сделано — POST /api/tick в web/server.mjs (findPlan, tickStep, запись через tmp+rename, очередь на файл плана, git commit -- planPath; без git — commit:false + console.error), 5 тестов в test/web-server.test.mjs; npm test 376/376. Решения: no-task → 404, not-manual/no-step/нестроковая задача → 400, already → 409; «лог демона» = stderr сервиса пульта (journald agent-autopilot-web)
