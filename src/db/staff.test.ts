import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { parseTime } from "@/domain/staff/schedule";
import { createAuth } from "@/lib/auth";
import { createLocation } from "./ledger";
import { staffMembers } from "./schema";
import {
  addStaffMember,
  createStaffUser,
  membershipsForUser,
  setStaffActive,
  setWeeklySchedule,
  StaffError,
  staffMember,
  updateStaffMember,
  weeklySchedule,
} from "./staff";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";

const PASSWORD = "navaja-y-cuero-2026";

let db: Db;
let client: PGlite;
let locationId: bigint;

beforeEach(async () => {
  ({ db, client } = await createTestDb());
  locationId = await createLocation(db, { name: "Villa — Sede principal" });
}, 30_000);

function testAuth() {
  return createAuth(db, { secret: "s".repeat(32), baseURL: "http://localhost:3000" });
}

describe("acceso del personal", () => {
  it("el dueño creado por script inicia sesión con correo y contraseña", async () => {
    const { userId } = await createStaffUser(db, {
      locationId,
      name: "Dueño Villa",
      email: "  Dueno@Villa.co ",
      password: PASSWORD,
      role: "owner",
    });

    const result = await testAuth().api.signInEmail({ body: { email: "dueno@villa.co", password: PASSWORD } });
    expect(result.user.id).toBe(userId);
    expect(result.token).toBeTruthy();
  });

  it("rechaza una contraseña equivocada", async () => {
    await createStaffUser(db, { locationId, name: "Recepción", email: "recepcion@villa.co", password: PASSWORD, role: "reception" });
    await expect(
      testAuth().api.signInEmail({ body: { email: "recepcion@villa.co", password: "otra-clave-larga-123" } }),
    ).rejects.toThrow();
  });

  it("no permite registro público", async () => {
    await expect(
      testAuth().api.signUpEmail({ body: { name: "Intruso", email: "intruso@x.co", password: PASSWORD } }),
    ).rejects.toThrow();
  });

  it("exige contraseñas de al menos 12 caracteres y correos únicos", async () => {
    await expect(
      createStaffUser(db, { locationId, name: "Ana", email: "ana@villa.co", password: "corta", role: "barber" }),
    ).rejects.toThrow(StaffError);
    await createStaffUser(db, { locationId, name: "Ana", email: "ana@villa.co", password: PASSWORD, role: "barber" });
    expect(
      await dbError(createStaffUser(db, { locationId, name: "Ana 2", email: "ANA@villa.co", password: PASSWORD, role: "barber" })),
    ).toMatch(/user_email_unique/);
  });

  it("la membresía da el rol; si se desactiva, el usuario queda sin acceso", async () => {
    const { userId, staffId } = await createStaffUser(db, {
      locationId,
      name: "Barbero Uno",
      email: "uno@villa.co",
      password: PASSWORD,
      role: "barber",
    });
    expect(await membershipsForUser(db, userId)).toEqual([
      { staffId, locationId, role: "barber", displayName: "Barbero Uno" },
    ]);

    await db.update(staffMembers).set({ active: false }).where(eq(staffMembers.id, staffId));
    expect(await membershipsForUser(db, userId)).toEqual([]);
  });

  it("la base de datos rechaza roles desconocidos", async () => {
    expect(
      await dbError(client.query(`insert into staff_members (location_id, display_name, role) values ($1, 'X', 'admin')`, [locationId])),
    ).toMatch(/staff_members_role_check/);
  });
});

describe("horario semanal", () => {
  it("guarda y reemplaza el horario completo", async () => {
    const staffId = await addStaffMember(db, { locationId, displayName: "Barbero Dos", role: "barber" });
    await setWeeklySchedule(db, {
      locationId,
      staffId,
      blocks: [
        { weekday: 1, startMin: parseTime("14:00"), endMin: parseTime("19:00") },
        { weekday: 1, startMin: parseTime("09:00"), endMin: parseTime("14:00") },
      ],
    });
    expect(await weeklySchedule(db, { locationId, staffId })).toEqual([
      { weekday: 1, startMin: 540, endMin: 840 },
      { weekday: 1, startMin: 840, endMin: 1140 },
    ]);

    await setWeeklySchedule(db, { locationId, staffId, blocks: [{ weekday: 6, startMin: 480, endMin: 960 }] });
    expect(await weeklySchedule(db, { locationId, staffId })).toEqual([{ weekday: 6, startMin: 480, endMin: 960 }]);
  });

  it("la base de datos rechaza bloques que se cruzan aunque se salten el dominio", async () => {
    const staffId = await addStaffMember(db, { locationId, displayName: "Barbero Tres", role: "barber" });
    const insert = (start: number, end: number) =>
      client.query(`insert into staff_schedules (location_id, staff_id, weekday, start_min, end_min) values ($1, $2, 2, $3, $4)`, [
        locationId,
        staffId,
        start,
        end,
      ]);
    await insert(540, 780);
    expect(await dbError(insert(750, 900))).toMatch(/staff_schedules_no_overlap/);
    await expect(insert(780, 900)).resolves.toBeDefined();
  });

  it("no permite asignar horario a personal de otra sede", async () => {
    const other = await createLocation(db, { name: "Otra sede" });
    const staffId = await addStaffMember(db, { locationId: other, displayName: "Ajeno", role: "barber" });
    expect(
      await dbError(setWeeklySchedule(db, { locationId, staffId, blocks: [{ weekday: 1, startMin: 540, endMin: 600 }] })),
    ).toMatch(/staff_schedules_staff_fk/);
  });
});

