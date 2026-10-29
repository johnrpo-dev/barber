# Sprint 4: cobro y caja

Decisiones de diseño del sprint 4. Se apoya en el modelo contable del sprint 1 ([arquitectura.md](arquitectura.md), "Modelo contable" y ADR-001) y en los flujos del descubrimiento (§5, §6 y §8). Lo que falta confirmar con el dueño o el contador está marcado **[confirmar]** y queda **configurable**, con un valor por defecto prudente.

## 0. Alcance

**Entra:**

- Cobro de una cita terminada o de un walk-in:
  - panel ya rellenado;
  - descuento (con permiso);
  - propina por barbero;
  - pago mixto (efectivo con cálculo de cambio, tarjeta, transferencia, billetera).
- Comisión del barbero calculada y **congelada** al cobrar.
- Caja:
  - apertura con base contada;
  - movimientos del turno (gastos de caja, pago de propinas, consignación al banco);
  - cierre con conteo y diferencia registrada.
- Gastos con categorías, pagados desde caja o desde banco.
- Anulaciones: recepción solicita y el dueño aprueba; queda un asiento de reversa.
- Cierre y reapertura del día contable.

**No entra:**

- Liquidación de comisiones y reportes del dueño: sprint 5.
- Productos e inventario: fase 2.
- IVA: queda pendiente **[confirmar si Villa es responsable de IVA]**. El modelo deja espacio para una línea de IVA, pero el sprint 4 no la genera.
- Factura electrónica DIAN.

**Requisito previo:** el endurecimiento del sprint 4 debe estar terminado:

- MFA del dueño;
- reautenticación (`requireRecentAuth`);
- bloqueo por intentos;
- idempotencia ligada al contenido;
- separación de roles de Postgres.

Ninguna acción de este documento se publica sin eso.

## 1. Reglas de negocio (con su valor por defecto)

| Regla | Valor por defecto | Configurable en Ajustes |
|---|---|---|
| Base de la comisión | Precio **neto** de la línea de servicio (después del descuento), como dice el descubrimiento §6 | Sí: neto o bruto **[confirmar]** |
| Redondeo de la comisión | Half-up **al peso**, por línea, una sola vez; se congela | No |
| Costo del datáfono | 0 puntos básicos por método hasta que el dueño lo ponga **[confirmar]**. Lo absorbe el negocio: es gasto 5305 y no reduce la comisión | Sí, por método |
| Propinas | 100 % del barbero. Pasivo 2380, no es ingreso y no genera comisión | Sí: que las propinas asuman su parte del datáfono (por defecto **no**) **[confirmar]**. Los pagos no se asignan a líneas, porque el dinero es fungible. Si la regla está activa, el costo total del datáfono se reparte entre venta y propinas en proporción a lo cobrado (`allocate`). Nunca se come una propina entera: si eso pasara, el cobro se rechaza |
| Montos | Precios, descuentos, propinas y efectivo en **pesos enteros**. Los pagos electrónicos pueden llevar centavos. Tope de $100.000 millones por monto, 20 líneas, 5 pagos y 10 propinas por venta | No |
| Costo de un medio de pago | Entre 0 % y 99,99 %, y siempre menor que el pago | Sí, por método |
| Descuentos | Solo con permiso `sales.discount` (dueño, y recepción si el dueño lo habilita). El tope por defecto es 30 % de la línea y se pide motivo | Sí: tope y si recepción puede |
| Métodos de pago | Efectivo, tarjeta (datáfono), transferencia, Nequi/Daviplata **[confirmar cuáles usan]** | Sí: activar o desactivar |
| Efectivo | Se registra lo que entra a la caja (pagado − cambio). El cambio se calcula en pantalla y el servidor lo vuelve a calcular | No |
| Anulación | La aprueba el dueño con reautenticación y motivo obligatorio. Quien cobró no aprueba su propio cobro, salvo que sea el dueño. Con un solo dueño, el registro queda con autor, motivo y hora | No |
| Día cerrado | No acepta movimientos. Reabrirlo es del dueño, con reautenticación y motivo, y queda como evento | No |

