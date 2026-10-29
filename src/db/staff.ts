import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { isRole, type Role } from "@/domain/staff/roles";
import { assertValidWeeklySchedule, type ScheduleBlock, type Weekday } from "@/domain/staff/schedule";
import { account, locations, session, staffMembers, staffSchedules, user } from "./schema";
import type { Db } from "./types";

// Personal de la sede y sus horarios. Los roles se guardan por sede (staff_members),
// no en la tabla user, para que una misma persona pueda tener otro rol en otra sede.

export class StaffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaffError";
  }
}

export interface StaffMembership {
  staffId: bigint;
  locationId: bigint;
  role: Role;
  displayName: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Crea una persona con acceso a la app: usuario, credencial (contraseña con hash) y membresía.
 * `mustChangePassword`: la contraseña la eligió otra persona (temporal) y debe cambiarla al ingresar.
 */
export async function createStaffUser(
  db: Db,
  input: { locationId: bigint; name: string; email: string; password: string; role: Role; mustChangePassword?: boolean },
): Promise<{ userId: string; staffId: bigint }> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (name.length < 2) throw new StaffError("El nombre debe tener al menos 2 caracteres");
  if (!EMAIL.test(email)) throw new StaffError("El correo no es válido");
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new StaffError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const userId = randomUUID();
    await tx.insert(user).values({ id: userId, name, email, emailVerified: true, mustChangePassword: input.mustChangePassword ?? false });
    // Mismo formato que better-auth usa para cuentas de correo y contraseña.
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
    });
    const [staff] = await tx
      .insert(staffMembers)
      .values({ locationId: input.locationId, userId, displayName: name, role: input.role })
      .returning({ id: staffMembers.id });
    if (!staff) throw new StaffError("No se pudo crear el miembro del personal");
    return { userId, staffId: staff.id };
  });
}

/** Persona sin acceso a la app (p. ej. un barbero que solo aparece en la agenda). */
export async function addStaffMember(
  db: Db,
  input: { locationId: bigint; displayName: string; role: Role },
): Promise<bigint> {
  const displayName = input.displayName.trim();
  if (displayName.length < 2) throw new StaffError("El nombre debe tener al menos 2 caracteres");
  const [staff] = await db
    .insert(staffMembers)
    .values({ locationId: input.locationId, displayName, role: input.role })
    .returning({ id: staffMembers.id });
  if (!staff) throw new StaffError("No se pudo crear el miembro del personal");
  return staff.id;
}

/** Membresías activas del usuario. Sin membresía activa no hay acceso, aunque la contraseña sea correcta. */
export async function membershipsForUser(db: Db, userId: string): Promise<StaffMembership[]> {
  const rows = await db
    .select({
      staffId: staffMembers.id,
      locationId: staffMembers.locationId,
      role: staffMembers.role,
      displayName: staffMembers.displayName,
    })
    .from(staffMembers)
    .where(and(eq(staffMembers.userId, userId), eq(staffMembers.active, true)))
    .orderBy(asc(staffMembers.locationId));
  return rows.flatMap((r) => (isRole(r.role) ? [{ ...r, role: r.role }] : []));
}

export async function listStaff(db: Db, locationId: bigint) {
  return db
    .select({
      staffId: staffMembers.id,
      displayName: staffMembers.displayName,
      role: staffMembers.role,
      active: staffMembers.active,
      userId: staffMembers.userId,
      bookableOnline: staffMembers.bookableOnline,
    })
    .from(staffMembers)
    .where(eq(staffMembers.locationId, locationId))
    .orderBy(asc(staffMembers.displayName));
}

export interface StaffMemberDetail {
  staffId: bigint;
  displayName: string;
  role: Role;
  active: boolean;
  /** Tiene usuario (correo y contraseña) para entrar a la app. */
  hasAppAccess: boolean;
  /** Verificación en dos pasos (TOTP) activa. */
  twoFactorEnabled: boolean;
  /** Aún no cambia la contraseña temporal que le dieron. */
  mustChangePassword: boolean;
}

