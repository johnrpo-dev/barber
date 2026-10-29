"use client";

import { CalendarPlus, CalendarX2 } from "lucide-react";
import { useState } from "react";
import { Btn, PageHeader, Sheet } from "../_components/ui";
import { TimeOffForm, TimeOffList } from "../personal/time-off";
import type { TimeOffView } from "../personal/time-off-view";
import { addClosureAction, addStaffTimeOffAction } from "./actions";

export interface PersonTimeOff {
  id: string;
  name: string;
  isMe: boolean;
  items: TimeOffView[];
}

export function TimeOffBoard({
  people,
  closures,
  manageAll,
  today,
}: {
  people: PersonTimeOff[];
  /** Cierres de la sede; null para quien solo maneja su propio tiempo. */
  closures: TimeOffView[] | null;
  manageAll: boolean;
  today: string;
}) {
  const [addingFor, setAddingFor] = useState<PersonTimeOff | null>(null);
  const [closing, setClosing] = useState(false);
  const firstName = (p: PersonTimeOff) => p.name.split(" ")[0] ?? p.name;

  return (
    <>
      <PageHeader eyebrow={manageAll ? "Equipo" : "Tu tiempo"} title="Bloqueos y ausencias" />
      <p className="-mt-3 max-w-prose text-sm text-tinta/70">
        {manageAll
          ? "Lo que registres aquí sale de la agenda: nadie podrá agendar en esos ratos."
          : "Bloquea un rato o un día completo (una diligencia, un almuerzo largo). Para vacaciones o incapacidad, habla con la recepción."}
      </p>

      {people.map((person) => {
        const headingId = `persona-${person.id}`;
        return (
          <section key={person.id} aria-labelledby={headingId} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id={headingId} className="font-display text-2xl leading-tight">
                {person.isMe && manageAll ? `${person.name} (tú)` : manageAll ? person.name : "Tus bloqueos"}
              </h2>
              <Btn variant="secondary" onPress={() => setAddingFor(person)}>
                <CalendarPlus size={18} aria-hidden />
                {manageAll ? "Agregar" : "Bloquear tiempo"}
                {manageAll ? <span className="sr-only"> para {person.name}</span> : null}
              </Btn>
            </div>
            <TimeOffList
              items={person.items}
              emptyText={person.isMe ? "No tienes bloqueos próximos." : `${firstName(person)} no tiene ausencias próximas.`}
            />
          </section>
        );
      })}

      {closures ? (
        <section aria-labelledby="cierres" className="mt-2 flex flex-col gap-3 border-t border-tinta/10 pt-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 id="cierres" className="font-display text-2xl leading-tight">
                Cierres de la sede
              </h2>
              <p className="max-w-prose text-sm text-tinta/70">Festivos y días en que nadie atiende.</p>
            </div>
            <Btn variant="secondary" onPress={() => setClosing(true)}>
              <CalendarX2 size={18} aria-hidden />
              Agregar cierre
            </Btn>
          </div>
          <TimeOffList items={closures} showKind={false} emptyText="No hay cierres próximos." />
        </section>
      ) : null}

      <Sheet
        isOpen={addingFor !== null}
        onOpenChange={(open) => (open ? null : setAddingFor(null))}
        title={!addingFor || !manageAll ? "Bloquear tiempo" : `Ausencia o bloqueo de ${firstName(addingFor)}`}
        description={manageAll ? "Ese rato deja de ofrecerse en la agenda." : "Ese rato deja de ofrecerse en tu agenda."}
      >
        {addingFor ? (
          <TimeOffForm
            variant={manageAll ? "staff" : "own"}
            today={today}
            subject={addingFor.isMe ? "Tu agenda" : firstName(addingFor)}
            submit={({ kind, reason, range }) => addStaffTimeOffAction({ staffId: addingFor.id, kind, reason, range })}
            onDone={() => setAddingFor(null)}
          />
        ) : null}
      </Sheet>

      <Sheet isOpen={closing} onOpenChange={setClosing} title="Cerrar la sede" description="Días completos, para todo el personal.">
        {closing ? (
          <TimeOffForm
            variant="closure"
            today={today}
            subject="La sede"
            submit={({ reason, range }) =>
              addClosureAction({ reason, ...(range.allDay ? { fromDate: range.fromDate, toDate: range.toDate } : {}) })
            }
            onDone={() => setClosing(false)}
          />
        ) : null}
      </Sheet>
    </>
  );
}
