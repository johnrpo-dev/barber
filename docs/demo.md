# Demo para el dueño de Barbería Villa

La demo es para mostrarle el sistema al dueño con un mes de operación creíble. Corre en tu computador, sobre una base de datos aparte: no toca la base de desarrollo ni la de la barbería.

## 1. Prepararla (el mismo día de la presentación)

La historia termina **hoy**: la caja de hoy queda abierta, con citas en la silla y otras por llegar. Si la armas un día antes, mañana Caja dirá que el turno es "de un día anterior". Por eso se rehace el día de la presentación, antes de salir.

1. Detén el servidor de desarrollo normal (`npm run dev`), porque la demo usa el mismo puerto 3000.
2. Corre este comando y espera unos 10 minutos:

   ```bash
   npm run demo:setup
   ```

   - Crea, la primera vez, un PostgreSQL propio en `.demo/` (solo en este computador, puerto 55433).
   - Rehace la base desde cero: migraciones, sede, catálogo y equipo. Luego genera **30 días de operación**.
   - Al final corre la **prueba de cordura del libro** (la misma de los respaldos): débitos = créditos en todos los asientos, la caja nunca negativa, inventario y proveedores. Si algo no cuadrara, se detiene con error.
   - **Anota la contraseña** de las cuentas de prueba (`recepcion@villa.test` y `barbero@villa.test`). Sale una sola vez en la terminal.
3. Crea tu cuenta de dueño en la base de la demo:

   ```bash
   npm run demo:owner
   ```

   Al entrar la primera vez, la app te pide configurar el código de verificación (2FA). Agrégalo a tu app de autenticación con un nombre como "Villa demo", para no confundirlo con el de desarrollo.
4. Arranca la app de la demo:

   ```bash
   npm run demo
   ```

   - En el computador: http://localhost:3000.
   - En el celular, en la misma wifi: http://<IP del PC>:3000. Next la imprime como "Network".
