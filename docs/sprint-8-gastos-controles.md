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

## 3. C. Avisos al dueño

- **Tabla `owner_alerts`:** `location_id`, `kind`, `ref_id`, `created_at`, `notified_at` y `UNIQUE (location_id, kind, ref_id)`.
- **Barrido idempotente del worker cada minuto:** `INSERT … SELECT … ON CONFLICT DO NOTHING` sobre lo que ya existe (`void_requests`, `cash_sessions` por encima del umbral, `day_close_events` de reapertura y cortesías) de los últimos 2 días.
- **Entrega:** un correo agrupado cada 15 minutos a `ALERT_EMAIL`, con el patrón de `deliverSecurityAlerts`.
- **No toca el camino del dinero:** ni `cash.ts`, ni `voids.ts`, ni triggers nuevos.
- **El correo no lleva** el motivo libre ni nombres de clientes; solo quién (`display_name` del personal), el monto y el enlace al panel.
- **No se avisa la anulación aprobada:** la aprueba el mismo dueño.
- **Sin correo configurado,** el aviso queda en el registro del servidor y en Inicio, como hoy.
- **Propiedad:** repetir el barrido no duplica avisos y cada aviso sale en un solo correo.

## 4. E. Cortesía

Una venta de $0 obligaría a volver opcional el asiento de la venta y a cambiar `sales_assert_totals`, la anulación y los triggers del registro operativo. Es mucho riesgo para algo que no mueve un peso. Por eso la cortesía es un registro aparte:

- **Tabla `appointment_courtesies`:** solo-inserción, `UNIQUE (appointment_id)`, motivo de 3 a 300 caracteres, `created_by` y el precio de lista congelado.
- **Contabilidad:** no hay asiento, ni comisión. Si el dueño quiere pagarle algo al barbero, usa el ajuste que ya existe en la liquidación.
- La cita sale de "Por cobrar" (`appointmentsToCharge`).
- **Quién la da:** quien puede dar descuentos, y solo si el tope de descuento de la sede es 100 %. Queda en la bitácora (`appointment.courtesy`) y genera un aviso al dueño (§3).
- **Informes:** "Cortesías" por barbero, con el precio de lista sumado en SQL.
- **Pantalla:** un botón "Cortesía" en la fila de "Por cobrar" de Caja, no en la hoja de cobro.

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
