# Villa: documento de descubrimiento

**Versión:** 0.2 · **Fecha:** 2026-10-28

> **Actualización v0.2:**
> - El usuario decidió: solo para Villa, Colombia sin factura electrónica por ahora y diseño "Navaja y Cuero".
> - El proyecto lo programa Claude Code.
> - El **stack cambió a TypeScript (Next.js 16 + PostgreSQL 18)**.
> - Como la prioridad es que las cuentas no fallen, se adopta **partida doble desde el MVP**.
> - La decisión vigente está en [arquitectura.md](arquitectura.md). Donde este documento mencione Laravel, Filament o Livewire, prevalece arquitectura.md.
**Equipo que participó:** Producto, CTO, Arquitectura, Diseño UI/UX, Accesibilidad, Datos y Seguridad.

> **Idea del cliente:** "Villa es una barbería. Necesito crear todo un aplicativo donde ellos puedan tener sus cuentas contables, y además que los clientes puedan agendar citas."

---

## 0. Resumen ejecutivo

| Tema | Decisión propuesta |
|---|---|
| Qué construimos | Un sistema con dos caras: **un portal web de reservas** para clientes (celular, sin instalar nada ni crear cuenta) y **un panel interno** para el dueño, la recepción y los barberos (agenda, cobro, caja, gastos, comisiones y reportes). |
| "Cuentas contables" | La primera versión hace **gestión financiera operativa**: caja diaria, ingresos, gastos, propinas, comisiones, utilidad y exportación para el contador. Todo queda en un **libro de movimientos inmutable**, preparado para pasar a partida doble sin rehacer nada. La contabilidad formal y la factura electrónica (DIAN) se delegan a un proveedor externo (Alegra o Siigo) cuando se necesiten. |
| Stack | **Next.js 16 + TypeScript + Drizzle + PostgreSQL 18 + better-auth + React Aria + pg-boss**: un solo monolito en un VPS (ver [arquitectura.md](arquitectura.md)). |
| Notificaciones | **WhatsApp Cloud API** (recordatorios 24 h y 2 h antes), con email de respaldo. Sin SMS. |
| Pagos en línea | **Fuera del MVP.** Si se quiere cobrar anticipo, se integra Wompi o Mercado Pago después. |
| Multi-sede | Preparado en la base de datos desde el día 1 (`location_id` + RLS), sin interfaz multi-sede en el MVP. |
| Diseño | Dirección **"Navaja y Cuero"**: clásica, fondo claro y confirmación en forma de "ticket de turno". |
| Plazo MVP | **5 sprints**, más 2–3 semanas de arranque si quien programa no conoce Laravel. |
| Costo de operación | **~10–45 USD/mes** (VPS, backups y WhatsApp). |

**Lo primero que hay que decidir:** si de verdad conviene construir, o si basta una herramienta existente (ver §1).

---

## 1. Antes de construir: ¿comprar o construir?

El CTO advierte que **AgendaPro, Booksy y Fresha** ya resuelven reservas, recordatorios y comisiones por unas decenas de USD al mes por sede.

**Construir se justifica si** se cumple alguna de estas condiciones:
- Villa quiere un producto propio, con su marca y sus reglas.
- Se quiere vender el software a otras barberías (SaaS). Esto cambia la arquitectura, ver §7.
- Las herramientas existentes no cubren algo concreto, como el modelo de comisiones, el cierre de caja o la integración contable local.

Hay que dejar esto decidido por escrito antes del sprint 1.

---

## 2. Alcance de "cuentas contables"

Los cuatro agentes que tocaron el tema coinciden en el fondo y difieren en el grado:

| Agente | Postura |
|---|---|
| Producto | Gestión financiera operativa más exportación a Excel. La contabilidad formal queda para una fase posterior. |
| Arquitectura | Partida doble simplificada **desde el MVP**, porque migrar después es caro. |
| Datos | Libro de caja inmutable con signo, con columnas reservadas (`journal_entry_id`, `account_code`) para pasar a partida doble sin migración destructiva. |
| CTO | No construir PUC, balances, declaraciones ni factura DIAN. Eso lo hacen Alegra o Siigo y el contador. |

