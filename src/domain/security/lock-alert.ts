import { localMinuteOf } from "@/domain/booking/clock";
import { businessDate } from "@/domain/ledger/business-date";
import { formatTime } from "@/domain/staff/schedule";

// Aviso al dueño cuando se dispara un bloqueo por intentos fallidos (sprint 5). Lo arma el worker
// con lo que guardó security_alerts. Sin datos personales de más: ni el correo escrito, ni la IP,
// ni el sujeto del bloqueo. Solo el nombre que el dueño puso a la persona (display_name) cuando la
// cuenta existe; si no, "un correo que no es del equipo".

export type LockKind = "login" | "login-ip" | "reauth" | "password" | "totp-login";

export interface LockAlertRow {
  throttleKind: LockKind;
  /** staff_members.display_name, si el bloqueo es de una cuenta del personal. */
  staffName: string | null;
  failures: number;
  lockedUntil: Date;
  createdAt: Date;
  /** Cuántos bloqueos resume esta fila (una por tipo, cuenta y ventana de 15 minutos). */
  occurrences: number;
}

export const LOCK_KIND_LABELS: Record<LockKind, string> = {
  login: "ingreso (todas las redes)",
  "login-ip": "ingreso desde una misma red",
  reauth: "confirmación de identidad",
  password: "contraseña en Mi cuenta",
  "totp-login": "código de la app de autenticación",
};

/** Cuántas cuentas del equipo se detallan; el resto se resume en un conteo. */
export const MAX_DETAILED = 20;

/**
 * Primero las cuentas del equipo, una por línea: eso es lo que el dueño debe mirar. Los correos que
 * no son del equipo van en UNA línea con el conteo: cualquiera en internet los puede provocar, y
 * no deben tapar un bloqueo real ni llenar el correo.
 */
export function lockAlertMessage(rows: readonly LockAlertRow[], timeZone: string): { subject: string; text: string } {
  const when = (d: Date) => `${businessDate(d, timeZone)} ${formatTime(localMinuteOf(d, timeZone))}`;
  const staff = rows.filter((r) => r.staffName);
  const others = rows.filter((r) => !r.staffName);
  const lines = staff.slice(0, MAX_DETAILED).map((r) => {
    const times = r.occurrences > 1 ? ` (${r.occurrences} veces)` : "";
    return `- ${when(r.createdAt)}: cuenta de ${r.staffName}, ${LOCK_KIND_LABELS[r.throttleKind]}${times}, ${r.failures} intentos fallidos; bloqueado hasta ${when(r.lockedUntil)}.`;
  });
  if (staff.length > MAX_DETAILED) lines.push(`- y ${staff.length - MAX_DETAILED} avisos más de cuentas del equipo.`);
  const otherCount = others.reduce((sum, r) => sum + r.occurrences, 0);
  if (otherCount > 0) {
    lines.push(`- ${otherCount === 1 ? "1 bloqueo" : `${otherCount} bloqueos`} de correos que no son del equipo. Ninguna cuenta quedó afectada.`);
  }
  const total = rows.reduce((sum, r) => sum + r.occurrences, 0);
  const subject =
    staff.length > 0
      ? `Villa: bloqueo de ${staff.length === 1 ? "una cuenta" : `${staff.length} cuentas`} del equipo por intentos fallidos`
      : total === 1
        ? "Villa: se bloqueó un ingreso por intentos fallidos"
        : `Villa: ${total} bloqueos por intentos fallidos`;
  const text = [
    "Alguien escribió mal la contraseña o el código varias veces y Villa bloqueó esos intentos por un rato.",
    "",
    ...lines,
    "",
    "Si fuiste tú o alguien del equipo, no hay que hacer nada. Si no reconoces estos intentos, cambia tu contraseña desde Mi cuenta",
    "y revisa quién tiene acceso en Personal. Para desbloquear a alguien antes de tiempo: npm run staff:unlock -- <correo>.",
  ].join("\n");
  return { subject, text };
}
