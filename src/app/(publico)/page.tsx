import { ArrowRight, ChevronDown, MapPin, MessageCircle, Phone } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { GALLERY_PHOTOS, HERO_PHOTO, type PortalPhoto } from "@/content/portal-photos";
import { addDays, isoWeekday } from "@/domain/booking/clock";
import { formatDateLabel } from "@/domain/booking/public-labels";
import { showsReferencePhotos } from "@/lib/public-readiness";
import { getPortal, telHref } from "./_lib/portal";
import { cx, linkBtn, plural } from "./_lib/ui";
import { StickyCta } from "./_components/cta";
import { primaryCta } from "./_components/portal-chrome";
import { Ticket } from "./_components/ticket";
import type { PortalView } from "./data";

// Inicio: la página de la sede (docs/sprint-6-portal-abrebocas.md). Server Component; el único JS de
// cliente son la barra fija y el botón de la cabecera. El movimiento es CSS (globals.css: .entrar,
// .revelar) y se apaga con "reducir movimiento". Se pinta por petición (lee la base; ver layout.tsx).
export const dynamic = "force-dynamic";

const HERO_ID = "inicio-hero";

type Service = PortalView["services"][number];

export default async function HomePage() {
  const portal = await getPortal();
  const cta = primaryCta(portal);
  const enabled = portal?.enabled ?? false;
  const location = portal?.location;
  const whatsapp = location?.whatsappUrl ?? null;

  const byId = new Map(portal?.services.map((s) => [s.id, s]) ?? []);
  const featured = (portal?.featured ?? []).map((id) => byId.get(id)).filter((s): s is Service => Boolean(s));
  const featuredIds = new Set(featured.map((s) => s.id));
  const rest = (portal?.services ?? []).filter((s) => !featuredIds.has(s.id));

  // Fotos: las de referencia (Unsplash) solo en desarrollo o en el staging de la demo.
  const photoAllowed = (p: PortalPhoto) => !p.reference || showsReferencePhotos();
  const heroPhoto = photoAllowed(HERO_PHOTO) ? HERO_PHOTO : null;
  const gallery = GALLERY_PHOTOS.filter(photoAllowed);
  const ticketData = {
    code: "V-4K7Q",
    timeLabel: "10:30 a. m.",
    dateLabel: portal ? formatDateLabel(addDays(portal.today, 1)) : null,
    serviceName: featured[0]?.name ?? "Corte",
    staffName: portal?.staff[0]?.name ?? null,
    durationMin: featured[0]?.durationMin ?? 40,
    priceLabel: featured[0]?.priceLabel ?? null,
    address: location?.address ?? null,
    stamp: { label: "Confirmada", tone: "confirmed" as const },
  };

  return (
    <main>
      {/* ─── Hero: la franja oscura ───────────────────────────────────────── */}
      <section id={HERO_ID} aria-labelledby="inicio-h" className="banda-tinta">
        <div className="mx-auto max-w-2xl px-4 pb-12 pt-10 md:pt-16 lg:grid lg:max-w-6xl lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-center lg:gap-16 lg:pb-20">
          <div className="flex flex-col gap-5">
            <p className="entrar text-xs font-semibold uppercase tracking-[0.2em] text-hueso/70">
              Barbería
              {location?.address ? (
                <>
                  {" · "}
                  {location.mapsUrl ? (
                    <a
                      href={location.mapsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="-my-3 inline-block py-3 underline decoration-hueso/60 underline-offset-4 hover:decoration-hueso"
                    >
                      {location.address}
                      <span className="sr-only"> (cómo llegar; el mapa se abre en una pestaña nueva)</span>
                    </a>
                  ) : (
                    location.address
                  )}
                </>
              ) : null}
            </p>

            {portal ? (
              <p className="entrar inline-flex w-fit items-center gap-2 rounded-full border border-hueso/25 px-3 py-1.5 text-sm [animation-delay:60ms]">
                <span aria-hidden className={cx("size-2 rounded-full", portal.openNow.open ? "bg-laton" : "bg-hueso/40")} />
                {portal.openNow.label}
              </p>
            ) : null}

            <h1 id="inicio-h" className="font-display text-[clamp(2.75rem,12vw,4.75rem)] leading-[0.95] tracking-[-0.02em] text-balance">
              Corte fino, sin afán.
            </h1>
            <p className="entrar max-w-[40ch] text-lg text-hueso/80 [animation-delay:120ms]">
              {enabled
                ? "Elige servicio, barbero y hora en un minuto. Te confirmamos por WhatsApp."
                : "Llámanos o escríbenos y te buscamos un turno."}
            </p>

            <div className="entrar flex flex-wrap items-center gap-3 [animation-delay:180ms]">
              {cta ? (
                cta.external ? (
                  <a href={cta.href} className={linkBtn("primary", "xl", "ring-1 ring-laton")}>
                    {cta.href.startsWith("tel:") ? <Phone size={20} aria-hidden /> : null}
                    {cta.label}
                  </a>
                ) : (
                  <Link href={cta.href} className={linkBtn("primary", "xl", "ring-1 ring-laton")}>
                    Reservar mi turno
                    <ArrowRight size={20} aria-hidden />
                  </Link>
                )
              ) : null}
              {whatsapp && cta?.href !== whatsapp ? (
                <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={linkBtn("onDark", "lg")}>
                  <MessageCircle size={18} aria-hidden /> Escribir por WhatsApp
                  <span className="sr-only"> (se abre en una pestaña nueva)</span>
                </a>
              ) : null}
            </div>
            {!portal ? <p className="text-sm text-hueso/70">Muy pronto podrás reservar desde aquí.</p> : null}

            {portal && portal.services.length > 0 ? (
              <dl className="entrar mt-3 grid grid-cols-3 divide-x divide-hueso/15 border-t border-hueso/15 pt-5 [animation-delay:240ms]">
                <HeroFact label="Equipo" value={String(portal.staff.length)} first />
                <HeroFact label="Servicios" value={String(portal.services.length)} />
                {enabled ? <HeroFact label="En línea" value="24/7" /> : null}
              </dl>
            ) : null}
          </div>

          {heroPhoto ? (
            // Con foto: debajo del texto en el celular; a la derecha en pantallas anchas, con el
            // ticket de muestra montado encima (solo decorativo).
            <div className="entrar relative mt-10 [animation-delay:200ms] lg:mt-0">
              <div className="relative aspect-[4/3] overflow-hidden rounded-2xl ring-1 ring-laton/50 lg:aspect-[4/5]">
                <Image
                  src={heroPhoto.src}
                  alt={heroPhoto.alt}
                  fill
                  sizes="(min-width: 1024px) 24rem, (min-width: 672px) 40rem, 100vw"
                  placeholder="blur"
                  className="object-cover"
                />
                {heroPhoto.reference ? <ReferenceTag /> : null}
              </div>
              <div aria-hidden className="absolute -bottom-16 -left-20 hidden w-[19rem] origin-bottom-left scale-[0.8] lg:block">
                <Ticket headingId="ticket-muestra-h" className="-rotate-3 text-tinta" data={ticketData} />
              </div>
            </div>
          ) : (
            // Sin foto: el ticket solo, y solo en pantallas anchas (en el celular empujaría la carta).
            <div aria-hidden className="entrar hidden [animation-delay:200ms] lg:block">
              <Ticket headingId="ticket-muestra-h" className="rotate-2 text-tinta" data={ticketData} />
            </div>
          )}
        </div>
      </section>

      {/* ─── Lo que más piden ─────────────────────────────────────────────── */}
      {portal && featured.length > 0 ? (
        <section aria-labelledby="carta-h" className="mx-auto max-w-2xl px-4 pb-6 pt-14 lg:max-w-6xl">
          <SectionHeading id="carta-h" title={portal.featuredByDemand ? "Lo que más piden" : "La carta"}>
            {portal.featuredByDemand ? "Los servicios más reservados de los últimos dos meses." : "Precio y duración, sin sorpresas."}
          </SectionHeading>
          <ol role="list" className="mt-6 grid gap-x-12 md:grid-cols-2">
            {featured.map((s, i) => (
              <li key={s.id} className="revelar border-b border-tinta/10">
                <ServiceRow service={s} enabled={enabled} number={String(i + 1).padStart(2, "0")} />
              </li>
            ))}
          </ol>
          {rest.length > 0 ? (
            <details className="group mt-6">
              <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 font-semibold text-cuero underline underline-offset-4 [&::-webkit-details-marker]:hidden">
                Otros servicios ({rest.length})
                <ChevronDown size={18} aria-hidden className="transition-transform group-open:rotate-180" />
              </summary>
              <ul role="list" className="mt-2 grid gap-x-12 md:grid-cols-2">
                {[...rest]
                  .sort((a, b) => a.name.localeCompare(b.name, "es"))
                  .map((s) => (
                    <li key={s.id} className="border-b border-tinta/10">
                      <ServiceRow service={s} enabled={enabled} />
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {/* ─── El local ─────────────────────────────────────────────────────── */}
      {gallery.length > 0 ? (
        <section aria-labelledby="local-h" className="mx-auto max-w-2xl px-4 py-10 lg:max-w-6xl">
          <SectionHeading id="local-h" title="El local">
            {gallery.some((p) => p.reference)
              ? "Fotos de referencia: aquí van las de la barbería."
              : "Pasa cuando quieras: aquí te esperamos."}
          </SectionHeading>
          <ul role="list" className="mt-6 grid auto-rows-[10.5rem] grid-cols-2 gap-2 sm:auto-rows-[13rem] lg:grid-cols-4 lg:gap-3">
            {gallery.map((photo, i) => (
              <li key={photo.src.src} className={cx("revelar relative overflow-hidden rounded-xl bg-tinta/10", GALLERY_LAYOUT[i % GALLERY_LAYOUT.length])}>
                <Image
                  src={photo.src}
                  alt={photo.alt}
                  fill
                  sizes="(min-width: 1024px) 36rem, (min-width: 672px) 40rem, 100vw"
                  placeholder="blur"
                  className="object-cover transition-transform duration-500 ease-[var(--ease-villa)] hover:scale-[1.03]"
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ─── Así reservas ─────────────────────────────────────────────────── */}
      {enabled ? (
        <section aria-labelledby="pasos-h" className="mx-auto max-w-2xl px-4 py-10 lg:max-w-6xl">
          <SectionHeading id="pasos-h" title="Así reservas">
            Sin llamar, sin descargar nada y sin crear cuenta.
          </SectionHeading>
          <ol role="list" className="mt-6 grid gap-3 md:grid-cols-3">
            {(portal?.requiresCode ? STEPS : STEPS_WITHOUT_CODE).map((step, i) => (
              <li key={step.title} className="revelar flex gap-4 rounded-xl border border-tinta/10 bg-papel p-5 md:flex-col md:gap-3">
                <span aria-hidden className="monto font-display text-4xl leading-none text-cuero">
                  {i + 1}
                </span>
                <span className="flex flex-col gap-1">
                  <span className="font-semibold">{step.title}</span>
                  <span className="text-sm text-tinta/75">{step.body}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-sm text-tinta/75">
            {portal?.requiresCode
              ? "¿Ya reservaste desde este celular? Te reconocemos y no te pedimos el código otra vez."
              : "¿Ya reservaste desde este celular? Te reconocemos y no tienes que escribir tus datos otra vez."}
          </p>
        </section>
      ) : null}

      {/* ─── El equipo ────────────────────────────────────────────────────── */}
      {portal && portal.staff.length > 0 ? (
        <section aria-labelledby="barberos-h" className="mx-auto max-w-2xl px-4 py-10 lg:max-w-6xl">
          <SectionHeading id="barberos-h" title="El equipo">
            {plural(portal.staff.length, "profesional", "profesionales")}. Elige con quién, o déjanos asignarte el primero libre.
          </SectionHeading>
          <ul role="list" className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {portal.staff.map((p) => {
              const card = (
                <>
                  <span
                    aria-hidden
                    className="grid size-14 place-items-center rounded-full bg-tinta font-display text-xl text-hueso ring-2 ring-laton ring-offset-2 ring-offset-papel"
                  >
                    {p.initials}
                  </span>
                  <span className="font-semibold leading-tight">{p.name}</span>
                  {enabled ? <span className="mt-auto text-sm font-semibold text-cuero">Reservar con {p.name.split(/\s+/)[0]}</span> : null}
                </>
              );
              const cls = "flex h-full flex-col items-start gap-3 rounded-xl border border-tinta/10 bg-papel p-4";
              return (
                <li key={p.id} className="revelar">
                  {enabled ? (
                    <Link href={`/reservar?barbero=${encodeURIComponent(p.id)}`} className={cx(cls, "transition-colors hover:border-tinta/30")}>
                      {card}
                    </Link>
                  ) : (
                    <div className={cls}>{card}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* ─── Horario y ubicación ──────────────────────────────────────────── */}
      {portal ? <HoursAndPlace portal={portal} whatsapp={whatsapp} /> : null}

      {/* Espacio para que la barra fija no tape el final en móvil. */}
      {cta ? (
        <>
          <div aria-hidden className="h-20 md:hidden" />
          <StickyCta cta={cta} watchId={HERO_ID} />
        </>
      ) : null}
    </main>
  );
}

const STEPS = [
  { title: "Elige el servicio", body: "Con el precio y la duración a la vista." },
  { title: "Escoge barbero y hora", body: "Solo ves turnos libres de verdad. Si te da igual el barbero, te damos el primero libre." },
  { title: "Confirma por WhatsApp", body: "Te llega un código, lo escribes y tu turno queda apartado." },
] as const;

/** Sin código (por defecto, sprint 7): el último paso es dejar el nombre y el celular. */
const STEPS_WITHOUT_CODE = [
  STEPS[0],
  STEPS[1],
  { title: "Deja tu nombre y celular", body: "Tu turno queda confirmado al instante y te llega la confirmación por WhatsApp." },
] as const;

// Mosaico de la galería: en el celular, 2 columnas; en pantallas anchas, 4 (ver el orden en
// src/content/portal-photos). Las filas tienen alto fijo y cada foto se recorta con object-cover.
const GALLERY_LAYOUT = ["col-span-2 lg:row-span-2", "row-span-2", "row-span-2", "col-span-2", "", ""] as const;

/** Marca visible en las fotos que no son del local (para que nadie las tome por reales). */
function ReferenceTag() {
  return (
    <span className="absolute right-3 top-3 rounded-full bg-tinta/80 px-2.5 py-1 text-xs font-semibold text-hueso">
      Foto de referencia
    </span>
  );
}

function SectionHeading({ id, title, children }: { id: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div aria-hidden className="h-px w-12 bg-laton" />
      <h2 id={id} className="font-display text-3xl md:text-4xl">
        {title}
      </h2>
      {children ? <p className="max-w-[52ch] text-tinta/75">{children}</p> : null}
    </div>
  );
}

function HeroFact({ label, value, first }: { label: string; value: string; first?: boolean }) {
  return (
    <div className={cx("flex flex-col gap-1", first ? "pr-3" : "px-3")}>
      <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-hueso/65">{label}</dt>
      <dd className="monto font-display text-2xl leading-none md:text-3xl">{value}</dd>
    </div>
  );
}

function ServiceRow({ service: s, enabled, number }: { service: Service; enabled: boolean; number?: string }) {
  const row = (
    <>
      {number ? (
        <span aria-hidden className="monto w-8 shrink-0 pt-0.5 font-display text-xl text-cuero">
          {number}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-3">
          <span className="font-semibold">{s.name}</span>
          <span aria-hidden className="min-w-6 flex-1 translate-y-[-0.25em] border-b-2 border-dotted border-laton/60" />
          <span className="monto font-semibold">{s.priceLabel}</span>
        </span>
        <span className="text-sm text-tinta/70">{s.durationMin} min</span>
      </span>
    </>
  );
  return enabled ? (
    <Link href={`/reservar?servicio=${encodeURIComponent(s.id)}`} className="flex min-h-11 gap-3 py-3.5 hover:bg-tinta/[0.03]">
      {row}
      <span className="sr-only">, reservar</span>
    </Link>
  ) : (
    <div className="flex gap-3 py-3.5">{row}</div>
  );
}

function HoursAndPlace({ portal, whatsapp }: { portal: PortalView; whatsapp: string | null }) {
  const todayWeekday = isoWeekday(portal.today);
  const location = portal.location;
  const tel = telHref(location.publicPhone);
  return (
    <section aria-labelledby="horario-h" className="mx-auto max-w-2xl px-4 py-10 lg:max-w-6xl">
      <SectionHeading id="horario-h" title="Horario y ubicación" />
      <div className="mt-6 grid gap-8 md:grid-cols-2">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-tinta/10 bg-papel text-sm">
          {[...portal.hours]
            .sort((a, b) => a.weekday - b.weekday)
            .map((h) => {
              const isToday = h.weekday === todayWeekday;
              return (
                <div key={h.weekday} className={cx("col-span-2 grid grid-cols-subgrid gap-x-6 px-4 py-2.5", isToday && "bg-botella/10 font-semibold text-botella")}>
                  <dt>
                    {h.label}
                    {isToday ? <span className="sr-only"> (hoy)</span> : null}
                  </dt>
                  <dd className="monto">{h.ranges.length ? h.ranges.join(" · ") : "Cerrado"}</dd>
                </div>
              );
            })}
        </dl>
        <div className="flex flex-col gap-4">
          {location.address ? (
            <p className="flex items-start gap-2 text-base">
              <MapPin size={20} aria-hidden className="mt-0.5 shrink-0 text-botella" />
              {location.address}
            </p>
          ) : null}
          {location.publicPhone && tel ? (
            <p className="flex items-center gap-2 text-base">
              <Phone size={20} aria-hidden className="shrink-0 text-botella" />
              <a href={tel} className="monto font-semibold underline underline-offset-4">
                {location.publicPhone}
              </a>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {location.mapsUrl ? (
              <a href={location.mapsUrl} target="_blank" rel="noopener noreferrer" className={linkBtn("secondary", "lg")}>
                <MapPin size={18} aria-hidden /> Cómo llegar
                <span className="sr-only"> (se abre en una pestaña nueva)</span>
              </a>
            ) : null}
            {whatsapp ? (
              <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={linkBtn("secondary", "lg")}>
                <MessageCircle size={18} aria-hidden /> WhatsApp
                <span className="sr-only"> (se abre en una pestaña nueva)</span>
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
