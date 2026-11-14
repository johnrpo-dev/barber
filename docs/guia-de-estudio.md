# Guía de estudio de Villa

Qué hace cada parte del sistema, quién la usa y desde dónde se hace. Sirve para aprenderse la app antes de presentarla. Para practicar con datos, arma la demo ([demo.md](demo.md)); el guion de la presentación también está ahí.

**Cómo leer cada ítem:**
- **Quién:** dueño, recepción o barbero.
- **Dónde:** la pantalla y el botón.
- **Qué pasa por dentro:** lo que el sistema registra, sobre todo en la contabilidad.

En el celular, las pantallas que no caben en la barra de abajo están en **Más**.

## 1. Los tres roles y cómo se entra

| Rol | Qué ve en el menú | Cómo entra |
|---|---|---|
| **Dueño** | Inicio, Agenda, Caja, Ventas, Anulaciones, Comisiones, Informes, Bloqueos, Servicios, Productos, Personal, Gastos fijos, Ajustes, Auditoría, Clientes | `/ingresar` con correo y contraseña, **más el código de 6 dígitos** de su app de autenticación (obligatorio) |
| **Recepción** | Agenda, Caja, Ventas, Anulaciones, Bloqueos, Clientes | `/ingresar` con correo y contraseña |
| **Barbero** | Mi día, Agenda (solo la suya), Mis comisiones, Bloqueos (solo los suyos) | `/ingresar` con correo y contraseña |

- Las cuentas de recepción y de barberos las crea el dueño en **Personal**, con una contraseña temporal. La persona la cambia al entrar por primera vez.
- **Mi cuenta** (el nombre abajo en el menú, o `/cuenta`): cambiar la contraseña, configurar el código de verificación y cerrar las sesiones abiertas en otros equipos.
- Para las acciones delicadas (anular una venta, pagar desde el banco, suprimir un cliente, cambiar reglas), el sistema vuelve a pedir la contraseña y el código si no se confirmaron hace poco.

## 2. Mapa rápido

| Pantalla | Quién | Para qué sirve |
|---|---|---|
| Portada `/` | Clientes | Vitrina: abierto o cerrado, lo más pedido, equipo, cómo reservar |
| Reservar `/reservar` | Clientes | Elegir servicio, barbero y hora, y confirmar con código |
| Mi cita (enlace del mensaje) | Clientes | Ver, cancelar o mover su cita |
| **Inicio** | Dueño | Lo que pide atención hoy: alertas, ventas del día, efectivo, utilidad del mes, respaldos |
| **Mi día** | Barbero | Sus citas de hoy y lo que lleva |
| **Agenda** | Dueño, recepción y barbero (el suyo) | Citas por barbero, walk-in, nueva cita, estados, "Salió / Llegó" |
| **Caja** | Dueño y recepción | Cobrar, abrir y cerrar caja, gastos, compras de contado, propinas, consignaciones, pagos a proveedores |
| **Ventas** | Dueño y recepción | Ventas de hoy, historial y recibos para reimprimir o enviar |
| **Anulaciones** | Recepción pide; dueño aprueba | Deshacer una venta con motivo, sin borrar nada |
| **Comisiones** | Dueño | Lo que se le debe a cada barbero, liquidaciones, anticipos y comprobantes |
| **Mis comisiones** | Barbero | Lo suyo: ganado, pagado y pendiente |
| **Informes** | Dueño | Estado de resultados y análisis del negocio; exporta a CSV |
| **Bloqueos** | Todos (el barbero solo los suyos) | Ausencias, almuerzos especiales, cerrar la sede un día |
| **Servicios** | Dueño | Catálogo: precio, duración, comisión y si se ofrece en línea |
| **Productos** | Dueño | Catálogo de productos, compras, conteo de inventario y **cuentas por pagar** |
| **Personal** | Dueño | Equipo, roles, horarios, servicios que hace cada uno y accesos |
| **Gastos fijos** | Dueño | Arriendo, servicios e internet: plantillas y avisos de vencimiento |
| **Ajustes** | Dueño | Reglas de la reserva en línea, reglas de cobro, medios de pago y categorías de gasto |
| **Auditoría** | Dueño | Bitácora: quién hizo qué y cuándo |
| **Clientes** | Dueño y recepción | Ficha del cliente, historial y datos personales (Ley 1581) |

