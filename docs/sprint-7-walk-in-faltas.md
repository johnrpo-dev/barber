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
   - está ausente;
   - tiene una cita "En silla" o "Llegó" pasada de la hora sin marcar. Un olvido no puede dejarlo ocupado todo el día.

Además, un barbero no entra si el servicio no alcanza antes de su próxima cita o de su descanso, aunque falten más de 60 minutos.

**Empates:** primero el que menos servicios ha atendido hoy. Si siguen empatados, decide una rotación que cambia cada día; por nombre favorecería siempre al mismo.

**"Cualquiera" en el walk-in** toma al primero de la fila, calculado dentro de la transacción. Si dos recepcionistas empiezan a la vez, la segunda choca con la restricción EXCLUDE y pasa al siguiente.

**Elegido a mano:** la regla de los 60 minutos reparte, no bloquea. Recepción puede darle el cliente a ese barbero si el servicio cabe antes de su cita. El formulario lo explica.

**Diferencia con la cita agendada:** "Cualquiera" en una cita futura sigue eligiendo al que tiene menos minutos reservados ese día (`pickStaffForAny`). La fila por tiempo libre es solo para el cliente sin cita, que empieza ya.

**Presencia:** el sistema no sabe si el barbero está físicamente en la barbería. Si está en turno pero no vino, o salió, hay que marcarlo ausente en "Bloqueos". Si no, puede salir primero en la fila.

## 3. Faltas y reserva en línea

El dominio está en `src/domain/clients/no-shows.ts` y la base en `src/db/no-shows.ts`.

**Qué cuenta como falta:**
- Solo las citas en "No vino", contadas por la hora en que se marcaron (`status_changed_at`, que pone la base).
- Si la cita vuelve a "Llegó", deja de contar.
- Solo cuentan las faltas de los últimos 180 días.

**El bloqueo:**
- Con `no_show_limit` faltas (2 por defecto, en Ajustes), el cliente **no reserva en línea**.
- Se comprueba al confirmar la reserva (`confirmOnlineAppointment`), **después** del código o del navegador recordado. Así nadie descubre, escribiendo un número ajeno, si esa persona falta.
- La retención se libera y el cliente ve: "Tu reserva en línea está suspendida porque no llegaste a tus últimas citas. Escríbenos por WhatsApp o llámanos y te agendamos."

**Lo que sigue permitido:**
- El personal puede agendarle igual: ve el aviso al buscarlo y en la cita.
- Reprogramar o cancelar una cita que ya existe sigue funcionando.

**Desbloqueo:**
- Lo hacen recepción o el dueño desde la cita en la agenda, con el botón "Desbloquear reserva en línea".
- Guarda `clients.no_shows_cleared_at` con la hora de la base; las faltas anteriores dejan de contar.
- Queda en la bitácora (`client.no_shows_clear`, categoría Personal) sin datos de la persona.

## 4. Recordatorio

Los tres textos de recordatorio terminan con la frase "Si faltas sin avisar, tu reserva en línea puede quedar suspendida." No hay variable con el número: el límite se puede cambiar en Ajustes, y la plantilla de WhatsApp es fija.

Hoy solo se envía el del mismo día (`villa_recordatorio`). Al registrar las plantillas en Meta (sprint 9), su cuerpo tiene que llevar esa frase.

## 5. Migraciones

- `0021_walk_in_no_shows`:
  - `locations.walk_in_guard_min` (60, de 0 a 240);
  - `locations.no_show_limit` (2, de 1 a 10);
  - `clients.no_shows_cleared_at`.
- `0022_audit_no_shows_clear`: agrega `client.no_shows_clear` a los CHECK de `audit_events`.
