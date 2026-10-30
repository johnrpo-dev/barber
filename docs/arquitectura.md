# Arquitectura: Villa

**Fecha:** 2026-10-28 · **Firma:** CTO del proyecto · **Contexto completo:** [00-descubrimiento.md](00-descubrimiento.md)

## Qué entendí

Villa es una barbería en Colombia con una sede. Necesita:
- **Cuentas sin errores:** caja, ingresos, gastos, propinas, comisiones y utilidad. Es la prioridad número uno del dueño.
- **Agenda de citas:** los clientes reservan desde el celular sin instalar nada.
- **Informes para el dueño:** los consulta sobre todo **desde su celular**.

Todo lo programa Claude Code y el usuario trabaja solo. No hay factura electrónica por ahora, y el sistema no se venderá a otras barberías.

## Decisión

- **Lenguaje:** TypeScript 6 de punta a punta. Un solo lenguaje para servidor, cliente, validación y pruebas.
- **Framework:** Next.js 16 (App Router, `output: "standalone"`) con React 19.
- **Persistencia:** PostgreSQL 18 con Drizzle ORM. **Las reglas contables viven en la base de datos**, no solo en el código.
- **Interfaz:** PWA mobile-first con React Aria Components (accesibilidad) y Tailwind 4 (tokens "Navaja y Cuero"). El dueño la instala en el celular con "Agregar a inicio".
- **Autenticación:** better-auth, solo para el personal. Los clientes reservan sin cuenta y confirman con un código (OTP).
- **Jobs:** pg-boss sobre el mismo Postgres, sin Redis.
- **Pruebas:** Vitest con fast-check (property-based) para el núcleo contable, y Playwright para los flujos completos.
- **Despliegue:** un VPS con Ubuntu 24.04, Caddy (HTTPS) y dos servicios systemd: `villa-web` y `villa-worker`.
- **Costo mensual estimado:** ~10–45 USD.

## La prioridad: que las cuentas no fallen

**La exactitud contable depende muy poco del lenguaje.** Depende de dónde se hacen cumplir las reglas. Por eso las garantías están en cuatro capas, de la más fuerte a la más débil:

1. **PostgreSQL**, que ninguna línea de código puede saltarse.
   - **Partida doble desde el MVP.** Cada movimiento es un asiento con líneas de débito y crédito. Un *constraint trigger* diferido rechaza cualquier transacción cuyo asiento no cuadre (débitos = créditos). Un descuadre no se puede guardar, aunque el código tenga un bug.
   - **Libro solo-inserción.** Triggers y permisos prohíben UPDATE, DELETE y TRUNCATE. Un error se corrige con un asiento de reversa que referencia al original.
   - **Montos `bigint` en centavos** con `CHECK`. Nunca `real`, `double` ni `float`.
   - **Periodos cerrados bloqueados:** un día con caja cerrada no acepta asientos nuevos sin reapertura auditada.
   - **Transacciones `SERIALIZABLE`** en el cobro, la caja y la liquidación de comisiones, con clave de idempotencia para que un doble toque no cobre dos veces.
2. **Tipos.** `Money` es `{ minor: bigint, currency }` ([src/domain/money.ts](../src/domain/money.ts)). El compilador impide mezclar un monto con un `number`. El driver de Postgres devuelve `bigint` como `bigint`, nunca como `number`.
3. **Una sola aritmética.** Porcentajes en puntos básicos, redondeo half-up explícito y `allocate()` para repartir sin perder ni crear centavos. Todo cálculo de dinero pasa por ese módulo.
4. **Pruebas property-based** (fast-check). No se prueban 3 ejemplos sino miles de casos aleatorios: "repartir nunca pierde un centavo", "todo asiento cuadra", "reversar dos veces es imposible".

Esto refuerza la decisión de §2 del descubrimiento. El usuario dijo que la contabilidad es lo más importante, así que se adopta **partida doble real desde el sprint 1**, que era la postura de Arquitectura, en lugar de dejarla preparada para después. El dueño nunca ve débitos ni créditos: ve caja, ingresos, gastos y utilidad.

## Por qué, y qué descarté

- **C# / .NET 10 (ASP.NET Core + EF Core):**
  - Fue el rival más serio. Tiene `decimal` nativo de 128 bits, que es su gran argumento para finanzas.
  - Perdió porque, con montos enteros en `bigint`, JavaScript también hace aritmética **exacta**: `bigint` no tiene errores de redondeo.
  - Además, las garantías fuertes están en Postgres de todos modos.
  - Y para una interfaz moderna en el celular igual haría falta React, es decir, **dos lenguajes y dos proyectos** (API + frontend). Blazor evita lo segundo, pero queda por detrás en experiencia móvil.
  - Más piezas móviles y el mismo resultado contable.
