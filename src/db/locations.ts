import { and, eq } from "drizzle-orm";
import { locations, staffMembers } from "./schema";
import { StaffError } from "./staff";
import type { Db } from "./types";

// Ajustes de la sede: reglas de la agenda y datos de la reserva en línea. Los rangos se validan
// en la acción; la base tiene CHECK para la retención y el máximo de citas por cliente.

export interface LocationSettings {
  name: string;
  publicBookingEnabled: boolean;
  publicPhone: string | null;
  address: string | null;
  mapsUrl: string | null;
  slotStepMin: number;
  minAdvanceMin: number;
  maxAdvanceDays: number;
  holdMin: number;
  freeCancelHours: number;
  noShowGraceMin: number;
  maxActivePerClient: number;
}

export async function locationSettings(db: Db, locationId: bigint): Promise<LocationSettings> {
  const [row] = await db
    .select({
      name: locations.name,
      publicBookingEnabled: locations.publicBookingEnabled,
      publicPhone: locations.publicPhone,
      address: locations.address,
      mapsUrl: locations.mapsUrl,
      slotStepMin: locations.slotStepMin,
      minAdvanceMin: locations.minAdvanceMin,
      maxAdvanceDays: locations.maxAdvanceDays,
      holdMin: locations.holdMin,
      freeCancelHours: locations.freeCancelHours,
      noShowGraceMin: locations.noShowGraceMin,
      maxActivePerClient: locations.maxActivePerClient,
    })
    .from(locations)
    .where(eq(locations.id, locationId));
  if (!row) throw new Error(`La sede ${locationId} no existe`);
  return row;
}

export async function updateLocationSettings(db: Db, locationId: bigint, settings: Omit<LocationSettings, "name">): Promise<void> {
  await db.update(locations).set(settings).where(eq(locations.id, locationId));
}

/** Si la persona aparece en la reserva en línea. Solo dentro de la sede de quien opera. */
export async function setStaffBookableOnline(db: Db, input: { locationId: bigint; staffId: bigint; bookable: boolean }): Promise<void> {
  const updated = await db
    .update(staffMembers)
    .set({ bookableOnline: input.bookable })
    .where(and(eq(staffMembers.locationId, input.locationId), eq(staffMembers.id, input.staffId)))
    .returning({ id: staffMembers.id });
  if (updated.length === 0) throw new StaffError("La persona no existe en esta sede");
}
