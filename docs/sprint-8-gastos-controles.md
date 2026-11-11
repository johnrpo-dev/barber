# Sprint 8: gastos y controles

Diseño del 2026-11-06. Sale de la fila del sprint 8 en [00-descubrimiento.md](00-descubrimiento.md) §12.1 y de la fila B4 de la tabla de seguridad de [arquitectura.md](arquitectura.md).

## 1. Alcance

| Parte | Estado | Por qué |
|---|---|---|
| **D.** Celular enmascarado antes de enviar el recibo | Entra | Cierra B4: hoy el recibo puede llegarle a un tercero si quien cobra se equivocó de número |
| **C.** Avisos al dueño por correo (anulación pedida, caja descuadrada, día reabierto, cortesía) | Entra | Hoy solo los ve si abre Inicio |
| **E.** Cortesía (lo que el roadmap llamaba "descuento del 100 % sin propina") | Entra | Ver §4 |
| **B.** Gastos fijos con recordatorio | Entra | Arriendo, servicios y otros que se olvidan |
| **A.** Cuentas por pagar a proveedores | **Aplazada** | Depende de si algún proveedor le fía a la barbería (pregunta 1). Sin inventario (sprint 6, aún sin decisiones) es lo que menos le da al dueño y lo que más toca el libro |
| **F.** QR del 2FA | **Descartada** | El dueño se inscribe desde el celular, que es el mismo aparato de la app de autenticación, y el enlace `otpauth://` ya la abre. Si algún día hace falta, nunca con una API externa de QR (le mandaría el secreto a un tercero) |

**No entra:** compras de mercancía (1435), IVA descontable, gastos que se asienten solos y avisos por WhatsApp.

## 2. D. Celular enmascarado en el recibo

Sin migración ni acción nueva.

- `loadCheckout` devuelve el destino del recibo (canal y dato enmascarado). Se calcula con la misma elección de canal que `enqueueSaleReceipt`, así lo que se muestra es lo que se envía.
- Debajo del interruptor "Enviar recibo" aparece: "Se enviará por WhatsApp al 300 ••• ••67. Confírmalo con el cliente."
- Si el cliente es nuevo y su número se tecleó en el walk-in, se muestra el número completo formateado, para leérselo.
- `maskEmail` nuevo en `src/domain/clients/client.ts`. Propiedad: nunca muestra más que el primer carácter del usuario y el dominio.

**Hecho.**

- `preferredChannel` pasó a `src/domain/notifications/channel.ts` (puro; `src/db/notifications.ts` lo reexporta) y `receiptDestination` arma desde ahí el canal y el dato a mostrar. El envío y la hoja usan la misma regla; una prueba de propiedades lo comprueba.
- `loadCheckout` trae el destino del cliente de la cita (`appointmentReceiptDestination`). En el walk-in, el cliente existente lo trae de la búsqueda (`findClients` → `receiptTo`, con `receiptDestinationsOf`). Para el cliente nuevo, la hoja lo calcula con el celular tecleado y los canales activos (`receiptChannels()`), y lo muestra completo.
- Sin canal: "Sin celular ni correo: no se puede enviar el recibo." y no hay interruptor. Si la configuración de mensajes no está lista, no hay canales: no se ofrece el envío (tampoco se encolaría).
- `maskEmail` en `src/domain/clients/client.ts`; pruebas de propiedades de `maskEmail` y `maskPhone`. Sin migración ni acción nueva.

## 3. C. Avisos al dueño (hecho)

- **Tabla `owner_alerts`:** `location_id`, `kind`, `ref_id`, `created_at`, `notified_at` y `UNIQUE (location_id, kind, ref_id)`.
- **Barrido idempotente del worker cada minuto:** `INSERT … SELECT … ON CONFLICT DO NOTHING` sobre lo que ya existe (`void_requests`, `cash_sessions` por encima del umbral, `day_close_events` de reapertura y cortesías) de los últimos 2 días.
- **Entrega:** un correo agrupado cada 15 minutos a `ALERT_EMAIL`, con el patrón de `deliverSecurityAlerts`.
- **No toca el camino del dinero:** ni `cash.ts`, ni `voids.ts`, ni triggers nuevos.
- **El correo no lleva** el motivo libre ni nombres de clientes; solo quién (`display_name` del personal), el monto y el enlace al panel.
- **No se avisa la anulación aprobada:** la aprueba el mismo dueño.
- **Sin correo configurado,** el aviso queda en el registro del servidor y en Inicio, como hoy.
- **Propiedad:** repetir el barrido no duplica avisos y cada aviso sale en un solo correo.

