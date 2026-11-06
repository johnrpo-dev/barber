# Villa

Sistema de la barbería Villa. Tiene dos partes:
- **Portal web de reservas**, para que los clientes agenden desde el celular.
- **Panel interno**, para la agenda, el cobro, la caja, los gastos, las comisiones y los informes contables.

- Por qué está construido así: [docs/arquitectura.md](docs/arquitectura.md)
- Alcance, flujos y decisiones del equipo: [docs/00-descubrimiento.md](docs/00-descubrimiento.md)

## Requisitos

- Node.js 24 o superior.
- PostgreSQL 18.

## Instalación

1. Crear la base de datos y el rol (en `psql` como superusuario; cambia la contraseña):

   ```sql
   CREATE ROLE villa LOGIN PASSWORD 'cambia-esto';
   CREATE DATABASE villa OWNER villa;
   ```

2. Configurar el entorno:

   ```bash
   copy .env.example .env
   ```

   Edita `.env` y pon la contraseña en `DATABASE_URL`. En `BETTER_AUTH_SECRET` pon un valor
   aleatorio de al menos 32 caracteres (es la llave que firma las sesiones; no se comparte).

3. Instalar dependencias:

   ```bash
   npm install
   ```

4. Preparar la base: migraciones, sede con su plan de cuentas y la cuenta del dueño.

   ```bash
   npm run db:migrate
   npm run db:seed
   npm run staff:create-owner
   ```

   El último comando pide nombre, correo y contraseña (mínimo 12 caracteres, no se muestra
   al escribirla). Luego se ingresa en http://localhost:3000/ingresar.

## Uso

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo en http://localhost:3000 |
| `npm test` | Pruebas unitarias y de propiedades (Vitest + fast-check) |
| `npm run typecheck` | Verificación de tipos |
| `npm run build` | Build de producción (standalone) |
| `npm run worker` | Proceso de jobs (pg-boss): envía los recibos, confirmaciones y recordatorios; expiraciones, mantenimiento (incluye la purga de datos personales vencidos) y avisos de seguridad. Late cada minuto: si no late, Caja e Inicio avisan que los envíos están detenidos. En desarrollo, ver la nota de abajo |
| `npm run db:generate` | Genera una migración a partir de `src/db/schema.ts` |
| `npm run db:migrate` | Aplica las migraciones |
| `npm run db:seed` | Crea la sede de Villa con su plan de cuentas (no duplica si ya existe) |
| `npm run db:seed-demo` | Solo desarrollo: servicios, cuatro barberos con horario, teléfono de prueba y reserva en línea abierta (no duplica) |
| `npm run staff:create-owner` | Crea la cuenta del dueño; la contraseña se escribe oculta |
| `npm run staff:unlock -- <correo>` | Quita los bloqueos por intentos fallidos de esa cuenta (ingreso, reautenticación, código de la app). Necesita `BETTER_AUTH_SECRET` |
| `npm run test:e2e` | Pruebas de extremo a extremo. La primera vez, instala el navegador con `npx playwright install chromium` |

**Recibos, recordatorios y avisos en desarrollo.** `npm run dev` solo encola los mensajes; los envía
el worker. Para verlos salir, corre también el worker de desarrollo en otra terminal (fija
`NODE_ENV=development`; `npm run worker` sin esa variable se trata como producción y, sin
credenciales, deja los envíos en pausa):

```bash
npm run worker:dev
```

Sin credenciales de WhatsApp (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`) ni de Resend
(`RESEND_API_KEY`, `EMAIL_FROM`), los mensajes no salen: aparecen en la consola del worker
(`[notify:consola] …`, con el destino enmascarado). La hoja de cobro lo dice ("Modo de prueba").
Si el worker no corre, Caja e Inicio muestran que los envíos están detenidos y los mensajes esperan en
cola hasta que arranque (los de más de 2 días ya no se envían).

## Despliegue

El paso a paso para montar Villa en un VPS con Ubuntu 24.04 está en [docs/despliegue.md](docs/despliegue.md): PostgreSQL 18 y sus roles, Caddy, systemd, primer dueño con verificación en dos pasos, backups cifrados con prueba de restauración, y cómo volver atrás. Los archivos están en [`deploy/`](deploy).

La política de scripts (CSP) bloquea en producción. `CSP_ENFORCE=false` la deja solo reportando: es la semana de prueba del lanzamiento y la vuelta atrás (runbook, §10). En desarrollo solo reporta.
