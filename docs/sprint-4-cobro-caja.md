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

## 9. Contrato backend ↔ interfaz (obligatorio)

Ambas partes se construyen en paralelo contra este contrato. Si una necesita cambiarlo, lo dice en su informe; no lo cambia en silencio.

**Convenciones:**

- Todas las acciones devuelven `ActionResult<T>` (`src/lib/action.ts`).
  - Si falta reautenticación, devuelven `{ ok: false, code: "reauth_required" }`, y la interfaz usa `useReauth().run(...)` (`src/app/panel/_components/reauth.tsx`).
  - Los ids internos viajan como texto (`idSchema`).
- **Dinero que entra:** pesos enteros en texto, con el sufijo `Units` (`"30000"`), como en Servicios. **Dinero que sale:** texto de centavos con el sufijo `Minor` (`"3000000"`), más una etiqueta ya formateada con el sufijo `Label` (`"$ 30.000"`).
  - La interfaz **nunca** calcula montos que se guarden. El total, el cambio y el resto por pagar que muestra son solo vista previa. Puede calcularlos con `priceCheckout` del dominio, importado en el cliente, porque es puro.
  - Lo que vale es lo que devuelve el servidor.
- Toda acción que escribe recibe `idempotencyKey` (el `formId` del formulario). La interfaz la conserva entre reintentos de red y la renueva después de cualquier respuesta del servidor.
- **El servidor toma de la base, nunca del navegador:**
  - el precio y la comisión de cada servicio;
  - el tipo y el costo de cada medio de pago;
  - las reglas de cobro;
  - el día contable.

**`src/app/panel/cobro/actions.ts`:**

- **`loadCheckout({ appointmentId })`** devuelve `ActionResult<CheckoutView>`.

  ```ts
  type CheckoutView = {
    appointmentId: string; clientName: string | null; status: string;
    lines: { key: string; serviceId: string; serviceName: string; staffId: string; staffName: string; unitPriceMinor: string; unitPriceLabel: string; commissionBps: string }[];
    extraServices: { serviceId: string; name: string; unitPriceMinor: string; unitPriceLabel: string }[];
    staff: { id: string; name: string }[];                 // para propinas y extras
    methods: { id: string; kind: "cash" | "card" | "transfer" | "wallet"; label: string; feeBps: string }[];
    rules: { maxDiscountBps: string; canDiscount: boolean; tipsBearCardFees: boolean; commissionBase: "net" | "gross" };
    cashSessionOpen: boolean; dayClosed: boolean; businessDate: string;
    paid: { saleId: string; totalLabel: string; paidAt: string } | null;
  };
  ```

  `commissionBps` sirve solo para la vista previa: el servidor la vuelve a leer.

- **`checkoutAction({ appointmentId, extras, discounts, tips, payments, idempotencyKey })`** devuelve `ActionResult<Receipt>`. Los campos de entrada:
  - `extras: { serviceId: string; staffId: string }[]`;
  - `discounts: { key: string; amountUnits: string; reason: string }[]`, donde `key` es el de `lines` o `extra:<i>`;
  - `tips: { staffId: string; amountUnits: string }[]`;
  - `payments: { methodId: string; amountUnits: string; tenderedUnits?: string }[]`.

  ```ts
  type Receipt = { saleId: string; totalLabel: string; changeLabel: string | null; lines: { description: string; netLabel: string }[]; tips: { staffName: string; amountLabel: string }[]; payments: { label: string; amountLabel: string }[]; businessDate: string };
  ```

  - La cita queda `completed` si estaba `in_chair`.
  - Los mensajes de error conocidos (prefijos):
    - "Esta cita ya está cobrada";
    - "Abre la caja para recibir efectivo";
    - "El día ya está cerrado";
    - "Falta dinero por cobrar";
    - "Los pagos superan el total";
    - "El efectivo entregado no alcanza";
    - "El descuento supera el tope";
    - "Escribe el motivo del descuento".
- **`requestVoidAction({ saleId, reason, idempotencyKey })`**: permiso `ledger.post`.

**`src/app/panel/caja/actions.ts`:**

