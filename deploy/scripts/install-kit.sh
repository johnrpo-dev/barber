#!/usr/bin/env bash
# Instala en el VPS lo que corre como root: scripts, unidades systemd y SQL de roles.
#
#   sudo bash /root/villa-kit/deploy/scripts/install-kit.sh
#
# Solo desde una copia de root, parada exactamente en un tag que ya verificaste
# (docs/despliegue.md, "Copia de root"). Nunca desde un árbol del usuario villa ni desde una
# versión publicada: quien pueda escribir ahí terminaría corriendo código como root.
# No toca /etc/villa ni /etc/caddy/Caddyfile: esos tienen tus valores.
set -euo pipefail
umask 022
[[ $EUID -eq 0 ]] || { echo "install-kit: córrelo con sudo" >&2; exit 1; }

kit="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
[[ "$kit" != /srv/villa/* && "$kit" != /var/lib/villa/* ]] || { echo "install-kit: $kit es del árbol de la app; usa la copia de root" >&2; exit 1; }
other="$(find "$kit" ! -user root -print -quit)"
[[ -z "$other" ]] || { echo "install-kit: $other no es de root" >&2; exit 1; }
writable="$(find "$kit" ! -type l -perm /022 -print -quit)"
[[ -z "$writable" ]] || { echo "install-kit: $writable lo pueden escribir otros" >&2; exit 1; }
tag="$(git -C "$kit" describe --exact-match --tags HEAD 2>/dev/null)" \
  || { echo "install-kit: la copia no está parada en un tag" >&2; exit 1; }
if [[ -n "$(git -C "$kit" status --porcelain)" ]]; then
  echo "install-kit: la copia tiene cambios locales" >&2
  exit 1
fi

install -m 0755 -o root -g root \
  "$kit"/deploy/scripts/deploy-release.sh "$kit"/deploy/scripts/rollback.sh "$kit"/deploy/scripts/villa-run.sh \
  "$kit"/deploy/backup/villa-backup.sh "$kit"/deploy/backup/villa-restore.sh \
  "$kit"/deploy/backup/villa-restore-test.sh "$kit"/deploy/backup/villa-alert.sh \
  /usr/local/sbin/
install -d -m 0755 -o root -g root /usr/local/share/villa
install -m 0644 -o root -g root "$kit"/deploy/backup/sanity.sql "$kit"/src/db/roles/setup-roles.sql /usr/local/share/villa/
install -m 0644 -o root -g root "$kit"/deploy/systemd/*.service "$kit"/deploy/systemd/*.timer /etc/systemd/system/
install -d -m 0755 -o root -g root /etc/systemd/system/caddy.service.d
install -m 0644 -o root -g root "$kit"/deploy/caddy/caddy-runtime.conf /etc/systemd/system/caddy.service.d/villa.conf
systemctl daemon-reload
echo "install-kit: instalado desde ${tag}"
