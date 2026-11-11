#!/usr/bin/env bash
# Backup diario cifrado de Villa (docs/despliegue.md, "Backups").
#
#   pg_dump (formato custom) | age (llave PÚBLICA) → archivo local → rclone → bucket (B2 o R2)
#
# Lo corre villa-backup.service como el usuario postgres (autenticación peer por socket: no hay
# contraseñas de la base en ningún archivo). En el VPS solo está la llave pública: quien robe el
# bucket no puede leer nada, y el VPS no puede descifrar backups viejos.
#
# Destinos en el bucket:
#   daily/   todos los días    weekly/  domingos    monthly/ día 1
#   erasures/  todos los días: la lista acumulada de supresiones de clientes, aparte del dump. Si se
#              restaura un backup viejo, esta lista dice qué hay que volver a borrar.
#
# La retención (7 días / 4 semanas / 12 meses) la hacen las reglas de ciclo de vida del BUCKET: la
# llave del VPS no debe poder borrar, para que quien tome el VPS no destruya los backups. Si de
# verdad no puedes usar reglas, PRUNE_FROM_VPS=1 borra desde aquí, con una llave que sí borra.
#
# Variables (EnvironmentFile=/etc/villa/backup.env; ver deploy/backup/backup.env.example):
#   VILLA_DB             base a respaldar (villa)
#   AGE_RECIPIENTS_FILE  llave(s) pública(s) age, una por línea
#   RCLONE_CONFIG        configuración de rclone
#   RCLONE_REMOTE        destino, p. ej. "b2:villa-backups" o "r2:villa-backups"
#   PRUNE_FROM_VPS, KEEP_DAILY_DAYS / KEEP_WEEKLY_DAYS / KEEP_MONTHLY_DAYS (opcionales)
#   HEALTHCHECK_URL      (opcional) URL que se llama si todo salió bien (healthchecks.io, etc.)
set -euo pipefail
umask 077

: "${VILLA_DB:=villa}"
: "${AGE_RECIPIENTS_FILE:?Falta AGE_RECIPIENTS_FILE}"
: "${RCLONE_CONFIG:?Falta RCLONE_CONFIG}"
: "${RCLONE_REMOTE:?Falta RCLONE_REMOTE}"
: "${PRUNE_FROM_VPS:=0}"
: "${KEEP_DAILY_DAYS:=7}"
: "${KEEP_WEEKLY_DAYS:=28}"
: "${KEEP_MONTHLY_DAYS:=366}"
: "${BACKUP_DIR:=/var/backups/villa}"
export RCLONE_CONFIG
export RCLONE_CACHE_DIR="${BACKUP_DIR}/.rclone-cache"

for bin in pg_dump pg_dumpall psql age rclone sha256sum; do
  command -v "$bin" >/dev/null || { echo "villa-backup: falta el programa $bin" >&2; exit 1; }
done
[[ -r "$AGE_RECIPIENTS_FILE" ]] || { echo "villa-backup: no puedo leer $AGE_RECIPIENTS_FILE" >&2; exit 1; }
if grep -q "AGE-SECRET-KEY" "$AGE_RECIPIENTS_FILE"; then
  echo "villa-backup: $AGE_RECIPIENTS_FILE tiene una llave PRIVADA; ahí va solo la pública (age1...)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="${BACKUP_DIR}/villa-${stamp}.dump.age"
globals="${BACKUP_DIR}/villa-${stamp}.globals.sql.age"
erasures="${BACKUP_DIR}/villa-${stamp}.erasures.csv.age"
checksums="${BACKUP_DIR}/villa-${stamp}.sha256"
partial="${dump}.partial"
trap 'rm -f "$partial" "${globals}.partial" "${erasures}.partial"' EXIT

# 1. Base completa en formato custom (pg_restore elige qué y en qué orden), cifrada en el camino:
#    el dump en claro nunca toca el disco. pipefail hace fallar todo si pg_dump falla.
pg_dump --format=custom --compress=6 --no-password --dbname="$VILLA_DB" \
  | age --encrypt --recipients-file "$AGE_RECIPIENTS_FILE" --output "$partial"
mv "$partial" "$dump"

