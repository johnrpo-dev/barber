-- Separación de roles de Postgres para Villa (docs/arquitectura.md, "Seguridad").
--
--   villa_owner  dueño de la base y del esquema; SOLO corre las migraciones (MIGRATION_DATABASE_URL).
--   villa_app    la app web y los trabajos del worker (DATABASE_URL). No es dueño de ninguna tabla
--                de public ni tiene CREATE en NINGÚN esquema: no puede desactivar ni borrar triggers,
--                ni cambiar el esquema, ni crear funciones "sombra", ni hacer UPDATE, DELETE o
--                TRUNCATE sobre el libro y las tablas solo-inserción. Los permisos exactos los pone
--                la función app_apply_grants() (migraciones 0009 a 0011).
--   villa_queue  la cola del worker (pg-boss, QUEUE_DATABASE_URL). Es dueño SOLO del esquema pgboss
--                y no tiene permisos en public. Antes ese esquema era de villa_app, y con eso la app
--                podía crear funciones que reemplazaban las de las garantías (auditoría del sprint 4,
--                HIGH-1); ahora la app no crea nada en ningún lado.
--
-- Se corre UNA vez en el VPS, como superusuario, y se puede repetir sin daño:
--
--   sudo -u postgres psql -f src/db/roles/setup-roles.sql
--
-- Pide las tres contraseñas (no quedan en el historial de la terminal). NO las pases con
-- `-v owner_password=…` (ni app_password ni queue_password): quedarían en el historial del shell y
-- en la lista de procesos (`ps`) mientras corre. Ojo: \prompt de psql MUESTRA lo que escribes en
-- la pantalla (no lo oculta): córrelo sin nadie mirando, sin grabar la terminal, y limpia la
-- pantalla al terminar. Si ya existe el rol de
-- antes ("villa", el del README), le pasa todo lo suyo a villa_owner; ese rol se borra a mano
-- cuando la app ya ande con villa_app (ver el final).
--
-- Después:
--   1. En .env:  MIGRATION_DATABASE_URL=postgres://villa_owner:<clave>@localhost:5432/villa
--                DATABASE_URL=postgres://villa_app:<clave>@localhost:5432/villa
--                QUEUE_DATABASE_URL=postgres://villa_queue:<clave>@localhost:5432/villa
--   2. npm run db:migrate          (corre como villa_owner y aplica los permisos)
--   3. Reiniciar villa-web y villa-worker.

\set ON_ERROR_STOP on
\if :{?db}
\else
  \set db villa
\endif
\if :{?owner_password}
\else
  \prompt 'Contraseña nueva para villa_owner: ' owner_password
\endif
\if :{?app_password}
\else
  \prompt 'Contraseña nueva para villa_app: ' app_password
\endif
\if :{?queue_password}
\else
  \prompt 'Contraseña nueva para villa_queue: ' queue_password
\endif

-- Que las contraseñas no lleguen a los registros del servidor: CREATE/ALTER ROLE ... PASSWORD
-- saldrían en claro con log_statement o log_min_duration_statement, y también si la sentencia
-- falla (log_min_error_statement registra el texto de la sentencia que dio error). Solo vale para
-- esta sesión.
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = 'panic';

