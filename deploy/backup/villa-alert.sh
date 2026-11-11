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

# La falla también queda en la base, para que Inicio del dueño diga "El respaldo de anoche falló"
# (migración 0031). Corre como postgres (villa-alert@.service), por el socket local. Si la base es la
# que está caída, no se registra: Inicio lo verá igual porque no habrá un respaldo bueno reciente.
case "$unit" in
  villa-backup.service) kind=backup ;;
  villa-restore-test.service) kind=restore_test ;;
  *) kind="" ;;
esac
if [[ -n "$kind" ]]; then
  psql -X -q --no-password -d "${VILLA_DB:-villa}" -v ON_ERROR_STOP=1 -v kind="$kind" -v detail="$unit" <<'SQL' \
    || logger -p user.err -t villa-alert "no pude registrar la falla en backup_runs"
INSERT INTO backup_runs (kind, ok, detail) VALUES (:'kind', false, left(:'detail', 200));
SQL
fi