**Hecho** (migración 0027):
- **Tabla `owner_alerts`:** `location_id`, `kind` (`void_requested`, `cash_review`, `day_reopened`, `courtesy`, con CHECK), `ref_id` (id de la fila de origen), `created_at` y `notified_at`. `UNIQUE (location_id, kind, ref_id)`. `villa_app` tiene SELECT, INSERT y `UPDATE (notified_at)`; un trigger exige que `notified_at` pase de null a una fecha una sola vez y que nada más cambie. Sin DELETE.
- **Barrido** (`sweepOwnerAlerts` en `src/db/owner-alerts.ts`, trabajo `owner.alerts` cada minuto): un solo `INSERT … SELECT … ON CONFLICT DO NOTHING` sobre los últimos 2 días.
  - `void_requested`: solicitud aún pendiente. La aprobada o rechazada no se avisa.
  - `cash_review`: turno cerrado con `needs_review` u `opening_needs_review` (los marca la base con el umbral de la sede, como "por revisar") y sin revisar. Se avisa siempre, aunque cierre el dueño: el descuadre importa igual.
  - `day_reopened`: reapertura, manual o al abrir la caja.
  - `courtesy`: cortesía.
  - **Lo que hace el dueño no se avisa:** la solicitud de anulación, la reapertura y la cortesía de una cuenta con rol `owner` en esa sede (`staff_members.role`, por `user_id`) no generan aviso. El dueño no necesita un correo de lo que hizo él mismo.
- **Entrega** (`deliverOwnerAlerts`): por sede, un correo como mucho cada 15 minutos (bandera en `rate_limit_counters`, como `deliverSecurityAlerts`), agrupado por tipo con el enlace de cada grupo (`PUBLIC_BASE_URL` + `/panel/anulaciones`, `/panel/caja` o `/panel/informes`). Cada línea: hora local de la sede, quién (`display_name`), el monto con `format` y, en la caja, faltante o sobrante. Sin motivos, sin la nota de caja, sin clientes. El texto lo arma `src/domain/notifications/owner-alert.ts`.
- **Solo se marca lo que salió.** Si el envío falla, queda pendiente para la ventana siguiente. Si la anulación se decidió o el turno se revisó entre el barrido y el correo, no se lista y se marca con el correo de la sede (o solo, si no queda más que avisar).
- **Configuración del correo** (`ownerAlertTransport()` en `src/lib/notify`): solo `RESEND_API_KEY`, `EMAIL_FROM`, `ALERT_EMAIL` y `PUBLIC_BASE_URL`, cada una validada con los esquemas de `src/lib/env.ts` (`publicEnv()`). **No depende de `publicConfig()`:** un control del dinero no se apaga porque falten WhatsApp o Turnstile, que son de la reserva pública. El mismo arreglo se aplicó a `alertSender()`, que entrega los avisos de seguridad (bloqueos de ingreso).
- **Sin correo** (falta o viene mal alguna de las cuatro): no se marca nada, queda una línea por ventana en el registro con el conteo y los nombres de las variables que faltan (nunca sus valores) e Inicio sigue igual. Anotado en la tabla de seguridad de [arquitectura.md](arquitectura.md), con plan para el sprint 9.
- **Sin purga:** son unas pocas filas al día, la app no tiene DELETE y borrar un aviso que aún cae en la ventana de 2 días lo haría salir otra vez.
- **Pruebas:** `src/db/owner-alerts.test.ts`, como `villa_app`: cada tipo genera su aviso, repetir el barrido no duplica, la anulación decidida no se avisa, sin correo no se marca, con correo se marca y no se reenvía, un correo por sede, ventana de 15 minutos, envío fallido, el correo sin motivos ni datos del cliente, los permisos de la tabla, lo que hace el dueño (no se avisa, salvo el descuadre de caja) y la configuración: en producción con Resend, `ALERT_EMAIL` y `PUBLIC_BASE_URL` pero sin WhatsApp ni Turnstile, el aviso al dueño y el de seguridad salen; si falta alguna variable, no sale, no se marca y el registro nombra lo que falta. Propiedad (fast-check): para secuencias arbitrarias de eventos, barridos y entregas (con correo, sin correo o fallando), cada evento origina exactamente un aviso y cada aviso sale en un solo correo.

