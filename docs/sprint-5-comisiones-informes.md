# Sprint 5: comisiones, informes, tablero y auditoría

Decisiones de diseño de la mitad "dinero" del sprint 5. Se apoya en el modelo contable del sprint 1 ([arquitectura.md](arquitectura.md), "Modelo contable" y ADR-001), en el cobro y la caja del sprint 4 ([sprint-4-cobro-caja.md](sprint-4-cobro-caja.md)) y en los flujos del descubrimiento (§3, §4, §5 "Liquidar comisiones" y §6). Lo que falta confirmar con el dueño o el contador está marcado **[confirmar]** y tiene un valor por defecto prudente. La lista completa está en §13.

El §12 es el **contrato** entre backend e interfaz: las dos partes lo construyen en paralelo, igual que en el sprint 4.

## 0. Alcance

**Entra:**

- **Liquidación de comisiones** por persona y fecha de corte:
  - lista de las líneas cobradas con su comisión congelada;
  - descuento de comisiones ya pagadas de ventas que después se anularon;
  - propinas por pagar (opcional, por defecto sí);
  - anticipos entregados antes de liquidar y su descuento;
  - ajustes con motivo obligatorio (a favor o en contra);
  - pago desde la caja o desde el banco;
  - comprobante imprimible con número consecutivo.
- **Anticipos** a barberos, desde la caja o el banco, y su reversa.
- **Reversa de una liquidación** (dueño, con reautenticación).
- **Informes** del dueño por rango de días contables: estado de resultados, ventas por barbero y por servicio, medios de pago, propinas, datáfono, gastos por categoría, diferencias de caja, inasistencias y liquidaciones. Exportación CSV.
- **Tablero del dueño** como inicio del panel.
- **Bitácora de auditoría** de las acciones financieras y de configuración, con visor para el dueño.
- **"Mis comisiones"** para el barbero: solo lo suyo.

**No entra:**

- Retención en la fuente, seguridad social, nómina o el documento soporte electrónico de la DIAN. El comprobante es interno **[confirmar con el contador si los barberos son empleados o contratistas]** (§13).
- Comisiones escalonadas o por meta: la comisión sigue siendo la congelada en cada línea al cobrar.
- Gráficos: los informes son tablas y cifras grandes. Se pueden agregar después sobre los mismos datos.
- Productos e inventario: fase 2.
- Lo que no es dinero en el sprint 5 (purga de datos personales, CSP con nonce, despliegue): va en otros documentos.

**Requisito previo:** el sprint 4 cerrado y la separación de roles de Postgres aplicada (Arquitectura, "Pendiente").

**Coordinación de la migración:** otro trabajo del sprint 5 está escribiendo `0012_security_ops.sql` (lecturas de datos personales, avisos de seguridad y la función de purga). La migración de este documento usa **el siguiente número libre al momento de implementarla** (hoy sería 0013). Las dos redefinen `app_apply_grants()`: la que llegue de segunda copia el cuerpo vigente y le suma lo suyo. Lo mismo con `schema.ts`.

## 1. Reglas de negocio (con su valor por defecto)

| Regla | Valor por defecto | Configurable |
|---|---|---|
| Qué se liquida | **Todo lo pendiente** de la persona hasta la fecha de corte. No se escogen líneas a mano: así nada se pierde y nada se paga dos veces | No |
| Fecha de corte | La elige el dueño. No puede ser futura ni anterior al corte de la última liquidación vigente de esa persona. La pantalla propone ayer | No. Frecuencia sugerida: quincenal **[confirmar]** |
| Venta con anulación pendiente | Sus líneas **no se liquidan**: quedan para la próxima, cuando la solicitud se decida | No |
| Venta anulada **después** de liquidarse | La liquidación pagada no se toca. La comisión ya pagada se **descuenta en la próxima liquidación** de esa persona (línea "Anulación de una venta ya liquidada") **[confirmar con el dueño]** | No |
| Propinas | Se incluyen por defecto todas las que se le deben (saldo 2380 de la persona), **truncadas a pesos enteros**; los centavos quedan pendientes. Si el saldo es negativo (propina pagada de una venta anulada), se descuenta siempre, aunque se desmarque la casilla | Sí, por liquidación: incluir o no |
| Anticipos | Activo **1365 Cuentas por cobrar a trabajadores** **[confirmar código con el contador; alternativa 1330 Anticipos y avances]**. Por defecto se descuenta todo lo que se pueda: el mínimo entre lo que debe y lo que se le va a pagar | Sí, por liquidación: cuánto descontar |
| Resultado negativo | Si lo descontado supera lo ganado, el pago es $0 y la diferencia queda como cuenta por cobrar (1365), que se descuenta en la siguiente. Nunca se le cobra dinero en la liquidación | No |
| Ajustes | Hasta 10 por liquidación, en pesos enteros, a favor o en contra, con motivo obligatorio (3 a 300 caracteres). Van a **5105 Comisiones** **[confirmar con el contador si los descuentos van a 4250 Recuperaciones]** | No |
| Pago | Desde la **caja** (exige turno abierto y que el libro tenga ese efectivo) o desde el **banco**. Un pago de $0 no mueve dinero | Sí, por liquidación |
| Quién liquida | Solo el dueño, **siempre con reautenticación** | No |
| Anticipos: quién los da | Solo el dueño. Reautenticación si salen del banco **[confirmar si recepción puede dar anticipos de la caja]** | No |
| Reversa de una liquidación | Solo la **última vigente** de esa persona (la más reciente primero). Dueño, reautenticación y motivo. Se registra en el día contable de hoy | No |
| Reversa de un anticipo | Solo si todavía no se descontó (el saldo por cobrar de la persona no puede quedar negativo). Dueño, reautenticación y motivo | No |
| Número del comprobante | Consecutivo por sede, lo pone la base. Las liquidaciones y los anticipos llevan series separadas. Una reversa no libera el número | No |
| Informes | Por **día contable** (fecha local de la sede). Rango máximo de 366 días | No |
| CSV | UTF-8 con BOM, separador `;`, fin de línea CRLF, montos `-12000,00` (§6.3) | No |

**Por qué "todo lo pendiente hasta el corte" y no un periodo cerrado [desde, hasta]:** una línea que quedó por fuera (por ejemplo, porque tenía una anulación pendiente que después se rechazó) entra sola en la siguiente liquidación. Con un periodo cerrado habría que acordarse de buscarla. El comprobante muestra la fecha de cada línea, así que el periodo real siempre se ve.

## 2. Modelo de datos

Todas las tablas llevan `location_id`, ids `bigint` internos, FK compuestas con `location_id` y `public_id` (ULID) cuando salen al cliente. El dinero es `bigint` en centavos. Siguen el patrón del sprint 4: solo-inserción, salvo el paso único a "revertida", que controla un trigger.

**Plan de cuentas.** Se agrega:

| Código | Nombre | Tipo |
|---|---|---|
| 1365 | Cuentas por cobrar a trabajadores (anticipos) | `asset` |

- En el dominio: `ACCOUNTS.staffReceivable`. `createLocation` ya inserta `CHART_OF_ACCOUNTS`, así que una sede nueva la trae.
- La migración la inserta en cada sede existente.

**`ENTRY_KINDS`** gana `staff_advance` (anticipo). `commission_payout` ya existe desde el sprint 1. Se actualiza el CHECK `journal_entries_kind_check`.

**`commission_settlements`**: una liquidación.

- Campos:
  - `public_id` (ULID) y `number` (consecutivo por sede; lo asigna un trigger con un candado por sede);
  - `staff_id`;
  - `period_from` (informativo: la fecha de la comisión más antigua incluida, o `cutoff_date` si no hay ninguna) y `cutoff_date`;
  - `business_date` (día en que se paga);
  - `status` (`settled` | `reversed`);
  - `paid_from` (`cash` | `bank` | null) y `cash_session_id` (solo si es de caja);
  - totales congelados: `commission_total` (C), `clawback_total` (V), `tips_total` (T, con signo), `adjustments_total` (J, con signo), `advance_deduction` (D), `carry_over` (K), `payout` (P);
  - `journal_entry_id` (`NOT NULL`, único) y `reversal_entry_id` (único, nullable);
  - `reversed_at`, `reversed_by`, `reversal_reason`;
  - `note` (opcional), `created_by`, `created_at`;
  - `idempotency_key`, `request_hash`, `reversal_idempotency_key`, `reversal_request_hash`.
- CHECK:
  - `payout = commission_total − clawback_total + tips_total + adjustments_total − advance_deduction + carry_over`;
  - `payout >= 0`; C, V, D y K `>= 0`; D y K no pueden ser los dos mayores que cero; si K > 0, el pago es 0;
  - todo en pesos enteros (`% 100 = 0`);
  - `paid_from` es null si y solo si `payout = 0`; `cash_session_id` existe si y solo si `paid_from = 'cash'`;
  - `period_from <= cutoff_date <= business_date`;
  - estado y campos de reversa coherentes (como `sales_voided_check`).
- Únicos: `(location_id, number)`, `public_id`, `(location_id, idempotency_key)`, `(location_id, reversal_idempotency_key)`.

**`commission_settlement_lines`**: el detalle. El `amount` lleva **signo: su efecto sobre el pago**. Así `payout = Σ amount` siempre.

| `kind` | `sale_line_id` | `amount` | Para qué |
|---|---|---|---|
| `commission` | Sí | `+` comisión congelada de la línea | Comisión ganada |
| `clawback` | Sí | `−` comisión congelada de la línea | Anulación de una venta ya liquidada |
| `tips` | No | `±` | Propinas pagadas, o recuperadas si es negativo |
| `adjustment` | No | `±`, con `reason` obligatoria | Bono o descuento |
| `advance_deduction` | No | `−` | Anticipos descontados |
| `carry_over` | No | `+` | Lo que queda debiendo (pasa a 1365) |

- Campo `reversed boolean NOT NULL DEFAULT false`: solo puede pasar de `false` a `true`, una vez, en la misma transacción en que su liquidación pasa a `reversed`. Todo lo demás es inmutable.
- **Una línea de venta se liquida una sola vez:** índice único parcial `commission_settlement_lines_commission_once` sobre `(location_id, sale_line_id) WHERE kind = 'commission' AND NOT reversed`. Lo mismo para `clawback` (`commission_settlement_lines_clawback_once`). Una reversa libera la línea (`reversed = true`) y vuelve a quedar pendiente.
- Un único `tips`, `advance_deduction` y `carry_over` por liquidación (índice único parcial por `(settlement_id, kind)`).
- Las líneas solo se insertan en la misma transacción que su liquidación (misma regla que `journal_lines`).

