# Ambiente de pruebas en un VPS aparte

**Para qué:** que el dueño de la barbería pruebe Villa desde su celular, con HTTPS y datos de prueba, antes del lanzamiento. Decisión del 2026-11-06: VPS propio para Villa y un subdominio de NailsLu (por ejemplo `villa-demo.nailslu.com`).

**Lo que NO se toca de NailsLu:** su servidor, su código, su base de datos y su configuración. El único cambio es **agregar un registro DNS**. Para deshacerlo todo: borrar ese registro y eliminar el VPS.

Esta guía sigue [despliegue.md](despliegue.md) (la de producción) y dice solo qué cambia. Donde allá diga `reservas.TU-DOMINIO.co`, aquí va tu subdominio.

## 0. Lo que consigues tú

| Qué | Dónde | Notas |
|---|---|---|
| **VPS** con Ubuntu 24.04, 4 GB de RAM y 40 GB de disco | Hetzner (CX22), DigitalOcean, Vultr | Unos 5–12 USD al mes. Con 4 GB la compilación no se queda sin memoria. Se puede borrar al terminar las pruebas |
| **Registro DNS** `villa-demo` tipo A con la IP del VPS (y AAAA si tiene IPv6) | Donde administras el DNS de `nailslu.com` | **Solo agregar.** No edites ni borres los registros de NailsLu ni cambies los *nameservers*. Si el DNS está en Cloudflare, ponlo en **"DNS only" (nube gris)** |
| **Turnstile** (anti-bots) | Cloudflare → Turnstile → Add widget | Gratis. Hostname: tu subdominio. Te da la *site key* y la *secret key* |
| **WhatsApp de prueba** | developers.facebook.com → Crear app (tipo Business) → WhatsApp | No exige verificar el negocio. Meta da un **número de prueba** que envía mensajes reales a **hasta 5 celulares** que registres. Ver §4 |
| **Llave SSH** | Tu computador | Para entrar al VPS sin contraseña |

El correo (Resend) es opcional en pruebas. Sin él, los avisos solo van por WhatsApp.

## 1. Servidor, Node y Postgres

Sigue [despliegue.md](despliegue.md) §1, §2 y §3 tal cual: usuario administrador, SSH solo con llave, firewall (22, 80 y 443), Node 24, PostgreSQL 18 y los tres roles de la base.

**La copia de root va en un tag.** `install-kit.sh` se niega si no lo está. En §3 de la guía grande cambia `v1.0.0` por el tag de pruebas (`v0.7.0`).

**El repositorio es privado.** Hace falta una *deploy key* de solo lectura. `deploy-release.sh` clona como el usuario `villa`, así que la llave vive en su casa. Créala **después** de `adduser … villa` (§3 de la guía grande) y **antes** de la copia de root:

```bash
sudo install -d -o villa -g villa -m 0700 /var/lib/villa/.ssh
sudo -u villa ssh-keygen -t ed25519 -N "" -C villa-pruebas -f /var/lib/villa/.ssh/id_ed25519
ssh-keyscan -t ed25519 github.com | sudo -u villa tee /var/lib/villa/.ssh/known_hosts
ssh-keygen -lf /var/lib/villa/.ssh/known_hosts
sudo cat /var/lib/villa/.ssh/id_ed25519.pub
```

- La huella que imprime `ssh-keygen -lf` debe ser `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`. Es la que GitHub publica en *GitHub's SSH key fingerprints*. Si no coincide, para.
- Pega la llave pública (la última línea) en GitHub → repositorio `barber` → Settings → Deploy keys → Add deploy key, **sin** marcar "Allow write access".

La copia de root usa la misma llave. En §3 de la guía grande, cambia el `git clone` por:

```bash
sudo git -c core.sshCommand="ssh -i /var/lib/villa/.ssh/id_ed25519 -o UserKnownHostsFile=/var/lib/villa/.ssh/known_hosts" \
  clone git@github.com:johnrpo-dev/barber.git /root/villa-kit
sudo git -C /root/villa-kit config core.sshCommand "ssh -i /var/lib/villa/.ssh/id_ed25519 -o UserKnownHostsFile=/var/lib/villa/.ssh/known_hosts"
```

