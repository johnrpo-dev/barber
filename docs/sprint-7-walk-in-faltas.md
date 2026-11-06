# Sprint 7: walk-in por disponibilidad y faltas

Decisiones del dueño (noviembre de 2026) y cómo quedaron en el código.

## 1. Lo que se decidió y lo que se descartó

| Pregunta | Respuesta del dueño | En el sistema |
|---|---|---|
| Combos (corte + barba) | Los hace el mismo barbero; son los servicios que ya tenían en el otro proveedor | Ya existen como servicios del catálogo (p. ej. "Corte de cabello y barba", 60 min). **No** se construyen citas con varios servicios. Lo que se agregue en la silla va como extra al cobrar |
| Limpieza entre servicios | "Entre un servicio" | Es el `buffer_min` de cada servicio (ya existía) |
| Notas de la cita | Solo el nombre del servicio; el cliente dice qué quiere sentado | Sin campo de notas nuevo ni datos de salud |
| Clientes recurrentes | Aún no se sabe cuántos | Citas recurrentes y lista de espera: **aplazadas** |
| Faltas | 2 faltas suspenden la reserva en línea; se desbloquea desde recepción o el dueño | §3 |
| Llegar tarde / cancelar tarde | No cuenta como falta | Solo cuenta "No vino" |
| Recordatorio | Debe avisar que faltar suspende la reserva | §4 |
| Walk-in | Lo atiende el que primero terminó; no si tiene cita en menos de 60 min | §2 |
| Código por WhatsApp al reservar | "Mientras menos complique la app, mejor es la reserva": que no lo pida | §6 |
| Barbero en turno que salió | Queda fuera de servicio hasta que llega; al volver queda de último en la fila | §2, "Salí / Llegué" |

## 2. Walk-in: la fila por tiempo libre

Regla del dueño: *"el que quede disponible será el que primero termine el servicio … si tiene reserva en menos de 60 min no podrá estar disponible"*.

El dominio está en `src/domain/booking/walk-in-queue.ts`, que es puro y está probado con ejemplos y propiedades. La lectura de la base está en `walkInQueueFor` (`src/db/appointments.ts`).

1. **Libres** (pueden empezar ya), ordenados por "libre desde": el que más lleva esperando va primero. "Libre desde" es lo más tarde entre tres momentos:
   - cuando marcó "Terminar" en su último servicio de hoy, más la limpieza. Cuenta la hora real aunque haya terminado después de lo programado;
   - el inicio del bloque de turno en que está, de modo que después del almuerzo cuenta desde el regreso;
   - el fin de su última ausencia de hoy.
2. **Ocupados**, ordenados por la hora en que se liberan.
3. **No pueden**, cada uno con su motivo:
   - no hace el servicio;
   - el turno no le alcanza;
   - tiene una cita dentro del margen (60 min, ajustable en Ajustes: "Walk-in: sin cita en los próximos");
   - está ausente (un bloqueo o ausencia en "Bloqueos");
   - salió ("Salí / Llegué", abajo);
   - tiene una cita "En silla" o "Llegó" pasada de la hora sin marcar. Un olvido no puede dejarlo ocupado todo el día.

Además, un barbero no entra si el servicio no alcanza antes de su próxima cita o de su descanso, aunque falten más de 60 minutos.

**Empates:** primero el que menos servicios ha atendido hoy. Si siguen empatados, decide una rotación que cambia cada día; por nombre favorecería siempre al mismo.

**"Cualquiera" en el walk-in** toma al primero de la fila, calculado dentro de la transacción. Si dos recepcionistas empiezan a la vez, la segunda choca con la restricción EXCLUDE y pasa al siguiente.

**Elegido a mano:** la regla de los 60 minutos reparte, no bloquea. Recepción puede darle el cliente a ese barbero si el servicio cabe antes de su cita. El formulario lo explica.