## 2. Modelo de datos

Todas las tablas llevan `location_id`, ids `bigint` internos y `public_id` (ULID) cuando salen al cliente. El dinero es `bigint` en centavos con `CHECK (>= 0)`. Todas las FK son compuestas con `location_id`, como en el libro.

- **`payment_methods`**: método de la sede.
  - Campos: `kind` (`cash` | `card` | `transfer` | `wallet`), `label`, `active`, `fee_bps`.
  - El efectivo existe siempre y no se puede desactivar.
- **`sales`**: venta. Es solo-inserción salvo el paso a anulada.
  - Campos:
    - `appointment_id` (nullable para un walk-in sin cita) y `client_id` (nullable);
    - `business_date`;
    - `status` (`paid` | `voided`);
    - `journal_entry_id` (el asiento de la venta, `NOT NULL`);
    - `void_entry_id` (el asiento de reversa, nullable);
    - totales congelados: `subtotal`, `discount`, `tips`, `total_paid`;
    - `created_by`, `idempotency_key` y `payload_hash`.
  - **Una venta pagada por cita:** índice único parcial `(appointment_id) WHERE status = 'paid'`.
  - **Trigger:**
    - una venta `paid` solo puede pasar a `voided`, una sola vez y con `void_entry_id`;
    - todo lo demás es inmutable;
    - no se permite DELETE ni TRUNCATE.
- **`sale_lines`**: líneas de la venta, solo-inserción.
  - Campos: `kind` (`service` por ahora), `service_id`, `staff_id`, `description` congelada, `unit_price`, `discount`, `discount_reason`, `net`, `commission_bps` congelado, `commission`.
- **`sale_payments`**: pagos, solo-inserción.
  - Campos: `method_id`, `amount` (lo que se aplica a la venta), `tendered` y `change` (solo efectivo), `fee` congelado.
- **`sale_tips`**: propinas, solo-inserción. Campos: `staff_id`, `amount`, `fee_share` y `payable` (congelados).
  - Se cumple `payable = amount − fee_share`.
  - La suma de `payable` es exactamente el crédito a 2380 del asiento, así que el saldo por barbero cuadra en SQL contra 2380.
- **`cash_sessions`**: turnos de caja.
  - Campos: `opened_by`, `opened_at`, `opening_counted`, `closed_by`, `closed_at`, `closing_counted`, `expected_cash` congelado al cerrar, `difference`, `note`.
  - Una caja abierta por sede: índice único parcial `WHERE closed_at IS NULL`.
  - **Trigger:** solo se permite pasar de abierta a cerrada, una vez; lo demás es inmutable.
- **`expense_categories`**: categorías de gasto.
  - Campos: `name`, `account_code` (por defecto 5195 **[el contador define el mapeo]**), `active`.
  - `account_code` solo puede ser una cuenta de gasto sin flujo propio, como dice `isExpenseCategoryAccount()`:
    - nunca 5105 (comisiones), 5305 (datáfono) ni 5310 (diferencias de caja);
    - nunca una cuenta de activo, pasivo o ingreso.

    Se valida en el dominio y con un CHECK en la base.
  - Las categorías iniciales son sugerencias que el dueño edita: arriendo, servicios públicos, insumos, aseo, mantenimiento, publicidad y otros.
- **`expenses`**: gastos, solo-inserción.
  - Campos:
    - `category_id`, `amount`, `paid_from` (`cash` | `bank`), `cash_session_id` (obligatorio si sale de caja);
    - `description`, `journal_entry_id`, `created_by`;
    - `idempotency_key`.
- **`void_requests`**: solicitudes de anulación.
  - Campos: `sale_id`, `requested_by`, `reason`, `status` (`pending` | `approved` | `rejected`), `decided_by`, `decided_at`, `decision_note`.
  - Una solicitud pendiente por venta: índice único parcial.

`ENTRY_KINDS` gana `cash_deposit` (consignación de caja a banco) y `cash_opening_adjustment`. Este último no es un tipo nuevo: es un `cash_adjustment` con el memo correspondiente.

## 3. Asientos

