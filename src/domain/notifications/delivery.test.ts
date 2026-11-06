import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deliveryModes } from "./delivery";
import { NOTIFICATION_CHANNELS } from "./templates";

// La hoja de cobro no promete un envío que no va a ocurrir: detenido primero, después consola.

describe("modo del envío por canal", () => {
  it("ejemplos: worker caído → detenido; consola en desarrollo; si no, en vivo", () => {
    expect(deliveryModes({ workerDown: true, consoleChannels: [] })).toEqual({ whatsapp: "stopped", email: "stopped" });
    expect(deliveryModes({ workerDown: false, consoleChannels: ["whatsapp", "email"] })).toEqual({ whatsapp: "console", email: "console" });
    expect(deliveryModes({ workerDown: false, consoleChannels: ["email"] })).toEqual({ whatsapp: "live", email: "console" });
    expect(deliveryModes({ workerDown: false, consoleChannels: [] })).toEqual({ whatsapp: "live", email: "live" });
  });

  it("propiedad: 'live' solo con worker vivo y proveedor real; con worker caído nunca otra cosa que 'stopped'", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.subarray([...NOTIFICATION_CHANNELS]), (workerDown, consoleChannels) => {
        const modes = deliveryModes({ workerDown, consoleChannels });
        for (const channel of NOTIFICATION_CHANNELS) {
          if (workerDown) expect(modes[channel]).toBe("stopped");
          else expect(modes[channel]).toBe(consoleChannels.includes(channel) ? "console" : "live");
        }
      }),
    );
  });
});