**Diferencia con la cita agendada:** "Cualquiera" en una cita futura sigue eligiendo al que tiene menos minutos reservados ese día (`pickStaffForAny`). La fila por tiempo libre es solo para el cliente sin cita, que empieza ya.

**Salí / Llegué (presencia):** regla del dueño: *"si el barbero está en turno y salió, quedará fuera de servicio hasta que llegue y al regresar queda de último en la cola de disponible"*.
- En la Agenda, el encabezado de cada barbero tiene el botón "Salió". Al tocarlo, el encabezado dice "Salió a las 2:10" y el botón cambia a "Llegó".
- Recepción y el dueño marcan a cualquiera; el barbero, a sí mismo.
- Mientras está fuera, no entra a la fila del walk-in ("Salió a las 2:10"). Al marcar "Llegó", su "libre desde" es la hora en que llegó: queda detrás de todos los que ya estaban libres.
- No toca la agenda ni la reserva en línea: una diligencia de veinte minutos no le quita los turnos del resto del día. Para ausencias con hora de regreso conocida (almuerzo largo, cita médica) sigue "Bloqueos".
- Cada día empieza en la barbería: una salida que nadie cerró ayer no lo deja fuera hoy. Quien no ha llegado al empezar el turno se marca con "Salió" hasta que llegue.
- `staff_presence_events` es solo-inserción (la app no puede cambiar ni borrar marcas): manda la última marca del día, con la hora de la base, y queda quién marcó a quién (`src/db/staff-presence.ts`).

## 3. Faltas y reserva en línea

El dominio está en `src/domain/clients/no-shows.ts` y la base en `src/db/no-shows.ts`.

**Qué cuenta como falta:**
- Solo las citas en "No vino", contadas por la hora en que se marcaron (`status_changed_at`, que pone la base).
- Si la cita vuelve a "Llegó", deja de contar.
- Solo cuentan las faltas de los últimos 180 días.

**El bloqueo:**
- Con `no_show_limit` faltas (2 por defecto, en Ajustes), el cliente **no reserva en línea**.
- Se comprueba al confirmar la reserva (`confirmOnlineAppointment`), **después** del código o del navegador recordado. Así nadie descubre, escribiendo un número ajeno, si esa persona falta.
- En la reserva **sin código** (§6) el número no está comprobado: el mensaje es genérico ("No pudimos confirmar tu reserva en línea…"), sin mencionar faltas.
- La retención se libera y el cliente ve: "Tu reserva en línea está suspendida porque no llegaste a tus últimas citas. Escríbenos por WhatsApp o llámanos y te agendamos."

**Lo que sigue permitido:**
- El personal puede agendarle igual: ve el aviso al buscarlo y en la cita.
- Reprogramar o cancelar una cita que ya existe sigue funcionando.

**Desbloqueo:**
- Lo hacen recepción o el dueño desde la cita en la agenda o desde la ficha del cliente (§8), con el botón "Desbloquear reserva en línea".
- Guarda `clients.no_shows_cleared_at` con la hora de la base; las faltas anteriores dejan de contar.
- Queda en la bitácora (`client.no_shows_clear`, categoría Personal) sin datos de la persona.

## 4. Recordatorio

Los tres textos de recordatorio terminan con la frase "Si faltas sin avisar, tu reserva en línea puede quedar suspendida." No hay variable con el número: el límite se puede cambiar en Ajustes, y la plantilla de WhatsApp es fija.

Hoy solo se envía el del mismo día (`villa_recordatorio`). Al registrar las plantillas en Meta (sprint 9), su cuerpo tiene que llevar esa frase.

## 6. Reserva sin código por WhatsApp

Lo pidió el dueño: *"Si un cliente solicita por primera vez me gustaría que no pida recibir código por WhatsApp, mientras menos complicaciones tenga la app, mejor es la reserva"*.

