-- Pruebas de cordura de un backup restaurado (deploy/backup/villa-restore-test.sh y
-- villa-restore.sh). Se corre con psql -v ON_ERROR_STOP=1: cualquier falla aborta con código ≠ 0.
-- Solo lee. Lo que revisa es lo mismo que garantizan los triggers del libro (0001, 0011):
--   1. Todo asiento cuadra (débitos = créditos) y tiene al menos 2 líneas.
--   2. Ninguna línea tiene débito y crédito a la vez ni montos negativos.
--   3. El efectivo del libro (cuenta 1105) de cada sede no es negativo.
--   4. Balance de prueba: por sede, la suma de todos los débitos menos todos los créditos es 0.
--   4b. Inventario (0032–0034): 1435 y 6135 solo los mueven asientos de inventario (o la reversa de
--       una compra), y 1435 de cada sede vale el último conteo + las compras vigentes posteriores.
--   5. Las migraciones están aplicadas y los triggers de garantía existen y están activos.
--   6. Postura de los roles: villa_app no tiene TEMPORARY ni DDL ni puede editar el libro.

\set QUIET on
\pset footer off

\echo '== Conteos =='
SELECT (SELECT count(*) FROM locations) AS sedes,
       (SELECT count(*) FROM journal_entries) AS asientos,
       (SELECT count(*) FROM journal_lines) AS lineas,
       (SELECT count(*) FROM appointments) AS citas,
       (SELECT count(*) FROM clients) AS clientes,
       (SELECT count(*) FROM drizzle.__drizzle_migrations) AS migraciones,
       (SELECT max(created_at) FROM journal_entries) AS ultimo_asiento;

DO $$
DECLARE
  n bigint;
  t text;
  missing text;
