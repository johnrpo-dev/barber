# Sprint 6: venta de productos con inventario periódico (diseño)

Las **decisiones del dueño** del final quedaron cerradas el 2026-11-11; se construye por fases (abajo).

## Cambio de rumbo: periódico en vez de kardex

El primer diseño era un kardex completo:
- costo promedio ponderado por producto;
- existencia siempre al día;
- un trigger diferido con candado por producto;
- redefinir `sales_assert_totals` para meter el costo en cada venta.

El council del sprint 6 lo descartó y el dueño aprobó el cambio. Una barbería vende pocos productos (ceras, aceites, shampoo), y ese diseño trae mucha maquinaria para lo que da. Además, cada trigger nuevo sobre el libro es otro sitio donde una venta puede fallar en el mostrador. **Las cuentas nunca deben fallar**, y la forma más segura de lograrlo es tocar el cobro lo menos posible.

**Lo que se pierde:**
- el margen exacto de cada venta;
- la existencia exacta en todo momento.

El margen del mes sí sale exacto después del conteo. La existencia se estima con unidades (ver abajo).

**Cuándo volver al kardex:**
- si pasan de unas 50 referencias;
- si los faltantes del mes dejan de ser poca plata;
- o si el dueño necesita el margen venta por venta.

## En una frase

- Las compras suben la cuenta 1435 (inventario).
- Las ventas solo registran el ingreso en 4135 y las unidades vendidas; **no mueven costo**.
- Una vez al mes se cuentan las unidades y se valoran al costo de la última compra.
- Un único asiento de ajuste lleva 1435 al valor contado, contra 6135 (costo de ventas).

## Modelo de datos

### `products`

Catálogo: se edita, no se borra.

- Columnas: `public_id`, `name` único por sede, `sku` opcional, `price` en pesos enteros, `commission_bps` (0 por defecto) y `active`.
- No tiene costo ni existencia guardados.

### `inventory_documents` y `inventory_document_lines`

Compras y conteos. Solo-inserción, con idempotencia (`idempotency_key` y `request_hash`).

- `kind` es `purchase` o `count`.
- **Compra:**
  - cada línea lleva producto, unidades y costo total de la línea;
  - `paid_from` es `cash` (exige caja abierta y crea el movimiento de caja), `bank` u `owner` (carga inicial contra 3105).
- **Conteo:**
  - cada línea lleva producto, unidades contadas y su valor;
  - el valor de cada línea es `unidades × costo de la última compra`, calculado con `money.ts`;
  - genera el asiento de ajuste.

### `sale_lines`

Se le agrega:

- `kind` (`service` o `product`);
- `product_id`;
- `quantity`;
- un CHECK que exige exactamente uno de `service_id` o `product_id`.

Las filas existentes cumplen sin cambios: son de servicio, con cantidad 1. **Sin columna de costo.**

## Contabilidad

Las cuentas nuevas debe validarlas el contador:

| Cuenta | Nombre | Tipo |
|---|---|---|
| 1435 | Inventario de mercancía | Activo |
| 6135 | Costo de los productos vendidos | Gasto |

4135 (ingreso por productos) ya existe. Los asientos:

| Operación | Débito | Crédito |
|---|---|---|
| Compra de contado | 1435 | 1105 (más un movimiento de caja) |
| Compra por banco | 1435 | 1110 |
| Carga inicial | 1435 | 3105 |
| Venta | lo de hoy | 4170 (servicios) + 4135 (productos) |
| Conteo, si el valor contado es menor que el saldo de 1435 | 6135 | 1435 |
| Conteo, si el valor contado es mayor | 1435 | 6135 |
| Anulación de una venta | el espejo de la venta, como hoy | |
| Anulación de una compra | el espejo de la compra (1105, 1110 o 3105) | 1435 |

### Anular una compra mal registrada

Solo el dueño, con reautenticación, desde "Compras recientes" en Productos. No borra nada: asienta la reversa exacta de la compra en el día contable de hoy, y la compra queda anulada porque su asiento tiene reversa (una sola vez). Su costo deja de contar como "última compra". Reglas, que la base también exige al confirmar (migración 0033):

