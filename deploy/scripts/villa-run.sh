#!/usr/bin/env bash
# Corre un comando de la app en el VPS como el usuario villa, con los secretos de
# /etc/villa/villa.env, sin copiarlos a la línea de comandos ni al historial.
#
#   sudo villa-run.sh npm run staff:create-owner
#   sudo villa-run.sh npm run staff:unlock -- correo@ejemplo.com
#   sudo villa-run.sh npm run db:seed
#
# Es interactivo (--pty): create-owner pide la contraseña sin mostrarla.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "villa-run: córrelo con sudo" >&2; exit 1; }
[[ $# -ge 1 ]] || { echo "uso: $0 <comando> [argumentos…]" >&2; exit 2; }
exec systemd-run --quiet --wait --pty --collect --uid=villa --gid=villa \
  -p EnvironmentFile=/etc/villa/villa.env \
  -p WorkingDirectory=/srv/villa/current \
  -E NODE_ENV=production -E HOME=/var/lib/villa \
  "$@"
