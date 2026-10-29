# Sprint 3: diseño del portal público

Especificación del diseñador (29 de octubre de 2026). La arquitectura está en [sprint-3-reserva-publica.md](sprint-3-reserva-publica.md).

Reglas de color:

- Solo tokens existentes.
- El latón es solo decoración: reglas, perforación y la banda del talón.
- El texto más claro es `tinta/70`.

Tono: español de Colombia, de "tú", cálido.

## 0. Base compartida

- **Grupo de rutas `src/app/(publico)/`.** Su `layout.tsx` lleva:
  - `PortalHeader`: "Villa" en Fraunces, regla de latón de 2 px y un `Btn size="sm"` "Reservar";
  - `PortalFooter`: dirección, Privacidad y un enlace pequeño "Personal" a `/ingresar`.
- **Piezas compartidas a `src/app/_ui/`:** `Btn`, `field`, `Sheet`, `cx` y `ToastProvider`. El panel también las importa de ahí.
- **`SlotGroups`:** el `RadioGroup` Mañana/Tarde/Noche sale de `slot-picker.tsx` y lo usan el panel y el portal. El portal tiene su propia acción pública de horarios.
- **Componentes nuevos:**
  - `DayStrip`
  - `HoldTimer`
  - `OtpField`
  - `Ticket`
  - `ErrorSummary`
  - `StepHeading`
  - `BottomBar`
- **Anchos:**
  - 360 px: una columna, `px-4`.
  - `md`: `max-w-2xl mx-auto`.
  - `lg`: `max-w-6xl`, con dos columnas donde se indica.

## 1. Inicio `/`

Server Component con `revalidate: 300` y sin JS de cliente, salvo la barra fija.

**Hero:**

- Antetítulo: "Barbería de barrio · {Barrio}, {Ciudad}". Clases: `text-xs font-semibold uppercase tracking-[0.2em] text-botella`.
- H1: "Corte fino, sin afán." Clases: `font-display text-5xl leading-[1.05] md:text-6xl lg:text-7xl`.
- Subtítulo: "Reserva en un minuto. Te confirmamos por WhatsApp."
- Regla de latón: `h-px w-16 bg-laton`.
- Botones: "Reservar" (`xl`) y "Escríbenos" (secundario, enlace `wa.me`).
- `NextSlotChip`: "Hoy hay turno desde las 3:30 p. m." Clases: `rounded-full bg-botella/10 text-botella`. No se muestra si no hay datos.

**La carta (servicios):**

- Lista de enlaces a `/reservar?servicio={id público}`.
- Cada fila: nombre, una línea punteada de latón (`border-b-2 border-dotted border-laton/60`, `aria-hidden`), el precio en `monto` y la duración en `text-sm text-tinta/70`.
- Dos columnas desde `md`.

**Barberos:**

- Tarjetas que enlazan a `/reservar?barbero=…`.
- Avatar `h-14 w-14 rounded-full bg-botella text-hueso` con iniciales.
- Desplazamiento horizontal con `snap-x` en móvil; 3 columnas en `md` y 4 en `lg`.

**Horario y ubicación:**

- Una `<dl>` con los 7 días; la fila de hoy va resaltada.
- Estado: "Abierto ahora · cierra a las 8:00 p. m." en botella, o "Cerrado · abre mañana a las 9:00 a. m.".
- Botones "Cómo llegar" y "WhatsApp". Sin mapa embebido.

**Barra fija (solo móvil):** `fixed inset-x-0 bottom-0 md:hidden bg-papel/95 backdrop-blur border-t pb-[max(.75rem,env(safe-area-inset-bottom))]`. Aparece con "Reservar" cuando el hero sale de pantalla.

**En `lg`:** el hero va a 2 columnas, con un ticket de muestra decorativo (`aria-hidden`) a la derecha.

## 2. Flujo `/reservar`

**Estructura:**

