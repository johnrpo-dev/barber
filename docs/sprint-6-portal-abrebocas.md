# Sprint 6: portada pública como abrebocas

La portada de antes era correcta pero plana para una barbería: puro texto, sin ritmo y sin nada que
llamara la atención. Se necesitaba un "abrebocas" para presentarle el sistema al dueño de Barbería
Villa, y que después siguiera siendo la página real de la barbería. Amplía, solo para la portada,
[sprint-3-diseno-portal.md](sprint-3-diseno-portal.md).

## Cómo se decidió

1. **El agente de front** propuso la dirección, con las tendencias de 2025-2026 y sus fuentes.
2. **Lo discutieron tres voces más:**
   - un crítico de UX, accesibilidad y rendimiento;
   - un crítico comercial;
   - el CTO, que decidió los cambios de esquema y los tokens.
3. **Síntesis:** lo que quedó y lo que se descartó, con sus razones, está abajo.

## Qué quedó

**Franja oscura (`.banda-tinta`) solo en el hero.**
- El resto de la página sigue en hueso, igual que el flujo de reserva.
- Dentro de la franja, `--focus` pasa a hueso. El foco en cuero sobre tinta da 2,4:1 y no se vería.
- El latón sigue siendo solo filete o borde, nunca texto.
- No hubo token nuevo de latón claro. Las cifras van en hueso, así que la regla de CLAUDE.md no cambia.

**"Abierto ahora · cierra a las 9:00 p. m."**
- Lo calcula `openStatus` (`src/domain/booking/open-status.ts`), una función pura sobre el horario de la sede, que es la unión de los turnos.
- Usa la hora local de la sede.
- Tiene pruebas de ejemplo y de propiedades.

**Tres cifras del local:** barberos, servicios y "En línea 24/7".
- Se descartó "Desde $X": con el catálogo real decía "Desde $4.000" (las cejas), y eso abarata la marca.

**"Lo que más piden"** (`loadPortalData` → `featured`):
- Muestra los 6 servicios con más citas en firme (confirmadas, en curso o atendidas) de los últimos 60 días, futuras incluidas.
- El conteo es en SQL y usa el índice `(location_id, lower(during))`.
- Las retenciones sin verificar no cuentan, porque cualquiera las crea desde la web y así se podría inflar el ranking. Tampoco cuentan las canceladas ni los "no vino".
- Sin citas, usa el orden del catálogo y el título pasa a "La carta", para no afirmar algo que no es cierto.
- El resto de servicios queda en un `<details>` nativo, en orden alfabético. No necesita JS y ya había precedente en el repositorio. El CTO lo prefirió a una ruta `/servicios`.

**"Así reservas"**, en 3 pasos.
- Aclara que el código solo se omite si se reservó **desde ese mismo celular** (cookie del dispositivo). Prometer "sin código" a secas sería falso.

**"El equipo"** en grilla, no en carrusel. Con 10 barberos, un carrusel esconde 8 sin dar ninguna pista de que existen.

**Ticket de muestra** solo en pantallas anchas.
- En el celular empujaba la carta fuera de la primera pantalla.
- La fecha ahora es la de mañana, no una fecha fija que ya pasó.

**Movimiento solo con CSS** (`globals.css`):
- `.entrar`: entrada escalonada del hero. El H1 no se anima, porque retrasaría el LCP.
- `.revelar`: filas con `animation-timeline: view()`, dentro de `@supports`.
- Todo va dentro de `@media (prefers-reduced-motion: no-preference)` y se anula al imprimir.
- Sin soporte del navegador, todo se ve igual, solo que sin animación.

