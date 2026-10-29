import type { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { BookingError } from "@/domain/booking/appointment";
import { addDays, localMinuteOf, localMinuteToInstant, MINUTE_MS } from "@/domain/booking/clock";
import { ALLOWED_TRANSITIONS, APPOINTMENT_STATUSES, type AppointmentStatus, TransitionError } from "@/domain/booking/status";
import { fromUnits } from "@/domain/money";
import {
  appointmentHistory,
  availability,
  changeStatus,
  createAppointment,
  dayAgenda,
  rescheduleAppointment,
  SlotTakenError,
  type StaffActor,
  walkIn,
} from "./appointments";
import { createService } from "./catalog";
import { findOrCreateClient } from "./clients";
import { createLocation } from "./ledger";
import { addStaffMember, setWeeklySchedule } from "./staff";
import { createTestDb, dbError } from "./testing";
import { addTimeOff } from "./time-off";
import type { Db } from "./types";

const TZ = "America/Bogota";
const DAY = "2026-11-02"; // lunes
const at = (hhmm: string, date = DAY) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localMinuteToInstant(date, h * 60 + m, TZ);
};
const hhmm = (d: Date) => {
  const m = localMinuteOf(d, TZ);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const NOW = at("08:00");

let db: Db;
let client: PGlite;
let locationId: bigint;
let andres: bigint;
let brayan: bigint;
let corte: bigint; // 30 min + 10 de limpieza
let barba: bigint; // 20 min, sin limpieza
let juan: bigint;
let reception: StaffActor;
let key = 0;

const allWeek = (start: number, end: number) =>
  ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, startMin: start, endMin: end }));

beforeEach(async () => {
  ({ db, client } = await createTestDb());
  locationId = await createLocation(db, { name: "Villa" });
  andres = await addStaffMember(db, { locationId, displayName: "Andrés", role: "barber" });
  brayan = await addStaffMember(db, { locationId, displayName: "Brayan", role: "barber" });
  await setWeeklySchedule(db, { locationId, staffId: andres, blocks: allWeek(9 * 60, 19 * 60) });
  await setWeeklySchedule(db, { locationId, staffId: brayan, blocks: allWeek(9 * 60, 19 * 60) });
  const svc = (name: string, durationMin: number, bufferMin: number) =>
    createService(db, { locationId, draft: { name, durationMin, bufferMin, price: fromUnits(25_000n), commissionBps: 4_000 } });
  corte = (await svc("Corte", 30, 10)).id;
  barba = (await svc("Barba", 20, 0)).id;
  juan = (await findOrCreateClient(db, { locationId, name: "Juan Pérez", phone: "300 123 4567" })).id;
  const receptionStaff = await addStaffMember(db, { locationId, displayName: "Recepción", role: "reception" });
  reception = { userId: "user_recepcion", role: "reception", staffId: receptionStaff };
}, 30_000);

function book(start: string, opts: Partial<Parameters<typeof createAppointment>[1]> = {}) {
  return createAppointment(db, {
    locationId,
    serviceId: corte,
    staffId: andres,
    start: at(start),
    clientId: juan,
    source: "staff",
    idempotencyKey: `k${++key}`,
    createdBy: "user_recepcion",
    now: NOW,
    ...opts,
  });
}

