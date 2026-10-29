import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAppointment } from "@/db/appointments";
import { createService } from "@/db/catalog";
import { findOrCreateClient } from "@/db/clients";
import { createLocation } from "@/db/ledger";
import { staffMembers } from "@/db/schema";
import { addStaffMember, createStaffUser, setWeeklySchedule } from "@/db/staff";
import { createTestDb } from "@/db/testing";
import { addTimeOff } from "@/db/time-off";
import type { Db } from "@/db/types";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits } from "@/domain/money";
import type { Role } from "@/domain/staff/roles";

// Pruebas de autorización: cada rol contra cada server action del panel, más el aislamiento
// entre sedes. Corre el `requireStaff`/`requirePermission` REAL sobre un PostgreSQL en memoria;
// solo se simulan la cookie de sesión (better-auth) y el redirect de Next.js.
// Si alguien amplía un permiso sin querer, o una acción olvida verificarlo, esto falla.

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  session: null as null | { user: { id: string; name: string; email: string } },
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    // Igual que Next: un error con digest NEXT_REDIRECT que runAction debe dejar pasar.
    throw Object.assign(new Error(`redirect ${url}`), { url, digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // Fuera de una petición de Next no hay caché por petición: cada llamada consulta de nuevo.
  cache: <T>(fn: T) => fn,
}));
vi.mock("@/db/client", () => ({ db: () => state.db }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  auth: async () => ({ api: { getSession: async () => state.session } }),
}));

const agenda = await import("./agenda/actions");
const servicios = await import("./servicios/actions");
const personal = await import("./personal/actions");
const bloqueos = await import("./bloqueos/actions");
const ajustes = await import("./ajustes/actions");

const TZ = "America/Bogota";
const PASSWORD = "clave-de-prueba-123"; // valor de prueba, solo existe en esta base en memoria

type Person = { id: string; staffId: bigint };
let db: Db;
let client: PGlite;
const A = {} as {
  location: bigint;
  users: Record<Role, Person>;
  otherBarber: bigint;
  dummy: bigint;
  service: bigint;
  client: bigint;
};
const B = {} as { location: bigint; owner: Person; service: bigint; barber: bigint };

let base: string;
let slot = 0;
/** Un horario libre distinto en cada llamada (45 min cubren corte de 30 + limpieza de 10). */
function nextSlot() {
  const k = slot++;
  return { date: addDays(base, Math.floor(k / 12)), minute: 9 * 60 + (k % 12) * 45 };
}

let seq = 0;
const uniq = () => `${++seq}`.padStart(8, "0");

async function appointmentFor(staffId: bigint): Promise<bigint> {
  const { date, minute } = nextSlot();
  const created = await createAppointment(db, {
    locationId: A.location,
    serviceId: A.service,
    staffId,
    start: localMinuteToInstant(date, minute, TZ),
    clientId: A.client,
    source: "staff",
    idempotencyKey: `seed-${uniq()}`,
    createdBy: "seed",
  });
  return created.appointmentId;
}

async function timeOffFor(staffId: bigint, offsetDays: number): Promise<bigint> {
  const date = addDays(base, offsetDays);
  const { id } = await addTimeOff(db, { locationId: A.location, staffId, kind: "block", createdBy: "seed", allDay: true, fromDate: date, toDate: date });
  return id;
}

function signInAs(person: Person | null) {
  state.session = person ? { user: { id: person.id, name: "Prueba", email: "prueba@villa.test" } } : null;
}

/** El staffId de quien tiene la sesión (para acciones sobre lo propio); sin sesión, uno cualquiera. */
function myStaffId(): bigint {
  const me = Object.values(A.users).find((p) => p.id === state.session?.user.id);
  return me?.staffId ?? A.dummy;
}

