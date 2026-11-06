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

## 3. C. Avisos al dueño

- **Tabla `owner_alerts`:** `location_id`, `kind`, `ref_id`, `created_at`, `notified_at` y `UNIQUE (location_id, kind, ref_id)`.
- **Barrido idempotente del worker cada minuto:** `INSERT … SELECT … ON CONFLICT DO NOTHING` sobre lo que ya existe (`void_requests`, `cash_sessions` por encima del umbral, `day_close_events` de reapertura y cortesías) de los últimos 2 días.
- **Entrega:** un correo agrupado cada 15 minutos a `ALERT_EMAIL`, con el patrón de `deliverSecurityAlerts`.
- **No toca el camino del dinero:** ni `cash.ts`, ni `voids.ts`, ni triggers nuevos.
- **El correo no lleva** el motivo libre ni nombres de clientes; solo quién (`display_name` del personal), el monto y el enlace al panel.
- **No se avisa la anulación aprobada:** la aprueba el mismo dueño.
- **Sin correo configurado,** el aviso queda en el registro del servidor y en Inicio, como hoy.
- **Propiedad:** repetir el barrido no duplica avisos y cada aviso sale en un solo correo.

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
- **Pendiente:** el aviso al dueño (§3) aún no barre las cortesías.

## 5. B. Gastos fijos

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
4. **¿El contador confirma si Villa es responsable de IVA?** Sigue abierta desde el sprint 6. No bloquea este sprint.