- **Laravel + Filament:**
  - Era la primera recomendación, porque Filament ahorra semanas de pantallas a un humano.
  - Perdió porque quien programa es Claude Code, porque las pantallas clave (agenda en columnas, cobro en 3 toques, informes en el celular) son a medida igual, porque PHP no está instalado y porque PHP tampoco tiene decimal nativo.
- **App nativa (Flutter/Swift/Kotlin):**
  - El dueño puede instalar la PWA en el celular, y los clientes no van a instalar una app para reservar un corte.
  - Volver a evaluarlo solo si se necesitan funciones del dispositivo que una PWA no tiene.

## Estructura del proyecto

```
villa/
├─ src/
│  ├─ app/              # Rutas Next.js: delgadas, solo UI y server actions que llaman a domain/
│  ├─ domain/           # NÚCLEO: reglas de negocio puras, sin Next.js ni base de datos
│  │  ├─ money.ts       # aritmética exacta de dinero (única fuente de cálculo)
│  │  ├─ booking/       # disponibilidad, citas
│  │  ├─ sales/         # cobro, pagos mixtos, propinas, anulaciones
│  │  ├─ ledger/        # partida doble: cuentas, asientos, reversas, cierres
│  │  ├─ commissions/   # reglas versionadas y liquidación
│  │  ├─ clients/       # clientes, consentimiento (Ley 1581)
│  │  └─ staff/         # barberos, horarios, roles
│  ├─ db/               # esquema Drizzle, migraciones, cliente
│  ├─ lib/              # infraestructura transversal (env, auth, fechas)
│  └─ worker/           # proceso pg-boss: recordatorios, expiraciones
├─ e2e/                 # Playwright (móvil y tablet)
└─ docs/
```

- **Por qué `domain/` aparte:** el cálculo de dinero, disponibilidad y comisiones se prueba sin levantar ni Next.js ni Postgres.
- **Por qué `app/` es delgado:** se puede cambiar la interfaz sin tocar una regla contable.

## ADR-001: dinero exacto sin tipo `decimal` y política de redondeo

**Decisión:** no se usa `decimal` ni `numeric` para montos. Se usan **enteros `bigint` en centavos**, en TypeScript y en PostgreSQL.

**Por qué no hace falta `decimal`:**
- Villa trabaja con una sola moneda (COP).
- No maneja tasas de cambio, intereses ni cantidades fraccionarias.
- Los porcentajes (comisiones, IVA, datáfono) se expresan en puntos básicos y se redondean **una sola vez**.

Medido en esta máquina: con `number` y truncado, 463 combinaciones precio × porcentaje habituales en una barbería dan un peso de error (por ejemplo, 35 % de $10.500 da $3.674 en lugar de $3.675). Con enteros no falla ninguna.

**Por qué centavos aunque el COP no los use en la práctica:**
- El desglose de IVA incluido y el costo del datáfono producen centavos.
- La factura electrónica DIAN maneja 2 decimales.
- En pantalla se muestran pesos.

**Por qué `bigint` y no `number` entero:** no es por precisión, porque `number` llegaría a unos 90 billones de pesos. Es una **barrera**: TypeScript no permite escribir `monto * 0.35` con `bigint`, así que todo cálculo pasa por `src/domain/money.ts`.

**Reglas de redondeo:**

| Concepto | Escala | Regla |
|---|---|---|
| Comisión del barbero | **peso** | Half-up por línea de servicio, al cobrar. Se congela. La liquidación del periodo **suma** las líneas congeladas y no vuelve a redondear. |
| IVA (si Villa es responsable) | centavo | Base = total / 1,19 redondeado half-up. IVA = total − base, de modo que base + IVA = total siempre. |
| Costo del datáfono | centavo | Half-up. |
| Repartos (pago dividido, propina compartida) | centavo | `allocate()`: la suma de las partes es exactamente el total. |
| Efectivo que no da en monedas de $50 | peso | La diferencia se registra en la cuenta **5310 Diferencias y redondeos de caja**, nunca se "pierde". |