## 3. Las citas

### 3.1 Reserva en línea (el cliente)
- **Dónde:** la portada, botón **Reservar** (`/reservar`).
- **Pasos:**
  1. Elige el servicio, el barbero ("cualquiera" vale) y un turno libre.
  2. Escribe su nombre y su celular.
  3. Confirma con el código que le llega por WhatsApp. En desarrollo y en la demo, el código sale en pantalla.
  4. Si ya reservó antes **desde ese mismo celular**, no le pide código.
- **Reglas** (dueño → **Ajustes → Reserva en línea**):
  - cada cuántos minutos se ofrecen turnos;
  - con cuánta anticipación mínima y hasta cuántos días adelante se puede reservar;
  - cuántas citas activas puede tener un cliente;
  - hasta cuándo puede cancelar sin penalidad.
- **Quién atiende en línea:** **Ajustes**, sección de quién atiende en línea. Un barbero puede no aparecer en la web y aun así tener citas en la agenda.
- **El cliente cancela o mueve su cita** desde el enlace "Mi cita" que recibe.

### 3.2 La agenda
- **Quién:**
  - dueño y recepción ven a todos;
  - el barbero ve solo su columna.
- **Dónde:** **Agenda**, con una columna por barbero y la línea de la hora actual.
- **Lo que se hace ahí:**
  - **Nueva cita:** servicio, barbero, hora y cliente (búscalo por nombre o celular, o créalo).
  - **Cambiar el estado** tocando la cita: llegó → en la silla → atendida, o "no vino" y cancelada. Cada cambio queda en el historial de la cita.
  - **Walk-in** (cliente sin cita): eliges el servicio y el sistema propone al barbero libre, explicando por qué los demás no alcanzan (por ejemplo, "Libre, pero no alcanza antes de la que sigue"). **Empezar ahora** lo sienta de una vez.
  - **Salió / Llegó:** quien sale a una diligencia queda fuera de la fila del walk-in hasta que vuelve, y al volver entra de último. No le quita sus citas.
  - **Cobrar:** desde la cita atendida o en la silla (ver §4).

### 3.3 Bloqueos, ausencias y cierres
- **Dónde:** **Bloqueos.**
  - El barbero bloquea su propio tiempo.
  - Dueño y recepción, el de cualquiera.
  - **Cerrar la sede** marca un día festivo o cualquier cierre: nadie puede reservar en ese lapso.
- **Horario semanal** de cada persona: **Personal → la persona.**

## 4. El cobro (el corazón contable)

### 4.1 Cobrar
- **Quién:** dueño y recepción.
- **Dónde:**
  - **Caja → Cobrar**, en la lista "Por cobrar": las citas atendidas o en la silla que aún no se cobran;
  - **Caja → Nuevo cobro**, para un walk-in o una venta de mostrador;
  - desde la cita, en **Agenda**.
- **Qué se puede poner en un cobro:**
  - **Servicios**, más los extras (por ejemplo, cejas además del corte), cada uno con su barbero.
  - **Productos** (cera, shampoo, tónico…) y quién los vendió.
  - **Propina** para el barbero, aparte del precio.
  - **Descuento** con motivo: solo el dueño, o recepción si el dueño lo habilita en **Ajustes → Reglas de cobro**. Tiene un tope.
  - **Pago:** efectivo, Nequi/Daviplata, tarjeta o transferencia, **o combinado** (parte y parte). En efectivo calcula las vueltas.
- **Qué pasa por dentro, todo en una sola transacción:**
  - se crea la venta con su número de recibo;
  - se registra el asiento contable: entra el dinero a Caja (1105) o a Bancos (1110), y sale el ingreso por servicios (4170) o por productos (4135);
  - se registra la comisión del barbero como gasto y deuda (5105 contra 2335), y la propina como deuda con él (2380).
  - Si algo falla, no queda nada a medias. Repetir el mismo cobro por error no lo duplica (clave de idempotencia).
- **Recibo:**
  - **al cobrar**, si la venta tiene cliente, se elige enviarlo por WhatsApp o por correo; también se puede copiar el texto y pegarlo en WhatsApp;
  - después, en **Ventas → la venta**, se reimprime en tirilla de 58/80 mm o en A4;
  - **no es factura electrónica** (ver §11).

