# Odoo Test Environment Design

**Date:** 2026-08-21
**Status:** Approved; amended after adversarial review
**Target host:** 157.180.43.235 (ubuntu-4gb-nbg1-1)
**Public name:** odoo-test.opensmartirrigation.org
**Source repository:** /home/phil/Repos/osi-odoo locally, /opt/osi-odoo on the VPS

## Purpose

Build a disposable but operationally credible Odoo 19 Community environment for OSI's Swiss irrigation business. The environment must demonstrate the sales, inventory, accounting, CRM, project-template, and research workflows that OSI expects to use. It must also be safe to operate beside the existing osi-server deployment on the same VPS.

The environment is a test system. It is not the production system of record, and no real customer or credential data belongs in it.

## Fixed decisions

- Odoo 19 Community runs from the official odoo:19.0-20260817 image.
- PostgreSQL 17 runs from postgres:17.6-bookworm.
- Odoo and PostgreSQL use distinct login roles. The Odoo role cannot create databases, roles, schemas, or extensions.
- Odoo's filestore, PostgreSQL data, and rendered Odoo configuration use Docker named volumes.
- The rendered configuration volume is populated by a one-shot root container, then owned by the image's odoo user with mode 0600. The runtime container mounts it read-only.
- Secrets live in an operator-owned mode-0600 environment file on the VPS and are passed by environment-variable name. They are never embedded in Compose, committed files, generated command lines, or test fixtures.
- The master and database passwords are generated with openssl rand -hex 32. Values containing NUL, CR, or LF are rejected; punctuation is otherwise valid.
- Compose files do not set container_name.
- The deployed Odoo service joins the external caddy-net network with the unique alias osi-odoo. Disposable projects use only their project-scoped internal network and never claim that alias.
- Caddy terminates TLS. It sends /websocket and /websocket/* to Odoo port 8072, and all other traffic to port 8069.
- DNS must have one normalized address set for the public name. A divergent AAAA or conflicting CNAME is a deployment blocker.
- Odoo is configured for one HTTP worker, one cron worker, and one gevent worker. Per-process hard limits keep the three children within 1.5 GiB, leaving at least 512 MiB in the 2 GiB container limit for the master and transient overhead.
- The database selector and database manager are disabled.
- Odoo module tests run in disposable databases restored from a backup or created under a disposable Compose project. They never run against the live test database.
- The implementation branch is feat/initial-odoo-environment; main is not used for development commits.

## Repository layout

    osi-odoo/
    ├── .env.example
    ├── .gitignore
    ├── README.md
    ├── compose.yaml
    ├── compose.test-vps.yaml
    ├── config/
    │   └── odoo.conf.template
    ├── postgres-init/
    │   └── 010-odoo.sql.sh
    ├── addons/
    │   ├── osi_business_setup/
    │   │   ├── __init__.py
    │   │   ├── __manifest__.py
    │   │   ├── hooks.py
    │   │   ├── data/
    │   │   │   ├── business_data.xml
    │   │   │   └── project_data.xml
    │   │   └── tests/
    │   │       ├── __init__.py
    │   │       ├── test_business_setup.py
    │   │       └── test_projects.py
    │   └── osi_business_demo/
    │       ├── __init__.py
    │       ├── __manifest__.py
    │       ├── hooks.py
    │       └── tests/
    │           ├── __init__.py
    │           └── test_demo.py
    ├── scripts/
    │   ├── lib.sh
    │   ├── test-env
    │   ├── render_config.py
    │   ├── render-config
    │   ├── init-database
    │   ├── backup
    │   ├── restore-rehearsal
    │   ├── restore-production
    │   ├── update-modules
    │   ├── validate-backup
    │   ├── check-dns
    │   ├── test-bootstrap
    │   ├── test-module
    │   ├── test-business-setup
    │   ├── test-projects
    │   ├── test-demo
    │   ├── test-demo-lifecycle
    │   ├── test-init-database
    │   ├── test-coexistence
    │   ├── test-backup-restore
    │   └── deploy
    ├── systemd/
    │   ├── osi-odoo-backup.service
    │   └── osi-odoo-backup.timer
    └── deploy/
        └── Caddyfile.fragment

Runtime files such as .env, .env.test, backup archives, restore staging directories, and rendered configuration do not belong in Git.

## Runtime architecture

### Containers and networks

The base Compose file defines:

- db, reachable only through the project-scoped internal network;
- odoo, reachable only through the project-scoped internal network;
- config-init, behind a tools profile, which renders /etc/odoo/odoo.conf into the configuration volume as root and gives it to the odoo user.

The production override adds only the deployed odoo service to caddy-net with alias osi-odoo. Production commands always use both Compose files. Disposable verification commands use only the base file, a unique COMPOSE_PROJECT_NAME, and a unique database name.

No service publishes host ports. Caddy reaches Odoo over caddy-net.

### Named volumes

| Volume | Mount | Owner and access |
|---|---|---|
| odoo_db | PostgreSQL data directory | PostgreSQL image default |
| odoo_data | /var/lib/odoo | odoo image user, runtime read/write |
| odoo_config | /etc/odoo | populated as root, file owned by odoo:odoo, mode 0600, runtime read-only |

The configuration renderer writes to a temporary file in the named volume, calls fsync, changes ownership and mode, and atomically replaces odoo.conf. It rejects unresolved template markers and NUL, CR, or LF in substituted values.

### PostgreSQL ownership

odoo_admin is the bootstrap and recovery login. odoo_owner is a separate NOLOGIN database owner. odoo_app owns the public schema and is Odoo's login role. The runtime Odoo container receives only odoo_app credentials.

Bootstrap performs these operations from the official PostgreSQL initialization hook:

1. create or alter odoo_owner as NOLOGIN, NOSUPERUSER, NOCREATEDB, and NOCREATEROLE;
2. create or alter odoo_app with LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
3. create the application database owned by odoo_owner;
4. revoke public database and schema creation rights;
5. change the public schema owner to odoo_app;
6. grant odoo_app connect and temporary-database rights;
7. create pg_trgm as odoo_admin;
8. grant odoo_app use and create rights on public.

The bootstrap probe must prove that odoo_app can create and drop an application table and cannot create a database, role, schema, or extension.

unaccent is not enabled in this environment. If a later Odoo configuration enables it, its extension must be added to the privileged bootstrap first.

## Odoo process and memory budget

The runtime uses:

    workers = 1
    max_cron_threads = 1
    limit_memory_soft = 402653184
    limit_memory_hard = 536870912
    limit_memory_soft_gevent = 402653184
    limit_memory_hard_gevent = 536870912

Odoo's prefork mode creates an HTTP child, a cron child, and a gevent child. Three hard limits total 1,610,612,736 bytes (1.5 GiB). The Compose memory limit is 2 GiB, leaving 512 MiB for the master and overhead. Deployment stops if the rendered values differ from this budget or the host lacks enough free memory to start the service safely.

## Database lifecycle

Configuration rendering and PostgreSQL bootstrap happen before either custom module exists.

Final database initialization happens only after both modules and their tests exist. scripts/init-database implements this state machine:

| Observed module state | Action |
|---|---|
| Odoo registry absent | install osi_business_setup,osi_business_demo |
| Registry present; both modules absent or uninstalled | install both |
| Both modules installed | upgrade both |
| Only one installed, either pending install/removal/upgrade, or any other mixed state | fail with ERROR: partial OSI module state; operator action required |

The command passes OSI_ODOO_ADMIN_LOGIN and OSI_ODOO_ADMIN_PASSWORD by environment-variable name. It never prints their values. It exits before starting the long-running Odoo service if configuration validation, database health, or module initialization fails.

## osi_business_setup

The module depends on:

- base
- contacts
- crm
- sale_management
- purchase
- stock
- account
- project
- hr
- hr_expense
- repair
- maintenance
- calendar
- hr_timesheet
- sale_project
- sale_timesheet
- l10n_ch

### Company and accounting

The module configures the main company as:

- Name: Open Smart Irrigation
- Country: Switzerland
- Currency: CHF
- Company calendar timezone: Europe/Zurich
- Administrator timezone: Europe/Zurich

It explicitly loads the Swiss chart with:

    env["account.chart.template"].try_loading(
        "ch", company=company, install_demo=False
    )

The hook fails closed if the company already has a non-Swiss chart. Tests verify the ch template, Swiss fiscal country, CHF currency, a sales journal, active Swiss taxes, and receivable, payable, income, and expense accounts. Locale alone is not accepted as proof of accounting setup.

### Warehouse

The module does not create a second warehouse. stock creates the default warehouse with the company. The hook requires exactly one warehouse for the main company, renames it OSI Warehouse, changes its code to OSI, and registers osi_business_setup.warehouse_osi for that existing record. Zero or multiple warehouses cause an explicit failure.

### Catalog

The module creates seven stockable, serial-tracked products with stable XML IDs and references: OSI Gateway (OSI-GATEWAY), KIWI Sensor (OSI-KIWI), Tektelic Clover Sensor (OSI-CLOVER), Dragino LSN50 Sensor Node (OSI-LSN50), SenseCAP S2120 Weather Sensor (OSI-S2120), Aqua-Scope LoRain Gauge (OSI-LORAIN), and STREGA Valve (OSI-STREGA).

It also creates four services: Site Assessment, Installation and Commissioning, Operator Training, and Maintenance and Support. Services use ordered-quantity invoicing. Installation and Commissioning creates a project from the customer deployment template.

### Project templates

The module creates five project templates:

1. Customer irrigation deployment
2. Gateway and sensor commissioning
3. Preventive maintenance visit
4. Training and handover
5. Research or grant work package

Only these five project.project records have is_template=True. Their contained project.task records are ordinary tasks with is_template=False, matching Odoo's own project-template fixtures. Stage, tag, milestone, dependency, assignee, and allocated-hours relationships are explicit in XML.

The Installation and Commissioning service uses service_tracking="project_only" and links to the customer deployment template. Confirming a sales order for it must create a normal project and copied tasks, milestones, dependencies, stages, tags, and allocated hours.

## osi_business_demo

The demo module depends on osi_business_setup. Its post_init_hook calls a single ensure_demo(env) function. Calling ensure_demo twice must return the same root records and create no duplicates.

The hook creates:

- one demo customer;
- one demo supplier;
- one CRM opportunity;
- one draft quotation;
- one confirmed sales order;
- one completed inbound receipt that puts one serial-numbered OSI Gateway in stock;
- one completed delivery that consumes that serial without negative stock;
- one draft customer invoice;
- one generated customer project copied from the Customer irrigation deployment template.

The stock workflow uses Odoo inventory records, lot/serial tracking, move lines, and Odoo 19's stock.move.line.quantity field. The delivery must be reserved before validation.

Every demo-owned root and generated child has a stable external ID or belongs to a registered root through an asserted cascade. The inventory includes CRM, quotations and lines, confirmed sales and lines, invoice and lines, receipt and delivery pickings, moves, move lines, lot, quants, procurement group, generated project, tasks, milestones, and every demo external ID.

Uninstalling osi_business_demo must remove all demo-owned records and external IDs while leaving osi_business_setup records intact. Reinstalling it must recreate exactly one clean workflow. Tests exercise ensure_demo twice, module upgrade, uninstall, absence checks, reinstall, and count checks.

## Backup and recovery

### Backup contract

A backup is one quiesced, paired unit:

- PostgreSQL custom-format dump;
- archive of the matching odoo_data volume;
- manifest.json;
- SHA256SUMS.

The manifest records:

- schema version;
- UTC start and completion timestamps;
- database name;
- database dump filename;
- filestore archive filename;
- Git commit;
- both configured image references;
- both resolved image digests;
- source volume names;
- whether Odoo was running before backup;
- SHA-256 of each payload.

The backup script stops Odoo before the database dump and volume archive. A trap restarts it only when it was running before the backup. PostgreSQL stays running for pg_dump. All Compose execs use -T. A failed dump, archive, digest calculation, or manifest validation leaves no directory that can be mistaken for a complete backup.

### Timer

osi-odoo-backup.service is a root system service that executes /opt/osi-odoo/scripts/backup as user rocky from /opt/osi-odoo. osi-odoo-backup.timer runs daily with Persistent=true. Deployment installs both units, calls systemctl daemon-reload, enables and starts the timer, verifies the next trigger, and invokes the service once non-interactively.

### Restore modes

There are two separate commands:

- restore-rehearsal BACKUP_DIR creates a unique disposable Compose project, database volume, filestore volume, and target database. It never stops or joins the live runtime. It restores, starts one-off Odoo, runs functional assertions, and removes the explicitly validated disposable project and volumes.
- restore-production BACKUP_DIR --confirm-replace-live validates the pair through an isolated staged rehearsal, takes and retains a fresh paired backup of the previous live state, then stops Odoo and replaces the live database and filestore. It starts the replacement only after registry checks and prints the retained recovery backup after health checks pass.

Neither command accepts a manifest whose database name, image metadata, payload names, or checksums are missing or inconsistent.

### Upgrade failure contract

scripts/update-modules takes a paired backup, pulls the configured images, restores that pair into a disposable project, and runs both module updates and all named module tests there. Only after that rehearsal passes does it stop live Odoo and run the live module update. It restarts only after the live update and health checks pass.

If a module update fails:

- Odoo remains stopped;
- the command records the exit code, candidate image references and digests, Git commit, and backup directory;
- code or image rollback is not automatic;
- the operator first runs restore-production BACKUP_DIR --confirm-replace-live;
- only after the paired restore succeeds may the operator check out prior code or images and restart.

Tests inject a failing module update and prove that Odoo stays stopped and that the recorded backup restores in rehearsal mode.

## Caddy, DNS, and coexistence

Caddy uses a named path matcher:

    odoo-test.opensmartirrigation.org {
        encode zstd gzip

        @websocket path /websocket /websocket/*
        reverse_proxy @websocket osi-odoo:8072
        reverse_proxy osi-odoo:8069
    }

Deployment validates the full host Caddyfile before reload. It proves HTTPS login, dbfilter, disabled database-manager routes, the WebSocket health route, asset loading, and logs without proxy-loop or upstream-resolution errors.

DNS validation normalizes every A and AAAA response. The only accepted address set is the VPS's actual public address set. Any conflicting CNAME, divergent IPv6 target, or unexpected additional address stops deployment before Caddy reload.

Coexistence is proved by starting two distinct disposable base-Compose projects simultaneously and showing unique containers, networks, and volumes. Neither may have a caddy-net attachment or the osi-odoo alias.

## Verification and stop conditions

Work stops rather than proceeding when any of these conditions occurs:

- repository or branch does not match the expected target;
- required environment variables are missing or contain NUL, CR, or LF;
- rendered configuration is not readable by the runtime odoo user at mode 0600;
- PostgreSQL privilege probes do not fail and pass exactly as specified;
- module test discovery does not include the named test classes;
- accounting, warehouse, project-template, demo-stock, cleanup, or idempotence assertions fail;
- a live database is selected for a destructive or module-test command;
- backup halves, image metadata, manifest, or checksums do not match;
- DNS has a conflicting record;
- Caddy validation fails;
- the production alias is present in a disposable project;
- an update failure has not been repaired with a paired restore.

Acceptance requires fresh evidence for every item above, a successful rehearsal restore, a successful timer invocation, and a clean git diff --check.

## Review rulings

All eighteen required adversarial-review findings are incorporated in the implementation plan and this specification.

Optional rulings:

- O1: incorporated by recording configured image references and resolved digests in every backup and deployment report. Source Compose remains pinned to immutable version tags because digest pinning across host architectures is an operator-maintenance decision.
- O2: incorporated with exact /websocket and /websocket/* matchers.
- O3: incorporated with normalized A, AAAA, and CNAME validation.
- O4: incorporated with hex-generated secrets and rejection limited to NUL, CR, and LF.
- O5: pg_trgm is created by privileged bootstrap. unaccent is intentionally not created because it is not enabled.
- O6: incorporated with deterministic file-map checks, a required shellcheck preflight, and the repo-local anti-slop checker command.

## References

- Odoo 19 deployment guidance: <https://www.odoo.com/documentation/19.0/administration/on_premise/deploy.html>
- Odoo 19 project templates: <https://www.odoo.com/documentation/19.0/applications/services/project/project_management/project_templates.html>
- Odoo 19 service invoicing and project creation: <https://www.odoo.com/documentation/19.0/applications/sales/sales/invoicing/configured_milestones.html>
- Official Odoo image: <https://github.com/odoo/docker/tree/master/19.0>
- Docker Compose project isolation: <https://docs.docker.com/compose/how-tos/project-name/>
- Caddy request matchers: <https://caddyserver.com/docs/caddyfile/matchers>
