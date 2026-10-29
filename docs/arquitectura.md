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

## Informes para el dueño en el celular

- La sección **Finanzas** se diseña primero para 360 px:
  - indicadores grandes;
  - lista en lugar de tabla ancha;
  - selector de periodo fijo arriba;
  - totales fijos abajo.
- El escritorio es la versión ampliada, no al revés.
- La PWA se instala en el celular. El dueño entra con MFA.
- Los informes leen el libro contable. **Nunca se calculan sumando en el cliente:** la suma la hace Postgres.

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