**Resolución v0.2:** como la prioridad del usuario es que las cuentas no fallen, se adopta **partida doble real desde el MVP**, con cuadre garantizado por la base de datos (ver [arquitectura.md](arquitectura.md)). Lo que sigue era la resolución de la v0.1 y se mantiene en lo demás:

**Resolución v0.1:** se adopta la postura de **Datos**, que satisface a las otras tres:
- El MVP registra **cada movimiento de dinero como una fila inmutable** (con signo, categoría, método, día contable y autor) en `fin_entry`. Nunca se edita ni se borra; los errores se corrigen con un **contra-movimiento**.
- Quedan reservadas las columnas para generar asientos de partida doble más adelante, mediante una función de posteo y un backfill.
- El dueño nunca ve débitos ni créditos: ve caja, ingresos, gastos y utilidad.
- **Factura electrónica:** si es obligatoria desde el día 1, se integra por API con un proveedor autorizado y **desplaza otras funciones del MVP**.

**El sistema NO hará:**
- plan de cuentas (PUC);
- balance general;
- declaraciones de impuestos;
- nómina;
- conciliación bancaria.

---

## 3. Roles y permisos

Los permisos se verifican **siempre en el servidor**, con denegación por defecto.

| Rol | Puede | No puede |
|---|---|---|
| **Dueño/Admin** | Todo: usuarios, precios, reglas de comisión, reportes completos, aprobar anulaciones, reabrir cajas, exportar | — (MFA obligatorio; las acciones críticas piden reautenticación) |
| **Recepción/Caja** | Agenda completa, crear citas y walk-ins, cobrar, abrir y cerrar **su** caja, registrar gastos de caja, **solicitar** anulaciones | Ver utilidades, comisiones de otros o reportes financieros; aprobar sus propias anulaciones |
| **Barbero** | Ver su agenda, marcar "En silla" y "Terminado", ver a sus clientes (teléfono enmascarado), ver **sus** comisiones, bloquear su tiempo | Ver la caja general o datos de otros barberos; modificar montos |
| **Cliente** | Reservar, reprogramar o cancelar mediante enlace con token | — (sin cuenta en el MVP) |

**Separación de funciones:**
- Quien cobra no aprueba la anulación de ese cobro.
- Un día cerrado solo lo reabre el dueño, y la reapertura queda auditada.

---

## 4. Funcionalidades por fase

### Agenda
| MVP | Fase 2 | Futuro |
|---|---|---|
| Catálogo de servicios (duración, precio, margen de limpieza) | Lista de espera | Pago o depósito al reservar |
| Barberos con horario semanal, descansos y ausencias | Notas y preferencias del cliente | Programa de fidelidad y membresías |
| Reserva pública por enlace o QR, con enlace propio por barbero (`/andres`) | Citas recurrentes | App nativa |
| Opción "Cualquiera: el primer turno libre" | Varios servicios en una cita | Integración con Google Calendar |
| Agenda interna por día con una columna por barbero; walk-ins | Cuenta de cliente con historial | |
| Estados: pendiente → confirmada → llegó → en silla → completada / cancelada / no-show | Restricción por inasistencias | |
| Cancelar y reprogramar desde un enlace con token | | |
| Confirmación y recordatorios por WhatsApp, con email de respaldo | | |

### Finanzas
| MVP | Fase 2 | Futuro |
|---|---|---|
| Cobro de cita o walk-in con **pago mixto** y propina separada | Venta de productos con inventario básico | Partida doble activa y exportación contable formal |
| Caja diaria: apertura con base, cierre con arqueo (esperado vs. contado) | Gastos recurrentes, cuentas por pagar | Factura electrónica (DIAN), salvo que sea obligatoria ya |
| Gastos por categoría | Anulaciones con flujo de aprobación avanzado y alertas | Conciliación bancaria |
| Comisiones configurables por barbero y servicio; liquidación por periodo con comprobante | Reportes por barbero y servicio, tasa de no-show | |
| Reporte de ingresos, gastos y utilidad; exportación CSV/Excel | | |

