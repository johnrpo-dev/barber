import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { businessDate } from "@/domain/ledger/business-date";
import { type Money, money } from "@/domain/money";
import {
  type CheckoutLineInput,
  CheckoutError,
  type PaymentInput,
  priceCheckout,
  saleEntry,
  type TipInput,
} from "@/domain/sales/checkout";
import { assertSameRequest, requestHash } from "@/domain/security/idempotency";
import { canDiscount, type Role } from "@/domain/staff/roles";
import { changeStatus } from "./appointments";
import { openSession, requireOpenSession } from "./cash";
import { checkoutRulesOf } from "./checkout-settings";
import { findOrCreateClient } from "./clients";
import { isDayClosed, postEntry } from "./ledger";
import {
  appointments,
  cashMovements,
  clients,
  paymentMethods,
  saleLines,
  salePayments,
  sales,
  saleTips,
  services,
  staffMembers,
} from "./schema";
import { serializable } from "./serializable";
import type { Db } from "./types";
import { ulid } from "./ulid";

// Cobro (docs/sprint-4-cobro-caja.md §3 y §5). Todo en UNA transacción SERIALIZABLE con reintento:
// bloquea la cita, rearma líneas, precios, comisiones, medios de pago y reglas DESDE LA BASE (nunca
// del navegador), calcula con priceCheckout, inserta la venta con sus filas y registra el asiento.
// Postgres verifica al hacer COMMIT que totales, filas y asiento digan lo mismo (migración 0010).

/** Clave de la línea de la cita en `discounts` (las adicionales son "extra:<i>"). */
export const APPOINTMENT_LINE_KEY = "appointment";

/** "extra:<i>" sin ceros a la izquierda: una clave que no nombra exactamente una línea se rechaza. */
const EXTRA_KEY = /^extra:(0|[1-9]\d?)$/;

export interface CheckoutActor {
  userId: string;
  role: Role;
  staffId: bigint;
}

export interface CheckoutCommand {
  locationId: bigint;
  /**
   * La cita que se cobra, o null para un walk-in sin cita (§0 y §7): entonces los servicios son
   * `extras` (al menos uno, con su barbero) y el cliente es opcional (`clientId`).
   */
  appointmentId: bigint | null;
  /** Solo walk-in: el cliente, si se eligió. En una cita, el cliente es el de la cita. */
  clientId?: bigint | null;
  /**
   * Solo walk-in: un cliente nuevo (o el que ya tenga ese celular en la sede). Se crea DENTRO de la
   * transacción del cobro: si el cobro falla, no queda un cliente huérfano. Excluye `clientId`.
   */
  newClient?: { name: string; phone: string };
  extras: readonly { serviceId: bigint; staffId: bigint }[];
  discounts: readonly { key: string; amount: Money; reason: string }[];
  tips: readonly { staffId: bigint; amount: Money }[];
  payments: readonly { methodId: bigint; amount: Money; tendered?: Money }[];
  idempotencyKey: string;
  actor: CheckoutActor;
  now?: Date;
}

/** Huella de la petición: la misma clave con otro contenido es un conflicto. */
export function checkoutRequestHash(cmd: CheckoutCommand): string {
  return requestHash({
    kind: "checkout",
    locationId: cmd.locationId,
    appointmentId: cmd.appointmentId,
    // Solo en walk-in: la huella de un cobro de cita no cambia.
    ...(cmd.appointmentId === null
      ? {
          walkIn: true,
          clientId: cmd.clientId ?? null,
          ...(cmd.newClient ? { newClient: { name: cmd.newClient.name.trim(), phone: cmd.newClient.phone.replace(/\D/g, "") } } : {}),
        }
      : {}),
    extras: cmd.extras.map((e) => ({ serviceId: e.serviceId, staffId: e.staffId })),
    discounts: cmd.discounts.map((d) => ({ key: d.key, amount: d.amount.minor, reason: d.reason.trim() })),
    tips: cmd.tips.map((t) => ({ staffId: t.staffId, amount: t.amount.minor })),
    payments: cmd.payments.map((p) => ({ methodId: p.methodId, amount: p.amount.minor, tendered: p.tendered?.minor ?? null })),
    by: cmd.actor.userId,
  });
}

export const CHECKOUT_STATUSES = ["in_chair", "completed"] as const;

export async function paidSaleForAppointment(db: Db, locationId: bigint, appointmentId: bigint) {
  const [row] = await db
    .select({ id: sales.id, totalPaid: sales.totalPaid, createdAt: sales.createdAt })
    .from(sales)
    .where(and(eq(sales.locationId, locationId), eq(sales.appointmentId, appointmentId), eq(sales.status, "paid")));
  return row;
}

