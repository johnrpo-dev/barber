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
| `npm run worker` | Proceso de jobs (pg-boss): recordatorios y expiraciones |
| `npm run db:generate` | Genera una migración a partir de `src/db/schema.ts` |
| `npm run db:migrate` | Aplica las migraciones |
| `npm run db:seed` | Crea la sede de Villa con su plan de cuentas (no duplica si ya existe) |
| `npm run staff:create-owner` | Crea la cuenta del dueño; la contraseña se escribe oculta |
| `npm run staff:unlock -- <correo>` | Quita los bloqueos por intentos fallidos de esa cuenta (ingreso, reautenticación, código de la app). Necesita `BETTER_AUTH_SECRET` |
| `npm run test:e2e` | Pruebas de extremo a extremo. La primera vez, instala el navegador con `npx playwright install chromium` |
