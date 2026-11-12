# Revisión contable del sistema (2026-11-12)

Revisión hecha por Claude contra el PUC (Decreto 2650 de 1993), las NIIF para Pymes y el Estatuto Tributario. **No reemplaza al contador público** (Ley 43 de 1990): sirve para llevarle preguntas concretas y ahorrar su tiempo.

## 1. Cuentas por pagar a proveedores: correcto

| Hecho | Asiento | Veredicto |
|---|---|---|
| Compra de mercancía a crédito | Dr 1435 Inventario / Cr 2205 Proveedores | Correcto. Se causa al recibir la mercancía, no al pagarla (devengo, NIIF Pymes 2.36) |
| IVA que cobra el proveedor | Va dentro del costo en 1435 | Correcto **solo si** Villa no es responsable de IVA (ver §3) |
| Pago de la caja o del banco | Dr 2205 / Cr 1105 o 1110 | Correcto |
| Pago con plata del dueño | Dr 2205 / Cr 3105 (aporte) | El asiento es correcto; el código depende de la forma jurídica (ver §2) |
| Error en un pago o una compra | Asiento de reversa, nunca borrado | Correcto |
| Abonos parciales | Un pago nunca supera el saldo de su compra (lo exige la base) | Correcto |
| Auxiliar contra mayor | El saldo de 2205 = Σ (total − pagos vigentes) de las compras a crédito vigentes, revisado en cada respaldo (`sanity.sql` 4c) | Correcto. Es lo que el contador concilia a mano en otros programas |

Plazo por defecto: **30 días** (decisión del dueño, 2026-11-12). No se manejan intereses de mora ni descuentos por pronto pago.

## 2. Plan de cuentas: observaciones

| Cuenta del sistema | Qué es en el PUC | Observación | Prioridad |
|---|---|---|---|
| 3105 "Capital del dueño" | 3105 Capital suscrito y pagado (sociedades) | Si Villa es **persona natural**, la cuenta del PUC es **3130 Capital de personas naturales**. Si es S.A.S., 3105 está bien | Media: definir antes de producción, porque el libro es solo-inserción |
| 5310 "Diferencias y redondeos de caja" | 5310 Pérdida en venta y retiro de bienes | Los faltantes van mejor en 5315 o 5395, y los sobrantes en 4295 (ingresos diversos). Hoy un sobrante resta en 5310 | Baja: se puede mapear al exportar |
| 5105 "Comisiones de barberos" | 5105 Gastos de personal | Solo aplica si los barberos son **empleados**. Si son contratistas, va en 5110 Honorarios o como costo del servicio (clase 7), según el contador | Media: depende de la pregunta 3 |
| 1365 "Anticipos a trabajadores" | 1365 Cuentas por cobrar a trabajadores | Bien si son empleados; si son contratistas, 1330 Anticipos y avances | Baja |
| 2380 "Propinas por pagar" | 2380 Acreedores varios | Aceptable. Algunos contadores prefieren 2815 (ingresos recibidos para terceros), porque la propina no es de Villa | Baja |
| 6135 "Costo de los productos vendidos" | 6135 Comercio al por mayor y al por menor | Incluye las mermas del conteo. Es aceptable en un negocio pequeño; las pérdidas anormales irían a gasto | Baja |
| 1105, 1110, 1435, 2205, 2335, 4135, 4170, 5195, 5305 | Coinciden | Sin observación | — |

## 3. Hallazgo importante: la condición de "no responsable de IVA"

El sistema asume que Villa **no es responsable de IVA** (el dueño, 2026-11-11). Hay dos caminos para serlo, y ninguno está confirmado:

1. **Persona natural del régimen ordinario** (art. 437, parágrafo 3, E.T.). Exige ingresos brutos del año anterior por debajo de 3.500 UVT (unos $174 millones en 2025 y $183 millones en 2026), y lo mismo para las consignaciones bancarias. Con unos 10 barberos y los servicios registrados como ingreso de Villa (4170), ese tope **muy probablemente se supera**.
2. **Régimen Simple (SIMPLE), grupo 1 "peluquería"** (art. 437, parágrafo 4, y art. 908). Una peluquería del SIMPLE que **solo** presta servicios de peluquería no es responsable de IVA, sin el tope de 3.500 UVT. Pero el **concepto DIAN 007877 de 2026 (13 de mayo)** dice que vender productos capilares o de cuidado personal "configura una actividad comercial independiente". Villa vende productos (sprint 6), y por eso **podría perder la no responsabilidad**.

**Si resulta responsable de IVA**, cambia mucho:

- los cobros llevan IVA (2408);
- las compras tienen IVA descontable y ya no va al costo;
- hay declaraciones de IVA;
- muy probablemente hay que facturar electrónicamente.

El sistema hoy no hace nada de eso. Es lo primero que hay que confirmar con el contador, **antes del lanzamiento**.

## 4. Retención en la fuente

El sistema no practica retención al pagar a proveedores ni a barberos.

- **Si Villa está en el SIMPLE:** no es agente retenedor, salvo en pagos laborales (art. 911 E.T.). Entonces no hay retención, salvo que los barberos sean empleados.
- **Si es persona natural del régimen ordinario:** es agente retenedor solo si el año anterior superó 30.000 UVT de patrimonio o ingresos brutos (art. 368-2). Con 10 barberos es improbable, pero hay que confirmarlo.

## 5. Preguntas para el contador (en este orden)

1. ¿Villa es persona natural o S.A.S.? ¿Está en el Régimen Simple? (define 3105 o 3130, el IVA y la retención)
2. ¿Es o no responsable de IVA, ahora que vende productos (concepto DIAN 007877 de 2026)?
3. ¿Los barberos son empleados o contratistas? (define 5105 o 5110, 1365 o 1330, la nómina electrónica o el documento soporte, y la seguridad social)
4. ¿Acepta el mapeo de §2 o prefiere otros códigos? Se pueden cambiar antes de producción sin tocar asientos reales.
5. ¿Qué reporte quiere recibir y en qué formato: libro diario, balance de prueba, o un archivo para Alegra o Siigo?

Fuentes: [concepto DIAN 007877 de 2026](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_7877_2026.htm), [topes de no responsables de IVA para 2026](https://actualicese.com/montos-para-ser-no-responsables-de-iva-en-2026/) y [art. 915 E.T.](https://estatuto.co/915).