**Fotos de referencia** (`src/content/portal-photos`):
- Son 7 fotos de Unsplash (licencia libre). **No son de Barbería Villa**; el autor de cada una queda en el manifiesto.
- Hero: en el celular, la foto va debajo del texto; en pantallas anchas, a la derecha con el ticket de muestra montado encima.
- "El local": un mosaico de 6 fotos, con 2 columnas en el celular y 4 en pantallas anchas.
- Se sirven con `next/image` desde el propio servidor: nada de terceros y la CSP no cambia. Next genera AVIF o WebP según el ancho y muestra un desenfoque mientras cargan.
- Solo se ven con `showsReferencePhotos()`: en desarrollo, o con `PORTAL_REFERENCE_PHOTOS=1` en el staging de la demo. En producción, sin la variable, desaparecen el hero con foto y la galería (hay una prueba de esto). Presentar fotos ajenas como del local sería engañar al cliente.
- Mientras sean de referencia, la del hero lleva la marca "Foto de referencia" y la galería lo dice en su subtítulo.
- Para cambiarlas por las reales: se reemplazan los archivos con el mismo nombre y `reference` pasa a `false`.
- El equipo sigue con iniciales: poner caras de desconocidos sobre nombres de barberos, aunque sea de prueba, se presta a confusión. Las fotos del equipo entran cuando haya autorización escrita de cada barbero.

**Sin dependencias nuevas y sin JS nuevo.** Las únicas islas siguen siendo la barra fija y el botón de la cabecera.

**`seed-demo`:**
- Carga los 12 servicios que la barbería publica hoy, con su precio y duración, en el orden de lo más pedido allá.
- También la dirección.
- Y diez barberos con **nombres inventados**: los del equipo real son datos personales (Ley 1581) y no van al repositorio.

## Qué se descartó y por qué

| Propuesta | Decisión | Razón |
|---|---|---|
| Calificación de Weibook (4,9 · 586) en el hero | No | Es prueba prestada de la plataforma que se quiere reemplazar. Se queda allá si el dueño se va, y mandaría al cliente a Weibook. Si se muestra algo, que sean reseñas de Google Maps del propio negocio, con fuente y fecha. |
| `featured_rank`, `public_tagline`, `photo_path`, calificación en la sede | Después | Habría que hacer migración, grants y pruebas para algo que el cliente aún no ha comprado. Las fotos piden además subida de archivos, ampliar la CSP y la autorización de cada barbero. |
| Eje `opsz` de Fraunces | No | Más KB de fuente en celulares con datos limitados, por una ganancia solo estética. Se reabre con una medición. |
| "Próximo turno libre" en el hero | Después | Calcular la disponibilidad de todos los barberos en cada visita anónima abre la puerta al abuso. Con caché, podría mostrar un turno ya tomado. |
| Grano SVG `feTurbulence`, cabecera oscura, tirilla en el celular | No | Repinta en Android de gama media; basta un solo bloque oscuro; la tirilla empujaba el contenido. |
| Imagen Open Graph y `LocalBusiness` | Sprint 9 | Necesitan URL absolutas, y el dominio llega en el lanzamiento. Es lo que se ve al compartir el enlace por WhatsApp. |

## Lo que falta y no es código

- **Fotos reales:** la fachada, el local y cortes hechos ahí, con permiso del dueño, y autorización escrita de cada barbero si sale su cara. Hoy hay fotos de referencia que solo salen en desarrollo o en la demo. Sin fotos reales, en producción la página vuelve a ser tipográfica.
- **Para la reunión:** la página pública es la vitrina, pero lo que diferencia al sistema de Weibook es la caja, el cierre del día y la liquidación a barberos que siempre cuadran. Hay que mostrar eso con los datos de la barbería. La base con un mes de operación y el guion están en [demo.md](demo.md).
- **Lo que no se debe prometer:** menos inasistencias ni más ventas sin medirlo, que reemplaza a Weibook desde el primer día (mejor correr los dos en paralelo un mes), ni soporte 24/7.
- **Tener respuesta a "¿y si usted desaparece?":** código, documentación y un plan de continuidad.

## Costo por visita

La portada se pinta en cada petición (`force-dynamic`). Hace la lectura de la sede, la de los servicios con su conteo y la de los horarios.
- A la escala de una sede es poco.
- Si el tráfico de bots se nota, el conteo (que cambia despacio) puede ir en una caché de 60 s, dejando "abierto ahora" fuera de ella.
