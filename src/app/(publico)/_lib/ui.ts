import type { ActionResult } from "@/lib/action";

// Utilidades del portal que sirven igual en el servidor y en el cliente (sin "use client":
// las funciones de un módulo de cliente no se pueden llamar desde un Server Component).

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ─── Enlaces con aspecto de botón ────────────────────────────────────────────
// Mismo aspecto que Btn (panel/_components/ui.tsx), pero para <a>/<Link>: navegar es un enlace.

const LINK_VARIANTS = {
  primary: "bg-cuero text-hueso hover:bg-cuero/90",
  success: "bg-botella text-hueso hover:bg-botella/90",
  secondary: "border border-tinta/20 bg-papel text-tinta hover:border-tinta/40",
  ghost: "text-tinta hover:bg-tinta/5",
} as const;

const LINK_SIZES = { sm: "h-11 px-3 text-sm", md: "h-11 px-4 text-sm", lg: "h-12 px-5 text-base", xl: "h-14 px-6 text-lg" } as const;

export function linkBtn(variant: keyof typeof LINK_VARIANTS = "primary", size: keyof typeof LINK_SIZES = "md", extra?: string) {
  return cx(
    "inline-flex select-none items-center justify-center gap-2 rounded-lg font-semibold transition-[transform,background-color,border-color] duration-150 ease-[var(--ease-villa)] active:scale-[.98]",
    LINK_VARIANTS[variant],
    LINK_SIZES[size],
    extra,
  );
}

// ─── Horarios ────────────────────────────────────────────────────────────────

/** Forma de un horario según el contrato (actions.ts → SlotView). */
export type SlotView = { minute: number; label: string; period: "morning" | "afternoon" | "evening" };
/** `closed`: la sede no atiende ese día (sin turno, festivo, cierre o ausencia); si no, 0 es "lleno". */
export type DayCount = { date: string; count: number; closed: boolean };

// ─── Fechas de calendario ("yyyy-MM-dd", sin zona) ───────────────────────────
// Se formatean al mediodía UTC con timeZone UTC: la fecha no se corre por la zona del navegador.

const at = (date: string) => new Date(`${date}T12:00:00Z`);
const WEEKDAY = new Intl.DateTimeFormat("es-CO", { weekday: "long", timeZone: "UTC" });
const WEEKDAY_SHORT = new Intl.DateTimeFormat("es-CO", { weekday: "short", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("es-CO", { month: "long", timeZone: "UTC" });

export const weekdayName = (date: string) => WEEKDAY.format(at(date));
export const monthName = (date: string) => MONTH.format(at(date));
export const dayNumber = (date: string) => String(Number(date.slice(8, 10)));
/** "JUE" */
export const weekdayShort = (date: string) => WEEKDAY_SHORT.format(at(date)).replace(/\./g, "").slice(0, 3).toUpperCase();
/** "jueves 30 de octubre" */
export const longDate = (date: string) => `${weekdayName(date)} ${dayNumber(date)} de ${monthName(date)}`;
/** "jueves 30" */
export const weekdayDay = (date: string) => `${weekdayName(date)} ${dayNumber(date)}`;
/** "jue 30" */
export const shortWeekdayDay = (date: string) => `${weekdayShort(date).toLowerCase()} ${dayNumber(date)}`;

export const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Separa "3:30 p. m." en la cifra y el sufijo, para mostrar la cifra en grande. */
export function splitTime(label: string): [string, string] {
  const m = /^(\S+)\s+(.*)$/.exec(label);
  return m ? [m[1]!, m[2]!] : [label, ""];
}

// ─── Celular colombiano ──────────────────────────────────────────────────────

/** Solo los 10 dígitos nacionales: quita espacios, guiones y el +57 si lo pegaron. */
export function phoneDigits(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("57")) d = d.slice(2);
  return d;
}

/** "3001234567" → "300 123 4567"; si no son 10 dígitos, se deja como se escribió. */
export function formatPhone(raw: string): string {
  const d = phoneDigits(raw);
  return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : raw.trim();
}

// ─── Llamadas a server actions ───────────────────────────────────────────────

export const NETWORK_ERROR = "No pudimos conectarnos. Revisa tu internet e inténtalo otra vez.";

export type CallResult<T> = { ok: true; data: T } | { ok: false; error: string; network: boolean };

/** Una server action que falla por red lanza: aquí se vuelve un error con reintento, no una pantalla rota. */
export async function safeCall<T>(fn: () => Promise<ActionResult<T>>): Promise<CallResult<T>> {
  try {
    const r = await fn();
    return r.ok ? r : { ok: false, error: r.error, network: false };
  } catch {
    return { ok: false, error: NETWORK_ERROR, network: true };
  }
}

/** Prefijos de error con forma conocida (contrato §10): la interfaz reacciona a cada uno. */
export const KNOWN_ERRORS = {
  slotTaken: "Uy, alguien tomó ese horario",
  tooSoon: "Ese horario ya no se puede reservar",
  holdExpired: "Se acabó el tiempo",
  wrongCode: "Ese código no coincide.",
  codeExpired: "El código venció",
  tooManyAttempts: "Demasiados intentos",
  rateLimited: "Vas muy rápido",
} as const;

export const isError = (message: string, kind: keyof typeof KNOWN_ERRORS) => message.startsWith(KNOWN_ERRORS[kind]);
