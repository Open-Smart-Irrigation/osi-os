# OSI Odoo test environment implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, test, and deploy a secured Odoo 19 Community environment for OSI business operations and project delivery at `https://odoo.opensmartirrigation.org`.

**Architecture:** A new `/home/phil/Repos/osi-odoo` repository owns Docker Compose, two OSI add-ons, tests, and operator scripts. The test VPS runs a dedicated Odoo/PostgreSQL pair behind its existing Caddy proxy; it shares no data or database with `osi-server`.

**Tech Stack:** Odoo Community 19.0, PostgreSQL 16, Python/Odoo ORM, XML data, Docker Compose, Bash, Caddy 2.

**Spec:** `docs/superpowers/specs/2026-08-21-odoo-test-environment-design.md`

## Global constraints

- Work in `/home/phil/Repos/osi-odoo`; do not add Odoo runtime files to `osi-os` or `osi-server`.
- Use `odoo:19.0-20260817` and `postgres:16-alpine`; never use `latest`.
- Keep `osi-server`, its PostgreSQL volume, MQTT, Jenkins, and `osicloud.ch` out of scope.
- Disable upstream Odoo demo data. `osi_business_demo` may create marked business records but no users or passwords.
- Keep PostgreSQL private. Only Odoo joins `caddy-net`, and no Odoo or PostgreSQL host port is published.
- Put generated credentials only in mode-`0600` ignored files. Never print them.
- Run the task's tests, review its diff against this plan and the spec, and commit before starting the next task.
- After each task, a fresh reviewer checks spec compliance and a fresh verifier reruns the listed commands.
- Stop before public-route verification if `odoo.opensmartirrigation.org` still has no DNS record.

## File map

| Path | Responsibility |
|---|---|
| `compose.yaml` | Odoo/PostgreSQL services, resource limits, health checks, networks, and volumes |
| `.env.example` | Non-secret variable contract |
| `config/odoo.conf.template` | Runtime settings with an `@ADMIN_PASSWD@` render token |
| `postgres-init/10-create-odoo-role.sh` | Create the fixed database and restricted application role |
| `scripts/lib.sh` | Shared path, environment, Compose, and confirmation helpers |
| `scripts/render-config` | Render the ignored runtime Odoo configuration without logging secrets |
| `scripts/init-database` | One-shot database and module initialization |
| `scripts/update-modules` | Back up, upgrade OSI modules, and restart Odoo |
| `scripts/backup` | Atomic paired PostgreSQL/filestore backup with checksums and retention |
| `scripts/restore` | Confirmed paired restore and post-restore health check |
| `scripts/deploy-test` | Preflight, transfer, remote startup, Caddy validation, and smoke checks |
| `addons/osi_business_setup` | Company, catalog, and project-management configuration |
| `addons/osi_business_demo` | Removable OSI demonstration records |
| `tests/test_static.py` | Static contract tests that run before containers |
| `tests/test_setup.py` | Odoo `TransactionCase` tests for configured business records |
| `tests/test_demo.py` | Odoo `TransactionCase` tests for demonstration data |
| `tests/test_operational.sh` | Ephemeral initialization, idempotence, backup, and restore checks |
| `README.md` | Local use and test-VPS operating instructions |

---

### Task 1: Repository and Compose contract

**Files:**
- Create: `/home/phil/Repos/osi-odoo/.gitignore`
- Create: `/home/phil/Repos/osi-odoo/.env.example`
- Create: `/home/phil/Repos/osi-odoo/compose.yaml`
- Create: `/home/phil/Repos/osi-odoo/config/odoo.conf.template`
- Create: `/home/phil/Repos/osi-odoo/tests/test_static.py`
- Create: `/home/phil/Repos/osi-odoo/tests/fixtures/test.env`

**Interfaces:**
- Produces: Compose services `odoo` and `db`; networks `odoo-internal` and external `caddy-net`; volumes `odoo_data` and `odoo_db`.
- Produces: variables `POSTGRES_BOOTSTRAP_PASSWORD`, `ODOO_DB_NAME`, `ODOO_DB_USER`, `ODOO_DB_PASSWORD`, `ODOO_MASTER_PASSWORD`, `ODOO_ADMIN_LOGIN`, and `ODOO_ADMIN_PASSWORD`.

- [ ] **Step 1: Initialize the empty repository and write the failing static contract test**

