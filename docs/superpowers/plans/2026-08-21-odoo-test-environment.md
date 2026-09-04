# Odoo Test Environment Implementation Plan

> **For the implementer:** Use superpowers:executing-plans and execute one task at a time. Stop at every named stop condition. Do not reinterpret a failed assertion as an acceptable difference.

**Goal:** Deliver a secure Odoo 19 Community test environment for OSI with Swiss accounting, reusable delivery-project templates, a repeatable demo workflow, and rehearsed paired backup and recovery.

**Architecture:** The official Odoo and PostgreSQL images run in a project-scoped Compose network. A production-only override connects Odoo to Caddy through the unique osi-odoo alias. PostgreSQL bootstrap, Odoo configuration rendering, module installation, demo data, backup, restore, and deployment are separate state transitions with executable probes.

**Technology:** Docker Compose v2, Odoo 19 Community, PostgreSQL 17, Python 3, Bash, XML data files, Caddy, systemd, dig, curl, jq, shellcheck.

**Source spec:** docs/superpowers/specs/2026-08-21-odoo-test-environment-design.md

**Verified target capacity (2026-08-21):** 11 GiB total memory, 6.9 GiB
MemAvailable, and 33 GiB free disk. These observations clear the deployment
floors, but scripts/deploy checks current memory and disk before every run
because both values change with host load.

## Execution rules

1. Work only in /home/phil/Repos/osi-odoo until the remote-deployment task.
2. Implementation commits require feat/initial-odoo-environment. A detached runtime is accepted only when OSI_RECOVERY_REPORT names an existing failed-update report whose prior_release.git_commit equals HEAD.
3. Never run module tests against the deployed database osi_odoo_test. Test commands require a disposable project and database name.
4. Never put a secret value in a command argument, committed file, fixture, log, or report.
5. Use mode 0700 for executable scripts and mode 0600 for .env files.
6. Use the exact expected-failure messages and count gates in this plan.
7. Commit only the files named by the current task.
8. Before each commit, run the task's focused tests and git diff --check.
9. A failed module upgrade leaves Odoo stopped. Recovery is operator-driven: first reactivate the prior Git release and its recorded image references, then use that prior code to validate and restore its paired backup.
10. scripts/backup, scripts/restore-rehearsal, scripts/restore-production, scripts/update-modules, and scripts/deploy use the one operation-lock interface in scripts/lib.sh. A nested-flag call validates fd 9's path and calls flock on it; an inherited holder succeeds, an unlocked fd acquires when uncontended, and a forged fd fails while another holder is active.

## Task and review map

| Task | Delivers | Review findings closed |
|---|---|---|
| 1 | Historical Compose scaffold | Preserved history only |
| 2 | Secure config rendering and real PostgreSQL bootstrap probe | R1-R5, R14-R15, O4-O6 |
| 3 | Swiss company, accounting, catalog, and default warehouse | R4, R6-R8 |
| 4 | Project templates and service linkage | R5, R9-R10 |
| 5 | Idempotent demo workflow and complete cleanup | R11-R13 |
| 6 | Final database initialization and module lifecycle | R2, R4-R5, R12, R14 |
| 7 | Quiesced paired backup, two restores, upgrade recovery, timer | R16-R18, O1 |
| 8 | Deployment, Caddy, DNS, and operator documentation | R1, R14, R17, O2-O3, O6 |
| 9 | Remote acceptance without live-database module tests | R5, R14, R16-R18 |

## Amendment rulings

The execution ledger is applied directly:

- implementation remains on feat/initial-odoo-environment;
- every executable receives mode 0700 and every generated environment file receives mode 0600;
- Task 3 has no project-template assertions;
- live acceptance uses read-only SQL and HTTP only; named Odoo test classes run in disposable databases, including the rehearsal restore.

Optional findings are ruled as follows:

- O1 is incorporated by recording configured image references and resolved RepoDigests in backups and failed-update reports. Source Compose is not digest-pinned because cross-architecture digest selection and update ownership need a separate operator decision.
- O2 is incorporated with exact /websocket and /websocket/* Caddy paths.
- O3 is incorporated with Python ipaddress normalization of the final A/AAAA set. A CNAME is allowed when its fully resolved final set is exact.
- O4 is incorporated with a 64-character lowercase hexadecimal alphabet for every generated password. load_env enforces that sourcing contract.
- O5 is incorporated for pg_trgm. unaccent is not created because it is not enabled; enabling it requires a bootstrap amendment first.
- O6 is incorporated through the exact repository map, required shellcheck command, fixed anti-slop checker path, and git diff --check gates.

## Task 1: Historical Compose scaffold — completed

Task 1 is the scaffold at commit 59b1f4b5c2713cbaa6b860d9c85fcdbc8518c30c. Do not replay it, amend its commit, or claim its original Compose and configuration choices are final. At that commit the repository contains exactly .env.example, .gitignore, compose.yaml, config/odoo.conf.template, tests/fixtures/test.env, and tests/test_static.py. Task 2 amends or removes every incompatible Task 1 assertion and fixture in a new commit. This preserves Task 1 history while applying the security and operability corrections from review.

Execution begins at Task 2.

## Task 2: Amend the scaffold for secure configuration rendering and PostgreSQL bootstrap

This task does only configuration rendering and PostgreSQL bootstrap/privilege verification. It must not install, import, or test either custom Odoo module.

**Starting point and files:**

Before editing, run:

    cd /home/phil/Repos/osi-odoo
    test "$(git rev-parse HEAD)" = \
      59b1f4b5c2713cbaa6b860d9c85fcdbc8518c30c || {
      echo "ERROR: Task 2 requires completed Task 1 commit 59b1f4b5c2713cbaa6b860d9c85fcdbc8518c30c" >&2
      exit 1
    }
    install -d -m 0755 scripts postgres-init addons tests/fixtures

The install command creates every missing parent before a child file is written. Then apply this complete map:

- Replace: compose.yaml
- Create: compose.test-vps.yaml
- Replace: .env.example
- Replace: .gitignore
- Replace: config/odoo.conf.template
- Create: scripts/lib.sh
- Create: scripts/test-env
- Create: scripts/render_config.py
- Create: scripts/render-config
- Create: postgres-init/010-odoo.sql.sh
- Create: scripts/test-bootstrap
- Replace: tests/test_static.py
- Replace: tests/fixtures/test.env
- Create: README.md with the exact Task 2 content below

No Task 1 file is left with an obsolete assertion. Nothing is removed in Task 2.

### Step 1: Confirm the branch and toolchain

Run:

    cd /home/phil/Repos/osi-odoo
    test "$(git branch --show-current)" = feat/initial-odoo-environment || {
      echo "ERROR: unexpected implementation branch" >&2
      exit 1
    }
    command -v docker
    docker compose version
    command -v openssl
    command -v shellcheck
    command -v jq

Expected: every command exits 0. A missing tool is a stop condition.

### Step 2: Replace compose.yaml

Use this complete content:

    services:
      db:
        image: postgres:17.6-bookworm
        restart: unless-stopped
        environment:
          POSTGRES_USER: odoo_admin
          POSTGRES_PASSWORD: ${ODOO_POSTGRES_ADMIN_PASSWORD:?set ODOO_POSTGRES_ADMIN_PASSWORD}
          ODOO_DB_NAME: ${ODOO_DB_NAME:-osi_odoo_test}
          ODOO_DB_OWNER: ${ODOO_DB_OWNER:-odoo_owner}
          ODOO_DB_USER: ${ODOO_DB_USER:-odoo_app}
          ODOO_DB_PASSWORD: ${ODOO_DB_PASSWORD:?set ODOO_DB_PASSWORD}
        volumes:
          - odoo_db:/var/lib/postgresql/data
          - ./postgres-init:/docker-entrypoint-initdb.d:ro
        healthcheck:
          test: ["CMD-SHELL", "pg_isready -U odoo_admin -d postgres"]
          interval: 5s
          timeout: 5s
          retries: 30
        networks:
          - odoo-internal
        mem_limit: 1g
        cpus: "1.0"

      odoo:
        image: odoo:19.0-20260817
        restart: unless-stopped
        depends_on:
          db:
            condition: service_healthy
        environment:
          HOST: db
          PORT: "5432"
          USER: ${ODOO_DB_USER:-odoo_app}
          PASSWORD: ${ODOO_DB_PASSWORD:?set ODOO_DB_PASSWORD}
        command: ["odoo", "--config=/etc/odoo/odoo.conf"]
        read_only: true
        cap_drop:
          - ALL
        security_opt:
          - no-new-privileges:true
        mem_limit: 2g
        stop_grace_period: 90s
        tmpfs:
          - /tmp:size=256m,mode=1777
        volumes:
          - odoo_data:/var/lib/odoo
          - odoo_config:/etc/odoo:ro
          - ./addons:/mnt/extra-addons:ro
        healthcheck:
          test:
            - CMD-SHELL
            - >-
              python3 -c "import urllib.request;
              urllib.request.urlopen('http://127.0.0.1:8069/web/health',
              timeout=3).read()"
          interval: 10s
          timeout: 5s
          retries: 30
          start_period: 60s
        networks:
          - odoo-internal

      config-init:
        image: odoo:19.0-20260817
        profiles:
          - tools
        user: root
        network_mode: none
        read_only: true
        cap_drop:
          - ALL
        cap_add:
          - CHOWN
          - DAC_OVERRIDE
          - FOWNER
        security_opt:
          - no-new-privileges:true
        environment:
          ODOO_MASTER_PASSWORD: ${ODOO_MASTER_PASSWORD:?set ODOO_MASTER_PASSWORD}
          ODOO_DB_NAME: ${ODOO_DB_NAME:-osi_odoo_test}
          ODOO_DB_USER: ${ODOO_DB_USER:-odoo_app}
          ODOO_DB_PASSWORD: ${ODOO_DB_PASSWORD:?set ODOO_DB_PASSWORD}
        entrypoint: ["python3", "/opt/osi/scripts/render_config.py"]
        tmpfs:
          - /tmp:size=16m,mode=1777
        volumes:
          - odoo_config:/etc/odoo
          - ./config/odoo.conf.template:/opt/osi/config/odoo.conf.template:ro
          - ./scripts/render_config.py:/opt/osi/scripts/render_config.py:ro

    networks:
      odoo-internal:
        internal: true

    volumes:
      odoo_db:
      odoo_data:
      odoo_config:

Do not add container_name or host ports.

### Step 3: Create the production-only network override

compose.test-vps.yaml must contain:

    services:
      odoo:
        networks:
          caddy-net:
            aliases:
              - osi-odoo

    networks:
      caddy-net:
        external: true

The base file remains the only file used by disposable projects.

### Step 4: Replace environment and ignore files

.env.example:

    COMPOSE_PROJECT_NAME=osi-odoo
    ODOO_DB_NAME=osi_odoo_test
    ODOO_DB_USER=odoo_app
    ODOO_DB_PASSWORD=replace-with-openssl-rand-hex-32
    ODOO_DB_OWNER=odoo_owner
    ODOO_POSTGRES_ADMIN_PASSWORD=replace-with-openssl-rand-hex-32
    ODOO_MASTER_PASSWORD=replace-with-openssl-rand-hex-32
    OSI_ODOO_ADMIN_LOGIN=admin
    OSI_ODOO_ADMIN_PASSWORD=replace-with-openssl-rand-hex-32
    BACKUP_ROOT=/home/rocky/backups/osi-odoo
    OSI_ODOO_LOCK_DIR=/home/rocky/.local/state/osi-odoo
    EXPECTED_PUBLIC_IPV4=157.180.43.235
    EXPECTED_PUBLIC_IPV6=

.gitignore:

    .env
    .env.*
    !.env.example
    backups/
    restore-staging/
    *.log
    __pycache__/
    *.py[cod]

Generate real secret values only with:

    openssl rand -hex 32

### Step 5: Replace the Odoo configuration template

config/odoo.conf.template:

    [options]
    admin_passwd = @ODOO_MASTER_PASSWORD@
    db_host = db
    db_port = 5432
    db_user = @ODOO_DB_USER@
    db_password = @ODOO_DB_PASSWORD@
    db_name = @ODOO_DB_NAME@
    dbfilter = ^@ODOO_DB_NAME@$
    list_db = False
    proxy_mode = True
    addons_path = /mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons
    data_dir = /var/lib/odoo
    load = base,web,bus
    without_demo = all
    workers = 1
    max_cron_threads = 1
    gevent_port = 8072
    limit_memory_soft = 402653184
    limit_memory_hard = 536870912
    limit_memory_soft_gevent = 402653184
    limit_memory_hard_gevent = 536870912
    limit_time_cpu = 120
    limit_time_real = 240
    limit_request = 8192
    db_maxconn = 32
    log_level = info
    logfile =

The hard-limit arithmetic is 3 × 536870912 = 1610612736 bytes. It leaves 536870912 bytes inside the 2 GiB container limit.

### Step 6: Create the exact configuration renderer

scripts/render_config.py:

    #!/usr/bin/env python3
    import os
    import pathlib
    import pwd
    import re
    import tempfile


    TEMPLATE = pathlib.Path("/opt/osi/config/odoo.conf.template")
    TARGET = pathlib.Path("/etc/odoo/odoo.conf")
    MARKERS = {
        "@ODOO_MASTER_PASSWORD@": "ODOO_MASTER_PASSWORD",
        "@ODOO_DB_NAME@": "ODOO_DB_NAME",
        "@ODOO_DB_USER@": "ODOO_DB_USER",
        "@ODOO_DB_PASSWORD@": "ODOO_DB_PASSWORD",
    }
    IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


    def required(name):
        value = os.environ.get(name, "")
        if not value:
            raise SystemExit(f"ERROR: missing {name}")
        if any(char in value for char in ("\x00", "\r", "\n")):
            raise SystemExit(f"ERROR: control character in {name}")
        return value


    values = {marker: required(name) for marker, name in MARKERS.items()}
    for name in ("ODOO_DB_NAME", "ODOO_DB_USER"):
        if not IDENTIFIER.fullmatch(os.environ[name]):
            raise SystemExit(f"ERROR: invalid PostgreSQL identifier in {name}")

    rendered = TEMPLATE.read_text(encoding="utf-8")
    for marker, value in values.items():
        rendered = rendered.replace(marker, value)
    if re.search(r"@[A-Z0-9_]+@", rendered):
        raise SystemExit("ERROR: unresolved configuration marker")

    TARGET.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    os.chmod(TARGET.parent, 0o755)
    odoo_user = pwd.getpwnam("odoo")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=TARGET.parent,
            prefix=".odoo.conf.",
            delete=False,
        ) as handle:
            temporary = pathlib.Path(handle.name)
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.chown(temporary, odoo_user.pw_uid, odoo_user.pw_gid)
        os.chmod(temporary, 0o600)
        os.replace(temporary, TARGET)
        directory_fd = os.open(TARGET.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()

The script emits no secret value.

### Step 7: Create the shared shell interface

scripts/lib.sh:

    #!/usr/bin/env bash
    set -Eeuo pipefail

    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
    ENV_FILE="${OSI_ENV_FILE:-$REPO_ROOT/.env}"

    die() {
      printf 'ERROR: %s\n' "$*" >&2
      exit 1
    }

    require_command() {
      command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
    }

    load_env() {
      [[ -f "$ENV_FILE" ]] || die "missing environment file: $ENV_FILE"
      # The environment file is operator-owned input, mode 0600, and contains
      # only assignments generated from .env.example.
      set -a
      # shellcheck disable=SC1090
      . "$ENV_FILE"
      set +a
      : "${COMPOSE_PROJECT_NAME:?missing COMPOSE_PROJECT_NAME}"
      : "${ODOO_DB_NAME:?missing ODOO_DB_NAME}"
      : "${ODOO_DB_USER:?missing ODOO_DB_USER}"
      : "${ODOO_DB_PASSWORD:?missing ODOO_DB_PASSWORD}"
      : "${ODOO_DB_OWNER:?missing ODOO_DB_OWNER}"
      : "${ODOO_POSTGRES_ADMIN_PASSWORD:?missing ODOO_POSTGRES_ADMIN_PASSWORD}"
      : "${ODOO_MASTER_PASSWORD:?missing ODOO_MASTER_PASSWORD}"
      : "${OSI_ODOO_ADMIN_LOGIN:?missing OSI_ODOO_ADMIN_LOGIN}"
      : "${OSI_ODOO_ADMIN_PASSWORD:?missing OSI_ODOO_ADMIN_PASSWORD}"
      [[ "$ODOO_DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
        die "invalid ODOO_DB_NAME"
      [[ "$ODOO_DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
        die "invalid ODOO_DB_USER"
      local name value
      for name in ODOO_DB_PASSWORD ODOO_POSTGRES_ADMIN_PASSWORD \
        ODOO_MASTER_PASSWORD OSI_ODOO_ADMIN_PASSWORD; do
        value="${!name}"
        [[ "$value" =~ ^[0-9a-f]{64}$ ]] ||
          die "$name must be 64 lowercase hexadecimal characters"
      done
      [[ "$OSI_ODOO_ADMIN_LOGIN" =~ ^[A-Za-z0-9._@+-]+$ ]] ||
        die "invalid OSI_ODOO_ADMIN_LOGIN"
    }

    enter_repo() {
      cd "$REPO_ROOT"
      if [[ "$(git branch --show-current)" == feat/initial-odoo-environment ]]; then
        return 0
      fi
      [[ -n "${OSI_RECOVERY_REPORT:-}" && -f "$OSI_RECOVERY_REPORT" ]] ||
        die "unexpected implementation branch"
      local expected_recovery_commit
      expected_recovery_commit="$(jq -r '.prior_release.git_commit' \
        "$OSI_RECOVERY_REPORT")"
      [[ "$expected_recovery_commit" =~ ^[0-9a-f]{40}$ ]] ||
        die "invalid recovery report commit"
      [[ "$(git rev-parse HEAD)" == "$expected_recovery_commit" ]] ||
        die "recovery checkout does not match recovery report"
    }

    compose_base() {
      docker compose --env-file "$ENV_FILE" \
        --project-name "$COMPOSE_PROJECT_NAME" \
        -f "$REPO_ROOT/compose.yaml" "$@"
    }

    compose_prod() {
      docker compose --env-file "$ENV_FILE" \
        --project-name "$COMPOSE_PROJECT_NAME" \
        -f "$REPO_ROOT/compose.yaml" \
        -f "$REPO_ROOT/compose.test-vps.yaml" "$@"
    }

    require_disposable_project() {
      [[ "$COMPOSE_PROJECT_NAME" =~ ^osi-odoo-(bootstrap|restore|coexist)-[0-9]+-[A-Za-z0-9]+$ ]] ||
        die "refusing destructive action for non-disposable project"
      [[ "$ODOO_DB_NAME" != osi_odoo_test ]] ||
        die "refusing disposable action against live database name"
    }

    wait_for_db() {
      local tries=0
      until compose_base exec -T db \
        pg_isready -U odoo_admin -d postgres >/dev/null 2>&1; do
        tries=$((tries + 1))
        (( tries <= 60 )) || die "PostgreSQL did not become ready"
        sleep 1
      done
    }

Create scripts/test-env as the shared disposable-project fixture:

    #!/usr/bin/env bash
    set -Eeuo pipefail

    create_test_environment() {
      local category="$1"
      local suffix="$2"
      local database_prefix database_nonce
      [[ "$category" =~ ^(bootstrap|restore|coexist)$ ]] ||
        { echo "ERROR: invalid test category" >&2; return 1; }
      [[ "$suffix" =~ ^[A-Za-z0-9]$ ]] ||
        { echo "ERROR: invalid test suffix" >&2; return 1; }
      case "$category" in
        bootstrap) database_prefix=osi_b ;;
        restore) database_prefix=osi_r ;;
        coexist) database_prefix=osi_c ;;
      esac
      database_nonce="$(openssl rand -hex 4)"
      [[ "$database_nonce" =~ ^[0-9a-f]{8}$ ]] ||
        { echo "ERROR: invalid test database nonce" >&2; return 1; }
      TEST_DATABASE="${database_prefix}_${database_nonce}_${suffix}"
      [[ ${#TEST_DATABASE} -eq 16 ]] ||
        { echo "ERROR: test database name budget changed" >&2; return 1; }
      TEST_ROOT="$(mktemp -d /tmp/osi-odoo-test.XXXXXX)"
      chmod 0700 "$TEST_ROOT"
      TEST_PROJECT="osi-odoo-$category-$$-$suffix"
      TEST_ENV_FILE="$TEST_ROOT/test.env"
      {
        printf 'COMPOSE_PROJECT_NAME=%s\n' "$TEST_PROJECT"
        printf 'ODOO_DB_NAME=%s\n' "$TEST_DATABASE"
        printf 'ODOO_DB_OWNER=odoo_owner\n'
        printf 'ODOO_DB_USER=odoo_app\n'
        printf 'ODOO_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
        printf 'ODOO_POSTGRES_ADMIN_PASSWORD=%s\n' \
          "$(openssl rand -hex 32)"
        printf 'ODOO_MASTER_PASSWORD=%s\n' "$(openssl rand -hex 32)"
        printf 'OSI_ODOO_ADMIN_LOGIN=admin\n'
        printf 'OSI_ODOO_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 32)"
        printf 'BACKUP_ROOT=%s\n' "$TEST_ROOT/backups"
        printf 'OSI_ODOO_LOCK_DIR=%s\n' "$TEST_ROOT/operation-lock"
        printf 'EXPECTED_PUBLIC_IPV4=127.0.0.1\n'
        printf 'EXPECTED_PUBLIC_IPV6=\n'
      } >"$TEST_ENV_FILE"
      chmod 0600 "$TEST_ENV_FILE"
      export TEST_ROOT TEST_PROJECT TEST_DATABASE TEST_ENV_FILE
      export OSI_ENV_FILE="$TEST_ENV_FILE" OSI_RUNTIME_MODE=base
    }

    destroy_test_environment() {
      [[ "${TEST_PROJECT:-}" =~ ^osi-odoo-(bootstrap|restore|coexist)-[0-9]+-[A-Za-z0-9]+$ ]] ||
        { echo "ERROR: unsafe disposable project name" >&2; return 1; }
      [[ "${TEST_ROOT:-}" == /tmp/osi-odoo-test.* ]] ||
        { echo "ERROR: unsafe disposable directory" >&2; return 1; }
      docker compose --env-file "$TEST_ENV_FILE" \
        --project-name "$TEST_PROJECT" \
        -f "$TEST_REPO_ROOT/compose.yaml" \
        down -v --remove-orphans >/dev/null 2>&1 || true
      rm -rf -- "$TEST_ROOT"
    }

### Step 8: Replace scripts/render-config

Use:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    compose_base --profile tools run --rm --no-deps config-init
    compose_base run --rm --no-deps --entrypoint sh odoo -ceu '
      test -r /etc/odoo/odoo.conf
      test "$(stat -c %a /etc/odoo/odoo.conf)" = 600
      test "$(stat -c %U:%G /etc/odoo/odoo.conf)" = odoo:odoo
      ! grep -Eq "@[A-Z0-9_]+@" /etc/odoo/odoo.conf
    '

### Step 9: Replace the PostgreSQL initialization hook

postgres-init/010-odoo.sql.sh:

    #!/usr/bin/env bash
    set -Eeuo pipefail

    : "${POSTGRES_USER:?missing POSTGRES_USER}"
    : "${ODOO_DB_NAME:?missing ODOO_DB_NAME}"
    : "${ODOO_DB_OWNER:?missing ODOO_DB_OWNER}"
    : "${ODOO_DB_USER:?missing ODOO_DB_USER}"
    : "${ODOO_DB_PASSWORD:?missing ODOO_DB_PASSWORD}"

    for identifier in "$POSTGRES_USER" "$ODOO_DB_NAME" \
      "$ODOO_DB_OWNER" "$ODOO_DB_USER"; do
      [[ "$identifier" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
        echo "ERROR: invalid PostgreSQL identifier" >&2
        exit 1
      }
    done
    [[ "$ODOO_DB_PASSWORD" != *$'\r'* &&
       "$ODOO_DB_PASSWORD" != *$'\n'* ]] || {
      echo "ERROR: control character in ODOO_DB_PASSWORD" >&2
      exit 1
    }

    psql --set ON_ERROR_STOP=1 \
      --username "$POSTGRES_USER" \
      --dbname postgres \
      --set owner_user="$ODOO_DB_OWNER" \
      --set db_name="$ODOO_DB_NAME" \
      --set app_user="$ODOO_DB_USER" \
      --set app_password="$ODOO_DB_PASSWORD" <<'SQL'
    SELECT format(
      'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
      :'app_user', :'app_password'
    )
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = :'app_user'
    ) \gexec

    SELECT format(
      'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
      :'app_user', :'app_password'
    ) \gexec

    SELECT format(
      'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
      :'owner_user'
    )
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = :'owner_user'
    ) \gexec

    SELECT format(
      'ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
      :'owner_user'
    ) \gexec

    SELECT format(
      'CREATE DATABASE %I OWNER %I',
      :'db_name', :'owner_user'
    )
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_database WHERE datname = :'db_name'
    ) \gexec

    \connect :"db_name"

    SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
    SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I',
                  :'db_name', :'app_user') \gexec
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    SELECT format('ALTER SCHEMA public OWNER TO %I', :'app_user') \gexec
    SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I',
                  :'app_user') \gexec
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    SQL

The bootstrap login is odoo_admin. The database owner odoo_owner is a separate NOLOGIN role. Runtime Odoo receives only odoo_app credentials.

### Step 10: Create the real bootstrap and privilege test

scripts/test-bootstrap:

    #!/usr/bin/env bash
    set -Eeuo pipefail

    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
    require() {
      command -v "$1" >/dev/null 2>&1 || {
        echo "ERROR: missing command: $1" >&2
        exit 1
      }
    }
    for command_name in docker openssl shellcheck; do
      require "$command_name"
    done

    test_root="$(mktemp -d)"
    chmod 0700 "$test_root"
    project="osi-odoo-bootstrap-$$-a"
    database="osi_odoo_bootstrap_$$"
    env_file="$test_root/test.env"
    cleanup() {
      if [[ "$project" =~ ^osi-odoo-bootstrap-[0-9]+-a$ ]]; then
        docker compose --env-file "$env_file" --project-name "$project" \
          -f "$REPO_ROOT/compose.yaml" down -v --remove-orphans \
          >/dev/null 2>&1 || true
      fi
      rm -rf -- "$test_root"
    }
    trap cleanup EXIT

    db_password="$(openssl rand -hex 32)"
    postgres_admin_password="$(openssl rand -hex 32)"
    master_password="$(openssl rand -hex 32)"
    admin_password="$(openssl rand -hex 32)"
    {
      printf 'COMPOSE_PROJECT_NAME=%s\n' "$project"
      printf 'ODOO_DB_NAME=%s\n' "$database"
      printf 'ODOO_DB_USER=odoo_app\n'
      printf 'ODOO_DB_PASSWORD=%s\n' "$db_password"
      printf 'ODOO_DB_OWNER=odoo_owner\n'
      printf 'ODOO_POSTGRES_ADMIN_PASSWORD=%s\n' \
        "$postgres_admin_password"
      printf 'ODOO_MASTER_PASSWORD=%s\n' "$master_password"
      printf 'OSI_ODOO_ADMIN_LOGIN=admin\n'
      printf 'OSI_ODOO_ADMIN_PASSWORD=%s\n' "$admin_password"
        printf 'BACKUP_ROOT=%s\n' "$test_root/backups"
        printf 'OSI_ODOO_LOCK_DIR=%s\n' "$test_root/operation-lock"
    } >"$env_file"
    chmod 0600 "$env_file"
    unset db_password postgres_admin_password master_password admin_password

    export OSI_ENV_FILE="$env_file"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    require_disposable_project

    shellcheck scripts/lib.sh scripts/test-env scripts/render-config \
      postgres-init/010-odoo.sql.sh scripts/test-bootstrap

    bad_env="$test_root/bad-secret.env"
    sed 's/^ODOO_MASTER_PASSWORD=.*/ODOO_MASTER_PASSWORD=not-hex/' \
      "$env_file" >"$bad_env"
    chmod 0600 "$bad_env"
    if OSI_ENV_FILE="$bad_env" bash -ceu \
      '. scripts/lib.sh; load_env' \
      >"$test_root/bad-secret.log" 2>&1; then
      die "non-hex sourced password unexpectedly succeeded"
    fi
    grep -q 'ERROR: ODOO_MASTER_PASSWORD must be 64 lowercase hexadecimal characters' \
      "$test_root/bad-secret.log" ||
      die "non-hex sourced password lacked the named failure"

    compose_base config >"$test_root/compose.rendered.yaml"
    if grep -q 'container_name:' "$test_root/compose.rendered.yaml"; then
      die "container_name is forbidden"
    fi
    if grep -q 'caddy-net' "$test_root/compose.rendered.yaml"; then
      die "base Compose file must not join caddy-net"
    fi

    python3 - "$REPO_ROOT/config/odoo.conf.template" <<'PY'
    import pathlib
    import sys

    values = {}
    for raw in pathlib.Path(sys.argv[1]).read_text().splitlines():
        if " = " in raw:
            key, value = raw.split(" = ", 1)
            values[key] = value
    assert values["workers"] == "1"
    assert values["max_cron_threads"] == "1"
    assert int(values["limit_memory_hard"]) * 3 == 1610612736
    assert int(values["limit_memory_hard"]) * 3 <= 2 * 1024**3
    assert values["list_db"] == "False"
    PY

    compose_base --profile tools run --rm --no-deps config-init
    compose_base run --rm --no-deps --entrypoint sh odoo -ceu '
      test -r /etc/odoo/odoo.conf
      test "$(stat -c %a /etc/odoo/odoo.conf)" = 600
      test "$(stat -c %U:%G /etc/odoo/odoo.conf)" = odoo:odoo
      ! grep -Eq "@[A-Z0-9_]+@" /etc/odoo/odoo.conf
    '

    compose_base up -d db
    wait_for_db

    role_flags="$(compose_base exec -T db psql -U odoo_admin -d postgres -Atqc \
      "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication
       FROM pg_roles WHERE rolname='odoo_app'")"
    [[ "$role_flags" == 'f|f|f|f' ]] ||
      die "unexpected application role privileges: $role_flags"
    owner_login="$(compose_base exec -T db psql -U odoo_admin \
      -d postgres -Atqc \
      "SELECT rolcanlogin FROM pg_roles WHERE rolname='odoo_owner'")"
    [[ "$owner_login" == f ]] || die "database owner must be NOLOGIN"
    database_owner="$(compose_base exec -T db psql -U odoo_admin \
      -d postgres -Atqc \
      "SELECT pg_get_userbyid(datdba) FROM pg_database \
       WHERE datname='$ODOO_DB_NAME'")"
    [[ "$database_owner" == odoo_owner ]] ||
      die "odoo_owner does not own the application database"

    schema_owner="$(compose_base exec -T db psql -U odoo_admin \
      -d "$ODOO_DB_NAME" -Atqc \
      "SELECT pg_get_userbyid(nspowner)
       FROM pg_namespace WHERE nspname='public'")"
    [[ "$schema_owner" == odoo_app ]] ||
      die "odoo_app does not own public schema"

    extension="$(compose_base exec -T db psql -U odoo_admin \
      -d "$ODOO_DB_NAME" -Atqc \
      "SELECT e.extname || '|' || r.rolname
       FROM pg_extension e JOIN pg_roles r ON r.oid=e.extowner
       WHERE e.extname='pg_trgm'")"
    [[ "$extension" == 'pg_trgm|odoo_admin' ]] ||
      die "pg_trgm is absent or not owned by odoo_admin"

    app_psql() {
      compose_base exec -T db sh -ceu '
        PGPASSWORD="$ODOO_DB_PASSWORD" psql -v ON_ERROR_STOP=1 \
          -h 127.0.0.1 -U "$ODOO_DB_USER" -d "$ODOO_DB_NAME" -c "$1"
      ' sh "$1"
    }
    app_psql 'CREATE TABLE bootstrap_probe(id integer PRIMARY KEY);'
    app_psql 'DROP TABLE bootstrap_probe;'

    expect_denied() {
      local name="$1"
      local sql="$2"
      local output="$test_root/$name.log"
      if app_psql "$sql" >"$output" 2>&1; then
        die "$name unexpectedly succeeded"
      fi
      grep -Eqi 'permission denied|must be superuser' "$output" ||
        die "$name failed without the named permission error"
    }
    expect_denied create_database 'CREATE DATABASE forbidden_database;'
    expect_denied create_role 'CREATE ROLE forbidden_role;'
    expect_denied create_schema 'CREATE SCHEMA forbidden_schema;'
    expect_denied create_extension 'CREATE EXTENSION hstore;'

    echo "PASS: config volume and PostgreSQL bootstrap privileges"