/** Huella de todo lo que una acción podría tocar (opcionalmente solo de una sede). */
async function fingerprint(locationId?: bigint): Promise<string> {
  const loc = locationId ?? null;
  const rows = await db.execute(sql`
    select
      (select coalesce(string_agg(id || ':' || status || ':' || staff_id || ':' || during::text, ',' order by id), '')
         from appointments where ${loc}::bigint is null or location_id = ${loc}) as appointments,
      (select count(*) from appointment_events where ${loc}::bigint is null or location_id = ${loc}) as events,
      (select coalesce(string_agg(id || ':' || name || ':' || active || ':' || price || ':' || commission_bps, ',' order by id), '')
         from services where ${loc}::bigint is null or location_id = ${loc}) as services,
      (select coalesce(string_agg(id || ':' || display_name || ':' || role || ':' || active || ':' || bookable_online, ',' order by id), '')
         from staff_members where ${loc}::bigint is null or location_id = ${loc}) as staff,
      (select coalesce(string_agg(row(l.*)::text, ',' order by id), '')
         from locations l where ${loc}::bigint is null or id = ${loc}) as locations,
      (select coalesce(string_agg(staff_id || ':' || weekday || ':' || start_min || '-' || end_min, ',' order by staff_id, weekday, start_min), '')
         from staff_schedules where ${loc}::bigint is null or location_id = ${loc}) as schedules,
      (select coalesce(string_agg(id || ':' || (cancelled_at is null), ',' order by id), '')
         from time_off where ${loc}::bigint is null or location_id = ${loc}) as time_off,
      (select count(*) from clients where ${loc}::bigint is null or location_id = ${loc}) as clients,
      (select count(*) from "user") as users
  `);
  return JSON.stringify(rows);
}

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  state.db = db;
  base = addDays(businessDate(new Date(), TZ), 3);
  const allDay = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, startMin: 0, endMin: 24 * 60 }));
  const person = async (role: Role, locationId: bigint): Promise<Person> => {
    const { userId, staffId } = await createStaffUser(db, {
      locationId,
      name: `Persona ${role}`,
      email: `${role}-${locationId}@villa.test`,
      password: PASSWORD,
      role,
    });
    return { id: userId, staffId };
  };

  A.location = await createLocation(db, { name: "Villa" });
  A.users = { owner: await person("owner", A.location), reception: await person("reception", A.location), barber: await person("barber", A.location) };
  A.otherBarber = await addStaffMember(db, { locationId: A.location, displayName: "Otro barbero", role: "barber" });
  A.dummy = await addStaffMember(db, { locationId: A.location, displayName: "Persona de prueba", role: "barber" });
  for (const s of [A.users.barber.staffId, A.otherBarber]) await setWeeklySchedule(db, { locationId: A.location, staffId: s, blocks: allDay });
  A.service = (
    await createService(db, {
      locationId: A.location,
      draft: { name: "Corte", durationMin: 30, bufferMin: 10, price: fromUnits(30_000n), commissionBps: 4_000 },
    })
  ).id;
  A.client = (await findOrCreateClient(db, { locationId: A.location, name: "Juan Pérez", phone: "300 123 4567" })).id;

  B.location = await createLocation(db, { name: "Otra sede" });
  B.owner = await person("owner", B.location);
  B.barber = await addStaffMember(db, { locationId: B.location, displayName: "Barbero B", role: "barber" });
  await setWeeklySchedule(db, { locationId: B.location, staffId: B.barber, blocks: allDay });
  B.service = (
    await createService(db, {
      locationId: B.location,
      draft: { name: "Corte B", durationMin: 30, bufferMin: 10, price: fromUnits(25_000n), commissionBps: 4_000 },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await client?.close();
});

// ─── Matriz rol × acción ─────────────────────────────────────────────────────

type Outcome = { ok: boolean; error?: string; data?: unknown };
type Attempt = () => Promise<Outcome>;

interface Case {
  name: string;
  /** La server action que se prueba (ver la guarda de completitud al final). */
  action: string;
  /** Quiénes pueden. Es la especificación: cambiarla es una decisión de negocio, no un arreglo de test. */
  allowed: readonly Role[];
  /** Prepara datos válidos y devuelve la llamada (lo preparado no cuenta como cambio). */
  prepare: () => Promise<Attempt>;
  /** El walk-in depende de la hora real; basta con que no lo frene el permiso. */
  lenient?: boolean;
}

const CASES: Case[] = [
  {
    name: "agenda · ver horarios libres",
    action: "loadSlots",
    allowed: ["owner", "reception"],
    prepare: async () => () => agenda.loadSlots({ serviceId: String(A.service), staffId: "any", date: base }),
  },
  {
    name: "agenda · buscar clientes",
    action: "findClients",
    allowed: ["owner", "reception"],
    prepare: async () => () => agenda.findClients("Juan"),
  },
  {
    name: "agenda · historial de una cita",
    action: "loadHistory",
    allowed: ["owner", "reception", "barber"],
    prepare: async () => {
      const id = await appointmentFor(A.users.barber.staffId);
      return () => agenda.loadHistory(String(id));
    },
  },
  {
    name: "agenda · agendar",
    action: "bookAppointment",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const { date, minute } = nextSlot();
      return () =>
        agenda.bookAppointment({
          serviceId: String(A.service),
          staffId: String(A.users.barber.staffId),
          date,
          minute,
          client: { kind: "existing", id: String(A.client) },
          idempotencyKey: `book-${uniq()}`,
        });
    },
  },
  {
    name: "agenda · walk-in",
    action: "startWalkIn",
    allowed: ["owner", "reception"],
    lenient: true,
    prepare: async () => () =>
      agenda.startWalkIn({ serviceId: String(A.service), staffId: "any", client: { kind: "none" }, idempotencyKey: `walk-${uniq()}` }),
  },
  {
    name: "agenda · cambiar estado de una cita del barbero",
    action: "setStatus",
    allowed: ["owner", "reception", "barber"],
    prepare: async () => {
      const id = await appointmentFor(A.users.barber.staffId);
      return () => agenda.setStatus({ appointmentId: String(id), to: "in_chair" });
    },
  },
  {
    name: "agenda · reprogramar",
    action: "reschedule",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const id = await appointmentFor(A.users.barber.staffId);
      const { date, minute } = nextSlot();
      return () => agenda.reschedule({ appointmentId: String(id), staffId: String(A.users.barber.staffId), date, minute });
    },
  },
  {
    name: "servicios · crear",
    action: "createServiceAction",
    allowed: ["owner"],
    prepare: async () => {
      const name = `Servicio ${uniq()}`;
      return () => servicios.createServiceAction({ name, priceUnits: "20000", durationMin: 30, bufferMin: 5, commission: "40", active: true });
    },
  },
  {
    name: "servicios · cambiar precio y comisión",
    action: "updateServiceAction",
    allowed: ["owner"],
    prepare: async () => {
      const price = String(30_000 + Number(uniq()));
      return () =>
        servicios.updateServiceAction({
          serviceId: String(A.service),
          name: "Corte",
          priceUnits: price,
          durationMin: 30,
          bufferMin: 10,
          commission: "40",
          active: true,
        });
    },
  },
  {
    name: "servicios · retirar",
    action: "setServiceActiveAction",
    allowed: ["owner"],
    prepare: async () => {
      const svc = await createService(db, {
        locationId: A.location,
        draft: { name: `Temporal ${uniq()}`, durationMin: 20, bufferMin: 0, price: fromUnits(10_000n), commissionBps: 3_000 },
      });
      return () => servicios.setServiceActiveAction({ serviceId: String(svc.id), active: false });
    },
  },
  {
    name: "personal · agregar persona",
    action: "createStaffAction",
    allowed: ["owner"],
    prepare: async () => {
      const name = `Nuevo ${uniq()}`;
      return () => personal.createStaffAction({ withAccess: false, name, role: "barber" });
    },
  },
  {
    name: "personal · crear una cuenta de dueño",
    action: "createStaffAction",
    allowed: ["owner"],
    prepare: async () => {
      const k = uniq();
      return () =>
        personal.createStaffAction({ withAccess: true, name: `Socio ${k}`, role: "owner", email: `socio${k}@villa.test`, password: PASSWORD });
    },
  },
  {
    name: "personal · ascender a dueño",
    action: "updateStaffProfileAction",
    allowed: ["owner"],
    prepare: async () => {
      const target = await addStaffMember(db, { locationId: A.location, displayName: `Ascenso ${uniq()}`, role: "barber" });
      return () => personal.updateStaffProfileAction({ staffId: String(target), displayName: "Ascendido", role: "owner", active: true });
    },
  },
  {
    name: "personal · guardar horario",
    action: "saveScheduleAction",
    allowed: ["owner"],
    prepare: async () => {
      const end = `${String(10 + (Number(uniq()) % 9)).padStart(2, "0")}:00`;
      return () => personal.saveScheduleAction({ staffId: String(A.dummy), blocks: [{ weekday: 1, start: "09:00", end }] });
    },
  },
  {
    name: "bloqueos · ausencia de otra persona",
    action: "addStaffTimeOffAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const date = addDays(base, 100 + Number(uniq()));
      return () =>
        bloqueos.addStaffTimeOffAction({ staffId: String(A.dummy), kind: "absence", range: { allDay: true, fromDate: date, toDate: date } });
    },
  },
  {
    name: "bloqueos · bloquear el tiempo de otra persona",
    action: "addStaffTimeOffAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const date = addDays(base, 100 + Number(uniq()));
      return () =>
        bloqueos.addStaffTimeOffAction({
          staffId: String(A.otherBarber),
          kind: "block",
          range: { allDay: false, date, startTime: "12:00", endTime: "13:00" },
        });
    },
  },
  {
    name: "bloqueos · bloquear el tiempo propio",
    action: "addStaffTimeOffAction",
    allowed: ["owner", "reception", "barber"],
    prepare: async () => {
      const date = addDays(base, 100 + Number(uniq()));
      return () =>
        bloqueos.addStaffTimeOffAction({
          staffId: String(myStaffId()),
          kind: "block",
          range: { allDay: false, date, startTime: "12:00", endTime: "13:00" },
        });
    },
  },
  {
    name: "bloqueos · registrarse una ausencia propia (vacaciones)",
    action: "addStaffTimeOffAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const date = addDays(base, 100 + Number(uniq()));
      return () =>
        bloqueos.addStaffTimeOffAction({ staffId: String(myStaffId()), kind: "absence", range: { allDay: true, fromDate: date, toDate: date } });
    },
  },
  {
    name: "bloqueos · cierre de la sede",
    action: "addClosureAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const date = addDays(base, 300 + Number(uniq()));
      return () => bloqueos.addClosureAction({ fromDate: date, toDate: date, reason: "Festivo" });
    },
  },
  {
    name: "bloqueos · anular la ausencia de otra persona",
    action: "cancelTimeOffAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const id = await timeOffFor(A.dummy, 200 + Number(uniq()));
      return () => bloqueos.cancelTimeOffAction({ timeOffId: String(id) });
    },
  },
  {
    name: "bloqueos · anular un bloqueo propio",
    action: "cancelTimeOffAction",
    allowed: ["owner", "reception", "barber"],
    prepare: async () => {
      // Uno por persona: la llamada anula el de quien tenga la sesión.
      const k = 200 + Number(uniq());
      const ids = new Map<bigint, bigint>();
      for (const p of Object.values(A.users)) ids.set(p.staffId, await timeOffFor(p.staffId, k));
      return () => bloqueos.cancelTimeOffAction({ timeOffId: String(ids.get(myStaffId()) ?? 0n) });
    },
  },
  {
    name: "bloqueos · anular un cierre de la sede",
    action: "cancelTimeOffAction",
    allowed: ["owner", "reception"],
    prepare: async () => {
      const date = addDays(base, 400 + Number(uniq()));
      const { id } = await addTimeOff(db, {
        locationId: A.location,
        staffId: null,
        kind: "absence",
        createdBy: "seed",
        allDay: true,
        fromDate: date,
        toDate: date,
      });
      return () => bloqueos.cancelTimeOffAction({ timeOffId: String(id) });
    },
  },
  {
    name: "ajustes · reglas de la sede y reserva en línea",
    action: "updateBookingSettingsAction",
    allowed: ["owner"],
    prepare: async () => {
      const n = Number(uniq());
      return () =>
        ajustes.updateBookingSettingsAction({
          publicBookingEnabled: false,
          publicPhone: "300 123 4567",
          address: `Calle ${n}`,
          mapsUrl: "",
          slotStepMin: 15,
          minAdvanceMin: 60 + (n % 10) * 15,
          maxAdvanceDays: 30,
          holdMin: 10,
          freeCancelHours: 4,
          noShowGraceMin: 15,
          maxActivePerClient: 2,
        });
    },
  },
  {
    name: "ajustes · quién atiende en línea",
    action: "setStaffBookableAction",
    allowed: ["owner"],
    prepare: async () => {
      const [row] = await db.select({ bookable: staffMembers.bookableOnline }).from(staffMembers).where(eq(staffMembers.id, A.dummy));
      return () => ajustes.setStaffBookableAction({ staffId: String(A.dummy), bookable: !row?.bookable });
    },
  },
];

