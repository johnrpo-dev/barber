"use client";

import { Search, UserPlus, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ComboBox,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Text,
  TextField,
} from "react-aria-components";
import { Btn, cx, field } from "../../_components/ui";
import { type ClientOption, findClients } from "../actions";

// Buscar al cliente por nombre o celular; si no existe, crearlo con nombre y celular.
// En un walk-in el cliente es opcional (basta un nombre para llamarlo).

export type ClientChoice =
  | { kind: "existing"; id: string; name: string; phone: string | null }
  | { kind: "new"; name: string; phone: string }
  | { kind: "none"; name: string };

export function clientIsReady(c: ClientChoice, optional: boolean): boolean {
  if (c.kind === "existing") return true;
  if (c.kind === "new") return c.name.trim().length >= 2 && c.phone.replace(/\D/g, "").length >= 10;
  return optional;
}

export function toActionClient(c: ClientChoice) {
  if (c.kind === "existing") return { kind: "existing" as const, id: c.id };
  if (c.kind === "new") return { kind: "new" as const, name: c.name, phone: c.phone };
  return { kind: "none" as const, name: c.name };
}

export function ClientPicker({
  value,
  onChange,
  optional = false,
}: {
  value: ClientChoice;
  onChange: (c: ClientChoice) => void;
  optional?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientOption[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      findClients(q).then((r) => {
        setResults(r.ok ? r.data : []);
        setSearching(false);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  if (value.kind === "existing") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-botella/30 bg-botella/5 p-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-botella text-hueso" aria-hidden>
          <UserRound size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{value.name}</p>
          {value.phone ? <p className="monto text-sm text-tinta/70">{value.phone}</p> : null}
        </div>
        <Btn variant="ghost" size="sm" autoFocus onPress={() => onChange({ kind: "none", name: "" })}>
          Cambiar
        </Btn>
      </div>
    );
  }

  if (value.kind === "new") {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-tinta/10 bg-hueso/50 p-3">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <UserPlus size={16} aria-hidden /> Cliente nuevo
          </p>
          <Btn variant="ghost" size="sm" onPress={() => onChange({ kind: "none", name: "" })}>
            Buscar otro
          </Btn>
        </div>
        <TextField
          className={field.root}
          value={value.name}
          onChange={(name) => onChange({ ...value, name })}
          autoComplete="off"
          isRequired
          autoFocus={value.name === ""}
        >
          <Label className={field.label}>Nombre</Label>
          <Input className={field.input} />
        </TextField>
        <TextField
          className={field.root}
          value={value.phone}
          onChange={(phone) => onChange({ ...value, phone })}
          autoComplete="off"
          isRequired
          autoFocus={value.name !== "" && value.phone === ""}
        >
          <Label className={field.label}>Celular</Label>
          <Input className={cx(field.input, "monto")} inputMode="tel" placeholder="300 123 4567" />
          <Text slot="description" className={field.description}>
            Si ya está registrado con ese celular, se usa el mismo cliente.
          </Text>
        </TextField>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ComboBox
        className={field.root}
        items={results}
        inputValue={query}
        onInputChange={(q) => {
          setQuery(q);
          if (optional) onChange({ kind: "none", name: q });
        }}
        onSelectionChange={(key) => {
          const c = results.find((r) => r.id === key);
          if (c) onChange({ kind: "existing", id: c.id, name: c.name, phone: c.phone });
        }}
        menuTrigger="input"
        allowsEmptyCollection
        allowsCustomValue={optional}
      >
        <Label className={field.label}>{optional ? "Cliente (opcional)" : "Cliente"}</Label>
        <div className="relative">
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tinta/70" aria-hidden />
          <Input className={cx(field.input, "pl-10")} placeholder="Nombre o celular" />
        </div>
        <Text slot="description" className={field.description}>
          {optional ? "Escribe un nombre para llamarlo, o búscalo si ya es cliente." : "Escribe al menos 2 letras o 3 números."}
        </Text>
        <Popover className="w-(--trigger-width) overflow-auto rounded-xl border border-tinta/10 bg-papel p-1 shadow-xl data-[entering]:animate-pop-in">
          <ListBox
            className="max-h-72 outline-none"
            renderEmptyState={() => (
              <p className="p-3 text-sm text-tinta/70">{searching ? "Buscando…" : "Nadie con ese nombre o celular"}</p>
            )}
          >
            {(c: ClientOption) => (
              <ListBoxItem
                id={c.id}
                textValue={c.name}
                className={({ isFocused }) =>
                  cx(
                    "flex min-h-12 cursor-pointer flex-col justify-center rounded-lg px-3 py-2 outline-none",
                    isFocused && "bg-cuero/15 outline-2 -outline-offset-2 outline-cuero",
                  )
                }
              >
                <span className="font-semibold">{c.name}</span>
                {c.phone ? <span className="monto text-sm text-tinta/70">{c.phone}</span> : null}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </ComboBox>
      <Btn
        variant="secondary"
        onPress={() => {
          const digits = query.replace(/\D/g, "");
          onChange(digits.length >= 7 ? { kind: "new", name: "", phone: query } : { kind: "new", name: query, phone: "" });
        }}
      >
        <UserPlus size={18} aria-hidden /> Cliente nuevo
      </Btn>
    </div>
  );
}
