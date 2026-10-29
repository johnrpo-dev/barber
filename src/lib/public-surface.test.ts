import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIcs, foldLine, icsText } from "@/domain/booking/ics";
import { dayPeriod, formatClock, formatDateLabel, initials, ticketCode } from "@/domain/booking/public-labels";
import { ipBucketKey, ipFromHeaders } from "./client-ip";
import { ConsoleNotifier } from "./notify/console";
import { publicEnv } from "./env";
import { allowsDevFallbacks, DEV_ONLY_MANAGE_LINK_SECRET, DEV_ONLY_OTP_PEPPER, publicBookingReadiness, publicConfig } from "./public-readiness";
import { FakeVerifier, TurnstileVerifier } from "./turnstile";

// Piezas del lado público sin base de datos: configuración y degradación, IP real, Turnstile,
// .ics y los textos que ve el cliente.

const PUBLIC_VARS = [
  "OTP_PEPPER",
  "MANAGE_LINK_SECRET",
  "PUBLIC_BASE_URL",
  "TURNSTILE_SECRET",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_APP_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "ALERT_EMAIL",
  "NOTIFY_CAP_PHONE",
  "NOTIFY_CAP_GLOBAL",
];

function clearPublicEnv() {
  for (const name of PUBLIC_VARS) vi.stubEnv(name, "");
}

afterEach(() => vi.unstubAllEnvs());

describe("configuración pública", () => {
  it("cada variable mala cuenta como ausente, sin mostrar su valor", () => {
    const { values, problems } = publicEnv({ OTP_PEPPER: "corto", PUBLIC_BASE_URL: "https://villa.test/", NOTIFY_CAP_PHONE: "4" });
    expect(values.OTP_PEPPER).toBeUndefined();
    expect(values.PUBLIC_BASE_URL).toBe("https://villa.test");
    expect(values.NOTIFY_CAP_PHONE).toBe(4);
    expect(problems.join(" ")).toContain("OTP_PEPPER");
    expect(problems.join(" ")).not.toContain("corto");
  });

  it("los dos secretos deben ser distintos", () => {
    const same = "x".repeat(40);
    const { values, problems } = publicEnv({ OTP_PEPPER: same, MANAGE_LINK_SECRET: same });
    expect(values.OTP_PEPPER).toBeUndefined();
    expect(values.MANAGE_LINK_SECRET).toBeUndefined();
    expect(problems).toContain("OTP_PEPPER y MANAGE_LINK_SECRET deben ser distintos");
  });

  it("en producción falla cerrado: sin nada no está lista y publicConfig lanza", () => {
    clearPublicEnv();
    vi.stubEnv("NODE_ENV", "production");
    const r = publicBookingReadiness();
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(["OTP_PEPPER", "MANAGE_LINK_SECRET", "PUBLIC_BASE_URL", "TURNSTILE_SECRET"]));
    expect(r.channels).toEqual([]);
    expect(() => publicConfig()).toThrow(/no está disponible/);
  });

  const stubAllButChannels = () => {
    clearPublicEnv();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OTP_PEPPER", "p".repeat(40));
    vi.stubEnv("MANAGE_LINK_SECRET", "m".repeat(40));
    vi.stubEnv("PUBLIC_BASE_URL", "https://villa.test");
    vi.stubEnv("TURNSTILE_SECRET", "ts");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "sk");
  };

  it("en producción el código va solo por WhatsApp: con solo correo NO está lista", () => {
    stubAllButChannels();
    vi.stubEnv("RESEND_API_KEY", "re");
    vi.stubEnv("EMAIL_FROM", "Villa <c@villa.test>");
    const r = publicBookingReadiness();
    expect(r).toMatchObject({ ready: false, missing: ["WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID"], devFallbacks: false });
    expect(() => publicConfig()).toThrow(/no está disponible/);
  });

  it("en producción con WhatsApp está lista (el correo queda para avisos)", () => {
    stubAllButChannels();
    vi.stubEnv("WHATSAPP_TOKEN", "wa");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1234567890");
    expect(publicBookingReadiness()).toMatchObject({ ready: true, missing: [], channels: ["whatsapp"], devFallbacks: false });
    vi.stubEnv("RESEND_API_KEY", "re");
    vi.stubEnv("EMAIL_FROM", "Villa <c@villa.test>");
    expect(publicBookingReadiness()).toMatchObject({ ready: true, channels: ["whatsapp", "email"] });
    expect(publicConfig().otpPepper).not.toBe(DEV_ONLY_OTP_PEPPER);
  });

  it("lo de desarrollo solo con NODE_ENV development o test: sin definir o 'staging' falla cerrado", () => {
    for (const env of [undefined, "staging", "production", "Development", ""]) {
      clearPublicEnv();
      vi.stubEnv("NODE_ENV", env);
      expect(allowsDevFallbacks()).toBe(false);
      expect(publicBookingReadiness()).toMatchObject({ ready: false, devFallbacks: false, channels: [] });
      expect(() => publicConfig()).toThrow(/no está disponible/);
      expect(() => new FakeVerifier()).toThrow();
      expect(() => new ConsoleNotifier(() => {})).toThrow();
      // Sin proxy no se inventa una IP.
      expect(ipFromHeaders(new Headers())).toBeNull();
      // Una URL http pública tampoco sirve.
      expect(publicEnv({ PUBLIC_BASE_URL: "http://villa.test" }).values.PUBLIC_BASE_URL).toBeUndefined();
    }
    for (const env of ["development", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      expect(allowsDevFallbacks()).toBe(true);
      expect(ipFromHeaders(new Headers())).toBe("127.0.0.1");
    }
  });

  it("en producción una URL http pública no sirve", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(publicEnv({ PUBLIC_BASE_URL: "http://villa.test" }).values.PUBLIC_BASE_URL).toBeUndefined();
  });

  it("en desarrollo usa los secretos de desarrollo y la consola cubre ambos canales", () => {
    clearPublicEnv();
    vi.stubEnv("NODE_ENV", "development");
    const r = publicBookingReadiness();
    expect(r).toMatchObject({ ready: true, devFallbacks: true, channels: ["whatsapp", "email"] });
    const c = publicConfig();
    expect([c.otpPepper, c.manageLinkSecret]).toEqual([DEV_ONLY_OTP_PEPPER, DEV_ONLY_MANAGE_LINK_SECRET]);
    expect(c.turnstile).toBeNull();
  });
});