describe("crear citas", () => {
  it("agenda, copia el servicio y registra quién la creó", async () => {
    const a = await book("10:00");
    expect(a.created).toBe(true);
    expect(a.publicId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const appt = (await dayAgenda(db, { locationId, date: DAY })).appointments[0]!;
    expect([appt.serviceName, appt.status, hhmm(appt.start), hhmm(appt.serviceEnd), hhmm(appt.end), appt.clientName]).toEqual([
      "Corte",
      "confirmed",
      "10:00",
      "10:30",
      "10:40",
      "Juan Pérez",
    ]);
    expect(appt.price.minor).toBe(2_500_000n);
    const history = await appointmentHistory(db, { locationId, appointmentId: a.appointmentId });
    expect(history).toMatchObject([{ kind: "created", toStatus: "confirmed", actorKind: "staff" }]);
  });

  it("la misma clave de idempotencia no crea una segunda cita", async () => {
    const first = await book("10:00", { idempotencyKey: "doble-toque" });
    const again = await book("10:00", { idempotencyKey: "doble-toque" });
    expect(again).toMatchObject({ appointmentId: first.appointmentId, created: false });
    expect((await dayAgenda(db, { locationId, date: DAY })).appointments).toHaveLength(1);
  });

  it("la limpieza ocupa la silla: no se agenda encima de ella; justo después sí", async () => {
    await book("10:00");
    await expect(book("10:30")).rejects.toThrow(SlotTakenError);
    await expect(book("10:40")).resolves.toMatchObject({ created: true });
  });

  it("respeta el turno salvo que el personal lo confirme, y las ausencias siempre", async () => {
    await expect(book("19:00")).rejects.toThrow(/fuera del turno/);
    await expect(book("19:00", { allowOutsideHours: true })).resolves.toMatchObject({ created: true });
    await addTimeOff(db, { locationId, staffId: andres, kind: "block", allDay: false, start: at("12:00"), end: at("13:00"), createdBy: "u" });
    await expect(book("12:15")).rejects.toThrow(SlotTakenError);
  });

  it('"Cualquiera" asigna al barbero libre con menos carga y salta al ocupado', async () => {
    await book("09:00");
    expect((await book("11:00", { staffId: "any" })).staffId).toBe(brayan);
    await book("14:00", { staffId: brayan });
    expect((await book("14:00", { staffId: "any" })).staffId).toBe(andres);
    await expect(book("14:00", { staffId: "any" })).rejects.toThrow(/Ningún barbero/);
  });

  it("la disponibilidad deja de ofrecer lo que se reservó (incluida la limpieza)", async () => {
    const slots = () =>
      availability(db, { locationId, serviceId: corte, fromDate: DAY, toDate: DAY, staffId: andres, now: NOW, internal: true }).then((s) =>
        s.map((x) => hhmm(x.start)),
      );
    expect(await slots()).toContain("10:00");
    await book("10:15");
    const after = await slots();
    // La cita de 10:15 ocupa 10:15–10:55 (30 + 10 de limpieza).
    expect(after).toContain("09:30"); // 09:30–10:10: termina antes
    expect(after).not.toContain("09:45"); // 09:45–10:25: su limpieza choca
    expect(after).not.toContain("10:45");
    expect(after).toContain("11:00");
  });

  it("una reserva en línea vencida libera el horario sola", async () => {
    await book("10:00", { source: "online", createdBy: "online" });
    await expect(book("10:00", { now: new Date(NOW.getTime() + 11 * MINUTE_MS) })).resolves.toMatchObject({ created: true });
    const statuses = (await dayAgenda(db, { locationId, date: DAY })).appointments.map((a) => a.status).sort();
    expect(statuses).toEqual(["cancelled", "confirmed"]);
  });
});

describe("walk-in", () => {
  it("entra ya con quien esté libre; si el pedido está ocupado dice cuándo se libera", async () => {
    await book("10:00");
    const now = at("10:12");
    const base = { locationId, serviceId: barba, clientId: null, createdBy: "u", now };
    await expect(walkIn(db, { ...base, staffId: andres, idempotencyKey: "w1" })).rejects.toThrow(/se libera a las 10:40/);
    const w = await walkIn(db, { ...base, staffId: "any", idempotencyKey: "w2" });
    expect([w.staffId, hhmm(w.start)]).toEqual([brayan, "10:10"]);
    const appt = (await dayAgenda(db, { locationId, date: DAY })).appointments.find((a) => a.id === w.appointmentId)!;
    expect([appt.status, appt.source, appt.clientName]).toEqual(["arrived", "walk_in", null]);
  });
});

describe("estados", () => {
  it("terminar antes acorta la ocupación y libera la silla", async () => {
    const a = await book("10:00");
    for (const to of ["arrived", "in_chair", "completed"] as const) {
      await changeStatus(db, { locationId, appointmentId: a.appointmentId, to, actor: reception, now: at("10:18") });
    }
    const appt = (await dayAgenda(db, { locationId, date: DAY })).appointments[0]!;
    expect(hhmm(appt.end)).toBe("10:30"); // 10:18 → 10:20 + 10 de limpieza
    await expect(book("10:30")).resolves.toMatchObject({ created: true });
  });

  it("el barbero solo mueve sus citas y nadie salta estados", async () => {
    const a = await book("10:00");
    const other: StaffActor = { userId: "user_brayan", role: "barber", staffId: brayan };
    const own: StaffActor = { userId: "user_andres", role: "barber", staffId: andres };
    const move = (to: AppointmentStatus, actor: StaffActor) => changeStatus(db, { locationId, appointmentId: a.appointmentId, to, actor, now: NOW });
    await expect(move("in_chair", other)).rejects.toThrow(TransitionError);
    await expect(move("completed", own)).rejects.toThrow(TransitionError);
    await move("in_chair", own);
    const history = await appointmentHistory(db, { locationId, appointmentId: a.appointmentId });
    expect(history.map((h) => h.toStatus)).toEqual(["confirmed", "in_chair"]);
  });

  it("cancelar libera el horario y marca si fue tardía", async () => {
    const a = await book("10:00");
    await changeStatus(db, { locationId, appointmentId: a.appointmentId, to: "cancelled", cancelReason: "client", actor: reception, now: at("09:00") });
    const { rows } = await client.query<{ cancelled_late: boolean }>(`select cancelled_late from appointments where id = $1`, [a.appointmentId]);
    expect(rows[0]!.cancelled_late).toBe(true);
    await expect(book("10:00")).resolves.toMatchObject({ created: true });
  });

  it("reprogramar mueve la cita y deja rastro; nunca a un horario ocupado", async () => {
    const a = await book("10:00");
    await book("15:00", { staffId: brayan });
    const move = (start: string) =>
      rescheduleAppointment(db, { locationId, appointmentId: a.appointmentId, start: at(start), staffId: brayan, actor: reception, now: NOW });
    await expect(move("15:00")).rejects.toThrow(SlotTakenError);
    await move("11:00");
    const history = await appointmentHistory(db, { locationId, appointmentId: a.appointmentId });
    expect(history.at(-1)).toMatchObject({ kind: "rescheduled" });
    await expect(book("10:00")).resolves.toMatchObject({ created: true });
  });
});

describe("garantías en la base de datos", () => {
  async function rawInsert(status: AppointmentStatus, start: Date, staff = andres) {
    const end = new Date(start.getTime() + 30 * MINUTE_MS);
    const { rows } = await client.query<{ id: bigint }>(
      `insert into appointments (location_id, public_id, staff_id, service_id, client_id, service_name, duration_min, buffer_min,
         price, status, source, during, expires_at, created_by)
       values ($1, $2, $3, $4, $5, 'Corte', 30, 0, 2500000, $6::text, 'staff', tstzrange($7::timestamptz, $8::timestamptz, '[)'),
         case when $6::text = 'pending' then now() + interval '10 min' end, 'u')
       returning id`,
      [locationId, `P${++key}`, staff, corte, juan, status, start.toISOString(), end.toISOString()],
    );
    return rows[0]!.id;
  }

  it("el EXCLUDE impide la doble reserva aunque se salte la app; cita seguida sí", async () => {
    await rawInsert("confirmed", at("10:00"));
    expect(await dbError(rawInsert("confirmed", at("10:15")))).toMatch(/appointments_no_double_booking/);
    await expect(rawInsert("confirmed", at("10:30"))).resolves.toBeDefined();
  });

  it("una cita no nace terminada, no se borra, no cambia su precio y su historial no se edita", async () => {
    expect(await dbError(rawInsert("completed", at("10:00")))).toMatch(/no puede crearse como completed/);
    const id = await rawInsert("confirmed", at("11:00"));
    expect(await dbError(client.query(`delete from appointments where id = $1`, [id]))).toMatch(/no admite DELETE/);
    expect(await dbError(client.query(`update appointments set price = 1 where id = $1`, [id]))).toMatch(/no se editan/);
    const a = await book("13:00");
    expect(await dbError(client.query(`update appointment_events set reason = 'x' where appointment_id = $1`, [a.appointmentId]))).toMatch(
      /no admite UPDATE/,
    );
  });

  it("la base acepta exactamente los cambios de estado que define el dominio", async () => {
    const allowed = new Set(ALLOWED_TRANSITIONS.map(([f, t]) => `${f}>${t}`));
    // Cómo llegar a cada estado por caminos válidos.
    const pathTo: Record<AppointmentStatus, AppointmentStatus[]> = {
      pending: ["pending"],
      confirmed: ["confirmed"],
      arrived: ["arrived"],
      in_chair: ["arrived", "in_chair"],
      completed: ["arrived", "in_chair", "completed"],
      cancelled: ["confirmed", "cancelled"],
      no_show: ["confirmed", "no_show"],
    };
    const setStatus = (id: bigint, s: AppointmentStatus) =>
      client.query(`update appointments set status = $2::text, cancel_reason = case when $2::text = 'cancelled' then 'staff' end where id = $1`, [id, s]);
    let caseNo = 0;
    for (const from of APPOINTMENT_STATUSES) {
      for (const to of APPOINTMENT_STATUSES) {
        if (from === to) continue;
        const [first, ...rest] = pathTo[from];
        const id = await rawInsert(first!, at("10:00", addDays(DAY, ++caseNo))); // un día distinto por caso
        for (const s of rest) await setStatus(id, s);
        const ok = await setStatus(id, to).then(
          () => true,
          () => false,
        );
        expect(ok, `${from} → ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it("propiedad: con reservas al azar nunca quedan dos citas activas cruzadas", async () => {
    let day = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            minute: fc.integer({ min: 0, max: 120 }).map((n) => 9 * 60 + n * 5),
            staff: fc.constantFrom<"a" | "b" | "any">("a", "b", "any"),
            service: fc.constantFrom<"corte" | "barba">("corte", "barba"),
          }),
          { minLength: 1, maxLength: 15 },
        ),
        async (attempts) => {
          const date = addDays(DAY, ++day);
          for (const a of attempts) {
            try {
              await createAppointment(db, {
                locationId,
                serviceId: a.service === "corte" ? corte : barba,
                staffId: a.staff === "a" ? andres : a.staff === "b" ? brayan : "any",
                start: localMinuteToInstant(date, a.minute, TZ),
                clientId: juan,
                source: "staff",
                idempotencyKey: `p${++key}`,
                createdBy: "u",
                now: NOW,
              });
            } catch (err) {
              if (!(err instanceof SlotTakenError || err instanceof BookingError)) throw err;
            }
          }
          const { rows } = await client.query<{ n: number }>(
            `select count(*)::int as n from appointments a join appointments b
               on a.staff_id = b.staff_id and a.id < b.id and a.during && b.during
             where a.status in ('pending','confirmed','arrived','in_chair','completed')
               and b.status in ('pending','confirmed','arrived','in_chair','completed')`,
          );
          expect(rows[0]!.n).toBe(0);
        },
      ),
      { numRuns: 25 },
    );
  }, 60_000);
});
