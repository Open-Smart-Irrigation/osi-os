# OSI Odoo test environment design

**Date:** 2026-08-21

**Status:** Approved in chat; awaiting review of this written specification

**Target:** `https://odoo.opensmartirrigation.org` on the OSI test VPS

## Purpose

Open Smart Irrigation needs an Odoo 19 Community environment for customer delivery and internal operations. The first deployment will cover CRM, quotations, Swiss invoicing, procurement, serialized hardware stock, projects, timesheets, expenses, repairs, and maintenance. Project management receives the deepest configuration because OSI coordinates site surveys, hardware preparation, field installation, validation, training, and handover across each customer deployment.

The environment will run independently from `osi-server`. Operators enter Odoo business records manually. No farm, gateway, user, sensor, telemetry, or billing data will synchronize between the systems in this phase.

## Ground truth

The authorized target is `server.opensmartirrigation.org`, not the restricted production host `osicloud.ch`. A read-only inspection on 2026-08-21 found:

| Resource | Test VPS state |
|---|---|
| Architecture | x86_64 |
| CPU | 6 logical CPUs |
| Memory | 11 GiB total, 6.9 GiB available |
| Swap | 8 GiB total, 37 MiB used |
| Root filesystem | 99 GiB total, 33 GiB free |
| Container runtime | Docker 29.2.1, Compose 5.1.0 |
| Reverse proxy | `caddy:2-alpine` on ports 80 and 443 |
| Shared proxy network | `caddy-net` |
| Caddy configuration | `/home/rocky/caddy/Caddyfile` |

`odoo.opensmartirrigation.org` does not resolve as of the inspection. DNS must point that name to the same test VPS address as `server.opensmartirrigation.org` before Caddy can obtain a public certificate.

## Repository and deployment layout

The source will live in a new sibling repository at `/home/phil/Repos/osi-odoo`. The deployed copy will live at `/home/rocky/docker/osi-odoo` on the test VPS.

```text
osi-odoo/
├── .env.example
├── .gitignore
├── README.md
├── compose.yaml
├── config/
│   └── odoo.conf
├── addons/
│   ├── osi_business_setup/
│   └── osi_business_demo/
├── postgres-init/
│   └── 10-create-odoo-role.sh
├── scripts/
│   ├── backup
│   ├── deploy-test
│   ├── init-database
│   ├── restore
│   └── update-modules
└── tests/
    ├── test_compose_config.sh
    └── test_seed.py
```

The repository will not vendor or fork `odoo/odoo`. It will use the official `odoo:19.0-20260817` image and mount OSI modules at `/mnt/extra-addons`. PostgreSQL will use the `postgres:16-alpine` series. Odoo publishes dated image tags, while the PostgreSQL tag deliberately follows patch releases within major version 16.

## Container topology

Compose will define `odoo` and `db` services, an internal network, and two named volumes:

- `odoo_data` stores attachments and the filestore mounted at `/var/lib/odoo`.
- `odoo_db` stores PostgreSQL at `/var/lib/postgresql/data`.
- `odoo-internal` carries Odoo-to-PostgreSQL traffic and is not externally reachable.
- Only the Odoo service joins the existing external `caddy-net` network.
- Neither service publishes a host port. Caddy is the only ingress path.

Odoo will have a 2 CPU and 2 GiB container limit. PostgreSQL will have a 1 CPU and 1 GiB limit. Odoo will start with two HTTP workers and one cron worker; memory soft and hard limits will keep those workers inside the container allowance. These limits reserve capacity for the existing OSI backend, prediction services, Mosquitto, MongoDB, Jenkins, and their databases.

Compose health checks will use `pg_isready` for PostgreSQL and an unauthenticated Odoo web endpoint for Odoo. The Odoo service will wait for a healthy database. Both services will use `restart: unless-stopped`.

## Database and credential model

The database name is `osi_odoo_test`. A shell-based PostgreSQL initializer will pass generated credentials to `psql` variables without writing them into SQL or logs. It will create a non-superuser, no-createdb application role and grant it the schema privileges Odoo needs. The bootstrap owner remains separate from the application role, which prevents the Odoo process from creating or dropping databases.

The remote `.env` will be mode `0600` and will contain generated values for:

- PostgreSQL bootstrap password
- Odoo application database password
- Odoo database-manager master password
- Odoo administrator login and password

`.env.example` contains names and safe descriptions only. No deployed value enters Git, shell history, documentation, or command output.