/** Una persona de la sede, o null si no existe en esa sede. */
export async function staffMember(
  db: Db,
  input: { locationId: bigint; staffId: bigint },
): Promise<StaffMemberDetail | null> {
  const [row] = await db
    .select({
      staffId: staffMembers.id,
      displayName: staffMembers.displayName,
      role: staffMembers.role,
      active: staffMembers.active,
      userId: staffMembers.userId,
      twoFactorEnabled: user.twoFactorEnabled,
      mustChangePassword: user.mustChangePassword,
    })
    .from(staffMembers)
    .leftJoin(user, eq(user.id, staffMembers.userId))
    .where(and(eq(staffMembers.locationId, input.locationId), eq(staffMembers.id, input.staffId)));
  if (!row || !isRole(row.role)) return null;
  return {
    staffId: row.staffId,
    displayName: row.displayName,
    role: row.role,
    active: row.active,
    hasAppAccess: row.userId !== null,
    twoFactorEnabled: row.twoFactorEnabled ?? false,
    mustChangePassword: row.mustChangePassword ?? false,
  };
}

/**
 * Corre `change` serializado por sede (bloquea la fila de la sede) y, antes de confirmar,
 * exige que quede al menos un dueño activo: nadie puede dejar la sede sin quien la administre.
 */
async function withOwnerGuard(db: Db, locationId: bigint, change: (tx: Db) => Promise<void>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: locations.id }).from(locations).where(eq(locations.id, locationId)).for("no key update");
    await change(tx as unknown as Db);
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(staffMembers)
      .where(and(eq(staffMembers.locationId, locationId), eq(staffMembers.role, "owner"), eq(staffMembers.active, true)));
    if (Number(n) === 0) throw new StaffError("La sede debe tener al menos un dueño activo");
  });
}

/** Cambia nombre y rol. El rol vale para esta sede; el usuario (si tiene) no se toca. */
export async function updateStaffMember(
  db: Db,
  input: { locationId: bigint; staffId: bigint; displayName: string; role: Role },
): Promise<void> {
  const displayName = input.displayName.trim();
  if (displayName.length < 2 || displayName.length > 80) {
    throw new StaffError("El nombre debe tener entre 2 y 80 caracteres");
  }
  if (!isRole(input.role)) throw new StaffError("Rol inválido");
  await withOwnerGuard(db, input.locationId, async (tx) => {
    const updated = await tx
      .update(staffMembers)
      .set({ displayName, role: input.role })
      .where(and(eq(staffMembers.locationId, input.locationId), eq(staffMembers.id, input.staffId)))
      .returning({ id: staffMembers.id });
    if (updated.length === 0) throw new StaffError("La persona no existe en esta sede");
  });
}

/**
 * Activa o retira a una persona sin borrarla: su historial (citas, ventas) la sigue nombrando.
 * Sin membresía activa pierde el acceso; al retirarla también se cierran sus sesiones abiertas.
 */
export async function setStaffActive(
  db: Db,
  input: { locationId: bigint; staffId: bigint; active: boolean },
): Promise<void> {
  await withOwnerGuard(db, input.locationId, async (tx) => {
    const updated = await tx
      .update(staffMembers)
      .set({ active: input.active })
      .where(and(eq(staffMembers.locationId, input.locationId), eq(staffMembers.id, input.staffId)))
      .returning({ id: staffMembers.id, userId: staffMembers.userId });
    if (updated.length === 0) throw new StaffError("La persona no existe en esta sede");
    const userId = updated[0]!.userId;
    if (!input.active && userId) await tx.delete(session).where(eq(session.userId, userId));
  });
}

/** Reemplaza el horario semanal completo de una persona. */
export async function setWeeklySchedule(
  db: Db,
  input: { locationId: bigint; staffId: bigint; blocks: readonly ScheduleBlock[] },
): Promise<void> {
  const blocks = assertValidWeeklySchedule(input.blocks);
  await db.transaction(async (tx) => {
    await tx
      .delete(staffSchedules)
      .where(and(eq(staffSchedules.locationId, input.locationId), eq(staffSchedules.staffId, input.staffId)));
    if (blocks.length > 0) {
      await tx
        .insert(staffSchedules)
        .values(blocks.map((b) => ({ locationId: input.locationId, staffId: input.staffId, ...b })));
    }
  });
}

export async function weeklySchedule(db: Db, input: { locationId: bigint; staffId: bigint }): Promise<ScheduleBlock[]> {
  const rows = await db
    .select({ weekday: staffSchedules.weekday, startMin: staffSchedules.startMin, endMin: staffSchedules.endMin })
    .from(staffSchedules)
    .where(and(eq(staffSchedules.locationId, input.locationId), eq(staffSchedules.staffId, input.staffId)))
    .orderBy(asc(staffSchedules.weekday), asc(staffSchedules.startMin));
  return rows.map((r) => ({ ...r, weekday: r.weekday as Weekday }));
}