# 2. Roles (sin contraseñas): para recrear villa_owner, villa_app y villa_queue al restaurar.
pg_dumpall --globals-only --no-role-passwords --no-password \
  | age --encrypt --recipients-file "$AGE_RECIPIENTS_FILE" --output "${globals}.partial"
mv "${globals}.partial" "$globals"

# 3. Supresiones (Ley 1581): sede, id interno del cliente y fecha. Sin datos personales; cifrado
#    igual, porque dice a quién se atendió.
psql -X -q --no-password -d "$VILLA_DB" -v ON_ERROR_STOP=1 --csv \
  -c "SELECT location_id, target_ref, created_at FROM audit_events WHERE action = 'client.erase' ORDER BY id" \
  | age --encrypt --recipients-file "$AGE_RECIPIENTS_FILE" --output "${erasures}.partial"
mv "${erasures}.partial" "$erasures"

(cd "$BACKUP_DIR" && sha256sum "$(basename "$dump")" "$(basename "$globals")" "$(basename "$erasures")" > "$(basename "$checksums")")

# 4. Subida con copyto, archivo por archivo: `rclone copy` solo acepta un origen y un destino.
#    --immutable: nunca sobrescribe lo que ya está en el bucket.
put() {
  local file="$1" prefix="$2"
  rclone copyto --no-traverse --immutable --retries 5 --low-level-retries 10 \
    "$file" "${RCLONE_REMOTE}/${prefix}/$(basename "$file")"
}
upload() {
  local prefix="$1"
  put "$dump" "$prefix"
  put "$globals" "$prefix"
  put "$checksums" "$prefix"
}
upload daily
if [[ "$(date -u +%u)" == "7" ]]; then upload weekly; fi
if [[ "$(date -u +%d)" == "01" ]]; then upload monthly; fi
put "$erasures" erasures
put "$checksums" erasures

# 5. Retención desde el VPS, solo si se pidió. El código 3 de rclone es "carpeta no encontrada":
#    weekly/ y monthly/ no existen todavía en un bucket nuevo, y eso no es una falla.
prune() {
  local days="$1" prefix="$2" rc=0
  rclone delete --min-age "$((days + 1))d" "${RCLONE_REMOTE}/${prefix}/" || rc=$?
  if [[ "$rc" -ne 0 && "$rc" -ne 3 ]]; then
    echo "villa-backup: no pude limpiar ${prefix}/ (rclone salió con ${rc})" >&2
    return "$rc"
  fi
}
if [[ "$PRUNE_FROM_VPS" == "1" ]]; then
  prune "$KEEP_DAILY_DAYS" daily
  prune "$KEEP_WEEKLY_DAYS" weekly
  prune "$KEEP_MONTHLY_DAYS" monthly
fi

# 6. En el VPS quedan solo los 2 últimos (cifrados) para restaurar rápido sin bajar nada.
ls -1t "$BACKUP_DIR"/villa-*.dump.age 2>/dev/null | tail -n +3 | while read -r old; do
  base="${old%.dump.age}"
  rm -f "$old" "${base}.globals.sql.age" "${base}.erasures.csv.age" "${base}.sha256"
done

size="$(du -h "$dump" | cut -f1)"
echo "villa-backup: ok ${stamp} (${size}) → ${RCLONE_REMOTE}"

# 7. Lo deja en la base para Inicio del dueño ("Último respaldo: hoy 3:10", migración 0031). Si no
#    se puede registrar, el backup igual salió: no se marca como falla. Inicio lo verá como "hace más
#    de un día" mañana, y eso ya es una señal. Variables de psql por stdin (no se interpolan en -c).
psql -X -q --no-password -d "$VILLA_DB" -v ON_ERROR_STOP=1 \
  -v bytes="$(stat -c %s "$dump")" -v detail="$(basename "$dump")" <<'SQL' \
  || echo "villa-backup: el backup salió, pero no pude registrarlo en backup_runs" >&2
INSERT INTO backup_runs (kind, ok, size_bytes, detail) VALUES ('backup', true, :'bytes'::bigint, left(:'detail', 200));
SQL
if [[ -n "${HEALTHCHECK_URL:-}" ]]; then
  curl -fsS -m 10 --retry 3 "$HEALTHCHECK_URL" >/dev/null || echo "villa-backup: no pude avisar a HEALTHCHECK_URL" >&2
fi