**`staff_advances`**: anticipos.

- Campos: `public_id`, `number` (consecutivo por sede, serie propia), `staff_id`, `amount` (> 0, pesos enteros), `paid_from` (`cash` | `bank`), `cash_session_id`, `business_date`, `reason` (3 a 300 caracteres), `journal_entry_id`, `status` (`active` | `reversed`), los campos de reversa, `created_by`, `idempotency_key` y `request_hash`.

**`cash_movements`**: el CHECK de `kind` suma `commission_payout` y `staff_advance`. `staff_id` es obligatorio si y solo si el tipo es `tip_payout`, `commission_payout` o `staff_advance`.

**`audit_events`**: §8.

**Saldos por persona: funciones SQL**, `STABLE`, con `search_path` fijo. Son la **única** definición: las usan la app, los informes, el tablero y los triggers.

```sql
-- Comisión que se le debe (2335 de la persona). Negativo = ya se le pagó una comisión que se anuló.
staff_commission_owed(p_location bigint, p_staff bigint) RETURNS numeric
  = Σ sale_lines.commission de la persona en ventas 'paid'
  − Σ commission_settlement_lines.amount (kind IN ('commission','clawback'), NOT reversed, de sus liquidaciones)

-- Propinas que se le deben (2380 de la persona).
staff_tips_owed(p_location, p_staff)
  = Σ sale_tips.payable de la persona en ventas 'paid'
  − Σ débitos a 2380 de sus cash_movements 'tip_payout'
  − Σ commission_settlement_lines.amount (kind = 'tips', NOT reversed)

-- Lo que la persona le debe al negocio (1365 de la persona). Nunca negativo.
staff_receivable(p_location, p_staff)
  = Σ staff_advances.amount (status = 'active')
  + Σ commission_settlement_lines.amount (kind IN ('carry_over','advance_deduction'), NOT reversed)
```

Por construcción, sumadas sobre todas las personas, dan exactamente el saldo del libro de 2335, 2380 y 1365. Es una prueba de propiedades obligatoria (§11).

`tipsOwed()` de `src/db/cash.ts` pasa a usar `staff_tips_owed`: así el pago de propinas en Caja ve también lo pagado en liquidaciones.

## 3. Asientos

Un solo asiento por operación, en la misma transacción que las filas operativas, con la clave de idempotencia de la operación (`settlement:<clave>`, `advance:<clave>`).

### 3.1 Liquidación (`commission_payout`)

| Componente | Cuenta | Lado |
|---|---|---|
| C: comisiones de las líneas | 2335 | Débito |
| V: anulaciones ya liquidadas | 2335 | Crédito |
| T > 0: propinas pagadas | 2380 | Débito |
| T < 0: propinas recuperadas | 2380 | Crédito |
| J: bonos (ajustes a favor) | 5105 | Débito |
| J: descuentos (ajustes en contra) | 5105 | Crédito |
| D: anticipos descontados | 1365 | Crédito |
| K: lo que queda debiendo | 1365 | Débito |
| P: pago | 1105 (caja) o 1110 (banco) | Crédito |

- G = C − V + T + J es lo ganado antes de anticipos.
- Si G ≥ 0: D va de 0 a min(saldo por cobrar, G); K = 0; P = G − D.
- Si G < 0: D = 0; K = −G; P = 0.
- Un componente en cero no lleva línea. Los bonos y los descuentos van en líneas separadas de 5105 (una por signo, con memo); nunca se compensan entre sí en el asiento.
- **Cuadre:** débitos − créditos = (C − V) + T + J − D + K − P = 0 en los dos casos.

**Ejemplo 1.** Andrés, corte al 15 de noviembre, pagado de la caja:

- comisiones pendientes: corte de $30.000 con $3.000 de descuento, al 40 % ($10.800); barba de $20.000 al 40 % ($8.000); corte y barba de $45.000 al 40 % ($18.000). C = $36.800;
- una venta del 28 de octubre, ya pagada en la liquidación N.º 11, se anuló el 3 de noviembre: V = $12.000;
- propinas por pagar: T = $15.000;
- ajuste a favor: $5.000, "Bono por cubrir el domingo";
- anticipo pendiente de $20.000 (10 de noviembre), se descuenta completo: D = $20.000.

G = 36.800 − 12.000 + 15.000 + 5.000 = $44.800. P = 44.800 − 20.000 = **$24.800**.

| Cuenta | Débito | Crédito |
|---|---|---|
| 2335 Comisiones por pagar | 36.800 | |
| 2335 Comisiones por pagar (anulación ya liquidada) | | 12.000 |
| 2380 Propinas por pagar | 15.000 | |
| 5105 Comisiones de barberos (bono) | 5.000 | |
| 1365 Cuentas por cobrar a trabajadores | | 20.000 |
| 1105 Caja | | 24.800 |
| **Total** | **56.800** | **56.800** |

Líneas de la liquidación: +10.800, +8.000, +18.000 (`commission`); −12.000 (`clawback`); +15.000 (`tips`); +5.000 (`adjustment`); −20.000 (`advance_deduction`). Suman $24.800 = `payout`. Queda un movimiento de caja `commission_payout` del turno por $24.800.

**Ejemplo 2.** Camilo, con arrastre: C = $6.000; una anulación de una venta ya liquidada, V = $18.000; sin propinas ni ajustes. G = −$12.000, así que K = $12.000 y P = $0.

| Cuenta | Débito | Crédito |
|---|---|---|
| 2335 Comisiones por pagar | 6.000 | |
| 1365 Cuentas por cobrar a trabajadores | 12.000 | |
| 2335 Comisiones por pagar (anulación ya liquidada) | | 18.000 |

No mueve dinero (`paid_from` null, sin movimiento de caja). Camilo queda debiendo $12.000, que se le descuentan en la siguiente liquidación como `advance_deduction`.

**Propinas con centavos.** Si la regla "las propinas asumen el datáfono" está activa, el saldo puede tener centavos ($15.000,50). Se liquidan $15.000 y los $0,50 quedan pendientes. Así el pago es siempre en pesos enteros, que es lo único que se puede sacar de la caja.

### 3.2 Anticipo (`staff_advance`)

| Operación | Débito | Crédito |
|---|---|---|
| Anticipo de la caja | 1365 | 1105 (movimiento de caja `staff_advance`) |
| Anticipo del banco | 1365 | 1110 |

### 3.3 Reversas

- **Liquidación:** `reverseEntry` del asiento, en el **día contable de hoy** (el dinero vuelve hoy, y el día del pago puede estar cerrado).
  - La liquidación pasa a `reversed` y todas sus líneas a `reversed = true` en la misma transacción. Sus comisiones, anulaciones, propinas y anticipos vuelven a quedar pendientes.
  - Si se pagó de la caja, exige la caja abierta y queda un movimiento `reversal` que **entra** efectivo (el barbero lo devuelve).
  - Si fue del banco, la reversa debita 1110.
- **Anticipo:** igual, en el día de hoy. La base rechaza la reversa si deja `staff_receivable < 0`, es decir, si el anticipo ya se descontó: "Este anticipo ya se descontó en una liquidación; revierte esa liquidación primero".
- Una reversa no se reversa (regla del libro). Para corregir otra vez, se liquida de nuevo.

**Por qué solo la última liquidación:** si se pudiera revertir una vieja, la anulación que se descontó en una posterior quedaría cobrada dos veces, y un arrastre ya descontado se perdería. Revertir de la más reciente hacia atrás mantiene los saldos correctos sin casos especiales.

### 3.4 Anulación después de liquidar (línea de tiempo)

1. **28 oct.** Venta V1 de Andrés: corte de $30.000, comisión del 40 % = $12.000. Asiento de venta: 5105 a 2335 por $12.000.
2. **31 oct.** Liquidación N.º 11 (corte al 31 oct): incluye V1. Débito 2335 por $12.000. `staff_commission_owed(Andrés)` = 0.
3. **3 nov.** El dueño aprueba la anulación de V1 (reabriendo el 28 oct si estaba cerrado, como en el sprint 4). La reversa debita 2335 y acredita 5105 por $12.000. La N.º 11 **no cambia**. Ahora `staff_commission_owed(Andrés)` = −$12.000 (ya se le pagó una comisión que no existe).
   - `decideVoid` devuelve el aviso: "La comisión de esta venta ya se le pagó a Andrés en la liquidación N.º 11. Se le descontará en su próxima liquidación."
4. **15 nov.** Liquidación N.º 12: lista "Anulación de una venta ya liquidada · 28 oct · −$12.000" (`clawback`), que acredita 2335 por $12.000. `staff_commission_owed(Andrés)` vuelve a 0.

Con las propinas es igual: si la propina de V1 ya se pagó (en Caja o en una liquidación), el saldo de propinas de Andrés queda negativo y la siguiente liquidación lo recupera con una línea `tips` negativa.

**Consecuencia sobre los informes:** la anulación se registra en el día de la venta (regla del sprint 4), así que los informes de octubre cambian después del 3 de noviembre. Es lo correcto contablemente, pero el dueño debe saberlo. Si se cambia la regla a "anular en el día actual" (§13), los informes de ventas por barbero dejan de coincidir con 4170 por rango y habría que leer las anulaciones por fecha de reversa.

## 4. Liquidación: cómo se arma

1. **Vista previa** (`previewSettlement`, solo lectura). El servidor lee de la base, nunca del navegador:
   - **Comisiones pendientes:** líneas de la persona en ventas `paid` con `business_date <= corte`, sin reclamo `commission` vigente y sin solicitud de anulación pendiente. Las que tienen solicitud pendiente se cuentan aparte ("1 venta espera una decisión de anulación").
   - **Anulaciones por descontar:** líneas de la persona en ventas `voided` con reclamo `commission` vigente y sin `clawback` vigente. Todas, sin importar la fecha de corte: son deudas ya causadas.
   - Saldos: `staff_tips_owed` y `staff_receivable`.
   - Calcula con `computeSettlement` (dominio, puro) y devuelve todo más un `previewToken`: SHA-256 del contenido canónico (persona, corte, ids y montos de las líneas, saldos, opciones elegidas).