**Cómo queda:**
- `locations.booking_requires_code` vale `false` por defecto.
- La reserva queda confirmada al tocar "Reservar" (`bookWithoutCode` en `src/db/public-booking.ts`).
- El formulario pide solo nombre, celular y la autorización de datos. Correo y promociones se piden solo con código.
- Si el celular es nuevo, el navegador queda recordado y la próxima vez no hay que escribir nada. Si el celular ya era de un cliente, no: quien lo escribe podría no ser esa persona.
- En Ajustes, el interruptor "Pide código por WhatsApp al reservar" vuelve al flujo anterior sin tocar código.

**Lo que se pierde, y cómo se acota:**

| Riesgo | Cómo se acota |
|---|---|
| Cualquiera reserva con un número ajeno | Turnstile, límites por IP y por celular, tope de citas activas por número. Al dueño real del número le llega la confirmación por WhatsApp con el botón para cancelar. Si se vuelve un problema, se enciende el interruptor |
| Las faltas se esquivan reservando con otro número, y dos reservas falsas con el número de alguien lo dejan suspendido | Recepción desbloquea en un toque. Con el interruptor encendido vuelve a valer el celular comprobado |
| Cambiar los datos de un cliente existente desde afuera | No se cambian el nombre ni el correo, ni se registran autorizaciones a su nombre (ni a favor ni en contra) |
| Un correo ajeno recibiría las citas del dueño del número cuando WhatsApp falla | Sin código no se guarda correo |
| Promociones a un número que no autorizó | Sin código no se autorizan promociones |
| Salir con el nombre de la persona o con una cookie que reserve como ella | Con un celular ya registrado no queda el navegador recordado, y el ticket (`/cita/…`) ya no muestra el nombre de nadie |
| Revelar el historial de un tercero | "Suspendido por faltas" y "tope de citas activas" responden el mismo mensaje genérico (§3). Queda un bit: que ese número no puede reservar en línea ahora. Lo acotan Turnstile y los límites |
| Bots que rotan IPs y números llenan la agenda y mandan WhatsApps | Tope por sede para la reserva sin código: 60 por hora y 300 por día (`booking_start`, alcance `location`) |

**Lo que no cambia:**
- Sin código, el cliente no queda marcado "verificado" (`clients.verified_at`), porque nadie comprobó el celular.
- La política de privacidad sigue nombrando "el código que confirma que el celular es tuyo". Es cierto cuando la sede lo pide. En la próxima versión de la política, que obliga a autorizar de nuevo, conviene escribir "si lo pedimos, el código…".

## 7. Migraciones

- `0021_walk_in_no_shows`:
  - `locations.walk_in_guard_min` (60, de 0 a 240);
  - `locations.no_show_limit` (2, de 1 a 10);
  - `clients.no_shows_cleared_at`.
- `0022_audit_no_shows_clear`: agrega `client.no_shows_clear` a los CHECK de `audit_events`.
- `0023_booking_without_code`: `locations.booking_requires_code` (`false`).
- `0024_staff_presence`: tabla `staff_presence_events` (solo-inserción para la app).
- `0025_client_record` (ficha del cliente, §8):
  - agrega `client.consent_withdraw` y `client.devices_forget` a los CHECK de `audit_events`;
  - DELETE de `villa_app` solo sobre `client_devices`, con el trigger `client_devices_before_delete` (solo lo revocado o vencido hace más de 30 días) y TRUNCATE prohibido.

## 8. Ficha del cliente y privacidad

Cierra cuatro pendientes de la tabla "Seguridad: estado y plan" ([arquitectura.md](arquitectura.md)): retirar autorizaciones, olvidar los navegadores recordados, purgar `client_devices` y volver a autorizar al cliente recordado.

