"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db/client";
import { checkout, checkoutContext, saleDetail, walkInCheckoutContext } from "@/db/sales";
import type { Db } from "@/db/types";
import { requestVoid } from "@/db/voids";
import { CheckoutError } from "@/domain/sales/checkout";
import { canDiscount } from "@/domain/staff/roles";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { idempotencyKeySchema, unitsSchema } from "@/lib/action-schemas";
import { absLabel, minorText, moneyLabel } from "@/lib/labels";
import { requirePermission } from "@/lib/session";

// Cobro (docs/sprint-4-cobro-caja.md §9). La sede, los precios, las comisiones, los medios de pago,
// las reglas y el día contable salen de la base; del navegador solo llegan las elecciones.
// Walk-in (§9.2): un cobro sin cita, con los servicios y el barbero elegidos en la hoja y el
// cliente opcional; mismo cálculo, mismo asiento, misma idempotencia que el cobro de una cita.

const database = () => db() as unknown as Db;

function refresh() {
  revalidatePath("/panel/agenda");
  revalidatePath("/panel/mi-dia");
  revalidatePath("/panel/caja");
  revalidatePath("/panel/anulaciones");
}

export interface CheckoutView {
  /** null: walk-in (cobro sin cita). */
  appointmentId: string | null;
  clientName: string | null;
  status: string;
  lines: {
    key: string;
    serviceId: string;
    serviceName: string;
    staffId: string;
    staffName: string;
    unitPriceMinor: string;
    unitPriceLabel: string;
    commissionBps: string;
  }[];
  /** commissionBps solo para la vista previa: el servidor la vuelve a leer al cobrar. */
  extraServices: { serviceId: string; name: string; unitPriceMinor: string; unitPriceLabel: string; commissionBps: string }[];
  staff: { id: string; name: string }[];
  methods: { id: string; kind: "cash" | "card" | "transfer" | "wallet"; label: string; feeBps: string }[];
  rules: { maxDiscountBps: string; canDiscount: boolean; tipsBearCardFees: boolean; commissionBase: "net" | "gross" };
  cashSessionOpen: boolean;
  dayClosed: boolean;
  businessDate: string;
  paid: { saleId: string; totalLabel: string; paidAt: string } | null;
}

const loadInput = z.object({ appointmentId: idSchema });

export async function loadCheckout(raw: z.input<typeof loadInput>): Promise<ActionResult<CheckoutView>> {
  const staff = await requirePermission("ledger.post");
  return runAction(async () => {
    const input = loadInput.parse(raw);
    const ctx = await checkoutContext(database(), { locationId: staff.locationId, appointmentId: input.appointmentId });
    if (!ctx) throw new CheckoutError("La cita no existe");
    const a = ctx.appointment;
    return {
      appointmentId: a.id.toString(),
      clientName: a.clientName,
      status: a.status,
      lines: [
        {
          key: "appointment",
          serviceId: a.serviceId.toString(),
          serviceName: a.serviceName,
          staffId: a.staffId.toString(),
          staffName: a.staffName,
          unitPriceMinor: minorText(a.price),
          unitPriceLabel: moneyLabel(a.price),
          // Solo para la vista previa: el servidor la vuelve a leer al cobrar.
          commissionBps: String(a.commissionBps),
        },
      ],
      extraServices: ctx.extraServices.map((s) => ({
        serviceId: s.id.toString(),
        name: s.name,
        unitPriceMinor: minorText(s.price),
        unitPriceLabel: moneyLabel(s.price),
        commissionBps: String(s.commissionBps),
      })),
      staff: ctx.staff.map((s) => ({ id: s.id.toString(), name: s.name })),
      methods: ctx.methods.map((m) => ({ id: m.id.toString(), kind: m.kind, label: m.label, feeBps: String(m.feeBps) })),
      rules: {
        maxDiscountBps: ctx.rules.maxDiscountBps.toString(),
        canDiscount: canDiscount(staff.role, ctx.rules),
        tipsBearCardFees: ctx.rules.tipsBearCardFees,
        commissionBase: ctx.rules.commissionBase,
      },
      cashSessionOpen: ctx.cashSessionOpen,
      dayClosed: ctx.dayClosed,
      businessDate: ctx.businessDate,
      paid: ctx.paid ? { saleId: ctx.paid.id.toString(), totalLabel: moneyLabel(ctx.paid.totalPaid), paidAt: ctx.paid.createdAt.toISOString() } : null,
    };
  });
}

/** Hoja de cobro sin cita: todos los servicios activos, el personal activo y los medios de pago. */
export async function loadWalkInCheckout(): Promise<ActionResult<CheckoutView>> {
  const staff = await requirePermission("ledger.post");
  return runAction(async () => {
    const ctx = await walkInCheckoutContext(database(), { locationId: staff.locationId });
    return {
      appointmentId: null,
      clientName: null,
      status: "walk_in",
      lines: [],
      extraServices: ctx.services.map((s) => ({
        serviceId: s.id.toString(),
        name: s.name,
        unitPriceMinor: minorText(s.price),
        unitPriceLabel: moneyLabel(s.price),
        commissionBps: String(s.commissionBps),
      })),
      // Primero quienes atienden (barberos), después el resto del personal activo.
      staff: [...ctx.staff].sort((a, b) => Number(b.role === "barber") - Number(a.role === "barber")).map((s) => ({ id: s.id.toString(), name: s.name })),
      methods: ctx.methods.map((m) => ({ id: m.id.toString(), kind: m.kind, label: m.label, feeBps: String(m.feeBps) })),
      rules: {
        maxDiscountBps: ctx.rules.maxDiscountBps.toString(),
        canDiscount: canDiscount(staff.role, ctx.rules),
        tipsBearCardFees: ctx.rules.tipsBearCardFees,
        commissionBase: ctx.rules.commissionBase,
      },
      cashSessionOpen: ctx.cashSessionOpen,
      dayClosed: ctx.dayClosed,
      businessDate: ctx.businessDate,
      paid: null,
    };
  });
}