The four expected failures are named create_database, create_role, create_schema, and create_extension. Any success is a test failure.

### Step 11: Reconcile the completed Task 1 test, fixture, and README

Replace tests/test_static.py with:

    """Static contract checks for the amended Odoo Compose environment."""
    from pathlib import Path
    import re
    import unittest


    ROOT = Path(__file__).resolve().parents[1]


    class ComposeContractTests(unittest.TestCase):
        def test_compose_contract(self):
            compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
            for expected in (
                "image: postgres:17.6-bookworm",
                "image: odoo:19.0-20260817",
                "mem_limit: 1g",
                'cpus: "1.0"',
                "mem_limit: 2g",
                "odoo_config:/etc/odoo:ro",
                "internal: true",
            ):
                self.assertIn(expected, compose)
            self.assertNotIn("container_name:", compose)
            self.assertNotIn("caddy-net", compose)
            self.assertNotRegex(compose, r"(?m)^\s*ports:\s*$")
            override = (ROOT / "compose.test-vps.yaml").read_text(
                encoding="utf-8"
            )
            self.assertIn("caddy-net:", override)
            self.assertIn("- osi-odoo", override)

        def test_config_and_repository_contract(self):
            config = (ROOT / "config/odoo.conf.template").read_text(
                encoding="utf-8"
            )
            for expected in (
                "workers = 1",
                "max_cron_threads = 1",
                "without_demo = all",
                "db_name = @ODOO_DB_NAME@",
                "dbfilter = ^@ODOO_DB_NAME@$",
                "list_db = False",
            ):
                self.assertIn(expected, config)
            for path in (
                "scripts/lib.sh",
                "scripts/test-env",
                "scripts/render_config.py",
                "scripts/render-config",
                "scripts/test-bootstrap",
                "postgres-init/010-odoo.sql.sh",
                "tests/fixtures/test.env",
            ):
                self.assertTrue((ROOT / path).is_file(), path)
            ignored = (ROOT / ".gitignore").read_text(encoding="utf-8")
            for expected in (".env", "backups/", "restore-staging/"):
                self.assertIn(expected, ignored)

        def test_fixture_uses_the_sourceable_hex_contract(self):
            fixture = ROOT / "tests/fixtures/test.env"
            values = {}
            for line in fixture.read_text(encoding="utf-8").splitlines():
                key, value = line.split("=", 1)
                values[key] = value
            for key in (
                "ODOO_DB_PASSWORD",
                "ODOO_POSTGRES_ADMIN_PASSWORD",
                "ODOO_MASTER_PASSWORD",
                "OSI_ODOO_ADMIN_PASSWORD",
            ):
                self.assertRegex(values[key], r"^[0-9a-f]{64}$")
            self.assertEqual(values["ODOO_DB_OWNER"], "odoo_owner")
            self.assertIn("OSI_ODOO_LOCK_DIR", values)


    if __name__ == "__main__":
        unittest.main()

Replace tests/fixtures/test.env with these non-secret disposable values:

    COMPOSE_PROJECT_NAME=osi-odoo-bootstrap-999-a
    ODOO_DB_NAME=osi_odoo_bootstrap_999
    ODOO_DB_OWNER=odoo_owner
    ODOO_DB_USER=odoo_app
    ODOO_DB_PASSWORD=1111111111111111111111111111111111111111111111111111111111111111
    ODOO_POSTGRES_ADMIN_PASSWORD=2222222222222222222222222222222222222222222222222222222222222222
    ODOO_MASTER_PASSWORD=3333333333333333333333333333333333333333333333333333333333333333
    OSI_ODOO_ADMIN_LOGIN=admin
    OSI_ODOO_ADMIN_PASSWORD=4444444444444444444444444444444444444444444444444444444444444444
    BACKUP_ROOT=/tmp/osi-odoo-task2-fixture/backups
    OSI_ODOO_LOCK_DIR=/tmp/osi-odoo-task2-fixture/operation-lock
    EXPECTED_PUBLIC_IPV4=127.0.0.1
    EXPECTED_PUBLIC_IPV6=

Create README.md with this complete Task 2 content; Task 6 and Task 8 replace it with their own complete versions:

    # OSI Odoo test environment

    This repository currently provides configuration rendering and PostgreSQL
    bootstrap only. It does not yet contain the OSI business modules and must not
    be deployed.

    Run `scripts/test-bootstrap` to create an isolated disposable PostgreSQL
    volume, render the mode-0600 Odoo configuration, and exercise the restricted
    `odoo_app` role. Full Odoo database initialization is deliberately deferred to
    Task 6, after both custom modules and their tests exist.

    Copy `.env.example` to `.env` only for local operator work. Replace every
    password placeholder with `openssl rand -hex 32`, keep the file at mode 0600,
    and never commit or print it.

### Step 12: Apply modes and run the complete Task 1 plus Task 2 gate

Run:

    chmod 0700 scripts/lib.sh scripts/render-config \
      scripts/test-bootstrap postgres-init/010-odoo.sql.sh
    chmod 0644 scripts/test-env
    chmod 0644 scripts/render_config.py config/odoo.conf.template \
      compose.yaml compose.test-vps.yaml .env.example .gitignore \
      tests/test_static.py tests/fixtures/test.env README.md
    python3 -m unittest -v tests/test_static.py
    docker compose --env-file tests/fixtures/test.env -f compose.yaml config \
      > /tmp/osi-odoo-task2-compose.yaml
    ! grep -q 'container_name:' /tmp/osi-odoo-task2-compose.yaml
    ! grep -q 'caddy-net' /tmp/osi-odoo-task2-compose.yaml
    scripts/test-bootstrap
    git diff --check

Expected final line:

    PASS: config volume and PostgreSQL bootstrap privileges

Stop if the configuration cannot be read by the runtime odoo user, any forbidden SQL succeeds, or the test invokes an Odoo module.

Stop if the inherited Task 1 unittest suite, rendered Compose gates, configuration ownership, or any privilege probe fails. This gate is required against the actual 59b1f4b5c2713cbaa6b860d9c85fcdbc8518c30c starting commit.

### Step 13: Commit

Run:

    git add compose.yaml compose.test-vps.yaml .env.example .gitignore \
      config/odoo.conf.template postgres-init/010-odoo.sql.sh \
      scripts/lib.sh scripts/test-env scripts/render_config.py scripts/render-config \
      scripts/test-bootstrap tests/test_static.py tests/fixtures/test.env README.md
    git commit -m "feat: secure Odoo bootstrap and configuration"

## Task 3: Add Swiss company, accounting, catalog, and default-warehouse setup

This task tests only company, administrator, accounting, product, and warehouse fields. It must not assert project_template_id, project templates, milestones, dependencies, or generated projects; those belong to Task 4.

**Files:**

- Create: addons/osi_business_setup/__init__.py
- Create: addons/osi_business_setup/__manifest__.py
- Create: addons/osi_business_setup/hooks.py
- Create: addons/osi_business_setup/data/business_data.xml
- Create: addons/osi_business_setup/tests/__init__.py
- Create: addons/osi_business_setup/tests/test_business_setup.py
- Create: scripts/test-module
- Create: scripts/test-business-setup

### Step 1: Create the module scaffold and failing test

addons/osi_business_setup/__init__.py:

    from .hooks import post_init_hook

addons/osi_business_setup/__manifest__.py:

    {
        "name": "OSI Business Setup",
        "version": "19.0.1.0.0",
        "category": "Operations",
        "license": "LGPL-3",
        "depends": [
            "base",
            "contacts",
            "crm",
            "sale_management",
            "purchase",
            "stock",
            "account",
            "project",
            "hr",
            "hr_expense",
            "repair",
            "maintenance",
            "calendar",
            "hr_timesheet",
            "sale_project",
            "sale_timesheet",
            "l10n_ch",
        ],
        "data": ["data/business_data.xml"],
        "post_init_hook": "post_init_hook",
        "installable": True,
        "application": False,
    }

Create the initial addons/osi_business_setup/hooks.py:

    def post_init_hook(env):
        return None

Create the initial addons/osi_business_setup/data/business_data.xml so the red run reaches the assertions:

    <?xml version="1.0" encoding="utf-8"?>
    <odoo/>

addons/osi_business_setup/tests/__init__.py:

    from . import test_business_setup

addons/osi_business_setup/tests/test_business_setup.py:

    import os

    from odoo.tests.common import TransactionCase, tagged


    @tagged("post_install", "-at_install")
    class TestBusinessSetup(TransactionCase):
        def test_required_community_modules_are_installed(self):
            required = {
                "contacts", "crm", "sale_management", "purchase", "stock",
                "account", "project", "hr", "hr_expense", "repair",
                "maintenance", "calendar", "hr_timesheet", "sale_project",
                "sale_timesheet", "l10n_ch",
            }
            installed = set(
                self.env["ir.module.module"].search(
                    [("name", "in", sorted(required)),
                     ("state", "=", "installed")]
                ).mapped("name")
            )
            self.assertEqual(installed, required)

        def test_company_accounting_admin_and_warehouse(self):
            company = self.env.ref("base.main_company")
            self.assertEqual(company.name, "Open Smart Irrigation")
            self.assertEqual(company.country_id, self.env.ref("base.ch"))
            self.assertEqual(company.currency_id, self.env.ref("base.CHF"))
            self.assertEqual(company.resource_calendar_id.tz, "Europe/Zurich")
            self.assertEqual(company.chart_template, "ch")
            self.assertEqual(
                company.account_fiscal_country_id, self.env.ref("base.ch")
            )

            admin = self.env.ref("base.user_admin")
            self.assertEqual(admin.login, os.environ["OSI_ODOO_ADMIN_LOGIN"])
            self.assertEqual(admin.tz, "Europe/Zurich")

            sale_journal = self.env["account.journal"].search(
                [("company_id", "=", company.id), ("type", "=", "sale")]
            )
            self.assertTrue(sale_journal)
            self.assertTrue(
                self.env["account.tax"].search_count(
                    [("company_id", "=", company.id), ("active", "=", True)]
                )
            )
            for account_type in (
                "asset_receivable",
                "liability_payable",
                "income",
                "expense",
            ):
                self.assertTrue(
                    self.env["account.account"].search_count(
                        [
                            ("company_ids", "in", company.id),
                            ("account_type", "=", account_type),
                        ]
                    ),
                    f"missing {account_type} account",
                )

            warehouses = self.env["stock.warehouse"].search(
                [("company_id", "=", company.id)]
            )
            self.assertEqual(len(warehouses), 1)
            self.assertEqual(warehouses.name, "OSI Warehouse")
            self.assertEqual(warehouses.code, "OSI")
            self.assertEqual(
                warehouses, self.env.ref("osi_business_setup.warehouse_osi")
            )
            self.assertEqual(warehouses.in_type_id.warehouse_id, warehouses)
            self.assertEqual(warehouses.out_type_id.warehouse_id, warehouses)
            self.assertEqual(warehouses.lot_stock_id.warehouse_id, warehouses)

        def test_catalog(self):
            hardware = {
                "product_gateway": ("OSI Gateway", "OSI-GATEWAY"),
                "product_kiwi": ("KIWI Sensor", "OSI-KIWI"),
                "product_clover": (
                    "Tektelic Clover Sensor", "OSI-CLOVER"
                ),
                "product_lsn50": (
                    "Dragino LSN50 Sensor Node", "OSI-LSN50"
                ),
                "product_s2120": (
                    "SenseCAP S2120 Weather Sensor", "OSI-S2120"
                ),
                "product_lorain": (
                    "Aqua-Scope LoRain Gauge", "OSI-LORAIN"
                ),
                "product_strega": ("STREGA Valve", "OSI-STREGA"),
            }
            for xml_name, values in hardware.items():
                product = self.env.ref(f"osi_business_setup.{xml_name}")
                self.assertEqual((product.name, product.default_code), values)
                self.assertTrue(product.is_storable)
                self.assertEqual(product.tracking, "serial")

            services = {
                "service_site_assessment": "Site Assessment",
                "service_installation": "Installation and Commissioning",
                "service_operator_training": "Operator Training",
                "service_maintenance_support": "Maintenance and Support",
            }
            for xml_name, name in services.items():
                product = self.env.ref(f"osi_business_setup.{xml_name}")
                self.assertEqual(product.name, name)
                self.assertEqual(product.type, "service")

No Task 4 field appears in this test.

### Step 2: Create the disposable module-test runner

