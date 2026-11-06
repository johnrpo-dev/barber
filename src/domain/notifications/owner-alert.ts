import { localMinuteOf } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { format, type Money, negate } from "@/domain/money";
import { formatTime } from "@/domain/staff/schedule";

// Aviso al dueño por correo (sprint 8, docs/sprint-8-gastos-controles.md §3). Lo arma el worker con
// lo que barrió en owner_alerts (src/db/owner-alerts.ts), UN correo por sede. Solo lo que el dueño
// necesita para ir a mirar: qué pasó, quién (el nombre que el dueño le puso a la persona), el monto,
// la hora local y el enlace al panel. NUNCA el motivo escrito a mano (texto libre: podría traer
// nombres o celulares) ni datos de clientes.

export type OwnerAlertKind = "void_requested" | "cash_review" | "day_reopened" | "courtesy";

export type OwnerAlertItem =
  /** Solicitud de anulación pendiente: quién la pidió y el total de la venta. */
  | { kind: "void_requested"; at: Date; by: string | null; amount: Money }
  /**
   * Cierre de caja marcado para revisión por la base (umbral de la sede). Cada diferencia es
   * contado − esperado (positiva: sobrante; negativa: faltante); null si esa parte no se marcó.
   */
  | { kind: "cash_review"; at: Date; by: string | null; closingDifference: Money | null; openingDifference: Money | null }
  /** Reapertura de un día contable; onCashOpen si fue la automática al abrir la caja. */
  | { kind: "day_reopened"; at: Date; by: string | null; businessDate: string; onCashOpen: boolean }
  /** Cortesía: el servicio, su precio de lista y quién atendió. */
  | { kind: "courtesy"; at: Date; by: string | null; amount: Money; serviceName: string; staffName: string | null };

/** Rutas del panel, una por tipo de aviso. */
export const OWNER_ALERT_PATHS: Record<OwnerAlertKind, string> = {
  void_requested: "/panel/anulaciones",
  cash_review: "/panel/caja",
  day_reopened: "/panel/caja",
  courtesy: "/panel/informes",
};

const SECTION_TITLES: Record<OwnerAlertKind, string> = {
  void_requested: "Anulaciones por decidir",
  cash_review: "Cierres de caja por revisar",
  day_reopened: "Días reabiertos",
  courtesy: "Cortesías",
};

const ORDER: readonly OwnerAlertKind[] = ["void_requested", "cash_review", "day_reopened", "courtesy"];

/** Cuántos avisos de cada tipo se detallan; el resto va en un conteo. */
export const MAX_DETAILED_PER_KIND = 30;

const someone = (by: string | null) => by ?? "Alguien del personal";

function differenceText(d: Money): string {
  if (d.minor === 0n) return "sin diferencia";
  return d.minor < 0n ? `faltante de ${format(negate(d))}` : `sobrante de ${format(d)}`;
}

function line(item: OwnerAlertItem, when: (d: Date) => string): string {
  switch (item.kind) {
    case "void_requested":
      return `- ${when(item.at)}: ${someone(item.by)} pidió anular una venta de ${format(item.amount)}.`;
    case "cash_review": {
      const parts = [
        item.closingDifference ? `cierre con ${differenceText(item.closingDifference)}` : null,
        item.openingDifference ? `apertura con ${differenceText(item.openingDifference)}` : null,
      ].filter((p): p is string => p !== null);
      return `- ${when(item.at)}: ${someone(item.by)} cerró la caja; ${parts.join(" y ")}.`;
    }
    case "day_reopened":
      return `- ${when(item.at)}: ${someone(item.by)} reabrió el día ${item.businessDate}${item.onCashOpen ? " al abrir la caja" : ""}.`;
    case "courtesy":
      return `- ${when(item.at)}: ${someone(item.by)} dio una cortesía: ${item.serviceName} de ${format(item.amount)}${item.staffName ? `, atendió ${item.staffName}` : ""}.`;
  }
}

const SINGLE_SUBJECTS: Record<OwnerAlertKind, string> = {
  void_requested: "una anulación por decidir",
  cash_review: "un cierre de caja por revisar",
  day_reopened: "se reabrió un día",
  courtesy: "se dio una cortesía",
};

/**
 * UN correo con todos los avisos de una sede, agrupados por tipo y con el enlace a la pantalla de
 * cada grupo. `baseUrl` sin barra final (PUBLIC_BASE_URL).
 */
export function ownerAlertMessage(
  items: readonly OwnerAlertItem[],
  opts: { locationName: string; timeZone: string; baseUrl: string },
): { subject: string; text: string } {
  const when = (d: Date) => `${businessDate(d, opts.timeZone)} ${formatTime(localMinuteOf(d, opts.timeZone))}`;
  const sections: string[] = [];
  for (const kind of ORDER) {
    const ofKind = items.filter((i) => i.kind === kind).sort((a, b) => a.at.getTime() - b.at.getTime());
    if (ofKind.length === 0) continue;
    const lines = ofKind.slice(0, MAX_DETAILED_PER_KIND).map((i) => line(i, when));
    if (ofKind.length > MAX_DETAILED_PER_KIND) lines.push(`- y ${ofKind.length - MAX_DETAILED_PER_KIND} más.`);
    sections.push([`${SECTION_TITLES[kind]} (${ofKind.length}): ${opts.baseUrl}${OWNER_ALERT_PATHS[kind]}`, ...lines].join("\n"));
  }
  const subject =
    items.length === 1
      ? `Villa (${opts.locationName}): ${SINGLE_SUBJECTS[items[0]!.kind]}`
      : `Villa (${opts.locationName}): ${items.length} avisos para revisar`;
  const text = [
    `Esto pasó en ${opts.locationName} y conviene que lo mires:`,
    "",
    sections.join("\n\n"),
    "",
    "Los motivos y los datos de los clientes no van en este correo: míralos en el panel.",
  ].join("\n");
  return { subject, text };
}
