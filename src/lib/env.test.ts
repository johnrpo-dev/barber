import { describe, expect, it } from "vitest";
import { queueDatabaseUrl } from "./env";

// La cola del worker corre con villa_queue (QUEUE_DATABASE_URL), no con el rol de la app (HIGH-1).

const APP = "postgres://villa_app:x@localhost:5432/villa";
const QUEUE = "postgres://villa_queue:x@localhost:5432/villa";

describe("queueDatabaseUrl", () => {
  it("usa QUEUE_DATABASE_URL cuando está", () => {
    expect(queueDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: APP, QUEUE_DATABASE_URL: QUEUE })).toBe(QUEUE);
    expect(queueDatabaseUrl({ DATABASE_URL: APP, QUEUE_DATABASE_URL: ` ${QUEUE} ` })).toBe(QUEUE);
  });

  it("en producción, sin ella, no arranca", () => {
    expect(() => queueDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: APP })).toThrow(/QUEUE_DATABASE_URL/);
    expect(() => queueDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: APP, QUEUE_DATABASE_URL: "  " })).toThrow(/QUEUE_DATABASE_URL/);
  });

  it("en desarrollo cae en DATABASE_URL", () => {
    expect(queueDatabaseUrl({ NODE_ENV: "development", DATABASE_URL: APP })).toBe(APP);
    expect(queueDatabaseUrl({ DATABASE_URL: APP })).toBe(APP);
  });

  it("una URL inválida es un error", () => {
    expect(() => queueDatabaseUrl({ QUEUE_DATABASE_URL: "no-es-url" })).toThrow();
    expect(() => queueDatabaseUrl({})).toThrow();
  });
});