export interface Receipt {
  saleId: string;
  totalLabel: string;
  changeLabel: string | null;
  lines: { description: string; netLabel: string }[];
  tips: { staffName: string; amountLabel: string }[];
  payments: { label: string; amountLabel: string }[];
  businessDate: string;
}

const clientInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), id: idSchema }),
  z.object({ kind: z.literal("new"), name: z.string().max(80, "El nombre es muy largo"), phone: z.string().max(30) }),
  z.object({ kind: z.literal("none") }),
]);

const checkoutInput = z
  .object({
  /** null: walk-in. */
  appointmentId: idSchema.nullable(),
  /** Solo walk-in: el cliente es opcional. En una cita, el cliente es el de la cita. */
  client: clientInput.optional(),
  // Hasta 20 líneas por venta: la cita más 19, o 20 en un walk-in.
  extras: z.array(z.object({ serviceId: idSchema, staffId: idSchema })).max(20, "Demasiados servicios"),
  discounts: z
    .array(z.object({ key: z.string().max(20), amountUnits: unitsSchema("El descuento"), reason: z.string().max(200, "El motivo del descuento es muy largo") }))
    .max(20),
  tips: z.array(z.object({ staffId: idSchema, amountUnits: unitsSchema("La propina") })).max(10, "Demasiadas propinas"),
  payments: z
    .array(z.object({ methodId: idSchema, amountUnits: unitsSchema("El pago"), tenderedUnits: unitsSchema("El efectivo entregado").optional() }))
    .min(1, "Elige cómo paga el cliente")
    .max(5, "Demasiados pagos"),
  idempotencyKey: idempotencyKeySchema,
})
  .refine((v) => v.appointmentId === null || v.extras.length <= 19, { message: "Demasiados servicios", path: ["extras"] })
  .refine((v) => v.appointmentId === null || v.client === undefined, { message: "El cliente de una cita es el de la cita", path: ["client"] })
  .refine((v) => v.appointmentId !== null || v.extras.length > 0, { message: "Elige al menos un servicio", path: ["extras"] });

export async function checkoutAction(raw: z.input<typeof checkoutInput>): Promise<ActionResult<Receipt>> {
  const staff = await requirePermission("ledger.post");
  return runAction(async () => {
    const input = checkoutInput.parse(raw);
    const conn = database();
    // Walk-in: el cliente existente se verifica, y el nuevo se crea (o se encuentra por celular)
    // dentro de la transacción del cobro: si el cobro falla, no queda un cliente huérfano.
    const walkInClient =
      input.appointmentId === null
        ? input.client?.kind === "existing"
          ? { clientId: input.client.id }
          : input.client?.kind === "new"
            ? { clientId: null, newClient: { name: input.client.name, phone: input.client.phone } }
            : { clientId: null }
        : {};
    const { saleId } = await checkout(conn, {
      locationId: staff.locationId,
      appointmentId: input.appointmentId,
      ...walkInClient,
      extras: input.extras,
      discounts: input.discounts.map((d) => ({ key: d.key, amount: d.amountUnits, reason: d.reason })),
      tips: input.tips.map((t) => ({ staffId: t.staffId, amount: t.amountUnits })),
      payments: input.payments.map((p) => ({ methodId: p.methodId, amount: p.amountUnits, tendered: p.tenderedUnits })),
      idempotencyKey: input.idempotencyKey,
      actor: { userId: staff.userId, role: staff.role, staffId: staff.staffId },
    });
    const sale = await saleDetail(conn, staff.locationId, saleId);
    if (!sale) throw new Error(`La venta ${saleId} no se encontró después de cobrar`);
    refresh();
    // El recibo se arma con lo guardado: un reintento con la misma clave devuelve exactamente lo mismo.
    const change = sale.payments.reduce((acc, p) => acc + (p.change ?? 0n), 0n);
    return {
      saleId: sale.id.toString(),
      totalLabel: moneyLabel(sale.totalPaid),
      changeLabel: change > 0n ? moneyLabel(change) : null,
      lines: sale.lines.map((l) => ({ description: l.description, netLabel: moneyLabel(l.net) })),
      tips: sale.tips.map((t) => ({ staffName: t.staffName, amountLabel: absLabel(t.amount) })),
      payments: sale.payments.map((p) => ({ label: p.label, amountLabel: moneyLabel(p.amount) })),
      businessDate: sale.businessDate,
    };
  });
}

const voidInput = z.object({ saleId: idSchema, reason: z.string().max(300, "El motivo es muy largo"), idempotencyKey: idempotencyKeySchema });

export async function requestVoidAction(raw: z.input<typeof voidInput>): Promise<ActionResult<{ requestId: string }>> {
  const staff = await requirePermission("ledger.post");
  return runAction(async () => {
    const input = voidInput.parse(raw);
    const { requestId } = await requestVoid(database(), {
      locationId: staff.locationId,
      saleId: input.saleId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      actor: { userId: staff.userId },
    });
    refresh();
    return { requestId: requestId.toString() };
  });
}
