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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const GRANTS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  reception: new Set<Permission>([
    "ledger.post",
    "day.close",
    "appointments.manage.all",
    "clients.view.contact",
    "time_off.manage.all",
  ]),
  barber: new Set<Permission>(["commissions.view.own", "appointments.manage.own", "time_off.manage.own"]),
};

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].has(permission);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
