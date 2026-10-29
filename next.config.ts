import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build autocontenido para correr con systemd en el VPS (ver docs/arquitectura.md).
  output: "standalone",
  // Fija la raíz del proyecto: hay un package-lock.json suelto en la carpeta del usuario.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
