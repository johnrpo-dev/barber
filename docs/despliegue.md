# Despliegue de Villa en un VPS

**Para quién:** el dueño (o quien le ayude), con una terminal SSH abierta en el VPS. Cada paso dice qué hacer y cómo comprobar que quedó bien.

**Qué queda:**
- Ubuntu 24.04 y PostgreSQL 18.
- Caddy, que da el HTTPS.
- Dos servicios systemd: `villa-web` y `villa-worker`.
- Backups diarios cifrados en un bucket externo, con una prueba de restauración cada mes.

**¿Solo para pruebas, antes del lanzamiento?** Sigue [ambiente-de-pruebas.md](ambiente-de-pruebas.md): VPS aparte, un subdominio y datos de prueba, sin backups.

**Archivos del kit:** todo está en [`deploy/`](../deploy). Los valores entre `CAMBIAR` o `TU-DOMINIO` son tuyos y **nunca se suben al repositorio**.

| Archivo | Para qué |
|---|---|
| `deploy/systemd/villa-web.service`, `villa-worker.service` | Los dos servicios, con `NODE_ENV=production`, `HOSTNAME=127.0.0.1` y endurecimiento de systemd |
| `deploy/caddy/Caddyfile` | HTTPS, HSTS, cabeceras, compresión, caché de estáticos y registro sin tokens ni consultas |
| `deploy/env/*.env.example` | Plantillas de `/etc/villa/villa.env`, `worker.env` y `migrate.env` |
| `deploy/scripts/install-kit.sh` | Instala scripts, unidades y SQL de roles desde la copia de root |
| `deploy/scripts/deploy-release.sh` | Publica una versión: build sin secretos, backup, migración, cambio atómico y revisión de salud |
| `deploy/scripts/migrate.mjs` | Aplica las migraciones como `villa_owner`, solo con dependencias de producción |
| `deploy/scripts/rollback.sh` | Vuelve el código a una versión anterior |
| `deploy/scripts/villa-run.sh` | Corre `npm run …` (crear dueño, desbloquear) con los secretos, sin mostrarlos |
| `deploy/backup/*` | Backup cifrado, restauración, prueba mensual y `sanity.sql` |
| `deploy/systemd/villa-backup.*`, `villa-restore-test.*`, `villa-alert@.service` | Timers del backup (diario) y de la prueba (mensual), y aviso si fallan |

## 0. Lo que tienes que conseguir antes

| Qué | Dónde | Notas |
|---|---|---|
| **VPS** con Ubuntu 24.04, 2 GB de RAM o más y 40 GB de disco | Hetzner, DigitalOcean, Vultr, Contabo… | Que tenga IPv4 fija. Unos 6–12 USD al mes |
| **Dominio** | Cualquier registrador | Un subdominio, p. ej. `reservas.tubarberia.co`, con un registro A (y AAAA si hay IPv6) apuntando al VPS |
| **Bucket S3** para los backups | Backblaze B2 o Cloudflare R2 | Un bucket **privado**, con bloqueo de objetos y reglas de ciclo de vida, y una llave **solo de ese bucket y que no pueda borrar** (§8). Céntimos al mes |
| **Llaves de age** para cifrar los backups | Tu computador (no el VPS) | Ver §8. La privada se guarda fuera del VPS |
| **WhatsApp Cloud API, Turnstile y Resend** | Meta, Cloudflare, Resend | Ver [sprint-3-reserva-publica.md](sprint-3-reserva-publica.md) §9 |
| **Correo del dueño** para avisos | — | Va en `ALERT_EMAIL`. Llegan la cuota de mensajes y los bloqueos de ingreso |

## 1. Preparar el servidor

Entra por SSH como root la primera vez, crea tu usuario administrador y cierra el acceso de root.

```bash
adduser admin && usermod -aG sudo admin
# Copia tu llave SSH pública a /home/admin/.ssh/authorized_keys y prueba entrar como admin.
sudo timedatectl set-timezone America/Bogota
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git curl ufw unattended-upgrades age rclone postgresql-common
```

**SSH solo con llave:** en `/etc/ssh/sshd_config.d/10-villa.conf` pon:

