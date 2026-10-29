import { buildIcs } from "@/domain/booking/ics";
import { describeError } from "@/lib/log";
import { publicConfig } from "@/lib/public-readiness";
import { loadTicketWithId } from "../../../data";

// "Agregar al calendario" desde el ticket. Cualquier token malo da el mismo 404, sin pistas.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

function notFound(): Response {
  return new Response("No encontrado", { status: 404, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  let ticket;
  try {
    ticket = await loadTicketWithId(token);
  } catch (err) {
    console.error("[ics]", describeError(err));
    return notFound();
  }
  if (!ticket) return notFound();

  let manageUrl: string | null = null;
  try {
    manageUrl = `${publicConfig().baseUrl}/cita/${token}`;
  } catch {
    // Sin configuración pública el archivo sale igual, sin el enlace.
  }
  const body = buildIcs({
    uid: `${ticket.publicId}@villa`,
    start: new Date(ticket.startIso),
    end: new Date(ticket.endIso),
    now: new Date(),
    summary: `${ticket.serviceName} en Villa`,
    description: [
      `${ticket.serviceName} con ${ticket.staffName}. Turno ${ticket.code}.`,
      manageUrl ? `Para reprogramar o cancelar: ${manageUrl}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    location: ticket.address,
    url: manageUrl,
  });
  return new Response(body, {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="villa-${ticket.code}.ics"`,
    },
  });
}