- **Un solo redondeo por cálculo.** `percentOf(monto, puntosBásicos, paso)` redondea directamente al paso pedido (centavo o peso), sin pasar por un redondeo intermedio que causaría doble redondeo.
- **Sumas en SQL:** `SUM()` de una columna `bigint` devuelve `numeric`, que el driver entrega como texto. Toda suma se lee con `sumAsBigint()` (`src/db/sql.ts`) y nunca con `Number()`.
- **Serialización:** `JSON.stringify` no acepta `bigint`. En las respuestas JSON los montos viajan como texto de centavos, por ejemplo `"2500000"`, y se reconstruyen con `BigInt()`.

**Pendiente de confirmar con el dueño y el contador:**
- si Villa es responsable de IVA;
- quién absorbe el costo del datáfono;
- si la comisión se calcula antes o después del descuento.

Las reglas de esta tabla son configurables; lo que **no** cambia es que se redondea una sola vez y en un solo lugar.

## Modelo contable (sprint 1)

- **Partida doble:** `journal_entries` (asiento) y `journal_lines` (débito o crédito, exactamente uno mayor que cero).
- **Plan de cuentas por sede:** `accounts`. Los códigos están inspirados en el PUC colombiano y **debe validarlos el contador**.
- **Garantías en PostgreSQL**, en la migración `ledger_guards`:
  - *constraint trigger* diferido: cada asiento tiene al menos 2 líneas y débitos = créditos al hacer COMMIT;
  - asientos y líneas son solo-inserción: UPDATE, DELETE y TRUNCATE lanzan error;
  - FK compuestas `(location_id, …)`: una línea no puede apuntar a una cuenta ni a un asiento de otra sede;
  - un día cerrado (`day_close_events`) no acepta asientos; reabrirlo es un evento nuevo y auditable;
  - una reversa por asiento (`reverses_entry_id UNIQUE`), y una reversa no se puede reversar;
  - idempotencia: `UNIQUE (location_id, idempotency_key)`.
- **Pruebas:** los tests de integración corren la migración real sobre **PGlite**, un PostgreSQL embebido, así que no necesitan una base instalada.

## ADR-002: modelo de la agenda (sprint 2)

**Decisión:** cada cita guarda su ocupación como un `tstzrange` semiabierto `[inicio, fin)` en UTC, y Postgres impide los choques con un `EXCLUDE USING gist`. La disponibilidad se calcula en minutos locales del día de la sede.

**Por qué un rango y no inicio + duración:**
- `EXCLUDE (location_id WITH =, staff_id WITH =, during WITH &&)` hace imposible la doble reserva aunque dos recepcionistas agenden en el mismo milisegundo. Es la misma idea que en el libro contable: la regla vive en la base, no solo en la app.
- El rango incluye la limpieza (`buffer_min`), así que la silla queda ocupada hasta que esté lista.
- Solo bloquean las citas activas (`pending`, `confirmed`, `arrived`, `in_chair`, `completed`). Cancelar o marcar `no_show` libera el horario sin borrar nada.
- `CHECK` sobre el rango: no vacío, cerrado al inicio, abierto al final y sin infinitos.

**Por qué minutos locales para calcular disponibilidad:**
- El horario semanal (`staff_schedules`) es "lunes de 9:00 a 19:00", no instantes. Se guarda en minutos del día (`int4range`, con su propio `EXCLUDE` para que dos turnos del mismo día no se pisen).
- Cada día se calcula en minutos locales y se convierte a UTC una sola vez, con `localMinuteToInstant` y la zona de la sede. Colombia no tiene horario de verano, pero la conversión no lo supone.
- El día que se muestra es el día local de la sede, nunca el del navegador.

**Estados:** la máquina de estados vive en `src/domain/booking/status.ts` (`RULES`). Postgres replica solo los **pares** permitidos en un trigger: aunque la app tenga un error, una cita terminada o cancelada no cambia. Quién puede hacer cada paso (rol, barbero propio, cliente, sistema, después de la tolerancia, el mismo día) lo decide el dominio.

**Lo que la base garantiza además** (migración `0005_agenda_guards.sql`):
- Lo cotizado (servicio, duración y precio) no se edita después de agendar.
- Mover de barbero u horario solo antes de empezar. Al terminar, el fin puede acortarse, nunca alargarse.
- Nada se borra: citas, eventos y ausencias son solo-inserción o se anulan con marca de tiempo.
- Cada cambio deja un `appointment_events` con quién, cuándo y el rango anterior.
- Idempotencia por `(location_id, idempotency_key)`: reintentar un agendamiento o un walk-in devuelve la misma cita.

**Retenciones en línea (sprint 3):** una cita `pending` con `expires_at` ocupa el horario mientras el cliente verifica su celular. Al vencer pasa a `cancelled` (actor `system`) y libera el rango.