```
ReservarPage (servidor: servicios, personal, reglas)
└ BookingFlow (cliente)
  ├ StepProgress  ol[aria-label="Pasos"]: Servicio · Barbero · Hora · Datos · Código
  ├ SummaryChips  botones "Cambiar: …"
  ├ HoldTimer     desde "Enviar código" hasta confirmar
  ├ StepHeading   h2[tabIndex=-1], recibe el foco en cada paso
  ├ Paso actual   ServiceStep | StaffStep | TimeStep (DayStrip + estado + SlotGroups) | DetailsStep | OtpStep | TicketStep
  └ BottomBar     fija en móvil: resumen + "Continuar"
```

- "Cualquiera" va primero, con la pista "El primero que esté libre".
- `?servicio=` o `?barbero=` en la URL saltan su paso.
- En `lg` hay 2 columnas; a la derecha, un ticket "borrador" fijo que se va llenando.

### DayStrip

Es un RadioGroup horizontal con `aria-label="Día"`.

- **Contenedor:** `flex gap-2 overflow-x-auto snap-x snap-mandatory -mx-4 px-4 [scrollbar-width:none] motion-safe:scroll-smooth md:mx-0 md:grid md:grid-cols-7 md:px-0`.
- **Ficha de día:** `snap-start shrink-0 w-[3.75rem] h-[4.75rem] rounded-xl border`.
  - Sin elegir: `border-tinta/15 bg-papel`.
  - Elegida: `border-cuero bg-cuero text-hueso`.
  - Sin horarios: `border-dashed text-tinta/70`, deshabilitada.
- **Contenido de la ficha:** el día de la semana ("JUE" o "HOY"), el número en `font-display text-2xl` y "Lleno" o "Cerrado" cuando aplica.
- **Nombre accesible:** "jueves 30 de octubre, 8 horarios" o "…, sin horarios".
- El nombre del mes aparece encima cuando cambia dentro de la tira.
- Arranca en el primer día con horarios. Los conteos salen de una sola consulta de 14 días.

**Anuncio del conteo:** `<p role="status">` con "8 horarios disponibles el jueves 30 de octubre" o "Cargando horarios…". Cada grupo lleva `aria-label`, por ejemplo "Tarde, 5 horarios".

### Datos

Formulario de react-aria con `validationBehavior="aria"`.

- **Nombre:** `autoComplete="name"`.
- **Celular:**
  - Prefijo visual "+57", `aria-hidden`.
  - Input `type="tel" inputMode="numeric" autoComplete="tel-national"`.
  - Ayuda: "Celular de 10 dígitos (+57). Ahí te llega el código por WhatsApp."
  - Se formatea como "300 123 4567" al salir del campo.
- **Correo:** "Correo (opcional)", `autoComplete="email"`.
- **Casillas, todas sin marcar,** dentro de un `fieldset`:
  - Obligatoria: "Autorizo a Villa a tratar mis datos para gestionar mi cita." (`data_processing`).
  - Opcional: "Quiero recordatorios de mi cita por WhatsApp o correo."
  - Opcional: "Quiero recibir promociones y novedades de Villa."
  - Nota debajo: "Puedes cambiar esto cuando quieras. Lee nuestra política de privacidad."
- **Botón:** "Enviar código". Corre Turnstile invisible, crea la retención y arranca el `HoldTimer`.

### HoldTimer

- Clases: `sticky top-0 z-10 rounded-xl bg-botella px-4 py-2.5 text-hueso`.
- Texto: "Te guardamos el horario **9:41**". El reloj va en `role="timer" aria-live="off"`.
- Un `role="status"` oculto anuncia solo a los 5, 2 y 1 minutos.
- Con menos de 2 minutos cambia a `bg-alerta`.
- Manda el `expires_at` del servidor.

### OtpField

Un solo input, no seis cajas (mejor para autocompletar, pegar y lectores de pantalla):

```
<Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6}
  className="monto h-16 w-full max-w-[16rem] rounded-xl border-2 border-tinta/50 bg-papel text-center font-display text-4xl tracking-[0.5em] indent-[0.5em] focus:border-cuero data-[invalid]:border-alerta" />
```

