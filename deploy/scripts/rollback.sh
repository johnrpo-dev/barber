#!/usr/bin/env bash
# Vuelve el CÓDIGO a una versión anterior (docs/despliegue.md, "Volver atrás").
#
#   sudo rollback.sh previous      # a la que deploy-release.sh registró como anterior
#   sudo rollback.sh <carpeta>     # a una de /srv/villa/releases (ls /srv/villa/releases)
#
# Hay que decir a cuál: adivinar por fecha podría subir una versión que nadie probó.
# No toca la base: las migraciones son solo hacia adelante y la versión anterior debe funcionar con
# el esquema nuevo (las migraciones de Villa agregan; no borran columnas que el código viejo use).
# Si una migración dañó datos, se restaura el backup previo con villa-restore.sh (ver el runbook).
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "rollback: córrelo con sudo" >&2; exit 1; }
[[ $# -eq 1 ]] || { echo "uso: $0 previous | <carpeta de /srv/villa/releases>" >&2; exit 2; }
base=/srv/villa
releases="${base}/releases"
previous_file="${base}/previous-release"
current="$(readlink -f "${base}/current")"

if [[ "$1" == "previous" ]]; then
  [[ -r "$previous_file" ]] || { echo "rollback: no hay versión anterior registrada; di cuál (ls ${releases})" >&2; exit 1; }
  target="$(readlink -f "$(cat "$previous_file")")"
else
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "rollback: nombre inválido" >&2; exit 2; }
  target="$(readlink -f "${releases}/$1")"
fi
[[ "$target" == "${releases}/"* && -e "${target}/.complete" && -f "${target}/.next/standalone/server.js" ]] \
  || { echo "rollback: ${target} no es una versión completa de ${releases}" >&2; exit 1; }
[[ "$target" != "$current" ]] || { echo "rollback: esa versión ya está activa" >&2; exit 1; }

ln -sfn "$target" "${base}/current.next"
mv -T "${base}/current.next" "${base}/current"
systemctl restart villa-web.service villa-worker.service
for _ in $(seq 1 30); do
  if curl -fsS -m 2 http://127.0.0.1:3000/api/health >/dev/null; then
    echo "$current" > "$previous_file"
    echo "rollback: listo, en $(basename "$target")"
    exit 0
  fi
  sleep 1
done
echo "rollback: /api/health no responde en $(basename "$target"); revisa journalctl -u villa-web" >&2
exit 1