### Transversales (MVP)
- Login del personal con roles.
- Auditoría de todas las acciones financieras y de configuración.
- Dashboard del dueño.
- Zona horaria y moneda por sede.
- Consentimiento de datos personales.

---

## 5. Flujos críticos

**Reservar (cliente, 4–5 toques)**
1. El cliente elige el servicio.
2. Elige el barbero, o "Cualquiera".
3. Elige el día en una tira de 14 días y la hora en grupos de Mañana, Tarde y Noche.
4. Ingresa nombre y celular, con autocompletado si ya vino antes.
5. Verificación OTP por WhatsApp o enlace por email.
6. Ve el **ticket de confirmación** con "Agregar al calendario" (.ics), "Cómo llegar" y los enlaces para reprogramar o cancelar.

Detalles del flujo:
- La cita queda `pending` con `expires_at` de 10–15 minutos hasta que se verifica.
- Si un job encuentra pendientes vencidas, las cancela y libera el hueco.

**Atender y cobrar (meta: 3 toques en el caso típico)**
1. Recepción marca **Llegó**.
2. El barbero marca **En silla** y luego **Terminado**.
3. Recepción toca la cita y se abre un panel de cobro **ya rellenado**.
4. Puede agregar extras, productos, propina o descuento (con permiso).
5. Elige el método de pago (efectivo con cálculo de cambio, tarjeta, transferencia o billetera) y confirma.

Qué pasa al confirmar: en **una sola transacción** la venta queda `paid` y sellada, se insertan los movimientos en `fin_entry` y se congela la comisión en `sale_item`.

**Cierre de caja**
1. El sistema muestra el total esperado por método de pago.
2. Se cuenta el efectivo.
3. Si hay diferencia, se registra como `cash_adjustment` con nota obligatoria.
4. El día queda bloqueado.

**Liquidar comisiones**
1. Se elige barbero y periodo.
2. El sistema lista los servicios cobrados, la comisión congelada, las propinas, los descuentos y los adelantos.
3. Se ajusta si hace falta (con motivo) y se confirma.
4. Queda registrado el egreso `commission_payout`, el periodo se marca liquidado y se genera el comprobante.

---

## 6. Reglas de negocio

- **Duración:** cada servicio tiene duración y margen de limpieza opcional. Un combo suma las duraciones.
- **Anticipación:** el negocio configura el mínimo y el máximo de anticipación para reservar.
- **Cancelación:** gratuita hasta X horas antes (configurable). Después se marca como "tarde".
- **No-show:** se marca manualmente. Tras N inasistencias el cliente queda restringido (Fase 2).
- **Walk-ins:** se registran como cita inmediata, nunca encima de una cita reservada. Pueden ser de cliente anónimo.
- **Propinas:** son 100 % del barbero, no se cuentan como ingreso del negocio y no generan comisión. Es configurable si el negocio descuenta el costo del datáfono.
- **Comisión:** se calcula sobre el **precio neto** del servicio. La regla es versionada y se **congela al momento de cobrar**. Falta definir con el dueño quién absorbe los descuentos y si se descuenta el costo de la tarjeta.
- **Inmutabilidad:**
  - Nada financiero se borra.
  - Una venta pagada queda sellada.
  - Un día cerrado no cambia sin reapertura auditada.

---

## 7. Arquitectura y stack

### Forma
**Un monolito modular, un solo repositorio y un solo deploy.** No se justifican microservicios.

```
[Portal público /reservar (Livewire, PWA)]   [Panel /admin y /barbero (Filament 5)]
                 \                                   /
                  +---------- Laravel 13 -----------+
     Booking | Sales | Finance | Commissions | Clients | Staff | Locations | Notifications
                                 |
          [PostgreSQL]: datos + fin_entry (append-only) + audit_log + cola de jobs
                                 |
          [Worker de cola + scheduler]: recordatorios, expiración de pendientes
                                 |
          [Adaptadores]: WhatsApp Cloud API · Email (Resend/SES) · (futuro) pagos, factura
```

> **Reemplazado en v0.2.** El stack vigente es TypeScript con Next.js 16 y PostgreSQL 18, y la estructura de carpetas vigente también está en [arquitectura.md](arquitectura.md). Lo que sigue en esta sección se conserva como registro de la propuesta inicial.