Create the directory, run `git init -b main`, and add `tests/test_static.py`. The test loads `compose.yaml` as text and asserts the dated Odoo tag, PostgreSQL 16 tag, no `ports:` key, the external `caddy-net`, internal database network, both memory limits, `restart: unless-stopped`, exact database filter, disabled database list, proxy mode, and the absence of literal passwords. It also asserts `.env`, `runtime/`, `backups/`, and generated archives are ignored.

- [ ] **Step 2: Run the test and observe the expected failure**

Run: `python3 -m unittest -v tests.test_static`

Expected: FAIL because `compose.yaml` and `.gitignore` do not exist.

- [ ] **Step 3: Add the minimal Compose and configuration files**

`compose.yaml` must define:

```yaml
name: osi-odoo
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: postgres
      POSTGRES_USER: odoo_owner
      POSTGRES_PASSWORD: ${POSTGRES_BOOTSTRAP_PASSWORD:?set POSTGRES_BOOTSTRAP_PASSWORD}
      ODOO_DB_NAME: ${ODOO_DB_NAME:-osi_odoo_test}
      ODOO_DB_USER: ${ODOO_DB_USER:-odoo_app}
      ODOO_DB_PASSWORD: ${ODOO_DB_PASSWORD:?set ODOO_DB_PASSWORD}
    volumes:
      - odoo_db:/var/lib/postgresql/data
      - ./postgres-init:/docker-entrypoint-initdb.d:ro
    networks: [odoo-internal]
    healthcheck:
      test: [CMD-SHELL, "pg_isready -U odoo_owner -d postgres"]
      interval: 10s
      timeout: 5s
      retries: 12
    mem_limit: 1g
    cpus: 1.0
  odoo:
    image: odoo:19.0-20260817
    container_name: osi-odoo
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      HOST: db
      PORT: 5432
      USER: ${ODOO_DB_USER:-odoo_app}
      PASSWORD: ${ODOO_DB_PASSWORD:?set ODOO_DB_PASSWORD}
    volumes:
      - odoo_data:/var/lib/odoo
      - ./addons:/mnt/extra-addons:ro
      - ./runtime/odoo.conf:/etc/odoo/odoo.conf:ro
    networks: [odoo-internal, caddy-net]
    healthcheck:
      test: [CMD-SHELL, "python3 -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8069/web/login', timeout=5)\""]
      interval: 15s
      timeout: 8s
      retries: 20
      start_period: 60s
    mem_limit: 2g
    cpus: 2.0
networks:
  odoo-internal:
    internal: true
  caddy-net:
    external: true
volumes:
  odoo_data:
  odoo_db:
```

`config/odoo.conf.template` must set `/mnt/extra-addons`, `/var/lib/odoo`, `admin_passwd = @ADMIN_PASSWD@`, `db_name = osi_odoo_test`, `dbfilter = ^osi_odoo_test$`, `list_db = False`, `proxy_mode = True`, `workers = 2`, `max_cron_threads = 1`, `gevent_port = 8072`, `limit_memory_soft = 536870912`, `limit_memory_hard = 671088640`, `limit_request = 8192`, `limit_time_cpu = 120`, and `limit_time_real = 240`.

- [ ] **Step 4: Validate static and Compose syntax**

Run:

```bash
python3 -m unittest -v tests.test_static
docker compose --env-file tests/fixtures/test.env config --quiet
git diff --check
```

Expected: unit tests PASS, Compose exits 0, and `git diff --check` has no output.

- [ ] **Step 5: Review, verify, and commit**

Review for published ports, floating images, secret literals, missing limits, or accidental coupling to existing OSI containers. Re-run Step 4 from a fresh shell.

Commit: `chore: scaffold Odoo Compose environment`

### Task 2: Secure rendering and database bootstrap

**Files:**
- Create: `scripts/lib.sh`
- Create: `scripts/render-config`
- Create: `scripts/init-database`
- Create: `postgres-init/10-create-odoo-role.sh`
- Modify: `tests/test_static.py`
- Create: `tests/test_bootstrap.sh`

**Interfaces:**
- Produces: `load_env()`, `compose()`, `require_command()`, and `confirm_exact()` in `scripts/lib.sh`.
- Produces: ignored `runtime/odoo.conf` with mode `0600`.
- Produces: database `osi_odoo_test`, owner `odoo_owner`, and login role `odoo_app NOSUPERUSER NOCREATEDB NOCREATEROLE`.