const ROLES: Role[] = ["owner", "reception", "barber"];

describe.each(CASES)("$name", (c) => {
  it.each(ROLES)("como %s", async (role) => {
    const attempt = await c.prepare();
    signInAs(A.users[role]);
    if (c.allowed.includes(role)) {
      const result = await attempt();
      if (c.lenient) expect(result.ok || !/permiso/i.test(result.error ?? ""), JSON.stringify(result)).toBe(true);
      else expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    } else {
      const before = await fingerprint();
      await expect(attempt()).rejects.toMatchObject({ url: "/panel?sin-permiso=1" });
      expect(await fingerprint()).toBe(before);
    }
  });

  it("sin sesión: va a /ingresar sin tocar nada", async () => {
    const attempt = await c.prepare();
    signInAs(null);
    const before = await fingerprint();
    await expect(attempt()).rejects.toMatchObject({ url: "/ingresar" });
    expect(await fingerprint()).toBe(before);
  });
});

describe("cuenta válida sin acceso a ninguna sede", () => {
  it("se manda a /ingresar?sin-acceso=1", async () => {
    signInAs({ id: "usuario-sin-sede", staffId: 0n });
    await expect(agenda.findClients("Juan")).rejects.toMatchObject({ url: "/ingresar?sin-acceso=1" });
  });
});

