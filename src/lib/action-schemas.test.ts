import { describe, expect, it } from "vitest";
import { textSchema } from "./action-schemas";

describe("textSchema", () => {
  const description = textSchema().min(3, "mínimo 3").max(10, "máximo 10");

  it("entrega el texto limpio", () => {
    expect(description.parse("  Tinte\u202E\u200B  rojo ")).toBe("Tinte rojo");
  });

  it("mide lo que queda: los invisibles no completan el mínimo ni gastan el máximo", () => {
    expect(description.safeParse("\u3164\u3164\u3164\u3164").success).toBe(false);
    expect(description.safeParse("a\u200Bb").success).toBe(false);
    expect(description.parse("abc\u200B\u200B\u200B\u200B\u200B\u200B\u200B\u200B")).toBe("abc");
  });
});
