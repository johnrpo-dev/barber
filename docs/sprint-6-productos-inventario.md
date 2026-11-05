# Sprint 6: venta de productos con inventario básico (diseño)

Diseño preparado por el agente de planificación sobre el código actual. Todavía no está implementado. Antes de construirlo hay que cerrar las **decisiones del dueño** del final.

## En una frase

- Los productos van en una tabla propia.
- La existencia y el costo salen de sumar un kardex solo-inserción.
- El costo es promedio ponderado, calculado con `allocate()` sobre la bolsa del producto (nunca con un costo unitario redondeado).
- Las líneas de venta pasan a ser de servicio **o** de producto.
- Postgres exige al hacer COMMIT que el **saldo de 1435 = Σ valor de los movimientos** y que **ninguna existencia quede negativa**.

## Modelo de datos

### `products`

Catálogo: se edita, no se borra.

- Columnas: `public_id` (uuid), `name` único por sede, `sku` opcional, `price` en pesos enteros, `commission_bps` (0 por defecto) y `active`.
- **No tiene columna de costo:** el costo se deriva de los movimientos.

### `inventory_documents`

Compra o conteo. Solo-inserción, con asiento propio.

- `kind` es `purchase` o `count`.
- `paid_from` es `cash` (exige caja abierta), `bank` u `owner` (carga inicial contra 3105).
- Lleva idempotencia (`idempotency_key` y `request_hash`).

### `inventory_movements`

El kardex, solo-inserción.

| `kind` | Cantidad | Valor |
|---|---|---|
| `purchase` | + | ≥ 0 |
| `sale` | − | ≤ 0 |
| `count` | ± | mismo signo que la cantidad |
| `void_return` | + | ≥ 0 |

- La existencia **nunca se guarda: se suma en SQL** (`product_stock()` / `stockLevels`).

### `sale_lines`

Se le agrega:

- `kind` (`service` o `product`);
- `product_id`;
- `quantity`;
- `cost` (costo congelado de la línea);
- un CHECK que exige exactamente uno de `service_id` o `product_id`.

Las filas existentes cumplen sin cambios: son de servicio, con cantidad 1 y costo 0.

## Contabilidad

Las cuentas nuevas debe validarlas el contador:

| Cuenta | Nombre | Tipo |
|---|---|---|
| 1435 | Inventario de mercancía | Activo |
| 6135 | Costo de los productos vendidos | Gasto |
| 5315 | Faltantes y sobrantes de inventario | Gasto |

4135 (ingreso por productos) ya existe. Los asientos:

| Operación | Débito | Crédito |
|---|---|---|
| Compra de contado | 1435 | 1105 (más un movimiento de caja) |
| Compra por banco | 1435 | 1110 |
| Carga inicial | 1435 | 3105 |
| Venta | lo de hoy + 6135 | 4170 (servicios) + 4135 (productos) + 1435 |
| Faltante en un conteo | 5315 | 1435 |
| Sobrante en un conteo | 1435 | 5315 |
| Anulación | el espejo exacto de la venta, con un movimiento `void_return` por línea de producto | |

### Garantías en la base

- La existencia nunca queda negativa: un constraint trigger diferido con candado por producto.
- La cuenta 1435 cuadra con los movimientos de cada asiento. Ningún asiento manual toca 1435 sin su movimiento.
- `sales_assert_totals` se vuelve a definir a partir de su cuerpo exacto de 0010:
  - 4170 = servicios y 4135 = productos;
  - 6135 = −1435 = Σ costo;
  - ninguna cuenta fuera de la lista.
- Toda anulación con productos devuelve existencia y costo exactos.

## Reglas propuestas

- **No se vende sin existencia.** Sin existencia no hay costo, y el conteo deja de servir como control.
- **Descuentos en productos:** con las mismas reglas que los servicios (tope, permiso y motivo).
- **Comisión por producto:** `commission_bps`, 0 por defecto. La recibe quien vende.
- **Venta solo de productos (mostrador):** se permite.
- **Permiso nuevo `inventory.manage`**, solo para el dueño:
  - catálogo, costos, conteos, compras por banco y carga inicial;
  - recepción solo ve existencias, vende y (si el dueño lo aprueba) registra compras de contado.

## Fases

1. **A, base y dominio:**
   - `scaleHalfUp` en `money.ts`;
   - cuentas y tipos de asiento;
   - `domain/inventory/*` (costeo y asientos, con fast-check);
   - migración de tablas y garantías;
   - `db/products.ts` y `db/inventory.ts`;
   - auditoría.
2. **B, catálogo y entradas:**
   - `panel/productos` (acciones en la matriz de permisos);
   - caja (compras de mercancía);
   - seed.
3. **C, vender:**
   - migración de `sale_lines` y `sales_assert_totals`;
   - `checkout`, anulación, hoja de cobro, recibos;
   - informes por barbero y por servicio con `kind = 'service'` y bruto `unit_price × quantity`.
4. **D, conteo e informes:** margen por producto, valorización (que cuadre contra 1435).
5. **E, cierre:**
   - chequeo de cordura del backup (1435 = Σ movimientos);
   - documentación;
   - auditoría de seguridad.

**Pruebas clave:**

- Vender toda la existencia en cualquier partición suma exactamente su valor.
- Anular justo después de vender deja la existencia, el valor y el saldo de 1435 como estaban.
- Ataques directos con SQL (existencia negativa, asiento en 1435 sin movimiento, UPDATE o DELETE del kardex).
- Dos ventas simultáneas de la última unidad.

## Fuera del alcance básico

- Proveedores a crédito y cuentas por pagar (sprint 8).
- Devolución de compras y devolución parcial de ventas.
- Lotes, vencimientos y códigos de barras.
- Insumos que consumen los servicios (siguen como gasto).
- IVA y factura electrónica.

## Decisiones del dueño (antes de construir)

1. **IVA de los productos.** Si Villa es responsable de IVA, la venta de productos lleva 19 % (cuenta 2408). Hasta que el contador lo confirme, el precio se toma como total y todo va a 4135.
2. **Códigos 1435, 6135 y 5315**: que los valide el contador.
3. **¿Recepción puede registrar compras de contado?** Es el mismo riesgo que ya se acepta con los gastos de caja.