2. **Confirmación** (`settleCommissions`), en una transacción SERIALIZABLE:
   1. Repetición por clave de idempotencia: misma clave y mismo contenido devuelve la liquidación original; otro contenido es un conflicto.
   2. `FOR UPDATE` sobre la fila de la persona en `staff_members`: dos liquidaciones (o una liquidación y un pago de propinas) de la misma persona se hacen en fila.
   3. Día de hoy abierto. Si es de caja: `requireOpenSession` (turno bloqueado `FOR UPDATE`).
   4. Vuelve a calcular la vista previa con los datos de esta transacción. Si el `previewToken` no coincide: "La liquidación cambió desde que la abriste (entró un cobro, una anulación o un pago). Revísala otra vez." Así el dueño nunca paga un monto distinto del que vio.
   5. Si es de caja: P ≤ efectivo del libro (`ledgerCash`); si no, `cashShortError`.
   6. Inserta la liquidación (la base pone el número), sus líneas, el asiento y, si es de caja y P > 0, el movimiento `commission_payout` del turno.
   7. Escribe el evento de auditoría (§8).
3. **Comprobante:** la interfaz va a `/panel/comprobantes/<publicId>`.

**Lo que la base garantiza** (constraint triggers diferidos, al hacer COMMIT), aunque la app tenga un error:

- Una línea `commission`:
  - es de una venta `paid` de la misma persona, con `business_date <= cutoff_date`;
  - no tiene solicitud de anulación pendiente;
  - su monto es exactamente la comisión congelada.
- Un `clawback`: es de una venta `voided` de la misma persona, con un reclamo `commission` vigente en **otra** liquidación vigente, y su monto es −comisión.
- Totales de la liquidación = Σ de sus líneas por tipo, y `payout = Σ amount`.
- El asiento es `commission_payout` y sus netos por cuenta son exactamente los de §3.1 (2335, 2380, 5105, 1365 y 1105 o 1110), sin otras cuentas.
- Si es de caja con P > 0, existe el movimiento del turno por P.
- **Completa:** después de la liquidación no queda ninguna comisión pendiente de esa persona con fecha `<= cutoff_date` (salvo las de anulación pendiente) ni ninguna anulación por descontar. Si incluye `tips`, |`staff_tips_owed`| < $1 al terminar.
- `staff_receivable >= 0` siempre (liquidaciones, anticipos y sus reversas).
- Al revertir: es la última liquidación vigente de la persona; `reversal_entry_id` reversa su asiento; todas sus líneas quedan `reversed`.
- Libro: un asiento `commission_payout` o `staff_advance` sin su fila operativa no se confirma; la reversa de uno de ellos solo existe como reversa de su fila (se extiende `ledger_assert_operational_row`). Ya no se puede registrar un `commission_payout` suelto con `postEntry`.

## 5. Concurrencia e idempotencia

- **Transacción.** Liquidar, revertir, dar y revertir anticipos corren en `serializable()` (reintento acotado ante 40001, 40P01 y claves de idempotencia duplicadas), igual que el sprint 4.
- **Persona.** `FOR UPDATE` sobre `staff_members` en liquidar, revertir, anticipos y también en `payTips` (cambio en `src/db/cash.ts`): todo lo que mueve los saldos de una persona se hace en fila.
- **Contra un cobro simultáneo:** la liquidación lee las líneas y el cobro inserta una. Si el cobro confirma primero, su línea no estaba en la foto de la liquidación y queda pendiente para la siguiente. No hay doble pago ni pérdida.
- **Contra una anulación simultánea:** la liquidación lee el estado de la venta y la anulación lo escribe; la anulación lee los reclamos para el aviso. SSI aborta a una y el reintento ve lo nuevo. Si gana la anulación, la vista previa cambió y el dueño revisa otra vez.
- **Doble liquidación de una línea:** el índice único parcial la hace imposible, aunque todo lo demás falle. La violación (`commission_settlement_lines_commission_once`) se traduce a "Alguna de estas comisiones ya se liquidó. Revisa la liquidación otra vez." en `FRIENDLY_UNIQUE`.
- **Reversas.** Se toma la liquidación (o el anticipo) `FOR UPDATE` antes de reversar: la segunda reversa ve el estado `reversed` y responde "Esta liquidación ya está revertida". Así no se llega a `journal_entries_reverses_entry_id_key`, cuyo mensaje amigable es el de las ventas.
- **Número consecutivo.** Lo asigna un trigger `BEFORE INSERT` con `pg_advisory_xact_lock` por sede y serie: sin huecos por carreras y sin depender de la app.
- **Caja.** El pago y el anticipo de caja exigen el turno abierto y bloqueado, y respetan 1105 ≥ 0 (trigger de 0011). Solo el dueño los hace, así que siempre recibe el mensaje exacto de efectivo.

## 6. Informes

Todo se suma **en SQL** (`sumAsBigint`, `GROUP BY`, `GROUPING SETS`) y viaja como texto de centavos. El dominio solo valida el periodo, da forma y verifica invariantes; nunca suma montos para mostrarlos. Los informes se leen en **una transacción REPEATABLE READ de solo lectura** (`readOnlySnapshot`), así todas las secciones son de la misma foto.

### 6.1 Periodo

- `from` y `to` son días contables (`YYYY-MM-DD`), inclusive. `from <= to`, máximo 366 días.
- Atajos: hoy, ayer, esta semana (lunes a domingo), este mes, mes anterior, este año. Se calculan con el "hoy" de la sede, nunca del navegador.
- Las citas (inasistencias) se filtran por el inicio de la cita convertido a la zona de la sede: `[from 00:00, to + 1 día 00:00)` local, pasado a UTC una vez.

### 6.2 Qué muestra cada informe

| Informe | Fuente y definición |
|---|---|
| **Estado de resultados** | Libro. Por cuenta de tipo `income` y `expense` con `journal_entries.business_date` en el rango. Ingresos = Σ(crédito − débito); gastos = Σ(débito − crédito); utilidad = ingresos − gastos. Totales por tipo y utilidad salen de la misma consulta (`GROUPING SETS`). Las propinas no aparecen: son pasivo (2380). 5310 puede ser negativo (sobrantes) y se muestra con signo |
| **Ventas por barbero** | `sale_lines` de ventas `paid` en el rango, por `staff_id`: servicios, bruto, descuentos, neto y comisión congelada; más propinas (`sale_tips.amount`) por persona |
| **Ventas por servicio** | Igual, por `service_id`, con el nombre actual del servicio y su participación en el neto |
| **Medios de pago** | `sale_payments` de ventas `paid` en el rango, por `kind` y `label`: cantidad de pagos, monto, costo de datáfono y participación |
| **Propinas** | Por persona: recibidas, parte del datáfono, por pagar causadas, y pagadas en el rango (pagos en Caja + líneas `tips` de liquidaciones vigentes, por fecha de pago) |
| **Datáfono** | 5305 del libro en el rango, y desglose por medio desde `sale_payments.fee` |
| **Gastos por categoría** | `expenses` en el rango, por categoría y origen (caja o banco) |
| **Diferencias de caja** | 5310 del libro en el rango, y el detalle: asientos `cash_adjustment` del rango unidos a su turno (`opening_entry_id` o `closing_entry_id`), con fecha, apertura o cierre, diferencia, nota y quién contó |
| **Inasistencias** | `appointments` reservadas (no walk-in) que empiezan en el rango: atendidas, no-show, canceladas (tarde o a tiempo; sin las retenciones vencidas). Tasa = no-show / (atendidas + no-show), en puntos básicos. Total y por barbero |
| **Liquidaciones** | `commission_settlements` con `business_date` en el rango: número, persona, corte, pago, origen y estado |

**Coherencia que se prueba** (§11): Σ neto de "Ventas por barbero" = Σ neto de "Ventas por servicio" = 4170 del estado de resultados; Σ comisión de las líneas = 5105 sin los ajustes de liquidaciones; Σ `sale_payments.fee` = 5305. Valen porque la anulación va en el día de la venta (§3.4).

**Índices que usan:** `journal_entries (location_id, business_date)`, `journal_lines_entry_idx`, `sales (location_id, business_date)`, las únicas de `sale_lines`, `sale_payments` y `sale_tips` por `sale_id`, y uno nuevo: `appointments (location_id, lower(during))`.

### 6.3 Exportación CSV

- **Formato:**
  - UTF-8 **con BOM**: sin él, Excel abre las tildes y la ñ como basura.
  - Separador **`;`**: Excel en español de Colombia usa la coma como separador decimal y el punto y coma como separador de lista; con `;` el archivo se abre en columnas con doble clic.
  - Fin de línea CRLF.
  - Montos en **pesos con coma decimal, siempre dos decimales y sin separador de miles**: `27000,00`, `-12000,00`, `358,80`. Excel en es-CO los lee como números y suman. Sin separador de miles porque el punto es ambiguo (un lector en otro idioma lo tomaría como decimal). Se generan desde `bigint` con `csvMoney` (nunca `number` ni `toFixed`).
  - Fechas ISO `2026-11-15`, que Excel reconoce como fecha.
- **Inyección de fórmulas:** toda celda de texto que empiece por `=`, `+`, `-`, `@`, tabulador, CR o LF se antepone con `'`. Las celdas con `;`, `"`, CR o LF van entre comillas dobles, con las comillas internas duplicadas. Los montos son celdas numéricas generadas por el servidor (cumplen `^-?\d+,\d{2}$`) y no se escapan. Los textos que entran (memos, motivos, nombres) siempre pasan por `csvText`.
- **Informes exportables:** estado de resultados, **libro diario** (fecha, número de asiento, tipo, memo, cuenta, nombre de la cuenta, débito, crédito; para el contador), ventas por barbero, ventas por servicio, medios de pago, propinas, gastos, diferencias de caja y liquidaciones.
- **Tope:** 50.000 filas. Si se pasa: "El periodo tiene demasiados movimientos para exportar; exporta por meses."
- **Entrega:** una server action devuelve `{ filename, csv }` y la interfaz arma el archivo con un `Blob`. Así la exportación queda dentro de la matriz de autorización (una ruta GET quedaría por fuera de la guarda de completitud). Cada exportación deja un evento de auditoría.
- Nombre: `villa-<informe>-<desde>-a-<hasta>.csv`.

### 6.4 Quién ve qué

| Qué | Dueño | Recepción | Barbero |
|---|---|---|---|
| Tablero, informes y CSV (`reports.financial`) | Sí | No | No |
| Comisiones de todos (`commissions.view.all`) | Sí | No | No |
| Liquidar, anticipos y reversas (`commissions.settle`) | Sí | No | No |
| Sus propias comisiones, liquidaciones, anticipos y comprobantes (`commissions.view.own`) | Sí (como todo) | No | Sí, solo lo suyo |
| Bitácora de auditoría (`audit.view`) | Sí | No | No |