- **Si hubo un conteo después, no se anula.** El conteo ya dejó 1435 en lo que había; anular bajaría el inventario por debajo de lo contado. La diferencia se corrige en el próximo conteo.
- **Una compra de caja se anula solo con su mismo turno abierto,** y el efectivo vuelve a ese turno. Con el turno cerrado, el arqueo ya tuvo en cuenta la diferencia; devolverla otra vez la contaría doble.
- **Un conteo no se anula:** se corrige con otro conteo.

Antes de registrar, la compra avisa y pide confirmar si el costo de una línea supera precio de venta × unidades (casi siempre un error de dedo).

El ajuste es `saldo de 1435 al cierre del conteo − valor contado`, y se calcula en SQL. Así 6135 del mes queda igual a inventario inicial + compras − inventario final: el costo de lo vendido **más** lo que se perdió.

### Garantías en la base

- 1435 solo la mueven documentos de inventario (compra o conteo). Lo impide un trigger sobre las líneas de asiento: ningún asiento de venta, gasto ni manual la toca.
- El asiento sigue cuadrando por el constraint trigger de siempre.
- `sales_assert_totals` cambia lo mínimo: 4170 es la suma de líneas de servicio y 4135 la de líneas de producto. No aparece ninguna cuenta nueva en la venta.
- El conteo toma un candado por sede: no puede haber dos conteos a la vez ni un conteo mezclado con una compra a medio registrar.

## Faltantes, sin kardex

El asiento junta en 6135 el costo de lo vendido con lo que se perdió. Para que el dueño los distinga, el informe del conteo muestra, **en unidades** y por producto:

`esperado = último conteo + compras − vendidas`; `diferencia = contado − esperado`.

Es un informe, no un asiento. La plata cuadra siempre; las unidades señalan dónde mirar.

## Reglas propuestas

- **Se puede vender sin existencia registrada.** Sin kardex no hay saldo en tiempo real que bloquee. El primer conteo y el informe de diferencias lo ponen en evidencia.
- **Descuentos en productos:** con las mismas reglas que los servicios (tope, permiso y motivo).
- **Comisión por producto:** `commission_bps`, 0 por defecto. La recibe quien vende.
- **Venta solo de productos (mostrador):** se permite.
- **Permiso nuevo `inventory.manage`**, solo para el dueño: catálogo, conteos, compras por banco y carga inicial. Recepción vende y, si el dueño lo aprueba, registra compras de contado.

## Fases

1. **A, base y dominio (hecho):**
   - cuentas 1435 y 6135 y tipos de asiento `inventory_purchase` e `inventory_count` (y `cash_movements.kind = 'inventory_purchase'`);
   - `domain/inventory/*` (valoración del conteo y asiento de ajuste, con fast-check) y `mulDiv` en `money.ts`;
   - migración **0032** de tablas y garantías:
     - la línea de asiento en 1435 o 6135 solo pasa si el asiento es de inventario o la reversa de uno, y uno de inventario no toca otras cuentas;
     - al COMMIT, cada asiento de inventario tiene su documento; el total del documento es la suma de sus líneas; la compra mueve exactamente su total (y si es de caja, es un movimiento de su turno); y tras un conteo, 1435 de la sede es exactamente lo contado;
     - documentos y líneas solo-inserción; productos sin DELETE y con UPDATE solo en las columnas editables;
     - `app_apply_grants` = la de 0031 más el UPDATE por columnas sobre `products`;
   - `db/products.ts` y `db/inventory.ts`: `recordPurchase` (SERIALIZABLE, clave de idempotencia ligada al contenido, caja abierta y efectivo suficiente si es de caja, día abierto, candado de inventario por sede) y `recordCount` (solo el dueño; candado por sede; saldo de 1435 en SQL; exige contar todo producto activo o con compras). Permisos `inventory.manage` (dueño) e `inventory.purchase` (dueño y recepción).