scripts/test-module:

    #!/usr/bin/env bash
    set -Eeuo pipefail

    if (( $# < 2 || $# > 3 )); then
      echo "usage: scripts/test-module MODULE EXPECTED_TEST_CLASS [EXPECTED_TEST_METHOD]" >&2
      exit 64
    fi
    module="$1"
    expected_class="$2"
    expected_method="${3:-}"
    [[ "$module" =~ ^osi_[a-z_]+$ ]] || {
      echo "ERROR: invalid module name" >&2
      exit 1
    }
    [[ "$expected_class" =~ ^Test[A-Za-z0-9_]+$ ]] || {
      echo "ERROR: invalid test class" >&2
      exit 1
    }
    if [[ -n "$expected_method" &&
          ! "$expected_method" =~ ^test_[A-Za-z0-9_]+$ ]]; then
      echo "ERROR: invalid test method" >&2
      exit 1
    fi
    test_tag="/$module:$expected_class"
    if [[ -n "$expected_method" ]]; then
      test_tag="${test_tag}.${expected_method}"
    fi

    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    test_root="$(mktemp -d)"
    chmod 0700 "$test_root"
    project="osi-odoo-bootstrap-$$-m"
    database="osi_odoo_module_$$"
    env_file="$test_root/test.env"
    cleanup() {
      if [[ "$project" =~ ^osi-odoo-bootstrap-[0-9]+-m$ ]]; then
        docker compose --env-file "$env_file" --project-name "$project" \
          -f "$SCRIPT_DIR/../compose.yaml" down -v --remove-orphans \
          >/dev/null 2>&1 || true
      fi
      rm -rf -- "$test_root"
    }
    trap cleanup EXIT

    {
      printf 'COMPOSE_PROJECT_NAME=%s\n' "$project"
      printf 'ODOO_DB_NAME=%s\n' "$database"
      printf 'ODOO_DB_USER=odoo_app\n'
      printf 'ODOO_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
      printf 'ODOO_DB_OWNER=odoo_owner\n'
      printf 'ODOO_POSTGRES_ADMIN_PASSWORD=%s\n' \
        "$(openssl rand -hex 32)"
      printf 'ODOO_MASTER_PASSWORD=%s\n' "$(openssl rand -hex 32)"
      printf 'OSI_ODOO_ADMIN_LOGIN=admin\n'
      printf 'OSI_ODOO_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 32)"
        printf 'BACKUP_ROOT=%s\n' "$test_root/backups"
        printf 'OSI_ODOO_LOCK_DIR=%s\n' "$test_root/operation-lock"
    } >"$env_file"
    chmod 0600 "$env_file"

    export OSI_ENV_FILE="$env_file"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    require_disposable_project
    compose_base --profile tools run --rm --no-deps config-init
    compose_base up -d db
    wait_for_db

    set +e
    compose_base run --rm --no-deps \
      -e OSI_ODOO_ADMIN_LOGIN \
      -e OSI_ODOO_ADMIN_PASSWORD \
      odoo odoo --config=/etc/odoo/odoo.conf \
      --database="$ODOO_DB_NAME" \
      --init="$module" \
      --test-enable \
      --test-tags="$test_tag" \
      --log-level=test \
      --stop-after-init 2>&1 | tee "$test_root/odoo-tests.log"
    status="${PIPESTATUS[0]}"
    set -e
    (( status == 0 )) || exit "$status"
    grep -q "$expected_class" "$test_root/odoo-tests.log" || {
      echo "ERROR: expected test class was not discovered: $expected_class" >&2
      exit 1
    }
    if [[ -n "$expected_method" ]]; then
      discovery_count="$(grep -Ec \
        "Starting .*${expected_class}\\.${expected_method}([^A-Za-z0-9_]|$)" \
        "$test_root/odoo-tests.log")"
      [[ "$discovery_count" == 1 ]] || {
        echo "ERROR: expected exactly one runtime discovery of ${expected_class}.${expected_method}; found $discovery_count" >&2
        exit 1
      }
      printf 'PASS: discovered %s.%s exactly once\n' \
        "$expected_class" "$expected_method"
    fi

scripts/test-business-setup:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    exec "$SCRIPT_DIR/test-module" osi_business_setup TestBusinessSetup

Run the failing test:

    chmod 0700 scripts/test-module scripts/test-business-setup
    scripts/test-business-setup

Expected failure:

    AssertionError: 'My Company' != 'Open Smart Irrigation'

If the command exits 0 or TestBusinessSetup is absent from the log, stop and repair test discovery.

### Step 3: Replace hooks.py with the complete setup hook

    import os

    from odoo.exceptions import UserError


    def _required_environment(name):
        value = os.environ.get(name, "")
        if not value:
            raise UserError(f"Missing required environment variable: {name}")
        if any(char in value for char in ("\x00", "\r", "\n")):
            raise UserError(f"Control character in environment variable: {name}")
        return value


    def _register_external_id(env, module, name, record):
        data = env["ir.model.data"].sudo()
        existing = data.search(
            [("module", "=", module), ("name", "=", name)], limit=1
        )
        if existing:
            if existing.model != record._name or existing.res_id != record.id:
                raise UserError(
                    f"External ID collision: {module}.{name}"
                )
            return existing
        return data.create(
            {
                "module": module,
                "name": name,
                "model": record._name,
                "res_id": record.id,
                "noupdate": True,
            }
        )


    def post_init_hook(env):
        company = env.ref("base.main_company")
        switzerland = env.ref("base.ch")
        chf = env.ref("base.CHF")

        if company.chart_template and company.chart_template != "ch":
            raise UserError(
                "Refusing to replace non-Swiss chart template "
                f"{company.chart_template!r}"
            )

        company.write(
            {
                "name": "Open Smart Irrigation",
                "country_id": switzerland.id,
                "currency_id": chf.id,
            }
        )
        if not company.resource_calendar_id:
            raise UserError("Main company has no resource calendar")
        company.resource_calendar_id.write({"tz": "Europe/Zurich"})

        env["account.chart.template"].try_loading(
            "ch", company, install_demo=False
        )
        if company.chart_template != "ch":
            raise UserError("Swiss chart template did not load")

        admin = env.ref("base.user_admin")
        admin.write(
            {
                "login": _required_environment("OSI_ODOO_ADMIN_LOGIN"),
                "password": _required_environment(
                    "OSI_ODOO_ADMIN_PASSWORD"
                ),
                "tz": "Europe/Zurich",
            }
        )

        warehouses = env["stock.warehouse"].search(
            [("company_id", "=", company.id)]
        )
        if len(warehouses) != 1:
            raise UserError(
                "Expected exactly one default warehouse for the main "
                f"company; found {len(warehouses)}"
            )
        warehouse = warehouses.ensure_one()
        warehouse.write({"name": "OSI Warehouse", "code": "OSI"})
        _register_external_id(
            env, "osi_business_setup", "warehouse_osi", warehouse
        )

### Step 4: Create the exact business catalog

addons/osi_business_setup/data/business_data.xml:

    <?xml version="1.0" encoding="utf-8"?>
    <odoo noupdate="1">
      <record id="product_gateway" model="product.template">
        <field name="name">OSI Gateway</field>
        <field name="default_code">OSI-GATEWAY</field>
        <field name="type">consu</field>
        <field name="is_storable">True</field>
        <field name="tracking">serial</field>
        <field name="list_price">890.00</field>
      </record>
      <record id="product_kiwi" model="product.template">
        <field name="name">KIWI Sensor</field>
        <field name="default_code">OSI-KIWI</field>
        <field name="type">consu</field>
        <field name="is_storable">True</field>
        <field name="tracking">serial</field>
      </record>
      <record id="product_clover" model="product.template">
        <field name="name">Tektelic Clover Sensor</field>
        <field name="default_code">OSI-CLOVER</field>
        <field name="type">consu</field>
        <field name="is_storable">True</field>
        <field name="tracking">serial</field>
      </record>
      <record id="product_lsn50" model="product.template">
        <field name="name">Dragino LSN50 Sensor Node</field>
        <field name="default_code">OSI-LSN50</field>
        <field name="type">consu</field>
        <field name="is_storable">True</field>
        <field name="tracking">serial</field>
      </record>
      <record id="product_s2120" model="product.template">
        <field name="name">SenseCAP S2120 Weather Sensor</field>
        <field name="default_code">OSI-S2120</field>
        <field name="type">consu</field>
        <field name="is_storable">True</field>
        <field name="tracking">serial</field>
      </record>
      <record id="product_lorain" model="product.template">
        <field name="name">Aqua-Scope LoRain Gauge</field>
        <field name="default_code">OSI-LORAIN</field>
        <field name="type">consu</field>
        <field name="is_storable">True</field>
        <field name="tracking">serial</field>
      </record>
      <record id="product_strega" model="product.template">
        <field name="name">STREGA Valve</field>
        <field name="default_code">OSI-STREGA</field>
        <field name="type">consu</field>
        <field name="is_storable">True</field>
        <field name="tracking">serial</field>
      </record>

      <record id="service_site_assessment" model="product.template">
        <field name="name">Site Assessment</field>
        <field name="default_code">OSI-SVC-ASSESSMENT</field>
        <field name="type">service</field>
        <field name="invoice_policy">order</field>
      </record>
      <record id="service_installation" model="product.template">
        <field name="name">Installation and Commissioning</field>
        <field name="default_code">OSI-SVC-INSTALL</field>
        <field name="type">service</field>
        <field name="invoice_policy">order</field>
      </record>
      <record id="service_operator_training" model="product.template">
        <field name="name">Operator Training</field>
        <field name="default_code">OSI-SVC-TRAINING</field>
        <field name="type">service</field>
        <field name="invoice_policy">order</field>
      </record>
      <record id="service_maintenance_support" model="product.template">
        <field name="name">Maintenance and Support</field>
        <field name="default_code">OSI-SVC-SUPPORT</field>
        <field name="type">service</field>
        <field name="invoice_policy">order</field>
      </record>
    </odoo>

### Step 5: Run the module gate

Run:

    python3 -m compileall -q addons/osi_business_setup
    scripts/test-business-setup
    git diff --check

Expected: TestBusinessSetup is discovered and the command exits 0.

Stop on:

- Missing OSI_ODOO_ADMIN_LOGIN or OSI_ODOO_ADMIN_PASSWORD.
- A non-Swiss existing chart.
- Zero or multiple company warehouses.
- Missing Swiss journal or account categories.
- Any assertion involving Task 4 project-template fields.

### Step 6: Commit

    git add addons/osi_business_setup scripts/test-module \
      scripts/test-business-setup
    git commit -m "feat: configure Swiss Odoo business data"

## Task 4: Add project templates and sales-to-project linkage

**Files:**

- Create: addons/osi_business_setup/data/project_data.xml
- Modify: addons/osi_business_setup/__manifest__.py
- Modify: addons/osi_business_setup/tests/__init__.py
- Create: addons/osi_business_setup/tests/test_projects.py
- Create: scripts/test-projects

### Step 1: Import and write the failing project tests

Replace addons/osi_business_setup/tests/__init__.py with:

    from . import test_business_setup
    from . import test_projects

Create addons/osi_business_setup/tests/test_projects.py:

    from odoo.fields import Command
    from odoo.tests.common import TransactionCase, tagged


    @tagged("post_install", "-at_install")
    class TestOsiProjects(TransactionCase):
        def test_exact_template_configuration(self):
            expected_stages = [
                ("Backlog", 10, False),
                ("Ready", 20, False),
                ("In Progress", 30, False),
                ("Field Validation", 40, False),
                ("Blocked", 50, False),
                ("Done", 60, True),
            ]
            stages = [
                self.env.ref(f"osi_business_setup.stage_{xml_name}")
                for xml_name in (
                    "backlog",
                    "ready",
                    "in_progress",
                    "field_validation",
                    "blocked",
                    "done",
                )
            ]
            self.assertEqual(
                [(stage.name, stage.sequence, stage.fold) for stage in stages],
                expected_stages,
            )

            tag_names = {
                self.env.ref(f"osi_business_setup.tag_{xml_name}").name
                for xml_name in (
                    "hardware",
                    "firmware",
                    "edge_os",
                    "cloud",
                    "agronomy",
                    "deployment",
                    "training",
                    "support",
                )
            }
            self.assertEqual(
                tag_names,
                {
                    "Hardware",
                    "Firmware",
                    "Edge OS",
                    "Cloud",
                    "Agronomy",
                    "Deployment",
                    "Training",
                    "Support",
                },
            )

            templates = [
                self.env.ref(f"osi_business_setup.{xml_name}")
                for xml_name in (
                    "project_template_customer_deployment",
                    "project_template_gateway_commissioning",
                    "project_template_preventive_maintenance",
                    "project_template_training_handover",
                    "project_template_research_grant",
                )
            ]
            self.assertEqual(len(templates), 5)
            for template in templates:
                self.assertTrue(template.is_template)
                self.assertTrue(template.allow_task_dependencies)
                self.assertTrue(template.allow_milestones)
                self.assertTrue(template.allow_recurring_tasks)
                self.assertTrue(template.allow_timesheets)
                self.assertEqual(
                    template.type_ids,
                    self.env["project.task.type"].browse(
                        [stage.id for stage in stages]
                    ),
                )

            deployment = templates[0]
            tasks = deployment.tasks.filtered(
                lambda task: task.parent_id.id is False
            ).sorted("sequence")
            expected_names = [
                "Confirm scope and customer contacts",
                "Complete site survey",
                "Prepare gateway and devices",
                "Configure connectivity",
                "Install gateway",
                "Install and assign sensors or valves",
                "Validate uplinks and measurements",
                "Train operators",
                "Complete handover",
            ]
            self.assertEqual(tasks.mapped("name"), expected_names)
            self.assertEqual(
                tasks.mapped("allocated_hours"),
                [2.0, 6.0, 4.0, 3.0, 4.0, 8.0, 4.0, 3.0, 2.0],
            )
            self.assertFalse(any(tasks.mapped("is_template")))
            self.assertTrue(all(task.stage_id == stages[0] for task in tasks))

            milestone_names = [
                "Site ready",
                "Site ready",
                "Hardware installed",
                "Hardware installed",
                "Hardware installed",
                "Hardware installed",
                "Data validated",
                "Handover accepted",
                "Handover accepted",
            ]
            self.assertEqual(
                [task.milestone_id.name for task in tasks], milestone_names
            )
            self.assertFalse(tasks[0].depend_on_ids)
            for index in range(1, len(tasks)):
                self.assertEqual(tasks[index].depend_on_ids, tasks[index - 1])

        def test_sale_creates_non_template_project_copy(self):
            partner = self.env["res.partner"].create(
                {"name": "Project Template Test Customer"}
            )
            service = self.env.ref(
                "osi_business_setup.service_installation"
            )
            template = self.env.ref(
                "osi_business_setup.project_template_customer_deployment"
            )
            self.assertEqual(service.type, "service")
            self.assertEqual(service.service_tracking, "project_only")
            self.assertEqual(service.service_policy, "ordered_prepaid")
            self.assertEqual(service.project_template_id, template)

            order = self.env["sale.order"].create(
                {
                    "partner_id": partner.id,
                    "order_line": [
                        Command.create(
                            {
                                "product_id": service.product_variant_id.id,
                                "product_uom_qty": 1,
                            }
                        )
                    ],
                }
            )
            order.action_confirm()
            line = order.order_line
            project = line.project_id
            self.assertTrue(project)
            self.assertFalse(project.is_template)
            self.assertEqual(project.sale_order_id, order)
            self.assertEqual(len(project.tasks), 9)
            self.assertFalse(any(project.tasks.mapped("is_template")))
            self.assertTrue(
                all(
                    dependency.project_id == project
                    for task in project.tasks
                    for dependency in task.depend_on_ids
                )
            )
            self.assertTrue(
                all(
                    milestone.project_id == project
                    for milestone in project.milestone_ids
                )
            )

The first red run must discover TestOsiProjects and fail because stage_backlog does not exist. A module-not-found result or a zero-test pass is not accepted.

scripts/test-projects:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    "$SCRIPT_DIR/test-module" osi_business_setup TestOsiProjects \
      test_exact_template_configuration
    "$SCRIPT_DIR/test-module" osi_business_setup TestOsiProjects \
      test_sale_creates_non_template_project_copy
    echo "PASS: both TestOsiProjects methods discovered exactly once"

Run:

    chmod 0700 scripts/test-projects
    scripts/test-projects

Expected named failure:

    ValueError: External ID not found in the system: osi_business_setup.stage_backlog

### Step 2: Create the complete project data

addons/osi_business_setup/data/project_data.xml:

    <?xml version="1.0" encoding="utf-8"?>
    <odoo noupdate="1">
      <record id="project_template_customer_deployment"
              model="project.project">
        <field name="name">Customer irrigation deployment</field>
        <field name="is_template">True</field>
        <field name="privacy_visibility">invited_users</field>
        <field name="allow_task_dependencies">True</field>
        <field name="allow_milestones">True</field>
        <field name="allow_recurring_tasks">True</field>
        <field name="allow_timesheets">True</field>
      </record>
      <record id="project_template_gateway_commissioning"
              model="project.project">
        <field name="name">Gateway and sensor commissioning</field>
        <field name="is_template">True</field>
        <field name="privacy_visibility">invited_users</field>
        <field name="allow_task_dependencies">True</field>
        <field name="allow_milestones">True</field>
        <field name="allow_recurring_tasks">True</field>
        <field name="allow_timesheets">True</field>
      </record>
      <record id="project_template_preventive_maintenance"
              model="project.project">
        <field name="name">Preventive maintenance visit</field>
        <field name="is_template">True</field>
        <field name="privacy_visibility">invited_users</field>
        <field name="allow_task_dependencies">True</field>
        <field name="allow_milestones">True</field>
        <field name="allow_recurring_tasks">True</field>
        <field name="allow_timesheets">True</field>
      </record>
      <record id="project_template_training_handover"
              model="project.project">
        <field name="name">Training and handover</field>
        <field name="is_template">True</field>
        <field name="privacy_visibility">invited_users</field>
        <field name="allow_task_dependencies">True</field>
        <field name="allow_milestones">True</field>
        <field name="allow_recurring_tasks">True</field>
        <field name="allow_timesheets">True</field>
      </record>
      <record id="project_template_research_grant"
              model="project.project">
        <field name="name">Research or grant work package</field>
        <field name="is_template">True</field>
        <field name="privacy_visibility">followers</field>
        <field name="allow_task_dependencies">True</field>
        <field name="allow_milestones">True</field>
        <field name="allow_recurring_tasks">True</field>
        <field name="allow_timesheets">True</field>
      </record>

      <record id="tag_hardware" model="project.tags">
        <field name="name">Hardware</field>
        <field name="color">1</field>
      </record>
      <record id="tag_firmware" model="project.tags">
        <field name="name">Firmware</field>
        <field name="color">2</field>
      </record>
      <record id="tag_edge_os" model="project.tags">
        <field name="name">Edge OS</field>
        <field name="color">3</field>
      </record>
      <record id="tag_cloud" model="project.tags">
        <field name="name">Cloud</field>
        <field name="color">4</field>
      </record>
      <record id="tag_agronomy" model="project.tags">
        <field name="name">Agronomy</field>
        <field name="color">5</field>
      </record>
      <record id="tag_deployment" model="project.tags">
        <field name="name">Deployment</field>
        <field name="color">6</field>
      </record>
      <record id="tag_training" model="project.tags">
        <field name="name">Training</field>
        <field name="color">7</field>
      </record>
      <record id="tag_support" model="project.tags">
        <field name="name">Support</field>
        <field name="color">8</field>
      </record>

      <record id="stage_backlog" model="project.task.type">
        <field name="name">Backlog</field>
        <field name="sequence">10</field>
        <field name="project_ids"
               eval="[(6, 0, [ref('project_template_customer_deployment'),
                              ref('project_template_gateway_commissioning'),
                              ref('project_template_preventive_maintenance'),
                              ref('project_template_training_handover'),
                              ref('project_template_research_grant')])]"/>
      </record>
      <record id="stage_ready" model="project.task.type">
        <field name="name">Ready</field>
        <field name="sequence">20</field>
        <field name="project_ids"
               eval="[(6, 0, [ref('project_template_customer_deployment'),
                              ref('project_template_gateway_commissioning'),
                              ref('project_template_preventive_maintenance'),
                              ref('project_template_training_handover'),
                              ref('project_template_research_grant')])]"/>
      </record>
      <record id="stage_in_progress" model="project.task.type">
        <field name="name">In Progress</field>
        <field name="sequence">30</field>
        <field name="project_ids"
               eval="[(6, 0, [ref('project_template_customer_deployment'),
                              ref('project_template_gateway_commissioning'),
                              ref('project_template_preventive_maintenance'),
                              ref('project_template_training_handover'),
                              ref('project_template_research_grant')])]"/>
      </record>
      <record id="stage_field_validation" model="project.task.type">
        <field name="name">Field Validation</field>
        <field name="sequence">40</field>
        <field name="project_ids"
               eval="[(6, 0, [ref('project_template_customer_deployment'),
                              ref('project_template_gateway_commissioning'),
                              ref('project_template_preventive_maintenance'),
                              ref('project_template_training_handover'),
                              ref('project_template_research_grant')])]"/>
      </record>
      <record id="stage_blocked" model="project.task.type">
        <field name="name">Blocked</field>
        <field name="sequence">50</field>
        <field name="project_ids"
               eval="[(6, 0, [ref('project_template_customer_deployment'),
                              ref('project_template_gateway_commissioning'),
                              ref('project_template_preventive_maintenance'),
                              ref('project_template_training_handover'),
                              ref('project_template_research_grant')])]"/>
      </record>
      <record id="stage_done" model="project.task.type">
        <field name="name">Done</field>
        <field name="sequence">60</field>
        <field name="fold">True</field>
        <field name="project_ids"
               eval="[(6, 0, [ref('project_template_customer_deployment'),
                              ref('project_template_gateway_commissioning'),
                              ref('project_template_preventive_maintenance'),
                              ref('project_template_training_handover'),
                              ref('project_template_research_grant')])]"/>
      </record>

      <record id="milestone_site_ready" model="project.milestone">
        <field name="name">Site ready</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
      </record>
      <record id="milestone_hardware_installed" model="project.milestone">
        <field name="name">Hardware installed</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
      </record>
      <record id="milestone_data_validated" model="project.milestone">
        <field name="name">Data validated</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
      </record>
      <record id="milestone_handover_accepted" model="project.milestone">
        <field name="name">Handover accepted</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
      </record>

      <record id="task_confirm_scope" model="project.task">
        <field name="name">Confirm scope and customer contacts</field>
        <field name="sequence">10</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
        <field name="stage_id" ref="stage_backlog"/>
        <field name="is_template">False</field>
        <field name="allocated_hours">2</field>
        <field name="milestone_id" ref="milestone_site_ready"/>
        <field name="tag_ids"
               eval="[(6, 0, [ref('tag_deployment')])]"/>
        <field name="user_ids"
               eval="[(6, 0, [ref('base.user_admin')])]"/>
      </record>
      <record id="task_site_survey" model="project.task">
        <field name="name">Complete site survey</field>
        <field name="sequence">20</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
        <field name="stage_id" ref="stage_backlog"/>
        <field name="is_template">False</field>
        <field name="allocated_hours">6</field>
        <field name="milestone_id" ref="milestone_site_ready"/>
        <field name="depend_on_ids"
               eval="[(6, 0, [ref('task_confirm_scope')])]"/>
        <field name="tag_ids"
               eval="[(6, 0, [ref('tag_agronomy'),
                              ref('tag_deployment')])]"/>
        <field name="user_ids"
               eval="[(6, 0, [ref('base.user_admin')])]"/>
      </record>
      <record id="task_prepare_hardware" model="project.task">
        <field name="name">Prepare gateway and devices</field>
        <field name="sequence">30</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
        <field name="stage_id" ref="stage_backlog"/>
        <field name="is_template">False</field>
        <field name="allocated_hours">4</field>
        <field name="milestone_id" ref="milestone_hardware_installed"/>
        <field name="depend_on_ids"
               eval="[(6, 0, [ref('task_site_survey')])]"/>
        <field name="tag_ids"
               eval="[(6, 0, [ref('tag_hardware')])]"/>
        <field name="user_ids"
               eval="[(6, 0, [ref('base.user_admin')])]"/>
      </record>
      <record id="task_connectivity" model="project.task">
        <field name="name">Configure connectivity</field>
        <field name="sequence">40</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
        <field name="stage_id" ref="stage_backlog"/>
        <field name="is_template">False</field>
        <field name="allocated_hours">3</field>
        <field name="milestone_id" ref="milestone_hardware_installed"/>
        <field name="depend_on_ids"
               eval="[(6, 0, [ref('task_prepare_hardware')])]"/>
        <field name="tag_ids"
               eval="[(6, 0, [ref('tag_edge_os'),
                              ref('tag_cloud')])]"/>
        <field name="user_ids"
               eval="[(6, 0, [ref('base.user_admin')])]"/>
      </record>
      <record id="task_install_gateway" model="project.task">
        <field name="name">Install gateway</field>
        <field name="sequence">50</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
        <field name="stage_id" ref="stage_backlog"/>
        <field name="is_template">False</field>
        <field name="allocated_hours">4</field>
        <field name="milestone_id" ref="milestone_hardware_installed"/>
        <field name="depend_on_ids"
               eval="[(6, 0, [ref('task_connectivity')])]"/>
        <field name="tag_ids"
               eval="[(6, 0, [ref('tag_hardware'),
                              ref('tag_deployment')])]"/>
        <field name="user_ids"
               eval="[(6, 0, [ref('base.user_admin')])]"/>
      </record>
      <record id="task_install_devices" model="project.task">
        <field name="name">Install and assign sensors or valves</field>
        <field name="sequence">60</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
        <field name="stage_id" ref="stage_backlog"/>
        <field name="is_template">False</field>
        <field name="allocated_hours">8</field>
        <field name="milestone_id" ref="milestone_hardware_installed"/>
        <field name="depend_on_ids"
               eval="[(6, 0, [ref('task_install_gateway')])]"/>
        <field name="tag_ids"
               eval="[(6, 0, [ref('tag_hardware'),
                              ref('tag_deployment')])]"/>
        <field name="user_ids"
               eval="[(6, 0, [ref('base.user_admin')])]"/>
      </record>
      <record id="task_validate_data" model="project.task">
        <field name="name">Validate uplinks and measurements</field>
        <field name="sequence">70</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
        <field name="stage_id" ref="stage_backlog"/>
        <field name="is_template">False</field>
        <field name="allocated_hours">4</field>
        <field name="milestone_id" ref="milestone_data_validated"/>
        <field name="depend_on_ids"
               eval="[(6, 0, [ref('task_install_devices')])]"/>
        <field name="tag_ids"
               eval="[(6, 0, [ref('tag_agronomy'),
                              ref('tag_edge_os'),
                              ref('tag_cloud')])]"/>
        <field name="user_ids"
               eval="[(6, 0, [ref('base.user_admin')])]"/>
      </record>
      <record id="task_train_operators" model="project.task">
        <field name="name">Train operators</field>
        <field name="sequence">80</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
        <field name="stage_id" ref="stage_backlog"/>
        <field name="is_template">False</field>
        <field name="allocated_hours">3</field>
        <field name="milestone_id" ref="milestone_handover_accepted"/>
        <field name="depend_on_ids"
               eval="[(6, 0, [ref('task_validate_data')])]"/>
        <field name="tag_ids"
               eval="[(6, 0, [ref('tag_training')])]"/>
        <field name="user_ids"
               eval="[(6, 0, [ref('base.user_admin')])]"/>
      </record>
      <record id="task_handover" model="project.task">
        <field name="name">Complete handover</field>
        <field name="sequence">90</field>
        <field name="project_id"
               ref="project_template_customer_deployment"/>
        <field name="stage_id" ref="stage_backlog"/>
        <field name="is_template">False</field>
        <field name="allocated_hours">2</field>
        <field name="milestone_id" ref="milestone_handover_accepted"/>
        <field name="depend_on_ids"
               eval="[(6, 0, [ref('task_train_operators')])]"/>
        <field name="tag_ids"
               eval="[(6, 0, [ref('tag_deployment'),
                              ref('tag_support')])]"/>
        <field name="user_ids"
               eval="[(6, 0, [ref('base.user_admin')])]"/>
      </record>

      <record id="service_installation" model="product.template">
        <field name="type">service</field>
        <field name="invoice_policy">order</field>
        <field name="service_tracking">project_only</field>
        <field name="service_policy">ordered_prepaid</field>
        <field name="project_template_id"
               ref="project_template_customer_deployment"/>
      </record>
    </odoo>

