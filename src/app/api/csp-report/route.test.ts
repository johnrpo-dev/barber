import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const JSON_TYPE = { "content-type": "application/csp-report" };

function streamed(chunks: number, chunkBytes: number): { request: Request; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return controller.close();
      pulled++;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
    cancel() {
      cancelled = true;
    },
  });
  // Sin Content-Length: quien ataca no lo manda.
  const request = new Request("https://villa.test/api/csp-report", { method: "POST", headers: JSON_TYPE, body, duplex: "half" } as RequestInit);
  return { request, pulled: () => pulled, cancelled: () => cancelled };
}

describe("POST /api/csp-report", () => {
  it("corta la lectura apenas pasa los 16 KB, aunque no haya Content-Length", async () => {
    const s = streamed(1_000, 4 * 1024);
    const response = await POST(s.request);
    expect(response.status).toBe(413);
    expect(s.cancelled()).toBe(true);
    // Leyó lo justo para pasarse, no los 4 MB (el flujo puede adelantar un par de pedazos).
    expect(s.pulled()).toBeLessThan(10);
  });

  it("un Content-Length grande se rechaza sin leer", async () => {
    const request = new Request("https://villa.test/api/csp-report", {
      method: "POST",
      headers: { ...JSON_TYPE, "content-length": String(1024 * 1024) },
      body: "{}",
    });
    expect((await POST(request)).status).toBe(413);
  });

  it("un reporte normal se registra sin el token ni la consulta", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = new Request("https://villa.test/api/csp-report", {
      method: "POST",
      headers: JSON_TYPE,
      body: JSON.stringify({ "csp-report": { "violated-directive": "script-src", "blocked-uri": "https://mal.test/a?x=1", "document-uri": "https://villa.test/cita/SECRETO?y=2" } }),
    });
    expect((await POST(request)).status).toBe(204);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("/cita/[token]");
    expect(logged).not.toContain("SECRETO");
    warn.mockRestore();
  });

  it("basura o tipo equivocado no pasa", async () => {
    const bad = new Request("https://villa.test/api/csp-report", { method: "POST", headers: JSON_TYPE, body: "no es json" });
    expect((await POST(bad)).status).toBe(400);
    const wrong = new Request("https://villa.test/api/csp-report", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect((await POST(wrong)).status).toBe(415);
  });
});