**Caduca cuando:** haya recursos compartidos además del barbero (sillas o cabinas contadas aparte), o servicios con varios barberos a la vez. Ahí la exclusión pasa a ser por recurso y no por `staff_id`.

## Informes para el dueño en el celular

- La sección **Finanzas** se diseña primero para 360 px:
  - indicadores grandes;
  - lista en lugar de tabla ancha;
  - selector de periodo fijo arriba;
  - totales fijos abajo.
- El escritorio es la versión ampliada, no al revés.
- La PWA se instala en el celular. El dueño entra con MFA.
- Los informes leen el libro contable. **Nunca se calculan sumando en el cliente:** la suma la hace Postgres.

## Seguridad: estado y plan (auditorías de los sprints 2 y 3, endurecimiento del sprint 4)

Al cerrar cada sprint corre una auditoría del agente de seguridad (solo lectura) más las pruebas automáticas de permisos. Las pruebas de ataque contra la app en marcha se hacen en un entorno propio, nunca contra terceros: la superficie pública en el sprint 3, y una prueba de penetración completa antes del lanzamiento en el sprint 5.

**Ya está y se prueba:**

- **Permisos en el servidor.** `src/app/panel/authorization.test.ts` corre el `requirePermission` real, con cada rol contra cada server action. Comprueba que:
  - un rol sin permiso no cambia nada en la base;
  - sin sesión se redirige a `/ingresar`;
  - un barbero no toca las citas de otro;
  - el dueño de otra sede no alcanza nada de esta (IDOR).

  Una guarda busca todo archivo de `src/app` con `"use server"` y falla si uno no está clasificado (personal o público) o si exporta una acción que no está en la matriz.
- **Inyección y XSS.** Las consultas son parametrizadas: no hay `sql.raw` ni `unsafe`. React escapa el texto, no hay `dangerouslySetInnerHTML` y el único enlace con datos es un `tel:` ya validado.
- **Registro y sesiones.**
  - No existe registro público (`disableSignUp`).
  - La membresía se relee en cada petición, así que quien se retira pierde el acceso al instante.
  - Las cookies son HttpOnly y SameSite=Lax, con Secure forzado en producción.
  - `BETTER_AUTH_URL` exige `https://` en producción.
  - El límite de intentos usa la IP real detrás de Caddy (`trustedProxies`).