2. **B, catálogo y compras (hecho):**
   - `/panel/productos` (solo `inventory.manage`): crear, editar, retirar; compra del banco o carga inicial con reautenticación; saldo de 1435 según el libro y costo de la última compra por producto;
   - Caja: "Compra de mercancía" (recepción y dueño), varias líneas, sale del efectivo del turno y aparece en el desglose del esperado;
   - acciones en `authorization.test.ts` (matriz, IDOR, reautenticación y bitácora); productos de ejemplo en `seed-demo`.
   - La pantalla del conteo llegó en la fase D.
   - **Anular una compra (hecho, migración 0033):** "Compras recientes" en Productos, solo el dueño; reglas arriba. Aviso de costo alto antes de registrar.
3. **C, vender (hecho, migración 0034):**
   - `sale_lines`: `kind` (`service` o `product`), `product_id` y `quantity`; un CHECK exige exactamente uno de servicio o producto, un servicio de a uno y un producto de 1 a 99 unidades. `unit_price` es por unidad; el bruto es `unit_price × quantity` y los CHECK de monto y comisión lo usan.
   - `sales_assert_totals`: subtotal = Σ precio × unidades; 4170 = neto de servicios y 4135 = neto de productos. Además, el asiento de una venta solo puede tocar sus cuentas (1105, 1110, 5305, 4170, 4135, 2380, 5105, 2335).
   - `checkout`: productos con unidades y quien vende (recibe la comisión del producto); precio y comisión salen del catálogo de la sede; descuentos con la clave `product:<i>` y las mismas reglas (tope sobre el bruto de todas las unidades, permiso y motivo). Un cobro sin cita puede ser solo de productos (mostrador). La huella de idempotencia de un cobro sin productos no cambió.
   - Hoja de cobro: "Agregar producto" (producto, unidades, "Lo vendió"; por defecto, el barbero de la cita o quien cobra). Vender un producto no abre una fila de propina, y la propina por porcentaje se calcula sobre los servicios.
   - La anulación no cambió: es la reversa exacta del asiento (devuelve 4135 y la comisión).
   - Recibos, historial y movimiento de caja muestran las unidades ("Cera ×2", "2 × $25.000").
   - Informes: por servicio, solo servicios. Por barbero, servicios, bruto, descuento y neto siguen siendo de servicios (la suma del neto es 4170), una columna "Productos" con el neto vendido por cada quien (la suma es 4135) y la comisión de todo lo que atendió o vendió (la misma que se liquida). Inicio cuenta solo servicios.
4. **D, conteo e informes (hecho, sin migración):**
   - **Unidades** (`countSheet` y `countReport` en `db/inventory.ts`, sumadas en SQL; `expectedUnits` y `unitDifference` en el dominio, con fast-check). Por producto, entre dos conteos: `esperado = conteo anterior + compras vigentes − vendidas`.
     - Las compras se ordenan contra los conteos por id, porque el candado de inventario las serializa. Una compra anulada no cuenta.
     - Las ventas cuentan por hora: suman las cobradas en el periodo y restan las anuladas en él (la unidad volvió). Una venta anulada después de un conteo devuelve su unidad al periodo siguiente, y el informe del conteo guardado no cambia.
     - El esperado puede salir negativo (se vendió algo cuya compra no se registró) y se muestra tal cual.
   - **Pantalla del conteo** (Productos → "Contar inventario", solo el dueño, con reautenticación; `recordCountAction`).
     - Por cada producto que el conteo exige (activos o con movimientos): lo que debería haber, cómo se llega a ese número y, al escribir lo contado, la diferencia ("Falta 1", "Sobran 2", "Cuadra").
     - Vista previa del valor al costo de la última compra (`valueCountLine`), del saldo de 1435 y del ajuste al costo de ventas. El servidor recalcula todo.
     - Avisa si un producto contado no tiene compras (vale $0).
     - Un conteo no se borra: el siguiente lo corrige.
   - **Historial** ("Conteos" en Productos): los últimos 6 con su valor, su ajuste (lo que movió en 6135) y las unidades que faltaron. "Ver diferencias" abre la tabla por producto: debería, hay y diferencia.
   - **Margen de productos en Informes** (`productMargin` en `domain/reports/pnl.ts`, con fast-check): 4135 − 6135 a partir del estado de resultados, cuyas sumas vienen de SQL. Se muestra si hubo ventas de productos o costo.
     - Si en el periodo no hubo conteo (`inventoryCountsInPeriod`), advierte que el costo todavía no se conoce y el margen sale inflado.
   - **Recordatorio** (`countDueToday`): el último día del mes en la zona de la sede, si hay productos activos y aún no hay un conteo con ese día contable.
     - Inicio muestra la alerta "Hoy es el último día del mes: toca contar el inventario" a quien tiene `inventory.manage`.
     - Productos muestra "Contar ahora".
   - `recordCountAction` en `authorization.test.ts`: matriz (solo el dueño), IDOR (contar con productos de otra sede), sesión vieja y bitácora `inventory.count`.