Todos son un solo asiento por operación, en la misma transacción que las filas operativas, con la clave de idempotencia de la operación.

**Venta.** Ejemplo:

- corte de $30.000 con descuento de $3.000, así que el neto es $27.000;
- comisión del 40 %: $10.800;
- propina de $5.000;
- pago: $20.000 en efectivo y $12.000 con tarjeta (comisión del datáfono del 2,99 %: $358,80).

| Cuenta | Débito | Crédito |
|---|---|---|
| 1105 Caja | 20.000 | |
| 1110 Bancos | 11.641,20 | |
| 5305 Datáfono | 358,80 | |
| 4170 Ingresos por servicios | | 27.000 |
| 2380 Propinas por pagar | | 5.000 |
| 5105 Comisiones de barberos | 10.800 | |
| 2335 Comisiones por pagar | | 10.800 |

Reglas del asiento de venta:

- **Ingreso.** Va neto del descuento. El descuento queda en `sale_lines` para los reportes; no se usa una cuenta de descuentos **[confirmar con el contador si prefiere la cuenta 4175 de devoluciones y descuentos]**.
- **Datáfono.** El costo se calcula sobre el monto del pago con tarjeta: half-up al centavo, una sola vez, congelado en `sale_payments.fee`.
- **Comisión.** Se causa al cobrar: gasto contra pasivo. La liquidación del sprint 5 paga el pasivo.
- **Cuadre.** La suma de pagos debe ser igual a la suma de netos más las propinas. El total pagado nunca puede quedar por debajo de lo cobrado: no hay cuentas por cobrar.

**Resto de operaciones:**

| Operación | Débito | Crédito |
|---|---|---|
| Gasto de caja | Cuenta de la categoría | 1105 |
| Gasto de banco | Cuenta de la categoría | 1110 |
| Pago de propinas en efectivo al barbero (`tip_payout`) | 2380 | 1105 |
| Consignación (`cash_deposit`) | 1110 | 1105 |
| Faltante al cerrar la caja (`cash_adjustment`) | 5310 | 1105 |
| Sobrante al cerrar la caja (`cash_adjustment`) | 1105 | 5310 |

- **Apertura de caja.** El efectivo esperado es el saldo de 1105 en el libro. Si la base contada difiere, se registra un `cash_adjustment` con nota obligatoria.
- **Anulación.** Es `reverseEntry` del asiento de la venta, el mismo día contable si el día está abierto.
  - Si el día ya se cerró, el dueño reabre el día. **[Alternativa a confirmar:** registrar la reversa en el día actual.]
  - La reversa también deshace la comisión causada y la propina por pagar.
  - Si la propina ya se pagó en efectivo, la anulación no la "devuelve": el pago de propinas es otro asiento, y el sistema avisa al dueño.

## 4. Caja: qué se espera al cerrar

El esperado sale **siempre de SQL**: el saldo de 1105 desde la apertura del turno. Se muestra desglosado:

```
base contada al abrir
+ ventas en efectivo (neto de cambio)
− gastos de caja
− propinas pagadas en efectivo
− consignaciones
± ajustes
= efectivo esperado
```

Para los otros métodos se muestra el total del turno por método, para cuadrar contra el datáfono y los extractos. Esos montos no se cuentan.

Al cerrar:

1. Se cuenta el efectivo.
2. Diferencia = contado − esperado. Si no es cero, la nota es obligatoria y se registra el asiento de ajuste.
3. El turno queda cerrado.

El cierre del **día contable** (`closeDay`) solo se permite sin caja abierta.

## 5. Concurrencia e idempotencia

- **Transacción.** Cobro, gasto, movimientos de caja, apertura, cierre y anulación corren en **una transacción `SERIALIZABLE`** con reintento acotado (3 veces) ante el error `40001`.
- **Clave de idempotencia.**
  - La clave viene del cliente (`formId`) y se liga al hash del contenido (endurecimiento).
  - Misma clave y mismo contenido devuelve el resultado original.
  - Misma clave con otro contenido es un conflicto.
