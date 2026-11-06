import { TriangleAlert } from "lucide-react";

/** El texto del aviso: una sola fuente para Caja, Inicio y sus pruebas. */
export const DELIVERY_STOPPED_TEXT =
  "Los envíos de WhatsApp y correo están detenidos: el proceso de envíos no responde. Los recibos y avisos quedan en cola y salen cuando vuelva.";

/**
 * Envíos detenidos (migración 0030): hay recibos o avisos de la sede en cola y el worker no late hace
 * más de 5 minutos. Sin datos de clientes. Sirve en componentes de servidor y de cliente.
 */
export function DeliveryStoppedNotice() {
  return (
    <p role="status" className="flex items-start gap-3 rounded-xl border border-alerta/30 bg-alerta/5 px-4 py-3 text-sm">
      <TriangleAlert size={18} className="mt-0.5 shrink-0 text-alerta" aria-hidden />
      <span className="min-w-0 flex-1 font-semibold text-tinta">{DELIVERY_STOPPED_TEXT}</span>
    </p>
  );
}