### 4.2 Anular una venta
- **Recepción pide:** **Caja → Cobros de hoy → Pedir anulación**, con motivo (o desde **Anulaciones**).
- **El dueño aprueba o rechaza:** **Anulaciones**. También le llega como alerta en **Inicio**.
- **Qué pasa por dentro:** **nada se borra**. Se crea un **asiento de reversa** que deja la venta en cero, con quién la pidió, quién la aprobó y por qué. Las comisiones de esa venta se descuentan en la siguiente liquidación.

### 4.3 Cortesías
- **Dónde:** **Caja → Por cobrar**, botón **Cortesía** junto a la cita.
- Un servicio que no se cobra (por ejemplo, para compensar un error):
  - sale de "Por cobrar";
  - queda registrado con motivo;
  - aparece en **Informes → Cortesías** y como alerta en **Inicio**.

## 5. La caja del día

**Quién:** dueño y recepción. **Dónde:** **Caja.**

| Momento | Qué se hace | Detalle |
|---|---|---|
| **Abrir caja** | Contar el efectivo con que se empieza | Lo normal es la base que quedó la noche anterior |
| **Durante el día** | **Registrar gasto** (insumos, aseo, café…) | Sale de la caja con su categoría |
| | **Compra de mercancía** de contado | Productos pagados con efectivo de la caja |
| | **Pago a proveedor** desde la caja | Abono a una compra a crédito |
| | **Registrar gasto fijo** que se paga en efectivo | Si la plantilla dice "de la caja" |
| **Al final** | **Pagar propinas** | Se le entrega a cada barbero su propina en efectivo |
| | **Consignar** | Lo que pasa de la base se lleva al banco |
| | **Cerrar caja** | **Conteo a ciegas** (ver abajo) |
| | **Cerrar el día** | Después de cerrar la caja. Ese día ya no admite cobros ni movimientos |

- **Conteo a ciegas:**
  - recepción **no ve cuánto debería haber** mientras cuenta; el esperado aparece solo después de contar, para que nadie acomode el conteo al número;
  - si hay diferencia, se escribe una nota;
  - el dueño la ve en **Inicio** ("Un turno de caja por revisar") y en **Caja → Historial**.
- **Otros medios del día:** Nequi, tarjeta y transferencia se muestran aparte; no se cuentan en la caja.
- **Reabrir el día:**
  - el dueño puede reabrir cualquier día cerrado;
  - recepción solo puede reabrir **hoy**, para no parar la operación.
- **Historial de caja:** **Caja → Historial**, con cada turno: apertura, movimientos, esperado, contado, diferencia y nota.

## 6. Comisiones, propinas y anticipos

| Qué | Quién | Dónde | Qué pasa |
|---|---|---|---|
| **Ver lo que se debe** a cada barbero | Dueño | **Comisiones** | Comisión del periodo (el % de cada servicio y producto), propinas y anticipos |
| **Liquidar** | Dueño | **Comisiones → el barbero → Liquidar** | La vista previa muestra servicio por servicio, con fecha y cliente. Se paga de la caja o del banco y se genera el **comprobante** |
| **Dar anticipo** | Dueño | **Comisiones → Dar anticipo** | Queda como **cuenta por cobrar al trabajador (1365)** y se descuenta solo en la siguiente liquidación |
| **Revertir** una liquidación o un anticipo | Dueño | **Comisiones**, sobre el movimiento | Asiento de reversa con motivo; nada se borra |
| **Ver lo suyo** | Barbero | **Mis comisiones** | Lo ganado, lo pagado, lo pendiente y sus comprobantes |
| **Comprobantes** | Dueño y el barbero dueño del comprobante | El enlace del comprobante | Para imprimir o compartir |

La comisión de cada servicio se fija en **Servicios** y la de cada producto, en **Productos**.

## 7. Cuentas por cobrar y por pagar

### Por cobrar
- **Citas atendidas sin cobrar:**
  - **Dónde:** **Caja → Por cobrar** (también en la agenda).
  - No es una deuda contable: es lo que falta pasar por caja hoy.
- **Anticipos a barberos (1365):**
  - **Dónde:** **Comisiones**, en el saldo de cada uno.
  - Se recupera solo al liquidar.
- **Fiado a clientes:** la app **no lo maneja**. En una barbería casi no se usa. Si se necesita, se construye como funcionalidad aparte.

