-- Separación de roles de Postgres para Villa (docs/arquitectura.md, "Seguridad").
--
--   villa_owner  dueño de la base y del esquema; SOLO corre las migraciones (MIGRATION_DATABASE_URL).
--   villa_app    la app web y el worker (DATABASE_URL). No es dueño de ninguna tabla de public:
--                no puede desactivar ni borrar triggers, ni cambiar el esquema, ni hacer UPDATE,
--                DELETE o TRUNCATE sobre el libro y las tablas solo-inserción. Los permisos exactos
--                los pone la función app_apply_grants() de la migración 0009.
--
-- Se corre UNA vez en el VPS, como superusuario, y se puede repetir sin daño:
--
--   sudo -u postgres psql -f src/db/roles/setup-roles.sql
--
-- Pide las dos contraseñas (no quedan en el historial de la terminal). Si ya existe el rol de
-- antes ("villa", el del README), le pasa todo lo suyo a villa_owner; ese rol se borra a mano
-- cuando la app ya ande con villa_app (ver el final).
--
-- Después:
--   1. En .env:  MIGRATION_DATABASE_URL=postgres://villa_owner:<clave>@localhost:5432/villa
--                DATABASE_URL=postgres://villa_app:<clave>@localhost:5432/villa
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

-- ─── Roles (sin superusuario, sin crear bases ni roles) ─────────────────────
SELECT format('CREATE ROLE villa_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'owner_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'villa_owner') \gexec
SELECT format('CREATE ROLE villa_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'villa_app') \gexec
SELECT format('ALTER ROLE villa_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'owner_password') \gexec
SELECT format('ALTER ROLE villa_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_password') \gexec
-- Ninguno puede hacerse pasar por el otro.
REVOKE villa_owner FROM villa_app;
REVOKE villa_app FROM villa_owner;
ALTER ROLE villa_app SET search_path = public;
ALTER ROLE villa_owner SET search_path = public;

-- ─── Base de datos ──────────────────────────────────────────────────────────
SELECT format('CREATE DATABASE %I OWNER villa_owner', :'db')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO villa_owner', :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO villa_app', :'db') \gexec
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
-- Esquema aparte, de villa_app: pg-boss crea ahí sus tablas y particiones. No toca public.
DO $$
DECLARE
  r record;
BEGIN
  IF to_regnamespace('pgboss') IS NULL THEN
    EXECUTE 'CREATE SCHEMA pgboss AUTHORIZATION villa_app';
    RETURN;
  END IF;
  EXECUTE 'ALTER SCHEMA pgboss OWNER TO villa_app';
  FOR r IN
    SELECT c.relname, c.relkind
      FROM pg_class c
     WHERE c.relnamespace = 'pgboss'::regnamespace
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       -- Las secuencias de columnas identity/serial cambian de dueño con su tabla.
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i'))
  LOOP
    EXECUTE format('ALTER %s pgboss.%I OWNER TO villa_app',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, r.relname);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig, p.prokind FROM pg_proc p WHERE p.pronamespace = 'pgboss'::regnamespace LOOP
    EXECUTE format('ALTER %s %s OWNER TO villa_app', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.sig);
  END LOOP;
  FOR r IN
    SELECT t.typname FROM pg_type t
     WHERE t.typnamespace = 'pgboss'::regnamespace AND t.typtype IN ('e', 'd')
  LOOP
    EXECUTE format('ALTER TYPE pgboss.%I OWNER TO villa_app', r.typname);
  END LOOP;
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
       has_schema_privilege('villa_app', 'public', 'CREATE')           AS app_ddl_public
 WHERE to_regclass('public.journal_entries') IS NOT NULL;

-- Cuando la app y el worker ya anden con villa_app (y las migraciones con villa_owner), el rol
-- viejo se puede retirar:   DROP ROLE villa;   (si dice que aún es dueño de algo: REASSIGN OWNED BY
-- villa TO villa_owner; DROP OWNED BY villa; en cada base donde tenga objetos).
