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

**Decidido:** Villa **no es responsable de IVA** (el dueño, 2026-11-11). Requisitos que conviene que el contador confirme: solo una persona natural puede ser no responsable (una S.A.S. es responsable por ley), y los ingresos brutos del año anterior deben ser menores a 3.500 UVT. Los cobros van completos a ingresos y los gastos por su total: no hay línea de IVA ni IVA descontable. La regla de redondeo de la tabla queda para el día en que lo sea. **En duda (revisión contable del 2026-11-12):** con unos 10 barberos, el tope de 3.500 UVT muy probablemente se supera. Por la vía del Régimen Simple (peluquería, grupo 1), el concepto DIAN 007877 de 2026 trata la venta de productos como actividad aparte. Hay que confirmarlo con el contador antes del lanzamiento ([revision-contable.md](revision-contable.md) §3).

**Pendiente de confirmar con el dueño y el contador:**
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
- **Lo que no es asiento: la cortesía (sprint 8, migración 0026).** Una cita atendida que el negocio regala no es una venta de $0 (eso obligaría a volver opcional el asiento de la venta y a tocar `sales_assert_totals` y los triggers del cobro). Va en `appointment_courtesies`, solo-inserción para `villa_app`, una por cita, con el precio de lista congelado. No mueve el libro ni genera comisión; el cobro rechaza una cita con cortesía y la bitácora la registra como `appointment.courtesy` (finanzas). Diseño en [sprint-8-gastos-controles.md](sprint-8-gastos-controles.md) §4.
- **Gastos fijos: nada se asienta solo (sprint 8, migración 0028).** Una plantilla (`recurring_expenses`) solo dice qué periodos tocan (`duePeriods`, dominio puro, con el día local de la sede). Cada periodo lo confirma una persona: registrarlo es un gasto normal (`addExpenseTx`, con su asiento de siempre y sin tipos de asiento nuevos) y su fila en `recurring_expense_runs` (solo-inserción, una por periodo) en la misma transacción SERIALIZABLE, con la clave `recurring:<id>:<periodo>`; omitirlo (solo el dueño) deja el motivo. Diseño en [sprint-8-gastos-controles.md](sprint-8-gastos-controles.md) §5.
- **Cuentas por pagar a proveedores (sprint 8, migración 0036).** La compra de mercancía a crédito es un documento de inventario más (`paid_from = 'credit'`, con proveedor y vencimiento): 1435 contra **2205 Proveedores** (pasivo). Cada pago (`supplier_payments`, solo-inserción) abona UNA compra: 2205 contra caja, banco o aporte del dueño (3105). La base exige al COMMIT que el pago cuadre con su asiento y que los pagos vigentes de una compra no superen su total; 2205 solo lo mueven compras a crédito y pagos (o sus reversas). Corregir es anular (reversa), nunca editar: primero los pagos, después la compra. Diseño y detalle en [sprint-8-gastos-controles.md](sprint-8-gastos-controles.md) §5b.

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
- Diseño y contrato del sprint 5 (liquidación de comisiones, anticipos, informes, CSV, tablero y bitácora de auditoría): [sprint-5-comisiones-informes.md](sprint-5-comisiones-informes.md).

## Seguridad: estado y plan (auditorías de los sprints 2 y 3, endurecimiento del sprint 4)

Al cerrar cada sprint corre una auditoría del agente de seguridad (solo lectura) más las pruebas automáticas de permisos. Las pruebas de ataque contra la app en marcha se hacen en un entorno propio, nunca contra terceros: la superficie pública en el sprint 3, y una prueba de penetración completa antes del lanzamiento en el sprint 5.

**Ya está y se prueba:**

- **Permisos en el servidor.** `src/app/panel/authorization.test.ts` corre el `requirePermission` real, con cada rol contra cada server action. Comprueba que:
  - un rol sin permiso no cambia nada en la base;
  - sin sesión se redirige a `/ingresar`;
  - un barbero no toca las citas de otro;
  - el dueño de otra sede no alcanza nada de esta (IDOR).

  Una guarda busca todo archivo de `src/app` con `"use server"` y falla si uno no está clasificado (personal o público) o si exporta una acción que no está en la matriz.
- **Inyección y XSS.** Las consultas son parametrizadas: no hay `unsafe`, y `sql.raw` solo aparece en `schema.ts`, para escribir los CHECK de la bitácora a partir de listas constantes del código (nunca con datos de una petición). React escapa el texto, no hay `dangerouslySetInnerHTML` y el único enlace con datos es un `tel:` ya validado.
- **Registro y sesiones.**
  - No existe registro público (`disableSignUp`).
  - La membresía se relee en cada petición, así que quien se retira pierde el acceso al instante.
  - Las cookies son HttpOnly y SameSite=Lax, con Secure forzado en producción.
  - `BETTER_AUTH_URL` exige `https://` en producción.
  - El límite de intentos usa la IP real detrás de Caddy (`trustedProxies`).