- [ ] **Step 1: Add failing shell tests**

`tests/test_bootstrap.sh` must copy the repository to a temporary directory, create a test `.env`, run `scripts/render-config`, assert mode `600`, assert the master password appears in the rendered file and not in tracked files, then run `shellcheck` on all scripts when `shellcheck` is available. It must also assert the PostgreSQL initializer contains `set -eu`, `psql -v ON_ERROR_STOP=1`, quoted `psql` variables, `NOSUPERUSER`, `NOCREATEDB`, and `NOCREATEROLE`.

- [ ] **Step 2: Run the tests and observe failure**

Run: `bash tests/test_bootstrap.sh`

Expected: FAIL because the scripts do not exist.

- [ ] **Step 3: Implement shared helpers and config rendering**

`load_env()` resolves the repository root from the script path, refuses a missing or group/world-readable `.env`, exports only variables declared there, and never enables shell tracing. `render-config` validates all seven required variables, rejects newlines and `/` in the master password, replaces only `@ADMIN_PASSWD@` using a safe Python one-liner, writes through `mktemp`, installs the result as `runtime/odoo.conf` with mode `0600`, and removes the temporary file on exit.

- [ ] **Step 4: Implement restricted PostgreSQL initialization**

`10-create-odoo-role.sh` must use the entrypoint-provided owner connection and `psql` variables. It creates or alters `odoo_app` with `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password'`, creates `osi_odoo_test` owned by `odoo_owner` when absent, revokes public database create rights, connects to the target database, grants `CONNECT`, `TEMPORARY`, and `USAGE, CREATE` on schema `public`, and changes schema ownership to `odoo_app`. SQL identifiers are validated against `^[a-z][a-z0-9_]*$` before use.

- [ ] **Step 5: Implement one-shot initialization**

`scripts/init-database` renders config, starts only `db`, waits for its health check, verifies the target database has no installed `osi_business_setup`, then runs:

```bash
docker compose run --rm --no-deps \
  -e OSI_ODOO_ADMIN_LOGIN -e OSI_ODOO_ADMIN_PASSWORD \
  odoo odoo --config=/etc/odoo/odoo.conf \
  --without-demo=all --stop-after-init \
  -i osi_business_setup,osi_business_demo
```

It refuses to initialize when either OSI module is already installed and never prints the environment.

- [ ] **Step 6: Verify and commit**

Run:

```bash
bash tests/test_bootstrap.sh
python3 -m unittest -v tests.test_static
docker compose --env-file tests/fixtures/test.env config --quiet
git diff --check
```

Expected: all checks PASS.

Commit: `feat: add secure Odoo bootstrap`

### Task 3: OSI company, catalog, and application setup

**Files:**
- Create: `addons/osi_business_setup/__init__.py`
- Create: `addons/osi_business_setup/__manifest__.py`
- Create: `addons/osi_business_setup/hooks.py`
- Create: `addons/osi_business_setup/data/business_data.xml`
- Create: `addons/osi_business_setup/tests/__init__.py`
- Create: `addons/osi_business_setup/tests/test_setup.py`

**Interfaces:**
- Produces XML IDs `osi_business_setup.product_*`, `service_*`, and `warehouse_osi`.
- Produces `post_init_hook(env)` that configures company and administrator facts idempotently.

- [ ] **Step 1: Write failing Odoo tests**

Use `TransactionCase` tagged `post_install` and `-at_install`. Assert the main company name, CH country, CHF currency, administrator time zone, installed dependency set, warehouse name, seven exact hardware references, `is_storable=True`, `tracking='serial'`, and four service products. Assert the install and commissioning service has `type='service'`, `service_tracking='project_only'`, `service_policy='ordered_prepaid'`, and a project template after Task 4.

- [ ] **Step 2: Run the isolated module test and observe failure**

Run the official image against the ephemeral database with:

```bash
docker compose run --rm odoo odoo --config=/etc/odoo/odoo.conf \
  --without-demo=all --stop-after-init -i osi_business_setup \
  --test-enable --test-tags /osi_business_setup
```

Expected: FAIL because the module or asserted records are absent.

- [ ] **Step 3: Add the manifest and hook**

