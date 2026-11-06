// Bitácora de auditoría (docs/sprint-5-comisiones-informes.md §8): qué acciones financieras y de
// configuración se registran, con qué categoría y cómo se describen. Sin datos personales de
// clientes: ni nombres, ni celulares, ni correos. La base vuelve a exigir la lista (CHECK de 0013).

export const AUDIT_ACTIONS = [
  // Finanzas
  "sale.checkout",
  "void.request",
  "void.approve",
  "void.reject",
  "cash.open",
  "cash.close",
  "cash.review",
  "expense.add",
  "tips.pay",
  "cash.deposit",
  "day.close",
  "day.reopen",
  "settlement.create",
  "settlement.reverse",
  "advance.create",
  "advance.reverse",
  // Configuración
  "service.create",
  "service.update",
  "service.active",
  "settings.booking",
  "settings.checkout_rules",
  "payment_method.save",
  "expense_category.save",
  "staff.bookable",
  // Personal
  "staff.create",
  "staff.update",
  "staff.password_reset",
  "staff.sessions_revoke",
  "schedule.save",
  "account.password_change",
  "account.two_factor_disable",
  "account.backup_codes",
  // Datos personales: el evento nunca lleva el nombre ni el contacto de la persona.
  "client.erase",
  // Informes
  "report.export",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const AUDIT_CATEGORIES = ["finanzas", "configuracion", "personal", "informes"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  finanzas: "Finanzas",
  configuracion: "Configuración",
  personal: "Personal",
  informes: "Informes",
};

export const AUDIT_CATEGORY: Record<AuditAction, AuditCategory> = {
  "sale.checkout": "finanzas",
  "void.request": "finanzas",
  "void.approve": "finanzas",
  "void.reject": "finanzas",
  "cash.open": "finanzas",
  "cash.close": "finanzas",
  "cash.review": "finanzas",
  "expense.add": "finanzas",
  "tips.pay": "finanzas",
  "cash.deposit": "finanzas",
  "day.close": "finanzas",
  "day.reopen": "finanzas",
  "settlement.create": "finanzas",
  "settlement.reverse": "finanzas",
  "advance.create": "finanzas",
  "advance.reverse": "finanzas",
  "service.create": "configuracion",
  "service.update": "configuracion",
  "service.active": "configuracion",
  "settings.booking": "configuracion",
  "settings.checkout_rules": "configuracion",
  "payment_method.save": "configuracion",
  "expense_category.save": "configuracion",
  "staff.bookable": "configuracion",
  "staff.create": "personal",
  "staff.update": "personal",
  "staff.password_reset": "personal",
  "staff.sessions_revoke": "personal",
  "schedule.save": "personal",
  "account.password_change": "personal",
  "account.two_factor_disable": "personal",
  "account.backup_codes": "personal",
  "client.erase": "personal",
  "report.export": "informes",
};

export const AUDIT_LABELS: Record<AuditAction, string> = {
  "sale.checkout": "Cobró una venta",
  "void.request": "Pidió anular una venta",
  "void.approve": "Aprobó una anulación",
  "void.reject": "Rechazó una anulación",
  "cash.open": "Abrió la caja",
  "cash.close": "Cerró la caja",
  "cash.review": "Revisó un cierre de caja",
  "expense.add": "Registró un gasto",
  "tips.pay": "Pagó propinas",
  "cash.deposit": "Consignó efectivo",
  "day.close": "Cerró el día",
  "day.reopen": "Reabrió el día",
  "settlement.create": "Liquidó comisiones",
  "settlement.reverse": "Revirtió una liquidación",
  "advance.create": "Dio un anticipo",
  "advance.reverse": "Revirtió un anticipo",
  "service.create": "Creó un servicio",
  "service.update": "Cambió un servicio",
  "service.active": "Activó o retiró un servicio",
  "settings.booking": "Cambió los ajustes de la agenda",
  "settings.checkout_rules": "Cambió las reglas del cobro",
  "payment_method.save": "Guardó un medio de pago",
  "expense_category.save": "Guardó una categoría de gasto",
  "staff.bookable": "Cambió quién aparece en la reserva en línea",
  "staff.create": "Agregó a alguien del personal",
  "staff.update": "Cambió los datos de alguien del personal",
  "staff.password_reset": "Reinició una contraseña",
  "staff.sessions_revoke": "Cerró las sesiones de alguien",
  "schedule.save": "Guardó un horario",
  "account.password_change": "Cambió su contraseña",
  "account.two_factor_disable": "Desactivó su verificación en dos pasos",
  "account.backup_codes": "Generó códigos de respaldo nuevos",
  "client.erase": "Suprimió los datos de un cliente",
  "report.export": "Exportó un informe",
};

/** Dinero y puntos básicos como texto de dígitos; nunca contraseñas, correos ni teléfonos. */
export type AuditValue = string | boolean | null;

export interface AuditChange {
  readonly field: string;
  readonly before: AuditValue;
  readonly after: AuditValue;
}

export const MAX_AUDIT_SUMMARY = 300;
/** Caracteres de control y separadores de línea Unicode: el resumen es siempre una sola línea. */
const CONTROL_CHARS = new RegExp("[\u0000-\u001f\u007f\u2028\u2029]+", "g");
/** Tope del jsonb de cambios (la base exige lo mismo con un CHECK). */
export const MAX_AUDIT_CHANGES_BYTES = 4096;

/** Solo los campos de la lista blanca que cambiaron. */
export function configChanges(before: Record<string, AuditValue>, after: Record<string, AuditValue>, fields: readonly string[]): AuditChange[] {
  const out: AuditChange[] = [];
  for (const field of fields) {
    const b = Object.hasOwn(before, field) ? before[field]! : null;
    const a = Object.hasOwn(after, field) ? after[field]! : null;
    if (b !== a) out.push({ field, before: b, after: a });
  }
  return out;
}

/** Una línea, sin saltos ni caracteres de control, recortada a 300. Nunca vacía. */
export function auditSummary(text: string): string {
  const clean = text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  const one = clean || "Sin detalle";
  return [...one].length > MAX_AUDIT_SUMMARY ? [...one].slice(0, MAX_AUDIT_SUMMARY - 1).join("") + "…" : one;
}

/** Listas blancas de campos por tipo de objeto: lo único que entra a `changes`. */
export const AUDIT_FIELDS = {
  service: ["name", "price", "commissionBps", "durationMin", "bufferMin", "active"],
  paymentMethod: ["label", "feeBps", "active"],
  expenseCategory: ["name", "accountCode", "active"],
  checkoutRules: ["commissionBase", "maxDiscountBps", "receptionCanDiscount", "tipsBearCardFees", "cashReviewThreshold"],
  bookingSettings: [
    "publicBookingEnabled",
    "slotStepMin",
    "minAdvanceMin",
    "maxAdvanceDays",
    "holdMin",
    "freeCancelHours",
    "noShowGraceMin",
    "maxActivePerClient",
    "walkInGuardMin",
    "noShowLimit",
    "address",
    "mapsUrl",
    // El NIT o cédula no entra: si el negocio es persona natural, es su documento.
    "receiptFooter",
  ],
  staff: ["displayName", "role", "active", "bookableOnline"],
} as const satisfies Record<string, readonly string[]>;

/** Campos que son dinero (texto de centavos) o puntos básicos: el visor los formatea. */
export const AUDIT_MONEY_FIELDS: ReadonlySet<string> = new Set(["price", "cashReviewThreshold"]);
export const AUDIT_BPS_FIELDS: ReadonlySet<string> = new Set(["commissionBps", "feeBps", "maxDiscountBps"]);

export const AUDIT_FIELD_LABELS: Record<string, string> = {
  name: "Nombre",
  price: "Precio",
  commissionBps: "Comisión",
  durationMin: "Duración (min)",
  bufferMin: "Limpieza (min)",
  active: "Activo",
  label: "Nombre",
  feeBps: "Costo del medio",
  accountCode: "Cuenta",
  commissionBase: "Base de la comisión",
  maxDiscountBps: "Tope de descuento",
  receptionCanDiscount: "Recepción da descuentos",
  tipsBearCardFees: "Propinas asumen el datáfono",
  cashReviewThreshold: "Límite de diferencia de caja",
  publicBookingEnabled: "Reserva en línea",
  slotStepMin: "Turnos cada (min)",
  minAdvanceMin: "Anticipación mínima (min)",
  maxAdvanceDays: "Días hacia adelante",
  holdMin: "Tiempo para confirmar (min)",
  freeCancelHours: "Horas para cancelar",
  noShowGraceMin: "Tolerancia de llegada (min)",
  maxActivePerClient: "Citas activas por cliente",
  walkInGuardMin: "Walk-in: sin cita en los próximos (min)",
  noShowLimit: "Faltas para suspender la reserva",
  address: "Dirección",
  mapsUrl: "Enlace del mapa",
  receiptFooter: "Pie del recibo",
  displayName: "Nombre",
  role: "Rol",
  bookableOnline: "En la reserva en línea",
};