- **Cobro de una cita:**
  - toma `FOR UPDATE` sobre la cita;
  - exige el estado `completed`, o permite `in_chair` y la deja en `completed` en la misma transacción;
  - el índice único impide dos ventas pagadas para la misma cita.
- **Caja.** Toda operación de efectivo exige una caja abierta y toma su fila con `FOR UPDATE`, así que un cierre y un cobro en efectivo no se cruzan.
- **Sin caja abierta.** Se puede cobrar con tarjeta, transferencia o billetera. El efectivo exige caja abierta.

## 6. Permisos

| Acción | Dueño | Recepción | Barbero |
|---|---|---|---|
| Cobrar (`ledger.post`) | Sí | Sí | No |
| Descuento (`sales.discount`) | Sí | Si el dueño lo habilita | No |
| Abrir y cerrar caja, pago de propinas, consignación (`cash.manage`) | Sí | Sí | No |
| Gasto de caja (`ledger.post`) | Sí | Sí | No |
| Gasto de banco (`expenses.bank`) | Sí | No | No |
| Solicitar anulación | Sí | Sí | No |
| Aprobar anulación (`ledger.reverse` y reautenticación) | Sí | No | No |
| Cerrar día (`day.close`) | Sí | Sí | No |
| Reabrir día (`day.reopen` y reautenticación) | Sí | No | No |
| Categorías de gasto y métodos de pago (`settings.manage`) | Sí | No | No |

Cada acción nueva entra en `authorization.test.ts`, con sus casos de aislamiento entre sedes.

## 7. Pantallas (mobile-first, 360 px)

- **Panel de cobro.** Es una hoja que se abre desde la cita en Agenda o en Mi día, o desde "Cobrar walk-in".
  - Muestra las líneas ya rellenadas, con descuento opcional, y la propina por barbero con chips de 0 %, 10 %, 15 % y otro valor.
  - Métodos de pago:
    - uno o varios;
    - "pagar el resto con…";
    - para efectivo: billetes rápidos ($50.000, $100.000) y cálculo del cambio.
  - El botón grande dice "Cobrar $X".
  - Al confirmar muestra un recibo en pantalla con el total, el cambio y la opción de compartirlo.
  - El caso típico se cobra en 3 toques.
- **Caja.** Muestra el estado del turno:
  - abierta desde qué hora y por quién;
  - el efectivo esperado ahora;
  - los movimientos del turno.

  Acciones: registrar gasto, pagar propinas, consignar y cerrar caja. El cierre se hace con un conteo por denominación opcional o con el total directo.
- **Gastos.** Lista del día y formulario.
- **Anulaciones.** Recepción ve sus solicitudes. El dueño ve la cola con la venta completa, quién cobró y el motivo, y aprueba o rechaza.
- **Ajustes.** Se suman las secciones de métodos de pago (con su costo de datáfono), categorías de gasto y reglas de cobro (base de comisión, tope de descuento, si recepción da descuentos, si la propina con tarjeta paga datáfono).

## 8. Pruebas obligatorias

**De propiedades (fast-check):**

- todo asiento de venta cuadra, para cualquier combinación de líneas, descuentos, propinas, pagos y costos de datáfono;
- la suma de pagos es igual a la suma de netos más las propinas;
- la comisión congelada por línea es igual a `percentOf(neto, bps, PESO)`, y la suma por barbero no se vuelve a redondear;
- anular y luego calcular el balance de prueba deja todas las cuentas como estaban;
- el esperado de caja calculado en SQL es igual a la suma de los movimientos generados;
- el cambio es igual a lo entregado menos el efectivo aplicado, y nunca es negativo.

**De integración (PGlite):**

- doble toque con la misma clave da una sola venta;
- misma clave con otro contenido da un conflicto;
- dos cobros simultáneos de la misma cita dan una sola venta;
- cobro en efectivo contra cierre de caja simultáneo: uno espera al otro y el esperado es exacto;
- en un día cerrado no se puede cobrar;
- una venta pagada no se puede modificar (trigger);
- los triggers de solo-inserción funcionan en todas las tablas nuevas.

**De autorización:** la matriz completa y el aislamiento entre sedes.