The manifest must be installable, LGPL-3, version `19.0.1.0.0`, and depend on `contacts`, `crm`, `sale_management`, `purchase`, `stock`, `account`, `project`, `hr`, `hr_expense`, `repair`, `maintenance`, `calendar`, `hr_timesheet`, `sale_project`, `sale_timesheet`, and `l10n_ch`. `post_init_hook(env)` must require `OSI_ODOO_ADMIN_LOGIN` and `OSI_ODOO_ADMIN_PASSWORD`, rename the built-in administrator, set its password and `Europe/Zurich` time zone, and set the main company to Open Smart Irrigation, Switzerland, and CHF without inventing address, VAT, banking, registration, or tax values.

- [ ] **Step 4: Add warehouse and products**

`business_data.xml` must create `OSI Warehouse`; seven goods with references `OSI-GATEWAY`, `OSI-KIWI`, `OSI-CLOVER`, `OSI-LSN50`, `OSI-S2120`, `OSI-LORAIN`, and `OSI-STREGA`; and four service products for site assessment, installation and commissioning, operator training, and maintenance and support. Hardware uses `is_storable=True` and `tracking='serial'`. All data uses stable XML IDs and `noupdate="1"` only for values operators should own after installation.

- [ ] **Step 5: Verify idempotence and commit**

Run the module test command twice, using `-i` on the first run and `-u osi_business_setup` on the second. Query counts by each internal reference and XML ID; every count remains one.

Commit: `feat: configure OSI company and catalog`

### Task 4: Project-management templates and sales linkage

**Files:**
- Create: `addons/osi_business_setup/data/project_data.xml`
- Modify: `addons/osi_business_setup/__manifest__.py`
- Create: `addons/osi_business_setup/tests/test_projects.py`

**Interfaces:**
- Produces six shared `project.task.type` stages, eight `project.tags`, five template `project.project` records, four deployment milestones, and nine ordered deployment tasks.
- Links `service_installation` to `project_template_customer_deployment` through `project_template_id`.

- [ ] **Step 1: Write failing project tests**

Assert exactly these stages in sequence: Backlog 10, Ready 20, In Progress 30, Field Validation 40, Blocked 50, Done 60 with Done folded. Assert tags Hardware, Firmware, Edge OS, Cloud, Agronomy, Deployment, Training, and Support. Assert five projects with `is_template=True`, `allow_task_dependencies=True`, `allow_milestones=True`, `allow_recurring_tasks=True`, and `allow_timesheets=True`.

For the customer deployment template, assert the nine task names from the spec, their `allocated_hours` values `[2, 6, 4, 3, 4, 8, 4, 3, 2]`, linear `depend_on_ids`, and milestone assignments. Assert the installation service points at the template and creates a project when a sales order containing it is confirmed.

- [ ] **Step 2: Run the project tests and observe failure**

Run the Task 3 Odoo command with `--test-tags /osi_business_setup:TestOsiProjects`.

Expected: FAIL because stages, templates, and tasks do not exist.

- [ ] **Step 3: Add stages, tags, and templates**

Create the six shared stages and attach them to all five templates. Customer-facing templates use `privacy_visibility='invited_users'`; research/grant uses `privacy_visibility='followers'`. Enable dependencies, milestones, recurrence, and timesheets. Create the four milestones and nine tasks with stable XML IDs, `is_template=True`, assigned stage, tags, allocated hours, dependency commands, and milestone references.

- [ ] **Step 4: Configure the sales-to-project flow**

Set installation and commissioning to `type='service'`, `service_tracking='project_only'`, `service_policy='ordered_prepaid'`, and `project_template_id` equal to the customer deployment template. The test confirms an order and asserts one non-template project linked to the order, copied tasks, copied dependencies, and copied milestones.

- [ ] **Step 5: Verify and commit**

Run all `osi_business_setup` tests, upgrade the module, and run them again. Expected: PASS with no duplicate stages, tags, templates, tasks, or milestones.

Commit: `feat: add OSI project delivery templates`

### Task 5: Removable OSI demonstration workflow

**Files:**
- Create: `addons/osi_business_demo/__init__.py`
- Create: `addons/osi_business_demo/__manifest__.py`
- Create: `addons/osi_business_demo/hooks.py`
- Create: `addons/osi_business_demo/tests/__init__.py`
- Create: `addons/osi_business_demo/tests/test_demo.py`