- **Cabeceras** (`next.config.ts`): CSP con `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS en producción y sin `X-Powered-By`.
- **Registros sin datos personales.** `src/lib/log.ts` corta los parámetros de la consulta (correos, celulares, hashes).
- **CI.** `npm audit` de dependencias de producción (frena ante vulnerabilidades altas o críticas) y checkout sin credenciales persistentes.
- **Contraseñas.** better-auth usa scrypt. Es aceptable según OWASP; la sección 9 del descubrimiento decía Argon2id o bcrypt.
- **Reserva pública (sprint 3).** `src/app/(publico)/public-endpoints.test.ts` prueba cada acción pública; su propia guarda de completitud falla si aparece una nueva sin cubrir.
  - **Código de verificación:**
    - es un OTP de 6 dígitos guardado como HMAC con pimienta fuera de la base y comparado en tiempo constante;
    - el intento se cuenta antes de comparar, en un solo UPDATE condicional, así que no se puede correr en paralelo;
    - es de un solo uso, con 5 intentos, 3 envíos y 60 s entre reenvíos.
  - **Canal del código:** en producción viaja solo por WhatsApp, el único canal que prueba que el número es del cliente.
  - **Límites contra abuso:**
    - por IP (IPv6 agrupada por /64), por teléfono y globales por sede;
    - un tope de horarios apartados a la vez;
    - Turnstile antes de escribir nada, que falla cerrado en producción.
  - **Enlace de gestión:**
    - es un HMAC de 256 bits y la base solo guarda su SHA-256;
    - vence, se revoca al cancelar y responde el mismo 404 para todo token inválido, sin IDOR;
    - la página no se guarda en caché, no se indexa y no envía referer.
  - **Datos del cliente:** el correo y el nombre escritos en la página pública solo se guardan al verificar, y nunca pisan los de un cliente existente.
  - **Triggers de 0007:**
    - el consentimiento y la bandeja de avisos son solo-inserción;
    - el estado del código es inmutable salvo +1 intento y un único consumo;
    - un enlace revocado no revive.
- **Ajustes de la sede.** Solo el dueño (`settings.manage`). Las acciones están en la matriz de autorización y el enlace del mapa solo acepta `https://`.
- **Endurecimiento antes del dinero (inicio del sprint 4).**
  - **Verificación en dos pasos (TOTP).** Plugin `twoFactor` de better-auth: códigos de 6 dígitos cada 30 s, 10 códigos de respaldo guardados cifrados y mostrados una sola vez.
    - Obligatoria para el dueño (`MFA_REQUIRED` en `src/domain/staff/roles.ts`): `requireStaff` lo manda a `/cuenta/verificacion` antes de cualquier pantalla o acción del panel. Opcional para recepción y barberos.
    - El ingreso pide el código después de la contraseña, o un código de respaldo. 5 códigos malos bloquean la cuenta 15 minutos. Además, cada código del segundo paso se reserva antes de verificarse, por usuario (sujeto `totp-login`): con varios retos en paralelo tampoco se prueban más de 5.
    - Con el TOTP activo, generar códigos de respaldo nuevos y desactivarlo (o cambiar de celular) piden la contraseña **y** un código de la app o de respaldo (`regenerateBackupCodesAction`, `disableTwoFactorAction` en `src/app/cuenta/actions.ts`). Por HTTP, `/two-factor/disable` y `/generate-backup-codes` responden 403 a quien ya lo tiene activo.
    - Cambiar la contraseña propia cuenta como reautenticación solo si el TOTP no está activo.
    - Se prueba de punta a punta con better-auth real en `src/lib/auth.test.ts`.
  - **Reautenticación** (`requireRecentAuth` en `src/lib/session.ts`). Una prueba de identidad en los últimos 5 minutos, guardada en `session.reauthenticated_at`.
    - Con la verificación en dos pasos activa (los dueños siempre) solo vale el código de la app o un código de respaldo: la contraseña sola no basta. Sin ella, la contraseña.
    - La exigen: crear o ascender un dueño, cambiar un rol, editar o retirar a un dueño y poner la contraseña de otra persona; reabrir un día y decidir anulaciones; y lo que mueve dinero sin pasar por la caja: medios de pago, categorías de gasto, reglas de cobro, crear un servicio o cambiar su precio o comisión, y un gasto pagado del banco.
    - El servidor responde `code: "reauth_required"`; `useReauth` (`src/app/panel/_components/reauth.tsx`) pide la confirmación y reintenta.
  - **Bloqueo por cuenta en Postgres** (`login_throttles`, `src/db/login-throttle.ts`). 5 fallos bloquean 1 minuto; cada fallo siguiente duplica la espera hasta 15 minutos, y el contador se olvida a las 24 h.
    - **El intento se reserva ANTES de verificar** la credencial: `pg_advisory_xact_lock` por sujeto, se revisa el bloqueo y se suma 1 en la misma transacción. N peticiones en paralelo verifican a lo sumo 5 (test de concurrencia). Un acierto borra el contador; un intento que no llegó a verificar nada (datos mal escritos) se devuelve.
    - Ingreso: el bloqueo duro es por (correo, cubeta de IP; IPv6 por /64). Además hay un límite blando por correo, sumando todas las IP, de 50 fallos. Un navegador donde ya se ingresó completo lleva la cookie firmada `known_device` (HMAC, HttpOnly, Secure en producción, 90 días) y no cuenta para el límite por correo, pero sí para el de (correo, IP). Así, un ataque repartido desde muchas IP no deja al dueño fuera desde su celular.
    - Aplica también a la reautenticación, al cambio de contraseña y a la contraseña que piden `/two-factor/enable`, `/disable` y `/generate-backup-codes` (mismo sujeto que cambiar la contraseña).
    - Los sujetos son HMAC del correo (y de la IP) o SHA-256 del id del usuario: sirven igual para correos que no existen y el mensaje no dice si la cuenta existe. Cuando se dispara un bloqueo queda un aviso en el registro, sin datos personales.
    - Con un bloqueo vigente no se cuenta ni se acorta nada (test de propiedades).
    - **Desbloquear a alguien:** `npm run staff:unlock -- <correo>` borra sus contadores (todas sus IP, el límite por correo, la reautenticación, la contraseña, el segundo paso) y el bloqueo del código de la app. Necesita el mismo `BETTER_AUTH_SECRET` de la app.
  - **Endpoints de better-auth cerrados** (hook `before` en `src/lib/auth.ts`, prueba en `src/lib/auth.test.ts`):
    - `/update-user`, `/change-email`, `/delete-user`, `/set-password`, `/change-password` y `/two-factor/get-totp-uri` responden 403. La app tiene sus propias acciones, con reautenticación y bloqueo.
    - Cualquier petición con `trustDevice` se rechaza: el código se pide en cada ingreso. Cambiar o reiniciar la contraseña, cerrar sesiones o retirar a alguien borra además sus registros `trust-device-*` de `verification`.
    - Con sesión y TOTP activo, `/two-factor/verify-totp` y `/verify-backup-code` responden 403 por HTTP: solo sirven para el ingreso o para terminar la inscripción, y no son un oráculo sin bloqueo. La reautenticación los llama desde el servidor (`auth.api`, sin `request`), detrás de su propio bloqueo.
  - **Nombres en las vistas de dinero.** Quién cobró, abrió la caja o pidió y aprobó una anulación se muestra con `staff_members.display_name` (lo pone el dueño), no con `user.name`.
  - **Límite de intentos de better-auth en la base** (`rate_limit_counters`, cubetas `auth:*` con HMAC). Vale para todos los procesos y no guarda la IP en claro.
  - **Contraseña temporal.** La que el dueño pone al crear a alguien, o al reiniciársela, obliga a cambiarla en el primer ingreso (`/cuenta/clave`).
    - Cambiar la contraseña propia cierra las demás sesiones.
    - Reiniciar la de otra persona, cerrar sus sesiones o retirarla las cierra todas en la misma transacción.
  - **Idempotencia ligada al contenido.** La clave guarda un SHA-256 del contenido canónico de la petición (`src/domain/security/idempotency.ts`) en citas y asientos.
    - La misma clave con el mismo contenido devuelve el resultado original; con otro contenido es un conflicto con mensaje en español.
    - La huella de una cita no se edita (trigger). Hay test de propiedades del dominio y del libro en la base.
  - **Roles de Postgres separados.** `villa_owner` es dueño del esquema y corre las migraciones (`MIGRATION_DATABASE_URL`); `villa_app` es la app y los trabajos del worker; `villa_queue` es la cola del worker (pg-boss, `QUEUE_DATABASE_URL`) y solo es dueño del esquema `pgboss`.
    - `villa_app` no tiene DDL ni TRUNCATE, no puede desactivar ni borrar triggers, no puede volverse `villa_owner` y no tiene UPDATE ni DELETE sobre el libro, los cierres, el historial de citas, los consentimientos ni la bandeja de avisos (0006/0007).
    - Permisos en `app_apply_grants()` (migración 0009); script del VPS en `src/db/roles/setup-roles.sql`.
    - `src/db/roles.test.ts` corre el trabajo diario como `villa_app` en PGlite y prueba cada negativa. Con `VILLA_TEST_DB_ROLE=app` se puede correr toda la suite con ese rol. Fallan solo los 6 tests que verifican mensajes de triggers con UPDATE o DELETE directos, porque ahí frena antes el permiso.
    - **Regla:** toda migración que cree tablas termina con `SELECT app_apply_grants();`. Sin eso, la tabla nueva queda sin permisos para la app: falla cerrado.
    - **search_path fijo (auditoría del sprint 4, HIGH-1).** Antes `pgboss` era de `villa_app`: la app podía crear ahí una `ledger_assert_entry()` vacía, poner `search_path = pgboss, public` y saltarse el cuadre. Ahora (0011) toda función de `public` lleva `SET search_path = pg_catalog, public, pg_temp`, `villa_app` no tiene CREATE en ningún esquema ni tablas temporales, y `pgboss` es de `villa_queue`. `roles.test.ts` revisa `pg_proc` y repite el ataque con la instalación vieja: el asiento descuadrado se sigue frenando.
    - `setup-roles.sql` apaga `log_statement`, `log_min_duration_statement` y `log_min_error_statement` en su sesión, para que `CREATE/ALTER ROLE … PASSWORD` no quede en los registros del servidor, ni siquiera si falla. Las contraseñas se escriben cuando las pide; nunca con `-v owner_password=…`, que las deja en el historial del shell y en `ps`. `\prompt` de psql **muestra** lo que se escribe: se corre sin nadie mirando ni grabando la terminal, y se limpia la pantalla después.
    - Si `pgboss` venía de `villa_app`, el script le pasa a `villa_queue` el esquema y todo lo suyo: tablas, la tabla particionada `job` y cada partición, vistas, secuencias sueltas, funciones y tipos.
  - **Conteo a ciegas (auditoría del sprint 4, MEDIUM-3).** Con la caja abierta, el servidor no manda el esperado, el saldo de apertura, el desglose ni los montos de los movimientos a quien no tiene `cash.review` (solo el dueño); quien cuenta a ciegas siempre deja nota, así el error no sirve de oráculo, y "no hay tanto efectivo" le llega como mensaje genérico. La base marca para revisión las aperturas y los cierres con diferencia mayor que el umbral de la sede ($20.000 por defecto) y el dueño los revisa en Caja. Probado en `authorization.test.ts` ("conteo a ciegas") y `cash.test.ts`.
  - **Gasto de banco.** La acción decide sobre la entrada ya validada, y `addExpense` exige además `expenses.bank` con el rol que recibe. Tampoco se puede colar por otro camino.
  - **Vencimiento de los enlaces de gestión.** Un trigger (0009) impide alargarlos más de 7 días después del fin de la cita.

