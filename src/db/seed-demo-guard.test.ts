import { describe, expect, it } from "vitest";
import { seedDemoHostMode, seedDemoMode } from "./seed-demo-guard";

// La guarda de seed-demo (sprint 9, B3). Las URL son de mentira: nunca se imprimen.
const LOCAL = "postgres://u:p@localhost:5432/villa";
const TUNNEL = "postgres://u:p@localhost:5433/villa";
const REMOTE = "postgres://u:p@db.example.com:5432/villa";

describe("seedDemoHostMode", () => {
  it("base local o túnel por localhost: local", () => {
    expect(seedDemoHostMode({ DATABASE_URL: LOCAL })).toBe("local");
    expect(seedDemoHostMode({ DATABASE_URL: TUNNEL, NODE_ENV: "development" })).toBe("local");
    expect(seedDemoHostMode({ DATABASE_URL: "postgres://u:p@[::1]:5432/villa" })).toBe("local");
  });

  it("con NODE_ENV=production nunca, ni con ALLOW_SEED_DEMO=1", () => {
    expect(() => seedDemoHostMode({ DATABASE_URL: LOCAL, NODE_ENV: "production", ALLOW_SEED_DEMO: "1" })).toThrow(/NODE_ENV=production/);
  });

  it("base remota: solo con ALLOW_SEED_DEMO=1 exacto", () => {
    expect(() => seedDemoHostMode({ DATABASE_URL: REMOTE })).toThrow(/base local/);
    expect(() => seedDemoHostMode({ DATABASE_URL: REMOTE, ALLOW_SEED_DEMO: "true" })).toThrow(/base local/);
    expect(seedDemoHostMode({ DATABASE_URL: REMOTE, ALLOW_SEED_DEMO: "1" })).toBe("allowed");
  });

  it("sin URL o con una URL rota: no es local", () => {
    expect(() => seedDemoHostMode({})).toThrow(/base local/);
    expect(() => seedDemoHostMode({ DATABASE_URL: "no es una url" })).toThrow(/base local/);
  });
});

describe("seedDemoMode", () => {
  it("sin respaldos registrados: lo que dijo el host (desarrollo y ambiente de pruebas)", () => {
    expect(seedDemoMode("local", { hasBackups: false }, {})).toBe("local");
    expect(seedDemoMode("allowed", { hasBackups: false }, { ALLOW_SEED_DEMO: "1" })).toBe("allowed");
  });

  it("con respaldos (producción por un túnel a localhost): se niega", () => {
    expect(() => seedDemoMode("local", { hasBackups: true }, {})).toThrow(/respaldos registrados/);
  });

  it("con respaldos y forzado: corre como no local, sin cuentas de prueba", () => {
    expect(seedDemoMode("local", { hasBackups: true }, { ALLOW_SEED_DEMO: "1" })).toBe("allowed");
  });
});