/** La cita a cobrar, bloqueada FOR UPDATE, sin venta pagada y en silla o terminada. */
async function lockAppointment(tx: Db, locationId: bigint, appointmentId: bigint) {
  const [appt] = await tx
    .select({
      id: appointments.id,
      status: appointments.status,
      serviceId: appointments.serviceId,
      staffId: appointments.staffId,
      serviceName: appointments.serviceName,
      price: appointments.price,
      clientId: appointments.clientId,
    })
    .from(appointments)
    .where(and(eq(appointments.locationId, locationId), eq(appointments.id, appointmentId)))
    .for("update");
  if (!appt) throw new CheckoutError("La cita no existe");
  if (await paidSaleForAppointment(tx, locationId, appt.id)) throw new CheckoutError("Esta cita ya está cobrada");
  if (!(CHECKOUT_STATUSES as readonly string[]).includes(appt.status)) {
    throw new CheckoutError("Solo se cobra una cita en silla o terminada");
  }
  return appt;
}

export async function checkout(db: Db, cmd: CheckoutCommand): Promise<{ saleId: bigint; created: boolean }> {
  const hash = checkoutRequestHash(cmd);
  return serializable(db, async (tx) => {
    const [existing] = await tx
      .select({ id: sales.id, requestHash: sales.requestHash })
      .from(sales)
      .where(and(eq(sales.locationId, cmd.locationId), eq(sales.idempotencyKey, cmd.idempotencyKey)));
    if (existing) {
      assertSameRequest(existing, hash);
      return { saleId: existing.id, created: false };
    }

    const now = cmd.now ?? new Date();
    const rules = await checkoutRulesOf(tx, cmd.locationId);
    const day = businessDate(now, rules.timeZone);
    if (await isDayClosed(tx, cmd.locationId, day)) {
      throw new CheckoutError(`El día ya está cerrado (${day}). El dueño debe reabrirlo para cobrar.`);
    }

    // La cita, bloqueada: dos cobros simultáneos de la misma cita se ponen en fila. Un walk-in no
    // tiene cita: sus servicios llegan en `extras` y su idempotencia es la de la venta.
    const appt = cmd.appointmentId === null ? null : await lockAppointment(tx, cmd.locationId, cmd.appointmentId);
    let clientId: bigint | null = appt?.clientId ?? null;
    if (!appt) {
      if (cmd.extras.length === 0) throw new CheckoutError("Elige al menos un servicio");
      if (cmd.newClient && cmd.clientId != null) throw new CheckoutError("Elige un cliente existente o uno nuevo, no los dos");
      if (cmd.newClient) {
        // En la misma transacción SERIALIZABLE: un reintento lo vuelve a crear o lo encuentra por celular.
        clientId = (await findOrCreateClient(tx, { locationId: cmd.locationId, name: cmd.newClient.name, phone: cmd.newClient.phone })).id;
      } else if (cmd.clientId !== undefined && cmd.clientId !== null) {
        const [client] = await tx
          .select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.locationId, cmd.locationId), eq(clients.id, cmd.clientId), isNull(clients.anonymizedAt)));
        if (!client) throw new CheckoutError("El cliente no existe en la sede");
        clientId = client.id;
      }
    }

    // Precios y comisiones de la base. La cita conserva el precio cotizado; la comisión se lee del
    // catálogo y se congela ahora (sprint 2: "la comisión se congela al cobrar").
    const serviceIds = [...(appt ? [appt.serviceId] : []), ...cmd.extras.map((e) => e.serviceId)];

    const svcRows = await tx
      .select({ id: services.id, name: services.name, price: services.price, commissionBps: services.commissionBps, active: services.active })
      .from(services)
      .where(and(eq(services.locationId, cmd.locationId), inArray(services.id, serviceIds)));
    const svc = new Map(svcRows.map((s) => [s.id, s]));
    const staffIds = [...new Set([...cmd.extras.map((e) => e.staffId), ...cmd.tips.map((t) => t.staffId)])];
    const staffRows = staffIds.length
      ? await tx
          .select({ id: staffMembers.id })
          .from(staffMembers)
          .where(and(eq(staffMembers.locationId, cmd.locationId), eq(staffMembers.active, true), inArray(staffMembers.id, staffIds)))
      : [];
    const activeStaff = new Set(staffRows.map((s) => s.id));
    if (staffIds.some((id) => !activeStaff.has(id))) throw new CheckoutError("Una de las personas elegidas no está activa en la sede");

    const discounts = new Map<string, { amount: Money; reason: string }>();
    for (const d of cmd.discounts) {
      // Toda clave debe nombrar exactamente una línea de esta venta; una desconocida se rechaza (L7).
      const isAppointment = d.key === APPOINTMENT_LINE_KEY && appt !== null;
      const isExtra = EXTRA_KEY.test(d.key) && Number(d.key.slice(6)) < cmd.extras.length;
      if (!isAppointment && !isExtra) throw new CheckoutError("El descuento no corresponde a ningún servicio");
      if (discounts.has(d.key)) throw new CheckoutError("Hay dos descuentos para el mismo servicio");
      discounts.set(d.key, { amount: d.amount, reason: d.reason.trim() });
    }
    if ([...discounts.values()].some((d) => d.amount.minor > 0n) && !canDiscount(cmd.actor.role, rules)) {
      throw new CheckoutError("No tienes permiso para dar descuentos");
    }
    for (const d of discounts.values()) if (d.reason.length > 200) throw new CheckoutError("El motivo del descuento es muy largo");

    const zero = money(0n);
    const lineFor = (key: string, base: { serviceId: bigint; staffId: bigint; description: string; price: bigint }): CheckoutLineInput & {
      serviceId: bigint;
    } => {
      const s = svc.get(base.serviceId);
      if (!s) throw new CheckoutError("Un servicio de la venta no existe");
      const d = discounts.get(key);
      return {
        serviceId: base.serviceId,
        staffId: base.staffId,
        description: base.description,
        unitPrice: money(base.price),
        discount: d?.amount ?? zero,
        discountReason: d?.amount.minor ? d.reason : undefined,
        commissionBps: BigInt(s.commissionBps),
      };
    };
    const lines = [
      ...(appt
        ? [lineFor(APPOINTMENT_LINE_KEY, { serviceId: appt.serviceId, staffId: appt.staffId, description: appt.serviceName, price: appt.price })]
        : []),
      ...cmd.extras.map((e, i) => {
        const s = svc.get(e.serviceId);
        if (!s?.active) throw new CheckoutError("Un servicio adicional no existe o ya no se ofrece");
        return lineFor(`extra:${i}`, { serviceId: e.serviceId, staffId: e.staffId, description: s.name, price: s.price });
      }),
    ];

    const methodIds = cmd.payments.map((p) => p.methodId);
    const methodRows = methodIds.length
      ? await tx
          .select({ id: paymentMethods.id, kind: paymentMethods.kind, label: paymentMethods.label, feeBps: paymentMethods.feeBps })
          .from(paymentMethods)
          .where(and(eq(paymentMethods.locationId, cmd.locationId), eq(paymentMethods.active, true), inArray(paymentMethods.id, methodIds)))
      : [];
    const methods = new Map(methodRows.map((m) => [m.id, m]));
    const payments: (PaymentInput & { label: string })[] = cmd.payments.map((p) => {
      const m = methods.get(p.methodId);
      if (!m) throw new CheckoutError("Ese medio de pago no está disponible");
      return { methodId: m.id, kind: m.kind, label: m.label, amount: p.amount, tendered: p.tendered, feeBps: BigInt(m.feeBps) };
    });
    const tips: TipInput[] = cmd.tips.map((t) => ({ staffId: t.staffId, amount: t.amount }));

    const priced = priceCheckout({ lines, payments, tips }, rules);

    // El efectivo exige la caja abierta, bloqueada: un cierre no se cruza con este cobro.
    const hasCash = priced.payments.some((p) => p.kind === "cash");
    const session = hasCash ? await requireOpenSession(tx, cmd.locationId, "Abre la caja para recibir efectivo") : null;

    if (appt?.status === "in_chair") {
      await changeStatus(tx, {
        locationId: cmd.locationId,
        appointmentId: appt.id,
        to: "completed",
        actor: { userId: cmd.actor.userId, role: cmd.actor.role, staffId: cmd.actor.staffId },
        note: "Cobrada",
        now,
      });
    }

    const publicId = ulid(now.getTime());
    const memo = `Venta ${publicId}: ${priced.lines.map((l) => l.description).join(", ")}`.slice(0, 300);
    const posted = await postEntry(tx, {
      locationId: cmd.locationId,
      createdBy: cmd.actor.userId,
      entry: saleEntry(priced, { businessDate: day, memo, idempotencyKey: `sale:${cmd.idempotencyKey}` }),
    });
    const [sale] = await tx
      .insert(sales)
      .values({
        locationId: cmd.locationId,
        publicId,
        appointmentId: appt?.id ?? null,
        clientId,
        businessDate: day,
        journalEntryId: posted.entryId,
        subtotal: priced.subtotal.minor,
        discount: priced.discount.minor,
        tips: priced.tipsTotal.minor,
        totalPaid: priced.totalDue.minor,
        createdBy: cmd.actor.userId,
        idempotencyKey: cmd.idempotencyKey,
        requestHash: hash,
      })
      .returning({ id: sales.id });
    const saleId = sale!.id;
    await tx.insert(saleLines).values(
      priced.lines.map((l, i) => ({
        locationId: cmd.locationId,
        saleId,
        position: i,
        serviceId: lines[i]!.serviceId,
        staffId: l.staffId,
        description: l.description,
        unitPrice: l.unitPrice.minor,
        discount: l.discount.minor,
        discountReason: l.discount.minor > 0n ? (l.discountReason ?? null) : null,
        net: l.net.minor,
        commissionBps: Number(l.commissionBps),
        commission: l.commission.minor,
      })),
    );
    await tx.insert(salePayments).values(
      priced.payments.map((p, i) => ({
        locationId: cmd.locationId,
        saleId,
        methodId: p.methodId,
        kind: p.kind,
        label: payments[i]!.label,
        feeBps: Number(p.feeBps),
        amount: p.amount.minor,
        tendered: p.kind === "cash" ? p.tendered!.minor : null,
        change: p.kind === "cash" ? p.change.minor : null,
        fee: p.fee.minor,
      })),
    );
    if (priced.tips.length > 0) {
      await tx.insert(saleTips).values(
        priced.tips.map((t) => ({
          locationId: cmd.locationId,
          saleId,
          staffId: t.staffId,
          amount: t.amount.minor,
          feeShare: t.feeShare.minor,
          payable: t.payable.minor,
        })),
      );
    }
    if (session) {
      await tx.insert(cashMovements).values({
        locationId: cmd.locationId,
        cashSessionId: session.id,
        kind: "sale",
        journalEntryId: posted.entryId,
        description: `Venta: ${priced.lines.map((l) => l.description).join(", ")}`.slice(0, 200),
        createdBy: cmd.actor.userId,
      });
    }
    return { saleId, created: true };
  });
}