5. **E, cierre (hecho, migración 0035):**
   - `deploy/backup/sanity.sql`: ninguna línea de 1435 o 6135 fuera de asientos de inventario (o la reversa de una compra); 1435 de cada sede = último conteo + compras vigentes posteriores; triggers de 0032 a 0034 presentes; `villa_app` sin UPDATE ni DELETE en documentos de inventario.
   - Auditoría de seguridad (solo lectura) de todo el sprint: sin hallazgos críticos ni altos. Correcciones:
     - **M-1:** el candado de inventario es ahora el UPDATE de una fila por sede (`inventory_locks`), porque en SERIALIZABLE la foto se toma antes de esperar un candado consultivo. Prueba determinista en `concurrency.pg.test.ts`.
     - **M-2:** Inicio avisa al dueño de las compras de caja de otras personas en 7 días.
     - **B-2:** a lo sumo 500 productos por sede.
     - El resto queda en la tabla "Seguridad: estado y plan" de [arquitectura.md](arquitectura.md).
   - La regla "banco y carga inicial solo el dueño" sigue en TypeScript, no en la base (`created_by` no trae el rol). Revisada en la auditoría y aceptada.

**Pruebas clave (propiedades):**

- Para cualquier secuencia de compras, ventas y conteos, el saldo de 1435 después de un conteo es exactamente el valor contado.
- 6135 del periodo es inventario inicial + compras − inventario final.
- Un conteo repetido con la misma clave de idempotencia no crea un segundo ajuste.
- Ningún asiento que no sea de inventario puede tocar 1435 (ataque directo con SQL).

## Fuera del alcance básico

- Proveedores a crédito y cuentas por pagar (sprint 8).
- Devolución de compras y devolución parcial de ventas.
- Lotes, vencimientos y códigos de barras.
- Insumos que consumen los servicios (siguen como gasto).
- IVA y factura electrónica.

## Decisiones del dueño (cerradas el 2026-11-11)

1. **IVA de los productos. Resuelta: Villa no es responsable de IVA** (el dueño, 2026-11-11). Requisitos que conviene que el contador confirme: solo una persona natural puede ser no responsable (una S.A.S. es responsable por ley), y los ingresos brutos del año anterior deben ser menores a 3.500 UVT. El precio es el total y la venta va completa a 4135, sin cuenta 2408. Si algún día pasa a ser responsable, la venta lleva 19 % y cambia su asiento.
2. **Códigos 1435 y 6135**: se usan los del PUC (1435 mercancías no fabricadas por la empresa, 6135 costo de ventas del comercio). Que el contador los valide; cambiarlos después es renombrar la cuenta, no mover asientos.
3. **¿Recepción puede registrar compras de contado?** **Sí**, como los gastos de caja: con la caja abierta y su movimiento. Las compras por banco, la carga inicial, el catálogo y los conteos siguen siendo solo del dueño (`inventory.manage`).
4. **Día del conteo:** **el último día del mes, después de la última venta.** El ajuste queda en ese mes y el informe mensual sale completo. El sistema no lo impide otro día (el dueño puede contar cuando quiera), pero Inicio lo recuerda el último día del mes.