**Interfaces:**
- Consumes: setup XML IDs for products and the customer deployment template.
- Produces: `DEMO` customer, supplier, opportunity, quotation, confirmed order, completed delivery, draft invoice, and generated deployment project with explicit `ir.model.data` ownership.

- [ ] **Step 1: Write failing demo tests**

Assert no users are created by the module. Assert customer `DEMO Farm Zürich`, supplier `DEMO Sensor Supplier AG`, one CRM opportunity, one draft quotation, one confirmed sale, a completed picking with serials prefixed `DEMO-`, one draft invoice, and one generated non-template project. Every record name or reference must contain `DEMO`.

- [ ] **Step 2: Run and observe failure**

Install the setup module, then run `-i osi_business_demo --test-enable --test-tags /osi_business_demo`.

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement the post-init workflow**

The LGPL-3 module depends only on `osi_business_setup`. Its `post_init_hook(env)` creates records through normal ORM methods, confirms the demonstration sale, assigns unique serials to reserved move lines, validates the picking, creates but does not post the invoice, and registers every created record under the `osi_business_demo` namespace in `ir.model.data`. It uses a `DEMO` reference search to return existing records on a repeated hook call.

- [ ] **Step 4: Verify install, upgrade, and uninstall**

Run demo tests, upgrade the module, and rerun. Then uninstall `osi_business_demo` through an Odoo shell invocation and assert all its external IDs and marked partners/orders/projects are gone while `osi_business_setup` products and templates remain.

- [ ] **Step 5: Commit**

Commit: `feat: add removable OSI business demo`

### Task 6: Backup, restore, update, and operational test harness

**Files:**
- Create: `scripts/backup`
- Create: `scripts/restore`
- Create: `scripts/update-modules`
- Create: `tests/test_operational.sh`
- Modify: `scripts/lib.sh`

**Interfaces:**
- Produces backup set `<UTC timestamp>/database.dump`, `filestore.tar.gz`, and `manifest.sha256`.
- Produces `wait_healthy SERVICE TIMEOUT_SECONDS` and exact confirmation phrase `restore <timestamp>`.

- [ ] **Step 1: Write the failing operational test**

The test creates an isolated Compose project name and temporary volume names, creates `caddy-net` only when absent, initializes the database, runs all add-on tests, upgrades both modules, asserts idempotent counts, creates a backup, restores into disposable volumes, reruns seed assertions, and tears down only its uniquely named containers and volumes.

- [ ] **Step 2: Run and observe failure**

Run: `bash tests/test_operational.sh`

Expected: FAIL because backup, restore, and update scripts are absent.

- [ ] **Step 3: Implement atomic backup**

`scripts/backup` creates a mode-`0700` temporary set, runs `pg_dump --format=custom` inside the database container without echoing credentials, archives `/var/lib/odoo/filestore/osi_odoo_test`, writes SHA-256 checksums plus image references, then atomically renames the set. It retains the newest 14 complete timestamp directories and ignores incomplete temporary paths.

- [ ] **Step 4: Implement confirmed paired restore**

`scripts/restore <absolute-backup-directory>` rejects relative, missing, checksum-invalid, or incomplete sets. It requires typed confirmation, stops Odoo, terminates target database sessions, recreates the target through the bootstrap owner, restores the dump, replaces only the matching filestore directory, fixes container ownership, starts Odoo, and waits for health. A `--yes-for-test` flag is accepted only when `OSI_ALLOW_TEST_RESTORE=1`.

- [ ] **Step 5: Implement guarded module update**

`scripts/update-modules` runs backup first, stops Odoo, executes `-u osi_business_setup,osi_business_demo --stop-after-init`, restarts Odoo, and waits for health. Any failed upgrade leaves Odoo stopped and prints the backup path without attempting an unsafe schema rollback.

- [ ] **Step 6: Verify and commit**

Run `bash tests/test_operational.sh`, `python3 -m unittest -v tests.test_static`, all module tests, and `git diff --check`.

Commit: `feat: add Odoo backup and recovery tooling`

### Task 7: Operator documentation and deploy script

**Files:**
- Create: `README.md`
- Create: `scripts/deploy-test`
- Create: `tests/test_deploy_static.py`

