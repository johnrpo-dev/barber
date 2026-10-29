// Esqueleto mientras llega la agenda: misma forma que la vista real, sin saltos al cargar.
export default function AgendaLoading() {
  return (
    <div className="flex flex-col gap-4 px-4 pb-6 pt-4 lg:px-8 lg:pt-8" aria-busy="true" aria-label="Cargando agenda">
      <div className="flex flex-col gap-2">
        <div className="h-3 w-16 rounded bg-tinta/10" />
        <div className="h-9 w-48 animate-pulse rounded-lg bg-tinta/10" />
        <div className="h-4 w-32 rounded bg-tinta/5" />
      </div>
      <div className="h-[calc(100dvh-17rem)] min-h-[420px] animate-pulse rounded-2xl border border-tinta/10 bg-papel lg:h-[calc(100dvh-12rem)]" />
    </div>
  );
}