**Requisitos de despliegue que la seguridad da por hechos** (auditoría del sprint 3):

- `villa-web` escucha solo en `127.0.0.1` (`HOSTNAME=127.0.0.1` en la unidad systemd) y el firewall cierra el puerto 3000. Si alguien llega directo a Next, puede inventarse `X-Forwarded-For` y saltarse todos los límites por IP.
- Si se pone Cloudflare delante de Caddy, hay que agregar sus rangos a `trusted_proxies` en Caddy y en `src/lib/client-ip.ts`. Si no, todos los clientes comparten los mismos contadores.
- Las dos unidades (`villa-web` y `villa-worker`) llevan `Environment=NODE_ENV=production`. Fuera de `development` o `test`, la app falla cerrado si faltan secretos o canales.
- El registro de acceso de Caddy no guarda las rutas `/cita/*`, porque el token de esa ruta permite cancelar y reprogramar.
- **`BETTER_AUTH_SECRET` no se rota a la ligera.** Ese secreto:
  - cifra los secretos TOTP y los códigos de respaldo (`two_factor`);
  - firma las cookies de sesión y la de dispositivo conocido;
  - es la llave de los HMAC de los contadores de bloqueo y de límites.

  Si se cambia, nadie puede verificar su código de la app y **el dueño queda fuera**: habría que desactivar el TOTP en la base e inscribirlo de nuevo. Además, se pierden las sesiones y los bloqueos vigentes. Guarda una copia sellada fuera del VPS, junto con la clave de los backups.