// ─── Lecturas ────────────────────────────────────────────────────────────────

export interface SaleDetail {
  id: bigint;
  publicId: string;
  businessDate: string;
  status: "paid" | "voided";
  createdAt: Date;
  createdBy: string;
  chargedByName: string | null;
  clientName: string | null;
  journalEntryId: bigint;
  totalPaid: bigint;
  lines: { description: string; staffId: bigint; unitPrice: bigint; discount: bigint; net: bigint; commission: bigint }[];
  tips: { staffId: bigint; staffName: string; amount: bigint; payable: bigint }[];
  payments: { kind: string; label: string; amount: bigint; tendered: bigint | null; change: bigint | null; fee: bigint }[];
}

/** Venta completa de la sede (null si no existe en ESTA sede). */
export async function saleDetail(db: Db, locationId: bigint, saleId: bigint): Promise<SaleDetail | null> {
  const [sale] = await db
    .select({
      id: sales.id,
      publicId: sales.publicId,
      businessDate: sales.businessDate,
      status: sales.status,
      createdAt: sales.createdAt,
      createdBy: sales.createdBy,
      // Nombre en la sede (staff_members), no el de la cuenta: ese lo controla cada quien.
      chargedByName: staffMembers.displayName,
      clientName: clients.name,
      journalEntryId: sales.journalEntryId,
      totalPaid: sales.totalPaid,
    })
    .from(sales)
    .leftJoin(staffMembers, and(eq(staffMembers.locationId, sales.locationId), eq(staffMembers.userId, sales.createdBy)))
    .leftJoin(clients, and(eq(clients.locationId, sales.locationId), eq(clients.id, sales.clientId)))
    .where(and(eq(sales.locationId, locationId), eq(sales.id, saleId)));
  if (!sale) return null;
  const [lines, tips, payments] = await Promise.all([
    db
      .select({
        description: saleLines.description,
        staffId: saleLines.staffId,
        unitPrice: saleLines.unitPrice,
        discount: saleLines.discount,
        net: saleLines.net,
        commission: saleLines.commission,
      })
      .from(saleLines)
      .where(and(eq(saleLines.locationId, locationId), eq(saleLines.saleId, saleId)))
      .orderBy(asc(saleLines.position)),
    db
      .select({ staffId: saleTips.staffId, staffName: staffMembers.displayName, amount: saleTips.amount, payable: saleTips.payable })
      .from(saleTips)
      .innerJoin(staffMembers, and(eq(staffMembers.locationId, saleTips.locationId), eq(staffMembers.id, saleTips.staffId)))
      .where(and(eq(saleTips.locationId, locationId), eq(saleTips.saleId, saleId)))
      .orderBy(asc(saleTips.id)),
    db
      .select({
        kind: salePayments.kind,
        label: salePayments.label,
        amount: salePayments.amount,
        tendered: salePayments.tendered,
        change: salePayments.change,
        fee: salePayments.fee,
      })
      .from(salePayments)
      .where(and(eq(salePayments.locationId, locationId), eq(salePayments.saleId, saleId)))
      .orderBy(asc(salePayments.id)),
  ]);
  return { ...sale, lines, tips, payments };
}

