import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadTicket } from "../../data";
import { getPortal } from "../../_lib/portal";
import { TicketScreen } from "./_components/ticket-screen";

// Enlace de gestión de una cita. Token desconocido, vencido, revocado o de otra sede: el mismo 404.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Tu cita",
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
    referrer: "no-referrer",
  };
}

type Params = Promise<{ token: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CitaPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const ticket = await loadTicket(token);
  if (!ticket) notFound();
  const portal = await getPortal();
  const isNew = sp.nueva === "1";

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 md:py-12">
      <header className="flex flex-col gap-2 text-center">
        {isNew && ticket.status !== "cancelled" ? (
          <>
            <h1 className="font-display text-4xl leading-tight">¡Listo! Tu cita quedó confirmada</h1>
            <p className="text-tinta/80">Te enviamos este ticket por WhatsApp. Guárdalo: desde aquí puedes reprogramar o cancelar.</p>
          </>
        ) : (
          <>
            <h1 className="font-display text-4xl leading-tight">Hola, {ticket.clientFirstName}</h1>
            <p className="text-tinta/80">Esta es tu cita en Villa.</p>
          </>
        )}
        <div aria-hidden className="mx-auto mt-1 h-px w-16 bg-laton" />
      </header>

      <TicketScreen
        token={token}
        ticket={ticket}
        today={portal?.today ?? ticket.startIso.slice(0, 10)}
        whatsappUrl={portal?.location.whatsappUrl ?? null}
      />
    </main>
  );
}