**Interfaces:**
- Produces remote release directory `/home/rocky/docker/osi-odoo` and backups under `/home/rocky/backups/osi-odoo`.
- Produces Caddy route for `odoo.opensmartirrigation.org` with `/websocket*` to `osi-odoo:8072` and other traffic to `osi-odoo:8069`.

- [ ] **Step 1: Write failing deploy-script tests**

Assert the script hardcodes `server.opensmartirrigation.org`, rejects `osicloud.ch`, checks DNS equality with the test hostname, records pre-deploy containers, backs up any prior release and Caddyfile, transfers via `rsync --delete` with explicit excludes, validates Compose remotely, validates Caddy before reload, never uses `docker compose down -v`, and reruns existing route checks after deployment.

- [ ] **Step 2: Run and observe failure**

Run: `python3 -m unittest -v tests.test_deploy_static`

Expected: FAIL because the deploy script and README do not exist.

- [ ] **Step 3: Implement deployment orchestration**

The script performs local tests first, refuses a dirty `osi-odoo` tree, checks remote capacity and Docker, requires DNS for `odoo.opensmartirrigation.org` to match `server.opensmartirrigation.org`, creates a timestamped remote backup, transfers tracked files only, creates or preserves remote `.env`, renders config, initializes on first deploy or updates on later deploys, starts services, amends and validates Caddy through a temporary file, installs the file only after validation, reloads Caddy, and runs the acceptance checks. It does not print secrets or restart unrelated containers.

- [ ] **Step 4: Write operator documentation**

Document local prerequisites, initial secret generation, local initialization, login, test commands, update flow, backup/restore, removal of the demo module, DNS prerequisite, test deployment, resource limits, and explicit non-goals. State that legal identity, VAT, bank, tax, and invoice settings require human validation before real invoicing.

- [ ] **Step 5: Verify and commit**

Run static, bootstrap, deploy, and operational tests. Run the repo anti-slop checker on `README.md` if available from the sibling `osi-os` checkout.

Commit: `docs: add Odoo operations and test deploy workflow`

### Task 8: Test-VPS deployment and acceptance

**Files:**
- Modify remotely: `/home/rocky/caddy/Caddyfile`
- Create remotely: `/home/rocky/docker/osi-odoo/`
- Create remotely: `/home/rocky/backups/osi-odoo/`

**Interfaces:**
- Consumes: clean committed `osi-odoo` repository and a resolving DNS record.
- Produces: healthy HTTPS Odoo environment at `odoo.opensmartirrigation.org`.

- [ ] **Step 1: Record and review pre-deploy evidence**

Capture hostname, architecture, memory, disk, Docker versions, running container names/images/ports, current Caddy validation, DNS A records, and HTTP status for existing server, MQTT upgrade endpoint, and Jenkins. Do not inspect environment variables or secrets.

- [ ] **Step 2: Run the guarded deploy**

Run: `scripts/deploy-test`

Expected: exit 0; it reports the remote backup directory, healthy `osi-odoo` and database containers, successful Caddy reload, and HTTPS login status 200. If DNS is absent or divergent, stop here with no Caddy change.

- [ ] **Step 3: Verify security boundaries**

On the test VPS, verify no published port for either Odoo service; only `osi-odoo` joins `caddy-net`; the Odoo database role returns false for superuser, createdb, createrole, and replication; database manager routes are unavailable; `.env` and runtime config modes are `600`; backups directory mode is `700`.

- [ ] **Step 4: Verify business and project behavior**

Run Odoo test tags against the deployed database using `--stop-after-init`, then inspect through the web UI: Swiss/CHF company, installed apps, warehouse, seven serialized products, four services, six stages, eight tags, five templates, dependencies, milestones, allocated hours, marked demo workflow, and sales-order project creation.

- [ ] **Step 5: Rehearse recovery**

Create a backup, validate checksums, restore it into disposable database and filestore targets, run seed assertions there, and remove only those disposable targets after success.

- [ ] **Step 6: Verify existing services and record deployment evidence**

Compare container inventory and route results with Step 1. Confirm `server.opensmartirrigation.org`, MQTT, and Jenkins still behave as before. Record commands, exit codes, image references, backup path, and any DNS or mail limitation in an execution report under `docs/` in the `osi-odoo` repository.

- [ ] **Step 7: Commit the execution report**

Commit: `docs: record Odoo test deployment evidence`