## 4. E. Cortesía (hecho)

Una venta de $0 obligaría a volver opcional el asiento de la venta y a cambiar `sales_assert_totals`, la anulación y los triggers del registro operativo. Es mucho riesgo para algo que no mueve un peso. Por eso la cortesía es un registro aparte:

- **Tabla `appointment_courtesies`:** solo-inserción, `UNIQUE (appointment_id)`, motivo de 3 a 300 caracteres, `created_by` y el precio de lista congelado.
- **Contabilidad:** no hay asiento, ni comisión. Si el dueño quiere pagarle algo al barbero, usa el ajuste que ya existe en la liquidación.
- La cita sale de "Por cobrar" (`appointmentsToCharge`).
- **Quién la da:** quien puede dar descuentos, y solo si el tope de descuento de la sede es 100 %. Queda en la bitácora (`appointment.courtesy`) y genera un aviso al dueño (§3).
- **Informes:** "Cortesías" por barbero, con el precio de lista sumado en SQL.
- **Pantalla:** un botón "Cortesía" en la fila de "Por cobrar" de Caja, no en la hoja de cobro.

**Hecho** (migración 0026):
- **Tabla `appointment_courtesies`:** `location_id`, `appointment_id` (FK compuesta a la cita), `staff_id` de quien atendió (FK compuesta), `list_price` en centavos de pesos enteros (el precio de la cita, que es lo que habría cobrado el cobro), `reason` (de 3 a 300 caracteres, una línea: la base lo vuelve a exigir), `business_date` (día contable local), `created_by` y `created_at`. `UNIQUE (location_id, appointment_id)`. Solo SELECT e INSERT para `villa_app` (el default de `app_apply_grants`).
- **Regla** (`giveCourtesy` en `src/db/courtesies.ts`): una transacción SERIALIZABLE con la cita bloqueada `FOR UPDATE`. Solo una cita en la silla o terminada, sin venta pagada; se rechazan la cancelada, el "No vino" y la que aún no pasa a la silla. Como el cobro, una cita en la silla queda terminada y no se da en un día cerrado. La idempotencia es el `UNIQUE`: repetir devuelve la misma cortesía, sin otra fila ni otro evento. Sin asiento, sin comisión, sin movimiento de caja.
- **El cobro** (`lockAppointment` en `src/db/sales.ts`) rechaza una cita con cortesía: "Esta cita se dio como cortesía: no se cobra". Los triggers contables no cambiaron.
- **"Por cobrar"** (`appointmentsToCharge`) ya no muestra las citas con cortesía.
- **Quién:** la acción `giveCourtesyAction` (Caja) exige `ledger.post` y `canDiscount` (si no, va a "sin permiso"); el dominio (`src/domain/sales/courtesy.ts`) exige además el tope de descuento de la sede en 100 %. Con el tope menor, Caja no muestra el botón y el servidor la rechaza con un mensaje.
- **Bitácora:** `appointment.courtesy` (finanzas) en la misma transacción. Lleva el servicio, quien atendió y el precio de lista; no el cliente ni el motivo (texto libre).
- **Pantalla:** en "Por cobrar", "Cortesía" al lado de "Cobrar"; en el celular los dos botones bajan a su propia línea. El diálogo muestra la cita, avisa "No se cobra ni genera comisión" y pide el motivo.
- **Informe:** sección "Cortesías" en Informes (solo `reports.financial`), por barbero, con la cantidad y el precio de lista sumados en SQL (`courtesiesByStaff`), y su CSV (`courtesies`, sin el motivo).
- **Pruebas:** `src/db/courtesies.test.ts` (ejemplos y una propiedad: en cualquier orden de cortesías y cobros, ninguna cita queda cobrada y con cortesía, manda lo primero que entró, solo las ventas mueven el libro y el informe suma lo mismo que las filas) y los casos de `giveCourtesyAction` en `authorization.test.ts` (matriz de roles, otra sede, evento único, recepción habilitada y tope bajo 100 %).
- **Aviso al dueño:** el barrido de §3 incluye las cortesías.
- **Agenda:** la hoja de la cita ya no ofrece "Cobrar" en una cita con cortesía; muestra "Cortesía" en su lugar (`courtesyAppointmentIds`). El servidor ya la rechazaba.

