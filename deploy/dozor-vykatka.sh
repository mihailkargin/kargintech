#!/usr/bin/env bash
# Дозор: ждёт восстановления маршрута до Selectel и выкатывает комплект.
set -u
SSH="C:/Windows/System32/OpenSSH/ssh.exe"
HOST="kargin@SERVER_IP"
cd "$(dirname "$0")/.." || exit 1

for i in $(seq 1 40); do
  if "$SSH" -o ConnectTimeout=10 -o BatchMode=yes "$HOST" "echo ok-net" 2>/dev/null | grep -q ok-net; then
    echo "[dozor] network up, attempt $i: $(date '+%H:%M:%S')"
    python -I deploy/send-kit-zip.py "$HOST" && echo "[dozor] kit sent"
    "$SSH" "$HOST" "cd ~/kargintech/deploy && docker compose up -d --build app 2>&1 | tail -1 && sleep 3 && docker compose exec -T app sha256sum app/yandex-run.js src/spec.js site/pages-legal.js" | tee /tmp/dozor-remote.txt
    node -e "const c=require('crypto'),fs=require('fs');for (const f of ['app/yandex-run.js','src/spec.js','site/pages-legal.js']) console.log(c.createHash('sha256').update(fs.readFileSync(f)).digest('hex')+'  '+f)" | tee /tmp/dozor-local.txt
    if diff <(awk '{print $1}' /tmp/dozor-remote.txt | sort) <(awk '{print $1}' /tmp/dozor-local.txt | sort) >/dev/null; then
      echo "[dozor] HASHES MATCH - deploy confirmed"
    else
      echo "[dozor] WARNING: hashes differ, check manually"
    fi
    exit 0
  fi
  sleep 60
done
echo "[dozor] network did not return in 40 min"
exit 1