- Etiqueta: "Código de 6 dígitos". Ayuda: "Lo enviamos por WhatsApp al +57 300 123 4567."
- Se envía solo al completar 6 dígitos.
- "Reenviar código en 0:45": queda deshabilitado mientras corre la cuenta.
- "Cambiar número": vuelve a Datos sin perder lo escrito.

### Ticket de turno (la pieza memorable)

```
<article aria-labelledby="ticket-h" className="relative mx-auto w-full max-w-[22rem] rounded-2xl bg-papel shadow-…
  [--tear:6.5rem]
  [mask:radial-gradient(circle_at_0_var(--tear),#0000_12px,#000_12.5px)_0_0/51%_100%_no-repeat,radial-gradient(circle_at_100%_var(--tear),#0000_12px,#000_12.5px)_100%_0/51%_100%_no-repeat]">
  <header className="h-[var(--tear)] px-6 pt-5">  talón: "Turno" + código "V-4K7Q" </header>
  <div aria-hidden className="mx-5 h-1 bg-[radial-gradient(circle,var(--color-laton)_1.5px,transparent_2px)] bg-[length:10px_4px] bg-repeat-x" />
  <div className="px-6 pb-6 pt-5"> hora grande · fecha · dl (servicio, barbero, duración, valor, dónde) · sello </div>
</article>
```

- **Muescas:** las dos capas de máscara al 51 % cortan una muesca a cada lado sin `mask-composite`. Verificar `-webkit-mask` en Safari.
- **Sellos** (`rotate-[-6deg] border-2 uppercase`):
  - "Confirmada": botella.
  - "Por confirmar": `tinta/50` con texto `tinta/70`.
  - "Cancelada": alerta, con el ticket a `opacity-75`.
- **Debajo del ticket:**
  - "Agregar al calendario": un .ics con `VALARM` 1 h antes y el enlace de gestión en la descripción.
  - "Cómo llegar".
  - "Reprogramar" y "Cancelar".
  - "Te enviamos este ticket por WhatsApp."

### Movimiento y accesibilidad

- **Movimiento:**
  - Cada paso entra con `animate-fade-in`, sin deslizar.
  - El ticket entra con `animate-pop-in`, y el sello 200 ms después.
  - `prefers-reduced-motion` ya está cubierto en `globals.css`.
- **En cada cambio de paso:**
  - el foco va al `StepHeading`;
  - se actualiza `document.title`, por ejemplo "Elige la hora · Reservar · Villa";
  - `history.pushState`, para que el botón atrás de Android vuelva al paso anterior.
- Los datos se guardan en memoria y en `sessionStorage`; volver atrás no los pierde.
- **Errores de envío:** un `ErrorSummary` (`role="alert"`, recibe el foco) con enlaces a cada campo; además, un `FieldError` en cada campo.

## 3. `/cita/[token]`

**Estructura:** saludo + `Ticket` + acciones + `CancelSheet` + `RescheduleSheet`.

**Cancelar:**

- Motivo opcional: Me salió algo / Ya no lo necesito / Me equivoqué de hora / Otro (hasta 200 caracteres).
- Dentro de la ventana tardía, aviso: "Faltan menos de {X} horas. Puedes cancelar, pero quedará registrada como cancelación tardía."
- Botones: "Sí, cancelar mi cita" y "Mantener mi cita". El foco arranca en "Mantener".

**Reprogramar:**

- `DayStrip` + `SlotGroups`. Confirmar: "Cambiar a jue 30, 4:00 p. m.".
- Aviso de éxito: "Listo, tu cita ahora es el jueves 30 a las 4:00 p. m."

## 4. `/privacidad`

- **Contenedor:** `max-w-[68ch] mx-auto px-4 py-10`.
- **Encabezado:** H1 en Fraunces, y debajo "Versión 1.0 · actualizada el …".
- **Índice:** dentro de un `<details>` en móvil; como columna fija en `lg`.
- **Secciones:**
  1. Responsable
  2. Qué datos recogemos
  3. Para qué
  4. Recordatorios y promociones
  5. Tus derechos
  6. Cómo ejercerlos (10 días hábiles para consultas, 15 para reclamos)
  7. Encargados (Meta/WhatsApp, correo, hosting)
  8. Cuánto tiempo guardamos
  9. Cambios
