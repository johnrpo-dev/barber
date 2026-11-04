#!/usr/bin/env bash
# Publica una versión de Villa en el VPS (docs/despliegue.md, "Publicar una versión").
#
#   sudo deploy-release.sh <tag-o-commit>
#
# Instalado en /usr/local/sbin (root). Nunca se corre desde un árbol del usuario villa: quien tome
# ese usuario no debe poder cambiar lo que root ejecuta (auditoría del sprint 5, H1).
#
# 1. Crea /srv/villa/releases/<fecha>, de villa solo mientras se construye. /srv/villa y releases/
#    son de root: villa no puede renombrar ni reemplazar las otras versiones.
# 2. Clona y hace npm ci --ignore-scripts (ninguna dependencia corre scripts de instalación).
# 3. npm run build, solo con las variables NEXT_PUBLIC_*: ningún secreto llega al build ni al código
#    de terceros que corre en él.
# 4. Pasa TODO a root y quita la escritura: el proceso que corre el código no lo puede cambiar.
# 5. Backup cifrado ANTES de migrar (villa-backup.service).
# 6. Migraciones como villa_owner con deploy/scripts/migrate.mjs (solo dependencias de producción,
#    fijadas por package-lock.json). Ni drizzle-kit ni las de desarrollo ven esa credencial.
# 7. Cambia /srv/villa/current de forma atómica, reinicia y revisa /api/health. Si no responde,
#    vuelve sola a la versión anterior (el código; la base no, ver "Volver atrás").
#
# Variables (opcionales): REPO_URL (de /etc/villa/deploy.conf), KEEP_RELEASES=5,
# SKIP_BACKUP=1 (solo para la primera instalación, cuando aún no hay backups configurados).
set -euo pipefail
umask 022