```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Luego corre `sudo systemctl reload ssh`. **Antes de cerrar la sesión, prueba entrar desde otra terminal.**

**Actualizaciones automáticas de seguridad:**

```bash
sudo dpkg-reconfigure -plow unattended-upgrades   # responde "Sí"
```

En `/etc/apt/apt.conf.d/50unattended-upgrades` puedes activar `Unattended-Upgrade::Automatic-Reboot "true";` con `Automatic-Reboot-Time "04:30";`. Los servicios arrancan solos después del reinicio.

**Firewall:** solo SSH, HTTP y HTTPS. El puerto 3000 (Next) y el 5432 (Postgres) **nunca** se abren.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

**fail2ban (opcional, para SSH):** `sudo apt install -y fail2ban`. El perfil por defecto ya protege `sshd`. El ingreso a la app tiene su propio bloqueo en la base y no necesita fail2ban.

## 2. Node.js 24

Desde el repositorio firmado de NodeSource, sin correr ningún script descargado:

```bash
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
echo 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt update && sudo apt install -y nodejs
node --version                    # v24.x
```

## 3. PostgreSQL 18, la copia de root y los roles

```bash
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt install -y postgresql-18
sudo systemctl status postgresql   # active
```

Postgres escucha solo en `localhost` (es el valor por defecto; no cambies `listen_addresses`).

**Usuario del sistema.** Su casa no está en `/srv/villa`: ese árbol es de root.

```bash
sudo adduser --system --group --home /var/lib/villa --shell /usr/sbin/nologin villa
```

**Quién es dueño de qué.** Quien tome el usuario `villa` (el que corre la app) no debe poder cambiar lo que root ejecuta.

| Ruta | Dueño | Para qué |
|---|---|---|
| `/usr/local/sbin/*`, `/usr/local/share/villa/*`, unidades systemd | root | Lo que corre root o systemd. Viene de la copia de root |
| `/root/villa-kit` | root | Copia del repositorio en un tag verificado. Solo sirve para instalar el kit |
| `/srv/villa`, `/srv/villa/releases`, cada versión ya publicada | root | El código. `villa` lo lee y lo corre, pero no lo cambia |
| La carpeta de la versión **mientras se construye** | villa | Solo durante `npm ci` y el build; después pasa a root |
| `/var/lib/villa`, `/var/cache/villa` | villa | Su casa y la caché de Next |

**Copia de root.** Revisa el tag antes de instalar nada:

```bash
sudo git clone https://github.com/TU-USUARIO/villa.git /root/villa-kit
sudo git -C /root/villa-kit fetch --tags
sudo git -C /root/villa-kit checkout --detach v1.0.0
sudo git -C /root/villa-kit verify-tag v1.0.0     # si firmas tus tags; necesita tu llave pública en el llavero de root
sudo git -C /root/villa-kit rev-parse HEAD        # si no: compáralo con el commit del tag en GitHub
sudo bash /root/villa-kit/deploy/scripts/install-kit.sh
```

`install-kit.sh` se niega si algo de la copia no es de root, si otros pueden escribirlo, si no está parada en un tag o si tiene cambios locales.

**Roles de la base** ([src/db/roles/setup-roles.sql](../src/db/roles/setup-roles.sql)). El script crea la base `villa` y tres roles:
- `villa_owner`: dueño del esquema, solo migra.
- `villa_app`: la app y los trabajos del worker.
- `villa_queue`: la cola de pg-boss.

Pide las tres contraseñas. `\prompt` las **muestra** en pantalla: córrelo sin nadie mirando, sin grabar la terminal, y limpia la pantalla al terminar (`clear`). Genera cada contraseña con `openssl rand -base64 32` y guárdala en tu gestor de contraseñas.

```bash
sudo -u postgres psql -f /usr/local/share/villa/setup-roles.sql
clear
```

En una base nueva, la verificación del final sale con **0 filas**: es normal, porque aún no hay tablas. Los permisos se comprueban después de migrar (§6).

## 4. Secretos en /etc/villa

```bash
sudo install -d -m 0750 -o root -g postgres /etc/villa
sudo install -m 0600 -o root -g root /root/villa-kit/deploy/env/villa.env.example   /etc/villa/villa.env
sudo install -m 0600 -o root -g root /root/villa-kit/deploy/env/worker.env.example  /etc/villa/worker.env
sudo install -m 0600 -o root -g root /root/villa-kit/deploy/env/migrate.env.example /etc/villa/migrate.env
sudo nano /etc/villa/villa.env      # y luego worker.env y migrate.env
```

Qué va en cada uno:
- **`villa.env`:** `DATABASE_URL` con `villa_app` y los secretos de la app.
  - `BETTER_AUTH_SECRET`, `OTP_PEPPER` y `MANAGE_LINK_SECRET` se generan con `openssl rand -base64 48`. Los tres deben ser distintos.
  - `BETTER_AUTH_URL` y `PUBLIC_BASE_URL` van con `https://` y tu dominio.
- **`worker.env`:** `QUEUE_DATABASE_URL` con `villa_queue`. Solo la recibe el worker.
- **`migrate.env`:** `MIGRATION_DATABASE_URL` con `villa_owner`. Ningún servicio la recibe; solo el paso de migración.

Los tres archivos son de root con permiso `0600`. systemd los lee antes de pasar al usuario `villa`, así que el proceso de la app no puede leer el archivo.

**Permisos de `/etc/villa`.** La carpeta es `root:postgres 0750`: `villa` no entra, y `postgres` (el usuario del backup) entra solo a lo que le corresponde.

| Archivo | Dueño y permiso | Quién lo lee |
|---|---|---|
| `villa.env`, `worker.env`, `migrate.env`, `deploy.conf`, `backup.env` | `root:root 0600` | systemd o root, antes de soltar privilegios |
| `rclone.conf` (§8) | `postgres:postgres 0600` | El backup |
| `backup-recipients.txt` (§8) | `root:postgres 0640` | El backup: es una llave pública, y `postgres` no la puede cambiar por otra |
| `backup-identity.txt` (opcional, §8) | `postgres:postgres 0400` | La prueba automática de restauración |

> **`BETTER_AUTH_SECRET` no se rota a la ligera:** cifra el TOTP del dueño. Si se pierde o se cambia, el dueño queda fuera ([arquitectura.md](arquitectura.md#seguridad-estado-y-plan-auditorías-de-los-sprints-2-y-3-endurecimiento-del-sprint-4)). Guarda una copia sellada fuera del VPS, junto con la llave privada de los backups (§8).

Comprueba los permisos con `sudo ls -l /etc/villa`.

## 5. Servicios y Caddy

`install-kit.sh` (§3) ya instaló las unidades y los scripts. Falta activarlas y decirles de dónde sale el código:

```bash
echo 'REPO_URL=https://github.com/TU-USUARIO/villa.git' | sudo tee /etc/villa/deploy.conf
sudo chmod 0600 /etc/villa/deploy.conf
sudo systemctl enable villa-web villa-worker
```

Si el repositorio es privado, usa una *deploy key* de solo lectura para el usuario `villa`, en `/var/lib/villa/.ssh/`, y un `REPO_URL` del tipo `git@github.com:…`.

**Caddy** (repositorio oficial):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
sudo cp /root/villa-kit/deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # tu dominio y tu correo
sudo install -d -o caddy -g caddy -m 0750 /var/log/caddy
sudo systemctl daemon-reload          # toma la carpeta del socket de administración
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl restart caddy
sudo systemctl reload caddy && echo "reload OK"   # comprueba que reload llega por el socket
ls -l /run/caddy/admin.sock           # srw------- caddy caddy
```

La primera vez es `restart` y no `reload`: la API de administración pasa del puerto TCP al socket, y `reload` solo funciona contra la que está corriendo.
```

**Qué hace el Caddyfile:**
- **HTTPS y cabeceras:**
  - HTTPS automático, HSTS de 2 años, `nosniff`, `X-Frame-Options`, `Referrer-Policy` y `Permissions-Policy`.
  - Compresión zstd/gzip.
  - Un año de caché para `/_next/static`.
  - `no-store` y `no-referrer` en `/cita/*`.
- **Registro de acceso sin datos sensibles:**
  - las rutas sin consulta;
  - `/cita/<token>` como `/cita/`, sin el token;
  - sin cookies ni `Referer`;
  - la IP recortada (/24 en IPv4, /48 en IPv6).
- **Registro general (errores):** lleva los mismos filtros, porque también trae la petición.
- **Administración:** la API de Caddy está en un socket `0600`, no en un puerto. Un SSRF desde la app no la alcanza.
- **Tamaño:** las peticiones a `/api/*` no pasan de 64 KB.
- **IP del cliente:** Caddy **reemplaza** `X-Forwarded-For` por la IP que él validó. Así nadie la inventa, y los límites por IP de la app ven la IP real.

**Cloudflare delante (opcional):**
1. En el `Caddyfile`, descomenta `trusted_proxies` y `client_ip_headers`.
2. En Cloudflare, pon SSL/TLS en **Full (strict)**.
3. Para que nadie se salte Cloudflare, limita el 443 a sus rangos en ufw (`https://www.cloudflare.com/ips/`).

No hace falta tocar `src/lib/client-ip.ts`: Caddy ya le pasa a la app la IP real.

## 6. Primera publicación

```bash
sudo SKIP_BACKUP=1 /usr/local/sbin/deploy-release.sh v1.0.0
```

El script hace todo esto:
1. Crea `/srv/villa/releases/<fecha>`, de `villa` solo mientras se construye, y clona ahí.
2. Corre `npm ci --ignore-scripts`: ninguna dependencia ejecuta scripts de instalación.
3. Corre `npm run build` solo con las variables `NEXT_PUBLIC_*`: ningún secreto llega al build.
4. Pasa todo a root y quita la escritura. Arma el standalone: copia `.next/static` y enlaza la caché a `/var/cache/villa/next`.
5. Corre las migraciones como `villa_owner` con `migrate.mjs`. Cada migración aplica los permisos de `villa_app`.
6. Apunta `/srv/villa/current` a la versión nueva.
7. Reinicia los dos servicios y espera a que `/api/health` responda.

`SKIP_BACKUP=1` solo la primera vez, porque los backups se configuran en §8. Después **nunca**.

Comprueba:

```bash
systemctl status villa-web villa-worker          # active (running)
curl -s http://127.0.0.1:3000/api/health          # {"ok":true,"app":"villa"}
curl -sI https://reservas.TU-DOMINIO.co | grep -i -E 'strict-transport|content-security'
stat -c '%U %a %n' /srv/villa /srv/villa/releases /srv/villa/current/package.json   # root en las tres
ss -ltnp | grep 3000                              # 127.0.0.1:3000, NUNCA 0.0.0.0
journalctl -u villa-worker -n 20                  # "[worker] Villa worker arrancó"
# Permisos: las tres columnas deben decir f (villa_app no edita ni borra el libro, ni crea tablas).
sudo -u postgres psql -d villa -c "SELECT has_table_privilege('villa_app','journal_entries','UPDATE'), has_table_privilege('villa_app','journal_entries','DELETE'), has_schema_privilege('villa_app','public','CREATE')"
```

**La sede y el dueño:**

```bash
sudo /usr/local/sbin/villa-run.sh npm run db:seed
sudo /usr/local/sbin/villa-run.sh npm run staff:create-owner
```

`create-owner` pide el nombre, el correo y la contraseña. La contraseña tiene mínimo 12 caracteres y no se muestra al escribirla.

**Verificación en dos pasos (TOTP) de inmediato:**
1. Entra a `https://reservas.TU-DOMINIO.co/ingresar` con esa cuenta. Villa te manda a **Mi cuenta → Verificación**.
2. Escanea o escribe la clave en tu app de autenticación (Google Authenticator, Microsoft Authenticator o 1Password).
3. Confirma con un código.
4. **Guarda los 10 códigos de respaldo** fuera del celular: impresos o en el gestor de contraseñas.

Hazlo apenas crees la cuenta. Mientras no haya TOTP inscrito, quien tenga la contraseña podría inscribir el suyo.

**Activar la reserva en línea:** en el panel, **Ajustes**. Después, abre `/reservar`. Si dice "Por ahora reservamos por teléfono", falta una variable; el registro dice cuál, sin mostrar su valor: `journalctl -u villa-worker | grep "en pausa"`.

## 7. Publicar una versión nueva

```bash
sudo /usr/local/sbin/deploy-release.sh v1.2.0
```

Antes de migrar, el script **siempre** hace un backup cifrado. Si `/api/health` no responde después del cambio, vuelve sola a la versión anterior.

**Si la versión cambió algo en `deploy/` o `setup-roles.sql`,** actualiza primero la copia de root:

```bash
sudo git -C /root/villa-kit fetch --tags
sudo git -C /root/villa-kit checkout --detach v1.2.0
sudo git -C /root/villa-kit verify-tag v1.2.0     # o compara rev-parse HEAD con GitHub
sudo bash /root/villa-kit/deploy/scripts/install-kit.sh
```

### Volver atrás

```bash
sudo /usr/local/sbin/rollback.sh previous      # a la versión anterior registrada
sudo /usr/local/sbin/rollback.sh 20261105T150000Z   # a una en particular (ls /srv/villa/releases)
```

`rollback.sh` exige que digas a cuál, y cambia **el código, no la base**:
- Las migraciones de Villa solo agregan: tablas, columnas, funciones y triggers. El código anterior sigue funcionando con el esquema nuevo.
- Si una migración dañó datos, para y restaura el backup que el deploy hizo justo antes:
  1. `sudo systemctl stop villa-web villa-worker`
  2. Restaura en `villa_restore` y compara (§9).
  3. Si hay que volver, restaura con `--replace` sobre `villa`, con los servicios detenidos.
  4. `rollback.sh` al código anterior y `sudo systemctl start villa-web villa-worker`.
- **Antes de reemplazar producción**, mira qué movimientos se registraron después del backup. Esos cobros hay que volver a registrarlos a mano: el libro es solo-inserción y nada se "pierde en silencio".

## 8. Backups cifrados

**Llaves de age.** Créalas **en tu computador**, no en el VPS:

```bash
age-keygen -o villa-backup-identity.txt     # muestra la llave pública: age1...
```

- **La privada** (`villa-backup-identity.txt`) descifra los backups. Guárdala en dos lugares fuera del VPS: el gestor de contraseñas y una USB o un papel en sobre sellado. Guárdala **junto con `BETTER_AUTH_SECRET`**: sin las dos no se recupera la operación.
- **La pública** (`age1…`) va al VPS. Con ella solo se puede cifrar.
- Si quieres que alguien más pueda descifrar (el contador o un socio), agrega su llave pública como otra línea del mismo archivo.

```bash
echo 'age1TU-LLAVE-PUBLICA' | sudo tee /etc/villa/backup-recipients.txt
sudo chown root:postgres /etc/villa/backup-recipients.txt && sudo chmod 0640 /etc/villa/backup-recipients.txt
```

**Bucket.** La idea: quien tome el VPS puede subir backups nuevos, pero **no puede borrar los que ya están**. Por eso la llave del VPS no borra, y la retención la hace el bucket con reglas por prefijo.

| Prefijo | Borrar a los | Para qué |
|---|---|---|
| `daily/` | 7 días | Backup de todos los días |
| `weekly/` | 28 días | Domingos (4 semanas) |
| `monthly/` | 366 días | Día 1 (12 meses) |
| `erasures/` | 400 días | Lista de supresiones de clientes (§11). Debe durar más que cualquier backup |

- **Backblaze B2:**
  1. Crea un bucket privado, p. ej. `villa-backups-xxxx`, con **Object Lock activado** y retención por defecto de **7 días**. Object Lock solo se puede activar al crear el bucket.
  2. En *Lifecycle Settings*, crea las reglas de la tabla con *custom lifecycle rules*: `daysFromUploadingToHiding` con esos días y `daysFromHidingToDeleting` en 1.
  3. Crea una *Application Key* restringida a ese bucket, con permisos para listar, leer y escribir archivos, **sin `deleteFiles`**.
- **Cloudflare R2:**
  1. Crea el bucket.
  2. En sus *Object lifecycle rules*, crea las reglas de la tabla.
  3. En *Bucket lock rules*, crea una regla sin prefijo de 7 días. Prevalece sobre las reglas de ciclo de vida.
  4. Crea un *API token* de R2 limitado a ese bucket. Si el permiso de escritura también deja borrar, lo que protege los backups es el bloqueo de 7 días; revísalo en los permisos del token.

Si el VPS cae en malas manos, cámbiale la llave y revisa el bucket **antes de 7 días**: es lo que dura la protección sobre lo más nuevo. Los backups de más de 7 días solo los borran las reglas, según su plazo.

**rclone.**

```bash
sudo rclone config --config /etc/villa/rclone.conf
#   n) New remote → nombre "b2" (o "r2")
#   B2: tipo "b2", account = keyID, key = applicationKey
#   R2: tipo "s3", provider "Cloudflare", access_key_id / secret_access_key, endpoint https://<cuenta>.r2.cloudflarestorage.com
sudo chown postgres:postgres /etc/villa/rclone.conf && sudo chmod 0600 /etc/villa/rclone.conf
sudo -u postgres rclone --config /etc/villa/rclone.conf lsd b2:    # debe listar tu bucket
```

**Activar:**

```bash
sudo install -m 0600 -o root -g root /root/villa-kit/deploy/backup/backup.env.example /etc/villa/backup.env
sudo nano /etc/villa/backup.env          # RCLONE_REMOTE=b2:villa-backups-xxxx
sudo install -d -m 0700 -o postgres -g postgres /var/backups/villa
sudo systemctl enable --now villa-backup.timer
sudo systemctl start villa-backup.service && journalctl -u villa-backup -n 5    # "villa-backup: ok …"
sudo -u postgres rclone --config /etc/villa/rclone.conf ls b2:villa-backups-xxxx/daily
sudo -u postgres rclone --config /etc/villa/rclone.conf delete b2:villa-backups-xxxx/daily   # debe FALLAR o no borrar nada; si borró, la llave está mal
```

**Cómo funciona:**
- **Cifrado en el camino:** `pg_dump` en formato custom pasa directo por `age` con la llave pública. El dump en claro nunca toca el disco.
- **Roles:** también se respaldan, sin contraseñas (`pg_dumpall --globals-only`).
- **Destinos en el bucket:** `daily/` todos los días, `weekly/` los domingos, `monthly/` el día 1 y `erasures/` todos los días. Cada uno lleva su `.sha256`.
- **En el VPS** quedan solo los 2 últimos, también cifrados.
- **Si falla,** `villa-alert@` deja un error en el journal y llama a `ALERT_WEBHOOK_URL` si la configuraste.
- **Recomendado:** un ping de vida en `HEALTHCHECK_URL` (healthchecks.io, gratis). Si un día no llega, te avisan, aunque el VPS esté caído.

**Custodia de las llaves: la decisión que tienes que tomar.** La prueba de restauración automática (§9) necesita la llave **privada** en el VPS, en `/etc/villa/backup-identity.txt` (`0400 postgres:postgres`).

- **Sin la privada en el VPS (más seguro):** quien entre al VPS no puede leer backups viejos. Tú haces la prueba a mano cada mes (§9).
- **Con la privada en el VPS:** la prueba es automática. Pero quien entre al VPS como root puede descifrar los backups que estén en el bucket. Igual ya tendría la base viva, así que el riesgo extra son solo los datos viejos.

Recomendación: **empieza sin la llave en el VPS** y haz la prueba a mano el primer trimestre. Si la olvidas, pasa a la automática. En ambos casos el cifrado protege lo importante: que el proveedor del bucket, o quien robe sus credenciales, no pueda leer nada.

## 9. Restaurar y prueba mensual

**Rol para probar backups.** Una base de prueba se restaura como `villa_restore`, sin superusuario: si un dump estuviera alterado, solo alcanza esa base. El usuario `postgres` entra como ese rol sin contraseña, solo a las bases de prueba:

```bash
sudo -u postgres psql -c "CREATE ROLE villa_restore LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
echo 'villa_restore  postgres  villa_restore' | sudo tee -a /etc/postgresql/18/main/pg_ident.conf
sudo sed -i '1i local  villa_restore_test,villa_restore  villa_restore  peer map=villa_restore' /etc/postgresql/18/main/pg_hba.conf
sudo systemctl reload postgresql
```

**Prueba automática** (solo si dejaste la llave privada en el VPS):

```bash
echo 'AGE_IDENTITY_FILE=/etc/villa/backup-identity.txt' | sudo tee -a /etc/villa/backup.env
sudo systemctl enable --now villa-restore-test.timer
sudo systemctl start villa-restore-test.service && journalctl -u villa-restore-test -n 30
```

Cada día 5 la prueba:
1. baja el último `daily/` y verifica su SHA-256 (sin suma, no restaura);
2. lo descifra y lo restaura en `villa_restore_test` como `villa_restore`;
3. aplica los permisos de la app, corre `sanity.sql` y borra la base temporal.

`sanity.sql` revisa:
- que todo asiento cuadre y tenga al menos 2 líneas;
- que ninguna línea tenga los dos lados ni montos negativos;
- que el efectivo (1105) de cada sede sea ≥ 0;
- que el balance de prueba dé cero por sede;
- que existan y estén activos los triggers de garantía;
- que `villa_app` no tenga `TEMPORARY`, ni pueda crear objetos, ni editar el libro, ni alcanzar `pgboss`.

Termina con `cordura: OK`.

**Prueba a mano** (sin la llave en el VPS), una vez al mes, unos 10 minutos:
1. Copia la llave privada **temporalmente** al VPS:
   ```bash
   scp villa-backup-identity.txt admin@VPS:/tmp/k.txt
   ```
2. Corre la prueba:
   ```bash
   sudo install -m 0400 -o postgres /tmp/k.txt /run/villa-k.txt && rm /tmp/k.txt
   sudo systemd-run --pty --wait --uid=postgres -p EnvironmentFile=/etc/villa/backup.env \
     -E AGE_IDENTITY_FILE=/run/villa-k.txt /usr/local/sbin/villa-restore.sh latest villa_restore_test --replace
   sudo -u postgres dropdb villa_restore_test
   sudo shred -u /run/villa-k.txt
   ```
3. Anota la fecha y el resultado (`cordura: OK`) en una hoja de control.

**Restauración real** (desastre, VPS nuevo):
1. Sigue los pasos 1 a 5 de este documento. Usa los **mismos** secretos de `villa.env`, en especial `BETTER_AUTH_SECRET`.
2. Corre `setup-roles.sql`, que crea los roles y la base.
3. Crea el rol `villa_restore` y prueba el backup primero en `villa_restore`, como arriba. Una restauración sobre `villa` corre como superusuario y confía en el archivo.
4. Con los servicios detenidos, restaura sobre `villa`:
   ```bash
   sudo systemd-run --pty --wait --uid=postgres -p EnvironmentFile=/etc/villa/backup.env \
     -E AGE_IDENTITY_FILE=/run/villa-k.txt /usr/local/sbin/villa-restore.sh latest villa --replace
   ```
   Conserva los dueños, vuelve a aplicar el endurecimiento de la base (`REVOKE … FROM PUBLIC`, sin `TEMPORARY` para la app), corre `sanity.sql` y vuelve a aplicar las supresiones de clientes (§11). Si reporta un cliente que no pudo suprimir, resuélvelo antes de abrir.
5. `deploy-release.sh` con la misma versión que tenías.
6. Verifica que el dueño entre con su TOTP.

## 10. CSP: semana de prueba y bloqueo

La política de scripts con *nonce* (`src/proxy.ts`, `src/lib/csp.ts`) **bloquea por defecto en producción**. `CSP_ENFORCE=false` la deja en modo reporte:
- Los navegadores mandan cada violación a `/api/csp-report`.
- El servidor la deja en el registro sin datos personales: directiva, origen bloqueado y ruta sin consulta ni token.
- Al arrancar, el registro avisa que no está bloqueando.

**Semana de prueba: es un paso obligatorio del lanzamiento.** La plantilla de `villa.env` ya trae `CSP_ENFORCE=false`. Déjala así la primera semana y revisa:

```bash
journalctl -u villa-web --since "7 days ago" | grep '\[csp\]' | sort | uniq -c | sort -rn | head
```

Mientras tanto, comprueba:
- que `/reservar` complete el Turnstile;
- que el panel y el ingreso funcionen;
- que hayas abierto la app instalada en el celular del dueño.

**Al terminar la semana sin violaciones propias,** borra la línea y reinicia:

```bash
sudo sed -i '/^CSP_ENFORCE=/d' /etc/villa/villa.env
sudo systemctl restart villa-web
curl -sI https://reservas.TU-DOMINIO.co/reservar | grep -i '^content-security-policy:'
```

**Para volver atrás,** pon `CSP_ENFORCE=false` y reinicia.

**Violaciones que no debes permitir:**
- `script-src` con `blocked: "inline"` en una página propia es un bug: falta el nonce, o la página quedó estática; hay que hacerla dinámica.
- Un origen desconocido en `script-src` puede ser una extensión del navegador (ruido) o un intento de inyección. Si se repite en muchos usuarios, investígalo.

## 11. Operación diaria

| Para | Comando |
|---|---|
| Ver si todo anda | `systemctl status villa-web villa-worker caddy postgresql` |
| Registro de la app | `journalctl -u villa-web -f` (y `-u villa-worker`) |
| Accesos (sin tokens ni consultas) | `sudo tail -f /var/log/caddy/villa-access.log` |
| Desbloquear a alguien | `sudo /usr/local/sbin/villa-run.sh npm run staff:unlock -- correo@ejemplo.com` |
| Último backup | `journalctl -u villa-backup -n 3` y `sudo -u postgres rclone --config /etc/villa/rclone.conf ls b2:villa-backups-xxxx/daily` |
| Espacio en disco | `df -h /` y `sudo du -sh /var/lib/postgresql /var/log/caddy /var/backups/villa` |

**Avisos que llegan al correo del dueño (`ALERT_EMAIL`):**
- **Bloqueo por intentos fallidos:**
  - Llega como mucho un correo cada 15 minutos, con todos los bloqueos juntos.
  - Primero las cuentas del equipo, por el nombre que le pusiste en Personal. Si no reconoces esos intentos, cambia tu contraseña.
  - Los correos que no son del equipo van en una sola línea con el conteo: cualquiera en internet los puede provocar. Nunca incluye la IP ni el correo escrito.
- **80 % de la cuota diaria de mensajes.**

**Mantenimiento automático** (worker, 03:00):
- borra contadores viejos;
- anonimiza reservas nunca confirmadas (7 días);
- **purga los datos personales vencidos:**
  - IP, navegador, nombre y correo escritos al pedir el código, y el contenido de los avisos: **30 días**;
  - registro de quién vio el celular de un cliente: **365 días**;
  - lo de un cliente anonimizado se purga sin esperar esos plazos, en la siguiente corrida.

Las retenciones están en `src/domain/clients/retention.ts` y en la migración 0012. La política de privacidad (versión 2026-11-02) las cita.

**Si un cliente pide suprimir sus datos (Ley 1581):** en el panel, **Clientes**, búscalo y usa **Suprimir** (solo el dueño, con confirmación de identidad). No se puede mientras tenga citas activas: cancélalas primero. Antes, revisa con el abogado si hay un deber legal de guardar algo de esa persona.

- **Se borra:** nombre, celular, correo, notas, motivos, la IP y el navegador del consentimiento, el contenido de los avisos y los enlaces activos de sus citas.
- **Se queda, por ley:** las ventas y el libro, apuntando al cliente ya anónimo. La autorización conserva qué aceptó y cuándo.
- **Queda constancia:** un evento `client.erase` en la bitácora, solo con el id interno del cliente, sin datos personales.

**Supresiones y backups.** Los backups ya hechos no se editan: el dato sale de ellos cuando cada copia vence, hasta 12 meses (la política de privacidad lo dice).

Si se restaura una copia anterior a la supresión, el dato volvería. Por eso cada backup sube a `erasures/` la lista acumulada de supresiones, cifrada y aparte del dump, y `villa-restore.sh` vuelve a aplicar la más nueva al restaurar sobre `villa` (§9). La lista lleva ids y no un hash del celular: el id es el mismo en cualquier copia, y el hash de un celular colombiano se revierte fácil.

## 12. Lista de chequeo antes de abrir al público

- [ ] `ss -ltnp` muestra Next solo en `127.0.0.1:3000`, y `ufw status` solo 22, 80 y 443.
- [ ] `systemctl show villa-web -p Environment` incluye `NODE_ENV=production` y `HOSTNAME=127.0.0.1`.
- [ ] `/etc/villa/*.env` son `0600 root`, y ninguno está en el repositorio.
- [ ] La comprobación de permisos de §6 dio `f` en todas las columnas, y la app corre con `villa_app`: en `psql`, `SELECT usename FROM pg_stat_activity WHERE datname='villa'` muestra `villa_app` y `villa_queue`.
- [ ] El dueño entra con TOTP y guardó sus códigos de respaldo.
- [ ] Hubo un backup en el bucket y **una restauración probada** con `cordura: OK`.
- [ ] La llave privada de age y `BETTER_AUTH_SECRET` están guardados fuera del VPS, en dos lugares.
- [ ] Una reserva de prueba completa: Turnstile, código por WhatsApp, enlace `/cita/…`. Después, en el registro de Caddy aparece `/cita/`, sin el token.
- [ ] `stat` de §6 muestra `/srv/villa`, `releases/` y el código como de root.
- [ ] El bucket tiene bloqueo y reglas por prefijo, y la prueba de borrado de §8 no borró nada.
- [ ] La CSP lleva una semana en modo reporte sin violaciones propias, y se borró `CSP_ENFORCE=false` de `villa.env`.
- [ ] La política de privacidad tiene los datos del responsable (`[Razón social]`, `[NIT]`…), completados con el abogado.
- [ ] La prueba de penetración del sprint 5 se hizo contra este entorno (nunca contra terceros).
