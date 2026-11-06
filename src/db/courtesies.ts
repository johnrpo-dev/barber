import { and, eq } from "drizzle-orm";
import { businessDate } from "@/domain/ledger/business-date";
import { format, money } from "@/domain/money";
import { CheckoutError } from "@/domain/sales/checkout";
import { courtesyAllowedBySettings, courtesyReason } from "@/domain/sales/courtesy";
import { canDiscount, type Role } from "@/domain/staff/roles";
import { changeStatus } from "./appointments";
import { recordAudit } from "./audit";
import { checkoutRulesOf } from "./checkout-settings";
import { isDayClosed } from "./ledger";
import { CHECKOUT_STATUSES, paidSaleForAppointment } from "./sales";
import { appointmentCourtesies, appointments, staffMembers } from "./schema";
import { pgError, serializable } from "./serializable";
import type { Db } from "./types";

// Cortesía (docs/sprint-8-gastos-controles.md §4): una cita atendida que el negocio regala. No toca el
// libro: no hay asiento, ni comisión, ni movimiento de caja. Todo en UNA transacción SERIALIZABLE con
// la cita bloqueada FOR UPDATE (la misma que bloquea el cobro), así una cortesía y un cobro de la
// misma cita se ponen en fila y el segundo ve al primero. La idempotencia es el UNIQUE de la cita:
// repetir devuelve la misma cortesía, sin duplicarla ni dejar otro evento en la bitácora.

export interface CourtesyActor {
  userId: string;
  role: Role;
  staffId: bigint;
}

export interface CourtesyCommand {
  locationId: bigint;
  appointmentId: bigint;
  reason: string;
  actor: CourtesyActor;
  now?: Date;
}

const UNIQUE_CONSTRAINT = "appointment_courtesies_appointment_key";

async function existingCourtesy(db: Db, locationId: bigint, appointmentId: bigint) {
  const [row] = await db
    .select({ id: appointmentCourtesies.id })
    .from(appointmentCourtesies)
    .where(and(eq(appointmentCourtesies.locationId, locationId), eq(appointmentCourtesies.appointmentId, appointmentId)));
  return row;
}

export async function giveCourtesy(db: Db, cmd: CourtesyCommand): Promise<{ courtesyId: bigint; created: boolean }> {
  const reason = courtesyReason(cmd.reason);
  try {
    return await serializable(db, async (tx) => {
      const rules = await checkoutRulesOf(tx, cmd.locationId);
      // El permiso se vuelve a exigir aquí (la acción ya lo verificó): quien no puede dar descuentos
      // no da cortesías, ni siquiera repitiendo una.
      if (!canDiscount(cmd.actor.role, rules)) throw new CheckoutError("No tienes permiso para dar cortesías");

      // La cita, bloqueada: un cobro simultáneo de la misma cita espera a que esto termine.
      const [appt] = await tx
        .select({
          id: appointments.id,
          publicId: appointments.publicId,
          status: appointments.status,
          staffId: appointments.staffId,
          serviceName: appointments.serviceName,
          price: appointments.price,
        })
        .from(appointments)
        .where(and(eq(appointments.locationId, cmd.locationId), eq(appointments.id, cmd.appointmentId)))
        .for("update");
      if (!appt) throw new CheckoutError("La cita no existe");

      // Repetir (doble toque, reintento de red) devuelve la misma cortesía.
      const existing = await existingCourtesy(tx, cmd.locationId, appt.id);
      if (existing) return { courtesyId: existing.id, created: false };

      if (!courtesyAllowedBySettings(rules)) {
        throw new CheckoutError("Las cortesías solo se permiten si el tope de descuento de la sede es 100 %. El dueño lo cambia en Ajustes.");
      }
      if (await paidSaleForAppointment(tx, cmd.locationId, appt.id)) throw new CheckoutError("Esta cita ya está cobrada: no se puede dar como cortesía");
      if (appt.status === "cancelled") throw new CheckoutError("La cita está cancelada: no se puede dar como cortesía");
      if (appt.status === "no_show") throw new CheckoutError("El cliente no vino: la cita no se puede dar como cortesía");
      if (!(CHECKOUT_STATUSES as readonly string[]).includes(appt.status)) {
        throw new CheckoutError("Solo se da como cortesía una cita en la silla o terminada");
      }

      const now = cmd.now ?? new Date();
      const day = businessDate(now, rules.timeZone);
      // Como el cobro: con el día cerrado no entra nada más en esa fecha.
      if (await isDayClosed(tx, cmd.locationId, day)) {
        throw new CheckoutError(`El día ya está cerrado (${day}). El dueño debe reabrirlo para dar una cortesía.`);
      }

      // Como el cobro: la cita en la silla queda terminada.
      if (appt.status === "in_chair") {
        await changeStatus(tx, {
          locationId: cmd.locationId,
          appointmentId: appt.id,
          to: "completed",
          actor: { userId: cmd.actor.userId, role: cmd.actor.role, staffId: cmd.actor.staffId },
          note: "Cortesía",
          now,
        });
      }

      const [row] = await tx
        .insert(appointmentCourtesies)
        .values({
          locationId: cmd.locationId,
          appointmentId: appt.id,
          staffId: appt.staffId,
          listPrice: appt.price,
          reason,
          businessDate: day,
          createdBy: cmd.actor.userId,
        })
        .returning({ id: appointmentCourtesies.id });

      const [staff] = await tx
        .select({ name: staffMembers.displayName })
        .from(staffMembers)
        .where(and(eq(staffMembers.locationId, cmd.locationId), eq(staffMembers.id, appt.staffId)));
      // Sin el cliente ni el motivo (texto libre que puede nombrarlo): la bitácora no guarda datos personales.
      await recordAudit(tx, {
        locationId: cmd.locationId,
        actorUserId: cmd.actor.userId,
        actorStaffId: cmd.actor.staffId,
        action: "appointment.courtesy",
        targetKind: "appointment",
        targetRef: appt.publicId,
        summary: `Dio como cortesía ${appt.serviceName} de ${staff?.name ?? "Personal"} (precio de lista ${format(money(appt.price))})`,
      });
      return { courtesyId: row!.id, created: true };
    });
  } catch (err) {
    // Dos cortesías simultáneas de la misma cita: la segunda choca con el UNIQUE y devuelve la primera.
    const { code, constraint } = pgError(err);
    if (code === "23505" && constraint === UNIQUE_CONSTRAINT) {
      const existing = await existingCourtesy(db, cmd.locationId, cmd.appointmentId);
      if (existing) return { courtesyId: existing.id, created: false };
    }
    throw err;
  }
}
