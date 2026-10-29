# Sprint 3: reserva pública y notificaciones

Decisiones del arquitecto, revisadas contra el código (29 de octubre de 2026). El diseño visual y los textos están en [sprint-3-diseno-portal.md](sprint-3-diseno-portal.md). Cuando este documento y el código no coincidan, manda el código y se corrige aquí.

## 0. Lo que el código actual obliga a cambiar

- `changeStatus` y `rescheduleAppointment` (`src/db/appointments.ts`) solo aceptan `StaffActor`. Se amplían a `actor: StaffActor | { kind: "client" } | { kind: "system" }`. `status.ts` ya permite al cliente cancelar `pending`/`confirmed` y al sistema confirmar `pending`.
- `expireHolds` solo corre dentro de `createAppointment`. Se exporta `expireHoldsAll(db, now)` para el worker.
- `availability()` ofrece a todo el personal con turno, incluido el dueño. Se filtra por `bookable_online`.
- `services` y `staff_members` no tienen ID público. Se les agrega `public_id`, porque hacia afuera nunca va el `bigint`.

## 1. Flujo y rutas (grupo `src/app/(publico)/`)

| Ruta | Qué hace |
|---|---|
| `/` | Página de la sede: servicios, barberos, horario, ubicación y "Reservar". |
| `/reservar?servicio=&barbero=&dia=&hora=` | Pasos en la URL (volver atrás no pierde nada). Lee servicios activos, barberos con `bookable_online` y `availability({ internal: false })` para 14 días. "Cualquiera" es la unión de horarios; el barbero se fija al retener (`pickStaffForAny`). |
| Paso de datos | Nombre, celular, correo opcional, consentimientos y Turnstile. Acción `startBooking`. |
| `/reservar/verificar` | Encuentra la retención por cookie (sin IDs en la URL). Acciones `verifyCode` y `resendCode`. |
| `/cita/[token]` | Ticket, .ics, cancelar y reprogramar. `no-store`, `noindex`, `Referrer-Policy: no-referrer`. |
| `/cita/[token]/calendario.ics` | Route handler GET. |
| `/privacidad` | Política vigente; `?v=` muestra versiones anteriores. |

**Retención:**

- `startBooking` llama a `createAppointment({ source: "online" })`: la cita queda `pending` con `expires_at = now + holdMin`.
- Pasa a `confirmed` **solo** dentro de la transacción de `verifyCode`, con actor `system`, después de bloquear la fila y comprobar `status = 'pending' AND expires_at > now()`. Al confirmar, `expires_at` queda en null.
- `CHECK locations.hold_min BETWEEN 10 AND 30`, para que el tiempo alcance para el código y dos reenvíos.

**Cliente:**

- `findOrCreateClient` al retener. Nunca se sobrescribe el nombre de un cliente existente.
- No hay autocompletado desde la base.
- `clients.verified_at` se llena con el primer código correcto.

## 2. Verificación (código de 6 dígitos) y límites

**Tabla `booking_verifications`, ligada a la cita:**

- Código con `crypto.randomInt`.
- `code_hash = HMAC-SHA256(OTP_PEPPER, "otp:" + id + ":" + code)`, comparado con `timingSafeEqual`.
- Vence en `min(now + 5 min, appointment.expires_at)`. `max_attempts = 5`.
- `browser_hash` = SHA-256 de la cookie `villa_hold`: 32 bytes, HttpOnly, Secure, SameSite=Strict, `Path=/reservar`. Sin el mismo navegador, el código no sirve.

**Verificar:**

1. Un UPDATE propio suma el intento antes de comparar: `attempts = attempts + 1 WHERE … attempts < max AND consumed_at IS NULL AND expires_at > now() RETURNING code_hash`. El intento cuenta aunque el código falle.
2. Si coincide, todo en **una transacción**: `consumed_at`, cita a `confirmed`, límite de citas activas, consentimientos, enlace de gestión, confirmación al outbox y `verified_at`.

**Reenvío:**

- Espera de 60 s y máximo 3 envíos por retención.
- El envío nuevo marca el anterior con `superseded_at`.
- La retención no se alarga.

