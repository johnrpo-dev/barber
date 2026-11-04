import { type NextRequest, NextResponse } from "next/server";
import { buildCsp, CSP_REPORT_GROUP, CSP_REPORT_PATH, cspEnforced, cspHeaderName, newNonce } from "@/lib/csp";

// Proxy de Next.js 16 (antes "middleware"): pone la CSP con nonce en cada página. Next.js toma
// el nonce de la cabecera de la PETICIÓN (Content-Security-Policy o su variante Report-Only) y se
// lo agrega a sus scripts; por eso va en la petición y en la respuesta. Ver src/lib/csp.ts.

export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const enforce = cspEnforced();
  const policy = buildCsp({ nonce, dev: process.env.NODE_ENV === "development", enforce });
  const header = cspHeaderName(enforce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(header, policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(header, policy);
  response.headers.set("Reporting-Endpoints", `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);
  return response;
}

export const config = {
  matcher: [
    // Solo páginas: ni las rutas de API, ni los estáticos, ni las precargas de next/link.
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|icon|apple-icon|manifest.webmanifest).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
