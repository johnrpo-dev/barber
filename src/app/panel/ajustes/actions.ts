"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  auditActor,
  bookingSettingsSnapshot,
  checkoutRulesSnapshot,
  expenseCategorySnapshot,
  paymentMethodSnapshot,
  recordConfigChange,
  staffSnapshot,
} from "@/db/audit";
import {
  checkoutRulesOf,
  listExpenseCategories,
  listPaymentMethods,
  saveExpenseCategory,
  savePaymentMethod,
  updateCheckoutRules,
} from "@/db/checkout-settings";
import { db } from "@/db/client";
import { setStaffBookableOnline, updateLocationSettings } from "@/db/locations";
import { StaffError } from "@/db/staff";
import type { Db } from "@/db/types";
import { AUDIT_FIELDS } from "@/domain/audit/events";
import { InvalidClientError, normalizePhone } from "@/domain/clients/client";
import { type ActionResult, idSchema, runAction } from "@/lib/action";
import { bpsSchema, unitsSchema } from "@/lib/action-schemas";
import { requirePermission, requireRecentAuth } from "@/lib/session";

// Ajustes de la sede (solo el dueño). La sede sale SIEMPRE de la sesión, nunca del cliente.

const conn = () => db() as unknown as Db;

const minutes = (min: number, max: number, label: string) =>
  z.number().int(`${label}: escribe un número entero`).min(min, `${label}: mínimo ${min}`).max(max, `${label}: máximo ${max}`);

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} es muy largo`)
    .transform((v) => v || null);

const settingsSchema = z.object({
  publicBookingEnabled: z.boolean(),
  publicPhone: optionalText(30, "El teléfono"),
  address: optionalText(200, "La dirección"),
  mapsUrl: optionalText(500, "El enlace del mapa").refine(
    (v) => v === null || /^https:\/\/\S+$/.test(v),
    "El enlace del mapa debe empezar por https://",
  ),
  slotStepMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30)], "Elige cada cuánto se ofrecen turnos"),
  minAdvanceMin: minutes(0, 1440, "La anticipación mínima"),
  maxAdvanceDays: minutes(1, 60, "Los días hacia adelante"),
  holdMin: minutes(10, 30, "El tiempo para confirmar"),
  freeCancelHours: minutes(0, 72, "Las horas para cancelar sin penalidad"),
  noShowGraceMin: minutes(0, 60, "La tolerancia de llegada"),
  maxActivePerClient: minutes(1, 10, "Las citas activas por cliente"),
});

export async function updateBookingSettingsAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("settings.manage");
    const input = settingsSchema.parse(raw);
    let publicPhone: string | null = null;
    if (input.publicPhone) {
      // Celular en E.164 (sirve para el enlace de WhatsApp); un fijo se guarda como se escribió.
      publicPhone = normalizePhone(input.publicPhone) ?? (/^\+?[\d\s()-]{7,20}$/.test(input.publicPhone) ? input.publicPhone : null);
      if (!publicPhone) throw new InvalidClientError("El teléfono público no parece un número válido");
    }
    if (input.publicBookingEnabled && !publicPhone && !input.address) {
      throw new InvalidClientError("Para abrir la reserva en línea, escribe al menos el teléfono o la dirección de la sede");
    }
    await conn().transaction(async (tx) => {
      const t = tx as unknown as Db;
      const before = await bookingSettingsSnapshot(t, staff.locationId);
      await updateLocationSettings(t, staff.locationId, { ...input, publicPhone });
      const after = await bookingSettingsSnapshot(t, staff.locationId);
      // El teléfono público nunca entra a la bitácora: no está en la lista blanca.
      await recordConfigChange(
        t,
        { ...auditActor(staff), action: "settings.booking", targetKind: "location", targetRef: staff.locationId.toString(), summary: "Cambió los ajustes de la reserva en línea" },
        before,
        after,
        AUDIT_FIELDS.bookingSettings,
      );
    });
    revalidatePath("/panel/ajustes");
    revalidatePath("/", "layout");
    return undefined;
  });
}

const bookableSchema = z.object({ staffId: idSchema, bookable: z.boolean() });

export async function setStaffBookableAction(raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const staff = await requirePermission("settings.manage");
    const input = bookableSchema.parse(raw);
    await conn().transaction(async (tx) => {
      const t = tx as unknown as Db;
      const before = await staffSnapshot(t, staff.locationId, input.staffId);
      if (!before) throw new StaffError("La persona no existe en esta sede");
      await setStaffBookableOnline(t, { locationId: staff.locationId, staffId: input.staffId, bookable: input.bookable });
      await recordConfigChange(
        t,
        {
          ...auditActor(staff),
          action: "staff.bookable",
          targetKind: "staff",
          targetRef: input.staffId.toString(),
          summary: `${input.bookable ? "Abrió" : "Cerró"} la reserva en línea de ${String(before.displayName)}`,
        },
        before,
        { ...before, bookableOnline: input.bookable },
        AUDIT_FIELDS.staff,
      );
    });
    revalidatePath("/panel/ajustes");
    return undefined;
  });
}

// ─── Cobro (sprint 4, docs/sprint-4-cobro-caja.md §9) ────────────────────────
// Los puntos básicos llegan como texto de dígitos ("299") y se validan como bigint.

export interface CheckoutSettingsView {
  methods: { id: string; kind: "cash" | "card" | "transfer" | "wallet"; label: string; feeBps: string; active: boolean }[];
  categories: { id: string; name: string; accountCode: string; active: boolean }[];
  rules: {
    commissionBase: "net" | "gross";
    maxDiscountBps: string;
    receptionCanDiscount: boolean;
    tipsBearCardFees: boolean;
    /** Límite de diferencia de caja para revisión, en pesos (texto de dígitos). */
    cashReviewThresholdUnits: string;
  };
}

export async function loadCheckoutSettings(): Promise<ActionResult<CheckoutSettingsView>> {
  const staff = await requirePermission("settings.manage");
  return runAction(async () => {
    const [methods, categories, rules] = await Promise.all([
      listPaymentMethods(conn(), { locationId: staff.locationId }),
      listExpenseCategories(conn(), { locationId: staff.locationId }),
      checkoutRulesOf(conn(), staff.locationId),
    ]);
    return {
      methods: methods.map((m) => ({ id: m.id.toString(), kind: m.kind, label: m.label, feeBps: m.feeBps.toString(), active: m.active })),
      categories: categories.map((c) => ({ id: c.id.toString(), name: c.name, accountCode: c.accountCode, active: c.active })),
      rules: {
        commissionBase: rules.commissionBase,
        maxDiscountBps: rules.maxDiscountBps.toString(),
        receptionCanDiscount: rules.receptionCanDiscount,
        tipsBearCardFees: rules.tipsBearCardFees,
        cashReviewThresholdUnits: (rules.cashReviewThreshold / 100n).toString(),
      },
    };
  });
}

const methodSchema = z.object({
  id: idSchema.optional(),
  kind: z.enum(["cash", "card", "transfer", "wallet"], "Elige el tipo de medio de pago"),
  label: z.string().max(40, "El nombre es muy largo"),
  feeBps: bpsSchema("El costo del medio de pago", 9_999n),
  active: z.boolean(),
});

export async function savePaymentMethodAction(raw: z.input<typeof methodSchema>): Promise<ActionResult<{ id: string }>> {
  const staff = await requirePermission("settings.manage");
  return runAction(async () => {
    // Cambia cuánto se descuenta de cada cobro: confirmar identidad.
    requireRecentAuth(staff);
    const input = methodSchema.parse(raw);
    const id = await conn().transaction(async (tx) => {
      const t = tx as unknown as Db;
      const before = input.id === undefined ? null : await paymentMethodSnapshot(t, staff.locationId, input.id);
      const saved = await savePaymentMethod(t, { ...input, locationId: staff.locationId });
      const after = await paymentMethodSnapshot(t, staff.locationId, saved);
      await recordConfigChange(
        t,
        {
          ...auditActor(staff),
          action: "payment_method.save",
          targetKind: "payment_method",
          targetRef: saved.toString(),
          summary: `${before ? "Cambió" : "Creó"} el medio de pago ${input.label.trim()}`,
        },
        before ?? {},
        after!,
        AUDIT_FIELDS.paymentMethod,
      );
      return saved;
    });
    revalidatePath("/panel/ajustes");
    return { id: id.toString() };
  });
}

const categorySchema = z.object({
  id: idSchema.optional(),
  name: z.string().max(60, "El nombre es muy largo"),
  accountCode: z.string().max(10),
  active: z.boolean(),
});

export async function saveExpenseCategoryAction(raw: z.input<typeof categorySchema>): Promise<ActionResult<{ id: string }>> {
  const staff = await requirePermission("settings.manage");
  return runAction(async () => {
    // Decide a qué cuenta del libro van los gastos: confirmar identidad.
    requireRecentAuth(staff);
    const input = categorySchema.parse(raw);
    const id = await conn().transaction(async (tx) => {
      const t = tx as unknown as Db;
      const before = input.id === undefined ? null : await expenseCategorySnapshot(t, staff.locationId, input.id);
      const saved = await saveExpenseCategory(t, { ...input, locationId: staff.locationId });
      const after = await expenseCategorySnapshot(t, staff.locationId, saved);
      await recordConfigChange(
        t,
        {
          ...auditActor(staff),
          action: "expense_category.save",
          targetKind: "expense_category",
          targetRef: saved.toString(),
          summary: `${before ? "Cambió" : "Creó"} la categoría de gasto ${input.name.trim()}`,
        },
        before ?? {},
        after!,
        AUDIT_FIELDS.expenseCategory,
      );
      return saved;
    });
    revalidatePath("/panel/ajustes");
    revalidatePath("/panel/caja");
    return { id: id.toString() };
  });
}

const rulesSchema = z.object({
  commissionBase: z.enum(["net", "gross"], "Elige la base de la comisión"),
  maxDiscountBps: bpsSchema("El tope de descuento", 10_000n),
  receptionCanDiscount: z.boolean(),
  tipsBearCardFees: z.boolean(),
  // Conteo a ciegas: desde qué diferencia (faltante o sobrante) un cierre de caja va a revisión.
  cashReviewThresholdUnits: unitsSchema("El límite de diferencia de caja").optional(),
});

export async function updateCheckoutRulesAction(raw: z.input<typeof rulesSchema>): Promise<ActionResult> {
  const staff = await requirePermission("settings.manage");
  return runAction(async () => {
    // Comisiones, descuentos y propinas: confirmar identidad.
    requireRecentAuth(staff);
    const input = rulesSchema.parse(raw);
    const { cashReviewThresholdUnits, ...rules } = input;
    await conn().transaction(async (tx) => {
      const t = tx as unknown as Db;
      const before = await checkoutRulesSnapshot(t, staff.locationId);
      await updateCheckoutRules(t, staff.locationId, { ...rules, cashReviewThreshold: cashReviewThresholdUnits });
      const after = await checkoutRulesSnapshot(t, staff.locationId);
      await recordConfigChange(
        t,
        { ...auditActor(staff), action: "settings.checkout_rules", targetKind: "location", targetRef: staff.locationId.toString(), summary: "Cambió las reglas de cobro" },
        before,
        after,
        AUDIT_FIELDS.checkoutRules,
      );
    });
    revalidatePath("/panel/ajustes");
    return undefined;
  });
}