### Stack elegido (CTO, v0.1, reemplazado)
| Pieza | Elección | Por qué | Descartado |
|---|---|---|---|
| Backend | PHP 8.4 + **Laravel 13** | Colas, scheduler, notificaciones, auth y migraciones vienen incluidos | Django: su admin no sirve como producto diario |
| Panel interno | **Filament 5** (Livewire 4) | El 70 % del sistema son pantallas internas; es el mayor ahorro de semanas | Construir el panel a mano |
| Portal público | Blade + Livewire + manifest PWA | Mobile-first sin SPA | App nativa |
| Base de datos | **PostgreSQL** | `EXCLUDE USING gist` impide la doble reserva **dentro de la base de datos** | MySQL (no tiene ese mecanismo), SQLite (escrituras concurrentes) |
| Mensajería | WhatsApp Cloud API + email | Es el canal real en LATAM; el SMS es caro | SMS |
| Hosting | VPS (Hetzner o DigitalOcean, 2 vCPU y 4 GB) + Forge o Coolify | Barato y suficiente para decenas de sedes | Serverless, porque los jobs y el cron son incómodos |
| Backups | Diario y cifrado a Backblaze B2 o Cloudflare R2, con restauración probada cada mes | | |

**Plan B:** si quien programa domina TypeScript y no PHP, Next.js 16 + Drizzle + Better Auth + PostgreSQL. El costo es tener que construir el back-office a mano.

### Simplificación del consolidador
Arquitectura propuso eventos de dominio con un *transactional outbox* entre módulos. Como es **una sola base de datos**, el cobro escribe la venta, los movimientos financieros y la comisión **en la misma transacción**: consistencia inmediata y sin eventos internos.

El outbox solo hace falta hacia afuera (WhatsApp, email). Para eso basta con jobs de Laravel despachados `afterCommit` sobre la cola en base de datos: es la misma tabla dentro de la misma transacción, que es en la práctica un outbox.

### Estructura de carpetas
```
villa/
├─ app/
│  ├─ Domain/
│  │  ├─ Booking/        # Appointment, Service, WorkSchedule; BookAppointment, ComputeAvailability
│  │  ├─ Sales/          # Sale, SaleItem, Payment; ChargeSale, VoidSale
│  │  ├─ Finance/        # FinEntry, CashSession, Expense; OpenCash, CloseCash
│  │  ├─ Commissions/    # CommissionRule; SettleCommissions
│  │  ├─ Clients/        # Client, Consent
│  │  ├─ Staff/          # Staff, roles
│  │  ├─ Locations/      # Location (tenant)
│  │  └─ Notifications/  # WhatsAppChannel, AppointmentReminder job
│  ├─ Filament/Admin/    # solo UI: llama a las acciones de Domain
│  ├─ Filament/Barber/
│  └─ Livewire/Booking/  # flujo público
├─ database/{migrations,seeders}
├─ resources/views/booking/
├─ routes/{web.php,console.php}
├─ tests/{Unit,Feature,Browser}
└─ docs/
```

**Regla:** la disponibilidad, los cobros, la caja y las comisiones viven en **acciones** que no conocen ni Filament ni HTTP, de modo que se prueban con tests unitarios.

**Convención:** el código y la base de datos van en **inglés**; la interfaz y la documentación, en **español**.

### Cuándo deja de servir esta decisión
- Si Villa se convierte en **SaaS para muchas barberías**: hace falta tenancy real, facturación de suscripciones e infraestructura redundante.
- Si se exige una app nativa.

---

## 8. Modelo de datos (resumen)

**Convenciones**
- Todas las tablas operativas llevan `location_id NOT NULL`, aunque haya una sola sede.
- **Dinero:** `bigint` en unidades menores más `currency char(3)`. Nunca `float` ni `money`.
- **Fechas:** `timestamptz` en UTC. Los horarios semanales se guardan como `time` local de la sede. El `business_date` es el día local de la sede y se guarda.
- **IDs:** `bigint` internos. Hacia afuera se exponen **ULID o tokens aleatorios** (128 bits o más, con expiración), nunca IDs consecutivos.
- **Soft delete:** `deleted_at` solo en catálogos y maestros. Citas y finanzas se cancelan o se revierten, nunca se borran. Los datos personales se **anonimizan**.

