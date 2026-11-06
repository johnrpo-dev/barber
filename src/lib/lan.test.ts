import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({
  networkInterfaces: () => ({
    lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    wifi: [
      { family: "IPv4", internal: false, address: "192.168.0.16" },
      { family: "IPv6", internal: false, address: "fe80::1" },
    ],
    vpn: [{ family: "IPv4", internal: false, address: "100.64.3.2" }],
    publica: [{ family: "IPv4", internal: false, address: "181.50.1.2" }],
    docker: [{ family: "IPv4", internal: false, address: "172.17.0.1" }],
  }),
}));

const { devLanOrigins, lanAddresses } = await import("./lan");

afterEach(() => vi.unstubAllEnvs());

describe("lanAddresses", () => {
  it("solo las IPv4 privadas, nunca la de bucle, las públicas ni las de otros rangos", () => {
    expect(lanAddresses()).toEqual(["192.168.0.16", "172.17.0.1"]);
  });
});

describe("devLanOrigins", () => {
  it("usa el puerto de BETTER_AUTH_URL", () => {
    vi.stubEnv("PORT", undefined);
    expect(devLanOrigins("http://localhost:3000")).toEqual(["http://192.168.0.16:3000", "http://172.17.0.1:3000"]);
  });

  it("agrega el de PORT si next dev corre en otro", () => {
    vi.stubEnv("PORT", "3001");
    expect(devLanOrigins("http://localhost:3000")).toEqual([
      "http://192.168.0.16:3000",
      "http://192.168.0.16:3001",
      "http://172.17.0.1:3000",
      "http://172.17.0.1:3001",
    ]);
  });
});