- **Cabeceras** (`next.config.ts`; la CSP de scripts con nonce está más abajo, en el sprint 5): CSP con `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS en producción y sin `X-Powered-By`.
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
  - **Recordatorio único y portada (cierre del sprint 6):**
    - el recordatorio exige que la última autorización de recordatorios sea de la política 2026-11-05b o posterior (`hasLatestConsent(..., { sinceVersion })`), al crearlo y otra vez al entregarlo, como promete esa versión (M-1); una revocación posterior manda;
    - "lo más pedido" de la portada se cuenta a lo sumo una vez cada 5 minutos por proceso y sede (`DEMAND_CACHE_MS`), con las visitas simultáneas compartiendo la consulta: un bot que recarga `/` no dispara un GROUP BY por visita (M-2).
- **Ajustes de la sede.** Solo el dueño (`settings.manage`). Las acciones están en la matriz de autorización y el enlace del mapa solo acepta `https://`.
- **Endurecimiento antes del dinero (inicio del sprint 4).**
  - **Verificación en dos pasos (TOTP).** Plugin `twoFactor` de better-auth: códigos de 6 dígitos cada 30 s, 10 códigos de respaldo guardados cifrados y mostrados una sola vez.
    - Obligatoria para el dueño (`MFA_REQUIRED` en `src/domain/staff/roles.ts`): `requireStaff` lo manda a `/cuenta/verificacion` antes de cualquier pantalla o acción del panel. Opcional para recepción y barberos.
    - El ingreso pide el código después de la contraseña, o un código de respaldo. 5 códigos malos bloquean la cuenta 15 minutos. Además, cada código del segundo paso se reserva antes de verificarse, por usuario (sujeto `totp-login`): con varios retos en paralelo tampoco se prueban más de 5.
    - Con el TOTP activo, generar códigos de respaldo nuevos y desactivarlo (o cambiar de celular) piden la contraseña **y** un código de la app o de respaldo (`regenerateBackupCodesAction`, `disableTwoFactorAction` en `src/app/cuenta/actions.ts`). Por HTTP, `/two-factor/disable` y `/generate-backup-codes` responden 403 a quien ya lo tiene activo.
    - Ambos cambios, y el cambio de la contraseña propia, se escriben **en la misma transacción que su evento de bitácora** (L11, sprint 6): `changeOwnPassword`, `disableOwnTwoFactor` y `replaceBackupCodes` en `src/db/credentials.ts`. Los dos últimos hacen directamente en la base lo mismo que better-auth (los códigos, con su mismo formato cifrado), y una prueba confirma que better-auth acepta los códigos nuevos.
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
- **Operación y datos personales (sprint 5, migración 0012).**
  - **CSP de scripts con nonce** (`src/proxy.ts`, `src/lib/csp.ts`):
    - El proxy de Next 16 genera 128 bits por petición. La política lleva `script-src 'self' 'nonce-…' 'strict-dynamic' https://challenges.cloudflare.com`, `frame-src` de Turnstile, `object-src 'none'` y `frame-ancestors 'none'`.
    - **En producción bloquea por defecto.** `CSP_ENFORCE=false` la deja en modo reporte (`Content-Security-Policy-Report-Only`): es la semana de prueba obligatoria del lanzamiento y la vuelta atrás ([despliegue.md](despliegue.md) §10). Al arrancar sin bloquear, el servidor lo avisa en el registro (`src/instrumentation.ts`).
    - `/api/csp-report` deja cada violación en el registro sin datos personales: directiva, origen y ruta sin consulta ni token de `/cita` (en cualquier parte de la ruta). Máximo 60 por minuto. Lee el cuerpo como flujo y corta apenas pasa de 16 KB, aunque no venga `Content-Length` (`route.test.ts`); Caddy además limita `/api/*` a 64 KB.
    - La cabecera estática de `next.config.ts` sigue bloqueando siempre el enmarcado, las bases, los formularios y los plugins.
    - El layout raíz llama a `connection()`: ninguna página queda estática, ni la 404, porque una página estática sale sin nonce y la CSP frenaría sus scripts.
  - **Purga de datos personales** (`purge_expired_personal_data()`):
    - Es `SECURITY DEFINER` de `villa_owner`, sin parámetros, con `search_path` fijo y EXECUTE solo para `villa_app`.
    - **Qué borra:**
      - de `booking_verifications`, la IP, el navegador, el nombre y el correo escritos;
      - de `notifications`, `params`;
      - del registro de lecturas, lo que ya venció.
    - **Cuándo:** a los 30 días, o en la siguiente corrida si el cliente fue anonimizado. Lo de lecturas, a los 365 días.
    - **Los triggers lo vigilan:** solo dejan poner esos campos en NULL o `{}` cuando se cumple el plazo o el cliente está anonimizado. Cualquier otro UPDATE o DELETE sigue prohibido.
    - Corre en el mantenimiento diario del worker. La política de privacidad (desde 2026-11-02) dice los plazos, tomados de `src/domain/clients/retention.ts`; la versión 2026-11-03 agrega los 12 meses de las copias de seguridad y qué pasa con una supresión en ellas.
    - Probado en `src/db/privacy.test.ts`, también como `villa_app` y con test de propiedades.
  - **Aviso al dueño por bloqueo de ingreso:**
    - Cada bloqueo se registra en `security_alerts`, dentro de la misma transacción del contador. Guarda el tipo, el usuario si el correo es del equipo, los fallos y hasta cuándo; **nunca** la IP ni el correo escrito.
    - **Sin inundación (auditoría del sprint 5, M1):** hay una sola fila pendiente por (tipo, cuenta o "sin cuenta", ventana de 15 minutos); los bloqueos siguientes suman en `occurrences`. 500 intentos con correos ajenos son una fila.
    - El trabajo `security.alerts` (cada minuto) manda a `ALERT_EMAIL` como mucho un correo cada 15 minutos. Primero las cuentas del equipo; los correos ajenos, en una sola línea con el conteo. Si no hay canal, lo deja en el registro.
    - Un trigger impide borrar un aviso sin entregar.
  - **Avisos al dueño de la operación (sprint 8, migración 0027):**
    - El trabajo `owner.alerts` (cada minuto) barre los últimos 2 días con `INSERT … SELECT … ON CONFLICT DO NOTHING` hacia `owner_alerts` (`UNIQUE (location_id, kind, ref_id)`): solicitud de anulación pendiente, turno cerrado que la base marcó para revisión y nadie revisó, reapertura de un día y cortesía. La solicitud, la reapertura y la cortesía de una cuenta con rol de dueño en la sede no se avisan; el turno descuadrado, siempre. Solo lee las tablas del dinero: sin triggers nuevos en ellas ni cambios en `cash.ts` o `voids.ts`.
    - Entrega: un correo por sede como mucho cada 15 minutos a `ALERT_EMAIL` (Resend), con quién (`display_name`), el monto (`format` de `money.ts`), la hora local de la sede y el enlace al panel. **Nunca** el motivo escrito a mano, la nota de caja ni datos de clientes. Si la anulación ya se decidió o el turno ya se revisó antes del correo, no se lista.
    - `notified_at` se marca solo si el correo salió. `villa_app` solo tiene `UPDATE (notified_at)` y un trigger exige que pase de null a una fecha una sola vez; sin DELETE: los avisos no se purgan (unas pocas filas al día, y borrar uno dentro de la ventana del barrido lo haría salir otra vez).
    - El correo solo necesita `RESEND_API_KEY`, `EMAIL_FROM`, `ALERT_EMAIL` y `PUBLIC_BASE_URL` (validadas con `publicEnv()`), no la configuración de la reserva pública: no se apaga porque falten WhatsApp o Turnstile. Lo mismo vale para `alertSender()` (avisos de seguridad).
    - Sin correo configurado no se marca nada: queda una línea por ventana en el registro (el conteo y los nombres de las variables que faltan, nunca sus valores) y el dueño los sigue viendo en Inicio.
  - **Vida máxima absoluta de la sesión: 12 h** (`SESSION_MAX_AGE_S`):
    - better-auth no la renueva (`disableSessionRefresh`);
    - `sessionState` corta además por `created_at`, aunque alguien alargue `expires_at`.
    - Probado en `auth.test.ts` y `reauth.test.ts`.
  - **Cookie `villa_hold` firmada** (HMAC con llave derivada de `OTP_PEPPER`). Una cookie plantada o sin retención viva para ese navegador se reemplaza por una nueva (`public-endpoints.test.ts`).
  - **Historial de la cita con `display_name`**, como las vistas de dinero.
  - **Auditoría de lecturas de contactos (Ley 1581).**
    - `personal_data_reads` registra quién vio el celular de qué clientes: la agenda del día y la búsqueda de clientes, solo para los roles que lo ven.
    - Agrupa por ventanas de 10 minutos, para que recargar no infle el registro.
    - Es solo-inserción y se purga a los 365 días.
  - **Kit de despliegue y backups** ([despliegue.md](despliegue.md), carpeta `deploy/`), con los arreglos de la auditoría del sprint 5:
    - **Root no corre nada de `villa` (H1).** Los scripts viven en `/usr/local/sbin` y salen de una copia de root parada en un tag verificado (`install-kit.sh` se niega si no). `/srv/villa` y `releases/` son de root; la versión es de `villa` solo mientras se construye, y después pasa a root sin escritura.
    - **Build y migraciones sin secretos de más (M2).** `npm ci --ignore-scripts`; el build solo recibe `NEXT_PUBLIC_*`; las migraciones corren con `deploy/scripts/migrate.mjs`, que solo usa dependencias de producción fijadas por el lockfile. Cada paso como `villa` es una unidad transitoria: al terminar no queda ningún proceso vivo.
    - **Vuelta atrás explícita (L6):** `rollback.sh previous` o una versión con nombre. Las versiones a medias se borran.
    - **Backup (H2, M6):** `pg_dump` cifrado con age, subido archivo por archivo con `rclone copyto --immutable`. Retención 7/4/12 en reglas del bucket, con bloqueo de objetos y una llave del VPS que no borra.
    - **Restauración (M5, M6):** sin SHA-256 no restaura. Las bases de prueba se restauran como `villa_restore`, sin superusuario. Sobre producción se vuelve a aplicar el endurecimiento de la base de `setup-roles.sql` y las supresiones de clientes posteriores al backup.
    - **`sanity.sql`:** cuadre del libro, triggers de garantía presentes y activos, y postura de `villa_app` (sin `TEMPORARY`, sin DDL, sin UPDATE/DELETE en el libro, sin `pgboss`). Probado en `src/db/backup-sanity.test.ts`.
    - **Caddy (M3, M4, M8, L2):** API de administración en un socket `0600`; el registro general (errores) con los mismos filtros que el de acceso; `/api/*` hasta 64 KB.
    - **Permisos de `/etc/villa` (L5):** `root:postgres 0750`; los secretos de la app `root 0600`; `rclone.conf` de `postgres 0600`; las llaves públicas de age `root:postgres 0640`. Node sale del repositorio firmado de NodeSource, sin correr su script.

