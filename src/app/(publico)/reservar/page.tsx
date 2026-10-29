import { MessageCircle, Phone } from "lucide-react";
import type { Metadata } from "next";
import { getPortal, telHref } from "../_lib/portal";
import { linkBtn } from "../_lib/ui";
import { BookingFlow } from "./_components/booking-flow";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reservar" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

export default async function ReservarPage({ searchParams }: { searchParams: SearchParams }) {
  const [portal, sp] = await Promise.all([getPortal(), searchParams]);

  if (!portal || !portal.enabled) {
    const tel = telHref(portal?.location.publicPhone);
    const whatsapp = portal?.location.whatsappUrl ?? null;
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-12">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-botella">Reservas</p>
        <h1 className="font-display text-4xl leading-tight">Por ahora reservamos por teléfono</h1>
        <div aria-hidden className="h-px w-16 bg-laton" />
        <p className="text-lg text-tinta/80">
          {tel || whatsapp ? "Llámanos o escríbenos y te buscamos un turno." : "La reserva en línea no está disponible en este momento. Vuelve a intentarlo más tarde."}
        </p>
        <div className="flex flex-wrap gap-3">
          {tel ? (
            <a href={tel} className={linkBtn("primary", "xl")}>
              <Phone size={20} aria-hidden /> Llámanos para reservar
            </a>
          ) : null}
          {whatsapp ? (
            <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={linkBtn("secondary", "xl")}>
              <MessageCircle size={20} aria-hidden /> WhatsApp
            </a>
          ) : null}
        </div>
      </main>
    );
  }

  const servicio = one(sp.servicio);
  const barbero = one(sp.barbero);
  const initialServiceId = servicio && portal.services.some((s) => s.id === servicio) ? servicio : null;
  const initialStaffId = barbero && portal.staff.some((p) => p.id === barbero) ? barbero : null;

  return (
    <main>
      <BookingFlow
        key={`${initialServiceId ?? ""}|${initialStaffId ?? ""}`}
        initialServiceId={initialServiceId}
        initialStaffId={initialStaffId}
        portal={{
          services: portal.services,
          staff: portal.staff,
          today: portal.today,
          whatsappUrl: portal.location.whatsappUrl,
          turnstileSiteKey: portal.turnstileSiteKey,
          holdMin: portal.holdMin,
        }}
      />
    </main>
  );
}