Recepción sigue viendo lo del sprint 4 (Caja, ventas del día y propinas por pagar) y nada más.

## 7. Tablero del dueño

`/panel` lleva al dueño a `/panel/inicio` (quien tiene `reports.financial`); recepción sigue yendo a Agenda y el barbero a Mi día. Se lee en una sola foto de solo lectura, con unas 8 consultas pequeñas que usan índices existentes.

- **4 indicadores de hoy** (descubrimiento §10), cada uno contra el mismo día de la semana anterior:
  - **Ventas de hoy:** ingresos del libro (4170 + 4135) del día. Incluye descuentos y anulaciones; no incluye propinas.
  - **Servicios atendidos hoy:** líneas de ventas `paid` del día.
  - **Utilidad del mes:** estado de resultados del 1 a hoy, contra el mismo tramo del mes anterior (recortado si el mes anterior es más corto).
  - **Efectivo en caja:** saldo de 1105 si hay turno abierto (el dueño tiene `cash.review`), con quién la abrió y a qué hora; o "Caja cerrada".
  - La variación se calcula con `ratioBps` (half-up, una vez) y se muestra como "+12,5 %". Si el valor anterior es 0, no hay variación.
- **Alertas:** turnos por revisar (`sessionsNeedingReview`), anulaciones pendientes (`void_requests` `pending`), y "Ayer no se cerró el día" si ayer tuvo asientos y no tiene cierre. Cada alerta enlaza a su pantalla.
- **Por pagar al personal:** por persona con algo distinto de cero: comisión, propinas, lo que debe (1365) y el neto estimado. Enlaza a `/panel/comisiones/<staffId>`.
- **Próximas citas de hoy:** las 5 siguientes (`pending`, `confirmed`, `arrived`) desde ahora: hora, barbero, servicio y nombre del cliente.

## 8. Auditoría

**Lo que hay hoy:** registros parciales por dominio: `appointment_events`, `day_close_events`, `void_requests`, las marcas de revisión de `cash_sessions`, el libro mismo y `personal_data_reads` (lecturas de datos de contacto, 0012). **No hay** una bitácora general de las acciones de configuración: hoy no queda rastro de quién cambió el precio o la comisión de un servicio, un medio de pago, una regla de cobro o el rol de una persona. El descubrimiento lo pide en §4 "Transversales".

**Diseño mínimo: `audit_events`, solo-inserción.**

- Campos:
  - `location_id`;
  - `occurred_at` (lo pone la base, `now()`);
  - `actor_user_id` y `actor_staff_id` (FK compuesta);
  - `action`: CHECK contra la lista de `AUDIT_ACTIONS`;
  - `category`: `finanzas` | `configuracion` | `personal` | `informes`;
  - `target_kind` y `target_ref` (el `public_id` cuando existe; si no, el id interno como texto, que solo ve el dueño);
  - `summary`: texto en español de 1 a 300 caracteres, **sin datos personales de clientes** (ni nombres, ni celulares, ni correos);
  - `changes jsonb` (null salvo configuración): lista de `{ field, before, after }` solo con los campos de una lista blanca por tipo de objeto. Dinero como texto de centavos; nunca contraseñas, correos ni teléfonos. CHECK de tamaño (≤ 4 KB).
- Triggers de solo-inserción (sin UPDATE, DELETE ni TRUNCATE) y `villa_app` con solo SELECT e INSERT.
- Índices: `(location_id, id DESC)` y `(location_id, occurred_at)`.
- Se guarda indefinidamente: no contiene datos personales de clientes.

**Dónde se escribe:** con `recordAudit(tx, …)` **dentro de la misma transacción** de la escritura, en la capa `src/db/`, y **solo cuando la operación se creó** (`created: true`). Una repetición por idempotencia no duplica el evento; una operación que falla no deja evento. Las funciones de configuración que hoy no corren en transacción (servicios, ajustes, personal) pasan a hacerlo, y leen el antes con `FOR UPDATE`.

**Acciones que se auditan:**

| Categoría | Acciones |
|---|---|
| Finanzas | `sale.checkout`, `void.request`, `void.approve`, `void.reject`, `cash.open`, `cash.close`, `cash.review`, `expense.add`, `tips.pay`, `cash.deposit`, `day.close`, `day.reopen`, `settlement.create`, `settlement.reverse`, `advance.create`, `advance.reverse` |
| Configuración | `service.create`, `service.update`, `service.active`, `settings.booking`, `settings.checkout_rules`, `payment_method.save`, `expense_category.save`, `staff.bookable` |
| Personal | `staff.create`, `staff.update`, `staff.password_reset`, `staff.sessions_revoke`, `schedule.save` |
| Informes | `report.export` |

No se auditan los bloqueos de tiempo ni las citas: ya tienen su propio historial.

**Visor:** `/panel/auditoria`, solo el dueño (`audit.view`). Lista de 50 en 50 (cursor por id), filtros por rango de fechas y categoría. Cada evento muestra la hora en la zona de la sede, quién (`display_name`), la acción, el resumen y, si es de configuración, los cambios "antes → después". Lo anterior al sprint 5 sigue en sus tablas de origen; el visor no las une.

## 9. Permisos

`src/domain/staff/roles.ts` gana dos permisos, solo para el dueño (el dueño tiene todos):

- `commissions.settle`: liquidar, revertir liquidaciones, dar y revertir anticipos.
- `audit.view`: ver la bitácora.

Los que ya existen se usan así: `reports.financial` (tablero, informes y CSV), `commissions.view.all` (comisiones de todos y cualquier comprobante de la sede) y `commissions.view.own` (barbero: lo suyo). Recepción no gana nada.

| Acción | Permiso | Reautenticación |
|---|---|---|
| Ver comisiones de todos, vista previa | `commissions.view.all` / `commissions.settle` | No |
| Liquidar | `commissions.settle` | **Siempre** |
| Revertir una liquidación | `commissions.settle` | Siempre |
| Anticipo de la caja | `commissions.settle` | No |
| Anticipo del banco | `commissions.settle` | Sí |
| Revertir un anticipo | `commissions.settle` | Siempre |
| Comprobante | `commissions.view.all`, o `commissions.view.own` si es suyo | No |
| Mis comisiones | `commissions.view.own` | No |
| Tablero e informes | `reports.financial` | No |
| Exportar CSV | `reports.financial` | No |
| Bitácora | `audit.view` | No |

Cada acción nueva entra en `src/app/panel/authorization.test.ts`, con aislamiento entre sedes.

## 10. Pantallas (mobile-first, 360 px)

- **Inicio del dueño** (`/panel/inicio`): los 4 indicadores en tarjetas grandes (2 × 2 en el celular), alertas, "Por pagar al personal" y "Próximas citas". Cifras tabulares.
- **Comisiones** (`/panel/comisiones`): una fila por persona con lo que se le debe (comisión, propinas, lo que debe) y la última liquidación. Botón "Dar anticipo".
- **Comisiones de una persona** (`/panel/comisiones/[staffId]`):
  - pendientes agrupados por día, con el total arriba;
  - anulaciones por descontar, propinas y anticipos pendientes;
  - formulario de liquidación: fecha de corte (por defecto ayer), "Incluir propinas" (marcado), descuento de anticipos (por defecto el máximo), ajustes ("Agregar ajuste": a favor o en contra, valor y motivo), origen (caja o banco; caja deshabilitada con "Abre la caja" si no hay turno);
  - el botón grande dice "Pagar $24.800 a Andrés" (o "Registrar liquidación sin pago" si el pago es $0). Pide reautenticación y luego abre el comprobante;
  - historial de liquidaciones y anticipos, con "Revertir" solo en la última liquidación vigente y en los anticipos que se pueden revertir.
  - Lo que muestra antes de confirmar es la vista previa del servidor; la interfaz no calcula montos.
- **Comprobante** (`/panel/comprobantes/[publicId]`): liquidación o anticipo.
  - Encabezado con el nombre de la sede, "Comprobante de pago de comisiones N.º 0012", persona, periodo y fecha de pago.
  - Tabla real (`caption`, `th scope`, `tfoot`): fecha, servicio, neto, %, comisión. Luego anulaciones, propinas, ajustes con su motivo, anticipos descontados, lo que queda debiendo y el **total pagado**, con el origen.
  - Sin datos de clientes.
  - Pie con "Recibí conforme", espacio para firma y cédula escritas a mano, quién registró y el ULID.
  - Si está revertida: sello "REVERTIDA", con fecha, quién y motivo.
  - Botones "Imprimir" (`window.print()`) y "Compartir" (enlace; abrirlo exige sesión).
  - Hoja de impresión: oculta la navegación (`print:hidden` en `PanelNav` y `MobileTopBar`), una columna de 560 px como máximo, legible en A4 y en impresora de tirilla de 80 mm. El borde perforado del ticket en latón es decorativo; ningún texto va en latón.
  - Un `publicId` que no es ULID, que no existe o que no es de quien mira da **404**, igual en los tres casos.
- **Mis comisiones** (`/panel/mis-comisiones`, barbero): lo pendiente con sus líneas (hasta hoy), anulaciones por descontar, propinas, lo que debe, y sus liquidaciones y anticipos con enlace al comprobante.
- **Informes** (`/panel/informes`): selector de periodo fijo arriba (atajos y personalizado); secciones en lista para el celular y tabla en escritorio; totales fijos abajo; botón "Exportar CSV" por sección y "Libro diario" para el contador.
- **Auditoría** (`/panel/auditoria`): lista cronológica inversa con filtros.
- **Navegación:**
  - "Inicio" (`reports.financial`), "Comisiones" (`commissions.view.all`), "Mis comisiones" (barbero: `commissions.view.own` sin `view.all`), "Informes" (`reports.financial`) y "Auditoría" (`audit.view`).
  - En el celular, "Informes" y "Auditoría" van en el menú "Más" si la barra se llena (lo decide la interfaz).
- **Caja** (cambio menor): los movimientos muestran "Liquidación a Andrés" y "Anticipo a Andrés", y el desglose del esperado suma la línea "− pagos al personal (liquidaciones y anticipos)".

## 11. Pruebas obligatorias

**De propiedades (fast-check), dominio:**

- `computeSettlement`, para cualquier combinación de comisiones, anulaciones, propinas (con centavos y negativas), anticipos y ajustes:
  - `payout = C − V + T + J − D + K = Σ amount de las líneas`;
  - `payout >= 0`; D y K no son positivos a la vez; todo en pesos enteros;
  - `settlementEntry` pasa `assertValidEntry` (cuadra) y sus netos por cuenta son exactamente los de §3.1;
  - |propinas debidas − T| < $1, y T tiene el signo de lo debido o es 0;
  - D ≤ min(saldo por cobrar, max(G, 0)).