### Step 3: Add project_data.xml to the manifest

The final data list is:

    "data": [
        "data/business_data.xml",
        "data/project_data.xml",
    ],

Do not change the dependency list or hook.

### Step 4: Run exact discovery and behavior gates

Run:

    python3 -m compileall -q addons/osi_business_setup
    scripts/test-projects
    git diff --check

Expected runtime signals:

    PASS: discovered TestOsiProjects.test_exact_template_configuration exactly once
    PASS: discovered TestOsiProjects.test_sale_creates_non_template_project_copy exactly once
    PASS: both TestOsiProjects methods discovered exactly once

Absence, duplication, or failure of either individually selected method is a stop condition. Also run this structural gate; it does not substitute for the runtime gate:

    test "$(grep -c 'def test_' \
      addons/osi_business_setup/tests/test_projects.py)" -eq 2
    grep -q 'from . import test_projects' \
      addons/osi_business_setup/tests/__init__.py
    test "$(grep -c '<field name="is_template">True</field>' \
      addons/osi_business_setup/data/project_data.xml)" -eq 5
    test "$(grep -c '<field name="is_template">False</field>' \
      addons/osi_business_setup/data/project_data.xml)" -eq 9

### Step 5: Commit

    git add addons/osi_business_setup scripts/test-projects
    git commit -m "feat: add OSI project delivery templates"

## Task 5: Add the idempotent and removable OSI business demo

**Files:**

- Create: addons/osi_business_demo/__init__.py
- Create: addons/osi_business_demo/__manifest__.py
- Create: addons/osi_business_demo/hooks.py
- Create: addons/osi_business_demo/tests/__init__.py
- Create: addons/osi_business_demo/tests/test_demo.py
- Create: scripts/test-demo
- Create: scripts/test-demo-lifecycle

### Step 1: Scaffold the module and write the failing tests

addons/osi_business_demo/__init__.py:

    from .hooks import ensure_demo, post_init_hook

addons/osi_business_demo/__manifest__.py:

    {
        "name": "OSI Business Demo",
        "version": "19.0.1.0.0",
        "category": "Operations",
        "license": "LGPL-3",
        "depends": ["osi_business_setup"],
        "post_init_hook": "post_init_hook",
        "installable": True,
        "application": False,
    }

Create the initial addons/osi_business_demo/hooks.py:

    def ensure_demo(env):
        return {}


    def post_init_hook(env):
        ensure_demo(env)

addons/osi_business_demo/tests/__init__.py:

    from . import test_demo

addons/osi_business_demo/tests/test_demo.py:

    from odoo.tests.common import TransactionCase, tagged

    from odoo.addons.osi_business_demo.hooks import ensure_demo


    @tagged("post_install", "-at_install")
    class TestOsiBusinessDemo(TransactionCase):
        def test_complete_idempotent_demo(self):
            users_before = self.env["res.users"].search_count([])
            first = ensure_demo(self.env)
            second = ensure_demo(self.env)
            self.assertEqual(
                {key: value.id for key, value in first.items()},
                {key: value.id for key, value in second.items()},
            )
            self.assertEqual(
                self.env["res.users"].search_count([]), users_before
            )

            customer = self.env.ref("osi_business_demo.demo_customer")
            supplier = self.env.ref("osi_business_demo.demo_supplier")
            lead = self.env.ref("osi_business_demo.demo_opportunity")
            quote = self.env.ref("osi_business_demo.demo_quotation")
            sale = self.env.ref("osi_business_demo.demo_sale")
            receipt = self.env.ref("osi_business_demo.demo_receipt")
            delivery = self.env.ref("osi_business_demo.demo_delivery")
            invoice = self.env.ref("osi_business_demo.demo_invoice")
            project = self.env.ref("osi_business_demo.demo_project")
            lot = self.env.ref("osi_business_demo.demo_gateway_lot")

            self.assertEqual(customer.name, "DEMO Farm Zürich")
            self.assertEqual(supplier.name, "DEMO Sensor Supplier AG")
            self.assertIn("DEMO", lead.name)
            self.assertEqual(quote.state, "draft")
            self.assertEqual(sale.state, "sale")
            self.assertEqual(receipt.state, "done")
            self.assertEqual(delivery.state, "done")
            self.assertEqual(invoice.state, "draft")
            self.assertFalse(project.is_template)
            self.assertEqual(len(project.tasks), 9)
            self.assertFalse(any(project.tasks.mapped("is_template")))

            move_lines = receipt.move_line_ids | delivery.move_line_ids
            self.assertTrue(move_lines)
            self.assertTrue(all(line.quantity == 1 for line in move_lines))
            self.assertEqual(move_lines.lot_id, lot)
            self.assertEqual(lot.name, "DEMO-GATEWAY-0001")

            gateway = self.env.ref(
                "osi_business_setup.product_gateway"
            ).product_variant_id
            negative = self.env["stock.quant"].search_count(
                [
                    ("product_id", "=", gateway.id),
                    ("quantity", "<", 0),
                ]
            )
            self.assertEqual(negative, 0)

            external_ids = self.env["ir.model.data"].search(
                [("module", "=", "osi_business_demo")]
            )
            models = set(external_ids.mapped("model"))
            for required_model in (
                "res.partner",
                "crm.lead",
                "sale.order",
                "sale.order.line",
                "stock.picking",
                "stock.move",
                "stock.move.line",
                "stock.lot",
                "stock.quant",
                "procurement.group",
                "account.move",
                "account.move.line",
                "project.project",
                "project.task",
                "project.milestone",
            ):
                self.assertIn(required_model, models)

The initial empty ensure_demo makes this fail at the demo_customer lookup. The named expected failure is:

    ValueError: External ID not found in the system: osi_business_demo.demo_customer

### Step 2: Replace hooks.py with the complete workflow

    from odoo import Command
    from odoo.exceptions import UserError


    ROOT_IDS = (
        "demo_customer",
        "demo_supplier",
        "demo_opportunity",
        "demo_quotation",
        "demo_sale",
        "demo_receipt",
        "demo_delivery",
        "demo_invoice",
        "demo_project",
        "demo_gateway_lot",
    )


    def _register(env, name, record):
        record.ensure_one()
        data = env["ir.model.data"].sudo()
        existing = data.search(
            [
                ("module", "=", "osi_business_demo"),
                ("name", "=", name),
            ],
            limit=1,
        )
        if existing:
            if existing.model != record._name or existing.res_id != record.id:
                raise UserError(
                    f"External ID collision: osi_business_demo.{name}"
                )
            return
        data.create(
            {
                "module": "osi_business_demo",
                "name": name,
                "model": record._name,
                "res_id": record.id,
                "noupdate": True,
            }
        )


    def _register_many(env, prefix, records):
        for index, record in enumerate(records.sorted("id"), start=1):
            _register(env, f"{prefix}_{index:03d}", record)


    def _existing_roots(env):
        roots = {
            name: env.ref(
                f"osi_business_demo.{name}", raise_if_not_found=False
            )
            for name in ROOT_IDS
        }
        present = {name for name, record in roots.items() if record}
        if present and len(present) != len(ROOT_IDS):
            missing = sorted(set(ROOT_IDS) - present)
            raise UserError(
                "Partial OSI demo ownership; missing external IDs: "
                + ", ".join(missing)
            )
        return roots if present else None


    def ensure_demo(env):
        existing = _existing_roots(env)
        if existing:
            return existing

        company = env.ref("base.main_company")
        warehouse = env.ref("osi_business_setup.warehouse_osi")
        gateway = env.ref(
            "osi_business_setup.product_gateway"
        ).product_variant_id
        installation = env.ref(
            "osi_business_setup.service_installation"
        ).product_variant_id
        assessment = env.ref(
            "osi_business_setup.service_site_assessment"
        ).product_variant_id

        customer = env["res.partner"].create(
            {
                "name": "DEMO Farm Zürich",
                "ref": "DEMO-CUSTOMER",
                "customer_rank": 1,
                "country_id": env.ref("base.ch").id,
            }
        )
        supplier = env["res.partner"].create(
            {
                "name": "DEMO Sensor Supplier AG",
                "ref": "DEMO-SUPPLIER",
                "supplier_rank": 1,
                "country_id": env.ref("base.ch").id,
            }
        )
        lead = env["crm.lead"].create(
            {
                "name": "DEMO Irrigation modernization",
                "partner_id": customer.id,
                "type": "opportunity",
                "expected_revenue": 2500.0,
            }
        )

        quotation = env["sale.order"].create(
            {
                "partner_id": customer.id,
                "client_order_ref": "DEMO-QUOTATION",
                "order_line": [
                    Command.create(
                        {
                            "product_id": assessment.id,
                            "product_uom_qty": 1,
                        }
                    )
                ],
            }
        )

        lot = env["stock.lot"].create(
            {
                "name": "DEMO-GATEWAY-0001",
                "product_id": gateway.id,
                "company_id": company.id,
            }
        )
        receipt = env["stock.picking"].create(
            {
                "partner_id": supplier.id,
                "picking_type_id": warehouse.in_type_id.id,
                "location_id": warehouse.in_type_id.default_location_src_id.id,
                "location_dest_id": warehouse.lot_stock_id.id,
                "origin": "DEMO-RECEIPT",
            }
        )
        receipt_move = env["stock.move"].create(
            {
                "name": "DEMO OSI Gateway receipt",
                "picking_id": receipt.id,
                "product_id": gateway.id,
                "product_uom_qty": 1,
                "product_uom": gateway.uom_id.id,
                "location_id": receipt.location_id.id,
                "location_dest_id": receipt.location_dest_id.id,
            }
        )
        receipt_move._action_confirm()
        env["stock.move.line"].create(
            {
                "move_id": receipt_move.id,
                "picking_id": receipt.id,
                "product_id": gateway.id,
                "product_uom_id": gateway.uom_id.id,
                "location_id": receipt.location_id.id,
                "location_dest_id": receipt.location_dest_id.id,
                "lot_id": lot.id,
                "quantity": 1,
                "picked": True,
            }
        )
        receipt._action_done()
        if receipt.state != "done":
            raise UserError("DEMO receipt did not complete")

        sale = env["sale.order"].create(
            {
                "partner_id": customer.id,
                "client_order_ref": "DEMO-CONFIRMED-SALE",
                "opportunity_id": lead.id,
                "order_line": [
                    Command.create(
                        {
                            "product_id": gateway.id,
                            "product_uom_qty": 1,
                        }
                    ),
                    Command.create(
                        {
                            "product_id": installation.id,
                            "product_uom_qty": 1,
                        }
                    ),
                ],
            }
        )
        sale.action_confirm()
        delivery = sale.picking_ids.filtered(
            lambda picking: picking.picking_type_code == "outgoing"
        )
        if len(delivery) != 1:
            raise UserError(
                f"Expected one DEMO delivery; found {len(delivery)}"
            )
        delivery.action_assign()
        gateway_lines = delivery.move_line_ids.filtered(
            lambda line: line.product_id == gateway
        )
        if len(gateway_lines) != 1:
            raise UserError(
                "DEMO delivery did not reserve exactly one gateway"
            )
        gateway_lines.write(
            {"lot_id": lot.id, "quantity": 1, "picked": True}
        )
        delivery._action_done()
        if delivery.state != "done":
            raise UserError("DEMO delivery did not complete")

        invoice = sale._create_invoices()
        if len(invoice) != 1 or invoice.state != "draft":
            raise UserError("Expected one draft DEMO invoice")
        service_line = sale.order_line.filtered(
            lambda line: line.product_id == installation
        )
        project = service_line.project_id
        if len(project) != 1 or project.is_template:
            raise UserError("DEMO sale did not create a normal project")

        roots = {
            "demo_customer": customer,
            "demo_supplier": supplier,
            "demo_opportunity": lead,
            "demo_quotation": quotation,
            "demo_sale": sale,
            "demo_receipt": receipt,
            "demo_delivery": delivery,
            "demo_invoice": invoice,
            "demo_project": project,
            "demo_gateway_lot": lot,
        }
        for name, record in roots.items():
            _register(env, name, record)

        _register_many(env, "demo_quotation_line", quotation.order_line)
        _register_many(env, "demo_sale_line", sale.order_line)
        _register_many(env, "demo_receipt_move", receipt.move_ids)
        _register_many(env, "demo_receipt_move_line", receipt.move_line_ids)
        _register_many(env, "demo_delivery_move", delivery.move_ids)
        _register_many(env, "demo_delivery_move_line", delivery.move_line_ids)
        _register_many(env, "demo_invoice_line", invoice.line_ids)
        _register_many(env, "demo_project_task", project.tasks)
        _register_many(env, "demo_project_milestone", project.milestone_ids)
        if sale.procurement_group_id:
            _register(
                env,
                "demo_procurement_group",
                sale.procurement_group_id,
            )
        demo_quants = env["stock.quant"].search(
            [("product_id", "=", gateway.id), ("lot_id", "=", lot.id)]
        )
        _register_many(env, "demo_quant", demo_quants)

        if env["stock.quant"].search_count(
            [("product_id", "=", gateway.id), ("quantity", "<", 0)]
        ):
            raise UserError("DEMO workflow created negative gateway stock")
        return roots


    def post_init_hook(env):
        ensure_demo(env)

The receipt is deliberately completed before sale confirmation. The outgoing delivery is assigned, gets its unique lot and Odoo 19 quantity value, and is completed only after the reservation count is exactly one.

### Step 3: Create the install/idempotence test entrypoint

scripts/test-demo:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    exec "$SCRIPT_DIR/test-module" osi_business_demo TestOsiBusinessDemo

Run:

    chmod 0700 scripts/test-demo
    scripts/test-demo

Expected: TestOsiBusinessDemo is discovered and passes. This calls ensure_demo twice; an Odoo module upgrade alone is not accepted as the idempotence proof.

### Step 4: Run the separate lifecycle gate

Create scripts/test-demo-lifecycle. Its complete prologue is:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    TEST_REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
    export TEST_REPO_ROOT
    # shellcheck source=scripts/test-env
    . "$SCRIPT_DIR/test-env"
    create_test_environment bootstrap l
    trap destroy_test_environment EXIT
    test_root="$TEST_ROOT"
    project="$TEST_PROJECT"
    env_file="$TEST_ENV_FILE"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    require_disposable_project
    "$SCRIPT_DIR/render-config"
    compose_base up -d db
    wait_for_db

Append every command in the rest of this step to that file in the shown order. The EXIT trap keeps the same database alive for install, upgrade, uninstall, absence checks, and reinstall, then removes only the validated project.

    compose_base run --rm --no-deps \
      -e OSI_ODOO_ADMIN_LOGIN -e OSI_ODOO_ADMIN_PASSWORD \
      odoo odoo --config=/etc/odoo/odoo.conf \
      --database="$ODOO_DB_NAME" \
      --init=osi_business_demo --without-demo=all --stop-after-init

    compose_base run --rm --no-deps \
      -e OSI_ODOO_ADMIN_LOGIN -e OSI_ODOO_ADMIN_PASSWORD \
      odoo odoo --config=/etc/odoo/odoo.conf \
      --database="$ODOO_DB_NAME" \
      --update=osi_business_demo --without-demo=all --stop-after-init

Before uninstall, save the exact list of osi_business_demo external IDs and assert it is non-empty:

    compose_base exec -T db psql -U odoo_admin -d "$ODOO_DB_NAME" \
      -Atqc "SELECT model || ':' || res_id
             FROM ir_model_data
             WHERE module='osi_business_demo'
             ORDER BY model,res_id" >"$test_root/demo-owned.before"
    test -s "$test_root/demo-owned.before"

Uninstall from a separate Odoo shell process:

    printf '%s\n' \
      'env["ir.module.module"].search([("name", "=", "osi_business_demo")]).button_immediate_uninstall()' |
      compose_base run --rm --no-deps odoo \
      odoo shell --config=/etc/odoo/odoo.conf \
      --database="$ODOO_DB_NAME" --no-http

Run one read-only SQL assertion block:

    compose_base exec -T db psql -U odoo_admin -d "$ODOO_DB_NAME" \
      -v ON_ERROR_STOP=1 <<'SQL'
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM ir_model_data WHERE module='osi_business_demo'
      ) THEN RAISE EXCEPTION 'demo external IDs remain'; END IF;
      IF EXISTS (
        SELECT 1 FROM res_partner WHERE ref LIKE 'DEMO-%'
      ) THEN RAISE EXCEPTION 'demo partners remain'; END IF;
      IF EXISTS (
        SELECT 1 FROM sale_order
        WHERE client_order_ref LIKE 'DEMO-%'
      ) THEN RAISE EXCEPTION 'demo sales remain'; END IF;
      IF EXISTS (
        SELECT 1 FROM account_move WHERE ref LIKE 'DEMO-%'
      ) THEN RAISE EXCEPTION 'demo invoices remain'; END IF;
      IF EXISTS (
        SELECT 1 FROM stock_picking WHERE origin LIKE 'DEMO-%'
      ) THEN RAISE EXCEPTION 'demo pickings remain'; END IF;
      IF EXISTS (
        SELECT 1 FROM stock_lot WHERE name LIKE 'DEMO-%'
      ) THEN RAISE EXCEPTION 'demo lots remain'; END IF;
      IF (
        SELECT count(*)
        FROM ir_model_data d
        JOIN product_template p
          ON d.model='product.template' AND p.id=d.res_id
        WHERE d.module='osi_business_setup'
          AND d.name IN (
            'product_gateway','product_kiwi','product_clover',
            'product_lsn50','product_s2120','product_lorain','product_strega',
            'service_site_assessment','service_installation',
            'service_operator_training','service_maintenance_support'
          )
      ) != 11 THEN RAISE EXCEPTION 'one of eleven setup products was removed';
      END IF;
      IF (
        SELECT count(*)
        FROM ir_model_data d
        JOIN project_project p
          ON d.model='project.project' AND p.id=d.res_id
        WHERE d.module='osi_business_setup'
          AND d.name IN (
            'project_template_customer_deployment',
            'project_template_gateway_commissioning',
            'project_template_preventive_maintenance',
            'project_template_training_handover',
            'project_template_research_grant'
          )
          AND p.is_template
      ) != 5 THEN RAISE EXCEPTION 'one of five setup templates was removed';
      END IF;
      IF (
        SELECT count(*)
        FROM ir_model_data d
        JOIN project_task_type s
          ON d.model='project.task.type' AND s.id=d.res_id
        WHERE d.module='osi_business_setup'
          AND d.name IN (
            'stage_backlog','stage_ready','stage_in_progress',
            'stage_field_validation','stage_blocked','stage_done'
          )
      ) != 6 THEN RAISE EXCEPTION 'one of six setup stages was removed';
      END IF;
      IF (
        SELECT count(*)
        FROM ir_model_data d
        JOIN stock_warehouse w
          ON d.model='stock.warehouse' AND w.id=d.res_id
        WHERE d.module='osi_business_setup' AND d.name='warehouse_osi'
      ) != 1 THEN RAISE EXCEPTION 'setup warehouse was removed';
      END IF;
    END $$;
    SQL

Run this model-level absence loop for every saved external-ID target:

    while IFS=: read -r model record_id; do
      [[ "$model" =~ ^[a-z][a-z0-9_.]+$ ]]
      [[ "$record_id" =~ ^[0-9]+$ ]]
      export MODEL="$model" RECORD_ID="$record_id"
      result="$(printf '%s\n' \
        'import os' \
        'record = env[os.environ["MODEL"]].browse(int(os.environ["RECORD_ID"]))' \
        'print("PRESENT" if record.exists() else "ABSENT")' |
        compose_base run --rm --no-deps -e MODEL -e RECORD_ID odoo \
        odoo shell --config=/etc/odoo/odoo.conf \
        --database="$ODOO_DB_NAME" --no-http 2>/dev/null |
        tail -n 1)"
      if [[ "$result" != ABSENT ]]; then
        die "orphaned demo record $model:$record_id"
      fi
    done <"$test_root/demo-owned.before"

This covers sale.order.line, account.move.line, stock.move,
stock.move.line, stock.quant, procurement.group, project.task, and
project.milestone as well as every other registered target.

Reinstall and rerun scripts/test-demo against this same database:

    compose_base run --rm --no-deps \
      -e OSI_ODOO_ADMIN_LOGIN -e OSI_ODOO_ADMIN_PASSWORD \
      odoo odoo --config=/etc/odoo/odoo.conf \
      --database="$ODOO_DB_NAME" \
      --init=osi_business_demo --without-demo=all --stop-after-init

    compose_base run --rm --no-deps \
      -e OSI_ODOO_ADMIN_LOGIN -e OSI_ODOO_ADMIN_PASSWORD \
      odoo odoo --config=/etc/odoo/odoo.conf \
      --database="$ODOO_DB_NAME" \
      --update=osi_business_demo \
      --test-enable --test-tags=/osi_business_demo \
      --without-demo=all --stop-after-init 2>&1 | \
      tee "$test_root/reinstalled-demo-tests.log"
    grep -q TestOsiBusinessDemo \
      "$test_root/reinstalled-demo-tests.log"

    root_count="$(compose_base exec -T db psql -U odoo_admin \
      -d "$ODOO_DB_NAME" -Atqc \
      "SELECT count(*) FROM ir_model_data
       WHERE module='osi_business_demo'
         AND name IN ('demo_customer','demo_supplier','demo_opportunity',
                      'demo_quotation','demo_sale','demo_receipt',
                      'demo_delivery','demo_invoice','demo_project',
                      'demo_gateway_lot')")"
    [[ "$root_count" == 10 ]] || die "reinstall root count is not ten"

