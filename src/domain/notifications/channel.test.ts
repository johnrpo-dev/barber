import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { maskEmail, maskPhone } from "@/domain/clients/client";
import { preferredChannel, receiptDestination } from "./channel";
import { NOTIFICATION_CHANNELS } from "./templates";

// Lo que la hoja de cobro le muestra a quien cobra es lo que el envío usa (riesgo B4).

const phone = "+573001234567";
const email = "juan.perez@gmail.com";

describe("destino del recibo", () => {
  it("WhatsApp si hay celular; si no, correo; si no, nada", () => {
    expect(receiptDestination({ phoneE164: phone, email }, ["whatsapp", "email"])).toEqual({ channel: "whatsapp", label: "300 ••• ••67" });
    expect(receiptDestination({ phoneE164: null, email }, ["whatsapp", "email"])).toEqual({ channel: "email", label: "j•••@gmail.com" });
    expect(receiptDestination({ phoneE164: phone, email }, ["email"])).toEqual({ channel: "email", label: "j•••@gmail.com" });
    expect(receiptDestination({ phoneE164: phone, email: null }, ["email"])).toBeNull();
    expect(receiptDestination({ phoneE164: null, email: null }, ["whatsapp", "email"])).toBeNull();
  });

  it("el celular recién tecleado se muestra completo para leérselo", () => {
    expect(receiptDestination({ phoneE164: phone, email: null }, ["whatsapp"], { reveal: true })).toEqual({ channel: "whatsapp", label: "300 123 4567" });
  });

  it("propiedad: el canal mostrado es el que elige el envío, y el dato es el enmascarado de su destino", () => {
    fc.assert(
      fc.property(
        fc.option(fc.stringMatching(/^3\d{9}$/).map((c) => `+57${c}`), { nil: null }),
        fc.option(fc.emailAddress(), { nil: null }),
        fc.subarray([...NOTIFICATION_CHANNELS]),
        (phoneE164, mail, channels) => {
          const client = { phoneE164, email: mail };
          const sent = preferredChannel(client, channels);
          const shown = receiptDestination(client, channels);
          if (!sent) {
            expect(shown).toBeNull();
            return;
          }
          expect(shown?.channel).toBe(sent.channel);
          expect(shown?.label).toBe(sent.channel === "whatsapp" ? maskPhone(sent.to) : maskEmail(sent.to));
        },
      ),
    );
  });
});
