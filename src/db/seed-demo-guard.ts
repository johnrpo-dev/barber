// ¿Puede correr seed-demo contra esta base, y como local o no? Aparte de seed-demo.ts (que corre al
// importarse) para probarlo. Cierra la fila B3 de la tabla de seguridad (sprint 9).
//
// El riesgo: un túnel SSH a producción por localhost pasa por "base local" (así se carga el
// ambiente de pruebas: docs/ambiente-de-pruebas.md). Mirar el host no basta. La señal que separa
// producción de pruebas está en la base: producción registra sus respaldos cada noche
// (backup_runs, migración 0031) y el ambiente de pruebas no los configura. Una base con respaldos es
// una base que alguien cuida: seed-demo no la toca. Ni aun forzándolo crea cuentas de prueba allí.

export type SeedDemoMode =
  /** Base local de desarrollo (o el túnel al ambiente de pruebas): todo, con cuentas de prueba. */
  | "local"
  /** Forzado con ALLOW_SEED_DEMO=1: catálogo y equipo, sin cuentas de prueba ni abrir la reserva. */
  | "allowed";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** Lo que se sabe sin tocar la base: NODE_ENV y el host de DATABASE_URL (nunca se imprime la URL). */
export function seedDemoHostMode(env: { NODE_ENV?: string; DATABASE_URL?: string; ALLOW_SEED_DEMO?: string }): SeedDemoMode {
  if (env.NODE_ENV === "production") {
    throw new Error("seed-demo es solo para desarrollo: no se ejecuta con NODE_ENV=production");
  }
  let host = "";
  try {
    host = new URL(env.DATABASE_URL ?? "").hostname;
  } catch {
    // Sin URL válida: no es una base local reconocible.
  }
  if (LOCAL_HOSTS.includes(host)) return "local";
  if (env.ALLOW_SEED_DEMO === "1") return "allowed";
  throw new Error("seed-demo solo corre contra una base local. Si de verdad es una base de pruebas, usa ALLOW_SEED_DEMO=1.");
}

/** Con lo que dice la base: si tiene respaldos registrados, es producción (o una base cuidada). */
export function seedDemoMode(hostMode: SeedDemoMode, db: { hasBackups: boolean }, env: { ALLOW_SEED_DEMO?: string }): SeedDemoMode {
  if (!db.hasBackups) return hostMode;
  if (env.ALLOW_SEED_DEMO !== "1") {
    throw new Error(
      "Esta base tiene respaldos registrados: parece producción. seed-demo no la toca. Si de verdad es una base de pruebas, usa ALLOW_SEED_DEMO=1 (no se crearán cuentas de prueba).",
    );
  }
  return "allowed";
}