Expected: exactly one record for every ROOT_IDS external ID and no negative quant.

Stop and report plan divergence if module-owned uninstall cannot remove the done stock workflow. Do not invent cleanup code or weaken the absence assertions during execution.

### Step 5: Commit

    python3 -m compileall -q addons/osi_business_demo
    chmod 0700 scripts/test-demo-lifecycle
    scripts/test-demo-lifecycle
    git diff --check
    git add addons/osi_business_demo scripts/test-demo \
      scripts/test-demo-lifecycle
    git commit -m "feat: add removable OSI business demo"

## Task 6: Integrate final database initialization after both modules exist

**Files:**

- Create: scripts/init-database
- Create: scripts/test-init-database
- Create: scripts/test-coexistence
- Modify: scripts/lib.sh
- Modify: README.md

### Step 1: Add the runtime Compose selector

Append to scripts/lib.sh:

    compose_runtime() {
      case "${OSI_RUNTIME_MODE:-base}" in
        base) compose_base "$@" ;;
        production) compose_prod "$@" ;;
        *) die "invalid OSI_RUNTIME_MODE" ;;
      esac
    }

### Step 2: Create the exact initialization state machine

scripts/init-database:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    require_command docker

    if [[ "${OSI_RUNTIME_MODE:-base}" == base &&
          "$COMPOSE_PROJECT_NAME" == osi-odoo ]]; then
      die "base mode is forbidden for the deployed project"
    fi

    "$SCRIPT_DIR/render-config"
    compose_runtime up -d db
    wait_for_db

    registry_exists="$(compose_runtime exec -T db \
      psql -U odoo_admin -d "$ODOO_DB_NAME" -Atqc \
      "SELECT to_regclass('public.ir_module_module') IS NOT NULL")"
    module_state=""
    if [[ "$registry_exists" == t ]]; then
      module_state="$(compose_runtime exec -T db \
        psql -U odoo_admin -d "$ODOO_DB_NAME" -Atqc \
        "SELECT COALESCE(
           string_agg(name || '=' || state, ',' ORDER BY name), ''
         )
         FROM ir_module_module
         WHERE name IN ('osi_business_setup','osi_business_demo')")"
    fi

    case "$registry_exists:$module_state" in
      f:|t:|t:osi_business_demo=uninstalled,osi_business_setup=uninstalled)
        operation=init
        ;;
      t:osi_business_demo=installed,osi_business_setup=installed)
        operation=update
        ;;
      *)
        die "partial OSI module state; operator action required ($module_state)"
        ;;
    esac

    odoo_arguments=(
      odoo
      --config=/etc/odoo/odoo.conf
      --database="$ODOO_DB_NAME"
      --without-demo=all
      --stop-after-init
    )
    if [[ "$operation" == init ]]; then
      odoo_arguments+=(--init=osi_business_setup,osi_business_demo)
    else
      odoo_arguments+=(--update=osi_business_setup,osi_business_demo)
    fi

    compose_runtime run --rm --no-deps \
      -e OSI_ODOO_ADMIN_LOGIN \
      -e OSI_ODOO_ADMIN_PASSWORD \
      odoo "${odoo_arguments[@]}"

    final_state="$(compose_runtime exec -T db \
      psql -U odoo_admin -d "$ODOO_DB_NAME" -Atqc \
      "SELECT string_agg(name || '=' || state, ',' ORDER BY name)
       FROM ir_module_module
       WHERE name IN ('osi_business_setup','osi_business_demo')")"
    [[ "$final_state" == \
      'osi_business_demo=installed,osi_business_setup=installed' ]] ||
      die "module initialization ended in unexpected state: $final_state"

    printf 'PASS: module state machine completed %s\n' "$operation"

The exact mixed-state failure begins:

    ERROR: partial OSI module state; operator action required

It must occur before an Odoo module command.

### Step 3: Create the real integration test

scripts/test-init-database starts with this complete prologue:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
    TEST_REPO_ROOT="$REPO_ROOT"
    export TEST_REPO_ROOT
    # shellcheck source=scripts/test-env
    . "$SCRIPT_DIR/test-env"
    create_test_environment bootstrap i
    sampler_pid=""
    cleanup_init_test() {
      touch "${TEST_ROOT}/stop-memory-sampler" 2>/dev/null || true
      if [[ "$sampler_pid" =~ ^[0-9]+$ ]]; then
        kill "$sampler_pid" 2>/dev/null || true
        wait "$sampler_pid" 2>/dev/null || true
      fi
      destroy_test_environment
    }
    trap cleanup_init_test EXIT
    test_root="$TEST_ROOT"
    project="$TEST_PROJECT"
    database="$TEST_DATABASE"
    env_file="$TEST_ENV_FILE"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    require_disposable_project