[[ $EUID -eq 0 ]] || { echo "deploy: córrelo con sudo" >&2; exit 1; }
[[ $# -eq 1 ]] || { echo "uso: $0 <tag-o-commit>" >&2; exit 2; }
ref="$1"
# Sin "-" al inicio (git lo leería como opción) y sin "..".
[[ "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ && "$ref" != *..* ]] || { echo "deploy: referencia inválida" >&2; exit 2; }

if [[ -r /etc/villa/deploy.conf ]]; then
  # shellcheck disable=SC1091
  source /etc/villa/deploy.conf
fi
: "${REPO_URL:?Falta REPO_URL (en /etc/villa/deploy.conf)}"
: "${KEEP_RELEASES:=5}"
base=/srv/villa
releases="${base}/releases"
villa_home=/var/lib/villa
previous_file="${base}/previous-release"

# Comando como villa en una unidad transitoria: al terminar, systemd mata lo que haya quedado vivo
# (ningún proceso de un paquete sigue escribiendo cuando el árbol pasa a root).
# Uso: as_villa <directorio> <archivo-de-entorno|-> <comando…>
as_villa() {
  local dir="$1" envfile="$2"
  shift 2
  local props=(-p "WorkingDirectory=${dir}" -p NoNewPrivileges=yes -p PrivateTmp=yes)
  [[ "$envfile" == "-" ]] || props+=(-p "EnvironmentFile=${envfile}")
  systemd-run --quiet --wait --pipe --collect --uid=villa --gid=villa "${props[@]}" \
    -E HOME="${villa_home}" -E NEXT_TELEMETRY_DISABLED=1 "$@"
}

install -d -o root -g root -m 0755 "$base" "$releases"
install -d -o villa -g villa -m 0750 "$villa_home"
install -d -o villa -g villa -m 0700 /var/cache/villa /var/cache/villa/next

# Lo que un intento anterior dejó a medias (sin .complete) no sirve para nada.
find "$releases" -mindepth 1 -maxdepth 1 -type d -name '.incoming-*' -exec rm -rf {} +
for d in "$releases"/*/; do
  [[ -d "$d" && ! -e "${d}.complete" ]] && rm -rf "$d"
done

previous="$(readlink -f "${base}/current" 2>/dev/null || true)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
release="${releases}/${stamp}"
build_env="$(mktemp /run/villa-build.XXXXXX)"
activated=0
cleanup() {
  rm -f "$build_env"
  if [[ "$activated" != "1" ]]; then rm -rf "$release"; fi
}
trap cleanup EXIT

# 1. Código (villa solo escribe en esta carpeta). La ruta es la definitiva: el build no se muda.
install -d -o villa -g villa -m 0755 "$release"
as_villa "$villa_home" - /usr/bin/git clone --quiet "$REPO_URL" "$release"
as_villa "$release" - /usr/bin/git checkout --quiet --detach "$ref"
sha="$(as_villa "$release" - /usr/bin/git rev-parse --short=10 HEAD)"
echo "deploy: versión ${ref} (${sha}) en ${release}"

# 2. Dependencias sin scripts de instalación. esbuild (tsx, drizzle-kit) funciona sin su postinstall,
#    que solo optimiza el arranque; el paso siguiente lo comprueba. Si una dependencia nueva necesita
#    su script, se agrega aquí con su nombre: npm rebuild <paquete>.
as_villa "$release" - /usr/bin/npm ci --ignore-scripts --include=dev --no-audit --no-fund
as_villa "$release" - "${release}/node_modules/.bin/tsx" --version >/dev/null

# 3. Build solo con NEXT_PUBLIC_*: son públicas (van al navegador).
grep -E '^NEXT_PUBLIC_[A-Z0-9_]+=' /etc/villa/villa.env > "$build_env" || true
as_villa "$release" "$build_env" -E NODE_ENV=production /usr/bin/npm run build
standalone="${release}/.next/standalone"
[[ -f "${standalone}/server.js" ]] || { echo "deploy: el build no produjo .next/standalone/server.js" >&2; exit 1; }

# 4. De aquí en adelante el árbol es de root. -R no sigue enlaces; chmod quita setuid y escritura.
chown -R root:root "$release"
chmod -R u=rwX,go=rX "$release"
cp -a "${release}/.next/static" "${standalone}/.next/static"
if [[ -d "${release}/public" ]]; then cp -a "${release}/public" "${standalone}/public"; fi
rm -rf "${standalone}/.next/cache"
ln -s /var/cache/villa/next "${standalone}/.next/cache"
echo "$sha" > "${release}/REVISION"
touch "${release}/.complete"

# 5. Backup antes de migrar.
if [[ "${SKIP_BACKUP:-0}" != "1" ]]; then
  echo "deploy: backup previo a la migración…"
  systemctl start villa-backup.service
fi

# 6. Migraciones (villa_owner). Cada una termina con app_apply_grants().
echo "deploy: migraciones…"
as_villa "$release" /etc/villa/migrate.env /usr/bin/node deploy/scripts/migrate.mjs

# 7. Cambio atómico y reinicio.
ln -sfn "$release" "${base}/current.next"
mv -T "${base}/current.next" "${base}/current"
activated=1
systemctl restart villa-web.service villa-worker.service

healthy=0
for _ in $(seq 1 30); do
  if curl -fsS -m 2 http://127.0.0.1:3000/api/health >/dev/null; then healthy=1; break; fi
  sleep 1
done
if [[ "$healthy" != "1" ]]; then
  echo "deploy: /api/health no responde; vuelvo a la versión anterior" >&2
  journalctl -u villa-web -n 40 --no-pager >&2 || true
  if [[ -n "$previous" && -d "$previous" ]]; then
    ln -sfn "$previous" "${base}/current.next"
    mv -T "${base}/current.next" "${base}/current"
    systemctl restart villa-web.service villa-worker.service
  fi
  exit 1
fi
systemctl is-active --quiet villa-worker.service || { echo "deploy: villa-worker no quedó activo (journalctl -u villa-worker)" >&2; exit 1; }
if [[ -n "$previous" && -d "$previous" ]]; then echo "$previous" > "$previous_file"; fi

# 8. Limpieza: se conservan las últimas KEEP_RELEASES (nunca la activa ni la anterior).
ls -1dt "${releases}"/*/ 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do
  old="$(readlink -f "$old")"
  [[ "$old" == "$(readlink -f "${base}/current")" || "$old" == "$previous" ]] && continue
  rm -rf "$old"
done
echo "deploy: listo, ${sha} en producción"