The initialization command will create the fixed database without standard Odoo demo data, install `osi_business_setup` and `osi_business_demo`, set the administrator login from the environment, and stop. Public routing is enabled only after initialization succeeds. Normal runtime sets the exact database name and filter, disables the database list and manager, and enables proxy mode. Odoo's deployment guide requires this shape for an internet-facing single-database service.

## Reverse proxy and DNS

Caddy will receive a new site block in `/home/rocky/caddy/Caddyfile`:

```caddyfile
odoo.opensmartirrigation.org {
    handle /websocket* {
        reverse_proxy osi-odoo:8072
    }

    handle {
        reverse_proxy osi-odoo:8069
    }
}
```

The container name or network alias will be `osi-odoo`. Odoo proxy mode will trust Caddy's forwarded scheme, host, and client address. Caddy redirects HTTP to HTTPS and manages the certificate after DNS resolves. The deployment will back up the current Caddyfile, validate the amended file with `caddy validate`, and reload Caddy without restarting unrelated services.

If DNS is not ready, the Odoo containers may start and pass internal health checks, but the deployment remains incomplete. It must not expose port 8069 as a workaround.

## Installed Community modules

`osi_business_setup` will depend on the following Odoo Community modules and install their dependencies:

| Area | Modules | OSI use |
|---|---|---|
| Relationships | `contacts`, `crm` | Farms, partners, suppliers, opportunities |
| Commercial | `sale_management`, `account` | Quotations, sales orders, CHF invoices |
| Procurement | `purchase` | Requests for quotation and purchase orders |
| Hardware | `stock` | Warehouses, receipts, deliveries, serial tracking |
| Delivery work | `project`, `hr_timesheet`, `sale_project`, `sale_timesheet` | Projects, tasks, milestones, planned and billable work |
| People and costs | `hr`, `hr_expense` | Employees and project-related expenses |
| After-sales | `repair`, `maintenance` | Customer returns and internal preventive maintenance |
| Coordination | `calendar`, `mail` | Activities, meetings, discussions, notifications |
| Localization | `l10n_ch` | Switzerland and CHF accounting defaults |

Enterprise-only Helpdesk, Field Service, Planning, Subscriptions, Documents, Sign, and Studio are excluded. Project tasks will cover support and field-service work until a measured need justifies an additional Community module or an Enterprise subscription.

## Company and catalog setup

The main company will be `Open Smart Irrigation`, with country Switzerland, currency CHF, and time zone Europe/Zurich. The setup will not invent a street address, VAT number, bank account, legal registration number, or tax rate. An administrator must enter and validate those facts before issuing a real invoice.

One warehouse named `OSI Warehouse` will contain a stock location and standard receipt and delivery operations. These stocked products will use individual serial tracking:

| Internal reference | Product |
|---|---|
| `OSI-GATEWAY` | OSI Gateway |
| `OSI-KIWI` | KIWI Sensor |
| `OSI-CLOVER` | Tektelic Clover Sensor |
| `OSI-LSN50` | Dragino LSN50 Sensor Node |
| `OSI-S2120` | SenseCAP S2120 Weather Sensor |
| `OSI-LORAIN` | Aqua-Scope LoRain Gauge |
| `OSI-STREGA` | STREGA Valve |

The serial-number field will hold the physical unit identifier used by operations. This phase will not add an Odoo device model or copy OSI gateway and sensor records from `osi-server`.

Service products will include site assessment, installation and commissioning, operator training, and maintenance and support. Confirming installation and commissioning on a sales order will create the customer deployment project from the OSI template.

## Project-management configuration

Odoo is the source of truth for commercial delivery, field work, training, maintenance, and grant work. GitHub remains the source of truth for product issues, source changes, pull requests, and software releases. Staff may link a GitHub issue URL in a task description, but the setup will not synchronize or duplicate engineering tickets.

The add-on will create five project templates:

1. Customer irrigation deployment
2. Gateway and sensor commissioning
3. Preventive maintenance visit
4. Training and handover
5. Research or grant work package

Projects use the stages Backlog, Ready, In Progress, Field Validation, Blocked, and Done. Tags cover hardware, firmware, edge OS, cloud, agronomy, deployment, training, and support.

The customer deployment template contains these tasks and dependencies:

1. Confirm scope and customer contacts
2. Complete site survey
3. Prepare gateway and devices
4. Configure connectivity
5. Install gateway
6. Install and assign sensors or valves
7. Validate uplinks and measurements
8. Train operators
9. Complete handover

