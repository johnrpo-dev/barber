#!/usr/bin/env bash
# Restaura un backup de Villa (docs/despliegue.md, "Restaurar").
#
#   villa-restore.sh <backup> <base-destino> [--replace]
#
#   <backup>        archivo local villa-AAAAMMDDTHHMMSSZ.dump.age, o ruta en el bucket
#                   (p. ej. "daily/villa-20261105T073000Z.dump.age"), o "latest"
#   <base-destino>  Si existe, el script se niega salvo con --replace.
#
# Hay dos modos, según el destino:
#
#   Base de prueba (cualquier nombre distinto de $VILLA_DB): pg_restore corre como villa_restore,
#   un rol SIN superusuario y dueño solo de esa base. Un dump alterado no alcanza a nada más. Sin
#   dueños ni permisos del dump; se aplican con app_apply_grants() para revisar los reales.
#   Requiere el rol y su línea en pg_hba (docs/despliegue.md, "Restaurar").
#
#   Producción ($VILLA_DB, normalmente villa): corre como postgres, porque conserva los dueños
#   (villa_owner, y villa_queue en pgboss). Vuelve a aplicar el endurecimiento de la base de
#   setup-roles.sql, que un CREATE DATABASE no trae, y las supresiones de clientes hechas después
#   del backup. Detén villa-web y villa-worker antes, y revisa el backup primero en una base de prueba.
#
# Necesita la llave PRIVADA de age (AGE_IDENTITY_FILE). Normalmente no vive en el VPS: tráela
# solo para restaurar y bórrala después (ver "Custodia de las llaves" en docs/despliegue.md).
# Se corre como postgres, con las variables de /etc/villa/backup.env:
#   sudo systemd-run --pty --wait --uid=postgres -p EnvironmentFile=/etc/villa/backup.env \
#     -E AGE_IDENTITY_FILE=/ruta/llave.txt /usr/local/sbin/villa-restore.sh latest villa_restore
set -euo pipefail
umask 077

usage() { echo "uso: $0 <backup|latest> <base-destino> [--replace]" >&2; exit 2; }
[[ $# -ge 2 ]] || usage
source_arg="$1"
target="$2"
replace="${3:-}"
[[ -z "$replace" || "$replace" == "--replace" ]] || usage
[[ "$target" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "villa-restore: nombre de base inválido: $target" >&2; exit 2; }

: "${AGE_IDENTITY_FILE:?Falta AGE_IDENTITY_FILE (la llave privada de age)}"
: "${BACKUP_DIR:=/var/backups/villa}"
: "${VILLA_DB:=villa}"
restore_role=villa_restore
[[ -r "$AGE_IDENTITY_FILE" ]] || { echo "villa-restore: no puedo leer $AGE_IDENTITY_FILE" >&2; exit 1; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Instalado: /usr/local/share/villa/sanity.sql; desde el repositorio: junto a este script.
sanity="${SANITY_SQL:-/usr/local/share/villa/sanity.sql}"
[[ -r "$sanity" ]] || sanity="${script_dir}/sanity.sql"
[[ -r "$sanity" ]] || { echo "villa-restore: no encuentro sanity.sql" >&2; exit 1; }

production=0
[[ "$target" == "$VILLA_DB" ]] && production=1

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [[ -n "${RCLONE_CONFIG:-}" ]]; then
  export RCLONE_CONFIG
  export RCLONE_CACHE_DIR="${work}/rclone-cache"
fi

# Sin suma de verificación no se restaura: nadie sabría qué se está cargando.
verify_checksum() {
  local file="$1" name="$2" sums="$3" expected actual
  [[ -r "$sums" ]] || { echo "villa-restore: falta el SHA-256 de ${name}" >&2; exit 1; }
  expected="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$sums")"
  actual="$(sha256sum "$file" | cut -d' ' -f1)"
  [[ -n "$expected" && "$expected" == "$actual" ]] || { echo "villa-restore: el SHA-256 de ${name} no coincide" >&2; exit 1; }
}

# 1. Conseguir el archivo cifrado y verificarlo.
if [[ -f "$source_arg" ]]; then
  encrypted="$source_arg"
  verify_checksum "$encrypted" "$(basename "$encrypted")" "${source_arg%.dump.age}.sha256"
else
  : "${RCLONE_CONFIG:?Falta RCLONE_CONFIG}"
  : "${RCLONE_REMOTE:?Falta RCLONE_REMOTE}"
  remote_path="$source_arg"
  if [[ "$source_arg" == "latest" ]]; then
    # El más reciente de daily/ (los nombres llevan la fecha UTC, así que ordenan solos).
    remote_path="daily/$(rclone lsf --files-only --include 'villa-*.dump.age' "${RCLONE_REMOTE}/daily/" | sort | tail -n 1)"
    [[ "$remote_path" != "daily/" ]] || { echo "villa-restore: no hay backups en ${RCLONE_REMOTE}/daily/" >&2; exit 1; }
  fi
  [[ "$remote_path" =~ ^(daily|weekly|monthly)/villa-[0-9TZ]+\.dump\.age$ ]] || { echo "villa-restore: ruta inválida: $remote_path" >&2; exit 2; }
  rclone copyto "${RCLONE_REMOTE}/${remote_path}" "${work}/backup.dump.age"
  rclone copyto "${RCLONE_REMOTE}/${remote_path%.dump.age}.sha256" "${work}/backup.sha256" \
    || { echo "villa-restore: falta el SHA-256 de ${remote_path}" >&2; exit 1; }
  verify_checksum "${work}/backup.dump.age" "$(basename "$remote_path")" "${work}/backup.sha256"
  encrypted="${work}/backup.dump.age"
  echo "villa-restore: usando ${remote_path}"
fi

# 2. Descifrar a un archivo temporal privado (pg_restore necesita poder saltar dentro del archivo).
age --decrypt --identity "$AGE_IDENTITY_FILE" --output "${work}/backup.dump" "$encrypted"
pg_restore --list "${work}/backup.dump" >/dev/null

# 3. Base destino.
# $target ya pasó la validación de arriba (solo [a-z0-9_]): se puede escribir tal cual.
if [[ "$production" != "1" ]]; then
  has_role="$(psql -XtAq -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname = '${restore_role}'")"
  [[ "$has_role" == "1" ]] || { echo "villa-restore: falta el rol ${restore_role} (docs/despliegue.md, \"Restaurar\")" >&2; exit 1; }
fi
exists="$(psql -XtAq -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '${target}'")"
if [[ "$exists" == "1" ]]; then
  [[ "$replace" == "--replace" ]] || { echo "villa-restore: la base $target ya existe (usa --replace si de verdad quieres reemplazarla)" >&2; exit 1; }
  psql -X -q -d postgres -v ON_ERROR_STOP=1 -v name="$target" <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'name' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE %I', :'name') \gexec
SQL
fi

if [[ "$production" == "1" ]]; then
  # El mismo endurecimiento de setup-roles.sql: el dump no lo trae, porque es de la base y no del
  # esquema. Sin esto, PUBLIC recupera CONNECT y TEMPORARY, y villa_app podría crear tablas temporales.
  psql -X -q -d postgres -v ON_ERROR_STOP=1 -v name="$target" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER villa_owner', :'name') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO villa_app', :'name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO villa_queue', :'name') \gexec