- **`loadCashView()`** devuelve `ActionResult<CashView>`.

  ```ts
  type CashView = {
    businessDate: string; dayClosed: boolean;
    session: null | {
      id: string; openedAtLabel: string; openedBy: string;
      expectedMinor: string; expectedLabel: string;
      breakdown: { label: string; amountLabel: string; sign: "+" | "-" | "±" }[];
      byMethod: { label: string; totalLabel: string }[];
      movements: { at: string; kind: "sale" | "expense" | "tip_payout" | "cash_deposit" | "cash_adjustment" | "reversal"; description: string; amountLabel: string; sign: "+" | "-" }[];
    };
    expectedOpeningMinor: string; expectedOpeningLabel: string; // saldo actual de 1105, para la vista previa al abrir
    lastClosed: null | { closedAtLabel: string; countedLabel: string; differenceLabel: string; note: string | null };
    tipsOwed: { staffId: string; name: string; owedMinor: string; owedLabel: string }[];
    categories: { id: string; name: string }[];
    canBankExpense: boolean; canCloseDay: boolean; canReopenDay: boolean;
    daySales: { saleId: string; atLabel: string; clientName: string | null; totalLabel: string; status: "paid" | "voided"; voidRequested: boolean; chargedBy: string }[];
  };
  ```

- Acciones de caja, todas con `idempotencyKey`:
  - `openCashSessionAction({ countedUnits, note?, idempotencyKey })`;
  - `closeCashSessionAction({ countedUnits, note?, idempotencyKey })`;
  - `addExpenseAction({ categoryId, amountUnits, paidFrom: "cash" | "bank", description, idempotencyKey })`;
  - `payTipsAction({ staffId, amountUnits, idempotencyKey })`;
  - `cashDepositAction({ amountUnits, idempotencyKey })`.
- Acciones del día:
  - `closeDayAction({ businessDate })`;
  - `reopenDayAction({ businessDate, reason })`, que pide reautenticación.

**`src/app/panel/anulaciones/actions.ts`:**

- **`loadVoidQueue()`** devuelve `ActionResult<{ requests: { id: string; saleId: string; atLabel: string; requestedBy: string; chargedBy: string; reason: string; totalLabel: string; lines: string[]; status: "pending" | "approved" | "rejected" }[] }>`.
- **`decideVoidAction({ requestId, approve: boolean, note, idempotencyKey })`**: permiso `ledger.reverse` y reautenticación.

**`src/app/panel/ajustes/actions.ts`** (se agregan; permiso `settings.manage`):

- `savePaymentMethodAction({ id?, kind, label, feeBps, active })`. El efectivo no se desactiva y su costo es 0.
- `saveExpenseCategoryAction({ id?, name, accountCode, active })`. `accountCode` debe pasar `isExpenseCategoryAccount`.
- `updateCheckoutRulesAction({ commissionBase, maxDiscountBps, receptionCanDiscount, tipsBearCardFees })`.
- `loadCheckoutSettings()` devuelve `ActionResult<{ methods: { id; kind; label; feeBps; active }[]; categories: { id; name; accountCode; active }[]; rules: { commissionBase; maxDiscountBps; receptionCanDiscount; tipsBearCardFees } }>`. Los puntos básicos viajan como texto de dígitos (`"299"`).
- La página de Ajustes recibe además `methods`, `categories`, `checkoutRules` y la lista de cuentas de gasto permitidas.

**Pantallas** (las hace la interfaz):

- La hoja de cobro, que se abre desde la cita en `/panel/agenda` y en `/panel/mi-dia` (solo para quien tiene `ledger.post`).
- `/panel/caja`.
- `/panel/anulaciones`.
- Las secciones nuevas de `/panel/ajustes`.
- Los ítems de navegación: "Caja" (`ledger.post`) y "Anulaciones" (`ledger.post`; el dueño ve la cola y recepción ve las suyas).

### 9.1 Lo que se precisó al construir

