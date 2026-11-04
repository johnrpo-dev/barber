-- Pruebas de cordura de un backup restaurado (deploy/backup/villa-restore-test.sh y
-- villa-restore.sh). Se corre con psql -v ON_ERROR_STOP=1: cualquier falla aborta con código ≠ 0.
-- Solo lee. Lo que revisa es lo mismo que garantizan los triggers del libro (0001, 0011):
--   1. Todo asiento cuadra (débitos = créditos) y tiene al menos 2 líneas.
--   2. Ninguna línea tiene débito y crédito a la vez ni montos negativos.
--   3. El efectivo del libro (cuenta 1105) de cada sede no es negativo.
--   4. Balance de prueba: por sede, la suma de todos los débitos menos todos los créditos es 0.
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

  -- 5. Garantías presentes después de restaurar.
  SELECT string_agg(want, ', ') INTO missing
    FROM unnest(ARRAY[
      'journal_entries_no_update_delete', 'journal_entries_no_truncate', 'journal_entries_before_insert',
      'journal_entries_balanced', 'journal_entries_operational_row',
      'journal_lines_no_update_delete', 'journal_lines_no_truncate', 'journal_lines_before_insert',
      'journal_lines_balanced', 'journal_lines_cash_nonnegative',
      'notifications_no_delete', 'security_alerts_before_delete', 'personal_data_reads_before_delete'
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
  FOREACH t IN ARRAY ARRAY['journal_entries', 'journal_lines'] LOOP
    IF has_table_privilege('villa_app', format('public.%I', t), 'UPDATE')
       OR has_table_privilege('villa_app', format('public.%I', t), 'DELETE')
       OR has_table_privilege('villa_app', format('public.%I', t), 'TRUNCATE') THEN
      RAISE EXCEPTION 'cordura: villa_app puede editar o borrar %', t;
    END IF;
  END LOOP;
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

\echo 'cordura: OK'