Lo demás de §3 sigue igual (`fetch --tags`, `checkout --detach v0.7.0`, `install-kit.sh`).

## 2. Secretos

Sigue [despliegue.md](despliegue.md) §4, con estos cambios en `/etc/villa/villa.env`:

- `BETTER_AUTH_URL` y `PUBLIC_BASE_URL`: `https://villa-demo.nailslu.com` (tu subdominio).
- Turnstile: las dos llaves del paso 0.
- WhatsApp: ver §4 de esta guía.
- **Borra** las líneas de `RESEND_API_KEY`, `EMAIL_FROM` y `ALERT_EMAIL` si no vas a usar correo. Dejarlas con `CAMBIAR` haría que la app intente enviar con una llave falsa.
- **Agrega** `PORTAL_REFERENCE_PHOTOS=1`: la portada muestra las fotos de referencia mientras no haya fotos reales. En producción esta línea no va.
- `CSP_ENFORCE=false` se queda así en pruebas.

Genera cada secreto con `openssl rand -base64 48`. Son distintos a los de tu computador y a los que tendrá producción.

## 3. Servicios y Caddy

Sigue [despliegue.md](despliegue.md) §5. En `/etc/villa/deploy.conf` va el repositorio por SSH:

```bash
echo 'REPO_URL=git@github.com:johnrpo-dev/barber.git' | sudo tee /etc/villa/deploy.conf
```

En `/etc/caddy/Caddyfile`, además de poner el subdominio y tu correo, agrega esta línea dentro del primer bloque `header { … }`:

```
		X-Robots-Tag "noindex, nofollow"
```

Así Google no indexa el ambiente de pruebas bajo el dominio de NailsLu. Luego `sudo caddy validate --config /etc/caddy/Caddyfile` y `sudo systemctl restart caddy`.

## 4. WhatsApp de prueba

1. En developers.facebook.com, crea una app tipo **Business** y agrega **WhatsApp**.
2. En **WhatsApp → API Setup**:
   - copia el **Phone number ID** del número de prueba → `WHATSAPP_PHONE_NUMBER_ID`;
   - en **"To"**, agrega y verifica los celulares que van a probar (máximo 5): el tuyo y el del dueño.
3. El token de esa pantalla **vence en 24 horas**. Para uno que dure: Business Settings → Usuarios del sistema → crea uno con rol de administrador → asígnale la app y la cuenta de WhatsApp → genera un token con los permisos `whatsapp_business_messaging` y `whatsapp_business_management` → `WHATSAPP_TOKEN`.
4. App → Configuración → Básica → **Clave secreta de la app** → `WHATSAPP_APP_SECRET`.
5. **Plantillas.** Villa solo envía plantillas aprobadas, en idioma **Español (`es`)**. Créalas en el administrador de WhatsApp (WhatsApp Manager → Plantillas de mensajes). Las de tipo *Utilidad* suelen aprobarse en minutos.

   Cada variable va en el orden de la tabla: `{{1}}`, `{{2}}`, etc. El botón de URL es de tipo **dinámico**, con la URL `https://villa-demo.nailslu.com/cita/{{1}}`. Villa le pasa el token de la cita.

   | Nombre | Categoría | Variables del cuerpo, en orden | Botón |
   |---|---|---|---|
   | `villa_reserva_confirmada` | Utilidad | nombre, servicio, barbero, fecha, hora, número de reserva | URL |
   | `villa_recordatorio` | Utilidad | nombre, hora, servicio, dirección | URL |
   | `villa_cita_reprogramada` | Utilidad | nombre, servicio, barbero, fecha, hora | URL |
   | `villa_cita_cancelada` | Utilidad | nombre, fecha, hora | URL |
   | `villa_cita_cancelada_sede` | Utilidad | nombre, fecha, hora | — |
   | `villa_recibo` | Utilidad | nombre, número, fecha, servicios, total, medio de pago | — |
   | `villa_otp` | Autenticación | el código | Copiar código |

   **Reglas de Meta:**
   - el texto no puede empezar ni terminar con una variable;
   - no puede haber dos variables seguidas;
   - el cuerpo de `villa_recordatorio` termina con "Si faltas sin avisar, tu reserva en línea puede quedar suspendida." ([sprint-7-walk-in-faltas.md](sprint-7-walk-in-faltas.md) §4).

   Hay un ejemplo de cuerpo para `villa_recibo` en [sprint-3-reserva-publica.md](sprint-3-reserva-publica.md) §9. Para probar basta con `villa_reserva_confirmada` y `villa_recordatorio`; las demás se pueden agregar después.