BEGIN
  -- 1. Asientos descuadrados o con menos de 2 líneas.
  SELECT count(*) INTO n FROM (
    SELECT e.id
      FROM journal_entries e
      LEFT JOIN journal_lines l ON l.location_id = e.location_id AND l.entry_id = e.id
     GROUP BY e.id
    HAVING count(l.id) < 2 OR coalesce(sum(l.debit), 0) <> coalesce(sum(l.credit), 0)
  ) bad;
  IF n > 0 THEN
    RAISE EXCEPTION 'cordura: % asiento(s) descuadrado(s) o con menos de 2 líneas', n;
  END IF;

  -- 2. Líneas con los dos lados o con montos negativos.
  SELECT count(*) INTO n FROM journal_lines WHERE debit < 0 OR credit < 0 OR (debit > 0) = (credit > 0);
  IF n > 0 THEN
    RAISE EXCEPTION 'cordura: % línea(s) con montos inválidos', n;
  END IF;

  -- 3. Efectivo del libro (1105) negativo en alguna sede.
  SELECT count(*) INTO n FROM (
    SELECT a.location_id
      FROM accounts a
      LEFT JOIN journal_lines l ON l.location_id = a.location_id AND l.account_id = a.id
     WHERE a.code = '1105'
     GROUP BY a.location_id
    HAVING coalesce(sum(l.debit - l.credit), 0) < 0
  ) bad;
  IF n > 0 THEN
    RAISE EXCEPTION 'cordura: el efectivo (1105) quedó negativo en % sede(s)', n;
  END IF;

  -- 4. Balance de prueba por sede.
  SELECT count(*) INTO n FROM (
    SELECT location_id FROM journal_lines GROUP BY location_id HAVING sum(debit) - sum(credit) <> 0
  ) bad;
  IF n > 0 THEN
    RAISE EXCEPTION 'cordura: el balance de prueba no da cero en % sede(s)', n;
  END IF;

  -- 4b. Inventario periódico (sprint 6).
  IF to_regclass('public.inventory_documents') IS NOT NULL THEN
    SELECT count(*) INTO n
      FROM journal_lines l
      JOIN accounts a ON a.location_id = l.location_id AND a.id = l.account_id
      JOIN journal_entries e ON e.location_id = l.location_id AND e.id = l.entry_id
      LEFT JOIN journal_entries o ON o.location_id = e.location_id AND o.id = e.reverses_entry_id
     WHERE a.code IN ('1435', '6135')
       AND NOT (e.kind IN ('inventory_purchase', 'inventory_count')
                OR (e.kind = 'reversal' AND o.kind IN ('inventory_purchase', 'inventory_count')));
    IF n > 0 THEN
      RAISE EXCEPTION 'cordura: % línea(s) en 1435 o 6135 que no son de inventario', n;
    END IF;

    SELECT count(*) INTO n FROM (
      SELECT a.location_id,
             coalesce((SELECT sum(l.debit - l.credit) FROM journal_lines l WHERE l.location_id = a.location_id AND l.account_id = a.id), 0) AS book,
             coalesce((SELECT c.total FROM inventory_documents c WHERE c.location_id = a.location_id AND c.kind = 'count' ORDER BY c.id DESC LIMIT 1), 0)
             + coalesce((SELECT sum(d.total) FROM inventory_documents d
                          WHERE d.location_id = a.location_id AND d.kind = 'purchase'
                            AND d.id > coalesce((SELECT max(c.id) FROM inventory_documents c WHERE c.location_id = a.location_id AND c.kind = 'count'), 0)
                            AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.location_id = d.location_id AND r.reverses_entry_id = d.journal_entry_id)), 0) AS expected
        FROM accounts a
       WHERE a.code = '1435'
    ) x WHERE book <> expected;
    IF n > 0 THEN
      RAISE EXCEPTION 'cordura: el inventario (1435) no cuadra con el último conteo y las compras en % sede(s)', n;
    END IF;
  END IF;

  -- 5. Garantías presentes después de restaurar.
  SELECT string_agg(want, ', ') INTO missing
    FROM unnest(ARRAY[
      'journal_entries_no_update_delete', 'journal_entries_no_truncate', 'journal_entries_before_insert',
      'journal_entries_balanced', 'journal_entries_operational_row',
      'journal_lines_no_update_delete', 'journal_lines_no_truncate', 'journal_lines_before_insert',
      'journal_lines_balanced', 'journal_lines_cash_nonnegative',
      'notifications_no_delete', 'security_alerts_before_delete', 'personal_data_reads_before_delete',
      'sales_totals',
      'journal_lines_inventory_accounts', 'journal_entries_inventory_document', 'journal_entries_inventory_reversal',
      'inventory_documents_entry_matches', 'inventory_documents_no_mutation', 'inventory_document_lines_no_mutation',
      'products_no_delete'
    ]) AS want
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = want AND NOT tgisinternal AND tgenabled <> 'D');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'cordura: faltan o están apagados estos triggers: %', missing;
  END IF;
  IF to_regprocedure('public.purge_expired_personal_data()') IS NULL THEN
    RAISE EXCEPTION 'cordura: falta la función de purga (migración 0012)';
  END IF;

  -- 6. Postura de los roles. Sin villa_app no hay cómo revisarla: el restaurado no sirve tal cual.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'villa_app') THEN
    RAISE EXCEPTION 'cordura: no existe el rol villa_app (corre setup-roles.sql antes de restaurar)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('villa_app', 'villa_queue', 'villa_owner')
              AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'cordura: un rol de la app tiene privilegios de administrador';
  END IF;
  IF has_database_privilege('villa_app', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'cordura: villa_app puede crear tablas temporales en esta base';
  END IF;
  IF has_database_privilege('villa_app', current_database(), 'CREATE') OR has_schema_privilege('villa_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'cordura: villa_app puede crear objetos';
  END IF;
  FOREACH t IN ARRAY ARRAY['journal_entries', 'journal_lines', 'inventory_documents', 'inventory_document_lines'] LOOP
    IF has_table_privilege('villa_app', format('public.%I', t), 'UPDATE')
       OR has_table_privilege('villa_app', format('public.%I', t), 'DELETE')
       OR has_table_privilege('villa_app', format('public.%I', t), 'TRUNCATE') THEN
      RAISE EXCEPTION 'cordura: villa_app puede editar o borrar %', t;
    END IF;
  END LOOP;
  -- Respaldos (0031): la app solo los lee; si pudiera insertar, podría fingir uno que no se hizo.
  IF to_regclass('public.backup_runs') IS NOT NULL
     AND has_table_privilege('villa_app', 'public.backup_runs', 'INSERT') THEN
    RAISE EXCEPTION 'cordura: villa_app puede registrar respaldos en backup_runs';
  END IF;
  IF to_regnamespace('pgboss') IS NOT NULL
     AND (has_schema_privilege('villa_app', 'pgboss', 'USAGE') OR has_schema_privilege('villa_app', 'pgboss', 'CREATE')) THEN
    RAISE EXCEPTION 'cordura: villa_app alcanza el esquema pgboss';
  END IF;
END;
$$;

\echo '== Balance de prueba por sede (debe ser 0) =='
SELECT location_id AS sede, sum(debit) AS debitos, sum(credit) AS creditos, sum(debit) - sum(credit) AS diferencia
  FROM journal_lines GROUP BY location_id ORDER BY location_id;

\echo '== Efectivo del libro (1105) por sede =='
SELECT a.location_id AS sede, coalesce(sum(l.debit - l.credit), 0) AS efectivo_centavos
  FROM accounts a
  LEFT JOIN journal_lines l ON l.location_id = a.location_id AND l.account_id = a.id
 WHERE a.code = '1105'
 GROUP BY a.location_id ORDER BY a.location_id;

\echo '== Inventario del libro (1435) por sede =='
SELECT a.location_id AS sede, coalesce(sum(l.debit - l.credit), 0) AS inventario_centavos
  FROM accounts a
  LEFT JOIN journal_lines l ON l.location_id = a.location_id AND l.account_id = a.id
 WHERE a.code = '1435'
 GROUP BY a.location_id ORDER BY a.location_id;

\echo 'cordura: OK'
