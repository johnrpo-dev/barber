import { and, eq } from "drizzle-orm";
import { addDays, localMinuteToInstant } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { fromUnits, type Money } from "@/domain/money";
import type { PaymentKind } from "@/domain/sales/checkout";
import { changeStatus, createAppointment } from "./appointments";
import { createService } from "./catalog";
import { findOrCreateClient } from "./clients";
import { createLocation } from "./ledger";
import { checkout, type CheckoutCommand } from "./sales";
import { expenseCategories, paymentMethods } from "./schema";
import { addStaffMember, setWeeklySchedule } from "./staff";
import type { Db } from "./types";

// Datos de prueba del cobro (solo tests): una sede con su dueño, recepción, dos barberos, un corte
// de $30.000 al 40 % y citas en silla listas para cobrar.

export const TZ = "America/Bogota";

export interface Shop {
  locationId: bigint;
  owner: { userId: string; role: "owner"; staffId: bigint };
  reception: { userId: string; role: "reception"; staffId: bigint };
  barber: bigint;
  barber2: bigint;
  service: bigint;
  client: bigint;
  methods: Record<PaymentKind, bigint>;
  category: bigint;
  /** Para variar los horarios de las citas. */
  slot: number;
}

export async function setupShop(db: Db, name = "Villa"): Promise<Shop> {
  const locationId = await createLocation(db, { name });
  const ownerStaff = await addStaffMember(db, { locationId, displayName: `Dueño ${name}`, role: "owner" });
  const receptionStaff = await addStaffMember(db, { locationId, displayName: `Recepción ${name}`, role: "reception" });
  const barber = await addStaffMember(db, { locationId, displayName: "Andrés", role: "barber" });
  const barber2 = await addStaffMember(db, { locationId, displayName: "Bruno", role: "barber" });
  const allDay = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, startMin: 0, endMin: 1440 }));
  for (const s of [barber, barber2]) await setWeeklySchedule(db, { locationId, staffId: s, blocks: allDay });
  const service = (
    await createService(db, {
      locationId,
      draft: { name: "Corte", durationMin: 30, bufferMin: 10, price: fromUnits(30_000n), commissionBps: 4_000 },
    })
  ).id;
  const client = (await findOrCreateClient(db, { locationId, name: "Juan Pérez", phone: "300 123 4567" })).id;
  const methods = await db.select({ id: paymentMethods.id, kind: paymentMethods.kind }).from(paymentMethods).where(eq(paymentMethods.locationId, locationId));
  const [category] = await db
    .select({ id: expenseCategories.id })
    .from(expenseCategories)
    .where(and(eq(expenseCategories.locationId, locationId), eq(expenseCategories.name, "Insumos")));
  return {
    locationId,
    owner: { userId: `owner-${locationId}`, role: "owner", staffId: ownerStaff },
    reception: { userId: `reception-${locationId}`, role: "reception", staffId: receptionStaff },
    barber,
    barber2,
    service,
    client,
    methods: Object.fromEntries(methods.map((m) => [m.kind, m.id])) as Record<PaymentKind, bigint>,
    category: category!.id,
    slot: 0,
  };
}

let keySeq = 0;
export const key = (prefix = "k") => `${prefix}-${++keySeq}-${Date.now()}`.padEnd(12, "x");

/** Una cita en silla (o terminada) lista para cobrar. */
export async function chairAppointment(db: Db, shop: Shop, opts: { staffId?: bigint; completed?: boolean } = {}): Promise<bigint> {
  const k = shop.slot++;
  const date = addDays(businessDate(new Date(), TZ), 2 + Math.floor(k / 20));
  const { appointmentId } = await createAppointment(db, {
    locationId: shop.locationId,
    serviceId: shop.service,
    staffId: opts.staffId ?? shop.barber,
    start: localMinuteToInstant(date, 6 * 60 + (k % 20) * 45, TZ),
    clientId: shop.client,
    source: "staff",
    idempotencyKey: key("appt"),
    createdBy: shop.owner.userId,
  });
  await changeStatus(db, { locationId: shop.locationId, appointmentId, to: "in_chair", actor: shop.owner });
  if (opts.completed) await changeStatus(db, { locationId: shop.locationId, appointmentId, to: "completed", actor: shop.owner });
  return appointmentId;
}

const cop = (pesos: bigint): Money => fromUnits(pesos);

/** Cobro sencillo: el corte de $30.000 con un medio, opcionalmente con propina. */
export function simpleCheckout(
  shop: Shop,
  appointmentId: bigint,
  opts: { kind?: PaymentKind; tip?: bigint; tendered?: bigint; idempotencyKey?: string } = {},
): CheckoutCommand {
  const tip = opts.tip ?? 0n;
  const kind = opts.kind ?? "card";
  return {
    locationId: shop.locationId,
    appointmentId,
    extras: [],
    discounts: [],
    tips: tip > 0n ? [{ staffId: shop.barber, amount: cop(tip) }] : [],
    payments: [{ methodId: shop.methods[kind], amount: cop(30_000n + tip), tendered: opts.tendered ? cop(opts.tendered) : undefined }],
    idempotencyKey: opts.idempotencyKey ?? key("sale"),
    actor: shop.reception,
  };
}

/** Cobra una cita nueva y devuelve la venta. */
export async function quickSale(db: Db, shop: Shop, opts: { kind?: PaymentKind; tip?: bigint } = {}) {
  const appointmentId = await chairAppointment(db, shop);
  const { saleId } = await checkout(db, simpleCheckout(shop, appointmentId, opts));
  return { saleId, appointmentId };
}