5. Abre tres ventanas: la **portada** (http://localhost:3000), el **panel como recepción** (en una ventana de incógnito) y el **panel como dueño**.

Al terminar, `npm run demo:stop` apaga ese PostgreSQL.

**Para practicar desde cero:** como dueño, **Ajustes → Demo: empezar de cero → Borrar todos los registros** (escribes BORRAR y te pide tu código).
- **Borra:** la operación (citas, clientes, ventas, caja, libro, compras, proveedores, anticipos, bitácora).
- **Conserva:** la sede, los servicios, los productos, el personal y las cuentas.
- **Dónde existe:** solo en la demo. En la base de la barbería ese bloque no aparece, y aunque alguien llamara la acción, la base se niega: tiene que llamarse `villa_demo`, la sesión tiene que ser superusuario y no puede tener respaldos registrados.
- **Para volver a tener el mes de datos,** vuelve al paso 2; tendrás que crear de nuevo la cuenta del dueño.

Qué hace cada pantalla y desde dónde se hace cada cosa: [guia-de-estudio.md](guia-de-estudio.md).

## 2. Qué trae la demo

- **El catálogo real** de la barbería (12 servicios con su precio y duración), 9 productos capilares de prueba (ceras, pomada, gel, shampoos, acondicionador, tónico y la línea de barba) y el equipo:
  - Sin más archivos salen **10 barberos con nombres inventados**: los nombres del equipo real son datos personales (Ley 1581) y no van al repositorio.
  - Si en este computador existe `seed-demo.equipo.local.json`, salen los reales (ver `src/db/seed-demo.ts`). Ese archivo no se sube nunca.
  - Además aparece la columna **"Barbero de prueba"**, sin citas: es la cuenta `barbero@villa.test`. La historia no le asigna citas, así que su vista sale vacía. Para mostrar lo que ve un barbero en su celular, haz en vivo un walk-in con él y cóbralo. Si el dueño pregunta: es la cuenta de pruebas, y el script que la crea se niega a correr en producción.
- **30 días de operación:**
  - citas y clientes que llegan sin cita;
  - viernes y sábados más llenos;
  - unos pocos clientes que no llegaron;
  - propinas, pagos en efectivo, Nequi, tarjeta y transferencia, a veces combinados;
  - algún producto vendido;
  - gastos pequeños de la caja.
- **Cada día de caja completo:** apertura, propinas pagadas en efectivo, consignación de lo que pasa de $200.000 y cierre del día. Tres cierres tienen diferencia (dos faltantes y un sobrante) y quedan por revisar.
- **Hoy:** la caja abierta, citas atendidas y cobradas, alguien en la silla, citas por llegar y las de mañana. Hay una **anulación pedida** por recepción ("Se cobró dos veces el mismo corte").
- **Recibos con servicios y productos juntos:** a veces cejas además del corte, y uno o dos productos capilares.
- **Por cobrar:** una cita de hoy atendida y sin cobrar (Caja → Por cobrar) y dos **anticipos a barberos** (Comisiones), que se descuentan en la liquidación.
- **Por pagar:**
  - **cuatro compras a crédito** a proveedores inventados (Productos → Cuentas por pagar): una pagada del banco, una vencida con un abono de la caja, una que vence en unos días y una al día;
  - **gastos fijos:** los del mes anterior, pagados; el arriendo y el internet de este mes, por pagar (Inicio y Gastos fijos);
  - las **comisiones** del mes.
- **Una compra de contado** desde la caja, hecha por recepción.
- **140 clientes inventados, sin celular ni correo.** Nunca se les envía nada. Para mostrar el recibo por WhatsApp, cobra a un cliente nuevo con tu propio número.
- **Quién hizo qué:**
  - la operación diaria la hizo la cuenta de recepción;
  - lo que solo puede hacer un dueño (compras a crédito, pagos del banco, anticipos y gastos fijos) lo hizo **"Administración de prueba"**, una cuenta sin contraseña que no puede entrar.
  - Así nada en la bitácora queda a nombre de tu cuenta.
  - Liquidar comisiones, aprobar la anulación y revisar los cierres con diferencia se hacen en vivo (ver el guion).

**Cómo se generó:** con las mismas funciones de la app y las mismas reglas de la base (cada asiento cuadra al guardarse). Lo único que se ajusta después son las horas que pone la base, que se corren a la fecha simulada. Por eso exige su propio PostgreSQL con superusuario (`src/scripts/demo-history.ts`).

## 3. Guion (35 a 45 minutos)

La idea: la portada abre la conversación, pero lo que diferencia al sistema de Weibook es **que las cuentas siempre cuadran**. Dedica la mayor parte del tiempo a la caja, el cierre y la liquidación.

### 3.1. La vitrina (3 min, en el celular)

- Portada: "Abierto ahora", lo más pedido (sale de las citas reales del último mes, no de una lista fija), el equipo y "Así reservas".
- Haz una reserva desde el celular. En la demo no hay WhatsApp, así que el código sale en pantalla. En producción llega por WhatsApp.
- Mensaje: el cliente reserva sin descargar nada y sin que la barbería dependa de otra plataforma.

### 3.2. La agenda de hoy (5 min, como recepción)

- Agenda por columnas, un barbero por columna, con quién está en la silla y quién llega.
- La reserva que acabas de hacer ya aparece.
- **Walk-in:** el sistema propone al barbero libre por tiempo, sin que nadie tenga que mirar la agenda.

### 3.3. Cobrar (5 min, como recepción)

- Cobra a quien está en la silla:
  - **pago combinado** (parte en efectivo y parte por Nequi);
  - **propina aparte** para el barbero;
  - agrega un producto.
- Muestra el **recibo** (tirilla de 58/80 mm o A4) y el envío por WhatsApp. Usa tu número.
- Recepción **no ve cuánto debería haber en la caja**: cuenta a ciegas. Así nadie "cuadra" el conteo con el número.

### 3.4. Lo que ve el dueño al entrar (5 min, como dueño)

- **Inicio** muestra solo lo que pide atención:
  - los cierres con diferencia por revisar;
  - la anulación pedida;
  - la cuenta por pagar vencida y la que vence pronto;
  - el arriendo y el internet vencidos sin registrar;
  - el último respaldo y lo que hace falta.
- **Aprueba la anulación.** Nada se borra: queda un asiento de reversa con motivo, quién lo pidió y quién lo aprobó. Ábrela en la bitácora.
- **Revisa un cierre con diferencia** en Caja → Historial: el esperado, lo contado, la diferencia y la nota de quien cerró.

### 3.5. La liquidación de un barbero (7 min, como dueño)

Es el momento clave.

- En Comisiones, cada barbero tiene lo que se le debe del mes (50% de cada servicio) y las propinas, que ya se pagaron cada noche.
- Elige uno: la **vista previa** muestra servicio por servicio, con fecha y cliente. Liquida y abre el **comprobante**.
- Mensaje: "cada peso que se le paga al barbero sale de un cobro registrado; nadie hace la cuenta a mano".
- Si quiere, da un **anticipo** y muestra cómo se descuenta en la siguiente liquidación.

### 3.6. Informes (5 min, como dueño)

- Ventas del mes por día, por barbero, por servicio y por medio de pago, y la tasa de "no vino".
- **La utilidad:** ingresos menos comisiones y gastos. Advierte que el arriendo de este mes todavía no está registrado, así que la utilidad sale inflada. Regístralo en vivo (3.7).
- Exportar a Excel (CSV) para el contador.

### 3.7. Gastos, productos y proveedores (5 min, como dueño)

- **Gastos fijos:** el arriendo de este mes ya aparece vencido. Regístralo pagado del banco y muestra cómo baja la utilidad en Informes.
- **Productos:** existencias, margen y las **cuentas por pagar**:
  - la vencida con su abono, la que vence en unos días y la pagada;
  - abona a la vencida desde el banco;
  - registra en vivo una compra nueva a crédito, a 30 días.

### 3.8. Seguridad y continuidad (2 min)

- El dueño entra con código de verificación; toda acción sensible queda en la bitácora.
- Respaldo diario con prueba de restauración (el mismo chequeo de cordura con que se armó esta demo).

## 4. Preguntas difíciles

| Pregunta | Respuesta honesta |
|---|---|
| **¿Hace factura electrónica?** | **No, hoy no.** Weibook la incluye. Si Villa la necesita (lo define el contador), se conecta con un proveedor como Alegra o Siigo, con su costo aparte. Es lo primero que hay que aclarar. |
| **¿Y el IVA?** | Se define con el contador al configurar la app en la barbería, y una vez guardado no se cambia desde la app. Si Villa es responsable de IVA, se activa en cobros, compras y productos. |
| **¿Cuánto cuesta frente a Weibook?** | El servidor sale entre 10 y 45 dólares al mes, contra $104.000–$126.000 al mes del plan Ultra de Weibook (que está justo en su tope de 10 profesionales). Hay que sumar el mantenimiento y, si hace falta, la factura electrónica. |
| **¿Y si usted desaparece?** | El código, la documentación y los datos quedan a nombre de Villa, en su propio servidor y con respaldos diarios. Está hecho con herramientas comunes (TypeScript, PostgreSQL), y cualquier desarrollador puede retomarlo con la documentación del repositorio. |
| **¿Funciona sin internet?** | No: es una aplicación web. Si se cae el internet del local, se puede seguir desde el celular con datos. |
| **¿Cómo pasamos de Weibook?** | Primero un mes con los dos sistemas en paralelo. El enlace de reservas se cambia cuando el equipo ya esté cómodo. |
| **¿Los recordatorios por WhatsApp?** | Necesitan que Meta verifique el negocio (tarda días o semanas) y cada mensaje tiene un costo pequeño. Hay que iniciar ese trámite pronto. |

## 5. Lo que no se debe prometer

- Que habrá menos inasistencias o más ventas: no se ha medido.
- Que reemplaza a Weibook desde el primer día: mejor correr los dos en paralelo un mes.
- Soporte 24/7.
- Que las fotos de la portada son del local: son de referencia (lo dice la marca "Foto de referencia"). Se reemplazan por fotos reales con autorización de quien salga.
