# Журнал: planner-images

- 2026-10-22 21:19 Task 1: сделано — markdown.mjs рендерит `![подпись](uploads/<uuid>.ext)` миниатюрой-ссылкой и `[текст](uploads/<uuid>.ext)` ссылкой, прочие адреса картинок остаются текстом; 6 тестов, npm test 220/220 (Ruling: `![x](https://…)` даёт обычную https-ссылку без <img>, внешнее не грузится)
- 2026-10-22 21:23 Task 2: сделано — web/share-image.mjs копирует картинку (jpg|jpeg|png|webp|gif, ≤8 МБ) в state/web/uploads/<uuid>.<ext> и печатает `![подпись](uploads/<id>)`; общий saveUpload/предел 200 файлов вынесен в web/uploads.mjs; правило в planner-prompt.md и README; 6 тестов, npm test 226/226 (Ruling: .jpeg сохраняется как .jpg, скобки/переводы строк из подписи убираются — иначе пульт не распознает строку)
