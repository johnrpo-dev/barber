import { describe, expect, it } from "vitest";
import { can, canDiscount, PERMISSIONS, requiredAccountSetup, ROLES } from "./roles";

describe("lo que falta antes de usar el panel", () => {
  it("el dueño sin verificación en dos pasos debe inscribirla; los demás roles no", () => {
    expect(requiredAccountSetup({ role: "owner", mustChangePassword: false, twoFactorEnabled: false })).toBe("two-factor");
    expect(requiredAccountSetup({ role: "owner", mustChangePassword: false, twoFactorEnabled: true })).toBeNull();
    expect(requiredAccountSetup({ role: "reception", mustChangePassword: false, twoFactorEnabled: false })).toBeNull();
    expect(requiredAccountSetup({ role: "barber", mustChangePassword: false, twoFactorEnabled: false })).toBeNull();
  });

  it("la contraseña temporal se cambia primero, en cualquier rol", () => {
    for (const role of ROLES) {
      for (const twoFactorEnabled of [false, true]) {
        expect(requiredAccountSetup({ role, mustChangePassword: true, twoFactorEnabled })).toBe("password");
      }
    }
  });
});

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

  it("caja y gastos (sprint 4): recepción maneja la caja; el banco y los descuentos son del dueño", () => {
    expect(can("owner", "cash.manage")).toBe(true);
    expect(can("reception", "cash.manage")).toBe(true);
    expect(can("barber", "cash.manage")).toBe(false);
    expect(can("owner", "expenses.bank")).toBe(true);
    expect(can("reception", "expenses.bank")).toBe(false);
    expect(can("barber", "expenses.bank")).toBe(false);
    // Conteo a ciegas (sprint 4, MEDIUM-3): solo el dueño ve el esperado con la caja abierta.
    expect(can("owner", "cash.review")).toBe(true);
    expect(can("reception", "cash.review")).toBe(false);
    expect(can("barber", "cash.review")).toBe(false);
    expect(can("reception", "sales.discount")).toBe(false);
    expect(can("barber", "sales.discount")).toBe(false);
  });

  it("descuentos: el dueño siempre; recepción solo si la sede lo habilita; el barbero nunca", () => {
    for (const receptionCanDiscount of [false, true]) {
      expect(canDiscount("owner", { receptionCanDiscount })).toBe(true);
      expect(canDiscount("reception", { receptionCanDiscount })).toBe(receptionCanDiscount);
      expect(canDiscount("barber", { receptionCanDiscount })).toBe(false);
    }
  });

  it("el barbero solo ve lo suyo: no toca caja ni ve contactos completos", () => {
    expect(can("barber", "commissions.view.own")).toBe(true);
    expect(can("barber", "appointments.manage.own")).toBe(true);
    for (const p of ["ledger.post", "day.close", "reports.financial", "commissions.view.all", "clients.view.contact", "settings.manage"] as const) {
      expect(can("barber", p)).toBe(false);
    }
  });
});