Tasks will support assignees, deadlines, planned hours, timesheets, subtasks, milestones, dependencies, recurring work, chatter, and attachments. Customer-facing projects may enable portal visibility. Internal research and grant projects remain private.

Milestones for a deployment are Site ready, Hardware installed, Data validated, and Handover accepted. Timesheets recorded against a billable installation project flow to the related sales order through standard `sale_timesheet` behavior.

## Demonstration data

Odoo's standard demo data will be disabled because the service is internet-facing. `osi_business_demo` will instead create OSI-specific business records without users or passwords:

- Fictional customer `Demo Farm Zürich`
- Fictional supplier `Demo Sensor Supplier AG`
- One CRM opportunity
- One draft quotation
- One confirmed order with serialized hardware
- One completed demonstration delivery
- One draft customer invoice
- One customer deployment project populated from the template

Every demonstration partner and transaction will carry a `DEMO` marker in its reference or name. Records created through an initialization hook will receive explicit `ir.model.data` identifiers. Uninstalling `osi_business_demo` can therefore remove its records through Odoo's module ownership mechanism without removing the setup module.

## Backups and recovery

The deployment will create `/home/rocky/backups/osi-odoo` with mode `0700`. A daily host timer will call the backup script and retain 14 successful daily sets. Each set contains:

- a custom-format `pg_dump` of `osi_odoo_test`;
- a compressed archive of the Odoo filestore;
- a manifest with UTC timestamp, image references, database dump checksum, and filestore checksum.

The script writes into a temporary directory and renames it only after both artifacts and checksums succeed. Failed or partial backups do not count toward retention.

The restore script requires an explicit backup path and typed confirmation. It stops Odoo, restores PostgreSQL and the matching filestore as a pair, starts Odoo, then runs the health and login-page checks. The deployment will perform one restore rehearsal into a disposable database and filestore before reporting backup readiness.

## Failure behavior

Initialization is idempotent. It checks database and module state before creating records, and it uses stable external identifiers for every configured object. Re-running initialization updates the OSI modules; it does not create duplicate stages, tags, products, or templates.

Deployment stops on any failed preflight, Compose validation, module installation, health check, Caddy validation, or HTTPS check. It does not remove old volumes, prune Docker images, restart the existing OSI stack, or alter the `osi-server` PostgreSQL container.

The deploy script backs up the previous deployed repository and Caddyfile before replacement. A failed Odoo update rolls back the code and image reference while preserving the database and filestore for diagnosis. A database-changing module upgrade requires a fresh paired backup; rollback then restores both database and filestore from that backup.

## Verification

Local verification must pass before transfer:

1. Python syntax and Odoo module manifest checks.
2. Shell syntax checks for every script.
3. `docker compose config` with non-secret test values.
4. A clean ephemeral startup with `--without-demo=all`.
5. Installation tests for both OSI modules.
6. Assertions for Switzerland, CHF, module set, warehouse, serial-tracked products, stages, tags, templates, task dependencies, milestones, and demo records.
7. A second module upgrade with no duplicate configuration or records.
8. Backup creation and restore into disposable volumes.

Test-VPS verification must pass without disrupting existing containers:

1. Existing container inventory recorded before and after deployment.
2. Odoo and its PostgreSQL service healthy within their resource limits.
3. Existing `server.opensmartirrigation.org`, MQTT, and Jenkins routes still respond as before.
4. `https://odoo.opensmartirrigation.org/web/login` returns 200 over a valid TLS certificate.
5. HTTP redirects to HTTPS.
6. `/web/database/manager` and database listing are unavailable.
7. PostgreSQL has no published port, and the Odoo application role is neither superuser nor createdb.
8. Login succeeds with the generated administrator account.
9. Core apps, Swiss company settings, project templates, catalog, and marked demonstration workflow are visible.
10. A backup completes, its checksums validate, and the disposable restore rehearsal succeeds.

## Non-goals

This phase does not provide production hosting, high availability, outbound email delivery, payment providers, Swiss tax or payroll sign-off, SSO, GitHub integration, `osi-server` synchronization, customer migration, real inventory import, or an Odoo Enterprise subscription. It also does not modify either existing OSI database.

## References

- [Odoo source repository](https://github.com/odoo/odoo)
- [Official Odoo Docker image](https://hub.docker.com/_/odoo)
- [Odoo 19 source installation](https://www.odoo.com/documentation/19.0/administration/on_premise/source.html)
- [Odoo 19 deployment and security](https://www.odoo.com/documentation/19.0/administration/on_premise/deploy.html)
