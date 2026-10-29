import { describe, expect, it } from "vitest";
import { can, PERMISSIONS } from "./roles";

describe("permisos por rol", () => {
  it("el dueño puede todo", () => {
    for (const p of PERMISSIONS) expect(can("owner", p)).toBe(true);
  });

  it("recepción cobra y cierra caja, pero no ve utilidades, no reabre días ni anula", () => {
    expect(can("reception", "ledger.post")).toBe(true);
    expect(can("reception", "day.close")).toBe(true);
    expect(can("reception", "reports.financial")).toBe(false);
    expect(can("reception", "day.reopen")).toBe(false);
    expect(can("reception", "ledger.reverse")).toBe(false);
    expect(can("reception", "commissions.view.all")).toBe(false);
    expect(can("reception", "settings.manage")).toBe(false);
  });

  it("el barbero solo ve lo suyo: no toca caja ni ve contactos completos", () => {
    expect(can("barber", "commissions.view.own")).toBe(true);
    expect(can("barber", "appointments.manage.own")).toBe(true);
    for (const p of ["ledger.post", "day.close", "reports.financial", "commissions.view.all", "clients.view.contact", "settings.manage"] as const) {
      expect(can("barber", p)).toBe(false);
    }
  });
});