**Requisitos de despliegue que la seguridad da por hechos** (auditoría del sprint 3). El kit de `deploy/` ya los trae; el paso a paso está en [despliegue.md](despliegue.md):

- `villa-web` escucha solo en `127.0.0.1` y el firewall cierra el puerto 3000. Si alguien llega directo a Next, puede inventarse `X-Forwarded-For` y saltarse todos los límites por IP.
  - La unidad `deploy/systemd/villa-web.service` pone `HOSTNAME=127.0.0.1`.
  - `ufw` deja abiertos solo el 22, el 80 y el 443.
- **IP real del cliente.** Caddy reemplaza `X-Forwarded-For` por la IP que él mismo validó (`header_up X-Forwarded-For {client_ip}`).
  - Si se pone Cloudflare delante, se descomentan `trusted_proxies` y `client_ip_headers` en el `Caddyfile`. Así Caddy resuelve la IP real y la app no cambia.
  - Sin eso, todos los clientes compartirían los mismos contadores.
- Las dos unidades (`villa-web` y `villa-worker`) llevan `Environment=NODE_ENV=production`. Fuera de `development` o `test`, la app falla cerrado si faltan secretos o canales.
- **El registro de acceso de Caddy no guarda datos sensibles.** Esto importa porque el token de `/cita/<token>` permite cancelar y reprogramar.
  - Borra el token de `/cita/<token>` en cualquier parte de la ruta (queda `/cita/`), también en el registro de errores.
  - Quita las consultas, las cookies y el `Referer`.
  - Recorta la IP (/24 en IPv4, /48 en IPv6).
