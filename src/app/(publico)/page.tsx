import { MapPin, MessageCircle, Phone } from "lucide-react";
import Link from "next/link";
import { isoWeekday } from "@/domain/booking/clock";
import { getPortal, telHref } from "./_lib/portal";
import { cx, linkBtn } from "./_lib/ui";
import { StickyCta } from "./_components/cta";
import { primaryCta } from "./_components/portal-chrome";
import { Ticket } from "./_components/ticket";

// Inicio: la página de la sede. Server Component; el único JS de cliente es la barra fija.
// Se pinta por petición (lee la base; ver layout.tsx).
export const dynamic = "force-dynamic";

const HERO_ID = "inicio-hero";

export default async function HomePage() {
  const portal = await getPortal();
  const cta = primaryCta(portal);
  const enabled = portal?.enabled ?? false;
  const location = portal?.location;
  const todayWeekday = portal ? isoWeekday(portal.today) : null;
  const whatsapp = location?.whatsappUrl ?? null;
  const tel = telHref(location?.publicPhone);
  const sample = portal?.services[0];

  return (
    <main>
      {/* ─── Hero ─────────────────────────────────────────────────────────── */}
      <section id={HERO_ID} aria-labelledby="inicio-h" className="mx-auto max-w-2xl px-4 pb-12 pt-10 md:pt-16 lg:grid lg:max-w-6xl lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center lg:gap-16">
        <div className="flex flex-col gap-5">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-botella">
            Barbería de barrio{location?.address ? ` · ${location.address}` : ""}
          </p>
          <h1 id="inicio-h" className="font-display text-5xl leading-[1.05] md:text-6xl lg:text-7xl">
            Corte fino, sin afán.
          </h1>
          <p className="max-w-[40ch] text-lg text-tinta/80">
            {enabled ? "Reserva en un minuto. Te confirmamos por WhatsApp." : "Llámanos o escríbenos y te buscamos un turno."}
          </p>
          <div aria-hidden className="h-px w-16 bg-laton" />
          <div className="flex flex-wrap gap-3">
            {cta ? (
              cta.external ? (
                <a href={cta.href} className={linkBtn("primary", "xl")}>
                  {cta.href.startsWith("tel:") ? <Phone size={20} aria-hidden /> : null}
                  {cta.label}
                </a>
              ) : (
                <Link href={cta.href} className={linkBtn("primary", "xl")}>
                  {cta.label}
                </Link>
              )
            ) : null}
            {whatsapp && cta?.href !== whatsapp ? (
              <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={linkBtn("secondary", "xl")}>
                <MessageCircle size={20} aria-hidden /> Escríbenos
              </a>
            ) : null}
          </div>
          {!portal ? <p className="text-sm text-tinta/70">Muy pronto podrás reservar desde aquí.</p> : null}
        </div>
        {/* Ticket de muestra, solo decorativo. */}
        <div aria-hidden className="hidden lg:block">
          <Ticket
            headingId="ticket-muestra-h"
            className="rotate-2"
            data={{
              code: "V-4K7Q",
              timeLabel: "3:30 p. m.",
              dateLabel: "jueves 30 de octubre",
              serviceName: sample?.name ?? "Corte clásico",
              staffName: portal?.staff[0]?.name ?? null,
              durationMin: sample?.durationMin ?? 45,
              priceLabel: sample?.priceLabel ?? null,
              address: location?.address ?? null,
              stamp: { label: "Confirmada", tone: "confirmed" },
            }}
          />
        </div>
      </section>

      {/* ─── La carta ─────────────────────────────────────────────────────── */}
      {portal && portal.services.length > 0 ? (
        <section aria-labelledby="carta-h" className="mx-auto max-w-2xl px-4 py-10 lg:max-w-6xl">
          <h2 id="carta-h" className="font-display text-3xl">
            La carta
          </h2>
          <ul className="mt-4 grid gap-x-12 md:grid-cols-2">
            {portal.services.map((s) => {
              const row = (
                <>
                  <span className="flex items-baseline gap-3">
                    <span className="font-semibold">{s.name}</span>
                    <span aria-hidden className="min-w-6 flex-1 translate-y-[-0.25em] border-b-2 border-dotted border-laton/60" />
                    <span className="monto font-semibold">{s.priceLabel}</span>
                  </span>
                  <span className="text-sm text-tinta/70">{s.durationMin} min</span>
                </>
              );
              return (
                <li key={s.id} className="border-b border-tinta/10">
                  {enabled ? (
                    <Link href={`/reservar?servicio=${encodeURIComponent(s.id)}`} className="flex min-h-11 flex-col gap-0.5 py-3 hover:bg-tinta/[0.03]">
                      {row}
                      <span className="sr-only">, reservar</span>
                    </Link>
                  ) : (
                    <div className="flex flex-col gap-0.5 py-3">{row}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* ─── Barberos ─────────────────────────────────────────────────────── */}
      {portal && portal.staff.length > 0 ? (
        <section aria-labelledby="barberos-h" className="mx-auto max-w-2xl px-4 py-10 lg:max-w-6xl">
          <h2 id="barberos-h" className="font-display text-3xl">
            Barberos
          </h2>
          <ul className="-mx-4 mt-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-3 md:overflow-visible md:px-0 lg:grid-cols-4">
            {portal.staff.map((p) => {
              const card = (
                <>
                  <span aria-hidden className="grid h-14 w-14 place-items-center rounded-full bg-botella font-semibold text-hueso">
                    {p.initials}
                  </span>
                  <span className="font-semibold">{p.name}</span>
                  {enabled ? <span className="text-sm font-semibold text-cuero">Reservar con {p.name.split(/\s+/)[0]}</span> : null}
                </>
              );
              const cls = "flex h-full flex-col items-start gap-2 rounded-xl border border-tinta/10 bg-papel p-4";
              return (
                <li key={p.id} className="w-44 shrink-0 snap-start md:w-auto">
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
      {portal ? (
        <section aria-labelledby="horario-h" className="mx-auto max-w-2xl px-4 py-10 lg:max-w-6xl">
          <h2 id="horario-h" className="font-display text-3xl">
            Horario y ubicación
          </h2>
          <div className="mt-4 grid gap-8 md:grid-cols-2">
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
              {location?.address ? (
                <p className="flex items-start gap-2 text-base">
                  <MapPin size={20} aria-hidden className="mt-0.5 shrink-0 text-botella" />
                  {location.address}
                </p>
              ) : null}
              {location?.publicPhone && tel ? (
                <p className="flex items-center gap-2 text-base">
                  <Phone size={20} aria-hidden className="shrink-0 text-botella" />
                  <a href={tel} className="monto font-semibold underline underline-offset-4">
                    {location.publicPhone}
                  </a>
                </p>
              ) : null}
              <div className="flex flex-wrap gap-3">
                {location?.mapsUrl ? (
                  <a href={location.mapsUrl} target="_blank" rel="noopener noreferrer" className={linkBtn("secondary", "lg")}>
                    <MapPin size={18} aria-hidden /> Cómo llegar
                  </a>
                ) : null}
                {whatsapp ? (
                  <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={linkBtn("secondary", "lg")}>
                    <MessageCircle size={18} aria-hidden /> WhatsApp
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      ) : null}

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
