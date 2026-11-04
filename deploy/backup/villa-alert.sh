#!/usr/bin/env bash
# Aviso de falla de un backup o de la prueba de restauración (villa-alert@.service).
# Siempre deja una línea "err" en el journal. Si ALERT_WEBHOOK_URL está en /etc/villa/backup.env
# (ntfy.sh, healthchecks.io /fail, un webhook de Slack o de WhatsApp propio), la llama con un
# texto corto sin datos personales.
set -euo pipefail
unit="${1:-desconocida}"
msg="Villa: falló ${unit} en $(hostname) el $(date '+%Y-%m-%d %H:%M %Z'). Revisa: journalctl -u ${unit} -n 100"
logger -p user.err -t villa-alert "$msg"
if [[ -n "${ALERT_WEBHOOK_URL:-}" ]]; then
  curl -fsS -m 10 --retry 3 -H "Content-Type: text/plain; charset=utf-8" --data-binary "$msg" "$ALERT_WEBHOOK_URL" >/dev/null \
    || logger -p user.err -t villa-alert "no pude llamar a ALERT_WEBHOOK_URL"
fi
