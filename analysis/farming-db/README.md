# Farming DB R Analysis

This workspace opens local snapshots created by `scripts/download-farming-db.sh`.
Raw SQLite snapshots stay under ignored `.local/farming-db/` storage.

## First-Time Setup

From the repo root:

```r
install.packages("renv")
renv::restore(project = "analysis/farming-db")
```

Create a private gateway inventory:

```bash
mkdir -p .local/farming-db
cp analysis/farming-db/gateways.example.tsv .local/farming-db/gateways.tsv
```

Then fill in the host values in `.local/farming-db/gateways.tsv`.

## Download A Snapshot

```bash
scripts/download-farming-db.sh --gateway kaba100
scripts/download-farming-db.sh --all
```

Snapshots are written to:

```text
.local/farming-db/snapshots/<gateway>/<UTC timestamp>/farming.db
```

## Open In R

```r
source("analysis/farming-db/load_device_data.R")
db <- open_device_data(gateway = "kaba100")

db$device_data
db$dendrometer_readings
db$chameleon_readings

db$disconnect()
```

The loader opens the SQLite file read-only. It loads telemetry and device/zone
metadata only; it does not load `users`, password hashes, sync tokens, or other
auth tables.