**Envío del código:** sale en línea desde la server action, después del COMMIT, nunca por pg-boss. Así el código en claro no queda en la cola ni en la base; el registro guarda `params: { code: "[redacted]" }`.

**Límites:** contador en Postgres (`rate_limit_counters`) con ventana fija y `INSERT … ON CONFLICT DO UPDATE SET hits = hits + 1 RETURNING hits`. Cada cubeta usa el HMAC de la IP o del teléfono.

| Acción | Por IP | Por teléfono o correo |
|---|---|---|
| `startBooking` | 10/h, 30/día | 5/h |
| Envíos de código | 20/día | 6/día |
| Intentos de verificación | 30/h | 5 por código |
| Acciones de `/cita` | 30/h | — |

**Citas por teléfono:**

- **Una pendiente por cliente.** Lo garantiza el índice único parcial `appointments_one_pending_per_client (location_id, client_id) WHERE status = 'pending'`. Una retención nueva cancela la anterior (`duplicate`, actor `system`).
- **Máximo `locations.max_active_per_client` (3) citas futuras activas.** Se comprueba al verificar, con `SELECT … FOR UPDATE` sobre el cliente. En ese punto el teléfono ya está probado, así que el mensaje no le revela nada a un extraño.

**Turnstile:**

- Puerto `HumanVerifier` con dos implementaciones:
  - `TurnstileVerifier`: siteverify con `remoteip`; comprueba `success`, `action === "reservar"` y `hostname`.
  - `FakeVerifier`: acepta `"ok"`; prohibido en producción.
- Solo protege `startBooking`.

## 3. Enlace de gestión (`/cita/[token]`)

**Token derivado, no aleatorio:** `base64url(HMAC-SHA256(MANAGE_LINK_SECRET, "manage:" + publicId + ":" + generation))`.

- Cada recordatorio lleva el enlace. Con un token aleatorio habría que guardarlo de forma reversible. Así el worker lo recalcula y la base solo guarda `SHA-256(token)` para buscarlo. Son 256 bits igual.
- Vence al fin de la cita + 7 días.
- Se revoca al cancelar (`revoked_at`, en la misma transacción). Rotar = `generation + 1`.
- Token desconocido, vencido, revocado o de otra sede: la **misma** página 404.

**Cancelar:** `changeStatus(actor client)`. Permitido hasta la hora de inicio; `cancelledLate` sale de `freeCancelHours`, y la interfaz avisa antes.

**Reprogramar:** `rescheduleAppointment(actor client)`.

- Solo citas `confirmed`, fuera de la ventana de cancelación gratuita. Dentro de ella: "llama a la barbería".
- Máximo 2 veces, contadas en `appointment_events`.
- El horario nuevo sale de `availability({ internal: false, excludeAppointmentId })`.
- El token no cambia.

## 4. Consentimiento (Ley 1581)

Tabla `client_consents`, solo-inserción; manda la última fila por (cliente, propósito). Tres propósitos, con casillas **sin marcar**:

- `data_processing`: autorización de tratamiento, **obligatoria para reservar**. Cubre el código, la confirmación y la cancelación.
- `reminders`: opcional.
- `marketing`: opcional.

**Evidencia:** las elecciones, la IP y el user-agent del envío se guardan en la verificación. Las filas de consentimiento se escriben **al verificar**, para que la evidencia quede ligada a un titular probado.

**Política versionada:** vive en `src/content/privacy/versions.ts`. Un test congela el SHA-256 de cada versión publicada; para cambiarla se crea una versión nueva. `text_version` debe existir en esa lista.

**Recordatorios:** se envían solo si el último consentimiento `reminders` es verdadero. Las citas creadas por el personal no los reciben hasta tener consentimiento.

## 5. Notificaciones

**Puerto `Notifier`:** `send({ channel, template, to, params }) → { providerMessageId }`. Adaptadores en `src/lib/notify/`, con `fetch` y sin dependencias nuevas:

- `whatsapp.ts`: Graph API, solo plantillas.
- `resend.ts`: cabecera `Idempotency-Key` = clave de deduplicación.
- `console.ts`: fuera de producción.
- `memory.ts`: tests y e2e.

**Ningún texto libre del usuario:**

