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