## 5. B. Gastos fijos (hecho)

**Tablas:**
- `recurring_expenses`: nombre, categoría, monto estimado, `pay_mode` (`cash` o `bank`), día del mes de 1 a 28, cada cuántos meses (de 1 a 12), mes de inicio y si está activo. Los cambios van a la bitácora con `configChanges`.
- `recurring_expense_runs`: solo-inserción, `UNIQUE (recurring_id, period)`. Si se registró, lleva el `expense_id`; si se omitió, el motivo.

**Reglas:**
- **Nada se asienta solo.** Un gasto que nadie confirmó que se pagó dejaría el libro mintiendo. El sistema los muestra como "Vence hoy" o "Vencido" con un botón "Registrar" que llena el formulario de gasto. El monto se puede editar, porque los servicios públicos varían.
- `addExpense` pasa a `addExpenseTx(tx, …)`, para que el gasto y su registro en `recurring_expense_runs` vayan en una sola transacción. Clave de idempotencia: `recurring:<id>:<periodo>`.
- El asiento es el de un gasto normal. No hay tipos de asiento nuevos.

**Propiedades de `duePeriods` (dominio puro):**
- nunca repite un periodo;
- un periodo vencido sigue apareciendo hasta que se registra u omite;
- respeta el intervalo;
- no adelanta más de 3 días.

**Permisos:**

| Acción | Permiso |
|---|---|
| Plantillas | `settings.manage` |
| Registrar de caja | `ledger.post` |
| Registrar de banco | `expenses.bank`, con reautenticación |
| Omitir | Solo el dueño |