- `staffAdvanceEntry` cuadra.
- `toCsv`: un analizador mínimo en la prueba recupera exactamente cada celda de texto; ninguna celda de texto empieza por un carácter de fórmula; `csvMoney` cumple `^-?\d+,\d{2}$` y se lee de vuelta al mismo `bigint`.
- `assemblePnl`: utilidad = ingresos − gastos, y Σ filas = totales de SQL (si no, lanza).
- `ratioBps` y `rateBps` contra una referencia con fracciones exactas (half-up).
- `presetPeriod`: `from <= to`, máximo 366 días, y contiene a `today` cuando debe.
- `configChanges`: solo campos de la lista blanca; vacío si no hubo cambios.

**De propiedades, en la base (PGlite, unos 30 casos por propiedad):** secuencias al azar de cobros, anulaciones, pagos de propinas, anticipos, liquidaciones y reversas para dos barberos. Después de cada paso:

- Σ por persona de `staff_commission_owed` = saldo acreedor de 2335; lo mismo para `staff_tips_owed` y 2380, y `staff_receivable` y 1365 (deudor), con cada `staff_receivable >= 0`.
- Por persona: Σ (C − V) de sus liquidaciones vigentes + `staff_commission_owed` = Σ comisión congelada de sus líneas en ventas `paid`.
- Una línea de venta tiene a lo sumo un reclamo `commission` vigente y a lo sumo un `clawback` vigente.
- Todo asiento cuadra y el balance de comprobación total cuadra.
- Utilidad del informe = ingresos − gastos del balance de comprobación del mismo rango; Σ neto por barbero = 4170 del rango.
- 1105 ≥ 0 y el esperado de caja = Σ de los movimientos (la propiedad del sprint 4, con los tipos nuevos).

**De integración (PGlite):**

- Doble toque con la misma clave da una sola liquidación; misma clave con otro contenido da un conflicto.
- Dos liquidaciones simultáneas de la misma persona: una sola paga cada línea.
- Liquidación contra anulación simultánea de una de sus ventas: el resultado es coherente (o entra el `clawback` después o la línea no se paga).
- Un cobro que entra después de la vista previa: "La liquidación cambió…".
- Pago de caja sin turno abierto, o mayor que el efectivo del libro: rechazado.
- En un día cerrado no se liquida.
- Revertir una liquidación que no es la última: rechazado. Revertir dos veces: rechazado.
- Revertir un anticipo ya descontado: rechazado.
- Anular una venta ya liquidada: aviso en `decideVoid` y `clawback` en la siguiente vista previa; después de liquidar, la deuda vuelve a 0.
- Un `commission_payout` registrado con `postEntry` sin liquidación no se confirma; `reverseEntry` sobre el asiento de una liquidación sin pasar por `reverseSettlement` tampoco.
- Triggers: UPDATE y DELETE prohibidos en las tablas nuevas; una línea solo pasa a `reversed` con su liquidación revertida; no se agregan líneas a una liquidación ya confirmada.
- La migración inserta 1365 en las sedes existentes (`migration-00NN.test.ts`).
- Auditoría: cada acción de escritura deja exactamente un evento; una repetición por idempotencia no deja otro; una acción que falla no deja ninguno.

**De autorización:** la matriz completa con las acciones nuevas; el barbero abre su comprobante y recibe 404 con el de otro; recepción no alcanza informes, tablero, comisiones, comprobantes ni bitácora; el dueño de otra sede no alcanza nada.

**Cierre del sprint:** auditoría del agente de seguridad (solo lectura) sobre todo lo nuevo, con atención a: IDOR en comprobantes, inyección de fórmulas en el CSV, datos personales en `audit_events` y en el CSV, y que ningún monto pase por `number`.

## 12. Contrato backend ↔ interfaz (obligatorio)

Ambas partes se construyen en paralelo contra este contrato. Si una necesita cambiarlo, lo dice en su informe; no lo cambia en silencio. Valen todas las convenciones del sprint 4 §9: `ActionResult<T>`, `reauth_required` con `useReauth().run(...)`, ids internos como texto (`idSchema`), dinero que entra en pesos enteros (`…Units`), dinero que sale como centavos (`…Minor`) más etiqueta (`…Label`), `idempotencyKey` en toda escritura, y el servidor toma de la base todo lo que vale.

### 12.1 Dominio (puro; sin Next.js, React ni base de datos)

**`src/domain/money.ts`** (se agrega):

```ts
/** Trunca hacia cero al paso pedido: 1.500.050 centavos con PESO → 1.500.000. */
export function truncateTo(amount: Money, step: bigint): Money;
export function negate(amount: Money): Money;
/** part / whole en puntos básicos, half-up una sola vez; null si whole = 0. Solo para mostrar. */
export function ratioBps(part: Money, whole: Money): bigint | null;
```

**`src/domain/ledger/accounts.ts`**: `staffReceivable: { code: "1365", name: "Cuentas por cobrar a trabajadores (anticipos)", type: "asset" }`.

**`src/domain/ledger/entry.ts`**: `ENTRY_KINDS` agrega `"staff_advance"`.

**`src/domain/commissions/settlement.ts`**:

```ts
export class SettlementError extends Error {}   // va en BUSINESS_ERRORS de src/lib/action.ts
export const MAX_ADJUSTMENTS = 10;
export const MAX_SETTLEMENT_REASON = 300;

export type SettlementLineKind = "commission" | "clawback" | "tips" | "adjustment" | "advance_deduction" | "carry_over";
export type PaidFrom = "cash" | "bank";

export interface PendingCommission { readonly saleLineId: bigint; readonly businessDate: string; readonly commission: Money }
export interface PendingClawback { readonly saleLineId: bigint; readonly businessDate: string; readonly commission: Money }
export interface AdjustmentInput { readonly direction: "add" | "deduct"; readonly amount: Money; readonly reason: string }

export interface SettlementInput {
  readonly commissions: readonly PendingCommission[];
  readonly clawbacks: readonly PendingClawback[];
  /** staff_tips_owed: puede ser negativo o tener centavos. */
  readonly tipsOwed: Money;
  readonly includeTips: boolean;
  /** staff_receivable (≥ 0). */
  readonly receivable: Money;
  /** "max" = min(receivable, max(G, 0)). */
  readonly advanceDeduction: Money | "max";
  readonly adjustments: readonly AdjustmentInput[];
}

export interface SettlementLineDraft {
  readonly kind: SettlementLineKind;
  readonly saleLineId?: bigint;
  /** Con signo: efecto sobre el pago. */
  readonly amount: Money;
  readonly reason?: string;
}

export interface SettlementDraft {
  readonly lines: readonly SettlementLineDraft[];
  readonly commissionTotal: Money;   // C
  readonly clawbackTotal: Money;     // V
  readonly tips: Money;              // T, con signo, en pesos enteros
  readonly adjustmentsTotal: Money;  // J, con signo
  readonly gross: Money;             // G = C − V + T + J
  readonly advanceDeduction: Money;  // D
  readonly carryOver: Money;         // K
  readonly payout: Money;            // P = G − D + K
}

/** Lanza SettlementError con mensaje para el usuario. Nunca redondea comisiones (ya vienen congeladas). */
export function computeSettlement(input: SettlementInput): SettlementDraft;
/** Propinas que se liquidan: truncadas a pesos enteros (los centavos quedan pendientes). */
export function settledTips(owed: Money): Money;
/** Asiento commission_payout (§3.1). paidFrom null solo si payout = 0. */
export function settlementEntry(
  draft: SettlementDraft,
  meta: { businessDate: string; memo: string; idempotencyKey: string; paidFrom: PaidFrom | null },
): JournalEntryDraft;
/** Asiento staff_advance (§3.2). */
export function staffAdvanceEntry(
  amount: Money,
  paidFrom: PaidFrom,
  meta: { businessDate: string; memo: string; idempotencyKey: string },
): JournalEntryDraft;
/** Corte: no futuro, no anterior al último corte vigente. */
export function assertCutoff(input: { cutoffDate: string; today: string; lastCutoffDate: string | null }): void;
/** Solo la última liquidación vigente de la persona. */
export function assertReversible(input: { status: "settled" | "reversed"; number: bigint; latestActiveNumber: bigint | null }): void;
/** Motivo obligatorio, recortado, de 3 a 300 caracteres. */
export function requireSettlementReason(text: string | undefined, what: string): string;
```

**`src/domain/reports/`**:

```ts
// period.ts
export class ReportError extends Error {}         // va en BUSINESS_ERRORS
export const MAX_REPORT_DAYS = 366;
export type PeriodPreset = "today" | "yesterday" | "this_week" | "this_month" | "last_month" | "this_year";
export interface ReportPeriod { readonly from: string; readonly to: string }
export function reportPeriod(from: string, to: string): ReportPeriod;          // valida
export function presetPeriod(preset: PeriodPreset, today: string): ReportPeriod;
export function sameDayLastWeek(day: string): string;
export function sameSpanPreviousMonth(today: string): ReportPeriod;

// pnl.ts
export interface AccountTotalRow { readonly code: string; readonly name: string; readonly type: AccountType; readonly debits: bigint; readonly credits: bigint }
export interface PnlTotals { readonly income: bigint; readonly expenses: bigint; readonly profit: bigint }  // de SQL
export interface PnlLine { readonly code: string; readonly name: string; readonly amount: Money }
export interface Pnl { readonly income: readonly PnlLine[]; readonly expenses: readonly PnlLine[]; readonly totalIncome: Money; readonly totalExpenses: Money; readonly profit: Money }
/** Da forma y verifica (Σ filas = totales de SQL; utilidad = ingresos − gastos). Lanza ReportError si no. */
export function assemblePnl(rows: readonly AccountTotalRow[], totals: PnlTotals): Pnl;

// rates.ts
/** part / total en puntos básicos, half-up; null si total = 0. Para conteos (inasistencias). */
export function rateBps(part: bigint, total: bigint): bigint | null;

// csv.ts
export type CsvCell = { text: string } | { money: Money } | { date: string } | { count: bigint };
export const CSV_MAX_ROWS = 50_000;
export type CsvReport = "pnl" | "journal" | "by_staff" | "by_service" | "payments" | "tips" | "expenses" | "cash_differences" | "settlements";
export function csvMoney(amount: Money): string;   // "-12000,00"
export function csvText(value: string): string;    // neutraliza fórmulas y cita
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string;  // BOM + ";" + CRLF
export function csvFilename(report: CsvReport, period: ReportPeriod): string;
```