**Pendiente, con su sprint:**

| Ítem | Riesgo | Cuándo |
|---|---|---|
| **Aplicar la separación de roles en el VPS**: correr `src/db/roles/setup-roles.sql` (ahora crea también `villa_queue` y le pasa el esquema `pgboss`), poner `DATABASE_URL` con `villa_app`, `MIGRATION_DATABASE_URL` con `villa_owner` y `QUEUE_DATABASE_URL` con `villa_queue`, y migrar (0011). Hasta entonces la app sigue siendo dueña de las tablas. Con `NODE_ENV=production` el worker no arranca sin `QUEUE_DATABASE_URL` | Medio: los triggers valen lo que valga el rol de la base | **Antes de la primera acción contable en producción (sprint 4)** |
| HIGH-1, lo que queda: el search_path fijo incluye `pg_temp` al final (más estricto que `pg_catalog, public`); `villa_app` ya no tiene TEMP, pero si un DBA se lo devolviera, `pg_temp` va último y no tapa nada de `public`. Las funciones nuevas deben llevar el mismo `SET search_path` (lo exige la prueba de `pg_proc`) | Bajo | Hecho en el sprint 4; vigilar en cada migración |
| MEDIUM-3, lo que queda: con la caja abierta, recepción todavía ve los totales de las ventas del día y las propinas por pagar, que dan una idea aproximada del efectivo (no exacta: no dicen el medio). Y un gasto o consignación rechazado por falta de efectivo dice, aunque con mensaje genérico, que el monto supera el esperado: probando montos se podría acotar. El umbral de revisión lo cambia el dueño con reautenticación | Bajo | Aceptado; revisar con el dueño en el sprint 5 |
| Inscripción del TOTP por confianza en el primer uso: quien tenga la contraseña del dueño antes de que él inscriba su celular podría inscribir el suyo. Mitigación: el dueño inscribe el TOTP apenas recibe la cuenta, y la de cada socio nuevo tiene contraseña temporal que debe cambiar primero | Medio, solo en la ventana de inscripción | Aceptado; revisar en la auditoría del sprint 4 |
| Un código TOTP se acepta hasta unos 90 s (ventana de ±1 paso de 30 s) y better-auth no recuerda el último paso usado: alguien que lo vea por encima del hombro puede repetirlo en ese lapso | Bajo: necesita también la contraseña | Aceptado |
| Sin código QR en la inscripción: hay enlace `otpauth://` (abre la app en el celular) y clave para escribir a mano. Agregar QR exige una dependencia nueva | Bajo (usabilidad) | Sprint 5, si el dueño lo pide |
| Aviso al dueño cuando se dispara un bloqueo por intentos fallidos. Hoy solo queda un aviso en el registro del servidor, sin datos personales | Bajo: el dueño no se entera de un ataque en curso | Sprint 5 |
| Bloqueo por (correo, IP) detrás de CGNAT: quien comparta IP pública con el dueño (mismo operador móvil) puede bloquearle 15 minutos el ingreso desde esa red. La cookie de dispositivo conocido no lo exime de ese bloqueo, a propósito | Bajo | Aceptado; `npm run staff:unlock` lo resuelve |
| El historial de una cita (agenda) todavía muestra `user.name` de quien hizo el cambio. Ya nadie puede cambiarse ese nombre (`/update-user` está cerrado), pero conviene pasarlo a `display_name` como en las vistas de dinero | Bajo | Sprint 5 |
| Vida máxima absoluta de la sesión; auditoría de lecturas de datos personales (Ley 1581) | Bajo | Sprint 5 |
| CSP de scripts con nonce (primero en modo reporte) | Bajo | Sprint 5, con el despliegue |
| Borrado de datos personales que hoy no se puede hacer: IP, navegador, nombre y correo escritos (`contact_name`, `contact_email`) en `booking_verifications`, y `params` en `notifications`, bloqueados por los triggers. Anonimizar al cliente no los borra. Hace falta una función de purga `SECURITY DEFINER` en el mantenimiento diario, y decir en la política de privacidad cuánto se guardan | Medio (Ley 1581): no se puede cumplir una solicitud de supresión | Sprint 5 |
| Firmar la cookie `villa_hold` o emitir una nueva si no hay verificación viva para ese navegador | Bajo: hace falta plantar la cookie desde un subdominio | Sprint 5 |
| CSP de scripts con nonce. Ahora es más urgente porque hay superficie pública; debe permitir `https://challenges.cloudflare.com` en `script-src` y `frame-src` | Medio en el portal | Sprint 5, con el despliegue |
| Verificar `X-Hub-Signature-256` en tiempo constante cuando exista el webhook de WhatsApp (estados de entrega) | Medio cuando exista | Cuando se agregue el webhook |
| Contar por IP más una cookie de dispositivo, porque el CGNAT de los operadores móviles hace que muchos clientes compartan IP | Bajo: un vecino abusivo bloquea a otros | Sprint 5, si se ve en producción |
| Bloquear un número a propósito: 6 solicitudes con Turnstile resuelto lo dejan sin reservar en línea 24 h. Se acepta y queda la reserva por teléfono | Bajo | Aceptado |
| Backups cifrados y restauración probada | Alto operativo | Despliegue (sprint 5) |

