# Sprint 6: venta de productos con inventario periódico (diseño)

Todavía no está implementado. Antes de construirlo hay que cerrar las **decisiones del dueño** del final.

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
| Anulación | el espejo de la venta, como hoy | |

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

1. **A, base y dominio:**
   - cuentas y tipos de asiento;
   - `domain/inventory/*` (valoración del conteo y asiento de ajuste, con fast-check);
   - migración de tablas y garantías;
   - `db/products.ts` y `db/inventory.ts`.
2. **B, catálogo y compras:** `panel/productos` (acciones en la matriz de permisos), compras desde caja, seed.
3. **C, vender:**
   - migración de `sale_lines` y `sales_assert_totals`;
   - `checkout`, anulación, hoja de cobro, recibos;
   - informes por barbero y por servicio con `kind = 'service'` y bruto `unit_price × quantity`.
4. **D, conteo e informes:**
   - pantalla de conteo e informe de diferencias en unidades;
   - margen del mes (4135 − 6135).
5. **E, cierre:** chequeo de cordura del backup (1435 solo con documentos de inventario), documentación y auditoría de seguridad.

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

## Decisiones del dueño (antes de construir)

1. **IVA de los productos. Resuelta: Villa no es responsable de IVA** (el dueño, 2026-11-11). Requisitos que conviene que el contador confirme: solo una persona natural puede ser no responsable (una S.A.S. es responsable por ley), y los ingresos brutos del año anterior deben ser menores a 3.500 UVT. El precio es el total y la venta va completa a 4135, sin cuenta 2408. Si algún día pasa a ser responsable, la venta lleva 19 % y cambia su asiento.
2. **Códigos 1435 y 6135**: que los valide el contador.
3. **¿Recepción puede registrar compras de contado?** Es el mismo riesgo que ya se acepta con los gastos de caja.
4. **Día del conteo:** el último día del mes al cierre, o el primero antes de abrir.