**`src/domain/audit/events.ts`**:

```ts
export const AUDIT_ACTIONS = [ /* la lista de §8 */ ] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditCategory = "finanzas" | "configuracion" | "personal" | "informes";
export const AUDIT_CATEGORY: Record<AuditAction, AuditCategory>;
export const AUDIT_LABELS: Record<AuditAction, string>;   // "Liquidó comisiones", "Cambió un servicio"…
export type AuditValue = string | boolean | null;         // dinero y bps como texto de dígitos
export interface AuditChange { readonly field: string; readonly before: AuditValue; readonly after: AuditValue }
/** Solo los campos de la lista blanca que cambiaron. */
export function configChanges(before: Record<string, AuditValue>, after: Record<string, AuditValue>, fields: readonly string[]): AuditChange[];
/** Una línea, sin saltos, recortada a 300. */
export function auditSummary(text: string): string;
```

### 12.2 Base de datos (`src/db/`)

**`src/db/commissions.ts`** (nuevo). Todas reciben `actor: ActorRef` cuando escriben y corren en `serializable()`:

```ts
export interface SettlementOptions {
  locationId: bigint; staffId: bigint; cutoffDate: string; includeTips: boolean;
  advanceDeduction: Money | "max"; adjustments: AdjustmentInput[]; paidFrom: PaidFrom; note: string | null; now?: Date;
}
export async function lockStaff(tx: Db, locationId: bigint, staffId: bigint): Promise<{ name: string; active: boolean }>;  // FOR UPDATE
export async function commissionBalances(db: Db, locationId: bigint, opts?: { staffId?: bigint }): Promise<StaffBalances[]>;
export async function previewSettlement(db: Db, opts: SettlementOptions): Promise<SettlementPreviewData>;  // con previewToken
export async function settleCommissions(db: Db, cmd: SettlementOptions & { previewToken: string; idempotencyKey: string; actor: ActorRef }):
  Promise<{ settlementId: bigint; publicId: string; number: bigint; payout: bigint; created: boolean }>;
export async function reverseSettlement(db: Db, cmd: { locationId: bigint; publicId: string; reason: string; idempotencyKey: string; actor: ActorRef; now?: Date }):
  Promise<{ created: boolean }>;
export async function giveAdvance(db: Db, cmd: { locationId: bigint; staffId: bigint; amount: Money; paidFrom: PaidFrom; reason: string; idempotencyKey: string; actor: ActorRef; now?: Date }):
  Promise<{ advanceId: bigint; publicId: string; number: bigint; created: boolean }>;
export async function reverseAdvance(db: Db, cmd: { locationId: bigint; publicId: string; reason: string; idempotencyKey: string; actor: ActorRef; now?: Date }):
  Promise<{ created: boolean }>;
export async function staffCommissionDetail(db: Db, input: { locationId: bigint; staffId: bigint; historyLimit?: number }): Promise<StaffCommissionDetail>;
export async function receiptByPublicId(db: Db, input: { locationId: bigint; publicId: string }): Promise<ReceiptData | null>;  // liquidación o anticipo, con staffId para el control de acceso
```

**`src/db/reports.ts`** (nuevo). Todas reciben `{ locationId, from, to }` y suman en SQL:

```ts
export function readOnlySnapshot<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T>;  // REPEATABLE READ, READ ONLY
export async function profitAndLoss(db, q): Promise<{ rows: AccountTotalRow[]; totals: PnlTotals }>;
export async function salesByStaff(db, q): Promise<{ staffId: bigint; name: string; services: number; gross: bigint; discount: bigint; net: bigint; commission: bigint; tips: bigint }[]>;
export async function salesByService(db, q): Promise<{ serviceId: bigint; name: string; services: number; gross: bigint; discount: bigint; net: bigint; commission: bigint }[]>;
export async function paymentMix(db, q): Promise<{ kind: PaymentKind; label: string; payments: number; amount: bigint; fees: bigint }[]>;
export async function tipsByStaff(db, q): Promise<{ staffId: bigint; name: string; tips: bigint; feeShare: bigint; payable: bigint; paidOut: bigint }[]>;
export async function cardFees(db, q): Promise<{ ledgerTotal: bigint; byMethod: { label: string; fees: bigint }[] }>;
export async function expensesByCategory(db, q): Promise<{ categoryId: bigint; name: string; paidFrom: "cash" | "bank"; count: number; amount: bigint }[]>;
export async function cashDifferences(db, q): Promise<{ net: bigint; items: { businessDate: string; moment: "opening" | "closing"; difference: bigint; note: string | null; by: string }[] }>;
export async function noShowStats(db, q & { timeZone: string }): Promise<{ total: NoShowRow; byStaff: (NoShowRow & { staffId: bigint; name: string })[] }>;
export async function settlementsInPeriod(db, q): Promise<SettlementSummaryRow[]>;
export async function journalDetail(db, q & { limit: number }): Promise<JournalDetailRow[]>;
export async function dashboardData(db: Db, input: { locationId: bigint; now?: Date }): Promise<DashboardData>;
```

**`src/db/audit.ts`** (nuevo):

```ts
export interface AuditEventInput {
  locationId: bigint; actorUserId: string; actorStaffId: bigint | null; action: AuditAction;
  targetKind: string; targetRef: string | null; summary: string; changes?: AuditChange[];
}
export async function recordAudit(tx: Db, event: AuditEventInput): Promise<void>;
export async function auditLog(db: Db, input: { locationId: bigint; before?: bigint; from?: string; to?: string; category?: AuditCategory; limit: number }): Promise<AuditRow[]>;
```

**Cambios en lo que existe:**

- `src/db/cash.ts`:
  - `tipsOwed` usa `staff_tips_owed`;
  - `payTips` toma `lockStaff`;
  - `MovementKind` suma `"commission_payout" | "staff_advance"`, y `sessionSummary` y `sessionExpectedFromMovements` los incluyen;
  - cada operación escribe su evento de auditoría.
- `src/db/voids.ts`: `decideVoid` agrega al `warning` el aviso de comisión ya liquidada (§3.4) y audita.
- `src/db/serializable.ts`: `FRIENDLY_UNIQUE` suma `commission_settlement_lines_commission_once` y `commission_settlement_lines_clawback_once` ("Alguna de estas comisiones ya se liquidó. Revisa la liquidación otra vez.").
- `src/db/sales.ts`, `expenses.ts`, `catalog.ts`, `staff.ts`, `checkout-settings.ts` y los ajustes de la sede: escriben su evento de auditoría en la misma transacción.

### 12.3 Server actions

**`src/app/panel/comisiones/actions.ts`:**

- **`loadCommissionsOverview()`** (`commissions.view.all`) devuelve `ActionResult<CommissionsOverview>`.

  ```ts
  type CommissionsOverview = {
    businessDate: string;
    staff: {
      staffId: string; name: string; active: boolean;
      pendingCommissionMinor: string; pendingCommissionLabel: string; pendingLines: number;
      clawbacksMinor: string; clawbacksLabel: string;
      tipsOwedMinor: string; tipsOwedLabel: string;
      receivableMinor: string; receivableLabel: string;
      estimatedPayoutMinor: string; estimatedPayoutLabel: string;   // con propinas y descontando todo lo que debe
      lastSettlement: { publicId: string; numberLabel: string; cutoffDate: string; payoutLabel: string } | null;
    }[];
    totals: { commissionOwedLabel: string; tipsOwedLabel: string; receivableLabel: string };
    canSettle: boolean;
  };
  ```

- **`loadStaffCommissions({ staffId })`** (`commissions.view.all`) devuelve `ActionResult<StaffCommissionsView>`.

  ```ts
  type StaffCommissionsView = {
    staff: { id: string; name: string; active: boolean };
    businessDate: string; dayClosed: boolean; cashSessionOpen: boolean;
    lastCutoffDate: string | null; suggestedCutoffDate: string;      // ayer, o el último corte si es posterior
    settlements: { publicId: string; numberLabel: string; businessDate: string; cutoffDate: string; payoutLabel: string;
                   paidFromLabel: string | null; status: "settled" | "reversed"; canReverse: boolean }[];   // últimas 24
    advances: { publicId: string; numberLabel: string; businessDate: string; amountLabel: string; reason: string;
                paidFromLabel: string; status: "active" | "reversed"; canReverse: boolean }[];               // últimos 24
  };
  ```

- **`loadSettlementPreview(input)`** (`commissions.settle`) devuelve `ActionResult<SettlementPreview>`. Entrada:

  ```ts
  {
    staffId: string; cutoffDate: string; includeTips: boolean;
    advanceDeductionUnits?: string;            // pesos enteros; sin el campo = el máximo
    adjustments: { direction: "add" | "deduct"; amountUnits: string; reason: string }[];   // hasta 10
    paidFrom: "cash" | "bank";
  }
  ```

  ```ts
  type SettlementPreview = {
    staff: { id: string; name: string };
    cutoffDate: string; periodFromDate: string | null; businessDate: string; dayClosed: boolean;
    commissions: { saleLineId: string; businessDate: string; description: string; netLabel: string; rateLabel: string;
                   commissionMinor: string; commissionLabel: string }[];
    clawbacks: { saleLineId: string; businessDate: string; description: string; settlementNumberLabel: string;
                 amountMinor: string; amountLabel: string }[];
    waitingVoidDecision: number;               // líneas que no entran por anulación pendiente
    tips: { owedMinor: string; owedLabel: string; settledMinor: string; settledLabel: string; included: boolean; mandatory: boolean };
    adjustments: { direction: "add" | "deduct"; amountLabel: string; reason: string }[];
    receivable: { outstandingMinor: string; outstandingLabel: string; maxDeductionMinor: string; maxDeductionLabel: string;
                  deductionMinor: string; deductionLabel: string };
    totals: { commissionLabel: string; clawbackLabel: string; tipsLabel: string; adjustmentsLabel: string;
              grossMinor: string; grossLabel: string; carryOverMinor: string; carryOverLabel: string;
              payoutMinor: string; payoutLabel: string };
    cash: { sessionOpen: boolean; enough: boolean };   // enough: el pago cabe en el efectivo del libro
    previewToken: string;                              // 64 hex
  };
  ```