**Tablas:** `location`, `app_user`, `staff`, `client`, `consent`, `service`, `work_schedule`, `time_off`, `appointment`, `appointment_item`, `product`, `sale`, `sale_item`, `payment`, `cash_session`, `expense_category`, `fin_entry`, `audit_log`.

**Anti doble reserva** (la garantía está en la base de datos y la app solo traduce el error `23P01` a "horario ocupado"):
```sql
CONSTRAINT no_double_booking EXCLUDE USING gist
  (barber_id WITH =, during WITH &&)
  WHERE (status IN ('pending','confirmed','arrived','in_chair','completed'))
```
- El rango `during` es semiabierto, así que una cita de 10:00 a 10:30 y otra de 10:30 a 11:00 no chocan.
- Las validaciones contra horarios y ausencias se hacen con un trigger.

**Libro financiero `fin_entry`:**
- Solo admite INSERT. Un trigger prohíbe UPDATE, DELETE y TRUNCATE, y el rol de la app no tiene esos permisos.
- `reverses_id UNIQUE` hace que cada movimiento se revierta una sola vez.
- Columnas reservadas: `journal_entry_id` y `expense_category.account_code`.

**Integridad de la caja y las ventas:**
- Solo puede haber **una caja abierta por sede** (índice único parcial).
- Una venta `paid` queda sellada por trigger.

**Aislamiento por sede:** RLS con `SET LOCAL app.location_id` en cada transacción. Con pool de conexiones, siempre `SET LOCAL` y nunca `SET`.

---

## 9. Seguridad y datos personales

**P0, bloqueante para el lanzamiento:**
1. HTTPS y cabeceras de seguridad (HSTS, CSP, frame-ancestors).
2. Personal con Argon2id/bcrypt, **MFA para el dueño**, bloqueo por intentos y cookies HttpOnly, Secure y SameSite.
3. RBAC en el servidor con **tests automáticos de autorización** (cada rol contra cada ruta).
4. Reserva con OTP o enlace verificado: código de 6 dígitos, expiración de 5 minutos, 3–5 intentos y hash en la base de datos.
   - Rate limit por IP y teléfono.
   - CAPTCHA invisible (Turnstile) como segunda capa.
   - Límite de citas activas por teléfono.
5. Validación de entradas y escape de salidas; consultas parametrizadas mediante el ORM.
6. IDs no enumerables y tokens de gestión de cita con expiración.
7. Libro append-only y cobros **transaccionales e idempotentes** (clave de idempotencia en los POST).
8. Consentimiento con evidencia (fecha, versión del texto, IP) y **política de tratamiento publicada**.
9. Secretos fuera del repositorio (`.gitignore` desde el primer commit).
10. Backups cifrados.

**Abuso de WhatsApp:**
- Solo plantillas fijas, nunca texto del usuario.
- Cuota diaria por número y global, con alertas de gasto.

**Ley 1581 de 2012 (Colombia), si se confirma el país:**
- Casilla de autorización **no premarcada** al reservar.
- Consentimientos **separados** para los recordatorios y para el marketing.
- Funciones para consultar, rectificar, anonimizar y exportar los datos de un cliente.
- Plazos de respuesta: 10 días hábiles para consultas y 15 para reclamos.
- Contratos con los encargados del tratamiento (Meta, email, hosting).
- Validar con un abogado local.

---

## 10. Diseño y UX

**Dirección recomendada: "Navaja y Cuero"**, una barbería clásica de barrio.

| Token | Hex | Uso |
|---|---|---|
| Hueso | `#F4EFE6` | Fondo |
| Tinta | `#1C1A17` | Texto |
| Cuero | `#8A4B2A` | Acción principal (contraste aprox. 5,7:1 sobre hueso) |
| Verde botella | `#2F4A3A` | Estados y éxito |
| Latón | `#B8893B` | **Solo decorativo, nunca para texto** (no alcanza el contraste mínimo) |

