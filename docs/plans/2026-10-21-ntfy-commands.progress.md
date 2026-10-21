# Журнал прогресса: управление с телефона
- 2026-10-21 11:00 Task 1: сделано — lib/commands.mjs (parseCommand, applyCommand, statusText) + 11 тестов, npm test 81/81; Spec — договорённость в чате (файла нет), «продолжить» при sleeping снимает ожидание, но счётчик попыток не сбрасывает
- 2026-10-21 11:03 Task 2: сделано — lib/listen.mjs (subscribeCommands: поток <topic>-cmd/json, since по id в sinceFile атомарно, без файла — с текущей секунды, переподключение 5→60 с со сбросом после удачи, stop()) + 8 тестов, npm test 89/89
- 2026-10-21 11:05 Task 3: сделано — lib/notify.mjs: buttonsFor + параметр actions (ntfy http, POST команды в <topic>-cmd с Bearer ntfyCommandToken, только при ntfyCommands и токене, ≤3 кнопок); autopilot.mjs передаёт кнопки во все 4 отправки; +4 теста, npm test 97/97