-- ─── Roles (sin superusuario, sin crear bases ni roles) ─────────────────────
SELECT format('CREATE ROLE villa_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'owner_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'villa_owner') \gexec
SELECT format('CREATE ROLE villa_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'villa_app') \gexec
SELECT format('ALTER ROLE villa_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'owner_password') \gexec
SELECT format('ALTER ROLE villa_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_password') \gexec
SELECT format('CREATE ROLE villa_queue LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'queue_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'villa_queue') \gexec
SELECT format('ALTER ROLE villa_queue WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'queue_password') \gexec
-- Ninguno puede hacerse pasar por otro.
REVOKE villa_owner FROM villa_app;
REVOKE villa_app FROM villa_owner;
REVOKE villa_queue FROM villa_app;
REVOKE villa_app FROM villa_queue;
REVOKE villa_owner FROM villa_queue;
REVOKE villa_queue FROM villa_owner;
ALTER ROLE villa_app SET search_path = public;
ALTER ROLE villa_owner SET search_path = public;
ALTER ROLE villa_queue SET search_path = pgboss;

-- ─── Base de datos ──────────────────────────────────────────────────────────
SELECT format('CREATE DATABASE %I OWNER villa_owner', :'db')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO villa_owner', :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO villa_app', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO villa_queue', :'db') \gexec
-- villa_owner crea el esquema "drizzle" (bitácora de migraciones); villa_app NO crea esquemas.
SELECT format('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO villa_owner', :'db') \gexec

\connect :db

-- Instalación anterior con un solo rol ("villa"): todo lo suyo pasa a villa_owner.
SELECT 'REASSIGN OWNED BY villa TO villa_owner'
  WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'villa') \gexec

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER SCHEMA public OWNER TO villa_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO villa_app;

-- ─── Cola del worker (pg-boss) ──────────────────────────────────────────────
-- Esquema aparte, de villa_queue: pg-boss crea ahí sus tablas y particiones. No toca public, y la
-- app (villa_app) no tiene ni USAGE ni CREATE en él. Si viene de una instalación donde era de
-- villa_app, todo lo suyo pasa a villa_queue.
DO $$
DECLARE
  r record;
BEGIN
  IF to_regnamespace('pgboss') IS NULL THEN
    EXECUTE 'CREATE SCHEMA pgboss AUTHORIZATION villa_queue';
  ELSE
    EXECUTE 'ALTER SCHEMA pgboss OWNER TO villa_queue';
    FOR r IN
      SELECT c.relname, c.relkind
        FROM pg_class c
       WHERE c.relnamespace = 'pgboss'::regnamespace
         AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
         -- TODAS las relaciones, también las tablas particionadas y cada partición (pgboss.job y
         -- job_*: ALTER TABLE del padre no baja a las particiones). Solo se saltan las secuencias
         -- de una columna identity/serial: cambian de dueño con su tabla (y no se pueden cambiar
         -- solas).
         AND NOT (c.relkind = 'S' AND EXISTS (
               SELECT 1 FROM pg_depend d
                WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                  AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')))
    LOOP
      EXECUTE format('ALTER %s pgboss.%I OWNER TO villa_queue',
        CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, r.relname);
    END LOOP;
    FOR r IN SELECT p.oid::regprocedure AS sig, p.prokind FROM pg_proc p WHERE p.pronamespace = 'pgboss'::regnamespace LOOP
      EXECUTE format('ALTER %s %s OWNER TO villa_queue', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.sig);
    END LOOP;
    FOR r IN
      SELECT t.typname FROM pg_type t
       WHERE t.typnamespace = 'pgboss'::regnamespace AND t.typtype IN ('e', 'd')
    LOOP
      EXECUTE format('ALTER TYPE pgboss.%I OWNER TO villa_queue', r.typname);
    END LOOP;
  END IF;
  EXECUTE 'REVOKE ALL ON SCHEMA pgboss FROM PUBLIC, villa_app';
  -- villa_app no crea objetos en NINGÚN esquema (ni funciones "sombra" para las garantías).
  FOR r IN
    SELECT n.nspname FROM pg_namespace n
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%'
  LOOP
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM villa_app', r.nspname);
  END LOOP;
  -- villa_queue no toca public.
  EXECUTE 'REVOKE ALL ON SCHEMA public FROM villa_queue';
END;
$$;

-- ─── Permisos de la app ─────────────────────────────────────────────────────
-- Si la base ya tiene la migración 0009, se aplican ya; si no, los aplica `npm run db:migrate`.
SELECT to_regprocedure('public.app_apply_grants()') IS NOT NULL AS has_grants \gset
\if :has_grants
  SET ROLE villa_owner;
  SELECT app_apply_grants();
  RESET ROLE;
\endif

-- ─── Verificación ───────────────────────────────────────────────────────────
-- Debe decir f en todo (villa_app no edita, no borra ni vacía el libro).
SELECT has_table_privilege('villa_app', 'journal_entries', 'UPDATE')   AS app_update_libro,
       has_table_privilege('villa_app', 'journal_entries', 'DELETE')   AS app_delete_libro,
       has_table_privilege('villa_app', 'journal_lines', 'TRUNCATE')   AS app_truncate_libro,
       has_schema_privilege('villa_app', 'public', 'CREATE')           AS app_ddl_public,
       has_schema_privilege('villa_app', 'pgboss', 'CREATE')           AS app_ddl_pgboss,
       has_schema_privilege('villa_app', 'pgboss', 'USAGE')            AS app_usa_pgboss,
       has_schema_privilege('villa_queue', 'public', 'USAGE')          AS cola_usa_public,
       has_database_privilege('villa_app', current_database(), 'TEMPORARY') AS app_temporales
 WHERE to_regclass('public.journal_entries') IS NOT NULL;

-- La cola (pg-boss) corre con villa_queue (QUEUE_DATABASE_URL); los trabajos del worker que tocan
-- datos (src/worker/jobs/*) siguen con villa_app (DATABASE_URL).
--
-- Cuando la app y el worker ya anden con villa_app (y las migraciones con villa_owner), el rol
-- viejo se puede retirar:   DROP ROLE villa;   (si dice que aún es dueño de algo: REASSIGN OWNED BY
-- villa TO villa_owner; DROP OWNED BY villa; en cada base donde tenga objetos).