- **Tipografía:** Fraunces para títulos y Public Sans para la interfaz, con **cifras tabulares** en los montos.
- **Detalle memorable:** la confirmación es un **ticket de turno** con borde perforado, número y hora.
- **Alternativa B, "Villa Urbana":** carbón, concreto y rojo. Se descarta porque el poste de barbería es un cliché y el fondo oscuro se lee peor en el mostrador.
- **Prioridad:** si el dueño ya tiene logo o colores, mandan los suyos.

**Dos superficies, dos tonos:**
- El **portal** es expresivo, mobile-first desde 360 px.
- El **panel** es sobrio y denso:
  - recepción en **tablet horizontal**, con zonas táctiles de 48 px o más;
  - barberos en **celular**;
  - el dueño en escritorio o celular.

**Panel por rol:**
- **Recepción:** agenda del día con una columna por barbero, cola de walk-ins y botón fijo **Cobrar**.
- **Barbero:** "Mi día", con el próximo cliente, sus notas y sus comisiones.
- **Dueño:** 4 indicadores de hoy contra el mismo día de la semana anterior, estado de la caja y alertas.

---

## 11. Accesibilidad (WCAG 2.2 AA)

- **Selector de fecha y hora:**
  - Lista de días y luego horarios como botones o `radiogroup`, no solo cuadrícula.
  - "No disponible" indicado con texto, no solo con color.
  - Anuncio con `role="status"`, por ejemplo "8 horarios disponibles".
- **Formularios:**
  - Etiquetas visibles y `autocomplete` (`name`, `tel`, `email`).
  - Errores en línea más un resumen con foco.
  - No se pierden los datos al retroceder.
- **Tablas financieras:** `<table>` real con `caption`, `th scope` y `tfoot`. Los gráficos llevan un resumen textual y una tabla equivalente.
- **Interacción:**
  - Zonas táctiles de 44 px como estándar.
  - Foco siempre visible.
  - Arrastrar y soltar con una alternativa ("Reprogramar").
- **CI:**
  - `@axe-core/playwright` en los flujos críticos (falla el build ante problemas *serious* o *critical*).
  - Lighthouse CI con un mínimo de 95.
  - Revisión manual con NVDA, VoiceOver o TalkBack en cada sprint.

> **v0.2:** con el cambio a Next.js y React se usa **React Aria Components**, tal como recomendó Accesibilidad. La nota siguiente solo aplicaba al stack de la v0.1.
>
> **Ajuste por el stack (v0.1):** Accesibilidad recomendó React Aria o Radix, pero el stack elegido es Livewire y Filament. En su lugar: **HTML nativo primero** (`<button>`, `<dialog>`, `<select>`), patrones APG implementados con Alpine.js, y **auditar con axe los componentes de Filament** que usemos. La agenda por columnas y el panel de cobro serán páginas Livewire propias, y ahí está el mayor esfuerzo de accesibilidad.

---

## 12. Plan del MVP

| Sprint | Contenido |
|---|---|
| **0 (semana 1, en paralelo)** | Iniciar la **verificación del negocio en Meta** y la aprobación de plantillas de WhatsApp, que toma días o semanas. Conseguir los insumos del dueño (§15). |
| **1. Fundaciones** | Scaffolding, CI, auth y roles, migraciones del modelo, sedes, catálogo de servicios, barberos y horarios, design tokens. |
| **2. Agenda** | Cálculo de disponibilidad, agenda interna por columnas, citas manuales y walk-ins, estados, bloqueos. |
| **3. Reserva pública y notificaciones** | Flujo del cliente, OTP, retención de huecos, enlaces para cancelar o reprogramar, recordatorios por WhatsApp y email, consentimiento. |
| **4. Cobro y caja** | Panel de cobro con pago mixto y propinas, `fin_entry`, apertura y cierre de caja, gastos, anulaciones. |
| **5. Comisiones, reportes y lanzamiento** | Liquidación, reporte de utilidad, exportación, dashboard, auditoría, pruebas con la barbería real y deploy. |

Si para el dueño lo contable es más urgente que la reserva pública, se intercambian los sprints 3 y 4.

