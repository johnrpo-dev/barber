import { CalendarCheck, Check, DoorOpen, Hourglass, type LucideIcon, Scissors, UserX, X } from "lucide-react";
import { type AppointmentStatus, STATUS_LABELS } from "@/domain/booking/status";
import { cx } from "../../_components/ui";

// Cada estado se distingue por forma, ícono y palabra, nunca solo por color.

export const STATUS_ICON: Record<AppointmentStatus, LucideIcon> = {
  pending: Hourglass,
  confirmed: CalendarCheck,
  arrived: DoorOpen,
  in_chair: Scissors,
  completed: Check,
  cancelled: X,
  no_show: UserX,
};

/** Bloque en la grilla de la agenda. */
export const BLOCK_STYLE: Record<AppointmentStatus, string> = {
  pending: "border border-dashed border-cuero/60 bg-papel text-tinta",
  confirmed: "border border-cuero/25 border-l-4 border-l-cuero bg-[color-mix(in_oklab,var(--color-cuero)_9%,var(--color-papel))] text-tinta",
  arrived: "border border-botella/30 border-l-4 border-l-botella bg-[color-mix(in_oklab,var(--color-botella)_12%,var(--color-papel))] text-tinta",
  in_chair: "border border-botella bg-botella text-hueso shadow-md",
  completed: "border border-tinta/10 bg-tinta/[0.04] text-tinta/70",
  cancelled: "border border-tinta/10 bg-papel text-tinta/70 line-through",
  no_show: "border border-alerta/30 bg-papel text-alerta",
};

const BADGE_STYLE: Record<AppointmentStatus, string> = {
  pending: "border border-dashed border-cuero/60 text-cuero",
  confirmed: "bg-cuero/10 text-cuero",
  arrived: "bg-botella/12 text-botella",
  in_chair: "bg-botella text-hueso",
  completed: "bg-tinta/8 text-tinta/70",
  cancelled: "bg-tinta/8 text-tinta/70",
  no_show: "bg-alerta/10 text-alerta",
};

export function StatusBadge({ status, className }: { status: AppointmentStatus; className?: string }) {
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold",
        BADGE_STYLE[status],
        className,
      )}
    >
      <Icon size={14} strokeWidth={2} aria-hidden />
      {STATUS_LABELS[status]}
    </span>
  );
}