SELECT format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO villa_owner', :'name') \gexec
SQL
  # 4. Restaurar con dueños y permisos (los roles los creó setup-roles.sql).
  #    Los triggers del libro se crean al final (post-data), después de cargar los datos.
  pg_restore --exit-on-error --no-password --dbname="$target" "${work}/backup.dump"
  psql -X -q -d "$target" -v ON_ERROR_STOP=1 <<'SQL'
ALTER SCHEMA public OWNER TO villa_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO villa_app;
SET ROLE villa_owner;
SELECT app_apply_grants();
RESET ROLE;
SQL
  psql_as=(psql -X -d "$target")
else
  psql -X -q -d postgres -v ON_ERROR_STOP=1 -v name="$target" -v role="$restore_role" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'name', :'role') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'name') \gexec
SQL
  # 4. Restaurar sin privilegios. btree_gist es una extensión "trusted": la crea el dueño de la base.
  pg_restore --exit-on-error --no-password --no-owner --no-acl --username="$restore_role" --dbname="$target" "${work}/backup.dump"
  psql -X -q -U "$restore_role" -d "$target" -v ON_ERROR_STOP=1 -c "SELECT app_apply_grants();" >/dev/null
  psql_as=(psql -X -U "$restore_role" -d "$target")
fi

# 5. Cordura del libro y de los permisos.
"${psql_as[@]}" -v ON_ERROR_STOP=1 -f "$sanity"

# 6. Supresiones posteriores al backup (solo producción): la lista más nueva del bucket es acumulada.
#    Volver a suprimir a alguien no cambia nada. Un cliente que no se pueda suprimir se reporta al
#    final, sin detener a los demás: alguien tiene que resolverlo a mano.
if [[ "$production" == "1" ]]; then
  if [[ -z "${RCLONE_REMOTE:-}" ]]; then
    echo "villa-restore: AVISO: sin RCLONE_REMOTE no pude revisar las supresiones; ver el runbook" >&2
    exit 1
  fi
  latest_erasures="$(rclone lsf --files-only --include 'villa-*.erasures.csv.age' "${RCLONE_REMOTE}/erasures/" | sort | tail -n 1)" || latest_erasures=""
  if [[ -z "$latest_erasures" ]]; then
    echo "villa-restore: AVISO: no hay lista de supresiones en el bucket; revisa que eso sea correcto" >&2
  else
    rclone copyto "${RCLONE_REMOTE}/erasures/${latest_erasures}" "${work}/erasures.csv.age"
    rclone copyto "${RCLONE_REMOTE}/erasures/${latest_erasures%.erasures.csv.age}.sha256" "${work}/erasures.sha256" \
      || { echo "villa-restore: falta el SHA-256 de ${latest_erasures}" >&2; exit 1; }
    verify_checksum "${work}/erasures.csv.age" "$latest_erasures" "${work}/erasures.sha256"
    age --decrypt --identity "$AGE_IDENTITY_FILE" --output "${work}/erasures.csv" "${work}/erasures.csv.age"
    applied=0
    failed=0
    while IFS=, read -r location client _; do
      [[ "$location" =~ ^[0-9]+$ && "$client" =~ ^[0-9]+$ ]] || continue # el encabezado
      if psql -X -q -d "$target" -v ON_ERROR_STOP=1 -c "SELECT erase_client_personal_data(${location}, ${client});" >/dev/null; then
        applied=$((applied + 1))
      else
        failed=$((failed + 1))
        echo "villa-restore: no pude suprimir al cliente ${client} de la sede ${location}" >&2
      fi
    done < "${work}/erasures.csv"
    echo "villa-restore: supresiones aplicadas: ${applied}, con falla: ${failed}"
    [[ "$failed" -eq 0 ]] || exit 1
  fi
fi

echo "villa-restore: ${target} restaurada y revisada"