describe("IP real del cliente", () => {
  const h = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});

  it("salta los proxies de confianza desde la derecha", () => {
    expect(ipFromHeaders(h("1.2.3.4, 127.0.0.1"), true)).toBe("1.2.3.4");
    // El extremo izquierdo lo escribe quien quiera: se toma el primer salto no confiable desde la derecha.
    expect(ipFromHeaders(h("6.6.6.6, 5.5.5.5, 127.0.0.1"), true)).toBe("5.5.5.5");
    expect(ipFromHeaders(h("::ffff:9.9.9.9"), true)).toBe("9.9.9.9");
  });

  it("sin cabecera: localhost fuera de producción, null en producción", () => {
    expect(ipFromHeaders(h(), false)).toBe("127.0.0.1");
    expect(ipFromHeaders(h(), true)).toBeNull();
    expect(ipFromHeaders(h("basura"), true)).toBeNull();
  });

  it("la cubeta de límites: IPv4 tal cual, IPv6 colapsada a su /64", () => {
    expect(ipBucketKey("1.2.3.4")).toBe("1.2.3.4");
    expect(ipBucketKey("2001:db8:aa:bb:1:2:3:4")).toBe("2001:db8:aa:bb::/64");
    expect(ipBucketKey("2001:0DB8:00aa:00bb:ffff::1")).toBe("2001:db8:aa:bb::/64");
    expect(ipBucketKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucketKey("::1")).toBe("0:0:0:0::/64");
    expect(ipBucketKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipBucketKey("::ffff:1.2.3.4")).toBe("0:0:0:0::/64");
  });

  it("propiedad: toda IPv6 de la misma /64 cae en la misma cubeta, y una /64 distinta no", () => {
    const group = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16));
    const groups = (n: number) => fc.array(group, { minLength: n, maxLength: n });
    fc.assert(
      fc.property(groups(4), groups(4), groups(4), fc.integer({ min: 0, max: 3 }), (prefix, a, b, flip) => {
        const ip = (hi: string[], lo: string[]) => [...hi, ...lo].join(":");
        expect(ipBucketKey(ip(prefix, a))).toBe(ipBucketKey(ip(prefix, b)));
        const other = [...prefix];
        other[flip] = ((parseInt(other[flip]!, 16) + 1) % 0x10000).toString(16);
        expect(ipBucketKey(ip(other, a))).not.toBe(ipBucketKey(ip(prefix, a)));
      }),
    );
  });
});

