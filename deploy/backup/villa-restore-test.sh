#!/usr/bin/env bash
# Prueba mensual de restauración (villa-restore-test.timer). Un backup que nunca se restauró no
# es un backup. Baja el último daily/, verifica su SHA-256, lo descifra, lo restaura en una base
# temporal como villa_restore (sin superusuario), corre sanity.sql (libro cuadrado, 1105 >= 0,
# balance de prueba en cero, permisos de villa_app) y borra la base temporal.
#
# Necesita AGE_IDENTITY_FILE (llave privada) legible por postgres. Si decidiste NO dejar la llave
# privada en el VPS, este timer queda apagado y la prueba se hace a mano cada mes
# (docs/despliegue.md, "Prueba mensual de restauración").
set -euo pipefail
umask 077

: "${AGE_IDENTITY_FILE:?Falta AGE_IDENTITY_FILE: sin la llave privada no se puede probar la restauración}"
scratch="villa_restore_test"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
  psql -X -q -d postgres -v ON_ERROR_STOP=1 -v name="$scratch" <<'SQL' || true
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'name' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'name') \gexec
SQL
}
trap cleanup EXIT
cleanup

started="$(date +%s)"
"${script_dir}/villa-restore.sh" latest "$scratch" --replace
elapsed="$(( $(date +%s) - started ))"
echo "villa-restore-test: OK en ${elapsed}s"

# Para Inicio del dueño (migración 0031): en la base de verdad, no en la temporal que se borra.
psql -X -q --no-password -d "${VILLA_DB:-villa}" -v ON_ERROR_STOP=1 -v detail="OK en ${elapsed}s" <<'SQL' \
  || echo "villa-restore-test: la prueba salió bien, pero no pude registrarla en backup_runs" >&2
INSERT INTO backup_runs (kind, ok, detail) VALUES ('restore_test', true, left(:'detail', 200));
SQL

if [[ -n "${RESTORE_HEALTHCHECK_URL:-}" ]]; then
  curl -fsS -m 10 --retry 3 "$RESTORE_HEALTHCHECK_URL" >/dev/null || echo "villa-restore-test: no pude avisar a RESTORE_HEALTHCHECK_URL" >&2
fi
