import { describe, expect, it } from "vitest";
import type { ClientRecord } from "@/db/client-record";
import { toClientRecordView } from "./record-view";

// La ficha muestra fechas y horas en la zona de la sede, no en la del servidor ni la del navegador.

const at = new Date("2026-11-06T03:30:00Z"); // 5 de noviembre, 22:30 en Bogotá (UTC-5)

const record: ClientRecord = {
  id: 7n,
  name: "Juan Pérez",
  phoneE164: "+573001234567",
  email: "juan@example.com",
  verified: true,
  createdAt: at,
  counts: { total: 1, completed: 1, noShows: 0, cancelled: 0, upcoming: 0 },
  history: [{ id: 11n, start: at, serviceName: "Corte", staffName: "Andrés", status: "completed" }],
  noShows: { count: 0, limit: 2, suspended: false },
  consents: { reminders: { purpose: "reminders", granted: true, textVersion: "2026-11-05b", source: "online", createdAt: at } },
  devices: { active: 1, lastUsedAt: at },
};

describe("ficha del cliente: vista", () => {
  it("2026-11-06T03:30Z se muestra como el 5 de noviembre a las 22:30 en America/Bogota", () => {
    const v = toClientRecordView(record, { timeZone: "America/Bogota", historyLimit: 20, canViewContact: true });
    expect(v.history[0]).toMatchObject({ dateLabel: "5 nov 2026", timeLabel: "22:30" });
    expect(v.sinceLabel).toBe("5 nov 2026");
    expect(v.devices.lastUsedLabel).toBe("5 nov 2026");
    expect(v.consents.find((c) => c.purpose === "reminders")).toMatchObject({ dateLabel: "5 nov 2026, 22:30", bySource: "En línea", withdrawable: true });
  });

  it("en UTC el mismo instante ya es el 6 de noviembre: la zona sale de la sede", () => {
    const v = toClientRecordView(record, { timeZone: "UTC", historyLimit: 20, canViewContact: true });
    expect(v.history[0]).toMatchObject({ dateLabel: "6 nov 2026", timeLabel: "03:30" });
  });

  it("sin permiso de contacto, el celular va enmascarado y el correo no se manda", () => {
    const v = toClientRecordView(record, { timeZone: "America/Bogota", historyLimit: 20, canViewContact: false });
    expect(v.phone).not.toContain("123 4567");
    expect(v.email).toBeNull();
  });
});