describe("gestión del personal", () => {
  it("lee a una persona solo dentro de su sede", async () => {
    const staffId = await addStaffMember(db, { locationId, displayName: "Andrés", role: "barber" });
    expect(await staffMember(db, { locationId, staffId })).toEqual({
      staffId,
      displayName: "Andrés",
      role: "barber",
      active: true,
      hasAppAccess: false,
    });
    const other = await createLocation(db, { name: "Otra sede" });
    expect(await staffMember(db, { locationId: other, staffId })).toBeNull();
  });

  it("cambia nombre y rol; la membresía refleja el nuevo rol", async () => {
    await addStaffMember(db, { locationId, displayName: "Dueño", role: "owner" });
    const { userId, staffId } = await createStaffUser(db, {
      locationId,
      name: "Camila",
      email: "camila@villa.co",
      password: PASSWORD,
      role: "barber",
    });
    await updateStaffMember(db, { locationId, staffId, displayName: "  Camila R. ", role: "reception" });
    expect(await membershipsForUser(db, userId)).toEqual([
      { staffId, locationId, role: "reception", displayName: "Camila R." },
    ]);
    expect((await staffMember(db, { locationId, staffId }))?.hasAppAccess).toBe(true);
    await expect(updateStaffMember(db, { locationId, staffId, displayName: "C", role: "barber" })).rejects.toThrow(StaffError);
  });

  it("retirar a alguien le quita el acceso; reactivarlo se lo devuelve", async () => {
    await addStaffMember(db, { locationId, displayName: "Dueño", role: "owner" });
    const { userId, staffId } = await createStaffUser(db, {
      locationId,
      name: "Barbero Uno",
      email: "uno@villa.co",
      password: PASSWORD,
      role: "barber",
    });
    await setStaffActive(db, { locationId, staffId, active: false });
    expect(await membershipsForUser(db, userId)).toEqual([]);
    await setStaffActive(db, { locationId, staffId, active: true });
    expect(await membershipsForUser(db, userId)).toHaveLength(1);
  });

  it("nunca deja la sede sin un dueño activo", async () => {
    const owner = await addStaffMember(db, { locationId, displayName: "Dueño", role: "owner" });
    await expect(setStaffActive(db, { locationId, staffId: owner, active: false })).rejects.toThrow(/al menos un dueño/);
    await expect(updateStaffMember(db, { locationId, staffId: owner, displayName: "Dueño", role: "barber" })).rejects.toThrow(
      /al menos un dueño/,
    );
    // El cambio fallido se revierte completo.
    expect(await staffMember(db, { locationId, staffId: owner })).toMatchObject({ role: "owner", active: true });

    const second = await addStaffMember(db, { locationId, displayName: "Socia", role: "owner" });
    await setStaffActive(db, { locationId, staffId: owner, active: false });
    await expect(setStaffActive(db, { locationId, staffId: second, active: false })).rejects.toThrow(StaffError);
  });

  it("no toca personal de otra sede", async () => {
    await addStaffMember(db, { locationId, displayName: "Dueño", role: "owner" });
    const other = await createLocation(db, { name: "Otra sede" });
    await addStaffMember(db, { locationId: other, displayName: "Dueño ajeno", role: "owner" });
    const ajeno = await addStaffMember(db, { locationId: other, displayName: "Ajeno", role: "barber" });
    await expect(setStaffActive(db, { locationId, staffId: ajeno, active: false })).rejects.toThrow(/no existe en esta sede/);
    await expect(updateStaffMember(db, { locationId, staffId: ajeno, displayName: "X Y", role: "owner" })).rejects.toThrow(
      /no existe en esta sede/,
    );
    expect(await staffMember(db, { locationId: other, staffId: ajeno })).toMatchObject({ active: true, role: "barber" });
  });
});
