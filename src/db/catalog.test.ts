import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { InvalidServiceError, type ServiceDraft } from "@/domain/catalog/service";
import { fromUnits } from "@/domain/money";
import { createService, listServices, setServiceActive, updateService } from "./catalog";
import { createLocation } from "./ledger";
import { createTestDb, dbError } from "./testing";
import type { Db } from "./types";

let db: Db;
let client: PGlite;
let locationId: bigint;

beforeEach(async () => {
  ({ db, client } = await createTestDb());
  locationId = await createLocation(db, { name: "Villa — Sede principal" });
}, 30_000);

const corte: ServiceDraft = {
  name: "Corte clásico",
  durationMin: 30,
  bufferMin: 5,
  price: fromUnits(25_000n),
  commissionBps: 4_000,
};

describe("catálogo de servicios", () => {
  it("crea, edita y retira un servicio sin perder precisión en el precio", async () => {
    const created = await createService(db, { locationId, draft: corte });
    expect(created.price.minor).toBe(2_500_000n);

    const updated = await updateService(db, {
      locationId,
      serviceId: created.id,
      draft: { ...corte, price: fromUnits(28_000n), commissionBps: 4_500 },
    });
    expect(updated.price.minor).toBe(2_800_000n);
    expect(updated.commissionBps).toBe(4_500);

    await setServiceActive(db, { locationId, serviceId: created.id, active: false });
    expect(await listServices(db, { locationId })).toEqual([]);
    expect(await listServices(db, { locationId, includeInactive: true })).toHaveLength(1);
  });

  it("valida en el dominio antes de escribir", async () => {
    await expect(createService(db, { locationId, draft: { ...corte, durationMin: 7 } })).rejects.toThrow(InvalidServiceError);
  });

  it("no repite nombres en la misma sede, sin importar mayúsculas", async () => {
    await createService(db, { locationId, draft: corte });
    expect(await dbError(createService(db, { locationId, draft: { ...corte, name: "CORTE CLÁSICO" } }))).toMatch(
      /services_location_name_key/,
    );
    const other = await createLocation(db, { name: "Otra sede" });
    await expect(createService(db, { locationId: other, draft: corte })).resolves.toBeDefined();
  });

  it("no edita servicios de otra sede", async () => {
    const other = await createLocation(db, { name: "Otra sede" });
    const ajeno = await createService(db, { locationId: other, draft: corte });
    await expect(updateService(db, { locationId, serviceId: ajeno.id, draft: corte })).rejects.toThrow(/no existe/);
  });

  it("la base de datos rechaza precios con centavos aunque se salten el dominio", async () => {
    expect(
      await dbError(
        client.query(
          `insert into services (location_id, name, duration_min, price, commission_bps) values ($1, 'X', 30, 2500050, 4000)`,
          [locationId],
        ),
      ),
    ).toMatch(/services_price_check/);
  });
});