// ─── El barbero y las citas ajenas ───────────────────────────────────────────

describe("barbero frente a la cita de otro barbero", () => {
  it("no puede cambiarle el estado ni ver su historial", async () => {
    const id = await appointmentFor(A.otherBarber);
    signInAs(A.users.barber);
    const before = await fingerprint();
    expect(await agenda.setStatus({ appointmentId: String(id), to: "in_chair" })).toMatchObject({ ok: false });
    expect(await agenda.loadHistory(String(id))).toEqual({ ok: true, data: [] });
    expect(await fingerprint()).toBe(before);
  });
});

// ─── Aislamiento entre sedes (IDOR) ──────────────────────────────────────────

const CROSS_LOCATION: { name: string; prepare: () => Promise<Attempt> }[] = [
  {
    name: "cancelar una cita",
    prepare: async () => {
      const id = await appointmentFor(A.users.barber.staffId);
      return () => agenda.setStatus({ appointmentId: String(id), to: "cancelled", cancelReason: "staff" });
    },
  },
  {
    name: "reprogramar una cita hacia su sede",
    prepare: async () => {
      const id = await appointmentFor(A.users.barber.staffId);
      const { date, minute } = nextSlot();
      return () => agenda.reschedule({ appointmentId: String(id), staffId: String(B.barber), date, minute });
    },
  },
  {
    name: "agendar con un servicio de esta sede",
    prepare: async () => {
      const { date, minute } = nextSlot();
      return () =>
        agenda.bookAppointment({
          serviceId: String(A.service),
          staffId: String(B.barber),
          date,
          minute,
          client: { kind: "new", name: "Intruso", phone: "301 000 0000" },
          idempotencyKey: `x-${uniq()}`,
        });
    },
  },
  {
    name: "agendar a un cliente de esta sede",
    prepare: async () => {
      const { date, minute } = nextSlot();
      return () =>
        agenda.bookAppointment({
          serviceId: String(B.service),
          staffId: String(B.barber),
          date,
          minute,
          client: { kind: "existing", id: String(A.client) },
          idempotencyKey: `x-${uniq()}`,
        });
    },
  },
  {
    name: "agendar con un barbero de esta sede",
    prepare: async () => {
      const { date, minute } = nextSlot();
      return () =>
        agenda.bookAppointment({
          serviceId: String(B.service),
          staffId: String(A.users.barber.staffId),
          date,
          minute,
          client: { kind: "new", name: "Intruso", phone: "301 000 0001" },
          idempotencyKey: `x-${uniq()}`,
        });
    },
  },
  {
    name: "editar un servicio",
    prepare: async () => () =>
      servicios.updateServiceAction({
        serviceId: String(A.service),
        name: "Hackeado",
        priceUnits: "1",
        durationMin: 30,
        bufferMin: 10,
        commission: "100",
        active: true,
      }),
  },
  { name: "retirar un servicio", prepare: async () => () => servicios.setServiceActiveAction({ serviceId: String(A.service), active: false }) },
  {
    name: "ascender a alguien a dueño",
    prepare: async () => () =>
      personal.updateStaffProfileAction({ staffId: String(A.users.reception.staffId), displayName: "X", role: "owner", active: true }),
  },
  { name: "borrar un horario", prepare: async () => () => personal.saveScheduleAction({ staffId: String(A.users.barber.staffId), blocks: [] }) },
  {
    name: "poner una ausencia",
    prepare: async () => {
      const date = addDays(base, 50);
      return () =>
        bloqueos.addStaffTimeOffAction({
          staffId: String(A.users.barber.staffId),
          kind: "absence",
          range: { allDay: true, fromDate: date, toDate: date },
        });
    },
  },
  {
    name: "anular una ausencia",
    prepare: async () => {
      const id = await timeOffFor(A.dummy, 250 + Number(uniq()));
      return () => bloqueos.cancelTimeOffAction({ timeOffId: String(id) });
    },
  },
  {
    name: "sacar a un barbero de la reserva en línea",
    prepare: async () => () => ajustes.setStaffBookableAction({ staffId: String(A.users.barber.staffId), bookable: false }),
  },
];

