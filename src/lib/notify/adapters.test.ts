import { afterEach, describe, expect, it, vi } from "vitest";
import { maskDestination, ConsoleNotifier } from "./console";
import { MemoryNotifier } from "./memory";
import { ChannelRouter, NotifyError, type SendRequest } from "./ports";
import { buildResendPayload, ResendNotifier } from "./resend";
import { buildWhatsAppPayload, urlButtonSuffix, WhatsAppNotifier } from "./whatsapp";

// Adaptadores de envío: la forma exacta de lo que sale hacia Meta y Resend, con fetch simulado.

const TOKEN = "a".repeat(43);
const confirmed: SendRequest = {
  channel: "whatsapp",
  template: "booking_confirmed",
  to: "+573001234567",
  params: {
    name: "Ana",
    service: "Corte",
    staff: "Andrés",
    date: "jueves 30 de octubre",
    time: "3:30 p. m.",
    ticket: "V-4K7Q",
    url: `https://villa.test/cita/${TOKEN}`,
  },
  idempotencyKey: "1:confirm:01ABC",
};

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

describe("WhatsApp", () => {
  it("arma la plantilla con las variables en orden y el token en el botón", () => {
    const p = buildWhatsAppPayload(confirmed);
    expect(p).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "573001234567",
      type: "template",
      template: {
        name: "villa_reserva_confirmada",
        language: { code: "es" },
        components: [
          {
            type: "body",
            parameters: ["Ana", "Corte", "Andrés", "jueves 30 de octubre", "3:30 p. m.", "V-4K7Q"].map((text) => ({ type: "text", text })),
          },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: TOKEN }] },
        ],
      },
    });
  });

  it("el código usa el formato de autenticación (cuerpo + copiar código), sin nombre", () => {
    const p = buildWhatsAppPayload({ channel: "whatsapp", template: "otp", to: "+573001234567", params: { code: "123456", name: "Hacker" }, idempotencyKey: "otp:1" });
    expect(p.template.name).toBe("villa_otp");
    expect(p.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "123456" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] },
    ]);
    expect(JSON.stringify(p)).not.toContain("Hacker");
  });

  it("la cancelación lleva el tramo final del enlace de reservar y la de la sede no lleva botón", () => {
    expect(urlButtonSuffix("https://villa.test/reservar")).toBe("reservar");
    const staff = buildWhatsAppPayload({
      channel: "whatsapp",
      template: "appointment_cancelled_staff",
      to: "+573001234567",
      params: { name: "Ana", date: "jueves 30", time: "3:30 p. m." },
      idempotencyKey: "k",
    });
    expect(staff.template.components).toHaveLength(1);
  });

  it("limpia saltos de línea y rechaza parámetros vacíos", () => {
    const p = buildWhatsAppPayload({ ...confirmed, params: { ...confirmed.params, staff: "Andrés\n\nGómez" } });
    expect(p.template.components[0]!.parameters[2]!.text).toBe("Andrés Gómez");
    expect(() => buildWhatsAppPayload({ ...confirmed, params: { ...confirmed.params, name: "  " } })).toThrow(/name/);
  });

  it("envía a Graph v21.0 con el token y devuelve el id", async () => {
    const { fn, calls } = stubFetch(200, { messages: [{ id: "wamid.X" }] });
    const n = new WhatsAppNotifier({ token: "tok", phoneNumberId: "12345" }, fn);
    await expect(n.send(confirmed)).resolves.toEqual({ providerMessageId: "wamid.X" });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v21.0/12345/messages");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("un rechazo es NotifyError; plantilla sin aprobar se marca para pasar a correo", async () => {
    const n = new WhatsAppNotifier({ token: "t", phoneNumberId: "12345" }, stubFetch(400, { error: { code: 132001 } }).fn);
    const err = await n.send(confirmed).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotifyError);
    expect((err as NotifyError).templateUnavailable).toBe(true);
    expect((err as NotifyError).code).toBe("whatsapp_400_132001");
  });

  it("2xx sin id NO es NotifyError (pudo salir: queda desconocido)", async () => {
    const n = new WhatsAppNotifier({ token: "t", phoneNumberId: "12345" }, stubFetch(200, {}).fn);
    const err = await n.send(confirmed).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotifyError);
  });
});

describe("Resend", () => {
  const email: SendRequest = { ...confirmed, channel: "email", to: "Ana@Example.com" };

  it("arma el correo con la plantilla y el destino en minúsculas", () => {
    const p = buildResendPayload(email, "Villa <citas@villa.test>");
    expect(p.to).toEqual(["ana@example.com"]);
    expect(p.subject).toBe("Cita confirmada: jueves 30 de octubre a las 3:30 p. m.");
    expect(p.html).toContain(`https://villa.test/cita/${TOKEN}`);
  });

  it("manda la clave de deduplicación como Idempotency-Key", async () => {
    const { fn, calls } = stubFetch(200, { id: "re_1" });
    await expect(new ResendNotifier({ apiKey: "key", from: "Villa <c@villa.test>" }, fn).send(email)).resolves.toEqual({ providerMessageId: "re_1" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("1:confirm:01ABC");
    expect(headers.Authorization).toBe("Bearer key");
  });

  it("un 4xx es NotifyError", async () => {
    const err = await new ResendNotifier({ apiKey: "k", from: "f@villa.test" }, stubFetch(422, { name: "validation_error" }).fn)
      .send(email)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotifyError);
  });
});

describe("consola, memoria y enrutador", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("la consola enmascara el destino y no se construye en producción", async () => {
    const lines: string[] = [];
    await new ConsoleNotifier((l) => lines.push(l)).send(confirmed);
    expect(lines[0]).toContain("300 ••• ••67");
    expect(lines[0]).not.toContain("3001234567");
    expect(maskDestination("email", "ana@example.com")).toBe("a•••@example.com");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => new ConsoleNotifier()).toThrow();
  });

  it("el enrutador manda cada canal a su adaptador y falla sin canal", async () => {
    const wa = new MemoryNotifier();
    const router = new ChannelRouter({ whatsapp: wa });
    await router.send(confirmed);
    expect(wa.sent).toHaveLength(1);
    await expect(router.send({ ...confirmed, channel: "email" })).rejects.toBeInstanceOf(NotifyError);
  });
});