---

## 13. Costos mensuales estimados (USD)

| Concepto | Costo |
|---|---|
| VPS | 5–12 |
| Forge (Coolify es gratis) | 0–12 |
| Dominio | ~1 |
| Backups | ~1 |
| Email (Resend, capa gratuita) | 0 |
| WhatsApp (~1.000 citas × 2 recordatorios) | ~2–20 (*confirmar la tarifa utility para Colombia en el rate card oficial de Meta*) |
| **Total** | **~10–45** |

La factura electrónica (Alegra o Siigo) y la pasarela de pagos se cobran aparte, si se activan.

---

## 14. Desacuerdos del equipo y cómo se resolvieron

| Tema | Posturas | Resolución |
|---|---|---|
| Alcance contable | Producto: algo simple. Arquitectura: partida doble ya. CTO: delegar lo formal. | Libro inmutable ahora, columnas reservadas para partida doble y lo formal a un proveedor externo (§2) |
| Tipo del dinero | Datos: `numeric(14,2)`. Seguridad, Arquitectura y CTO: enteros. | `bigint` en unidades menores |
| IDs | Datos: `bigint` identity. Seguridad: no enumerables. | `bigint` interno y ULID o tokens hacia afuera |
| Eventos internos | Arquitectura: outbox entre módulos | Una transacción interna; cola `afterCommit` solo para integraciones externas |
| Componentes accesibles | Accesibilidad: React Aria o Radix | No aplica a Livewire; HTML nativo, Alpine y auditoría de Filament |
| SMS | Seguridad lo contempla para el OTP; CTO lo descarta | WhatsApp y email; SMS solo si aparece un caso concreto |

---

## 15. Decisiones pendientes y preguntas al dueño

**Bloquean el inicio:**
1. ¿**Comprar o construir**? ¿Ya usan algo (Excel, AgendaPro, Booksy)? ¿Qué les falta?
2. ¿Es **solo para Villa** o se piensa **vender a otras barberías**?
3. ¿Qué lenguaje domina **quien va a programar**: PHP, TypeScript u otro?
4. ¿**País**? ¿Necesitan **factura electrónica** desde el inicio?

**Cambian el diseño:**
5. ¿Cuántos barberos y sedes tienen?
6. ¿Cómo se paga a los barberos: % por servicio, fijo, alquiler de silla o mixto? ¿Quién absorbe los descuentos y el costo del datáfono?
7. ¿Agendan hoy por WhatsApp?
8. ¿Venden productos? ¿Necesitan inventario?
9. ¿Qué métodos de pago usan (datáfono, Nequi/Daviplata, transferencia)?
10. ¿Qué dispositivo hay en caja? ¿El internet es confiable?
11. ¿Tienen datos históricos para migrar?
12. ¿Políticas de cancelación, inasistencias y propinas?

**Insumos a pedir:**
- Logo (ideal en SVG) y fotos de la fachada, del interior y de cada barbero.
- 8–12 fotos de cortes.
- Instagram y referencias que les gusten.
- Lista de servicios con precio y duración.
- Horarios por barbero.
- Categorías de gasto.
- Qué reporte pide su contador.
- Si tratan a los clientes de "tú" o de "usted".

---

## 16. Riesgos principales

| Riesgo | Mitigación |
|---|---|
| El alcance de "contabilidad" se infla | Dejar por escrito lo que el sistema no hace (§2) |
| Doble reserva y zonas horarias | Constraint en PostgreSQL; UTC y `America/Bogota` en un solo punto de conversión |
| La aprobación de WhatsApp en Meta tarda | Iniciarla en la semana 1; el email funciona como respaldo |
| Fraude interno (caja y comisiones) | Libro inmutable, anulaciones con aprobación, comisión calculada por el servidor, alertas |
| Bots o spam llenan la agenda | OTP, rate limit, límite de citas activas por teléfono y expiración de pendientes |
| Un solo VPS es un punto único de falla | Backups probados cada mes y monitoreo de uptime |
| Curva de aprendizaje de Laravel | 2–3 semanas de arranque, o activar el plan B (TypeScript) |