/** Lo que necesita la hoja de cobro, leído de la base (el servidor vuelve a leerlo al cobrar). */
export async function checkoutContext(db: Db, input: { locationId: bigint; appointmentId: bigint; now?: Date }) {
  const now = input.now ?? new Date();
  const [appt] = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      serviceId: appointments.serviceId,
      serviceName: appointments.serviceName,
      staffId: appointments.staffId,
      staffName: staffMembers.displayName,
      price: appointments.price,
      clientName: clients.name,
      commissionBps: services.commissionBps,
    })
    .from(appointments)
    .innerJoin(staffMembers, and(eq(staffMembers.locationId, appointments.locationId), eq(staffMembers.id, appointments.staffId)))
    .innerJoin(services, and(eq(services.locationId, appointments.locationId), eq(services.id, appointments.serviceId)))
    .leftJoin(clients, and(eq(clients.locationId, appointments.locationId), eq(clients.id, appointments.clientId)))
    .where(and(eq(appointments.locationId, input.locationId), eq(appointments.id, input.appointmentId)));
  if (!appt) return null;
  const rules = await checkoutRulesOf(db, input.locationId);
  const day = businessDate(now, rules.timeZone);
  const [extraServices, staff, methods, session, dayClosed, paid] = await Promise.all([
    db
      .select({ id: services.id, name: services.name, price: services.price, commissionBps: services.commissionBps })
      .from(services)
      .where(and(eq(services.locationId, input.locationId), eq(services.active, true)))
      .orderBy(asc(services.name)),
    db
      .select({ id: staffMembers.id, name: staffMembers.displayName })
      .from(staffMembers)
      .where(and(eq(staffMembers.locationId, input.locationId), eq(staffMembers.active, true)))
      .orderBy(asc(staffMembers.displayName)),
    db
      .select({ id: paymentMethods.id, kind: paymentMethods.kind, label: paymentMethods.label, feeBps: paymentMethods.feeBps })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.locationId, input.locationId), eq(paymentMethods.active, true)))
      .orderBy(asc(paymentMethods.id)),
    openSession(db, input.locationId),
    isDayClosed(db, input.locationId, day),
    paidSaleForAppointment(db, input.locationId, input.appointmentId),
  ]);
  return { appointment: appt, rules, businessDate: day, extraServices, staff, methods, cashSessionOpen: Boolean(session), dayClosed, paid };
}