- La plantilla del código **no lleva el nombre**. Si alguien escribe un teléfono ajeno, la víctima no recibe texto del atacante.
- Las demás llevan el primer nombre, saneado a letras y hasta 30 caracteres.

**Outbox solo-inserción:**

- `notifications` es la intención, con `UNIQUE(location_id, dedupe_key)`. Claves: `confirm:{publicId}`, `rem24:{publicId}:{startISO}`, `rem2:{publicId}:{startISO}`, `cancel:{publicId}`, `resched:{publicId}:{startISO}`.
- `notification_events` registra cada intento y su resultado.

**Entrega a lo sumo una vez:**

1. `pg_advisory_xact_lock(id)`.
2. Si ya hay `sent`, no se hace nada.
3. Se revisa la cuota.
4. Se inserta `attempt` y se hace COMMIT.
5. Se llama al proveedor.
6. Se inserta `sent` o `failed`.

Un `attempt` sin resultado después de 2 min pasa a `unknown` y no se reintenta: mejor perder un recordatorio que mandarlo dos veces.

**Jobs del worker** (pg-boss, `tz: America/Bogota`):

| Job | Cuándo | Qué hace |
|---|---|---|
| `holds:expire` | cada minuto | Vence retenciones. |
| `notifications:scan` | cada minuto | Crea recordatorios y entrega las filas pendientes. 24 h: falta ≤ 24 h y > 3 h. 2 h: falta ≤ 2 h y > 30 min. Solo `confirmed` con consentimiento. |
| `maintenance:daily` | 03:00 | Borra contadores viejos, anonimiza clientes nunca verificados (más de 7 días, solo con retenciones vencidas) y revisa la alerta de cuota. |

La web no usa pg-boss: escribe el outbox dentro de la transacción del dominio, y el scan lo despacha. Al reprogramar cambia `startISO`, así que los recordatorios viejos se marcan `suppressed`.

**Cuotas:** 6 por destinatario al día y 300 globales al día. Al 80 % llega un correo a `ALERT_EMAIL`; al 100 % los envíos quedan `suppressed`.

## 6. Seguridad de lo público

**Server actions para todo:** solo POST, Next revisa Origin/Host y se usa el mismo `runAction`. Route handlers solo para el `.ics` y, más adelante, el webhook de WhatsApp (firma `X-Hub-Signature-256`).

**Sin enumeración:**

- `startBooking` responde igual para un teléfono nuevo o existente.
- El código se envía en ambos casos.
- Los límites dan un único mensaje genérico.

**Lo que se expone:** `appointments.public_id` (ULID), `public_id` de servicios y barberos, slugs y tokens.

**Registros y CSP:**

- IP real con `src/lib/client-ip.ts`, con la misma regla de proxy que better-auth.
- Registros con lista de claves permitidas: nunca el teléfono ni el código.
- CSP: agregar `https://challenges.cloudflare.com` a `script-src` y `frame-src`.

**Tests:**

- `public-endpoints.test.ts`, con guarda de completitud de las acciones públicas. Casos:
  - si Turnstile falla, no se escribe nada;
  - teléfono existente y nuevo dan respuesta idéntica;
  - la cookie de otro navegador no verifica;
  - tokens malos dan el mismo 404;
  - cancelar dos veces no hace nada la segunda;
  - cancelar después del inicio se rechaza;
  - reprogramar dentro de la antelación mínima se rechaza;
  - superar el límite da el mensaje genérico.
- Propiedades (fast-check):
  - un código se consume a lo sumo una vez, y solo si es correcto, con intentos < 5 y sin vencer;
  - nunca más de una pendiente por cliente ni más de N activas;
  - el contador nunca deja pasar más del límite;
  - una dedupe key nunca queda `sent` dos veces;
  - la cuota por destinatario se respeta.

## 7. Esquema

**Migración generada (drizzle-kit):**

