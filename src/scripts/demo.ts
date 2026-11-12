// Base de la demo para presentarle el sistema al dueño (docs/demo.md). Un PostgreSQL aparte, solo
// en este computador (.demo/, ignorado por git), para no mezclar la demo con la base de desarrollo.
//
//   npm run demo:setup   rehace la base de la demo: migraciones, sede, catálogo, equipo y un mes de historia
//   npm run demo:owner   crea la cuenta del dueño en la base de la demo (la crea quien la va a usar)
//   npm run demo         arranca la app contra la base de la demo (http://localhost:3000)
//   npm run demo:stop    apaga el PostgreSQL de la demo
//
// El clúster escucha solo en localhost:55433 y confía en los usuarios de este computador (trust):
// es una demo local, sin datos reales. No sirve para producción ni para el ambiente de pruebas.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(process.cwd(), ".demo");
const PGDATA = resolve(DIR, "pgdata");
const PORT = "55433";
const USER = "villa_demo";
const DB = "villa_demo";
const URL = `postgres://${USER}@localhost:${PORT}/${DB}`;

/** Variables para todo lo que corre contra la demo: la base de desarrollo nunca se toca. */
const demoEnv = { ...process.env, DATABASE_URL: URL, MIGRATION_DATABASE_URL: URL, QUEUE_DATABASE_URL: URL, DEMO_DATABASE_URL: URL };

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; allowFail?: boolean; quiet?: boolean } = {}): number {
  const r = spawnSync(cmd, args, { stdio: opts.quiet ? "ignore" : "inherit", env: opts.env ?? process.env, shell: process.platform === "win32" });
  const code = r.status ?? 1;
  if (code !== 0 && !opts.allowFail) {
    console.error(`Falló: ${cmd} ${args.join(" ")}`);
    process.exit(code);
  }
  return code;
}

function startCluster() {
  if (!existsSync(PGDATA)) {
    mkdirSync(DIR, { recursive: true });
    console.log("Creando el PostgreSQL de la demo en .demo/ …");
    run("initdb", ["-D", PGDATA, "-U", USER, "--auth=trust", "-E", "UTF8", "--locale-provider=icu", "--icu-locale=es-CO", "--locale=C"]);
  }
  if (run("pg_ctl", ["status", "-D", PGDATA], { allowFail: true, quiet: true }) !== 0) {
    run("pg_ctl", ["start", "-D", PGDATA, "-w", "-l", resolve(DIR, "postgres.log"), "-o", `"-p ${PORT} -c listen_addresses=localhost"`]);
  }
}

function setup() {
  startCluster();
  console.log("Rehaciendo la base de la demo …");
  run("dropdb", ["-h", "localhost", "-p", PORT, "-U", USER, "--if-exists", "--force", DB]);
  run("createdb", ["-h", "localhost", "-p", PORT, "-U", USER, DB]);
  // El rol de la app como en el servidor, pero sin poder entrar: las migraciones le aplican sus
  // permisos (app_apply_grants) y la prueba de cordura revisa que no pueda editar el libro.
  run("psql", ["-h", "localhost", "-p", PORT, "-U", USER, "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "-c",
    `"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'villa_app') THEN CREATE ROLE villa_app NOLOGIN; END IF; END $$"`,
    // La misma postura de src/db/roles/setup-roles.sql sobre la base y el esquema public.
    "-c", `"REVOKE ALL ON DATABASE ${DB} FROM PUBLIC; GRANT CONNECT ON DATABASE ${DB} TO villa_app; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO villa_app"`]);
  run("npx", ["drizzle-kit", "migrate"], { env: demoEnv });
  run("npx", ["tsx", "--env-file-if-exists=.env", "src/db/seed.ts"], { env: demoEnv });
  run("npx", ["tsx", "--env-file-if-exists=.env", "src/db/seed-demo.ts"], { env: demoEnv });
  run("npx", ["tsx", "--env-file-if-exists=.env", "src/scripts/demo-history.ts"], { env: demoEnv });
  console.log("Prueba de cordura del libro (la misma de los respaldos) …");
  run("psql", ["-h", "localhost", "-p", PORT, "-U", USER, "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "-f", "deploy/backup/sanity.sql"]);
  console.log("\nListo. Sigue: npm run demo:owner (una vez por base nueva) y luego npm run demo.");
}

const command = process.argv[2];
switch (command) {
  case "setup":
    setup();
    break;
  case "owner":
    startCluster();
    run("npx", ["tsx", "--env-file-if-exists=.env", "src/scripts/create-owner.ts"], { env: demoEnv });
    break;
  case "start":
    startCluster();
    console.log("App de la demo en http://localhost:3000 (detén antes el servidor de desarrollo normal).");
    run("npx", ["next", "dev"], { env: demoEnv });
    break;
  case "stop":
    if (existsSync(PGDATA)) run("pg_ctl", ["stop", "-D", PGDATA, "-m", "fast"], { allowFail: true });
    break;
  default:
    console.error("Uso: tsx src/scripts/demo.ts setup | owner | start | stop");
    process.exit(1);
}
