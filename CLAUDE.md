# Villa: reglas para Claude Code

Sistema de una barbería en Colombia: agenda de citas y contabilidad. **La prioridad número uno del dueño es que las cuentas nunca fallen.**

- Antes de cambiar algo estructural, lee [docs/arquitectura.md](docs/arquitectura.md).
- Para alcance y reglas de negocio, consulta [docs/00-descubrimiento.md](docs/00-descubrimiento.md).

## Reglas de dinero y contabilidad (no negociables)

- Los montos son `Money` (`src/domain/money.ts`): `bigint` en centavos.
  - **Nunca** `number`, `parseFloat`, `toFixed` ni `Math.round` sobre dinero.
  - En la base de datos son columnas `bigint`.
- Todo cálculo de dinero pasa por `src/domain/money.ts`:
  - porcentajes en puntos básicos;
  - repartos con `allocate()`.
- El libro contable es **solo-inserción**.
  - No escribas UPDATE ni DELETE sobre asientos.
  - Para corregir, crea un asiento de reversa.
- Cada asiento cuadra (débitos = créditos). Lo garantiza un constraint trigger en Postgres; no lo quites ni lo desactives.
- Cobro, caja y liquidación:
  - van en **una transacción**;
  - con clave de idempotencia.
- Los informes suman en SQL, no en el cliente.
- Toda regla contable nueva lleva un **test de propiedades** (fast-check), además de los ejemplos.

## Convenciones

- El código, los identificadores y la base de datos van en inglés. La interfaz y la documentación, en español (Colombia).
- `src/domain/` no importa Next.js, React ni la base de datos.
- `src/app/` es delgado: UI y server actions que llaman a `domain/`.
- **Fechas:**
  - se guardan como `timestamptz` en UTC;
  - se muestran en la zona de la sede (`America/Bogota`) con `@date-fns/tz`;
  - el día contable es la fecha local de la sede.
- Toda tabla operativa lleva `location_id`.
- IDs `bigint` internos. Hacia afuera, solo ULID o tokens.
- **Interfaz:**
  - mobile-first, a 360 px;
  - componentes de `react-aria-components`;
  - tokens de `src/app/globals.css`;
  - el latón (`laton`) nunca se usa para texto.

## Cierre de cada sprint

- Corre la auditoría del agente de seguridad (solo lectura) sobre todo lo nuevo.
- Corrige los hallazgos; los que no se puedan corregir aún van a la tabla "Seguridad: estado y plan" de [docs/arquitectura.md](docs/arquitectura.md), con su sprint.
- Toda server action nueva entra en `src/app/panel/authorization.test.ts`; la guarda de completitud falla si falta.

## Verificación antes de dar algo por terminado

```bash
npm run typecheck
npm test
npm run build
```
