import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Cabeceras de seguridad para todas las rutas (docs/00-descubrimiento.md §9, P0 #1).
// La CSP de scripts con nonce la pone src/proxy.ts en cada página (src/lib/csp.ts), primero en modo
// reporte. Esta otra ya bloquea, también en /api y en los estáticos: cierra el enmarcado
// (clickjacking), las bases y formularios hacia otros dominios y los plugins. Con CSP_ENFORCE=true,
// en las páginas la reemplaza la del proxy, que trae estas mismas directivas.
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  // Solo en producción: en local se trabaja por http://localhost.
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

// Solo en desarrollo: Next 16 responde 403 a sus propios scripts y a la recarga en vivo cuando la
// página se abre desde otro origen que localhost. Se permiten las IP privadas de este PC para probar
// desde el celular en la misma wifi (http://<IP del PC>:3000). En producción Next ignora esta lista.
const lanAddresses = isProd
  ? []
  : Object.values(networkInterfaces())
      .flat()
      .filter((a) => a?.family === "IPv4" && !a.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address))
      .map((a) => a!.address);

const nextConfig: NextConfig = {
  allowedDevOrigins: lanAddresses,
  // Build autocontenido para correr con systemd en el VPS (ver docs/arquitectura.md).
  output: "standalone",
  // Fija la raíz del proyecto: hay un package-lock.json suelto en la carpeta del usuario.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  // No anunciar el framework en cada respuesta.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
