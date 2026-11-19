#!/bin/bash
# Одноразовая установка cron для watchdog-app.sh (вызывается по ssh).
(crontab -l 2>/dev/null | grep -v watchdog-app; echo '*/5 * * * * ~/kargintech/deploy/watchdog-app.sh') | crontab -
crontab -l | tail -2