**La ficha (`/panel/clientes`):**
- Permiso nuevo `clients.manage`: dueño y recepción; el barbero no. El enlace "Clientes" del panel se ve con `clients.manage` o `clients.erase`.
- Se busca por nombre o celular (`searchClients`) y se abre la ficha. Buscar y abrir la ficha dejan constancia de quién vio el celular completo (`recordContactReads`, contexto `client_search`).
- Muestra:
  - nombre, celular y si lo verificó con el código;
  - historial: las últimas 20 citas (fecha y hora de la sede, servicio, profesional, estado) y los conteos (citas, próximas, terminadas, "No vino", canceladas), sumados en SQL (`src/db/client-record.ts`);
  - faltas que cuentan hoy y si la reserva en línea está suspendida, con el mismo botón de desbloqueo de la agenda (misma regla: `clearNoShows`);
  - autorizaciones: la última fila de cada propósito, con versión de la política, fecha y origen (en línea o en la barbería);
  - navegadores recordados activos (sin revocar y sin vencer): cuántos y el último uso.
- La supresión de datos sigue siendo solo del dueño, con reautenticación y "SUPRIMIR": ahora se abre desde la ficha.

**Retirar el recordatorio o las promociones (Ley 1581, derecho a revocar):**
- Lo hace el personal cuando la persona lo pide. Pide confirmación.
- Inserta una fila nueva en `client_consents`: `granted = false`, `source = 'staff'`, versión vigente de la política. Nada se edita ni se borra; manda la última fila.
- El tratamiento de datos no se retira desde aquí: eso es la supresión.
- En la misma transacción queda `client.consent_withdraw` en la bitácora, solo con el propósito (sin nombre ni celular). Si la autorización ya no estaba vigente, no escribe nada.
- El worker ya respetaba la última fila: no crea el recordatorio y, si estaba en la cola, lo suprime al entregarlo (prueba en `src/db/notifications.test.ts`).

**Olvidar los navegadores de este cliente:**
- Revoca (`revoked_at = now()`) todos los navegadores activos del cliente, con `client.devices_forget` en la misma transacción. Pide confirmación.
- Revocar sigue siendo definitivo (trigger de 0017). La próxima reserva en línea vuelve a confirmar el celular.

**Tope y purga de `client_devices`:**
- Al recordar un navegador nuevo quedan como máximo 5 activos por cliente. Se revocan los que llevan más tiempo sin usarse (último uso o, si nunca se usó, cuando se recordó); el nuevo nunca (`src/domain/clients/devices.ts`, con prueba de propiedades). Cuenta con la fila del cliente bloqueada (`FOR UPDATE`), así dos verificaciones a la vez no se saltan el tope.
- El mantenimiento diario borra las filas revocadas o vencidas hace más de 30 días (`purgeClientDevices`, desde `purgeExpiredPersonalData`).
- Para eso `villa_app` tiene DELETE **solo** sobre `client_devices`. Un trigger exige la misma regla fila por fila: con la app tomada no se puede borrar un navegador activo ni uno que dejó de servir hace menos de 30 días. TRUNCATE sigue prohibido.

**Volver a autorizar al cliente recordado:**
- Si su última autorización de datos (o la del recordatorio) es de una política anterior a la vigente, la pantalla "Confirmar" pide una vez la casilla obligatoria, con el mismo texto del formulario. Sin ella no se reserva (`consentRenewal`).
- Con la casilla, en la misma transacción de la reserva se guarda una fila nueva de tratamiento de datos con la versión vigente, la IP y el navegador. La del recordatorio solo se escribe si no había fila o si la última era un sí de una política anterior. Las promociones no se tocan. La próxima vez no se vuelve a pedir.
- Un no previo al recordatorio se respeta siempre, lo haya marcado la persona en línea o lo haya retirado el personal: no obliga a renovar y la renovación no lo convierte en sí (Ley 1581).
- Lo que se escribe sale de una relectura dentro de la transacción, con la fila del cliente bloqueada (`FOR UPDATE`): un retiro del personal en paralelo no se deshace y dos reservas a la vez no duplican las filas.