Append this exact body:

    export OSI_ENV_FILE="$env_file"
    export OSI_RUNTIME_MODE=base
    [[ -f /sys/fs/cgroup/cgroup.controllers ]] ||
      die "aggregate memory gate requires host cgroup v2"
    printf '0\n' >"$test_root/db.peak-bytes"
    printf '0\n' >"$test_root/odoo.peak-bytes"
    container_cgroup_memory() {
      local container_id="$1" pid cgroup_path metric value
      pid="$(docker inspect -f '{{.State.Pid}}' "$container_id")"
      [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
      cgroup_path="$(awk -F: '$1 == "0" {print $3}' \
        "/proc/$pid/cgroup" 2>/dev/null || true)"
      [[ "$cgroup_path" == /* ]] || return 1
      for metric in memory.peak memory.current; do
        [[ -r "/sys/fs/cgroup${cgroup_path}/$metric" ]] || continue
        value="$(<"/sys/fs/cgroup${cgroup_path}/$metric")"
        if [[ "$value" =~ ^[0-9]+$ ]]; then
          printf '%s\n' "$value"
          return 0
        fi
      done
      return 1
    }
    sample_container_memory() {
      while [[ ! -e "$test_root/stop-memory-sampler" ]]; do
        local service container_id memory_bytes peak
        for service in db odoo; do
          while read -r container_id; do
            [[ -n "$container_id" ]] || continue
            memory_bytes="$(container_cgroup_memory "$container_id" || true)"
            [[ "$memory_bytes" =~ ^[0-9]+$ ]] || continue
            peak="$(<"$test_root/$service.peak-bytes")"
            if (( memory_bytes > peak )); then
              printf '%s\n' "$memory_bytes" >"$test_root/$service.peak-bytes"
            fi
          done < <(docker ps -q \
            --filter "label=com.docker.compose.project=$project" \
            --filter "label=com.docker.compose.service=$service")
        done
        sleep 0.2
      done
    }
    sample_container_memory &
    sampler_pid=$!
    "$SCRIPT_DIR/init-database" | tee "$test_root/first.log"
    touch "$test_root/stop-memory-sampler"
    wait "$sampler_pid"
    sampler_pid=""
    grep -q 'PASS: module state machine completed init' \
      "$test_root/first.log"

    db_id="$(compose_base ps -q db)"
    [[ "$(docker inspect -f '{{.HostConfig.Memory}}' "$db_id")" == 1073741824 ]]
    [[ "$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$db_id")" == 1000000000 ]]
    db_peak="$(<"$test_root/db.peak-bytes")"
    odoo_peak="$(<"$test_root/odoo.peak-bytes")"
    (( db_peak > 0 && db_peak <= 1073741824 )) ||
      die "PostgreSQL aggregate cgroup peak is absent or exceeds 1 GiB: $db_peak"
    (( odoo_peak > 0 && odoo_peak <= 2147483648 )) ||
      die "Odoo aggregate cgroup peak is absent or exceeds 2 GiB: $odoo_peak"
    printf 'PASS: aggregate cgroup memory db=%s odoo=%s within Compose caps\n' \
      "$db_peak" "$odoo_peak"

    first_counts="$(docker compose --env-file "$env_file" \
      --project-name "$project" -f "$REPO_ROOT/compose.yaml" \
      exec -T db psql -U odoo_admin -d "$database" -Atqc \
      "SELECT
         (SELECT count(*) FROM product_template
          WHERE default_code LIKE 'OSI-%') || '|' ||
         (SELECT count(*) FROM project_project
          WHERE is_template) || '|' ||
         (SELECT count(*) FROM ir_model_data
          WHERE module='osi_business_demo')")"

    "$SCRIPT_DIR/init-database" | tee "$test_root/second.log"
    grep -q 'PASS: module state machine completed update' \
      "$test_root/second.log"
    second_counts="$(docker compose --env-file "$env_file" \
      --project-name "$project" -f "$REPO_ROOT/compose.yaml" \
      exec -T db psql -U odoo_admin -d "$database" -Atqc \
      "SELECT
         (SELECT count(*) FROM product_template
          WHERE default_code LIKE 'OSI-%') || '|' ||
         (SELECT count(*) FROM project_project
          WHERE is_template) || '|' ||
         (SELECT count(*) FROM ir_model_data
          WHERE module='osi_business_demo')")"
    [[ "$first_counts" == "$second_counts" ]] ||
      die "rerun changed stable record counts"

    docker compose --env-file "$env_file" \
      --project-name "$project" -f "$REPO_ROOT/compose.yaml" \
      exec -T db psql -U odoo_admin -d "$database" -v ON_ERROR_STOP=1 \
      -c "UPDATE ir_module_module SET state='uninstalled'
          WHERE name='osi_business_demo'"

    if "$SCRIPT_DIR/init-database" >"$test_root/partial.log" 2>&1; then
      die "partial module state unexpectedly succeeded"
    fi
    grep -q 'ERROR: partial OSI module state; operator action required' \
      "$test_root/partial.log" ||
      die "partial-state failure message is absent"

### Step 4: Prove two full disposable projects coexist

scripts/test-coexistence:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
    TEST_REPO_ROOT="$REPO_ROOT"
    export TEST_REPO_ROOT
    # shellcheck source=scripts/test-env
    . "$SCRIPT_DIR/test-env"
    create_test_environment coexist a
    a_root="$TEST_ROOT"; a_project="$TEST_PROJECT"; a_env="$TEST_ENV_FILE"
    create_test_environment coexist b
    b_root="$TEST_ROOT"; b_project="$TEST_PROJECT"; b_env="$TEST_ENV_FILE"
    cleanup() {
      local item root project env_file
      for item in \
        "$a_root|$a_project|$a_env" \
        "$b_root|$b_project|$b_env"; do
        IFS='|' read -r root project env_file <<<"$item"
        [[ "$project" =~ ^osi-odoo-coexist-[0-9]+-[ab]$ ]] || continue
        [[ "$root" == /tmp/osi-odoo-test.* ]] || continue
        docker compose --env-file "$env_file" --project-name "$project" \
          -f "$REPO_ROOT/compose.yaml" down -v --remove-orphans \
          >/dev/null 2>&1 || true
        rm -rf -- "$root"
      done
    }
    trap cleanup EXIT

    for item in "$a_env|$a_project" "$b_env|$b_project"; do
      IFS='|' read -r env_file project <<<"$item"
      OSI_ENV_FILE="$env_file" OSI_RUNTIME_MODE=base \
        "$SCRIPT_DIR/init-database"
      docker compose --env-file "$env_file" --project-name "$project" \
        -f "$REPO_ROOT/compose.yaml" up -d odoo
    done

    for project in "$a_project" "$b_project"; do
      test "$(docker ps --filter \
        label=com.docker.compose.project="$project" \
        --format '{{.ID}}' | wc -l)" -eq 2
      odoo_id="$(docker ps -q \
        --filter label=com.docker.compose.project="$project" \
        --filter label=com.docker.compose.service=odoo)"
      for attempt in $(seq 1 90); do
        [[ "$(docker inspect -f '{{.State.Health.Status}}' \
          "$odoo_id")" == healthy ]] && break
        (( attempt < 90 )) || {
          echo "ERROR: coexistence Odoo did not become healthy" >&2
          exit 1
        }
        sleep 2
      done
      while read -r container_id; do
        networks="$(docker inspect -f \
          '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' \
          "$container_id")"
        [[ "$networks" != *caddy-net* ]]
      done < <(docker ps -q --filter \
        label=com.docker.compose.project="$project")
    done

    mapfile -t volumes < <(
      for project in "$a_project" "$b_project"; do
        docker volume ls -q \
          --filter label=com.docker.compose.project="$project"
      done | sort -u
    )
    test "${#volumes[@]}" -eq 6
    echo "PASS: two isolated Compose projects coexist"

Expected: both Odoo health checks become healthy, six volumes are distinct, and neither project has the production alias or caddy-net.

### Step 5: Apply modes and run both integration gates

Only after scripts/test-coexistence exists, run:

    chmod 0700 scripts/init-database scripts/test-init-database \
      scripts/test-coexistence
    shellcheck scripts/lib.sh scripts/init-database \
      scripts/test-init-database scripts/test-coexistence
    scripts/test-init-database | tee /tmp/osi-odoo-init-gate.log
    grep -Eq '^PASS: aggregate cgroup memory db=[1-9][0-9]* odoo=[1-9][0-9]* within Compose caps$' \
      /tmp/osi-odoo-init-gate.log
    scripts/test-coexistence

Expected:

    PASS: module state machine completed init
    PASS: module state machine completed update
    PASS: two isolated Compose projects coexist

The aggregate-cgroup line must match the exact regular expression in the gate; both byte counts must be positive integers. On cgroup v2, memory.peak and memory.current include the init process and every worker in the container cgroup, unlike process-only samples.

### Step 6: Replace README and commit

Replace README.md with this complete interim content; Task 8 replaces it with the final operator contract:

    # OSI Odoo test environment

    This repository runs Odoo 19 Community and PostgreSQL 17 for OSI test and
    demonstration work. It is not a production accounting system and must contain
    no real customer data or credentials.

    ## Database initialization

    Task 2 rendered configuration and bootstrapped PostgreSQL only. Both custom
    modules now exist, so `scripts/init-database` is the first supported full Odoo
    initialization entrypoint. Its state machine is:

    | Observed state | Action |
    |---|---|
    | Registry absent | Install both OSI modules |
    | Both modules absent or uninstalled | Install both OSI modules |
    | Both modules installed | Upgrade both OSI modules |
    | Any mixed or pending state | Stop for operator action |

    For a disposable base-Compose project, set `OSI_ENV_FILE` to its mode-0600
    environment file and run `OSI_RUNTIME_MODE=base scripts/init-database`.
    The deployed project will use `OSI_RUNTIME_MODE=production` after Task 8.

    Never run Odoo module test tags against `osi_odoo_test`. Use the disposable
    module-test scripts. Generate every password with `openssl rand -hex 32`.

Run:

    git diff --check
    git add scripts/lib.sh scripts/init-database \
      scripts/test-init-database scripts/test-coexistence README.md
    git commit -m "feat: add idempotent Odoo database initialization"

## Task 7: Add quiesced paired backups, two restore modes, upgrade recovery, and timer

**Files:**

- Modify: scripts/lib.sh
- Create: scripts/validate-backup
- Create: scripts/backup
- Create: scripts/restore-rehearsal
- Create: scripts/restore-production
- Create: scripts/update-modules
- Create: scripts/test-backup-restore
- Create: systemd/osi-odoo-backup.service
- Create: systemd/osi-odoo-backup.timer

### Step 1: Add the one operation lock plus exact restore, volume, and health helpers

Append to scripts/lib.sh:

    project_volume() {
      local logical_name="$1"
      local -a matches=()
      mapfile -t matches < <(
        docker volume ls -q \
          --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
          --filter "label=com.docker.compose.volume=$logical_name"
      )
      (( ${#matches[@]} == 1 )) ||
        die "expected one $logical_name volume; found ${#matches[@]}"
      printf '%s\n' "${matches[0]}"
    }

    operation_lock_enter() {
      : "${OSI_ODOO_LOCK_DIR:?missing OSI_ODOO_LOCK_DIR}"
      [[ "$OSI_ODOO_LOCK_DIR" == /* ]] ||
        die "OSI_ODOO_LOCK_DIR must be absolute"
      install -d -m 0700 "$OSI_ODOO_LOCK_DIR"
      [[ "$(stat -c %u "$OSI_ODOO_LOCK_DIR")" == "$UID" ]] ||
        die "operation lock directory is not owned by the caller"
      [[ "$(stat -c %a "$OSI_ODOO_LOCK_DIR")" == 700 ]] ||
        die "operation lock directory must have mode 0700"
      local lock_file="$OSI_ODOO_LOCK_DIR/operation.lock"
      if [[ "${OSI_ODOO_LOCK_HELD:-0}" == 1 ]]; then
        [[ "${OSI_ODOO_LOCK_FILE:-}" == "$lock_file" ]] ||
          die "nested operation lock path differs"
        [[ -e /proc/$$/fd/9 ]] ||
          die "nested operation did not inherit lock fd 9"
        [[ "$(readlink "/proc/$$/fd/9")" == "$lock_file" ]] ||
          die "nested operation inherited the wrong lock fd"
        flock -n 9 || die "nested operation lock is held elsewhere"
        return 0
      fi
      exec 9>"$lock_file"
      chmod 0600 "$lock_file"
      flock -n 9 || die "another Odoo operation is active"
      export OSI_ODOO_LOCK_HELD=1 OSI_ODOO_LOCK_FILE="$lock_file"
    }

    operation_lock_leave_outer() {
      [[ "${OSI_ODOO_LOCK_HELD:-0}" == 1 && -e /proc/$$/fd/9 ]] ||
        die "cannot release an operation lock that is not held"
      [[ "$(readlink "/proc/$$/fd/9")" == "$OSI_ODOO_LOCK_FILE" ]] ||
        die "operation lock fd changed before release"
      flock -u 9
      exec 9>&-
      unset OSI_ODOO_LOCK_HELD OSI_ODOO_LOCK_FILE
    }

    operation_test_pause() {
      local point="$1" attempt
      [[ "${OSI_TEST_PAUSE_AT:-}" == "$point" ]] || return 0
      require_disposable_project
      : "${OSI_TEST_CONTROL_DIR:?missing OSI_TEST_CONTROL_DIR}"
      [[ "$OSI_TEST_CONTROL_DIR" == /tmp/osi-odoo-test.*/* ]] ||
        die "unsafe test control directory"
      install -d -m 0700 "$OSI_TEST_CONTROL_DIR"
      : >"$OSI_TEST_CONTROL_DIR/$point.ready"
      for attempt in $(seq 1 300); do
        [[ -e "$OSI_TEST_CONTROL_DIR/$point.release" ]] && return 0
        sleep 0.1
      done
      die "test pause timed out: $point"
    }

    resolved_repo_digest() {
      local reference="$1" repository digest
      repository="${reference%%:*}"
      digest="$(docker image inspect "$reference" -f '{{range .RepoDigests}}{{println .}}{{end}}' |
        awk -v prefix="$repository@sha256:" 'index($0, prefix) == 1 {print; exit}')"
      [[ "$digest" == "$repository"@sha256:* ]] ||
        die "image has no RepoDigest for $reference"
      printf '%s\n' "$digest"
    }

    record_current_release() {
      [[ "${OSI_ODOO_LOCK_HELD:-0}" == 1 ]] ||
        die "current release may be recorded only under the operation lock"
      local target="$OSI_ODOO_LOCK_DIR/current-release.json" temporary
      temporary="$(mktemp "$OSI_ODOO_LOCK_DIR/.current-release.XXXXXX")"
      chmod 0600 "$temporary"
      jq -n \
        --arg commit "$(git rev-parse HEAD)" \
        --arg odoo "$(resolved_repo_digest odoo:19.0-20260817)" \
        --arg postgres "$(resolved_repo_digest postgres:17.6-bookworm)" \
        '{git_commit:$commit,images:{
          odoo:{reference:"odoo:19.0-20260817",repo_digest:$odoo},
          postgres:{reference:"postgres:17.6-bookworm",repo_digest:$postgres}
        }}' >"$temporary"
      mv -f -- "$temporary" "$target"
    }

    create_restore_database() {
      local target="$1"
      [[ "$target" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && ${#target} -le 63 ]] ||
        die "invalid restore database name"
      compose_runtime exec -T db psql -U odoo_admin -d postgres \
        -v ON_ERROR_STOP=1 \
        -c "CREATE DATABASE \"$target\" OWNER odoo_owner" \
        -c "REVOKE ALL ON DATABASE \"$target\" FROM PUBLIC" \
        -c "GRANT CONNECT, TEMPORARY ON DATABASE \"$target\" TO odoo_app"
      compose_runtime exec -T db psql -U odoo_admin -d "$target" \
        -v ON_ERROR_STOP=1 \
        -c 'REVOKE CREATE ON SCHEMA public FROM PUBLIC' \
        -c 'ALTER SCHEMA public OWNER TO odoo_app' \
        -c 'GRANT USAGE, CREATE ON SCHEMA public TO odoo_app' \
        -c 'CREATE EXTENSION pg_trgm'
      [[ "$(compose_runtime exec -T db psql -U odoo_admin -d "$target" -Atqc \
        "SELECT e.extname || '|' || r.rolname FROM pg_extension e
         JOIN pg_roles r ON r.oid=e.extowner WHERE e.extname='pg_trgm'")" == \
        'pg_trgm|odoo_admin' ]] || die "candidate pg_trgm owner is not odoo_admin"
    }

    restore_dump_without_bootstrap_extensions() {
      local backup_dir="$1" target="$2" work_dir="$3"
      docker run --rm --network none -v "$backup_dir:/backup:ro" \
        postgres:17.6-bookworm pg_restore --list /backup/database.dump \
        >"$work_dir/restore.list"
      awk '
        / EXTENSION - pg_trgm$/ {next}
        / COMMENT - EXTENSION pg_trgm$/ {next}
        {print}
      ' "$work_dir/restore.list" >"$work_dir/restore.filtered.list"
      ! grep -Eq ' (EXTENSION - pg_trgm|COMMENT - EXTENSION pg_trgm)$' \
        "$work_dir/restore.filtered.list" ||
        die "pg_trgm archive entries were not filtered"
      compose_runtime exec -T db sh -ceu \
        'cat > /tmp/osi-odoo-restore.list' \
        <"$work_dir/restore.filtered.list"
      compose_runtime exec -T db sh -ceu \
        'cat > /tmp/osi-odoo-restore.dump' \
        <"$backup_dir/database.dump"
      compose_runtime exec -T db pg_restore -U odoo_admin -d "$target" \
        --exit-on-error --no-owner --role=odoo_app \
        --use-list=/tmp/osi-odoo-restore.list \
        /tmp/osi-odoo-restore.dump
      compose_runtime exec -T db rm -f \
        /tmp/osi-odoo-restore.list /tmp/osi-odoo-restore.dump
      [[ "$(compose_runtime exec -T db psql -U odoo_admin -d "$target" -Atqc \
        "SELECT e.extname || '|' || r.rolname FROM pg_extension e
         JOIN pg_roles r ON r.oid=e.extowner WHERE e.extname='pg_trgm'")" == \
        'pg_trgm|odoo_admin' ]] || die "restored pg_trgm owner changed"
    }

    stage_filestore() {
      local backup_dir="$1" source_database="$2" target_database="$3"
      local filestore_volume
      filestore_volume="$(project_volume odoo_data)"
      docker run --rm --network none \
        -e SOURCE_DATABASE="$source_database" \
        -e TARGET_DATABASE="$target_database" \
        -v "$filestore_volume:/target" \
        -v "$backup_dir:/backup:ro" alpine:3.22 sh -ceu '
          case "$SOURCE_DATABASE:$TARGET_DATABASE" in
            *[!A-Za-z0-9_]*|:*) exit 64 ;;
          esac
          test ! -e "/target/filestore/$TARGET_DATABASE"
          staging="/target/.restore-$TARGET_DATABASE"
          test ! -e "$staging"
          mkdir -p "$staging"
          trap '\''rm -rf -- "$staging"'\'' EXIT
          tar -C "$staging" -xzf /backup/filestore.tar.gz \
            "./filestore/$SOURCE_DATABASE"
          mkdir -p /target/filestore
          mv "$staging/filestore/$SOURCE_DATABASE" \
            "/target/filestore/$TARGET_DATABASE"
        '
    }

    wait_for_odoo() {
      local tries=0 container_id health
      container_id="$(compose_runtime ps -q odoo)"
      [[ -n "$container_id" ]] || die "Odoo container is absent"
      while true; do
        health="$(docker inspect -f \
          '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
          "$container_id")"
        [[ "$health" == healthy ]] && return 0
        [[ "$health" != unhealthy && "$health" != exited ]] ||
          die "Odoo health failed: $health"
        tries=$((tries + 1))
        (( tries <= 90 )) || die "Odoo health timed out"
        sleep 2
      done
    }

Every top-level operational script calls operation_lock_enter immediately after load_env. Nested calls inherit fd 9 and the two exported lock facts. The nested branch verifies the path and calls `flock -n 9`: the inherited open description succeeds without deadlock, an unlocked descriptor acquires the lock when uncontended, and a forged descriptor fails against a real holder. Only deploy calls operation_lock_leave_outer, after all deployment mutations, so the separately launched systemd backup service can acquire the same lock for its required first run.

### Step 2: Create strict backup validation

scripts/validate-backup:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    (( $# == 1 )) || {
      echo "usage: scripts/validate-backup BACKUP_DIR" >&2
      exit 64
    }
    backup_dir="$(realpath -e -- "$1")"
    [[ -d "$backup_dir" ]] || {
      echo "ERROR: backup path is not a directory" >&2
      exit 1
    }
    for file in manifest.json SHA256SUMS database.dump filestore.tar.gz; do
      [[ -f "$backup_dir/$file" ]] || {
        echo "ERROR: missing backup file: $file" >&2
        exit 1
      }
    done
    jq -e '
      .schema_version == 1 and
      (.started_at | type == "string") and
      (.completed_at | type == "string") and
      (.database_name | type == "string" and length > 0) and
      .database_dump == "database.dump" and
      .filestore_archive == "filestore.tar.gz" and
      (.git_commit | type == "string" and length == 40) and
      (.images.odoo.reference | type == "string" and length > 0) and
      (.images.odoo.repo_digest | test("@sha256:[0-9a-f]{64}$")) and
      (.images.postgres.reference | type == "string" and length > 0) and
      (.images.postgres.repo_digest | test("@sha256:[0-9a-f]{64}$")) and
      (.volumes.database | type == "string" and length > 0) and
      (.volumes.filestore | type == "string" and length > 0) and
      (.was_running | type == "boolean") and
      (.sha256.database_dump | type == "string" and length == 64) and
      (.sha256.filestore_archive | type == "string" and length == 64)
    ' "$backup_dir/manifest.json" >/dev/null || {
      echo "ERROR: invalid backup manifest" >&2
      exit 1
    }
    (
      cd "$backup_dir"
      sha256sum -c SHA256SUMS
      test "$(sha256sum database.dump | cut -d' ' -f1)" = \
        "$(jq -r .sha256.database_dump manifest.json)"
      test "$(sha256sum filestore.tar.gz | cut -d' ' -f1)" = \
        "$(jq -r .sha256.filestore_archive manifest.json)"
      docker run --rm --network none \
        -v "$backup_dir:/backup:ro" postgres:17.6-bookworm \
        pg_restore --list /backup/database.dump >/dev/null
      tar -tzf filestore.tar.gz >/dev/null
    ) || {
      echo "ERROR: backup payload validation failed" >&2
      exit 1
    }
    echo "PASS: backup manifest and payloads"

### Step 3: Create the quiesced paired backup

scripts/backup:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    operation_lock_enter
    require_command jq
    require_command sha256sum
    : "${BACKUP_ROOT:?missing BACKUP_ROOT}"

    install -d -m 0700 "$BACKUP_ROOT"
    started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    temporary="$(mktemp -d "$BACKUP_ROOT/.partial-$stamp-XXXXXX")"
    final="$BACKUP_ROOT/$stamp"
    chmod 0700 "$temporary"
    [[ ! -e "$final" ]] || die "backup destination already exists"

    was_running=false
    odoo_id="$(compose_runtime ps -q odoo || true)"
    if [[ -n "$odoo_id" ]] &&
       [[ "$(docker inspect -f '{{.State.Running}}' "$odoo_id")" == true ]]; then
      was_running=true
    fi
    completed=false
    finish() {
      local status=$?
      if [[ "$was_running" == true ]]; then
        compose_runtime up -d odoo >/dev/null || status=1
      fi
      if [[ "$completed" != true && -d "$temporary" ]]; then
        rm -rf -- "$temporary"
      fi
      return "$status"
    }
    trap finish EXIT

    if [[ "$was_running" == true ]]; then
      compose_runtime stop -t 90 odoo
    fi
    operation_test_pause backup-after-odoo-stop
    compose_runtime up -d db
    wait_for_db

    database_volume="$(project_volume odoo_db)"
    filestore_volume="$(project_volume odoo_data)"
    compose_runtime exec -T db \
      pg_dump -U odoo_admin -d "$ODOO_DB_NAME" \
      --format=custom --no-owner --file=- \
      >"$temporary/database.dump"
    test -s "$temporary/database.dump" ||
      die "database dump is empty"

    docker run --rm --network none \
      -v "$filestore_volume:/source:ro" \
      -v "$temporary:/backup" \
      alpine:3.22 \
      tar -C /source -czf /backup/filestore.tar.gz .
    test -s "$temporary/filestore.tar.gz" ||
      die "filestore archive is empty"

    (
      cd "$temporary"
      sha256sum database.dump filestore.tar.gz >SHA256SUMS
    )
    database_sha="$(sha256sum "$temporary/database.dump" | cut -d' ' -f1)"
    filestore_sha="$(sha256sum "$temporary/filestore.tar.gz" | cut -d' ' -f1)"
    odoo_digest="$(resolved_repo_digest odoo:19.0-20260817)"
    postgres_digest="$(resolved_repo_digest postgres:17.6-bookworm)"
    completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    release_state="$OSI_ODOO_LOCK_DIR/current-release.json"
    if [[ -f "$release_state" ]]; then
      jq -e '.git_commit | test("^[0-9a-f]{40}$")' \
        "$release_state" >/dev/null || die "invalid current release state"
      git_commit="$(jq -r .git_commit "$release_state")"
    else
      git_commit="$(git rev-parse HEAD)"
    fi

    jq -n \
      --arg started "$started_at" \
      --arg completed "$completed_at" \
      --arg database "$ODOO_DB_NAME" \
      --arg commit "$git_commit" \
      --arg odoo_digest "$odoo_digest" \
      --arg postgres_digest "$postgres_digest" \
      --arg database_volume "$database_volume" \
      --arg filestore_volume "$filestore_volume" \
      --arg database_sha "$database_sha" \
      --arg filestore_sha "$filestore_sha" \
      --argjson was_running "$was_running" \
      '{
        schema_version: 1,
        started_at: $started,
        completed_at: $completed,
        database_name: $database,
        database_dump: "database.dump",
        filestore_archive: "filestore.tar.gz",
        git_commit: $commit,
        images: {
          odoo: {
            reference: "odoo:19.0-20260817",
            repo_digest: $odoo_digest
          },
          postgres: {
            reference: "postgres:17.6-bookworm",
            repo_digest: $postgres_digest
          }
        },
        volumes: {
          database: $database_volume,
          filestore: $filestore_volume
        },
        was_running: $was_running,
        sha256: {
          database_dump: $database_sha,
          filestore_archive: $filestore_sha
        }
      }' >"$temporary/manifest.json"

    "$SCRIPT_DIR/validate-backup" "$temporary" >/dev/null
    mv -- "$temporary" "$final"
    completed=true

    mapfile -t old_backups < <(
      find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
        -regextype posix-extended \
        -regex '.*/[0-9]{8}T[0-9]{6}Z' -printf '%f\n' |
        sort -r | tail -n +15
    )
    for old in "${old_backups[@]}"; do
      [[ "$old" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] ||
        die "unsafe retention candidate"
      rm -rf -- "$BACKUP_ROOT/$old"
    done
    printf '%s\n' "$final"

All docker compose exec calls use -T. The EXIT trap restarts Odoo only if it was running before backup.

### Step 4: Create the isolated rehearsal restore

scripts/restore-rehearsal:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    (( $# == 1 )) || {
      echo "usage: scripts/restore-rehearsal BACKUP_DIR" >&2
      exit 64
    }
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
    backup_dir="$(realpath -e -- "$1")"
    source_env="${OSI_SOURCE_ENV_FILE:-${OSI_ENV_FILE:-$REPO_ROOT/.env}}"
    export OSI_ENV_FILE="$source_env"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    operation_lock_enter
    "$SCRIPT_DIR/validate-backup" "$backup_dir"
    source_database="$(jq -r .database_name "$backup_dir/manifest.json")"
    source_admin_login="${OSI_ODOO_ADMIN_LOGIN:?missing source admin login}"
    source_admin_password="${OSI_ODOO_ADMIN_PASSWORD:?missing source admin password}"

    test_root="$(mktemp -d)"
    chmod 0700 "$test_root"
    project="osi-odoo-restore-$$-r"
    restore_nonce="$(openssl rand -hex 8)"
    [[ "$restore_nonce" =~ ^[0-9a-f]{16}$ ]] ||
      die "invalid rehearsal database nonce"
    database="osi_rr_${restore_nonce}"
    [[ ${#database} -eq 23 ]] ||
      die "rehearsal database name budget changed"
    env_file="$test_root/restore.env"
    cleanup() {
      if [[ "$project" =~ ^osi-odoo-restore-[0-9]+-r$ ]]; then
        docker compose --env-file "$env_file" --project-name "$project" \
          -f "$REPO_ROOT/compose.yaml" down -v --remove-orphans \
          >/dev/null 2>&1 || true
      fi
      rm -rf -- "$test_root"
    }
    trap cleanup EXIT
    {
      printf 'COMPOSE_PROJECT_NAME=%s\n' "$project"
      printf 'ODOO_DB_NAME=%s\n' "$database"
      printf 'ODOO_DB_OWNER=odoo_owner\n'
      printf 'ODOO_DB_USER=odoo_app\n'
      printf 'ODOO_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
      printf 'ODOO_POSTGRES_ADMIN_PASSWORD=%s\n' \
        "$(openssl rand -hex 32)"
      printf 'ODOO_MASTER_PASSWORD=%s\n' "$(openssl rand -hex 32)"
      printf 'OSI_ODOO_ADMIN_LOGIN=%s\n' "$source_admin_login"
      printf 'OSI_ODOO_ADMIN_PASSWORD=%s\n' "$source_admin_password"
      printf 'BACKUP_ROOT=%s\n' "$test_root/backups"
      printf 'OSI_ODOO_LOCK_DIR=%s\n' "$OSI_ODOO_LOCK_DIR"
    } >"$env_file"
    chmod 0600 "$env_file"

    export OSI_ENV_FILE="$env_file" ENV_FILE="$env_file" OSI_RUNTIME_MODE=base
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
    require_disposable_project
    "$SCRIPT_DIR/render-config"
    compose_base up -d db
    wait_for_db
    restore_dump_without_bootstrap_extensions \
      "$backup_dir" "$ODOO_DB_NAME" "$test_root"
    stage_filestore "$backup_dir" "$source_database" "$ODOO_DB_NAME"

    compose_base run --rm --no-deps \
      -e OSI_ODOO_ADMIN_LOGIN -e OSI_ODOO_ADMIN_PASSWORD odoo \
      odoo --config=/etc/odoo/odoo.conf \
      --database="$ODOO_DB_NAME" \
      --update=osi_business_setup,osi_business_demo \
      --test-enable \
      --test-tags=/osi_business_setup,/osi_business_demo \
      --without-demo=all --stop-after-init \
      2>&1 | tee "$test_root/rehearsal-tests.log"
    grep -q TestBusinessSetup "$test_root/rehearsal-tests.log" ||
      die "setup tests were not discovered in rehearsal"
    grep -q TestOsiProjects "$test_root/rehearsal-tests.log" ||
      die "project tests were not discovered in rehearsal"
    grep -q TestOsiBusinessDemo "$test_root/rehearsal-tests.log" ||
      die "demo tests were not discovered in rehearsal"
    compose_base exec -T db psql -U odoo_admin -d "$ODOO_DB_NAME" \
      -v ON_ERROR_STOP=1 <<'SQL'
    DO $$
    BEGIN
      IF (SELECT count(*) FROM ir_module_module
          WHERE name IN ('osi_business_setup','osi_business_demo')
            AND state='installed') != 2
      THEN RAISE EXCEPTION 'OSI modules are not installed'; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM res_company
        WHERE name='Open Smart Irrigation'
      ) THEN RAISE EXCEPTION 'OSI company is absent'; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM project_project WHERE is_template
      ) THEN RAISE EXCEPTION 'project templates are absent'; END IF;
    END $$;
    SQL
    if [[ -n "${OSI_EXPECT_ATTACHMENT_NAME:-}" ]]; then
      store_fname="$(compose_base exec -T db psql -U odoo_admin \
        -d "$ODOO_DB_NAME" -Atv ON_ERROR_STOP=1 \
        -v expected_name="$OSI_EXPECT_ATTACHMENT_NAME" \
        -c "SELECT store_fname FROM ir_attachment
            WHERE name=:'expected_name' AND store_fname IS NOT NULL")"
      [[ -n "$store_fname" ]] ||
        die "paired attachment row is absent after rehearsal"
      filestore_volume="$(project_volume odoo_data)"
      docker run --rm --network none \
        -e DATABASE="$ODOO_DB_NAME" -e STORE_FNAME="$store_fname" \
        -v "$filestore_volume:/target:ro" alpine:3.22 sh -ceu '
          test -s "/target/filestore/$DATABASE/$STORE_FNAME"
        '
      echo "PASS: attachment database row and filestore object are paired"
    fi
    echo "PASS: isolated rehearsal restore"

The script never uses compose.test-vps.yaml, never stops the live service, and deletes only its validated disposable project.

### Step 5: Create operator-confirmed production replacement

scripts/restore-production:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    (( $# == 2 )) ||
      { echo "usage: scripts/restore-production BACKUP_DIR --confirm-replace-live" >&2; exit 64; }
    [[ "$2" == --confirm-replace-live ]] ||
      { echo "ERROR: missing --confirm-replace-live" >&2; exit 1; }
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    backup_dir="$(realpath -e -- "$1")"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    operation_lock_enter
    if [[ "$COMPOSE_PROJECT_NAME" == osi-odoo ]]; then
      export OSI_RUNTIME_MODE=production
    elif [[ "${OSI_TEST_ALLOW_PRODUCTION_RESTORE:-0}" == 1 ]]; then
      require_disposable_project
      [[ "${OSI_RUNTIME_MODE:-base}" == base ]] ||
        die "disposable production-restore gate requires base mode"
      export OSI_RUNTIME_MODE=base
    else
      die "production restore requires the live project or explicit disposable gate"
    fi
    if [[ -n "${OSI_TEST_RESTORE_FAIL_AFTER:-}" ]]; then
      [[ "${OSI_TEST_ALLOW_PRODUCTION_RESTORE:-0}" == 1 ]] ||
        die "restore failure injection requires the disposable gate"
      require_disposable_project
      case "$OSI_TEST_RESTORE_FAIL_AFTER" in
        database-live-to-retained|database-candidate-to-live|\
        filestore-live-to-retained|filestore-candidate-to-live) ;;
        *) die "invalid restore failure point" ;;
      esac
    fi
    "$SCRIPT_DIR/validate-backup" "$backup_dir"
    [[ "$(jq -r .database_name "$backup_dir/manifest.json")" == \
      "$ODOO_DB_NAME" ]] ||
      die "backup database name does not match live database"
    OSI_SOURCE_ENV_FILE="$ENV_FILE" \
      "$SCRIPT_DIR/restore-rehearsal" "$backup_dir"

    backup_output="$("$SCRIPT_DIR/backup")"
    pre_restore_backup="$(printf '%s\n' "$backup_output" | tail -n 1)"
    [[ -d "$pre_restore_backup" ]] ||
      die "pre-restore backup path is absent"
    compose_runtime stop -t 90 odoo
    report_staging_failure() {
      local status=$?
      if (( status != 0 )); then
        printf 'ERROR: candidate staging failed; live pair is unchanged and Odoo remains stopped\n' >&2
        printf 'Recovery backup: %s\n' "$pre_restore_backup" >&2
      fi
      return "$status"
    }
    trap report_staging_failure EXIT
    source_database="$(jq -r .database_name "$backup_dir/manifest.json")"
    restore_nonce="$(openssl rand -hex 8)"
    [[ "$restore_nonce" =~ ^[0-9a-f]{16}$ ]] ||
      die "invalid production restore nonce"
    candidate_database="osi_candidate_${restore_nonce}"
    retained_database="osi_retained_${restore_nonce}"
    longest_restore_identifier=osi_candidate_ffffffffffffffff
    [[ ${#candidate_database} -eq 30 &&
       ${#retained_database} -eq 29 &&
       ${#longest_restore_identifier} -eq 30 ]] ||
      die "restore database name budget changed"
    (( ${#longest_restore_identifier} <= 63 )) ||
      die "restore database name exceeds PostgreSQL's 63-byte limit"
    work_dir="$(mktemp -d /tmp/osi-odoo-production-restore.XXXXXX)"
    chmod 0700 "$work_dir"
    create_restore_database "$candidate_database"
    restore_dump_without_bootstrap_extensions \
      "$backup_dir" "$candidate_database" "$work_dir"
    stage_filestore "$backup_dir" "$source_database" "$candidate_database"

    compose_runtime run --rm --no-deps odoo \
      odoo --config=/etc/odoo/odoo.conf \
      --database="$candidate_database" \
      --db-filter="^${candidate_database}$" --no-http --stop-after-init
    compose_runtime exec -T db psql -U odoo_admin -d "$candidate_database" \
      -v ON_ERROR_STOP=1 <<'SQL'
    DO $$
    BEGIN
      IF (SELECT count(*) FROM ir_module_module
          WHERE name IN ('osi_business_setup','osi_business_demo')
            AND state='installed') != 2
      THEN RAISE EXCEPTION 'candidate modules are not installed'; END IF;
      IF NOT EXISTS (SELECT 1 FROM res_company
                     WHERE name='Open Smart Irrigation')
      THEN RAISE EXCEPTION 'candidate OSI company is absent'; END IF;
      IF (SELECT count(*) FROM project_project WHERE is_template) != 5
      THEN RAISE EXCEPTION 'candidate template count is not five'; END IF;
      IF (SELECT e.extname || '|' || r.rolname FROM pg_extension e
          JOIN pg_roles r ON r.oid=e.extowner WHERE e.extname='pg_trgm')
          IS DISTINCT FROM 'pg_trgm|odoo_admin'
      THEN RAISE EXCEPTION 'candidate pg_trgm ownership changed'; END IF;
    END $$;
    SQL

    filestore_volume="$(project_volume odoo_data)"
    database_exists() {
      local database_name="$1" result
      result="$(compose_runtime exec -T db psql -U odoo_admin -d postgres \
        -Atv ON_ERROR_STOP=1 -v database_name="$database_name" \
        -c "SELECT count(*) FROM pg_database
            WHERE datname=:'database_name'")" || return 1
      [[ "$result" == 1 ]]
    }
    filestore_exists() {
      local database_name="$1"
      docker run --rm --network none \
        -e DATABASE_NAME="$database_name" \
        -v "$filestore_volume:/target:ro" alpine:3.22 sh -ceu '
          case "$DATABASE_NAME" in *[!A-Za-z0-9_]*) exit 64 ;; esac
          test -d "/target/filestore/$DATABASE_NAME"
        ' >/dev/null
    }
    rename_database() {
      local source_name="$1" target_name="$2"
      compose_runtime exec -T db psql -U odoo_admin -d postgres \
        -v ON_ERROR_STOP=1 \
        -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname='$source_name' AND pid <> pg_backend_pid()" \
        -c "ALTER DATABASE \"$source_name\" RENAME TO \"$target_name\""
    }
    rename_filestore() {
      local source_name="$1" target_name="$2"
      docker run --rm --network none \
        -e SOURCE_NAME="$source_name" -e TARGET_NAME="$target_name" \
        -v "$filestore_volume:/target" alpine:3.22 sh -ceu '
          case "$SOURCE_NAME:$TARGET_NAME" in
            *[!A-Za-z0-9_:]*) exit 64 ;;
          esac
          test -d "/target/filestore/$SOURCE_NAME"
          test ! -e "/target/filestore/$TARGET_NAME"
          mv "/target/filestore/$SOURCE_NAME" \
            "/target/filestore/$TARGET_NAME"
        '
    }
    pair_name_state() {
      local label="$1" name
      printf '%s database:' "$label" >&2
      for name in "$ODOO_DB_NAME" "$candidate_database" "$retained_database"; do
        if database_exists "$name"; then printf ' %s' "$name" >&2; fi
      done
      printf '\n%s filestore:' "$label" >&2
      for name in "$ODOO_DB_NAME" "$candidate_database" "$retained_database"; do
        if filestore_exists "$name"; then printf ' %s' "$name" >&2; fi
      done
      printf '\n' >&2
    }
    reconcile_database_to_old() {
      local live=false candidate=false retained=false
      database_exists "$ODOO_DB_NAME" && live=true
      database_exists "$candidate_database" && candidate=true
      database_exists "$retained_database" && retained=true
      if [[ "$retained" == true ]]; then
        if [[ "$live" == true ]]; then
          [[ "$candidate" == false ]] || {
            printf 'ERROR: three database swap names exist\n' >&2
            return 1
          }
          rename_database "$ODOO_DB_NAME" "$candidate_database" || return 1
        fi
        rename_database "$retained_database" "$ODOO_DB_NAME" || return 1
      else
        [[ "$live" == true ]] || {
          printf 'ERROR: old database has no live or retained name\n' >&2
          return 1
        }
      fi
      database_exists "$ODOO_DB_NAME" &&
        database_exists "$candidate_database" &&
        ! database_exists "$retained_database"
    }
    reconcile_filestore_to_old() {
      local live=false candidate=false retained=false
      filestore_exists "$ODOO_DB_NAME" && live=true
      filestore_exists "$candidate_database" && candidate=true
      filestore_exists "$retained_database" && retained=true
      if [[ "$retained" == true ]]; then
        if [[ "$live" == true ]]; then
          [[ "$candidate" == false ]] || {
            printf 'ERROR: three filestore swap names exist\n' >&2
            return 1
          }
          rename_filestore "$ODOO_DB_NAME" "$candidate_database" || return 1
        fi
        rename_filestore "$retained_database" "$ODOO_DB_NAME" || return 1
      else
        [[ "$live" == true ]] || {
          printf 'ERROR: old filestore has no live or retained name\n' >&2
          return 1
        }
      fi
      filestore_exists "$ODOO_DB_NAME" &&
        filestore_exists "$candidate_database" &&
        ! filestore_exists "$retained_database"
    }
    run_restore_mutation() {
      local failure_point="$1"
      shift
      "$@"
      if [[ "${OSI_TEST_RESTORE_FAIL_AFTER:-}" == "$failure_point" ]]; then
        require_disposable_project
        printf 'INJECT: mutation completed before nonzero: %s\n' \
          "$failure_point" >&2
        return 98
      fi
    }
    rollback_candidate_swap() {
      local status=$?
      (( status != 0 )) || return 0
      set +e
      compose_runtime stop -t 90 odoo >/dev/null 2>&1
      pair_name_state 'OBSERVED-FAILURE'
      database_reconciled=false
      filestore_reconciled=false
      reconcile_database_to_old && database_reconciled=true
      reconcile_filestore_to_old && filestore_reconciled=true
      pair_name_state 'OBSERVED-RECONCILED'
      rm -rf -- "$work_dir"
      if [[ "$database_reconciled" != true ||
            "$filestore_reconciled" != true ]]; then
        printf 'ERROR: restore rollback could not reconcile one old live pair\n' >&2
        return 96
      fi
      printf 'PASS: restore rollback reconciled one old live pair\n' >&2
      printf 'ERROR: production restore failed; Odoo remains stopped\n' >&2
      printf 'Recovery backup: %s\n' "$pre_restore_backup" >&2
      printf 'Candidate database/filestore: %s\n' "$candidate_database" >&2
      return "$status"
    }
    trap rollback_candidate_swap EXIT

    database_exists "$ODOO_DB_NAME"
    database_exists "$candidate_database"
    ! database_exists "$retained_database"
    filestore_exists "$ODOO_DB_NAME"
    filestore_exists "$candidate_database"
    ! filestore_exists "$retained_database"

    run_restore_mutation database-live-to-retained \
      rename_database "$ODOO_DB_NAME" "$retained_database"
    run_restore_mutation database-candidate-to-live \
      rename_database "$candidate_database" "$ODOO_DB_NAME"
    run_restore_mutation filestore-live-to-retained \
      rename_filestore "$ODOO_DB_NAME" "$retained_database"
    run_restore_mutation filestore-candidate-to-live \
      rename_filestore "$candidate_database" "$ODOO_DB_NAME"

    database_exists "$ODOO_DB_NAME"
    database_exists "$retained_database"
    ! database_exists "$candidate_database"
    filestore_exists "$ODOO_DB_NAME"
    filestore_exists "$retained_database"
    ! filestore_exists "$candidate_database"
    compose_runtime up -d odoo
    wait_for_odoo
    trap - EXIT
    rm -rf -- "$work_dir"
    printf 'PASS: production pair replaced\n'
    printf 'Retained pre-restore backup: %s\n' "$pre_restore_backup"
    printf 'Retained prior database/filestore name: %s\n' "$retained_database"

The live database and filestore are never dropped or emptied. A unique candidate pair is restored and verified first. With the long-running Odoo service stopped, four individually injectable mutations switch the names. On any nonzero return, including mutation-then-nonzero, the EXIT handler queries PostgreSQL and the volume for the three possible names and reconciles each side to the old pair under the live name. It does not infer state from a client-success Boolean. On success the prior pair remains under the same retained suffix and the fresh paired pre-restore backup remains available; cleanup is a separate operator decision. OSI_TEST_ALLOW_PRODUCTION_RESTORE and OSI_TEST_RESTORE_FAIL_AFTER work only with a validated disposable project.

### Step 6: Create failed-upgrade behavior

scripts/update-modules:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    operation_lock_enter
    backup_output="$("$SCRIPT_DIR/backup")"
    backup_dir="$(printf '%s\n' "$backup_output" | tail -n 1)"
    [[ -d "$backup_dir" ]] || die "module-update backup path is absent"
    compose_runtime pull db odoo
    OSI_SOURCE_ENV_FILE="$ENV_FILE" \
      "$SCRIPT_DIR/restore-rehearsal" "$backup_dir"
    compose_runtime stop -t 90 odoo
    report="$backup_dir/failed-update.json"
    set +e
    if [[ "${OSI_TEST_FORCE_UPDATE_FAILURE:-0}" == 1 ]]; then
      require_disposable_project
      update_status=97
    else
      compose_runtime run --rm --no-deps \
        -e OSI_ODOO_ADMIN_LOGIN -e OSI_ODOO_ADMIN_PASSWORD \
        odoo odoo --config=/etc/odoo/odoo.conf \
        --database="$ODOO_DB_NAME" \
        --update=osi_business_setup,osi_business_demo \
        --without-demo=all --stop-after-init
      update_status=$?
    fi
    set -e
    if (( update_status != 0 )); then
      jq -n \
        --argjson exit_code "$update_status" \
        --arg backup "$backup_dir" \
        --arg commit "$(git rev-parse HEAD)" \
        --arg odoo_image "$(resolved_repo_digest odoo:19.0-20260817)" \
        --arg postgres_image "$(resolved_repo_digest postgres:17.6-bookworm)" \
        --slurpfile prior "$backup_dir/manifest.json" \
        '{exit_code:$exit_code,backup:$backup,candidate_git_commit:$commit,
          candidate_images:{
            odoo:{reference:"odoo:19.0-20260817",repo_digest:$odoo_image},
            postgres:{reference:"postgres:17.6-bookworm",repo_digest:$postgres_image}
          },
          prior_release:{
            git_commit:$prior[0].git_commit,
            images:$prior[0].images
          },
          recovery_order:[
            "keep Odoo stopped",
            "check out prior_release.git_commit",
            "pull and tag each prior_release.images.*.repo_digest as its recorded reference",
            "using that prior code, run scripts/restore-production BACKUP_DIR --confirm-replace-live"
          ]}' \
        >"$report"
      printf 'ERROR: module update failed with exit %d; Odoo remains stopped\n' \
        "$update_status" >&2
      printf 'Failure report: %s\n' "$report" >&2
      exit "$update_status"
    fi
    compose_runtime up -d odoo
    wait_for_odoo
    record_current_release
    echo "PASS: modules updated"

No trap restarts Odoo on failure. The operator must keep Odoo stopped, reactivate the report's prior Git commit and immutable RepoDigests, and only then use that prior release's scripts/restore-production to validate and restore its paired backup. Candidate code never starts against restored prior data.

### Step 7: Add the systemd timer

systemd/osi-odoo-backup.service:

    [Unit]
    Description=OSI Odoo paired backup
    Requires=docker.service
    After=docker.service

    [Service]
    Type=oneshot
    User=rocky
    Group=rocky
    UMask=0077
    WorkingDirectory=/opt/osi-odoo
    Environment=OSI_RUNTIME_MODE=production
    ExecStart=/opt/osi-odoo/scripts/backup
    Nice=10

systemd/osi-odoo-backup.timer:

    [Unit]
    Description=Daily OSI Odoo paired backup

    [Timer]
    OnCalendar=*-*-* 02:40:00 Europe/Zurich
    Persistent=true
    RandomizedDelaySec=15m
    Unit=osi-odoo-backup.service

    [Install]
    WantedBy=timers.target

### Step 8: Build and run the failure-injection gate

scripts/test-backup-restore starts with this complete prologue:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
    TEST_REPO_ROOT="$REPO_ROOT"
    export TEST_REPO_ROOT
    # shellcheck source=scripts/test-env
    . "$SCRIPT_DIR/test-env"
    create_test_environment restore b
    backup_pid=""
    cleanup_backup_test() {
      if [[ "$backup_pid" =~ ^[0-9]+$ ]]; then
        kill "$backup_pid" 2>/dev/null || true
        wait "$backup_pid" 2>/dev/null || true
      fi
      destroy_test_environment
    }
    trap cleanup_backup_test EXIT
    test_root="$TEST_ROOT"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    require_disposable_project
    [[ "$TEST_DATABASE" =~ ^osi_r_[0-9a-f]{8}_b$ ]] ||
      die "production-restore gate does not use its short database name"
    longest_restore_identifier=osi_candidate_ffffffffffffffff
    [[ ${#TEST_DATABASE} -eq 16 &&
       ${#longest_restore_identifier} -eq 30 ]] ||
      die "restore identifier structure changed"
    (( ${#longest_restore_identifier} <= 63 )) ||
      die "restore identifier exceeds PostgreSQL's 63-byte limit"
    echo "PASS: longest restore identifier is 30 of 63 bytes"
    "$SCRIPT_DIR/init-database"
    compose_base up -d odoo
    wait_for_odoo

Append this exact body:

    attachment_name="PAIR-BOUNDARY-$$"
    export OSI_EXPECT_ATTACHMENT_NAME="$attachment_name"
    printf '%s\n' \
      'import base64, os' \
      'record = env["ir.attachment"].create({' \
      '    "name": os.environ["OSI_EXPECT_ATTACHMENT_NAME"],' \
      '    "type": "binary",' \
      '    "datas": base64.b64encode(b"paired-boundary-content"),' \
      '    "mimetype": "application/octet-stream",' \
      '})' \
      'env.cr.commit()' \
      'assert record.store_fname' |
      compose_base run --rm --no-deps \
        -e OSI_EXPECT_ATTACHMENT_NAME odoo \
        odoo shell --config=/etc/odoo/odoo.conf \
        --database="$ODOO_DB_NAME" --no-http

    seed_backup_output="$("$SCRIPT_DIR/backup")"
    seed_backup="$(printf '%s\n' "$seed_backup_output" | tail -n 1)"
    [[ -d "$seed_backup" ]]
    control_dir="$test_root/lock-control"
    export OSI_TEST_CONTROL_DIR="$control_dir"
    export OSI_TEST_PAUSE_AT=backup-after-odoo-stop
    "$SCRIPT_DIR/backup" >"$test_root/paused-backup.out" \
      2>"$test_root/paused-backup.err" &
    backup_pid=$!
    for attempt in $(seq 1 300); do
      [[ -e "$control_dir/backup-after-odoo-stop.ready" ]] && break
      kill -0 "$backup_pid" 2>/dev/null ||
        die "paused backup exited before its boundary"
      (( attempt < 300 )) || die "paused backup did not reach boundary"
      sleep 0.1
    done

    stopped_id="$(compose_base ps -a -q odoo)"
    [[ -n "$stopped_id" ]]
    [[ "$(docker inspect -f '{{.State.Running}}' "$stopped_id")" == false ]]
    if printf '%s\n' \
      'env["ir.config_parameter"].sudo().set_param("osi.backup.boundary", "forbidden")' |
      compose_base exec -T odoo \
        odoo shell --config=/etc/odoo/odoo.conf \
        --database="$ODOO_DB_NAME" --no-http \
        >"$test_root/boundary-write.log" 2>&1; then
      die "Odoo accepted a write boundary command while backup was quiesced"
    fi
    [[ "$(compose_base exec -T db psql -U odoo_admin \
      -d "$ODOO_DB_NAME" -Atqc \
      "SELECT count(*) FROM ir_config_parameter
       WHERE key='osi.backup.boundary'")" == 0 ]] ||
      die "boundary write reached PostgreSQL"
    if "$SCRIPT_DIR/backup" >"$test_root/concurrent-backup.log" 2>&1; then
      die "concurrent backup unexpectedly acquired the operation lock"
    fi
    grep -q 'ERROR: another Odoo operation is active' \
      "$test_root/concurrent-backup.log"
    if "$SCRIPT_DIR/restore-rehearsal" "$seed_backup" \
      >"$test_root/concurrent-restore.log" 2>&1; then
      die "concurrent restore unexpectedly acquired the operation lock"
    fi
    grep -q 'ERROR: another Odoo operation is active' \
      "$test_root/concurrent-restore.log"
    if OSI_ODOO_LOCK_HELD=1 \
       OSI_ODOO_LOCK_FILE="$OSI_ODOO_LOCK_DIR/operation.lock" \
       bash -ceu '
         exec 9>"$OSI_ODOO_LOCK_FILE"
         . "$1"
         operation_lock_enter
       ' bash "$SCRIPT_DIR/lib.sh" \
       >"$test_root/forged-lock.log" 2>&1; then
      die "forged unlocked descriptor bypassed the operation lock"
    fi
    grep -q 'ERROR: nested operation lock is held elsewhere' \
      "$test_root/forged-lock.log"
    echo "PASS: quiesced boundary and shared operation lock"

    touch "$control_dir/backup-after-odoo-stop.release"
    wait "$backup_pid"
    backup_pid=""
    unset OSI_TEST_PAUSE_AT OSI_TEST_CONTROL_DIR
    backup_dir="$(tail -n 1 "$test_root/paused-backup.out")"
    "$SCRIPT_DIR/validate-backup" "$backup_dir"
    "$SCRIPT_DIR/restore-rehearsal" "$backup_dir"

    rollback_attachment="PAIR-ROLLBACK-$$"
    export OSI_ROLLBACK_ATTACHMENT="$rollback_attachment"
    printf '%s\n' \
      'import base64, os' \
      'record = env["ir.attachment"].create({' \
      '    "name": os.environ["OSI_ROLLBACK_ATTACHMENT"],' \
      '    "type": "binary",' \
      '    "datas": base64.b64encode((' \
      '        "old-live-only:" + os.environ["OSI_ROLLBACK_ATTACHMENT"]' \
      '    ).encode()),' \
      '    "mimetype": "application/octet-stream",' \
      '})' \
      'env.cr.commit()' \
      'assert record.store_fname' |
      compose_base run --rm --no-deps \
        -e OSI_ROLLBACK_ATTACHMENT odoo \
        odoo shell --config=/etc/odoo/odoo.conf \
        --database="$ODOO_DB_NAME" --no-http
    rollback_store_fname="$(compose_base exec -T db psql -U odoo_admin \
      -d "$ODOO_DB_NAME" -Atv ON_ERROR_STOP=1 \
      -v attachment_name="$rollback_attachment" \
      -c "SELECT store_fname FROM ir_attachment
          WHERE name=:'attachment_name'")"
    [[ -n "$rollback_store_fname" ]]
    filestore_volume="$(project_volume odoo_data)"
    assert_old_attachment_pair() {
      local database_name="$1" filestore_name="$2" count
      count="$(compose_base exec -T db psql -U odoo_admin \
        -d "$database_name" -Atv ON_ERROR_STOP=1 \
        -v attachment_name="$rollback_attachment" \
        -c "SELECT count(*) FROM ir_attachment
            WHERE name=:'attachment_name'")"
      [[ "$count" == 1 ]] ||
        die "old rollback attachment row is not in $database_name"
      docker run --rm --network none \
        -e FILESTORE_NAME="$filestore_name" \
        -e STORE_FNAME="$rollback_store_fname" \
        -v "$filestore_volume:/target:ro" alpine:3.22 sh -ceu '
          test -s "/target/filestore/$FILESTORE_NAME/$STORE_FNAME"
        '
    }

    [[ "$COMPOSE_PROJECT_NAME" != osi-odoo ]] ||
      die "production-restore gate selected the live project"
    export OSI_TEST_ALLOW_PRODUCTION_RESTORE=1
    restore_points=(
      database-live-to-retained
      database-candidate-to-live
      filestore-live-to-retained
      filestore-candidate-to-live
    )
    for restore_point in "${restore_points[@]}"; do
      export OSI_TEST_RESTORE_FAIL_AFTER="$restore_point"
      sleep 1
      set +e
      "$SCRIPT_DIR/restore-production" "$backup_dir" \
        --confirm-replace-live \
        >"$test_root/restore-$restore_point.log" 2>&1
      restore_status=$?
      set -e
      [[ "$restore_status" == 98 ]] ||
        die "$restore_point returned $restore_status instead of 98"
      grep -q "INJECT: mutation completed before nonzero: $restore_point" \
        "$test_root/restore-$restore_point.log"
      grep -q 'PASS: restore rollback reconciled one old live pair' \
        "$test_root/restore-$restore_point.log"
      assert_old_attachment_pair "$ODOO_DB_NAME" "$ODOO_DB_NAME"
      stopped_id="$(compose_base ps -a -q odoo)"
      [[ -n "$stopped_id" ]]
      [[ "$(docker inspect -f '{{.State.Running}}' "$stopped_id")" == false ]]
      compose_base up -d odoo
      wait_for_odoo
    done
    unset OSI_TEST_RESTORE_FAIL_AFTER

    sleep 1
    "$SCRIPT_DIR/restore-production" "$backup_dir" \
      --confirm-replace-live >"$test_root/restore-success.log" 2>&1
    grep -q 'PASS: production pair replaced' \
      "$test_root/restore-success.log"
    retained_name="$(sed -n \
      's/^Retained prior database\/filestore name: //p' \
      "$test_root/restore-success.log")"
    [[ "$retained_name" =~ ^osi_retained_[0-9a-f]{16}$ ]]
    live_rollback_count="$(compose_base exec -T db psql -U odoo_admin \
      -d "$ODOO_DB_NAME" -Atv ON_ERROR_STOP=1 \
      -v attachment_name="$rollback_attachment" \
      -c "SELECT count(*) FROM ir_attachment
          WHERE name=:'attachment_name'")"
    [[ "$live_rollback_count" == 0 ]] ||
      die "successful restore did not activate the candidate database"
    docker run --rm --network none \
      -e DATABASE_NAME="$ODOO_DB_NAME" \
      -e STORE_FNAME="$rollback_store_fname" \
      -v "$filestore_volume:/target:ro" alpine:3.22 sh -ceu '
        test ! -e "/target/filestore/$DATABASE_NAME/$STORE_FNAME"
      '
    assert_old_attachment_pair "$retained_name" "$retained_name"
    unset OSI_TEST_ALLOW_PRODUCTION_RESTORE
    echo "PASS: four restore mutations reconcile and successful swap retains old pair"

    export OSI_TEST_FORCE_UPDATE_FAILURE=1
    if "$SCRIPT_DIR/update-modules" >"$test_root/update.log" 2>&1; then
      die "injected update failure unexpectedly succeeded"
    fi
    unset OSI_TEST_FORCE_UPDATE_FAILURE
    grep -q 'Odoo remains stopped' "$test_root/update.log"
    stopped_id="$(compose_base ps -a -q odoo)"
    [[ -n "$stopped_id" ]]
    [[ "$(docker inspect -f '{{.State.Running}}' "$stopped_id")" == false ]]
    failure_report="$(find "$BACKUP_ROOT" -name failed-update.json -print -quit)"
    test -f "$failure_report"
    test "$(jq -r .exit_code "$failure_report")" -eq 97
    recovery_backup="$(jq -r .backup "$failure_report")"
    test "$(jq -r '.prior_release.images.odoo.repo_digest' \
      "$failure_report")" = \
      "$(jq -r '.images.odoo.repo_digest' \
        "$recovery_backup/manifest.json")"
    "$SCRIPT_DIR/restore-rehearsal" "$recovery_backup"

    cp -a -- "$backup_dir" "$test_root/corrupt-payload"
    printf 'corrupt' >>"$test_root/corrupt-payload/database.dump"
    if "$SCRIPT_DIR/validate-backup" "$test_root/corrupt-payload" \
      >"$test_root/corrupt.log" 2>&1; then
      die "corrupt payload unexpectedly validated"
    fi
    grep -q 'ERROR: backup payload validation failed' \
      "$test_root/corrupt.log"

    cp -a -- "$backup_dir" "$test_root/missing-manifest"
    rm -- "$test_root/missing-manifest/manifest.json"
    if "$SCRIPT_DIR/validate-backup" "$test_root/missing-manifest" \
      >"$test_root/missing.log" 2>&1; then
      die "missing manifest unexpectedly validated"
    fi
    grep -q 'ERROR: missing backup file: manifest.json' \
      "$test_root/missing.log"

Run:

    chmod 0700 scripts/validate-backup scripts/backup \
      scripts/restore-rehearsal scripts/restore-production \
      scripts/update-modules scripts/test-backup-restore
    chmod 0644 systemd/osi-odoo-backup.service \
      systemd/osi-odoo-backup.timer
    shellcheck scripts/lib.sh scripts/validate-backup scripts/backup \
      scripts/restore-rehearsal scripts/restore-production \
      scripts/update-modules scripts/test-backup-restore
    systemd-analyze verify systemd/osi-odoo-backup.service \
      systemd/osi-odoo-backup.timer
    scripts/test-backup-restore
    git diff --check

Expected:

    PASS: longest restore identifier is 30 of 63 bytes
    PASS: backup manifest and payloads
    PASS: isolated rehearsal restore
    PASS: quiesced boundary and shared operation lock
    PASS: attachment database row and filestore object are paired
    PASS: four restore mutations reconcile and successful swap retains old pair

The gate creates an Odoo attachment backed by the filestore, stops Odoo at the exact pre-dump boundary, proves the stopped service cannot accept the boundary command, and proves concurrent and forged-descriptor callers cannot enter. It restores the paired attachment in rehearsal. It then creates an old-live-only attachment, invokes restore-production against the disposable project after each of the four mutation-then-nonzero points, and verifies that the old database row and old stored object share the live name after every rollback. A final successful invocation proves the candidate becomes live and the old pair survives under one retained name.

### Step 9: Commit

    git add scripts systemd
    git commit -m "feat: add paired Odoo backup and recovery"

## Task 8: Add deployment, Caddy, DNS, and operator documentation

**Files:**

- Create: deploy/Caddyfile.fragment
- Create: scripts/check-dns
- Create: scripts/deploy
- Replace: README.md

### Step 1: Create the exact Caddy fragment

deploy/Caddyfile.fragment:

    odoo-test.opensmartirrigation.org {
        encode zstd gzip

        @websocket path /websocket /websocket/*
        reverse_proxy @websocket osi-odoo:8072
        reverse_proxy osi-odoo:8069
    }

The matcher must not be /websocket*. Caddy validation is against the complete host Caddyfile, not this fragment alone.

### Step 2: Create normalized DNS validation

scripts/check-dns:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    : "${EXPECTED_PUBLIC_IPV4:?missing EXPECTED_PUBLIC_IPV4}"
    host=odoo-test.opensmartirrigation.org
    python3 - "$host" "$EXPECTED_PUBLIC_IPV4" \
      "${EXPECTED_PUBLIC_IPV6:-}" <<'PY'
    import ipaddress
    import socket
    import sys

    host, expected_v4, expected_v6 = sys.argv[1:]
    expected = {ipaddress.ip_address(expected_v4)}
    if expected_v6:
        expected.add(ipaddress.ip_address(expected_v6))
    try:
        answers = {
            ipaddress.ip_address(item[4][0])
            for item in socket.getaddrinfo(
                host, 443, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM
            )
        }
    except socket.gaierror as error:
        raise SystemExit(f"ERROR: DNS resolution failed for {host}: {error}")
    if answers != expected:
        normalized_answers = ",".join(sorted(map(str, answers)))
        normalized_expected = ",".join(sorted(map(str, expected)))
        raise SystemExit(
            "ERROR: final normalized DNS address set differs: "
            f"expected={normalized_expected} actual={normalized_answers}"
        )
    PY
    # A CNAME is permitted. socket.getaddrinfo follows its chain, and the exact
    # normalized final IPv4/IPv6 set above is the acceptance boundary.
    dig +short CNAME "$host" >/dev/null
    echo "PASS: normalized DNS address set"

### Step 3: Create the deploy entrypoint

scripts/deploy:

    #!/usr/bin/env bash
    set -Eeuo pipefail
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=scripts/lib.sh
    . "$SCRIPT_DIR/lib.sh"
    enter_repo
    load_env
    [[ "$REPO_ROOT" == /opt/osi-odoo ]] ||
      die "deployment must run from /opt/osi-odoo"
    [[ "$COMPOSE_PROJECT_NAME" == osi-odoo ]] ||
      die "deployment requires COMPOSE_PROJECT_NAME=osi-odoo"
    [[ "$(stat -c %a "$ENV_FILE")" == 600 ]] ||
      die ".env must have mode 0600"
    [[ "$(stat -c %U "$ENV_FILE")" == rocky ]] ||
      die ".env must be owned by rocky"
    for command_name in docker curl dig jq shellcheck sudo flock; do
      require_command "$command_name"
    done
    operation_lock_enter
    export OSI_RUNTIME_MODE=production

    mem_available_kib="$(awk '$1 == "MemAvailable:" {print $2}' /proc/meminfo)"
    [[ "$mem_available_kib" =~ ^[0-9]+$ ]] ||
      die "cannot read host MemAvailable"
    (( mem_available_kib >= 4194304 )) ||
      die "host MemAvailable is below 4 GiB"
    install -d -m 0700 "$BACKUP_ROOT"
    for path in /opt/osi-odoo "$BACKUP_ROOT"; do
      available_bytes="$(df -PB1 --output=avail "$path" | tail -n 1 | tr -d ' ')"
      [[ "$available_bytes" =~ ^[0-9]+$ ]] ||
        die "cannot read available disk for $path"
      (( available_bytes >= 10737418240 )) ||
        die "available disk is below 10 GiB for $path"
    done

    "$SCRIPT_DIR/check-dns"
    docker network inspect caddy-net >/dev/null ||
      die "external caddy-net is absent"
    compose_prod config >/dev/null
    "$SCRIPT_DIR/render-config"
    "$SCRIPT_DIR/init-database"
    compose_prod up -d
    wait_for_odoo

    sudo install -d -m 0755 /etc/caddy/sites
    caddy_backup="$(mktemp /tmp/Caddyfile.osi-odoo.XXXXXX)"
    sudo cp --preserve=mode,ownership,timestamps \
      /etc/caddy/Caddyfile "$caddy_backup"
    fragment_backup=""
    if sudo test -f /etc/caddy/sites/osi-odoo.caddy; then
      fragment_backup="$(mktemp /tmp/osi-odoo.caddy.XXXXXX)"
      sudo cp --preserve=mode,ownership,timestamps \
        /etc/caddy/sites/osi-odoo.caddy "$fragment_backup"
    fi
    caddy_applied=false
    rollback_caddy() {
      local status=$?
      if (( status != 0 )) && [[ "$caddy_applied" != true ]]; then
        sudo cp "$caddy_backup" /etc/caddy/Caddyfile
        if [[ -n "$fragment_backup" ]]; then
          sudo cp "$fragment_backup" /etc/caddy/sites/osi-odoo.caddy
        else
          sudo rm -f /etc/caddy/sites/osi-odoo.caddy
        fi
      fi
      rm -f -- "$caddy_backup" "$fragment_backup"
      return "$status"
    }
    trap rollback_caddy EXIT

    if sudo grep -Rqs \
      'odoo-test\.opensmartirrigation\.org' \
      /etc/caddy/Caddyfile /etc/caddy/sites &&
       ! sudo test -f /etc/caddy/sites/osi-odoo.caddy; then
      die "unmanaged Odoo Caddy route already exists"
    fi
    sudo install -o root -g root -m 0644 \
      "$REPO_ROOT/deploy/Caddyfile.fragment" \
      /etc/caddy/sites/osi-odoo.caddy
    if ! sudo grep -Fqx 'import /etc/caddy/sites/*.caddy' \
      /etc/caddy/Caddyfile; then
      printf '\n# OSI managed site fragments\nimport /etc/caddy/sites/*.caddy\n' |
        sudo tee -a /etc/caddy/Caddyfile >/dev/null
    fi
    sudo caddy validate --config /etc/caddy/Caddyfile \
      --adapter caddyfile
    sudo systemctl reload caddy
    caddy_applied=true
    trap - EXIT
    rm -f -- "$caddy_backup" "$fragment_backup"

    sudo install -o root -g root -m 0644 \
      "$REPO_ROOT/systemd/osi-odoo-backup.service" \
      /etc/systemd/system/osi-odoo-backup.service
    sudo install -o root -g root -m 0644 \
      "$REPO_ROOT/systemd/osi-odoo-backup.timer" \
      /etc/systemd/system/osi-odoo-backup.timer
    sudo systemctl daemon-reload
    sudo systemctl enable --now osi-odoo-backup.timer
    record_current_release
    operation_lock_leave_outer
    sudo systemctl start osi-odoo-backup.service
    sudo systemctl is-active osi-odoo-backup.timer
    sudo systemctl list-timers osi-odoo-backup.timer --no-pager |
      grep -q osi-odoo-backup.timer

    curl --fail --silent --show-error --max-time 20 \
      https://odoo-test.opensmartirrigation.org/web/login >/dev/null
    login_page="$(curl --fail --silent --show-error --max-time 20 \
      https://odoo-test.opensmartirrigation.org/web/login)"
    asset_path="$(printf '%s' "$login_page" | \
      sed -n 's/.*src="\([^" ]*\/web\/assets\/[^" ]*\.js\)".*/\1/p' | \
      head -n 1)"
    [[ -n "$asset_path" ]] || die "login page has no JavaScript asset"
    curl --fail --silent --show-error --max-time 20 \
      "https://odoo-test.opensmartirrigation.org$asset_path" >/dev/null
    redirect="$(curl --silent --output /dev/null --write-out '%{http_code}|%{redirect_url}' \
      --max-time 20 http://odoo-test.opensmartirrigation.org/web/login)"
    [[ "$redirect" == 3??\|https://* ]] ||
      die "HTTP does not redirect to HTTPS"
    curl --fail --silent --show-error --max-time 20 \
      https://odoo-test.opensmartirrigation.org/websocket/health \
      >/dev/null
    manager_status="$(curl --silent --output /dev/null \
      --write-out '%{http_code}' --max-time 20 \
      https://odoo-test.opensmartirrigation.org/web/database/manager)"
    [[ "$manager_status" != 200 ]] ||
      die "database manager is publicly available"
    if compose_prod logs --since 5m odoo 2>&1 | \
       grep -Eqi 'Traceback|database .* does not exist|connection refused'; then
      die "Odoo logs contain a startup or database error"
    fi
    if sudo journalctl -u caddy --since '-5 minutes' --no-pager | \
       grep -Eqi 'proxy loop|no such host|connection refused'; then
      die "Caddy logs contain an upstream routing error"
    fi
    echo "PASS: deployed Odoo, Caddy, DNS, and backup timer"

This script does not run Odoo test tags against osi_odoo_test. Its live checks are health and read-only HTTP checks.

### Step 4: Write the operator contract in README

Replace README.md with this complete content:

    # OSI Odoo test environment

    This repository deploys Odoo 19 Community and PostgreSQL 17 at
    `odoo-test.opensmartirrigation.org`. It is a test and demonstration system.
    Do not enter real customer data or reuse real customer credentials.

    ## Runtime boundary

    `compose.yaml` is the base file for disposable projects. It has no published
    ports, global container names, or Caddy attachment. The deployed project also
    uses `compose.test-vps.yaml`, which gives Odoo the unique `osi-odoo` alias on
    `caddy-net`. PostgreSQL remains internal.

    Copy `.env.example` to `.env`, replace every password placeholder with
    `openssl rand -hex 32`, and set mode 0600. Never print or commit `.env`.
    `scripts/deploy` requires `/opt/osi-odoo`, user `rocky`, at least 4 GiB
    MemAvailable, and at least 10 GiB free for both the repository and backup path.
    The memory floor covers the 3 GiB combined Odoo/PostgreSQL caps plus 1 GiB
    for the host, Docker, Caddy, and the existing service workload.
    On 2026-08-21 the target reported 11 GiB total memory, 6.9 GiB MemAvailable,
    and 33 GiB free disk. Those readings clear the floors; the deploy preflight
    remains mandatory because current availability can fall below them.

    After DNS points to the VPS and `caddy-net` exists, deploy with:

        cd /opt/osi-odoo
        scripts/deploy

    The command validates DNS and full Caddy configuration, initializes or updates
    the database, installs the persistent backup timer, records the accepted
    release identity, and checks HTTPS without printing credentials.

    ## Initialize or upgrade

        OSI_RUNTIME_MODE=production scripts/init-database

    The command installs both OSI modules when the registry is empty or both are
    uninstalled, upgrades both when both are installed, and stops on every mixed
    or pending state. Never run `--test-enable` or `--test-tags` against
    `osi_odoo_test`; the test scripts use disposable projects.

    For an intentional module update, run:

        OSI_RUNTIME_MODE=production scripts/update-modules

    The backup, restore, update, and deploy commands share one non-blocking
    operation lock. A concurrent invocation exits with `ERROR: another Odoo
    operation is active`.

    ## Paired backups

        OSI_RUNTIME_MODE=production scripts/backup

    Each completed directory contains a quiesced PostgreSQL custom dump, its
    matching filestore archive, `manifest.json`, and `SHA256SUMS`. The manifest
    records the Git commit and immutable image RepoDigests. The daily persistent
    systemd timer retains the newest 14 completed sets.

    Validate and restore a backup into an isolated disposable project without
    stopping the deployed service:

        scripts/validate-backup /home/rocky/backups/osi-odoo/TIMESTAMP
        scripts/restore-rehearsal /home/rocky/backups/osi-odoo/TIMESTAMP

    For an operator-confirmed live replacement:

        OSI_RUNTIME_MODE=production scripts/restore-production \
          /home/rocky/backups/osi-odoo/TIMESTAMP \
          --confirm-replace-live

    Production restore verifies a uniquely named candidate database and filestore
    before switching names while Odoo is stopped. It retains the prior database
    and filestore under the printed shared suffix and retains a fresh pre-restore
    backup. It never drops or empties the live pair first.

    ## Failed-update recovery

    A failed update leaves Odoo stopped and writes `failed-update.json` in its
    paired backup. Do not start candidate code against prior data. Recovery order
    is mandatory:

    1. Keep Odoo stopped.
    2. Read `prior_release.git_commit` and the two immutable
       `prior_release.images.*.repo_digest` values from the report.
    3. Check out that prior Git commit, pull each recorded RepoDigest, and tag it
       with the recorded image reference.
    4. From that prior release, run `scripts/restore-production BACKUP_DIR
       --confirm-replace-live`.
    5. Restart only after its candidate verification and health check pass.

    Run the sequence without printing secret values:

        report=/home/rocky/backups/osi-odoo/TIMESTAMP/failed-update.json
        test -f "$report"
        backup_dir="$(jq -r .backup "$report")"
        prior_commit="$(jq -r .prior_release.git_commit "$report")"
        export OSI_RECOVERY_REPORT="$report"
        git switch --detach "$prior_commit"
        for image in odoo postgres; do
          reference="$(jq -r ".prior_release.images.$image.reference" "$report")"
          repo_digest="$(jq -r ".prior_release.images.$image.repo_digest" "$report")"
          docker pull "$repo_digest"
          docker tag "$repo_digest" "$reference"
        done
        OSI_RUNTIME_MODE=production scripts/restore-production \
          "$backup_dir" --confirm-replace-live

    Retained database, filestore, and backup cleanup is a separate, deliberate
    operator action after acceptance.

    ## Business-data warnings

    Before issuing any real invoice, an authorized operator must validate the
    legal address, VAT number, banking details, registration details, Swiss chart,
    and every applicable tax. Demo identifiers start with `DEMO-`; they are not
    operational records.

Use literal TIMESTAMP only in README examples; scripts reject it because realpath requires an existing backup.

### Step 5: Run deterministic local gates

Run:

    chmod 0700 scripts/check-dns scripts/deploy
    chmod 0644 deploy/Caddyfile.fragment README.md
    shellcheck scripts/lib.sh scripts/test-env scripts/render-config scripts/test-bootstrap \
      scripts/test-module scripts/test-business-setup scripts/test-projects \
      scripts/test-demo scripts/test-demo-lifecycle scripts/init-database scripts/test-init-database \
      scripts/test-coexistence \
      scripts/validate-backup scripts/backup scripts/restore-rehearsal \
      scripts/restore-production scripts/update-modules \
      scripts/test-backup-restore scripts/check-dns scripts/deploy \
      postgres-init/010-odoo.sql.sh
    docker compose --env-file .env.example -f compose.yaml config \
      >/dev/null
    test -f /home/phil/Repos/osi-os/.claude/skills/anti-slop-writing/slop-check.js
    node /home/phil/Repos/osi-os/.claude/skills/anti-slop-writing/slop-check.js \
      README.md
    git diff --check

Expected: shellcheck has no findings, Compose renders, prose check reports no violations.

### Step 6: Commit

    git add deploy/Caddyfile.fragment scripts/check-dns \
      scripts/deploy README.md .env.example
    git commit -m "feat: deploy Odoo test environment"

## Task 9: Deploy to the test VPS and collect acceptance evidence

This task mutates the authorized test host only. It must not connect to osicloud.ch or any production OSI gateway.

### Step 1: Record coexistence state before transfer

Run:

    ssh rocky@157.180.43.235 'bash -se' <<'REMOTE' \
      | tee /tmp/osi-odoo-containers.before
    set -Eeuo pipefail
    while read -r container_id; do
      project="$(docker inspect -f \
        '{{index .Config.Labels "com.docker.compose.project"}}' \
        "$container_id")"
      [[ "$project" == osi-odoo ]] && continue
      docker inspect -f \
        '{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{index .Config.Labels "com.docker.compose.project"}}' \
        "$container_id"
    done < <(docker ps -aq) | sort
    REMOTE
    ssh rocky@157.180.43.235 \
      'curl -fsS https://server.opensmartirrigation.org/actuator/health' \
      >/tmp/osi-server-health.before

Stop if either command fails.

### Step 2: Transfer only repository files

From /home/phil/Repos/osi-odoo:

    ssh rocky@157.180.43.235 \
      'sudo install -d -o rocky -g rocky -m 0750 /opt/osi-odoo'
    rsync -a --delete \
      --exclude .env \
      --exclude backups \
      ./ rocky@157.180.43.235:/opt/osi-odoo/
    local_commit="$(git rev-parse HEAD)"
    [[ "$local_commit" =~ ^[0-9a-f]{40}$ ]]
    remote_commit="$(ssh rocky@157.180.43.235 \
      'git -C /opt/osi-odoo rev-parse HEAD')"
    test "$remote_commit" = "$local_commit"

The --delete target is the explicit application directory /opt/osi-odoo, never /opt or a home directory.

The transfer includes .git. The exact comparison above is mandatory because release state and backup manifests record the deployed commit.

### Step 3: Create the mode-0600 host environment without printing secrets

Run this only when /opt/osi-odoo/.env is absent:

    ssh rocky@157.180.43.235 'bash -se' <<'REMOTE'
    set -Eeuo pipefail
    test ! -e /opt/osi-odoo/.env
    umask 077
    db_password="$(openssl rand -hex 32)"
    postgres_admin_password="$(openssl rand -hex 32)"
    master_password="$(openssl rand -hex 32)"
    admin_password="$(openssl rand -hex 32)"
    {
      echo 'COMPOSE_PROJECT_NAME=osi-odoo'
      echo 'ODOO_DB_NAME=osi_odoo_test'
      echo 'ODOO_DB_OWNER=odoo_owner'
      echo 'ODOO_DB_USER=odoo_app'
      printf 'ODOO_DB_PASSWORD=%s\n' "$db_password"
      printf 'ODOO_POSTGRES_ADMIN_PASSWORD=%s\n' \
        "$postgres_admin_password"
      printf 'ODOO_MASTER_PASSWORD=%s\n' "$master_password"
      echo 'OSI_ODOO_ADMIN_LOGIN=admin'
      printf 'OSI_ODOO_ADMIN_PASSWORD=%s\n' "$admin_password"
      echo 'BACKUP_ROOT=/home/rocky/backups/osi-odoo'
      echo 'OSI_ODOO_LOCK_DIR=/home/rocky/.local/state/osi-odoo'
      echo 'EXPECTED_PUBLIC_IPV4=157.180.43.235'
      echo 'EXPECTED_PUBLIC_IPV6='
    } >/opt/osi-odoo/.env
    chmod 0600 /opt/osi-odoo/.env
    REMOTE

Whether the file was created now or already existed, run this exact validation. It reads values inside the remote Python process and prints nothing:

    ssh rocky@157.180.43.235 'python3 -' <<'PY'
    import os
    import pathlib
    import re

    path = pathlib.Path("/opt/osi-odoo/.env")
    stat = path.stat()
    if stat.st_mode & 0o777 != 0o600:
        raise SystemExit("ERROR: .env mode is not 0600")
    if stat.st_uid != os.getuid():
        raise SystemExit("ERROR: .env owner is not rocky")
    required = {
        "COMPOSE_PROJECT_NAME",
        "ODOO_DB_NAME",
        "ODOO_DB_OWNER",
        "ODOO_DB_USER",
        "ODOO_DB_PASSWORD",
        "ODOO_POSTGRES_ADMIN_PASSWORD",
        "ODOO_MASTER_PASSWORD",
        "OSI_ODOO_ADMIN_LOGIN",
        "OSI_ODOO_ADMIN_PASSWORD",
        "BACKUP_ROOT",
        "OSI_ODOO_LOCK_DIR",
        "EXPECTED_PUBLIC_IPV4",
        "EXPECTED_PUBLIC_IPV6",
    }
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise SystemExit("ERROR: invalid .env assignment")
        key, value = line.split("=", 1)
        if key in values:
            raise SystemExit("ERROR: duplicate .env key")
        values[key] = value
    if required - values.keys():
        raise SystemExit("ERROR: required .env key is absent")
    for key in (
        "ODOO_DB_PASSWORD",
        "ODOO_POSTGRES_ADMIN_PASSWORD",
        "ODOO_MASTER_PASSWORD",
        "OSI_ODOO_ADMIN_PASSWORD",
    ):
        if not re.fullmatch(r"[0-9a-f]{64}", values[key]):
            raise SystemExit(f"ERROR: {key} violates the hex contract")
    if values["COMPOSE_PROJECT_NAME"] != "osi-odoo":
        raise SystemExit("ERROR: wrong Compose project")
    if values["ODOO_DB_NAME"] != "osi_odoo_test":
        raise SystemExit("ERROR: wrong live database")
    PY

### Step 4: Run deployment and read-only live assertions

    ssh rocky@157.180.43.235 \
      'cd /opt/osi-odoo && scripts/deploy'

Then run only read-only SQL against the live database:

    ssh rocky@157.180.43.235 'bash -se' <<'REMOTE'
    set -Eeuo pipefail
    cd /opt/osi-odoo
    docker compose --env-file .env --project-name osi-odoo \
      -f compose.yaml -f compose.test-vps.yaml \
      exec -T db psql -U odoo_admin -d osi_odoo_test \
      -v ON_ERROR_STOP=1 <<'SQL'
    SELECT CASE WHEN (
      SELECT count(*) FROM ir_module_module
      WHERE name IN ('osi_business_setup','osi_business_demo')
        AND state='installed'
    ) = 2 THEN 1 ELSE 1/0 END;
    SELECT CASE WHEN (
      SELECT count(*) FROM project_project WHERE is_template
    ) = 5 THEN 1 ELSE 1/0 END;
    SELECT CASE WHEN (
      SELECT count(*) FROM project_task
      WHERE project_id IN (
        SELECT id FROM project_project WHERE is_template
      ) AND is_template
    ) = 0 THEN 1 ELSE 1/0 END;
    SELECT CASE WHEN (
      SELECT count(*) FROM stock_warehouse
    ) = 1 THEN 1 ELSE 1/0 END;
    SQL
    REMOTE

Do not add --test-enable or --test-tags to any live command.

### Step 5: Prove backup, rehearsal restore, and timer

    ssh rocky@157.180.43.235 'bash -se' <<'REMOTE'
    set -Eeuo pipefail
    cd /opt/osi-odoo
    export OSI_RUNTIME_MODE=production
    backup_output="$(scripts/backup)"
    backup_dir="$(printf '%s\n' "$backup_output" | tail -n 1)"
    test -d "$backup_dir"
    scripts/validate-backup "$backup_dir"
    scripts/restore-rehearsal "$backup_dir"
    sudo systemctl is-active osi-odoo-backup.timer
    sudo systemctl list-timers osi-odoo-backup.timer --no-pager |
      grep -q osi-odoo-backup.timer
    REMOTE

Expected:

    PASS: backup manifest and payloads
    PASS: isolated rehearsal restore

### Step 6: Verify existing services and isolation

    ssh rocky@157.180.43.235 'bash -se' <<'REMOTE' \
      | tee /tmp/osi-odoo-containers.after
    set -Eeuo pipefail
    while read -r container_id; do
      project="$(docker inspect -f \
        '{{index .Config.Labels "com.docker.compose.project"}}' \
        "$container_id")"
      [[ "$project" == osi-odoo ]] && continue
      docker inspect -f \
        '{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{index .Config.Labels "com.docker.compose.project"}}' \
        "$container_id"
    done < <(docker ps -aq) | sort
    REMOTE
    ssh rocky@157.180.43.235 \
      'curl -fsS https://server.opensmartirrigation.org/actuator/health' \
      >/tmp/osi-server-health.after
    cmp /tmp/osi-server-health.before /tmp/osi-server-health.after
    cmp /tmp/osi-odoo-containers.before \
      /tmp/osi-odoo-containers.after
    ssh rocky@157.180.43.235 'bash -se' <<'REMOTE'
    set -Eeuo pipefail
    mapfile -t db_ids < <(docker ps -q \
      --filter label=com.docker.compose.project=osi-odoo \
      --filter label=com.docker.compose.service=db)
    test "${#db_ids[@]}" -eq 1
    test -z "$(docker port "${db_ids[0]}")"
    test "$(docker inspect -f '{{.HostConfig.Memory}}' "${db_ids[0]}")" \
      = 1073741824
    test "$(docker inspect -f '{{.HostConfig.NanoCpus}}' "${db_ids[0]}")" \
      = 1000000000
    REMOTE

The sorted tuples exclude only the osi-odoo Compose project and are compared byte-for-byte. The database container is resolved through both Compose labels; no generated name is guessed.

### Step 7: Manual acceptance and stop conditions

An operator must:

1. open https://odoo-test.opensmartirrigation.org/web/login;
2. log in with the generated administrator credential without recording it;
3. inspect Switzerland, CHF, the Swiss chart, one warehouse, catalog, five templates, and the marked demo workflow;
4. confirm that /web/database/manager is unavailable;
5. enter and validate legal address, VAT, banking, registration, and tax details before any real invoice.

Stop and report without rollback if:

- DNS differs from the configured address set;
- Caddy validation or reload fails;
- any existing service changes health;
- a backup half or checksum is missing;
- rehearsal restore fails;
- Odoo module state is partial;
- an update failed and the prior release/images have not been reactivated before its paired production restore.

## Final verification matrix

| Surface | Command or evidence | Pass signal |
|---|---|---|
| Config ownership | scripts/test-bootstrap | runtime odoo user reads mode-0600 file |
| DB privileges | scripts/test-bootstrap | four named denials and table create/drop |
| Swiss setup | scripts/test-business-setup | TestBusinessSetup discovered and green |
| Project semantics | scripts/test-projects | 5 project templates, 9 ordinary tasks |
| Demo stock/idempotence | scripts/test-demo | receipt and delivery done, no negative quant |
| Demo lifecycle | Task 5 lifecycle gate | upgrade, uninstall absence, reinstall counts |
| Init state machine | scripts/test-init-database | init, update, named partial-state failure |
| Compose isolation | Task 6 coexistence gate | two healthy stacks, six distinct volumes |
| Backup/recovery | scripts/test-backup-restore | boundary write blocked, shared lock excludes concurrency, attachment row/file pair restores |
| Production swap | scripts/test-backup-restore | four mutation-then-nonzero rollbacks reconcile old pair; successful disposable swap retains old pair |
| Update failure | scripts/test-backup-restore | exit 97, Odoo stopped, backup restorable |
| Timer | systemctl list-timers | next trigger and successful manual invocation |
| DNS/Caddy | scripts/deploy | normalized DNS, full-config validation, HTTPS |
| Coexistence | before/after inventory | prior services unchanged |

The implementation is complete only when every row has fresh evidence.
