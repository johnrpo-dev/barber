import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildCsp, cspEnforced, cspHeaderName, newNonce, parseCspReport, redactPath, TURNSTILE_ORIGIN } from "./csp";

const directive = (policy: string, name: string) => policy.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

describe("CSP con nonce", () => {
  it("scripts solo con nonce (y strict-dynamic); Turnstile en script-src y frame-src", () => {
    const p = buildCsp({ nonce: "abc123==", dev: false, enforce: false });
    expect(directive(p, "script-src")).toBe(`script-src 'self' 'nonce-abc123==' 'strict-dynamic' ${TURNSTILE_ORIGIN}`);
    expect(directive(p, "frame-src")).toBe(`frame-src ${TURNSTILE_ORIGIN}`);
    expect(p).not.toContain("unsafe-eval");
    expect(directive(p, "script-src")).not.toContain("unsafe-inline");
    for (const d of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "report-uri /api/csp-report"]) {
      expect(p).toContain(d);
    }
    expect(p).not.toContain("upgrade-insecure-requests");
  });

  it("en desarrollo permite eval (React lo usa para los errores); al bloquear, sube a https", () => {
    expect(directive(buildCsp({ nonce: "n", dev: true, enforce: false }), "script-src")).toContain("'unsafe-eval'");
    expect(buildCsp({ nonce: "n", dev: false, enforce: true })).toContain("upgrade-insecure-requests");
  });

  it("en producción bloquea salvo CSP_ENFORCE=false; en desarrollo solo reporta", () => {
    const prod = { NODE_ENV: "production" };
    expect(cspEnforced(prod)).toBe(true);
    expect(cspEnforced({ ...prod, CSP_ENFORCE: "" })).toBe(true);
    expect(cspEnforced({ ...prod, CSP_ENFORCE: "flase" })).toBe(true);
    expect(cspEnforced({ ...prod, CSP_ENFORCE: "false" })).toBe(false);
    expect(cspEnforced({ ...prod, CSP_ENFORCE: " 0 " })).toBe(false);
    expect(cspEnforced({})).toBe(false);
    expect(cspEnforced({ NODE_ENV: "development", CSP_ENFORCE: "no" })).toBe(false);
    expect(cspEnforced({ CSP_ENFORCE: "true" })).toBe(true);
    expect(cspEnforced({ CSP_ENFORCE: " 1 " })).toBe(true);
    expect(cspHeaderName(false)).toBe("Content-Security-Policy-Report-Only");
    expect(cspHeaderName(true)).toBe("Content-Security-Policy");
  });

  it("propiedad: cada nonce es nuevo, de 128 bits y seguro dentro de la cabecera", () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(fc.constant(null), () => {
        const n = newNonce();
        expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
        expect(seen.has(n)).toBe(false);
        seen.add(n);
      }),
      { numRuns: 200 },
    );
  });
});

describe("reportes de la CSP sin datos personales", () => {
  it("formato viejo: ruta sin consulta ni token, origen sin ruta", () => {
    const [v] = parseCspReport({
      "csp-report": {
        "document-uri": "https://villa.example/cita/SECRETO-123?x=1#y",
        "blocked-uri": "https://evil.example/a.js?telefono=3001234567",
        "violated-directive": "script-src-elem",
      },
    });
    expect(v).toEqual({ directive: "script-src-elem", blocked: "https://evil.example", page: "/cita/[token]", disposition: "report" });
    expect(JSON.stringify(v)).not.toContain("SECRETO");
  });

  it("Reporting API: varias violaciones, palabras clave y basura", () => {
    const out = parseCspReport([
      { type: "csp-violation", body: { documentURL: "https://villa.example/reservar?telefono=300", blockedURL: "inline", effectiveDirective: "script-src-elem", disposition: "enforce" } },
      { type: "deprecation", body: {} },
      "basura",
    ]);
    expect(out).toEqual([{ directive: "script-src-elem", blocked: "inline", page: "/reservar", disposition: "enforce" }]);
    expect(parseCspReport(null)).toEqual([]);
    expect(parseCspReport({ otra: 1 })).toEqual([]);
  });

  it("el token sale aunque /cita no esté al inicio de la ruta", () => {
    expect(redactPath("https://villa.example//cita/SECRETO")).toBe("//cita/[token]");
    expect(redactPath("https://villa.example/x/CITA/SECRETO/calendario.ics")).toBe("/x/cita/[token]/calendario.ics");
  });

  it("propiedad: la ruta reportada nunca lleva el token de /cita ni la consulta", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{10,60}$/), fc.string({ maxLength: 30 }), (token, query) => {
        const path = redactPath(`https://villa.example/cita/${token}/calendario.ics?${encodeURIComponent(query)}`);
        expect(path).toBe("/cita/[token]/calendario.ics");
      }),
    );
  });
});