### Por pagar
- **Proveedores (2205):**
  - **Dónde:** **Productos → Cuentas por pagar**.
  - **Cómo nace la deuda:** se registra la compra en **Productos → Registrar compra → A crédito**, con proveedor y plazo (por defecto 30 días).
  - **Cada compra muestra** "Vencida hace N días", "Vence en N días" o "Pagada", más los abonos.
  - **Abonar:**
    - desde **Productos**, del banco o del bolsillo del dueño;
    - desde **Caja → Pago a proveedor**, en efectivo.
  - **Anular un pago** hecho por error: con motivo y asiento de reversa.
  - **Alertas en Inicio:** "Una cuenta por pagar vencida" o "vence".
- **Gastos fijos:**
  - **Dónde:** **Gastos fijos.**
  - Cada plantilla (arriendo, servicios, internet) dice cuánto, qué día del mes y si se paga de la caja o del banco.
  - Cuando vence aparece "Un gasto fijo vencido sin registrar" en **Inicio**, y se registra con el monto real.
  - Se puede **omitir un periodo** con motivo.
- **Comisiones por pagar (2335) y propinas por pagar (2380):** en **Comisiones**.

## 8. Productos e inventario

- **Quién:**
  - el dueño hace todo;
  - recepción solo registra **compras de contado** desde **Caja**.
- **Dónde:** **Productos.**
- **Catálogo:** nombre, referencia, precio de venta y comisión del vendedor. Desactivar no borra el historial.
- **Registrar compra:**
  - **de contado desde la caja**, también desde **Caja → Compra de mercancía**;
  - **del banco**;
  - **a crédito**, con proveedor y plazo;
  - **carga inicial**, lo que ya había al empezar a usar la app.
- **Contar inventario:**
  - a fin de mes se cuenta lo que hay; **Inicio** lo recuerda el último día;
  - el conteo valora cada producto al costo de su última compra, registra la diferencia como **costo de lo vendido y lo perdido** (6135) y deja el inventario (1435) igual a lo contado.
  - Vender un producto no descuenta el inventario uno a uno: el costo llega con el conteo del mes (inventario periódico).
- **Anular una compra** hecha por error: con motivo y asiento de reversa.

## 9. Informes

- **Quién:** dueño. **Dónde:** **Informes**, eligiendo el periodo.
- **Qué hay:**
  - **Estado de resultados:** ingresos menos comisiones, costo de productos y gastos = utilidad.
  - **Ventas por barbero** y **por servicio.**
  - **Medios de pago.**
  - **Propinas.**
  - **Gastos por categoría.**
  - **Diferencias de caja.**
  - **Costo del datáfono.**
  - **Liquidaciones.**
  - **Cortesías.**
  - **Inasistencias** ("no vino").
- **Exportar a CSV** (se abre en Excel) para el contador.
- Las sumas se hacen en la base de datos, no en el navegador: lo que dice el informe es lo que dice el libro.

## 10. Equipo, clientes, ajustes y auditoría

| Qué | Quién | Dónde |
|---|---|---|
| Agregar persona, cambiar rol, desactivar | Dueño | **Personal** |
| Horario semanal y servicios que hace cada uno | Dueño | **Personal → la persona** |
| Contraseña temporal y cerrar sus sesiones | Dueño | **Personal → la persona** |
| Precio, duración, comisión y si se ofrece en línea | Dueño | **Servicios** |
| Reglas de la reserva en línea, teléfono, dirección y mapa | Dueño | **Ajustes** |
| Reglas de cobro (descuentos, tope, propinas y datáfono, umbral de revisión de caja, pie del recibo) | Dueño | **Ajustes → Reglas de cobro** |
| Medios de pago y categorías de gasto | Dueño | **Ajustes** |
| Ficha del cliente: historial, faltas, autorizaciones | Dueño y recepción | **Clientes** |
| Desbloquear la reserva en línea de un cliente con muchas faltas | Dueño y recepción | **Clientes → la ficha** |
| Suprimir los datos de un cliente que lo pide (Ley 1581) | Dueño | **Clientes → la ficha → Suprimir** (escribiendo SUPRIMIR) |
| Bitácora: quién hizo qué | Dueño | **Auditoría**, con filtro por categoría |

Al suprimir un cliente, sus ventas y asientos se conservan a nombre de "Anónimo", porque los soportes contables se guardan 10 años.