- **Claves de las líneas del cobro:** la línea de la cita es `"appointment"` y los extras son `"extra:<i>"` (`i` de 0 a 19, sin ceros a la izquierda). Una clave de descuento que no es de una línea de la venta se rechaza; en un walk-in no existe `"appointment"`.
- **Resultados de las acciones de escritura:**
  - `requestVoidAction` devuelve `{ requestId }`.
  - `decideVoidAction` devuelve `{ status, warning }`. El aviso aparece si la propina ya se pagó en efectivo.
  - `openCashSessionAction` devuelve `{ sessionId, differenceLabel }`.
  - `closeCashSessionAction` devuelve `{ expectedLabel, countedLabel, differenceLabel, needsReview }`.
  - `markCashSessionReviewedAction` (solo el dueño) no devuelve datos.
  - `addExpenseAction` devuelve `{ expenseId }`.
  - `payTipsAction` y `cashDepositAction` devuelven `{ movementId }`.
  - Los guardados de Ajustes devuelven `{ id }`.
  - `closeDayAction`, `reopenDayAction` y `updateCheckoutRulesAction` no devuelven datos.
- **Movimientos de caja:** se guardan en `cash_movements`, junto a su asiento. `CashView.movements` no muestra los ajustes por conteo; esos se ven en `lastClosed` y en la diferencia al abrir.
- **Límites de efectivo:**
  - un gasto, una consignación o un pago de propinas no puede superar el efectivo de la caja ("No hay tanto efectivo en la caja");
  - el pago de propinas tampoco puede superar lo que se le debe al barbero;
  - una venta con efectivo solo se anula con la caja ABIERTA y con ese efectivo en el turno ("Abre la caja para devolver el efectivo de esta venta" / "En la caja no hay $ … para devolver esta venta en efectivo"). Ver §9.2.
- **Anulaciones con la caja cerrada:** las de tarjeta, transferencia o billetera sí; las que tuvieron efectivo, no (§9.2, C1).

### 9.2 Revisión del sprint 4 (lo que cambió)

Las revisiones de cierre del sprint encontraron fallas en la caja y en la base. Todo el esquema nuevo va en la migración `0011_cash_integrity.sql` (0010 no se tocó).

**Anular una venta en efectivo exige la caja abierta (C1).**

- Antes, con la caja cerrada, la anulación se aprobaba "con aviso": la devolución bajaba 1105 por debajo de cero y la apertura siguiente inventaba un sobrante en 5310.
- Ahora la devolución es un movimiento del turno: `decideVoid` bloquea el turno abierto (`requireOpenSession`), exige que el libro tenga ese efectivo y registra el movimiento `reversal`. Ya no hay aviso de caja cerrada.
- La base lo respalda: un constraint trigger diferido (`journal_lines_cash_nonnegative`) no deja confirmar ninguna transacción que deje 1105 negativo.
- En Anulaciones, el error lleva un botón "Ir a la caja".

**Conteo a ciegas (MEDIUM-3).**

- Con la caja abierta, solo quien tiene `cash.review` (el dueño) recibe del servidor el esperado, su desglose y los montos de los movimientos. Recepción ve "Conteo a ciegas", cuenta, y solo al cerrar ve el esperado y la diferencia.
- Para quien cuenta a ciegas, la nota del cierre es **siempre** obligatoria ("Escribe una nota del conteo…"): si solo se pidiera con diferencia, el error diría si el conteo cuadra y se podría tantear el esperado.
- La base marca `needs_review` al cerrar si |diferencia| > `locations.cash_review_threshold` (por defecto $20.000; el dueño lo cambia en Ajustes → Reglas de cobro), y `opening_needs_review` al abrir si |contado − libro| supera el mismo umbral. La app no puede fingir ni quitar ninguna de las dos.
- El dueño ve "Turnos por revisar" en Caja (apertura, cierre o ambos). Un turno abierto con la apertura marcada aparece, pero se da por revisado después de cerrarlo; una sola revisión (`markCashSessionReviewedAction`) cubre apertura y cierre. La hora la pone la base.
- 0011 rellena las dos marcas en los turnos viejos con diferencia mayor que $20.000.
- Con la caja abierta, el saldo de apertura (`expectedOpeningMinor`/`Label`) tampoco llega a quien cuenta a ciegas: es el mismo esperado.
- "No hay tanto efectivo en la caja" (gasto, consignación) solo lo recibe quien tiene `cash.review`; los demás reciben un mensaje genérico. El rechazo en sí sigue diciendo que el monto no alcanza: no se puede evitar sin dejar sacar de más.
- **Lo que todavía deja ver algo del esperado:** las ventas del día (totales, sin medio) y las propinas por pagar. Sumarlas a mano da una idea aproximada del efectivo; no exacta, porque no dicen qué parte fue en efectivo. Se acepta.

