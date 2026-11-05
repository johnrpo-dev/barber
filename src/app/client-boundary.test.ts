import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Frontera servidor/cliente. Un componente de servidor que importa de un módulo "use client"
// recibe referencias de cliente: sirven como componentes (<Algo />) o como props de un componente
// de cliente, pero NO como funciones ni como valores. Llamar cx() o usar una constante de clases
// así revienta en el servidor ("Attempted to call cx() from the server…"), y solo al pintar la
// página: ni typecheck ni build lo ven. Pasó en /panel/ventas (sprint 6).
//
// Regla que vigila esta prueba: desde un archivo de servidor, de un módulo "use client" solo se
// importan componentes (nombre con mayúscula inicial) o tipos.

const APP = resolve(__dirname);
const SRC = resolve(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const isClient = (src: string) => /^\s*(\/\/[^\n]*\n\s*)*["']use client["']/.test(src);

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** Nombres de valor importados (sin `type`), con su módulo. */
function valueImports(src: string): { names: string[]; spec: string }[] {
  const out: { names: string[]; spec: string }[] = [];
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
    if (m[1]) continue;
    const names = m[2]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("type "))
      .map((s) => s.split(/\s+as\s+/).pop()!.trim());
    out.push({ names, spec: m[3]! });
  }
  return out;
}

describe("frontera servidor/cliente", () => {
  it("ningún archivo de servidor usa funciones ni constantes de un módulo 'use client'", () => {
    const bad: string[] = [];
    for (const file of files(APP)) {
      const src = readFileSync(file, "utf8");
      if (isClient(src) || /["']use server["']/.test(src.slice(0, 200))) continue;
      for (const { names, spec } of valueImports(src)) {
        const target = resolveImport(file, spec);
        if (!target || !isClient(readFileSync(target, "utf8"))) continue;
        for (const name of names.filter((n) => !/^[A-Z]/.test(n))) bad.push(`${file.slice(SRC.length + 1)}: ${name} de ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