## Riesgos y cuándo esta decisión deja de servir

- **Aguanta** decenas de sedes y miles de citas al día en un solo VPS.
- **Deja de servir si:**
  - Villa se vuelve SaaS para otras barberías (hace falta tenancy real, suscripciones e infraestructura redundante);
  - se exige una app nativa;
  - la factura electrónica DIAN se vuelve obligatoria (se integra por API con Alegra o Siigo, sin cambiar el stack).
- **TypeScript 7** (el nuevo compilador nativo) salió hace poco. Nos quedamos en 6.0.3 hasta que Next.js lo soporte oficialmente.
- **Un solo VPS** es un punto único de falla. Se mitiga con `pg_dump` diario cifrado a R2 o B2, una restauración probada cada mes y monitoreo de uptime.

## Primeros pasos

1. Crear la base y el rol en el Postgres 18 local (ver README).
2. `copy .env.example .env` y completar `DATABASE_URL`.
3. `npm install`, `npm test` y `npm run dev`.
4. Sprint 1: modelo contable (cuentas, asientos, triggers de cuadre e inmutabilidad) con tests de propiedades **antes** de cualquier pantalla.
5. En paralelo: iniciar la verificación del negocio en Meta para WhatsApp.

---

Recomiendo TypeScript con PostgreSQL y las reglas contables blindadas en la base de datos. Lo firmo.