- **`settleCommissionsAction({ ...entrada de la vista previa, note?, previewToken, idempotencyKey })`**: `commissions.settle` y **reautenticación**. Devuelve `ActionResult<{ publicId: string; numberLabel: string; payoutLabel: string; receiptHref: string }>`.
- **`reverseSettlementAction({ publicId, reason, idempotencyKey })`**: `commissions.settle` y reautenticación. Devuelve `ActionResult<undefined>`.
- **`giveAdvanceAction({ staffId, amountUnits, paidFrom, reason, idempotencyKey })`**: `commissions.settle`; reautenticación si `paidFrom = "bank"`. Devuelve `ActionResult<{ publicId: string; numberLabel: string; receiptHref: string }>`.
- **`reverseAdvanceAction({ publicId, reason, idempotencyKey })`**: `commissions.settle` y reautenticación. Devuelve `ActionResult<undefined>`.

Mensajes de error conocidos (prefijos):

- "No hay nada que liquidar";
- "La liquidación cambió desde que la abriste";
- "La fecha de corte no puede ser futura";
- "La fecha de corte no puede ser anterior a la última liquidación";
- "Abre la caja para pagar en efectivo" / "Abre la caja para entregar el anticipo" / "Abre la caja para recibir el efectivo de vuelta";
- "No hay tanto efectivo en la caja";
- "El día ya está cerrado";
- "El descuento de anticipos supera lo que se puede descontar";
- "Escribe el motivo del ajuste" / "Escribe el motivo del anticipo" / "Escribe el motivo de la reversa";
- "Solo se puede revertir la última liquidación de";
- "Esta liquidación ya está revertida" / "Este anticipo ya está revertido";
- "Este anticipo ya se descontó en una liquidación";
- "Alguna de estas comisiones ya se liquidó".

**`src/app/panel/comprobantes/actions.ts`:**

- **`loadReceipt({ publicId })`**: `requireStaff` y luego `commissions.view.all`, o `commissions.view.own` si el comprobante es de `staff.staffId`. En cualquier otro caso, `notFound()` (404, igual que si no existe). Devuelve `ActionResult<ReceiptView>`.

  ```ts
  type ReceiptView = {
    kind: "settlement" | "advance";
    publicId: string; numberLabel: string;            // "N.º 0012"
    status: "settled" | "reversed" | "active";
    locationName: string; staffName: string;
    businessDate: string; createdAtLabel: string; createdBy: string; paidFromLabel: string | null;
    period: { fromDate: string | null; cutoffDate: string } | null;
    commissions: { businessDate: string; description: string; netLabel: string; rateLabel: string; commissionLabel: string }[];
    clawbacks: { businessDate: string; description: string; settlementNumberLabel: string; amountLabel: string }[];
    tipsLabel: string | null;                          // con signo si es negativo
    adjustments: { direction: "add" | "deduct"; amountLabel: string; reason: string }[];
    advanceDeductionLabel: string | null; carryOverLabel: string | null;
    totals: { commissionLabel: string; clawbackLabel: string; grossLabel: string; payoutLabel: string } | null;
    advance: { amountLabel: string; reason: string } | null;
    reversal: { atLabel: string; by: string; reason: string } | null;
    note: string | null;
  };
  ```

**`src/app/panel/mis-comisiones/actions.ts`:**

- **`loadMyCommissions()`** (`commissions.view.own`; la persona sale de la sesión, nunca del navegador) devuelve `ActionResult<MyCommissionsView>`.

  ```ts
  type MyCommissionsView = {
    name: string; businessDate: string;
    pending: { totalMinor: string; totalLabel: string;
               lines: { businessDate: string; description: string; netLabel: string; rateLabel: string; commissionLabel: string }[] };  // hasta 200
    clawbacks: { businessDate: string; description: string; amountLabel: string }[];
    tipsOwedLabel: string; receivableLabel: string; estimatedPayoutLabel: string;
    settlements: { publicId: string; numberLabel: string; businessDate: string; cutoffDate: string; payoutLabel: string; status: "settled" | "reversed" }[];
    advances: { publicId: string; numberLabel: string; businessDate: string; amountLabel: string; status: "active" | "reversed" }[];
  };
  ```

**`src/app/panel/informes/actions.ts`** (`reports.financial`):

- **`loadReport({ from, to })`** devuelve `ActionResult<ReportView>`.

  ```ts
  type AmountRow = { code: string; name: string; amountMinor: string; amountLabel: string };
  type ReportView = {
    period: { from: string; to: string; label: string };
    presets: { key: PeriodPreset; label: string; from: string; to: string }[];
    pnl: { income: AmountRow[]; expenses: AmountRow[]; totalIncomeMinor: string; totalIncomeLabel: string;
           totalExpensesMinor: string; totalExpensesLabel: string; profitMinor: string; profitLabel: string;
           marginLabel: string | null };
    byStaff: { staffId: string; name: string; services: number; grossLabel: string; discountLabel: string;
               netMinor: string; netLabel: string; commissionLabel: string; tipsLabel: string }[];
    byService: { serviceId: string; name: string; services: number; netMinor: string; netLabel: string; shareLabel: string | null }[];
    payments: { kind: "cash" | "card" | "transfer" | "wallet"; label: string; payments: number; amountMinor: string;
                amountLabel: string; feesLabel: string; shareLabel: string | null }[];
    tips: { rows: { staffId: string; name: string; tipsLabel: string; feeShareLabel: string; payableLabel: string; paidOutLabel: string }[];
            totalLabel: string };
    cardFees: { totalLabel: string; byMethod: { label: string; feesLabel: string }[] };
    expenses: { name: string; paidFrom: "cash" | "bank"; count: number; amountLabel: string }[];
    cashDifferences: { netMinor: string; netLabel: string;
                       items: { businessDate: string; moment: "opening" | "closing"; differenceLabel: string; sign: "+" | "-"; note: string | null; by: string }[] };
    noShow: { reservations: number; completed: number; noShow: number; cancelled: number; lateCancelled: number; rateLabel: string | null;
              byStaff: { name: string; completed: number; noShow: number; rateLabel: string | null }[] };
    settlements: { publicId: string; numberLabel: string; staffName: string; cutoffDate: string; businessDate: string;
                   payoutLabel: string; status: "settled" | "reversed" }[];
  };
  ```

- **`exportReportCsvAction({ report, from, to })`**, con `report` de `CsvReport`. Devuelve `ActionResult<{ filename: string; csv: string }>` (el BOM va incluido) y deja el evento `report.export`.

**`src/app/panel/inicio/actions.ts`** (`reports.financial`):

- **`loadDashboard()`** devuelve `ActionResult<DashboardView>`.

  ```ts
  type DashboardView = {
    businessDate: string; dayClosed: boolean;
    kpis: { key: "sales_today" | "services_today" | "profit_month" | "cash"; label: string; valueLabel: string;
            compareLabel: string | null; changeLabel: string | null; trend: "up" | "down" | "flat" | null }[];
    cash: { open: boolean; openedAtLabel: string | null; openedBy: string | null; expectedLabel: string | null };
    alerts: { kind: "cash_review" | "void_pending" | "day_unclosed"; count: number; label: string; href: string }[];
    owed: { staffId: string; name: string; commissionLabel: string; tipsLabel: string; receivableLabel: string;
            netMinor: string; netLabel: string }[];
    upcoming: { atLabel: string; staffName: string; serviceName: string; clientName: string | null;
                status: "pending" | "confirmed" | "arrived" }[];
  };
  ```

**`src/app/panel/auditoria/actions.ts`** (`audit.view`):

- **`loadAuditLog({ before?, from?, to?, category? })`** devuelve `ActionResult<{ events: { id: string; atLabel: string; actorName: string; categoryLabel: string; actionLabel: string; summary: string; changes: { field: string; before: string; after: string }[] }[]; nextCursor: string | null }>`. Los valores de `changes` ya vienen formateados (dinero como "$ 30.000", bps como "40 %", booleanos como "Sí"/"No").

**Validación de entradas (zod):** `idSchema`, `dateSchema`, `unitsSchema` e `idempotencyKeySchema` de siempre; `publicId` con `isUlid`; `reason` con `trim`, de 3 a 300; `previewToken` con `^[0-9a-f]{64}$`; `adjustments` con `.max(10)`; `report` con `z.enum` de `CsvReport`; `category` con `z.enum`.

### 12.4 Rutas y pantallas (las hace la interfaz)

- `/panel` redirige: `reports.financial` → `/panel/inicio`; recepción → `/panel/agenda`; barbero → `/panel/mi-dia`.
- `/panel/inicio`, `/panel/comisiones`, `/panel/comisiones/[staffId]`, `/panel/comprobantes/[publicId]`, `/panel/mis-comisiones`, `/panel/informes`, `/panel/auditoria`.
- Navegación como en §10. `PanelNav` y `MobileTopBar` llevan `print:hidden`.
- En Caja: los tipos de movimiento nuevos y la línea del desglose (§10).

### 12.5 Permisos (`src/domain/staff/roles.ts`)

- `PERMISSIONS` suma `"commissions.settle"` y `"audit.view"`. El dueño los recibe por `new Set(PERMISSIONS)`; recepción y barbero no cambian.
- `roles.test.ts`: recepción y barbero no tienen ninguno de los dos; el barbero conserva `commissions.view.own` y no tiene `commissions.view.all` ni `reports.financial`.
- `authorization.test.ts`: `STAFF_MODULES` suma `comisiones`, `comprobantes`, `mis-comisiones`, `informes`, `inicio` y `auditoria`, con cada acción en la matriz. Además, una guarda nueva: cada acción de escritura del personal está en un mapa `AUDITED` → `AuditAction` y, al ejecutarla con permiso, deja exactamente un evento.

### 12.6 Migración (siguiente número libre; hoy 0013)

Generada con drizzle-kit para las tablas y columnas, más una sección escrita a mano, como 0010 y 0011:

