import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ROLES } from "../staff/roles";
import { localMinuteToInstant, MINUTE_MS } from "./clock";
import {
  type Actor,
  ALLOWED_TRANSITIONS,
  APPOINTMENT_STATUSES,
  assertTransition,
  type AppointmentStatus,
  availableTransitions,
  isTerminal,
  TransitionError,
} from "./status";

const TZ = "America/Bogota";
const start = localMinuteToInstant("2026-11-02", 10 * 60, TZ);
const reception: Actor = { kind: "staff", role: "reception", ownAppointment: false };
const barberOwn: Actor = { kind: "staff", role: "barber", ownAppointment: true };
const barberOther: Actor = { kind: "staff", role: "barber", ownAppointment: false };

function attempt(from: AppointmentStatus, to: AppointmentStatus, actor: Actor, now = new Date(start.getTime() + 15 * MINUTE_MS)) {
  return () => assertTransition({ from, to, actor, now, appointmentStart: start, timeZone: TZ, noShowGraceMin: 10 });
}

describe("estados de la cita", () => {
  it("recorre el camino feliz: confirmada → llegó → en silla → terminada", () => {
    expect(attempt("confirmed", "arrived", reception)).not.toThrow();
    expect(attempt("arrived", "in_chair", barberOwn)).not.toThrow();
    expect(attempt("in_chair", "completed", barberOwn)).not.toThrow();
  });

  it("el barbero solo mueve sus propias citas y nunca cancela ni marca no-show", () => {
    expect(attempt("arrived", "in_chair", barberOther)).toThrow(TransitionError);
    expect(attempt("confirmed", "cancelled", barberOwn)).toThrow(TransitionError);
    expect(attempt("confirmed", "no_show", barberOwn)).toThrow(TransitionError);
  });

  it('"No vino" solo después de la tolerancia', () => {
    expect(attempt("confirmed", "no_show", reception, new Date(start.getTime() + 5 * MINUTE_MS))).toThrow(/10 minutos/);
    expect(attempt("confirmed", "no_show", reception, new Date(start.getTime() + 10 * MINUTE_MS))).not.toThrow();
  });

  it("deshacer solo el mismo día de la cita", () => {
    expect(attempt("in_chair", "arrived", reception)).not.toThrow();
    const nextDay = localMinuteToInstant("2026-11-03", 9 * 60, TZ);
    expect(attempt("in_chair", "arrived", reception, nextDay)).toThrow(/mismo día/);
  });

  it("el cliente solo cancela, y el sistema solo confirma o vence reservas pendientes", () => {
    expect(attempt("confirmed", "cancelled", { kind: "client" })).not.toThrow();
    expect(attempt("confirmed", "arrived", { kind: "client" })).toThrow(TransitionError);
    expect(attempt("pending", "cancelled", { kind: "system" })).not.toThrow();
    expect(attempt("confirmed", "cancelled", { kind: "system" })).toThrow(TransitionError);
  });

  it("propiedad: terminada y cancelada no tienen salida para nadie", () => {
    const actor = fc.oneof(
      fc.record({ kind: fc.constant("staff" as const), role: fc.constantFrom(...ROLES), ownAppointment: fc.boolean() }),
      fc.constant({ kind: "client" as const }),
      fc.constant({ kind: "system" as const }),
    );
    fc.assert(
      fc.property(fc.constantFrom<AppointmentStatus>("completed", "cancelled"), fc.constantFrom(...APPOINTMENT_STATUSES), actor, (from, to, a) => {
        expect(isTerminal(from)).toBe(true);
        expect(availableTransitions(from, a)).toEqual([]);
        expect(attempt(from, to, a)).toThrow(TransitionError);
      }),
    );
  });

  it("propiedad: todo cambio que alguien puede hacer está en la lista que replica Postgres", () => {
    const allowed = new Set(ALLOWED_TRANSITIONS.map(([f, t]) => `${f}>${t}`));
    for (const from of APPOINTMENT_STATUSES) {
      for (const role of ROLES) {
        for (const to of availableTransitions(from, { kind: "staff", role, ownAppointment: true })) {
          expect(allowed.has(`${from}>${to}`)).toBe(true);
        }
      }
    }
  });
});
