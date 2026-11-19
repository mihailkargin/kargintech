#!/bin/bash
# СТРАЖ ПРИЛОЖЕНИЯ: зависший разбор одного тендера крутил CPU на ~200% часами
# и глушил весь сервер (14.11.2026, тендер 0362300269826000001; тот же тендер
# — вероятный корень заморозки 14.11 днём). Синхронный цикл внутри Node
# нельзя прервать таймером, поэтому страховка внешняя: если app жрёт оба ядра
# дольше ПРЕДЕЛ минут подряд — контейнер перезапускается сам. Очередь разбора
# после перезапуска продолжится со следующего тендера; тендер-виновник уже
# исключён вручную, повторное зависание — сигнал смотреть лог и лечить причину.
#
# Нормальная работа: поиск поставщиков кратковременно поднимает CPU, поэтому
# считаем ТОЛЬКО длинные непрерывные всплески (6 проверок подряд × 5 минут).
#
# Cron (crontab -e): */5 * * * * ~/kargintech/deploy/watchdog-app.sh
set -u
COMPOSE="$HOME/kargintech/deploy"
STATE=/tmp/watchdog-app-strikes
CPU=$(docker stats --no-stream --format '{{.CPUPerc}}' deploy-app-1 2>/dev/null | tr -d '%' | cut -d. -f1)
[ -z "${CPU:-}" ] && exit 0   # контейнер пересобирается/лежит — не наша смена
if [ "$CPU" -ge 150 ]; then
  STRIKES=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
  echo "$STRIKES" > "$STATE"
  if [ "$STRIKES" -ge 6 ]; then
    echo "$(date -Is) CPU ${CPU}% ${STRIKES} проверок подряд — перезапуск app" >> "$HOME/kargintech/deploy/watchdog-app.log"
    cd "$COMPOSE" && docker compose restart app >> "$HOME/kargintech/deploy/watchdog-app.log" 2>&1
    echo 0 > "$STATE"
  fi
else
  echo 0 > "$STATE"
fi