**Integridad en la base (M2, L2, L7).**

- 1105 ≥ 0 también en READ COMMITTED: el trigger toma un candado de transacción por sede antes de sumar, así dos salidas simultáneas no pasan las dos.
- 0011 borra los registros `trust-device-*` que quedaron en `verification` (el código se pide en cada ingreso).
- Constraint triggers diferidos (al hacer COMMIT):
  - todo asiento `sale`, `expense`, `tip_payout`, `cash_deposit` o `reversal` tiene su registro operativo (venta, gasto o movimiento); la reversa de una venta es su `void_entry_id`;
  - un gasto coincide con su asiento (monto, cuenta de la categoría, caja o banco) y, si es de caja, es un movimiento de su turno;
  - un movimiento de caja coincide con su asiento y mueve efectivo en su sentido;
  - al abrir y al cerrar un turno, 1105 es exactamente lo contado;
  - una venta solo pasa a anulada con una solicitud aprobada.
- Las horas `closed_at`, `voided_at`, `decided_at` y `reviewed_at` las pone la base (`now()`); CHECK `closed_at >= opened_at`.
- CHECK `commission <= unit_price` en las líneas.

**search_path fijo (HIGH-1).** Todas las funciones de `public` llevan `SET search_path = pg_catalog, public, pg_temp`: nadie puede reemplazar `ledger_assert_entry()` y compañía con una función del mismo nombre en otro esquema. El esquema de la cola (`pgboss`) pasa a un rol propio, `villa_queue` (ver Arquitectura, Seguridad).

**Concurrencia y lecturas (M1, M3, L3, L4).**

- `closeBusinessDay` y `reopenBusinessDay` leen los asientos del día: bajo SERIALIZABLE, un cobro de ese día que se cruce con el cierre hace abortar a uno de los dos (SSI) y el reintento ve el día cerrado.
- `serializable()` reintenta 40001, 40P01 y las claves de idempotencia duplicadas con una espera corta al azar (5–25 ms × intento).
- Las carreras que llegan a una restricción única se traducen al mensaje de siempre: "La caja ya está abierta", "Ya hay una solicitud de anulación pendiente…", "Esta cita ya está cobrada", "Esta venta ya está anulada".
- La pantalla de Caja se lee en una sola transacción REPEATABLE READ de solo lectura.
- Abrir un turno en un día cerrado se rechaza siempre (antes solo si había diferencia).

**Cobro sin cita (walk-in).**

- Botón "Cobrar sin cita" en Caja y "Cobrar" en Agenda. En la hoja se eligen los servicios y quién los hizo; el cliente es opcional (buscarlo o crearlo con nombre y celular).
- Mismo cálculo (`priceCheckout`), mismo asiento, misma clave de idempotencia y la misma verificación de totales en la base. `checkoutAction` acepta `appointmentId: null`, `client` (`existing`, `new` o `none`) y hasta 20 servicios.
- Un cliente nuevo se crea (o se encuentra por celular) dentro de la transacción del cobro: si el cobro falla, no queda creado.
- Acción nueva: `loadWalkInCheckout`.

**Sigue sin poder registrarse:** un cobro con descuento del 100 % y sin propina (total cero). No hay pago que registrar y la base exige al menos uno. Queda para después, si el dueño lo pide.

**Queda por confirmar con el dueño y el contador:**

- el costo del datáfono por medio de pago (hoy es 0);
- el IVA;
- si se usa la cuenta 4175 para descuentos o el ingreso va neto;
- si la comisión se calcula sobre el precio neto o el bruto;
- el mapeo de las categorías de gasto (hoy todas van a 5195);
- si la anulación se registra el día de la venta (como ahora) o el día actual;
- qué medios de pago usan de verdad.
