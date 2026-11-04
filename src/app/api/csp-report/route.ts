import { parseCspReport, readBodyWithLimit } from "@/lib/csp";

// Reportes de la CSP (src/lib/csp.ts). Público por naturaleza (lo llama el navegador de cualquiera):
// no escribe en la base, no responde nada útil y solo deja en el registro un resumen sin datos
// personales (directiva, origen bloqueado, ruta sin consulta ni token). Con tope de tamaño y de
// registros por minuto, para que nadie llene el disco del VPS a punta de reportes.

const MAX_BODY_BYTES = 16 * 1024;
const MAX_LOGS_PER_MINUTE = 60;

let minute = 0;
let logged = 0;

export async function POST(request: Request): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/(csp-report|reports\+json|json)\b/i.test(type)) return new Response(null, { status: 415 });

  let body: unknown;
  try {
    // Content-Length se puede omitir o mentir: el tope real es este, sobre lo que va llegando.
    const raw = await readBodyWithLimit(request.body, MAX_BODY_BYTES);
    if (raw === null) return new Response(null, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }

  const now = Math.floor(Date.now() / 60_000);
  if (now !== minute) {
    minute = now;
    logged = 0;
  }
  for (const v of parseCspReport(body)) {
    if (logged >= MAX_LOGS_PER_MINUTE) break;
    logged++;
    console.warn("[csp] violación", JSON.stringify(v));
  }
  return new Response(null, { status: 204 });
}