- `locations`: `slug` único, `public_booking_enabled` (falso por defecto), `public_phone`, `address`, `maps_url`, `max_active_per_client` (3, CHECK 1..10).
- `services`: `public_id uuid` único.
- `staff_members`: `public_id uuid` único, `slug` (`UNIQUE(location_id, slug)`), `bookable_online` (verdadero por defecto).
- `clients`: `verified_at`.
- Tablas nuevas, como en las secciones 2 a 5:
  - `booking_verifications`: con los índices únicos parciales de una verificación viva y una consumida por cita;
  - `appointment_links`: con uno vigente por cita;
  - `client_consents`;
  - `notifications`;
  - `notification_events`;
  - `rate_limit_counters`: **sin `location_id`**, porque es infraestructura como pg-boss. Excepción documentada.

**Migración a mano (`public_booking_guards.sql`):**

- Solo-inserción (UPDATE, DELETE y TRUNCATE) en `client_consents`, `notifications` y `notification_events`.
- `booking_verifications`:
  - `code_hash`, `appointment_id`, `browser_hash` y `expires_at` no se cambian;
  - `attempts` solo sube de 1 en 1;
  - `consumed_at` se pone una vez, con intentos dentro del límite y sin vencer;
  - no hay DELETE.
- `appointment_links`: el token y la cita no se cambian; `revoked_at` se pone una sola vez; no hay DELETE.
- `appointments_one_pending_per_client` y `CHECK hold_min BETWEEN 10 AND 30`.

## 8. Orden de construcción (cada paso empieza por sus tests)

1. **`src/domain/` puro, con propiedades:**
   - `verification/otp.ts`
   - `security/rate-limit.ts`
   - `booking/client-policy.ts`
   - `links/manage-token.ts`
   - `clients/consent.ts`
   - `notifications/{templates,schedule,quota,ports}.ts`
2. Migraciones, con tests de triggers en PGlite.
3. **`src/db/`:**
   - `public-booking.ts`
   - `manage-links.ts`
   - `consents.ts`
   - `rate-limit.ts`
   - `notifications.ts`
   - Cambios en `appointments.ts`: actores, `expireHoldsAll` y `bookable_online`.
4. **`src/lib/`:**
   - `env.ts`: variables nuevas y opcionales
   - `notify/*`
   - `turnstile.ts`
   - `client-ip.ts`
   - `public-readiness.ts`
5. **`src/worker/jobs/`:**
   - `expire-holds`
   - `scan-notifications`
   - `deliver`
   - `maintenance`
6. **`src/app/(publico)/`:** páginas y `actions.ts` delgados.
7. `public-endpoints.test.ts` y un e2e con el notificador en memoria.
8. Página "Mensajes" del panel (dueño), con sus filas en `authorization.test.ts`. El webhook de WhatsApp va al final.

## 9. Lo que configura el dueño y cómo se degrada

**Meta:**

- Verificación del negocio y número aprobado.
- Plantillas en `es`:
  - `villa_otp`: autenticación, con botón de copiar código;
  - utilidad: `villa_reserva_confirmada`, `villa_recordatorio_24h`, `villa_recordatorio_2h`, `villa_cita_reprogramada` y `villa_cita_cancelada`, con botón URL cuyo sufijo es el token.
- Variables: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` y `WHATSAPP_VERIFY_TOKEN`.

**Correo:** dominio verificado en Resend, `RESEND_API_KEY`, `EMAIL_FROM` y `ALERT_EMAIL`.

**Turnstile:** `NEXT_PUBLIC_TURNSTILE_SITE_KEY` y `TURNSTILE_SECRET`. En staging se usan las claves de prueba de Cloudflare.

**Secretos:**

- `OTP_PEPPER` y `MANAGE_LINK_SECRET`: 32 caracteres o más, distintos entre sí.
- `PUBLIC_BASE_URL`: https.

**Del dueño y su abogado:** responsable del tratamiento, NIT, dirección y correo de habeas data para `/privacidad`.

**Degradación:** `publicBookingReadiness()` **falla cerrado** y el panel nunca se cae.

- Producción sin secretos, sin Turnstile o sin ningún canal: `/reservar` muestra "Reserva por teléfono".
- Solo correo: el correo pasa a ser obligatorio.
- Plantilla sin aprobar: esa notificación queda `suppressed` y se intenta por correo.
- Desarrollo: `ConsoleNotifier` y `FakeVerifier`.
- `public_booking_enabled = false` apaga la reserva pública.