describe("el dueño de otra sede no alcanza nada de esta", () => {
  it.each(CROSS_LOCATION)("no puede $name", async ({ prepare }) => {
    const attempt = await prepare();
    signInAs(B.owner);
    const before = await fingerprint(A.location);
    const result = await attempt();
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(await fingerprint(A.location)).toBe(before);
  });

  it("no encuentra clientes de esta sede ni ve el historial de sus citas", async () => {
    const id = await appointmentFor(A.users.barber.staffId);
    signInAs(B.owner);
    expect(await agenda.findClients("Juan")).toEqual({ ok: true, data: [] });
    expect(await agenda.loadHistory(String(id))).toEqual({ ok: true, data: [] });
  });
});

// ─── Completitud ─────────────────────────────────────────────────────────────

describe("guarda de completitud", () => {
  it("toda server action exportada del panel está en la matriz de permisos", () => {
    // Cada export de un archivo "use server" es un endpoint público: si alguien agrega uno
    // y no lo pone en CASES, este test lo obliga a decidir quién puede usarlo.
    const exported = [agenda, servicios, personal, bloqueos, ajustes].flatMap((m) =>
      Object.entries(m)
        .filter(([, v]) => typeof v === "function")
        .map(([k]) => k),
    );
    const covered = new Set(CASES.map((c) => c.action));
    expect(exported.filter((name) => !covered.has(name))).toEqual([]);
  });
});