**Hecho** (migración 0028):
- **Tabla `recurring_expenses`:** `location_id`, `name` (3 a 60, una línea), `category_id` (FK compuesta a `expense_categories` de la misma sede), `estimated_amount` en centavos de pesos enteros (como `expenses.amount`), `pay_mode` (`cash` o `bank`), `day_of_month` (1 a 28), `interval_months` (1 a 12), `start_month` (primer día del mes), `active`, `created_by`, `created_at` y `updated_at`. Sin `public_id`: el panel no tiene URL por plantilla. `villa_app` tiene `UPDATE` solo de las columnas de la plantilla (nunca `location_id`, `id` ni `created_by`) y no tiene `DELETE`: una plantilla se pausa. `app_apply_grants` parte de la de 0027 y solo agrega esa línea.
- **Tabla `recurring_expense_runs`:** solo-inserción (`villa_app` solo SELECT e INSERT, y triggers que prohíben UPDATE, DELETE y TRUNCATE a cualquiera). `UNIQUE (location_id, recurring_id, period)`; `period` es el primer día del mes. Un CHECK exige `registered` con `expense_id` (FK compuesta a `expenses`, que gana `UNIQUE (location_id, id)`) y sin motivo, o `skipped` sin gasto y con `skip_reason` de 3 a 300 caracteres en una línea. Un gasto pertenece a lo sumo a un periodo (`UNIQUE (location_id, expense_id)`).
- **Dominio** (`src/domain/expenses/recurring.ts`): `duePeriods(plantilla, { today, registeredOrSkipped })` devuelve, del más viejo al más nuevo, los periodos con vencimiento hasta 3 días después de hoy que no se registraron ni omitieron, desde `start_month` y al ritmo de `interval_months`; cada uno con su estado ("Vencido hace N días", "Vence hoy", "Vence en N días"). `today` es el día local de la sede (`businessDate` con `@date-fns/tz`). Una plantilla pausada no muestra nada. El mes de inicio, al crearlo o cambiarlo, va de 12 meses atrás a 12 adelante.
- **Registrar** (`registerRecurringExpense`, `src/db/recurring-expenses.ts`): una transacción SERIALIZABLE con la plantilla `FOR UPDATE`. El periodo debe estar en `duePeriods`. El gasto es el normal (`addExpenseTx`): la categoría y el modo de la plantilla, el monto que se escriba (prellenado con el estimado) y la descripción ("Arriendo · noviembre de 2026", editable). Valen todas las reglas de siempre: caja de hoy abierta y `FOR UPDATE` y efectivo suficiente si es de caja, día abierto, `expenses.bank` si es de banco. El asiento es el de un gasto normal. En la misma transacción: la fila `registered` y el evento `recurring_expense.register` (además del `expense.add` del gasto). Clave `recurring:<id>:<periodo>`: repetir lo mismo devuelve el mismo gasto, sin otra fila ni otro evento; otro monto para un periodo ya registrado, o registrar uno omitido, se rechaza. Un gasto suelto no puede usar una clave que empiece por `recurring:`.
- **`addExpense`** quedó como envoltorio de `addExpenseTx(tx, …)` en su propia transacción SERIALIZABLE: mismo comportamiento.
- **Omitir** (`skipRecurringExpense`): solo con el permiso nuevo `expenses.recurring.skip` (solo el dueño; `src/db/recurring-expenses.ts` lo vuelve a exigir). Fila `skipped` con el motivo y evento `recurring_expense.skip`. El motivo no entra a la bitácora (texto libre). Repetir con el mismo motivo no duplica.
- **Plantillas** (`saveRecurringExpense`): crear y editar con `settings.manage`, sin reautenticación (no mueven dinero). Evento `recurring_expense.save` (configuración) con `configChanges` sobre la lista blanca `AUDIT_FIELDS.recurringExpense`; la categoría va por su nombre y el monto como texto de centavos.
- **Acciones** (`src/app/panel/gastos-fijos/actions.ts`): `loadRecurringExpenses` y `saveRecurringExpenseAction` (`settings.manage`); `registerRecurringExpenseAction` (`ledger.post`; si la plantilla es de banco, además `expenses.bank` y confirmar identidad, como el gasto de banco de Caja; el modo lo decide la plantilla de la sede, no el navegador, y si cambió entre la verificación y el registro no se registra); `skipRecurringExpenseAction` (`expenses.recurring.skip`). Todas en `authorization.test.ts`: matriz por rol, otra sede, un evento por acción y reautenticación del banco.
- **Pantallas:** `/panel/gastos-fijos` (enlace "Gastos fijos" en la navegación, solo con `settings.manage`): "Por pagar" con "Registrar" y "Omitir" (con motivo) por periodo, y las plantillas con crear y editar. En Caja, el aviso "Gastos fijos por pagar" con los de caja vencidos o por vencer y "Registrar", que abre el formulario prellenado (con la caja de hoy abierta). En Inicio, la alerta "N gastos fijos vencidos sin registrar" (solo los vencidos).
- **Pruebas:** `src/domain/expenses/recurring.test.ts` (ejemplos y propiedades: nunca repite un periodo, respeta el intervalo y el mes de inicio, no adelanta más de 3 días, no muestra lo registrado u omitido y sí todo lo demás que ya toca, un vencido sigue apareciendo hasta registrarse u omitirse) y `src/db/recurring-expenses.test.ts` (como `villa_app`: transacción única, idempotencia, caja y efectivo, día cerrado, otra sede, permisos de la base y la prueba de coherencia de §6).
- **Coherencia (§6, hecha):** en `src/db/recurring-expenses.test.ts`, una propiedad con fast-check: con gastos sueltos de caja y de banco en varios días y gastos registrados desde plantillas, la suma de "Gastos por categoría" (`expensesByCategory`) es igual al neto de las cuentas de gasto de las categorías en el libro, en cualquier rango.

## 6. Orden

1. D, C y E: no comparten archivos fuera de `schema.ts`, la bitácora y `authorization.test.ts`, que se integran uno por uno.
2. B.
3. Al final:
   - la prueba de coherencia "suma de gastos por categoría = cuentas de gasto del libro";
   - la auditoría de seguridad;
   - la documentación.

## 7. Preguntas al dueño (con el valor que se usa mientras no responda)

1. **¿Algún proveedor les fía?** Mientras no responda, no hay cuentas por pagar (parte A aplazada).
2. **¿Los avisos le llegan por correo o por WhatsApp?** Correo a `ALERT_EMAIL`, agrupado cada 15 minutos. WhatsApp necesita una plantilla aprobada y cuesta por mensaje.
3. **¿Quién da cortesías y se le paga comisión al barbero?** Quien puede dar descuentos con tope de 100 %, y sin comisión.
4. **¿Villa es responsable de IVA?** Resuelta: **no** (el dueño, 2026-11-11). Requisitos que conviene que el contador confirme: solo una persona natural puede ser no responsable (una S.A.S. es responsable por ley), y los ingresos brutos del año anterior deben ser menores a 3.500 UVT.
