import type { CSSProperties } from "react";
import type { AppointmentStatus } from "@/domain/booking/status";
import { cx, splitTime } from "../_lib/ui";

// Ticket de turno: la pieza memorable del portal (docs/sprint-3-diseno-portal.md §2).
// Sin estado ni efectos: sirve en Server Components (la página de la cita, la muestra del
// inicio) y dentro del flujo de reserva (el ticket "borrador" en pantallas anchas).

export type StampTone = "confirmed" | "pending" | "cancelled" | "neutral" | "draft";

export interface TicketData {
  code: string | null;
  timeLabel: string | null;
  dateLabel: string | null;
  serviceName: string | null;
  staffName: string | null;
  durationMin: number | null;
  priceLabel: string | null;
  address: string | null;
  stamp: { label: string; tone: StampTone };
}

export function stampFor(status: AppointmentStatus, statusLabel: string): TicketData["stamp"] {
  if (status === "confirmed") return { label: "Confirmada", tone: "confirmed" };
  if (status === "pending") return { label: "Por confirmar", tone: "pending" };
  if (status === "cancelled") return { label: "Cancelada", tone: "cancelled" };
  return { label: statusLabel, tone: "neutral" };
}

const STAMP_TONES: Record<StampTone, string> = {
  confirmed: "border-botella text-botella",
  pending: "border-tinta/50 text-tinta/70",
  draft: "border-tinta/50 text-tinta/70",
  neutral: "border-tinta/50 text-tinta/70",
  cancelled: "border-alerta text-alerta",
};

// Dos capas de máscara al 51 %: cada una corta media muesca en su borde, sin mask-composite.
const TEAR = "6.5rem";
const MASK = [
  `radial-gradient(circle at 0 ${TEAR}, #0000 12px, #000 12.5px) 0 0/51% 100% no-repeat`,
  `radial-gradient(circle at 100% ${TEAR}, #0000 12px, #000 12.5px) 100% 0/51% 100% no-repeat`,
].join(", ");
const MASK_STYLE: CSSProperties = { mask: MASK, WebkitMask: MASK, ["--tear" as string]: TEAR };

const EMPTY = "—";

export function Ticket({
  data,
  headingId,
  className,
}: {
  data: TicketData;
  headingId: string;
  className?: string;
}) {
  const [time, suffix] = data.timeLabel ? splitTime(data.timeLabel) : [EMPTY, ""];
  const rows: [string, string | null, boolean?][] = [
    ["Servicio", data.serviceName],
    ["Barbero", data.staffName],
    ["Duración", data.durationMin ? `${data.durationMin} min` : null],
    ["Valor", data.priceLabel, true],
    ["Dónde", data.address],
  ];
  return (
    // La sombra va en el contenedor: la máscara recortaría un box-shadow del propio ticket.
    <div
      className={cx(
        "relative mx-auto w-full max-w-[22rem] drop-shadow-[0_10px_22px_rgb(28_26_23/0.14)]",
        data.stamp.tone === "cancelled" && "opacity-75",
        className,
      )}
    >
      <article aria-labelledby={headingId} className="relative animate-pop-in rounded-2xl bg-papel" style={MASK_STYLE}>
        <header className="flex h-(--tear) items-start justify-between gap-3 rounded-t-2xl border-t-[6px] border-laton px-6 pt-4">
          <h2 id={headingId} className="flex flex-col">
            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-tinta/70">Turno</span>
            <span className="monto font-display text-3xl leading-tight">{data.code ?? EMPTY}</span>
          </h2>
          <span className="pt-1 font-display text-lg text-botella" aria-hidden>
            Villa
          </span>
        </header>
        <div
          aria-hidden
          className="mx-5 -mt-0.5 h-1 bg-[radial-gradient(circle,var(--color-laton)_1.5px,transparent_2px)] bg-size-[10px_4px] bg-repeat-x"
        />
        <div className="relative px-6 pb-6 pt-5">
          <p className="flex items-baseline gap-1.5">
            <span className="monto font-display text-5xl leading-none">{time}</span>
            {suffix ? <span className="text-lg font-semibold">{suffix}</span> : null}
          </p>
          <p className="mt-1.5 text-base first-letter:uppercase">{data.dateLabel ?? "Elige día y hora"}</p>
          <dl className="mt-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            {rows.map(([label, value, money]) =>
              value ? (
                <div key={label} className="contents">
                  <dt className="text-tinta/70">{label}</dt>
                  <dd className={cx("font-semibold", money && "monto")}>{value}</dd>
                </div>
              ) : null,
            )}
          </dl>
          <p
            className={cx(
              "absolute right-5 top-5 rotate-[-6deg] rounded-md border-2 px-2.5 py-1 text-xs font-bold uppercase tracking-[0.16em]",
              "animate-pop-in [animation-delay:200ms] [animation-fill-mode:backwards]",
              STAMP_TONES[data.stamp.tone],
            )}
          >
            {data.stamp.label}
          </p>
        </div>
      </article>
    </div>
  );
}