**Mientras una plantilla no esté aprobada**, Villa sigue funcionando: la cita queda confirmada y ese aviso queda registrado como no enviado. Lo mismo pasa con un celular que no esté entre los 5 registrados.

## 5. Primera publicación

Sigue [despliegue.md](despliegue.md) §5 y §6 con el tag de pruebas:

```bash
sudo SKIP_BACKUP=1 /usr/local/sbin/deploy-release.sh v0.7.0
```

En pruebas no configuramos los backups (§8 de la guía grande), así que **cada** publicación lleva `SKIP_BACKUP=1`. Los datos son de prueba; en producción esto no se hace nunca.

Comprueba como dice §6: los servicios activos, `/api/health` y los permisos de `villa_app`.

## 6. Datos de prueba

**La sede y tu cuenta de dueño**, en el VPS:

```bash
sudo /usr/local/sbin/villa-run.sh npm run db:seed
sudo /usr/local/sbin/villa-run.sh npm run staff:create-owner
```

Inscribe la verificación en dos pasos apenas entres (§6 de la guía grande).

**El catálogo y el equipo** (`seed-demo`) no corren en el VPS: se niegan con `NODE_ENV=production`, a propósito. Se cargan desde tu computador por un túnel SSH, con tu `seed-demo.equipo.local.json`. Desde Git Bash, en la carpeta del proyecto:

```bash
ssh -N -L 5433:127.0.0.1:5432 admin@IP-DEL-VPS
```

Deja esa ventana abierta. En otra:

```bash
read -rs -p "Contraseña de villa_app en el VPS: " PGPW && echo
DATABASE_URL="postgres://villa_app:${PGPW}@localhost:5433/villa" npm run db:seed-demo
unset PGPW
```

- `read -rs` no muestra la contraseña ni la guarda en el historial.
- La variable que pones en la línea manda sobre la del `.env` de tu computador.
- `seed-demo` crea también las cuentas `recepcion@villa.test` y `barbero@villa.test`, y muestra su contraseña **una sola vez**: guárdala para probar el panel como cada rol.
- Si una contraseña tiene caracteres como `@`, `/` o `:`, genera otra con `openssl rand -hex 24` (sin símbolos) para no tener que codificarla en la URL.

Cierra el túnel (Ctrl+C) al terminar.

**Activa la reserva en línea** en el panel → Ajustes, y abre `/reservar` desde el celular.

## 7. Qué probar con el dueño

- Reservar desde su celular, sin código, y que le llegue la confirmación por WhatsApp.
- Agenda: walk-in, "Salió / Llegó", marcar "No vino" dos veces y desbloquear.
- Cobro, caja, recibo y cierre del día.
- El panel como recepción y como barbero, con las cuentas de prueba.

## 8. Publicar cambios

```bash
sudo SKIP_BACKUP=1 /usr/local/sbin/deploy-release.sh v0.7.1
```

Con cada tag nuevo que publique Claude. Si cambió algo en `deploy/`, actualiza antes la copia de root (§7 de la guía grande).

## 9. Al terminar las pruebas

- **Datos personales (Ley 1581):** si el dueño registró clientes reales, no se pasan a producción. Producción arranca con una base nueva.
- **Apagarlo todo:** elimina el VPS en el panel del proveedor y borra el registro `villa-demo` del DNS. NailsLu queda exactamente como estaba.
- **La deploy key:** bórrala de GitHub → Settings → Deploy keys.
