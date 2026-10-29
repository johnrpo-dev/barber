import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CURRENT_PRIVACY, PRIVACY_VERSIONS, privacyVersion } from "@/content/privacy/versions";
import { longDate } from "../_lib/ui";

// Política de tratamiento de datos (Ley 1581). La vigente por defecto; ?v= muestra una anterior
// (la prueba de lo que aceptó cada persona, por client_consents.text_version).

export const metadata: Metadata = { title: "Política de privacidad" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PrivacidadPage({ searchParams }: { searchParams: SearchParams }) {
  const { v } = await searchParams;
  const requested = Array.isArray(v) ? v[0] : v;
  const policy = requested ? privacyVersion(requested) : CURRENT_PRIVACY;
  if (!policy) notFound();
  const isCurrent = policy.version === CURRENT_PRIVACY.version;
  const others = PRIVACY_VERSIONS.filter((p) => p.version !== policy.version);

  return (
    <main className="mx-auto max-w-[68ch] px-4 py-10 lg:grid lg:max-w-6xl lg:grid-cols-[15rem_minmax(0,68ch)] lg:gap-16 print:block print:max-w-none print:py-0">
      <header className="flex flex-col gap-2 lg:col-start-2">
        <h1 className="font-display text-4xl leading-tight">{policy.title}</h1>
        <p className="text-sm text-tinta/70">
          Versión {policy.version} · vigente desde el {longDate(policy.publishedOn).replace(/^\S+ /, "")} de {policy.publishedOn.slice(0, 4)}
        </p>
        <div aria-hidden className="mt-1 h-px w-16 bg-laton print:hidden" />
        {!isCurrent ? (
          <p className="mt-2 rounded-xl border border-tinta/15 bg-papel p-3 text-sm print:hidden">
            Esta es una versión anterior de la política.{" "}
            <Link href="/privacidad" className="font-semibold text-cuero underline underline-offset-4">
              Ver la versión vigente
            </Link>
            .
          </p>
        ) : null}
      </header>

      {/* Índice: plegable en celular, columna fija en pantallas anchas. */}
      <details className="group mt-6 rounded-xl border border-tinta/10 bg-papel lg:hidden print:hidden">
        <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-semibold">Contenido</summary>
        <Toc sections={policy.sections} className="px-4 pb-3" />
      </details>
      <nav aria-label="Contenido" className="hidden lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:block print:hidden">
        <div className="sticky top-6">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-botella">Contenido</p>
          <Toc sections={policy.sections} className="mt-3" />
        </div>
      </nav>

      <div className="mt-8 flex flex-col gap-8 lg:col-start-2 print:mt-4 print:gap-4">
        {policy.sections.map((section, i) => (
          <section key={section.id} id={section.id} aria-labelledby={`${section.id}-h`} className="scroll-mt-6 print:break-inside-avoid">
            <h2 id={`${section.id}-h`} className="font-display text-2xl leading-tight">
              <span className="monto text-tinta/70">{i + 1}.</span> {section.heading}
            </h2>
            <div className="mt-3 flex flex-col gap-3 text-base leading-relaxed">
              {section.paragraphs.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
          </section>
        ))}

        {others.length > 0 ? (
          <section aria-labelledby="versiones-h" className="border-t border-tinta/10 pt-6 print:hidden">
            <h2 id="versiones-h" className="text-sm font-semibold">
              Otras versiones
            </h2>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {others.map((p) => (
                <li key={p.version}>
                  <Link
                    href={p.version === CURRENT_PRIVACY.version ? "/privacidad" : `/privacidad?v=${encodeURIComponent(p.version)}`}
                    className="inline-flex min-h-11 items-center text-cuero underline underline-offset-4"
                  >
                    Versión {p.version}
                    {p.version === CURRENT_PRIVACY.version ? " (vigente)" : ""}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function Toc({ sections, className }: { sections: readonly { id: string; heading: string }[]; className?: string }) {
  return (
    <ol className={className}>
      {sections.map((s, i) => (
        <li key={s.id}>
          <a href={`#${s.id}`} className="flex min-h-11 items-center gap-2 text-sm hover:text-cuero lg:min-h-9">
            <span className="monto w-5 text-tinta/70">{i + 1}.</span>
            {s.heading}
          </a>
        </li>
      ))}
    </ol>
  );
}