describe("Turnstile", () => {
  const verifierWith = (status: number, body: unknown) => {
    const calls: URLSearchParams[] = [];
    const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.body as URLSearchParams);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { v: new TurnstileVerifier("secreto", "villa.test", fn), calls };
  };

  it("acepta solo éxito con la acción y el host esperados, y manda la IP", async () => {
    const { v, calls } = verifierWith(200, { success: true, action: "reservar", hostname: "villa.test" });
    expect(await v.verify("tok", "1.2.3.4")).toBe(true);
    expect(calls[0]!.get("remoteip")).toBe("1.2.3.4");
    expect(calls[0]!.get("secret")).toBe("secreto");
    expect(await verifierWith(200, { success: true, action: "otra", hostname: "villa.test" }).v.verify("tok", null)).toBe(false);
    expect(await verifierWith(200, { success: true, action: "reservar", hostname: "evil.test" }).v.verify("tok", null)).toBe(false);
    expect(await verifierWith(500, {}).v.verify("tok", null)).toBe(false);
    expect(await v.verify("", null)).toBe(false);
  });

  it("un error de red falla cerrado", async () => {
    const v = new TurnstileVerifier("s", "villa.test", (async () => {
      throw new Error("red");
    }) as typeof fetch);
    expect(await v.verify("tok", null)).toBe(false);
  });

  it("el falso acepta 'ok' y no existe en producción", async () => {
    expect(await new FakeVerifier().verify("ok")).toBe(true);
    expect(await new FakeVerifier().verify("no")).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => new FakeVerifier()).toThrow();
  });
});

describe("textos para el cliente y .ics", () => {
  it("horas, fechas, código de turno, periodo e iniciales", () => {
    expect([formatClock(540), formatClock(930), formatClock(720), formatClock(0)]).toEqual(["9:00 a. m.", "3:30 p. m.", "12:00 p. m.", "12:00 a. m."]);
    expect(formatDateLabel("2026-10-29")).toBe("jueves 29 de octubre");
    expect(ticketCode("01JBCDEFGHJKMNPQRSTV4K7Q")).toBe("V-4K7Q");
    expect([dayPeriod(600), dayPeriod(780), dayPeriod(1140)]).toEqual(["morning", "afternoon", "evening"]);
    expect(initials("andrés felipe gómez")).toBe("AF");
  });

  it("el .ics va en UTC con Z, alarma 1 h antes, texto escapado y líneas plegadas", () => {
    const ics = buildIcs({
      uid: "01ABC@villa",
      start: new Date("2026-10-30T20:30:00Z"),
      end: new Date("2026-10-30T21:00:00Z"),
      now: new Date("2026-10-29T12:00:00Z"),
      summary: "Corte, barba; y más",
      description: `Para cancelar: https://villa.test/cita/${"a".repeat(43)}`,
      location: "Calle 1 # 2-3",
      url: null,
    });
    expect(ics).toContain("DTSTART:20261030T203000Z\r\n");
    expect(ics).toContain("DTEND:20261030T210000Z\r\n");
    expect(ics).toContain("TRIGGER:-PT1H");
    expect(ics).toContain("SUMMARY:Corte\\, barba\\; y más");
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(icsText("a\nb")).toBe("a\\nb");
    expect(foldLine("x".repeat(80)).split("\r\n ")).toHaveLength(2);
  });
});