/** Lo que necesita la hoja de cobro de un walk-in (sin cita): catálogo, personal, medios y reglas. */
export async function walkInCheckoutContext(db: Db, input: { locationId: bigint; now?: Date }) {
  const now = input.now ?? new Date();
  const rules = await checkoutRulesOf(db, input.locationId);
  const day = businessDate(now, rules.timeZone);
  const [services_, staff, methods, session, dayClosed] = await Promise.all([
    db
      .select({ id: services.id, name: services.name, price: services.price, commissionBps: services.commissionBps })
      .from(services)
      .where(and(eq(services.locationId, input.locationId), eq(services.active, true)))
      .orderBy(asc(services.name)),
    db
      .select({ id: staffMembers.id, name: staffMembers.displayName, role: staffMembers.role })
      .from(staffMembers)
      .where(and(eq(staffMembers.locationId, input.locationId), eq(staffMembers.active, true)))
      .orderBy(asc(staffMembers.displayName)),
    db
      .select({ id: paymentMethods.id, kind: paymentMethods.kind, label: paymentMethods.label, feeBps: paymentMethods.feeBps })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.locationId, input.locationId), eq(paymentMethods.active, true)))
      .orderBy(asc(paymentMethods.id)),
    openSession(db, input.locationId),
    isDayClosed(db, input.locationId, day),
  ]);
  return { rules, businessDate: day, services: services_, staff, methods, cashSessionOpen: Boolean(session), dayClosed };
}
