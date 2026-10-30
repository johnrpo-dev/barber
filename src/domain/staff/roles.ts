// Roles por sede y qué puede hacer cada uno (docs/00-descubrimiento.md §3).
// Denegado por defecto: un permiso que no aparece en la lista del rol no existe para ese rol.
// La verificación se hace SIEMPRE en el servidor; ocultar botones no es seguridad.

export const ROLES = ["owner", "reception", "barber"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Dueño",
  reception: "Recepción",
  barber: "Barbero",
};

export const PERMISSIONS = [
  "ledger.post", // cobrar, registrar gastos de caja
  "ledger.reverse", // anular un movimiento (con motivo)
  "day.close", // cerrar la caja del día
  "day.reopen", // reabrir un día cerrado
  "reports.financial", // utilidad, ingresos y gastos
  "commissions.view.all",
  "commissions.view.own",
  "staff.manage", // crear personal y asignar roles
  "services.manage", // precios, duraciones, comisiones
  "schedules.manage.all",
  "appointments.manage.all",
  "appointments.manage.own",
  "clients.view.contact", // teléfono y correo completos
  "time_off.manage.all", // ausencias y bloqueos de cualquiera, cierres de la sede
  "time_off.manage.own", // el barbero bloquea su propio tiempo
  "settings.manage", // reglas de la sede y reserva en línea
  "sales.discount", // dar descuentos al cobrar (recepción solo si el dueño lo habilita: canDiscount)
  "cash.manage", // abrir y cerrar caja, pagar propinas, consignar
  "expenses.bank", // registrar gastos pagados desde el banco
  "cash.review", // ver el esperado durante el turno y revisar cierres con diferencia (conteo a ciegas)
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const GRANTS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  reception: new Set<Permission>([
    "ledger.post",
    "day.close",
    "cash.manage",
    "appointments.manage.all",
    "clients.view.contact",
    "time_off.manage.all",
  ]),
  barber: new Set<Permission>(["commissions.view.own", "appointments.manage.own", "time_off.manage.own"]),
};

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].has(permission);
}

/**
 * Descuentos al cobrar: quien tiene sales.discount (el dueño) y recepción solo si la sede lo
 * habilita (regla receptionCanDiscount, docs/sprint-4-cobro-caja.md §1 y §6). El servidor lee la
 * regla de la base al cobrar.
 */
export function canDiscount(role: Role, rules: { receptionCanDiscount: boolean }): boolean {
  return can(role, "sales.discount") || (role === "reception" && rules.receptionCanDiscount);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Verificación en dos pasos (TOTP) obligatoria: el dueño tiene acceso total a las cuentas. */
export const MFA_REQUIRED: Record<Role, boolean> = { owner: true, reception: false, barber: false };

export type AccountSetup = "password" | "two-factor";

/**
 * Lo que falta antes de usar el panel, en orden: primero cambiar la contraseña temporal, después
 * (si el rol la exige) inscribir la verificación en dos pasos. null si no falta nada.
 */
export function requiredAccountSetup(input: { role: Role; mustChangePassword: boolean; twoFactorEnabled: boolean }): AccountSetup | null {
  if (input.mustChangePassword) return "password";
  if (MFA_REQUIRED[input.role] && !input.twoFactorEnabled) return "two-factor";
  return null;
}
