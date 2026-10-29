import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Cabeceras de seguridad para todas las rutas (docs/00-descubrimiento.md §9, P0 #1).
// La CSP de scripts con nonce llega aparte; esta ya cierra el enmarcado (clickjacking),
// las bases y formularios hacia otros dominios y los plugins.
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

const nextConfig: NextConfig = {
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