- Estilo de impresión incluido.

## 5. Estados de error y vacíos

Todos usan `role="alert"`, salvo los vacíos, que usan `status`.

| Caso | Texto |
|---|---|
| Sin horarios ese día | "No quedan horarios el jueves 30." + "El viernes 31 tiene 6 horarios." [Ver viernes]. Con barbero elegido: [Probar con Cualquiera] |
| Sin horarios en 14 días | "Andrés no tiene turnos en las próximas dos semanas." [Cualquiera] [Escríbenos] |
| Horario tomado al último segundo | "Uy, alguien tomó las 3:30 p. m. justo antes que tú. Estos son los más cercanos:" (3 botones). Los datos se conservan |
| Retención vencida | "Se acabó el tiempo y liberamos el horario. Elige otro; tus datos siguen aquí." |
| Código errado | "Ese código no coincide. Te quedan 2 intentos." |
| Código vencido | "El código venció (dura 5 minutos)." [Enviar código nuevo] |
| Demasiados intentos | "Demasiados intentos. Por seguridad, espera 15 minutos o escríbenos por WhatsApp." |
| Límite de velocidad | "Vas muy rápido. Espera un minuto y vuelve a intentar." |
| Límite de citas activas | "Ya tienes 3 citas activas con este número. Revísalas desde el enlace que te enviamos por WhatsApp." |
| Red | "No pudimos conectarnos. Revisa tu internet e inténtalo otra vez." [Reintentar] |
| Enlace vencido o inválido | "Este enlace ya no funciona." + "Puede que la cita ya pasó o el enlace venció." [Reservar otra cita] [Escríbenos por WhatsApp] |

## 6. Mensajes

**Reglas de Meta para las plantillas de WhatsApp (en `es`):** no pueden empezar ni terminar con una variable, no puede haber variables seguidas y no llevan texto del usuario.

| Plantilla | Texto |
|---|---|
| Código (autenticación, texto fijo de Meta) | "{{1}} es tu código de verificación. Por tu seguridad, no lo compartas." Pie: "Este código caduca en 5 minutos." Botón "Copiar código" |
| Confirmación | "¡Listo, {{1}}! Tu cita en Villa quedó confirmada: {{2}} con {{3}}, el {{4}} a las {{5}}. Tu código de turno es {{6}}. Si necesitas reprogramar o cancelar, usa el botón." Botón "Ver mi cita" |
| Recordatorio 24 h | "Hola, {{1}}. Te esperamos mañana a las {{2}} en Villa para tu {{3}} con {{4}}. Si no puedes venir, avísanos desde el botón y liberamos el turno." |
| Recordatorio 2 h | "Hola, {{1}}. Tu turno en Villa es hoy a las {{2}}. Estamos en {{3}}. ¡Nos vemos!" |
| Cancelación (por el cliente) | "Hola, {{1}}. Cancelamos tu cita del {{2}} a las {{3}}. Cuando quieras volver, reserva desde el botón." |
| Cancelación (por la barbería) | "Lo sentimos, {{1}}. Tuvimos que cancelar tu cita del {{2}} a las {{3}}. Escríbenos y te buscamos otro turno." |

**Correo** (remitente "Villa Barbería", HTML sencillo sobre hueso, con el ticket como tabla):

- **Código:** asunto "Tu código de Villa: {{1}}".
- **Confirmación:** asunto "Cita confirmada: {{1}} a las {{2}}", con el .ics adjunto.
- **Recordatorios:** asuntos "Mañana a las {{1}}: tu turno en Villa" y "Hoy a las {{1}}: te esperamos".
- **Cancelación:** asunto "Cancelamos tu cita del {{1}}".
- Los correos de servicio no llevan promociones.

## 7. Pendientes con el dueño

- **Abogado:** que valide la redacción de la autorización obligatoria y la política.
- **Cancelación tardía:** definir la ventana de horas y su consecuencia.
- **Pruebas de accesibilidad:** `@axe-core/playwright` sobre todo el flujo y una pasada manual con TalkBack en `DayStrip` y `OtpField`.