## 11. Lo que la app no hace (todavía)

- **Factura electrónica:** no. El recibo no la reemplaza. Si Villa la necesita, se conecta con un proveedor (Alegra, Siigo) y su costo va aparte.
- **IVA:** se define con el contador al configurar la app en la barbería, y una vez guardado no se cambia desde la app ([revision-contable.md](revision-contable.md)).
- **Fiado a clientes:** no (ver §7).
- **Funcionar sin internet:** no. Es una app web; sin internet en el local, se usa el celular con datos.
- **Recordatorios por WhatsApp:** necesitan que Meta verifique el negocio.

## 12. Seguridad y respaldos

- El dueño entra siempre con contraseña y código. Las acciones delicadas lo vuelven a pedir.
- **Nada contable se borra:**
  - el libro es solo-inserción;
  - los errores se corrigen con asientos de reversa;
  - cada asiento cuadra (débitos = créditos), y la base de datos se niega a guardar uno que no cuadre.
- **Respaldo diario** con prueba de restauración: **Inicio** muestra el último respaldo y avisa si alguno falló.

## 13. La demo: practicar, borrar y volver a empezar

| Quiero… | Cómo | Dónde |
|---|---|---|
| **Armar la demo con un mes de datos** | `npm run demo:setup` (unos 10 minutos) | Terminal, en el computador |
| Crear mi cuenta de dueño en la demo | `npm run demo:owner` | Terminal |
| Abrir la app de la demo | `npm run demo` y luego http://localhost:3000 | Terminal y navegador |
| **Borrar todo y practicar desde el primer día** | **Ajustes → Demo: empezar de cero → Borrar todos los registros**, escribiendo BORRAR y con tu código | App, como dueño |
| Volver a tener el mes de datos | `npm run demo:setup` de nuevo (pide crear otra vez la cuenta del dueño) | Terminal |

**Qué trae la demo:**
- **Clientes agendados** hoy y mañana, con su hora.
- **Un mes de cobros,** con servicios, cejas de más y **productos capilares** en el mismo recibo.
- **Una cita atendida sin cobrar** en **Caja → Por cobrar**.
- **Cuatro compras a crédito,** en **Productos → Cuentas por pagar**:
  - una pagada;
  - una vencida, con un abono;
  - una que vence en unos días;
  - una al día.
- **Dos anticipos a barberos,** por cobrar en **Comisiones**.
- **Gastos fijos:** los del mes anterior, pagados; el arriendo y el internet de este mes, por pagar.
- **Tres cierres de caja con diferencia** y **una anulación pedida.**

**El botón de borrado:**
- Solo existe en la demo; en la base real de la barbería no aparece.
- **Borra:** citas, clientes, ventas, caja, libro, compras, proveedores, anticipos, liquidaciones y bitácora.
- **Conserva:** la sede, los servicios, los productos (sin existencias), el personal, las cuentas de acceso, los medios de pago y las plantillas de gastos fijos.

Lo que solo puede hacer un dueño en la historia de la demo lo hizo "Administración de prueba": una cuenta sin contraseña, que no puede entrar. Así nada queda a tu nombre en la bitácora.

## 14. Ejercicios para practicar (en la demo)

1. Como recepción, cobra a quien está **por cobrar**:
   - pago combinado (efectivo y Nequi);
   - un producto;
   - propina.
2. Abre el recibo y revisa que cuadre.
3. Haz un **walk-in** y lee por qué el sistema propone a ese barbero.
4. Marca que un barbero **salió**, haz otro walk-in y comprueba que no lo propone; márcalo **llegó**.
5. Como dueño, **aprueba la anulación** pendiente y búscala en **Auditoría**.
6. Revisa un **cierre con diferencia** en **Caja → Historial**.
7. En **Productos → Cuentas por pagar**, **abona** a la compra vencida desde el banco y mira cómo baja la deuda.
8. Registra el **arriendo** pendiente en **Gastos fijos** y mira cómo cambia la utilidad en **Informes**.
9. **Liquida** a un barbero que tenga anticipo y verifica en el comprobante que se descontó.
10. Cierra la caja como recepción (conteo a ciegas), consigna lo que sobra de la base y **cierra el día**.
11. Cuando termines: **Ajustes → Borrar todos los registros**, y opera un día completo desde cero (abrir caja, agendar, cobrar, cerrar).
