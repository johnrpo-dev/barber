-- Garantías contables dentro de PostgreSQL (ver docs/arquitectura.md, "Modelo contable").
-- Ningún código de la aplicación puede saltárselas: si hay un bug, la transacción falla.

-- 1. Solo-inserción: asientos, líneas y eventos de cierre no se modifican ni se borran.
CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger: % es solo-inserción; corrige con un asiento de reversa', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_no_update_delete BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_lines_no_update_delete BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER day_close_events_no_update_delete BEFORE UPDATE OR DELETE ON day_close_events
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER day_close_events_no_truncate BEFORE TRUNCATE ON day_close_events
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_mutation();
--> statement-breakpoint

-- Candado por (sede, día): asientos lo toman compartido, cierres/reaperturas exclusivo.
-- Así un asiento no se cuela en un día que se está cerrando al mismo tiempo.
CREATE FUNCTION ledger_day_lock_key(p_location_id bigint, p_business_date date) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended('ledger-day:' || p_location_id || ':' || p_business_date, 0)
$$;
--> statement-breakpoint
CREATE FUNCTION ledger_day_is_closed(p_location_id bigint, p_business_date date) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT action = 'close' FROM day_close_events
      WHERE location_id = p_location_id AND business_date = p_business_date
      ORDER BY id DESC LIMIT 1),
    false)
$$;
--> statement-breakpoint

-- 2. Reglas al crear un asiento.
CREATE FUNCTION ledger_before_insert_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_currency char(3);
  v_original_kind text;
BEGIN
  -- La fecha de creación la pone la base de datos (la usa la regla de líneas más abajo).
  NEW.created_at := now();

  PERFORM pg_advisory_xact_lock_shared(ledger_day_lock_key(NEW.location_id, NEW.business_date));
  IF ledger_day_is_closed(NEW.location_id, NEW.business_date) THEN
    RAISE EXCEPTION 'ledger: el día % está cerrado en la sede %; reábrelo con motivo antes de registrar',
      NEW.business_date, NEW.location_id USING ERRCODE = 'check_violation';
  END IF;

  SELECT currency INTO v_currency FROM locations WHERE id = NEW.location_id;
  IF v_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'ledger: moneda % distinta a la de la sede (%)', NEW.currency, v_currency
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.reverses_entry_id IS NOT NULL THEN
    SELECT kind INTO v_original_kind FROM journal_entries
      WHERE id = NEW.reverses_entry_id AND location_id = NEW.location_id;
    IF v_original_kind = 'reversal' THEN
      RAISE EXCEPTION 'ledger: una reversa no se puede reversar; registra un asiento nuevo'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_before_insert BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_before_insert_entry();
--> statement-breakpoint

-- 3. Las líneas solo se agregan a un asiento creado en la misma transacción:
--    un asiento ya confirmado no puede recibir líneas nuevas.
CREATE FUNCTION ledger_before_insert_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM journal_entries
     WHERE id = NEW.entry_id AND location_id = NEW.location_id AND created_at = now()
  ) THEN
    RAISE EXCEPTION 'ledger: el asiento % ya está confirmado; no admite líneas nuevas', NEW.entry_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_before_insert BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_before_insert_line();
--> statement-breakpoint

-- 4. Al hacer COMMIT: el asiento tiene al menos dos líneas, débitos = créditos,
--    y si es una reversa, sus líneas son el espejo exacto del original.
CREATE FUNCTION ledger_assert_entry(p_entry_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_lines bigint;
  v_debits numeric;
  v_credits numeric;
  v_reverses bigint;
BEGIN
  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    INTO v_lines, v_debits, v_credits
    FROM journal_lines WHERE entry_id = p_entry_id;

  IF v_lines < 2 THEN
    RAISE EXCEPTION 'ledger: el asiento % tiene % línea(s); necesita al menos dos', p_entry_id, v_lines
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'ledger: el asiento % no cuadra (débitos %, créditos % centavos)', p_entry_id, v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT reverses_entry_id INTO v_reverses FROM journal_entries WHERE id = p_entry_id;
  IF v_reverses IS NOT NULL AND EXISTS (
    (SELECT account_id, credit AS debit, debit AS credit FROM journal_lines WHERE entry_id = v_reverses
     EXCEPT ALL
     SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = p_entry_id)
    UNION ALL
    (SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = p_entry_id
     EXCEPT ALL
     SELECT account_id, credit AS debit, debit AS credit FROM journal_lines WHERE entry_id = v_reverses)
  ) THEN
    RAISE EXCEPTION 'ledger: la reversa % no es el espejo exacto del asiento %', p_entry_id, v_reverses
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
-- Una función por tabla: plpgsql resuelve NEW.<campo> según la tabla del trigger.
CREATE FUNCTION ledger_check_entry_from_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_assert_entry(NEW.id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION ledger_check_entry_from_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_assert_entry(NEW.entry_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_from_entry();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_from_line();
--> statement-breakpoint

-- 5. Cierres y reaperturas coherentes: no se cierra un día cerrado ni se reabre uno abierto.
CREATE FUNCTION ledger_before_insert_day_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_closed boolean;
BEGIN
  NEW.created_at := now();
  PERFORM pg_advisory_xact_lock(ledger_day_lock_key(NEW.location_id, NEW.business_date));
  v_closed := ledger_day_is_closed(NEW.location_id, NEW.business_date);
  IF NEW.action = 'close' AND v_closed THEN
    RAISE EXCEPTION 'ledger: el día % ya está cerrado', NEW.business_date USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.action = 'reopen' AND NOT v_closed THEN
    RAISE EXCEPTION 'ledger: el día % no está cerrado', NEW.business_date USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER day_close_events_before_insert BEFORE INSERT ON day_close_events
  FOR EACH ROW EXECUTE FUNCTION ledger_before_insert_day_event();
