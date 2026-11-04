#!/usr/bin/env bash
# Создаёт каталог запасной учётки Claude: симлинки на общие настройки основной.
# .credentials.json не трогает — вход в учётку делается отдельно. Повторный запуск безопасен.
set -euo pipefail

SRC="${SRC:-/root/.claude}"
DST="${DST:-/root/.claude-alt}"
ITEMS=(settings.json plugins skills projects)

# Сначала проверяем всё, чтобы при ошибке ничего не менять.
bad=0
for n in "${ITEMS[@]}"; do
  if [ -e "$DST/$n" ] && [ ! -L "$DST/$n" ]; then
    echo "Ошибка: $DST/$n уже существует и это не симлинк — не перезаписываю. Перенесите или удалите его вручную." >&2
    bad=1
  fi
done
[ "$bad" -eq 0 ] || exit 1

mkdir -p "$DST"
for n in "${ITEMS[@]}"; do
  if [ ! -e "$SRC/$n" ]; then
    echo "Пропуск: $SRC/$n не найден" >&2
    continue
  fi
  ln -sfn "$SRC/$n" "$DST/$n"
  echo "ok: $DST/$n -> $SRC/$n"
done
