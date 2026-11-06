import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { newUuid } from "./uuid";

// Lo que valida el servidor (src/app/(publico)/actions.ts): z.uuid().
const valid = (id: string) => z.uuid().safeParse(id).success;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newUuid", () => {
  it("con randomUUID (HTTPS o localhost)", () => {
    expect(valid(newUuid())).toBe(true);
  });

  it("sin randomUUID (celular por la red local, http://192.168.x.x): sigue siendo un UUID v4 válido y distinto cada vez", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    const ids = Array.from({ length: 200 }, newUuid);
    for (const id of ids) {
      expect(valid(id), id).toBe(true);
      expect(id[14]).toBe("4");
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sin crypto del todo: también válido", () => {
    vi.stubGlobal("crypto", undefined);
    expect(valid(newUuid())).toBe(true);
  });
});
