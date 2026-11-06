import { networkInterfaces } from "node:os";

/**
 * IPv4 privadas de este PC (wifi o cable). Solo para desarrollo: probar desde el celular en la misma
 * red abriendo http://<IP del PC>:3000. En producción no se usa: allí el origen es el dominio con HTTPS.
 */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a?.family === "IPv4" && !a.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address))
    .map((a) => a!.address);
}

/**
 * Orígenes extra en los que confía el ingreso en desarrollo: las IP de la red local con el puerto de
 * BETTER_AUTH_URL (y el de PORT, si next dev corre en otro). Sin esto better-auth responde 403
 * "Invalid origin" al iniciar sesión desde el celular, porque solo confía en localhost.
 */
export function devLanOrigins(baseURL: string): string[] {
  const ports = new Set([new URL(baseURL).port || "3000", process.env.PORT ?? "3000"]);
  return lanAddresses().flatMap((ip) => [...ports].map((port) => `http://${ip}:${port}`));
}