- **`BETTER_AUTH_SECRET` no se rota a la ligera.** Ese secreto:
  - cifra los secretos TOTP y los códigos de respaldo (`two_factor`);
  - firma las cookies de sesión y la de dispositivo conocido;
  - es la llave de los HMAC de los contadores de bloqueo y de límites.

  Si se cambia, nadie puede verificar su código de la app y **el dueño queda fuera**: habría que desactivar el TOTP en la base e inscribirlo de nuevo. Además, se pierden las sesiones y los bloqueos vigentes. Guarda una copia sellada fuera del VPS, junto con la clave de los backups.

**Pendiente, con su sprint:**

| Ítem | Riesgo | Cuándo |
|---|---|---|
| **Aplicar la separación de roles en el VPS**: correr `src/db/roles/setup-roles.sql` (crea `villa_owner`, `villa_app` y `villa_queue`), poner `DATABASE_URL` con `villa_app`, `MIGRATION_DATABASE_URL` con `villa_owner` y `QUEUE_DATABASE_URL` con `villa_queue`, y migrar. Hasta entonces la app sigue siendo dueña de las tablas. Con `NODE_ENV=production` el worker no arranca sin `QUEUE_DATABASE_URL`. Los pasos están en [despliegue.md](despliegue.md) §3–§6 | Medio: los triggers valen lo que valga el rol de la base | **Lo corre el dueño al desplegar, antes de la primera acción contable en producción** |
| HIGH-1, lo que queda: el search_path fijo incluye `pg_temp` al final (más estricto que `pg_catalog, public`); `villa_app` ya no tiene TEMP, pero si un DBA se lo devolviera, `pg_temp` va último y no tapa nada de `public`. Las funciones nuevas deben llevar el mismo `SET search_path` (lo exige la prueba de `pg_proc`) | Bajo | Hecho en el sprint 4; vigilar en cada migración |
| MEDIUM-3, lo que queda: con la caja abierta, recepción todavía ve los totales de las ventas del día y las propinas por pagar, que dan una idea aproximada del efectivo (no exacta: no dicen el medio). Y un gasto o consignación rechazado por falta de efectivo dice, aunque con mensaje genérico, que el monto supera el esperado: probando montos se podría acotar. El umbral de revisión lo cambia el dueño con reautenticación | Bajo | Aceptado; revisar con el dueño en el sprint 5 |
| Inscripción del TOTP por confianza en el primer uso: quien tenga la contraseña del dueño antes de que él inscriba su celular podría inscribir el suyo. Mitigación: el dueño inscribe el TOTP apenas recibe la cuenta, y la de cada socio nuevo tiene contraseña temporal que debe cambiar primero | Medio, solo en la ventana de inscripción | Aceptado; revisar en la auditoría del sprint 4 |
| Un código TOTP se acepta hasta unos 90 s (ventana de ±1 paso de 30 s) y better-auth no recuerda el último paso usado: alguien que lo vea por encima del hombro puede repetirlo en ese lapso | Bajo: necesita también la contraseña | Aceptado |
| Sin código QR en la inscripción: hay enlace `otpauth://` (abre la app en el celular) y clave para escribir a mano. Agregar QR exige una dependencia nueva | Bajo (usabilidad) | Sprint 5, si el dueño lo pide |
| Bloqueo por (correo, IP) detrás de CGNAT: quien comparta IP pública con el dueño (mismo operador móvil) puede bloquearle 15 minutos el ingreso desde esa red. La cookie de dispositivo conocido no lo exime de ese bloqueo, a propósito | Bajo | Aceptado; `npm run staff:unlock` lo resuelve |
| **Terminar la semana de prueba de la CSP**: la plantilla de `villa.env` arranca con `CSP_ENFORCE=false`. Al terminar la semana sin violaciones propias se borra esa línea y la CSP bloquea. Mientras tanto, un XSS no se frena: solo queda en el registro | Medio en el portal durante esa semana | Primera semana en producción ([despliegue.md](despliegue.md) §10) |
| La CSP permite `style-src 'unsafe-inline'`, porque los atributos `style` de React no llevan nonce. No ejecuta código, pero permite inyectar CSS si apareciera una inyección de HTML | Bajo | Aceptado |
| Supresión y backups: la lista de supresiones que se re-aplica al restaurar lleva ids internos y no un hash del celular, como pedía la auditoría (M7). El id es el mismo en cualquier copia, y un hash de un celular colombiano se revierte fácil. Si una supresión no se puede volver a aplicar (p. ej., el cliente tenía citas activas en esa copia), la restauración falla y alguien debe resolverla a mano | Bajo | Aceptado |
| La restauración sobre producción corre como superusuario (conserva los dueños): confía en el archivo. El runbook exige probarlo antes en una base de prueba, sin superusuario. age cifra pero no autentica: quien tenga la llave pública y escriba en el bucket podría subir un backup falso con su SHA-256 | Bajo: necesita la llave del bucket, que no borra ni sobrescribe | Aceptado |
| Con la app tomada, se puede marcar un aviso de bloqueo como entregado y luego borrarlo: el trigger solo frena el borrado de los pendientes | Bajo: el aviso del correo ya salió o salía en ese minuto | Aceptado |
| La purga la puede ejecutar `villa_app`, el mismo rol de la web. No tiene parámetros y solo borra lo vencido o lo de clientes anonimizados, así que adelantarla no borra nada antes de tiempo | Bajo | Aceptado |
| No se purgan `notification_events.error_detail` (errores del proveedor, sin el mensaje), ni la IP y el navegador de `client_consents`: son la prueba del consentimiento (Ley 1581, art. 9) y se guardan mientras exista la relación | Bajo | Aceptado; revisar con el abogado |
| La auditoría de lecturas cubre la agenda, la búsqueda de clientes y la ficha del cliente (sprint 7), por donde hoy se ve el celular. Toda pantalla nueva que muestre contacto debe llamar a `recordContactReads` | Bajo | Vigilar en cada pantalla nueva |
| Llave privada de age: si se deja en el VPS para la prueba de restauración automática, quien tome root también lee los backups viejos del bucket. Por defecto queda fuera del VPS y la prueba es manual | Bajo | Decisión del dueño ([despliegue.md](despliegue.md) §8) |
| **El kit de `deploy/` no se ha corrido en un servidor real.** Solo pasó `bash -n`, y localmente: `npm ci --ignore-scripts`, `tsx`, el build solo con `NEXT_PUBLIC_*` y `sanity.sql` en PGlite. Falta probar en el VPS las unidades, `install-kit.sh`, `deploy-release.sh`, el Caddyfile (`caddy validate`, socket de administración, `reload`), la subida con rclone, el bloqueo y las reglas del bucket (y que la llave no borre), la restauración como `villa_restore` y las supresiones al restaurar | Alto operativo hasta que se pruebe | Al desplegar, antes de abrir al público ([despliegue.md](despliegue.md) §12) |
| El worker corre desde el código con `tsx` (necesita las dependencias de desarrollo en el VPS) | Bajo | Aceptado; compilarlo si pesa |
| Verificar `X-Hub-Signature-256` en tiempo constante cuando exista el webhook de WhatsApp (estados de entrega) | Medio cuando exista | Cuando se agregue el webhook |
| Contar por IP más una cookie de dispositivo, porque el CGNAT de los operadores móviles hace que muchos clientes compartan IP | Bajo: un vecino abusivo bloquea a otros | Sprint 5, si se ve en producción |
| Bloquear un número a propósito: 6 solicitudes con Turnstile resuelto lo dejan sin reservar en línea 24 h. Se acepta y queda la reserva por teléfono | Bajo | Aceptado |
| Correr el primer backup en el bucket y **una restauración probada** con `cordura: OK` (el kit ya está en `deploy/backup/`) | Alto operativo | Lo corre el dueño al desplegar, antes de abrir al público |
| Prueba de penetración completa contra el entorno propio desplegado | Medio | Antes del lanzamiento, sobre el VPS ya montado |
| **Celular recordado en el navegador (sprint 6).** Tras verificar el código una vez, la cookie `villa_device` (httpOnly, 180 días, `SameSite=Lax`; la base guarda solo el SHA-256 del token) deja reservar sin código desde ese navegador. Quien robe la cookie puede reservar a nombre de esa persona (no ver ni cambiar sus citas: eso sigue en el enlace de gestión). Lo acotan Turnstile, el límite por IP, el tope propio `booking_known` (5 por hora y 10 al día por navegador; 40 por hora y 200 al día por sede, auditoría del sprint 6 M1), el tope de citas activas, "No soy yo" (revoca), "Olvidar los navegadores" en la ficha del cliente (sprint 7), el tope de 5 navegadores activos por cliente y la supresión de datos (revoca todo) | Bajo | Aceptado: menos pasos para el cliente frecuente |
| El código de verificación vuelve a la pantalla **solo** en desarrollo sin WhatsApp (`allowsDevFallbacks()` y sin `WHATSAPP_TOKEN`), para poder probar la reserva. Regla en `revealsCodeOnScreen` (`src/lib/public-readiness.ts`), con prueba de que con cualquier otro `NODE_ENV` es falso (B1). En producción `allowsDevFallbacks()` es falso y la respuesta no lo trae | Bajo | Vigilar: nunca correr el portal público con `NODE_ENV=development` |
| Recibo al cobrar: un reintento del mismo cobro (misma clave) con "Enviar el recibo" lo encola aunque el primer intento no lo pidiera. Es lo que permite mandarlo si el cobro pasó y la respuesta se perdió; `sale_receipt:<ULID>` impide que salga dos veces | Bajo | Aceptado (auditoría del sprint 6) |
| **Reserva en línea sin código (decisión del dueño, sprint 7).** Por defecto la reserva se confirma sin código por WhatsApp: cualquiera puede reservar con un número ajeno, y la regla de las faltas se esquiva con otro número o se usa contra un tercero. Lo acotan Turnstile, los límites por IP, por celular y por sede (60/h, 300/día), el tope de citas activas, la confirmación al dueño real del número y mensajes que no revelan el historial. La auditoría del cierre del sprint 7 cerró lo que no era parte de la decisión: sin código no se guardan correo, promociones ni autorizaciones a nombre de un cliente existente, ni se recuerda el navegador para él, y el ticket ya no muestra el nombre. Queda aceptado un bit: que un número no puede reservar en línea ahora (suspensión o tope). El interruptor de Ajustes "Pide código por WhatsApp al reservar" vuelve al flujo con código (docs/sprint-7-walk-in-faltas.md §6) | Medio | Aceptado por el dueño; vigilar reservas falsas tras el lanzamiento |
| **Revocación manual del celular recordado (auditoría del sprint 6, M2).** Resuelto: en la ficha del cliente (`/panel/clientes`, permiso `clients.manage`: dueño y recepción) está "Olvidar los navegadores", que revoca todos los activos del cliente con el evento `client.devices_forget` en la misma transacción. Queda abierto, opcional, el vencimiento por 90 días sin uso (hoy vencen a los 180 días de recordados) | Bajo | Resuelto en el sprint 7 ([sprint-7-walk-in-faltas.md](sprint-7-walk-in-faltas.md) §8); el vencimiento por desuso, si el dueño lo pide |
| `client_devices` crecía sin purga (una fila por verificación). Resuelto: el mantenimiento diario borra las filas revocadas o vencidas hace más de 30 días, y al recordar un navegador nuevo quedan como máximo 5 activos por cliente (se revocan los de uso más viejo). Para borrar, `villa_app` tiene DELETE solo sobre `client_devices`, y un trigger (0025) exige la misma regla fila por fila: con la app tomada no se borra un navegador activo ni uno que dejó de servir hace menos de 30 días; TRUNCATE sigue prohibido | Bajo | Resuelto en el sprint 7 (migración 0025) |
| `seed-demo` valida el host de `DATABASE_URL`, no la base: un túnel SSH a producción por `localhost` pasaría. Lo acota que no corre con `NODE_ENV=production` y que no pisa barberos existentes (B3). Las cuentas de prueba (recepcion@ y barbero@villa.test, sprint 6) solo se crean con base local y con una contraseña al azar que ve solo quien corre el seed: si llegaran a producción, nadie más conocería la clave (M-1). El equipo real sale de `seed-demo.equipo.local.json` (ignorado por git; Ley 1581) y en base local desactiva a los inventados sin borrarlos | Bajo | **Resuelto en el sprint 9** (`src/db/seed-demo-guard.ts`): además del host, mira la base. Producción registra sus respaldos cada noche (`backup_runs`, migración 0031) y el ambiente de pruebas no los configura; con algún respaldo registrado, `seed-demo` se niega aunque el host sea `localhost`. Forzado con `ALLOW_SEED_DEMO=1`, corre como base no local: sin cuentas de prueba ni abrir la reserva. No se exigió `ALLOW_SEED_DEMO=1` siempre: el túnel al ambiente de pruebas lo volvería costumbre y no distingue producción de pruebas. Queda (auditoría del sprint 9, medio): una producción recién instalada, antes de su primer respaldo, pasaría por el túnel. Lo acota el runbook: el respaldo manual de la instalación ([despliegue.md](despliegue.md) §8) y el que hace cada despliegue antes de migrar registran filas desde el primer día. Si hiciera falta más, un marcador de ambiente en la base |
| El recibo va al celular que tecleó quien cobra: si se equivocó, le llega a un tercero (servicios, total y medio de pago, solo primer nombre) (B4). Resuelto: la hoja de cobro muestra antes de enviar a dónde saldrá ("Se enviará por WhatsApp al 300 ••• ••67. Confírmalo con el cliente.", o el correo como `j•••@gmail.com`), calculado con la misma regla que el envío (`receiptDestination`/`preferredChannel` en `src/domain/notifications/channel.ts`). El celular recién tecleado en un walk-in se muestra completo para leérselo; sin canal, dice que no se puede enviar y no ofrece el envío | Bajo | Resuelto en el sprint 8 ([sprint-8-gastos-controles.md](sprint-8-gastos-controles.md) §2) |
| **Retirar la autorización de recordatorios o de marketing (cierre del sprint 6, B-3).** Resuelto: en la ficha del cliente, el personal retira el recordatorio o las promociones a pedido de la persona. Inserta una fila `granted = false`, `source = 'staff'` con la versión vigente de la política (sin UPDATE ni DELETE) y el evento `client.consent_withdraw` en la misma transacción, sin datos de la persona. El worker respeta la última fila al crear y al entregar. El tratamiento de datos no se retira ahí: eso es la supresión | Medio (Ley 1581: derecho a revocar) | Resuelto en el sprint 7 |
| El cliente recordado (reserva sin código) no volvía a autorizar. Resuelto: si su última autorización de datos o del recordatorio es de una política anterior a la vigente, la pantalla "Confirmar" pide una vez la casilla obligatoria (mismo texto del formulario); sin ella no se reserva, y con ella se guardan las filas nuevas en la transacción de la reserva, releídas con el cliente bloqueado. Un no previo al recordatorio (en línea o del personal) se respeta: la renovación no lo convierte en sí | Bajo (producto) | Resuelto en el sprint 7 |
| **Autorización dejada por quien tecleó el número (reserva sin código).** Con la reserva sin código, un número que todavía no está registrado queda con un navegador recordado sin verificar: quien lo tecleó (aunque no sea el titular) deja la autorización inicial y, después, la renovación, con su IP y su navegador como prueba. Mitigado: con un número ya registrado no se recuerda el navegador ni se escriben autorizaciones, y el interruptor "Pide código por WhatsApp al reservar" lo cierra | Bajo | Aceptado: decisión del dueño, sprint 7 |
| Reprogramar varias veces con más de 6 h de anticipación da un recordatorio por cada hora nueva (cierre del sprint 6, B-2). Solo llega al celular verificado del propio cliente y lo frenan el límite de gestión y la cuota por destinatario | Bajo | Aceptado |
| Las fotos de referencia de la portada se empaquetan siempre (`/_next/static/media`, ruta con hash) aunque `showsReferencePhotos()` las oculte; también saldrían si producción arrancara con `NODE_ENV` mal puesto (cierre del sprint 6, B-1) | Bajo | Sprint 9: reemplazarlas por las reales o quitarlas antes del lanzamiento |
| Los códigos de respaldo y la desactivación del TOTP se escriben directo en la base con el formato interno de better-auth (L11). Si una versión nueva cambia el formato, la prueba de punta a punta de `src/lib/auth.test.ts` falla; revisar el changelog de better-auth antes de subir de versión (B5) | Bajo | Aceptado, con la prueba como guarda |
| **Reapertura automática de hoy al abrir la caja (auditoría de caja, M1).** Por decisión del dueño, recepción siempre abre la caja; si el día de hoy estaba cerrado, abrirla lo reabre a su nombre, sin pedir permiso al dueño. Mitigado: queda en la bitácora con cuántas veces se reabrió ese día, Inicio del dueño lo avisa y, con correo configurado, le llega un aviso (sprint 8). Solo aplica a hoy; un día anterior cerrado sigue cerrado | Medio | Aceptado por el dueño; revisar si se abusa |
| Quien cobra puede quedarse con efectivo de una venta (cobrarla con otro medio o no registrarla) (auditoría de caja, M3). Es propio de cualquier caja; lo acotan el conteo a ciegas al abrir y al cerrar, la diferencia a nombre de quien abre y quien cierra, y el umbral que marca el cierre para revisión | Medio | Aceptado; control del dueño con el datáfono y el informe del día |
| La bitácora guarda el resumen de la reapertura en texto, no el conteo como campo (auditoría de caja, LOW-4). Los informes cuentan las filas de `day_close_events`, no el texto | Bajo | Aceptado |
| **Avisos al dueño sin correo (sprint 8).** Los avisos de anulación pedida, caja por revisar, día reabierto y cortesía (`owner.alerts`) salen solo con Resend configurado (`RESEND_API_KEY`, `EMAIL_FROM`), `ALERT_EMAIL` y `PUBLIC_BASE_URL`. No dependen de WhatsApp ni de Turnstile (tampoco los avisos de seguridad, desde el sprint 8). Sin esas variables no se envían ni se marcan: el registro dice cuáles faltan y el dueño solo los ve si abre Inicio, como antes | Medio operativo | Sprint 9: configurar Resend, `ALERT_EMAIL` y `PUBLIC_BASE_URL` al desplegar y probar un aviso |
| **Cortesía sobre un servicio cobrado en efectivo (auditoría del sprint 8, M1).** Quien da la cortesía puede haber recibido el efectivo y quedárselo: la cita sale de Por cobrar sin venta ni asiento, así que la caja cuadra igual. No hay forma de verlo en la caja; se detecta por el aviso al dueño (correo, si está configurado), por Inicio ("N cortesías en los últimos 7 días", sin contar las que dio el dueño, con enlace al informe) y por el informe de Cortesías, con quién la dio y el motivo. `appointment_courtesies` es solo-inserción también para el dueño de la base (triggers de la migración 0029) | Medio | Aceptado por diseño: el dueño revisa las cortesías |
| **Ventana de 2 días del barrido de avisos (auditoría del sprint 8).** El barrido de `owner.alerts` mira solo los eventos de los últimos 2 días (`OWNER_ALERT_LOOKBACK_MS`). Si el worker o el correo fallan más tiempo, esos eventos no generan correo. Siguen en Inicio (anulaciones pedidas y cajas por revisar, todas; la reapertura de hoy; las cortesías de 7 días) y en los informes y la bitácora. **Alerta de worker caído, resuelta en parte (sprint 9, migración 0030):** el worker late cada minuto en `worker_heartbeats` (una fila por proceso, sin datos personales; `villa_app` solo puede cambiar `beat_at`) y solo late si puede entregar (con la configuración del barrido). Si hay recibos o avisos al cliente en cola y el latido tiene más de 5 minutos, Caja (junto a "Cobros de hoy") e Inicio muestran "Los envíos de WhatsApp y correo están detenidos", y la hoja de cobro dice que el recibo queda en cola (`src/db/worker-heartbeat.ts`, consulta en SQL). Queda abierto: con el worker caído y sin mensajes al cliente en cola no se ve nada (los avisos al dueño de `owner_alerts` no cuentan), y un correo que falla con el worker vivo no se detecta aquí | Bajo | Resuelto en parte en el sprint 9; contar `owner_alerts` sin entregar si el dueño lo pide |
| `findClients` devuelve el destino enmascarado del recibo con el dominio completo del correo (`j•••@gmail.com`) (auditoría del sprint 8, B2). Solo lo reciben los roles con `appointments.manage.all`, que hoy también tienen `clients.view.contact` y ven el correo entero en la ficha | Bajo | Aceptado |
| **Inventario (sprint 6, fases A y B): el rol se exige en TypeScript, no en la base.** Que una compra del banco o la carga inicial (`paid_from` `bank`/`owner`) sea solo del dueño lo exige `recordPurchaseTx` (`src/db/inventory.ts`), como `addExpenseTx` con `expenses.bank`; la base no lo vuelve a mirar porque `created_by` no trae el rol. Con la app tomada se podría registrar una compra del banco a nombre de recepción. El cuadre (1435 = líneas, origen = total, caja = movimiento del turno) sí lo exige la base | Bajo: no descuadra, queda en la bitácora | Aceptado (revisado en la auditoría del sprint 6: sin cambios) |
| **Inventario: `sanity.sql` del backup mira 1435. Resuelto (fase E del sprint 6).** El chequeo de cordura de la restauración exige que ninguna línea de 1435 o 6135 venga de un asiento que no sea de inventario (o la reversa de una compra), que 1435 de cada sede sea el último conteo más las compras vigentes posteriores, que existan los triggers de 0032 a 0034 y que `villa_app` no pueda editar documentos de inventario. Probado en `src/db/backup-sanity.test.ts` | Bajo | Resuelto en el sprint 6 |
| **Inventario: la foto de una transacción SERIALIZABLE era anterior al candado (auditoría del sprint 6, M-1). Resuelto (migración 0035).** El candado consultivo serializaba compra, conteo y anulación, pero la foto de datos se toma en la primera sentencia, antes de esperarlo: un conteo que esperaba a una compra asentaba el ajuste sin verla, y SSI no garantiza abortarlo. Ahora cada operación actualiza la fila de su sede en `inventory_locks`; si otra la cambió después de la foto, Postgres aborta con 40001 y `serializable()` repite con datos frescos. Prueba determinista en `src/db/concurrency.pg.test.ts` (compra abierta con el candado, conteo que espera y debe ver la compra) | Medio | Resuelto en el sprint 6. Verificado contra PostgreSQL 18 real: las 12 pruebas de `concurrency.pg.test.ts` pasan en 4 corridas seguidas. Cómo correrlas sin la contraseña del superusuario: un clúster desechable con `initdb -U villa_test --auth=trust` en un puerto aparte (`TEST_PG_URL=postgres://villa_test@localhost:55432/villa_test`) |
| **Compras de mercancía de la caja hechas por recepción (auditoría del sprint 6, M-2).** Recepción puede sacar efectivo como "compra de mercancía" (`inventory.purchase`, sin reautenticación ni tope; el único límite es el efectivo del libro). A diferencia de un gasto, el dinero queda como inventario (1435) hasta el conteo. Mitigado: Inicio del dueño muestra "N compras de mercancía de la caja en los últimos 7 días ($…)", sin las del dueño ni las anuladas, con enlace a Productos; el turno las muestra en el desglose del esperado; el conteo revela unidades que nunca llegaron (diferencia en unidades) y la compra avisa si el costo por unidad supera el precio | Medio | Aceptado por diseño (decisión del dueño: compras de caja por recepción); un tope o aprobación por monto, si el dueño lo pide |
| **Cuentas por pagar: carrera de dos escritores sin el candado de la app (auditoría del sprint 8, parte A, B-1). Resuelto (migración 0037).** Los triggers diferidos de 0036 sumaban los pagos con la foto de su transacción: dos pagos escritos a mano en READ COMMITTED, o un pago y la anulación de la compra, podían confirmarse a la vez y pagar de más o pagar una compra anulada. Ahora el trigger del pago y uno nuevo sobre la reversa de una compra a crédito toman primero la fila de la sede en `inventory_locks` (el mismo candado de la app). Prueba determinista en `src/db/concurrency.pg.test.ts` (uno verifica y retiene su COMMIT): sin el candado fallan las dos, con él pasan | Bajo (la app ya tomaba el candado) | Resuelto en el sprint 8. Verificado contra PostgreSQL 18 real (14 pruebas, 4 corridas, una en base nueva) |
| **Nombre del proveedor con caracteres invisibles (auditoría del sprint 8, parte A, B-2). Resuelto.** `cleanSupplierName` rechaza controles C0/C1 e invisibles de formato (`\p{Cc}`, `\p{Cf}`) y normaliza a NFC, para que un proveedor no se parta en dos nombres ni la base devuelva un error genérico. Los homoglifos (una "a" cirílica) siguen pasando: solo el dueño crea proveedores y se ven en la lista al escribir | Bajo | Resuelto en el sprint 8 |
| **Recepción ve las cuentas por pagar pendientes en Caja (auditoría del sprint 8, parte A, B-3).** Para ofrecer "Pago a proveedor" de la caja, `loadCashView` le pasa a quien tiene `inventory.purchase` cada compra a crédito con saldo: proveedor, resumen, saldo y vencimiento (de su sede). No ve el total de 2205 ni los pagos del banco | Bajo | Aceptado por diseño (recepción paga a proveedores de la caja, como compra de caja); si el dueño no quiere, el pago de caja queda solo para él |
| Pago a proveedor repetido con la misma clave al mismo tiempo (auditoría del sprint 8, parte A, B-4): el segundo choca con `supplier_payments_idempotency_key` o con 40001 y `serializable()` lo repite, y entonces devuelve el mismo pago. No hay doble pago | Informativo | Aceptado |
| Los valores de los conteos llevan centavos (unidades × costo de la última compra, half-up una vez por línea con `mulDiv`), mientras compras y precios van en pesos enteros (auditoría del sprint 6, B-1). Es intencional: 1435 vale exactamente lo contado y la base lo verifica | Informativo | Aceptado |
| Un conteo exige contar todos los productos activos o con movimientos y acepta hasta 600 líneas; el catálogo no tenía tope (auditoría del sprint 6, B-2). **Resuelto:** a lo sumo 500 productos por sede (`MAX_PRODUCTS`, en `createProduct`) | Bajo | Resuelto en el sprint 6 |
| Ids internos de productos, compras y personal viajan al navegador (auditoría del sprint 6, B-3), como ya pasaba con servicios y personal. Sin IDOR: toda acción filtra por la sede de la sesión y responde con un mensaje genérico | Bajo | Aceptado; usar `public_id` si se exponen en URL |
| Los textos libres (notas de compra o conteo, nombres de productos, y también de servicios, clientes y personal) aceptan caracteres de control bidi y de ancho cero; la base solo excluye `[[:cntrl:]]` (auditoría del sprint 6, B-4). React los escapa (no hay XSS), pero pueden confundir a la vista en la bitácora y las listas, y solo los escribe quien ya tiene permiso | Bajo | **Resuelto en el sprint 9:** el saneador común `cleanText` (`src/domain/text.ts`, con prueba de propiedades) entra por `textSchema()` (`src/lib/action-schemas.ts`) en todo texto libre de las server actions. Quita los bidi y los invisibles de formato, menos el unidor entre emojis. Los controles, los saltos y los espacios raros los vuelve un solo espacio, recorta y pasa a NFC, antes de medir el mínimo y el máximo. La base sigue excluyendo solo `[[:cntrl:]]`: un escritor que se salte la app aún podría guardarlos. Contraseñas, códigos y teléfonos no pasan por él |
| **Inventario: corregir una compra mal registrada. Resuelto (migración 0033).** El dueño anula una compra desde "Compras recientes" en Productos (`reversePurchase`, con reautenticación y bitácora): asiento de reversa, nunca un borrado; la compra anulada deja de dar el costo de la "última compra". La base exige al COMMIT que no se anule una compra con un conteo posterior, que la de caja devuelva el efectivo a su mismo turno todavía abierto y que un conteo no se anule. Además, la compra avisa antes de registrar si el costo supera precio × unidades. Queda: una compra de caja de un turno ya cerrado no se anula (el arqueo ya la absorbió); se corrige con el conteo | Bajo | Resuelto en el sprint 6 |

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