1. **Cuentas.** `INSERT INTO accounts (location_id, code, name, type) SELECT id, '1365', 'Cuentas por cobrar a trabajadores (anticipos)', 'asset' FROM locations ON CONFLICT DO NOTHING`.
2. **Tipos de asiento.** `journal_entries_kind_check` suma `staff_advance`.
3. **Tablas:** `commission_settlements`, `commission_settlement_lines`, `staff_advances` y `audit_events`, con sus CHECK, FK compuestas, únicos e índices (§2 y §8). Además, `appointments (location_id, lower(during))`.
4. **`cash_movements`:** CHECK de `kind` y de `staff_id` (§2).
5. **Funciones de saldo:** `staff_commission_owed`, `staff_tips_owed` y `staff_receivable`.
6. **Triggers:**
   - solo-inserción en las cuatro tablas, salvo el paso único a revertida (`commission_settlements`, `staff_advances`) y `reversed` en las líneas;
   - `BEFORE INSERT` de líneas: reglas de `commission` y `clawback` (§4) y misma transacción que su liquidación;
   - `BEFORE INSERT` de liquidaciones y anticipos: `number` consecutivo con candado por sede;
   - `BEFORE INSERT` de `audit_events`: `occurred_at = now()`;
   - diferidos: totales = líneas = asiento; completitud; `staff_receivable >= 0`; propinas en menos de $1 si hay línea `tips`; reversa de la última; movimiento de caja si es de caja;
   - `ledger_assert_operational_row`: `commission_payout`, `staff_advance` y sus reversas (y el `WHEN` del trigger los incluye);
   - `cash_movements_assert_entry`: montos de `commission_payout` y `staff_advance`; un `reversal` mueve efectivo en sentido **contrario** al del asiento que reversa (hoy exige siempre salida), y puede reversar una venta, una liquidación o un anticipo.
7. **`app_apply_grants()`** (partiendo del cuerpo vigente, incluido lo de 0012): SELECT e INSERT en las tablas nuevas; UPDATE solo en `commission_settlements (status, reversal_entry_id, reversed_at, reversed_by, reversal_reason, reversal_idempotency_key, reversal_request_hash)`, `staff_advances` (las mismas columnas) y `commission_settlement_lines (reversed)`. `audit_events` sin UPDATE ni DELETE. Termina con `SELECT app_apply_grants();`.
8. Toda función nueva lleva `SET search_path = pg_catalog, public, pg_temp` (lo exige `roles.test.ts`).

### 12.x Ajustes de implementación

Lo que se construyó distinto de lo anterior, ya acordado con la interfaz:

- **Comprobantes, sin permiso alguno.** `loadReceipt` manda a `/panel?sin-permiso=1` si el rol no tiene `commissions.view.all` ni `commissions.view.own` (recepción), como cualquier otra pantalla sin permiso. Sigue dando `notFound()` para un id que no es ULID, que no existe, de otra sede o de otra persona.
- **Auditoría de configuración en la capa de acciones.** En servicios, ajustes y personal, la transacción, la foto del antes (`FOR UPDATE`) y el evento van en la server action, no en `src/db/`: las funciones de `catalog.ts`, `locations.ts`, `checkout-settings.ts`, `staff.ts` y `credentials.ts` conservan su firma. Las que ya abrían transacción quedan como un savepoint. La garantía es la misma: el evento va en la transacción de la escritura.
- **`lockStaff`** vive en `src/db/cash.ts` (lo usa `payTips`) y `commissions.ts` lo reexporta.
- **`assertReversible`** recibe además `staffName` opcional, para decir "Solo se puede revertir la última liquidación de Andrés".
- **`estimatedPayout`** se agregó al dominio: el neto estimado de Comisiones, Mis comisiones y el tablero (nunca negativo). La cifra que se paga la da siempre `computeSettlement`.
- **`tips.mandatory`** es verdadero solo si hay que recuperar al menos un peso entero (lo liquidado es negativo), no con cualquier saldo negativo: un saldo de menos de $1 no se puede liquidar. `tips.included` = `includeTips` o `mandatory`.
- **`staffCommissionDetail`** devuelve `null` si la persona no es de la sede; `loadStaffCommissions` lo convierte en un error de negocio.
- **Denominadores en SQL.** `salesByService` suma `totalNet`, `paymentMix` suma `totalAmount` y `tipsByStaff` suma `totalTips`, para que participaciones y totales no se sumen en la aplicación. `commissionBalanceTotals` da los totales de la cabecera de Comisiones.
- **Regla adicional en la base.** Al confirmar una liquidación, el saldo de propinas debe quedar por encima de −$1, aunque no lleve línea de propinas.
- **Reintento.** `serializable()` también reintenta los choques únicos en `*_number_key` (el consecutivo por sede).
- **`loadAuditLog`** exige su argumento (`{}` para la primera página), como dice el contrato.

**Cierre del sprint (revisión contable y de seguridad):**

- **Una reversa se registra hoy.** Revertir una liquidación o un anticipo crea el asiento en el día contable de hoy, no en el de la liquidación: los ajustes en 5105 pasan al informe de hoy y el periodo pasado no cambia. Con el día de hoy cerrado no se revierte nada hasta reabrirlo.
- **Orden de las reversas (M-1).** Un anticipo no se revierte si una liquidación vigente posterior lo descontó o arrastró saldo (`advance_deduction > 0` o `carry_over > 0`): primero se revierte esa liquidación. `reverseSettlement` verifica antes que 1365 no quede negativo (`receivable + descuento − arrastre ≥ 0`) y lo dice con un mensaje de negocio.
- **Mensajes de los triggers diferidos (L-5).** `friendlyConstraintError` traduce los `check_violation` de comisiones que saltan al confirmar (1365 negativo, anticipo ya descontado, liquidación que cambió, solo la última) a errores de negocio.
- **Líneas por tandas (L-1)** de 2.000 al insertar una liquidación. **Índice parcial (L-2)** `sale_lines_staff_commission_idx` sobre `(location_id, staff_id) where commission > 0`: deja fuera las líneas sin comisión. No filtra las ya liquidadas, porque eso vive en otra tabla.
- **0013 no corre sobre pagos de comisión previos.** Un bloque `DO` aborta la migración si ya hay asientos `commission_payout`: quedarían como comisiones pendientes.
- **CSV sin texto libre (M-2).** El libro diario sale con una etiqueta fija por tipo de asiento (Venta, Reversa, Anticipo…), sin memo. Diferencias de caja sale sin la nota. En pantalla la nota se sigue viendo. Desde este sprint, la reversa de una anulación lleva como memo "Anulación de la venta <ULID>", sin el motivo.
- **Datáfono y propinas (M-4).** Con "las propinas asumen el datáfono", el informe agrega la fila "Parte absorbida por las propinas" (Σ `sale_tips.fee_share` de las ventas pagadas del rango), así que Σ medios − esa fila = 5305.
- **CSV (L1):** la fórmula se busca en el primer carácter después de quitar espacios Unicode, controles e invisibles (`\p{Z}\p{Cc}\p{Cf}`).
- **Bitácora:** un CHECK ata cada acción a su categoría (L-6). Hay eventos nuevos para cambiar la contraseña propia, desactivar el TOTP y generar códigos de respaldo (L11). Se registran después del cambio, que better-auth confirma en su propia transacción. *(Sprint 6: ya van en la misma transacción que el cambio; ver arquitectura.md.)*
- **Anticipos (L8):** todo anticipo pide reautenticación, también el de caja.
- **Tablero (L7):** el esperado de la caja abierta solo sale para quien tiene `cash.review`.

### 12.8 Supresión de datos a solicitud del titular

- **Quién:** el dueño (`clients.erase`), con reautenticación, en `/panel/clientes`. Busca al cliente, ve qué se borra y qué se conserva y confirma escribiendo SUPRIMIR. Acción `eraseClientAction`; evento `client.erase` (categoría personal, `target_ref` = id interno, sin nombre ni contacto).
- **Requisito:** sin citas activas (pendiente, confirmada, llegó, en silla). Una sola transacción (`eraseClient`, SERIALIZABLE).
- **Qué hace la base** (`erase_client_personal_data(location_id, client_id)`: SECURITY DEFINER de `villa_owner`, `search_path` fijo, EXECUTE solo para `villa_app`):
  - el cliente pasa a "Anónimo", sin celular ni correo;
  - se borran las notas y los motivos de cancelación de sus citas y los motivos de sus eventos;
  - se revocan sus enlaces de cita;
  - en las verificaciones se borran IP, navegador, nombre y correo;
  - en los consentimientos se borran IP y navegador (qué aceptó, de qué versión y cuándo se queda como prueba);
  - se vacían los parámetros de sus avisos y el detalle de error de sus envíos;
  - los motivos y notas de sus solicitudes de anulación y la descripción del movimiento de caja de esas anulaciones pasan a `[suprimido]`.

  Cada tabla solo-inserción admite ese único vaciado, y solo si el cliente ya está anonimizado. La función se puede repetir, para volver a aplicarla tras restaurar una copia.
- **Qué se conserva:** ventas y libro, intactos (la venta apunta al cliente anónimo).
  - Los memos de reversas anteriores a este sprint pueden tener el motivo de una anulación: el libro es solo-inserción, así que se quedan, pero no se exportan y no tienen visor.
  - `sale_lines.discount_reason` (texto libre del descuento) tampoco se toca: hoy no se muestra ni se exporta.

## 13. Para confirmar con el dueño y el contador

**Con el dueño:**

1. Frecuencia de liquidación (¿quincenal?) y si se liquida hasta ayer o hasta hoy.
2. Que una venta anulada **después** de pagada la comisión se le descuente al barbero en la siguiente liquidación (por defecto sí).
3. Que las ventas con anulación pendiente esperen a la siguiente liquidación.
4. Que las propinas se paguen por defecto en la liquidación (también se pueden seguir pagando a diario en Caja).
5. Si recepción puede entregar anticipos de la caja (por defecto no) y si hay un tope de anticipo.
6. Si el comprobante necesita algo más (logo, NIT, cédula del barbero impresa en lugar de escrita a mano).
7. Los 4 indicadores del tablero.
8. Si se acepta que con la caja abierta recepción siga viendo las ventas del día y las propinas por pagar (pendiente del sprint 4, MEDIUM-3).

**Con el contador:**

9. Si los barberos son empleados o contratistas (prestación de servicios): define si hace falta nómina electrónica, documento soporte, retención en la fuente o seguridad social. El sistema no lo calcula; el comprobante es interno.
10. Código de la cuenta de anticipos: 1365 (cuentas por cobrar a trabajadores) o 1330 (anticipos y avances).
11. Si los descuentos a un barbero (ajustes en contra) van contra 5105 o a una cuenta de ingreso (4250 Recuperaciones).
12. Si la comisión se reconoce como gasto al cobrar (como hoy: 5105 contra 2335) o al liquidar.
13. Formato del CSV: separador `;`, dos decimales con coma y libro diario con esas columnas; o si prefiere otro formato (por ejemplo, el de importación de Alegra o Siigo).
14. Si la anulación se registra el día de la venta (como hoy; los informes de meses pasados pueden cambiar) o el día actual.
15. Lo que sigue pendiente del sprint 4: IVA, costo del datáfono por medio, cuenta 4175 para descuentos, base de la comisión (neto o bruto) y mapeo de las categorías de gasto.
