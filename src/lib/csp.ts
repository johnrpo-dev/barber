// Content Security Policy con nonce para los scripts (sprint 5). La arma src/proxy.ts en cada
// petición de página; Next.js lee el nonce de la cabecera de la petición y se lo pone a sus
// propios scripts (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
//
// En producción bloquea por defecto. CSP_ENFORCE=false la deja en modo reporte
// (Content-Security-Policy-Report-Only): no bloquea nada y los navegadores mandan cada violación a
// /api/csp-report, que la deja en el registro sin datos personales. Es el modo de la primera semana
// y la vuelta atrás (docs/despliegue.md, "CSP: semana de prueba y bloqueo").
//
// Turnstile (Cloudflare) carga su script y su iframe desde challenges.cloudflare.com.

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
export const CSP_REPORT_PATH = "/api/csp-report";
export const CSP_REPORT_GROUP = "csp-endpoint";

/** 128 bits aleatorios en base64, uno por petición. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function buildCsp(opts: { nonce: string; dev: boolean; enforce: boolean }): string {
  const directives: string[] = [
    "default-src 'self'",
    // 'strict-dynamic': lo que cargue un script con nonce (el cargador de next/script, que trae
    // Turnstile) también vale. El origen de Turnstile queda para navegadores sin CSP 3.
    // En desarrollo React usa eval para los errores; en producción no.
    `script-src 'self' 'nonce-${opts.nonce}' 'strict-dynamic' ${TURNSTILE_ORIGIN}${opts.dev ? " 'unsafe-eval'" : ""}`,
    // Los atributos style de React y Tailwind no llevan nonce: los estilos en línea se permiten
    // (no ejecutan código).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${opts.dev ? " ws:" : ""}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ];
  if (opts.enforce && !opts.dev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** Nombre de la cabecera según el modo. */
export function cspHeaderName(enforce: boolean): "Content-Security-Policy" | "Content-Security-Policy-Report-Only" {
  return enforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}

/**
 * En producción bloquea, salvo CSP_ENFORCE=false (o 0), que es la vuelta atrás explícita y el modo
 * de la semana de prueba. En desarrollo solo reporta, salvo CSP_ENFORCE=true (o 1).
 * Un valor mal escrito cuenta como no dicho: en producción, bloquea.
 */
export function cspEnforced(source: Record<string, string | undefined> = process.env): boolean {
  const v = source.CSP_ENFORCE?.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return source.NODE_ENV === "production";
}

/** Lee un cuerpo con tope: corta la lectura apenas lo pasa, sin guardarlo. null si se pasó. */
export async function readBodyWithLimit(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ─── Reportes ────────────────────────────────────────────────────────────────

export interface CspViolation {
  directive: string;
  /** Solo el origen, o la palabra clave ("inline", "eval"): nunca la URL con su consulta. */
  blocked: string;
  /** Solo la ruta, sin consulta y sin el token de /cita/<token>. */
  page: string;
  disposition: string;
}

const MAX_FIELD = 120;

/** Ruta sin consulta ni fragmento, y sin el token de gestión (permite cancelar la cita). */
export function redactPath(url: string): string {
  let path: string;
  try {
    path = new URL(url, "https://villa.invalid").pathname;
  } catch {
    return "(inválida)";
  }
  // Sin ancla: el token sale aunque la ruta llegue con algo antes (//cita/…, /x/cita/…).
  return path.replace(/\/cita\/[^/]+/gi, "/cita/[token]").slice(0, MAX_FIELD);
}

function blockedOrigin(value: string): string {
  if (!value) return "(vacío)";
  if (/^[a-z-]+$/i.test(value)) return value.slice(0, 40); // inline, eval, data, blob, self…
  try {
    const u = new URL(value);
    return u.origin === "null" ? `${u.protocol}` : u.origin.slice(0, MAX_FIELD);
  } catch {
    return "(otro)";
  }
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Normaliza un reporte (formato viejo `application/csp-report` o Reporting API
 * `application/reports+json`) a lo mínimo para diagnosticar. Lo que no se entienda se descarta.
 */
export function parseCspReport(body: unknown): CspViolation[] {
  const raw: Record<string, unknown>[] = [];
  if (Array.isArray(body)) {
    for (const r of body.slice(0, 20)) {
      if (r && typeof r === "object" && (r as { type?: unknown }).type === "csp-violation") {
        const b = (r as { body?: unknown }).body;
        if (b && typeof b === "object") raw.push(b as Record<string, unknown>);
      }
    }
  } else if (body && typeof body === "object" && "csp-report" in body) {
    const b = (body as Record<string, unknown>)["csp-report"];
    if (b && typeof b === "object") raw.push(b as Record<string, unknown>);
  }
  return raw.map((r) => ({
    directive: (text(r.effectiveDirective) || text(r["effective-directive"]) || text(r["violated-directive"]) || "(desconocida)").slice(0, 40),
    blocked: blockedOrigin(text(r.blockedURL) || text(r["blocked-uri"])),
    page: redactPath(text(r.documentURL) || text(r["document-uri"])),
    disposition: (text(r.disposition) || "report").slice(0, 10),
  }));
}
