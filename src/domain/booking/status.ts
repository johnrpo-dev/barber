import { businessDate } from "../ledger/business-date";
import type { Role } from "../staff/roles";
import { MINUTE_MS } from "./clock";

// Ciclo de vida de una cita. La base de datos rechaza pares (desde, hacia) que no estén aquí
// (migración agenda_guards); quién puede hacer cada cambio se decide en este módulo.

export const APPOINTMENT_STATUSES = [
  "pending",
  "confirmed",
  "arrived",
  "in_chair",
  "completed",
  "cancelled",
  "no_show",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  pending: "Pendiente",
  confirmed: "Confirmada",
  arrived: "Llegó",
  in_chair: "En silla",
  completed: "Terminada",
  cancelled: "Cancelada",
  no_show: "No vino",
};

/** Estados que ocupan la silla (los mismos del EXCLUDE en Postgres). */
export const ACTIVE_STATUSES = ["pending", "confirmed", "arrived", "in_chair", "completed"] as const satisfies readonly AppointmentStatus[];

export const CANCEL_REASONS = ["client", "staff", "expired", "left", "duplicate"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export type Actor =
  | { readonly kind: "staff"; readonly role: Role; readonly ownAppointment: boolean }
  | { readonly kind: "client" }
  | { readonly kind: "system" };

interface Rule {
  readonly roles: readonly Role[];
  /** El barbero puede hacerlo sobre sus propias citas. */
  readonly barberOwn?: boolean;
  readonly client?: boolean;
  readonly system?: boolean;
  /** Solo después de la hora de inicio + tolerancia. */
  readonly afterGrace?: boolean;
  /** Deshacer: solo el mismo día contable de la cita. */
  readonly sameDay?: boolean;
}

const FRONT = ["owner", "reception"] as const satisfies readonly Role[];

const RULES: Partial<Record<AppointmentStatus, Partial<Record<AppointmentStatus, Rule>>>> = {
  pending: {
    confirmed: { roles: FRONT, system: true },
    cancelled: { roles: FRONT, client: true, system: true },
  },
  confirmed: {
    arrived: { roles: FRONT },
    in_chair: { roles: FRONT, barberOwn: true },
    cancelled: { roles: FRONT, client: true },
    no_show: { roles: FRONT, afterGrace: true },
  },
  arrived: {
    in_chair: { roles: FRONT, barberOwn: true },
    cancelled: { roles: FRONT },
    confirmed: { roles: FRONT, sameDay: true },
  },
  in_chair: {
    completed: { roles: FRONT, barberOwn: true },
    arrived: { roles: FRONT, sameDay: true },
  },
  no_show: {
    arrived: { roles: FRONT, sameDay: true },
  },
};

/** Pares permitidos, sin mirar quién; es la lista que replica el trigger de Postgres. */
export const ALLOWED_TRANSITIONS: readonly (readonly [AppointmentStatus, AppointmentStatus])[] = Object.entries(RULES).flatMap(
  ([from, tos]) => Object.keys(tos ?? {}).map((to) => [from as AppointmentStatus, to as AppointmentStatus] as const),
);

export function isTerminal(status: AppointmentStatus): boolean {
  return !RULES[status] || Object.keys(RULES[status]).length === 0;
}

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

export interface TransitionContext {
  readonly from: AppointmentStatus;
  readonly to: AppointmentStatus;
  readonly actor: Actor;
  readonly now: Date;
  readonly appointmentStart: Date;
  readonly timeZone: string;
  readonly noShowGraceMin: number;
}

function actorAllowed(rule: Rule, actor: Actor): boolean {
  switch (actor.kind) {
    case "system":
      return rule.system === true;
    case "client":
      return rule.client === true;
    case "staff":
      return rule.roles.includes(actor.role) || (actor.role === "barber" && rule.barberOwn === true && actor.ownAppointment);
  }
}

export function assertTransition(ctx: TransitionContext): void {
  const rule = RULES[ctx.from]?.[ctx.to];
  if (!rule) {
    throw new TransitionError(`Una cita ${STATUS_LABELS[ctx.from].toLowerCase()} no puede pasar a ${STATUS_LABELS[ctx.to].toLowerCase()}`);
  }
  if (!actorAllowed(rule, ctx.actor)) throw new TransitionError("No tienes permiso para hacer este cambio");
  if (rule.afterGrace && ctx.now.getTime() < ctx.appointmentStart.getTime() + ctx.noShowGraceMin * MINUTE_MS) {
    throw new TransitionError(`Solo se marca "No vino" ${ctx.noShowGraceMin} minutos después de la hora de la cita`);
  }
  if (rule.sameDay && businessDate(ctx.now, ctx.timeZone) !== businessDate(ctx.appointmentStart, ctx.timeZone)) {
    throw new TransitionError("Solo se puede deshacer el mismo día de la cita");
  }
}

/** Siguiente paso habitual: el botón principal de la agenda. */
export const NEXT_STEP: Partial<Record<AppointmentStatus, AppointmentStatus>> = {
  pending: "confirmed",
  confirmed: "arrived",
  arrived: "in_chair",
  in_chair: "completed",
};

export const NEXT_STEP_LABELS: Partial<Record<AppointmentStatus, string>> = {
  confirmed: "Confirmar",
  arrived: "Llegó",
  in_chair: "En silla",
  completed: "Terminado",
};

/** Cambios que este actor puede ofrecer desde `from` (para pintar botones; el servidor vuelve a validar). */
export function availableTransitions(from: AppointmentStatus, actor: Actor): AppointmentStatus[] {
  return Object.entries(RULES[from] ?? {})
    .filter(([, rule]) => rule && actorAllowed(rule, actor))
    .map(([to]) => to as AppointmentStatus);
}
