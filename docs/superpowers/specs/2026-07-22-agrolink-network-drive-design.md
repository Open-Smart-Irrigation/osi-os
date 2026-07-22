# AgroLink network-drive integration — design

**Date:** 2026-07-22
**Status:** Approved direction, pending implementation plan
**Context:** The AgroLink hub (Pi 5, OSI OS) will sit inside the Agroscope "Fola" research network, which exposes a Windows file share that every researcher PC maps as `O:`. The hub must drop per-account sensor CSVs onto that share and import external sensor CSVs from it.
**Companion specs:** [2026-07-19-agrolink-scoped-multiuser-design.md](2026-07-19-agrolink-scoped-multiuser-design.md) (account model this feature attaches to), [2026-07-19-agrolink-hub-hardening-design.md](2026-07-19-agrolink-hub-hardening-design.md)
**Review provenance:** transport options and failure modes reviewed by a senior-engineer consult on 2026-07-22; the consult killed the original JS-library plan with verified evidence (SMB signing gap, NTLM deprecation) and its recommendations are folded in below.

## 1. Goal and non-goals

Each AgroLink account gets a folder pair on the Agroscope share: the hub writes that account's scoped sensor data there as CSV, and imports external sensor CSVs that researchers or other systems drop into the paired import folder. The hub's SQLite stays the source of truth; every file on the share is regenerable.

Non-goals: treating the share as a system of record, per-researcher AD credentials on the hub, kernel CIFS mounts, free-text folder paths typed by researchers, syncing any drive-related state to the OSI cloud, and any behavior change for gateways without the feature flag.

## 2. Verified environment facts

Diagnosed 2026-07-22 from a standard-user domain workstation (Windows 11, build 26200) inside the Agroscope network:

| Fact | Value | Consequence |
|---|---|---|
| `O:` target | DFS namespace `\\agsad.admin.ch\AGROSCOPE`, current referral target `\\AGS-VCH-0101.agsad.admin.ch\AGROSCOPE` (10.183.20.10) | Configure the namespace path, not the server; survives their next file-server migration |
| NTLM acceptance | `net use` by IP succeeded, which forces NTLMv2 | Stock OpenWrt `samba4-client` works today without a Kerberos build |
| Domain controller | `AGS-VPO-0101.agsad.admin.ch` | Domain-based DFS referral requires DC reachability from the hub VLAN (open IT question) |
| Client signing policy | `RequireSecuritySignature=0` on the workstation | Server-side signing mandate unknown; irrelevant, `smbclient` negotiates signing either way |

Two limits of this diagnosis: the workstation's NTLM success does not guarantee the future service account escapes account-level NTLM restrictions, and nothing here tests reachability (TCP/445 to the file server, DC access for DFS, DNS for `agsad.admin.ch`) from the network segment the hub will occupy. Both stay on the IT question list (Appendix A).

## 3. Locked decisions

| # | Decision | Reason |
|---|---|---|
| D1 | All drive I/O goes through one transfer-seam module; nothing else in the codebase knows SMB exists | Backend swap (local, smbclient, Kerberos build, option D) never touches pipelines |
| D2 | First real backend: `smbclient` from the stock OpenWrt 24.10 `samba4-client` package (Samba 4.18), subprocess per batch | SMB 3.1.1 with signing, encryption, and DFS referrals; NTLMv2 verified accepted (§2); installable without reflash |
| D3 | Pure-JS SMB libraries rejected | No SMB signing support (open upstream issue), NTLM-only against a domain actively reducing NTLM; fails outright on hardened servers |
| D4 | Kernel CIFS mount rejected | Needs firmware reflash (kmod not in image); an unreachable server can hang mounted-path I/O in uninterruptible sleep on the device that runs irrigation |
| D5 | Folder paths are derived (`<root>/<account-slug>/export\|import`), admin-only override | With one service account, hub code is the only boundary between researchers; hand-typed paths would put that boundary in the hands it constrains |
| D6 | Drive files are a derived mirror | Regeneration from SQLite replaces a durable queue; outage recovery is a watermark catch-up |
| D7 | Imported data lands in a new edge-local `external_readings` table, not in `device_data` | Fake devices would drag in the sync contract, ChirpStack provisioning, and cloud-side effects for a chart overlay we can build directly |
| D8 | New tables are excluded from cloud sync: no sync triggers, no contract changes, nothing near the frozen `sync-init-fn` boot node | Keeps this feature out of the highest-risk subsystem |
| D9 | Auth failure stops transfers and alarms; no automatic retry until an admin re-enables | Server 2025 ships an SMB auth rate limiter and federal lockout thresholds are low; a retry loop converts one bad password into a locked account |
| D10 | Whole feature behind a per-gateway flag `OSI_NETWORK_DRIVE`, default off, code on osi-os mainline | Same rollout pattern as scoped access (its D7); existing farms unaffected |
| D11 | Kerberos client and Windows-side intermediary are specced contingencies, not built (§13) | Each has a named trigger; building either now is waste |

## 4. Architecture: the transfer seam

One backend module (Node-RED shared lib, `osiLib` pattern) exposes four operations: `health()`, `list(relPath)`, `get(relPath)`, `putAtomic(relPath, content)`. Callers pass share-relative paths; the module owns credentials, connection, timeout, and path enforcement (§5).

Backends behind the seam:

- **`local`** — a directory on disk. Used by development, CI, and unit tests; also the first thing built, so every pipeline, GUI element, and validation rule ships and is testable before any SMB code exists.
- **`smbclient`** — one subprocess per batch. Credentials come from a root-owned `0600` file passed with `-A`, never on the command line. Each subprocess gets a hard timeout (default 30 s per operation) and SIGKILL on expiry; a userspace TCP client dies cleanly, no kernel state involved. A fresh session per batch sidesteps Windows idle-session teardown and firewall state timeouts.

Gateway-level configuration (admin only, UCI section `osi-server.drive`): `enabled`, `unc` (the DFS namespace path), `root` (agreed AgroLink subtree on the share), `credentials_file` (default `/etc/osi/drive.cred`), `direct_unc` (optional fallback target if DC-based DFS referral proves unreachable from the hub VLAN). Exact key names follow the conventions in the osi-config-and-flags skill at plan time.

On `NT_STATUS_LOGON_FAILURE` or `NT_STATUS_ACCESS_DENIED` the module sets a persistent alarm state, disables further transfers, and surfaces the state in the GUI and health telemetry (D9). All other failures (timeout, unreachable, share missing) count as "share down": the cycle is skipped and staleness tracking continues.

## 5. Folder model and path enforcement

Each enabled account owns `<root>/<slug>/export/` and `<root>/<slug>/import/`. The slug derives from the username: lowercased, Windows-illegal characters (`<>:"/\|?*`), reserved names (`CON`, `NUL`, `COM1`…), trailing dots and spaces all rejected or mapped, uniqueness enforced case-insensitively because NTFS folder names collide by case. The GUI shows the researcher their folders as copyable `O:\...` paths.

Admins may override either path per account. Overrides and derived paths get identical treatment: validation runs at time of use inside the transfer seam, not only at configuration time. The seam canonicalizes, rejects `..` segments and NTFS alternate-data-stream syntax (`file.csv:stream`), and requires the `root` prefix. Config-time validation exists too, but as UX; the seam check is the security boundary.

The hub also creates missing account folders on first use, so provisioning a new researcher needs no manual folder work beyond the Windows-side subtree existing.

## 6. Export pipeline

A scheduled worker runs hourly with ±10 min jitter (avoids their nightly backup and AV windows; makes 25 accounts not stampede at once). Per enabled account, per zone in the account's scope: read rows from SQLite since the account-zone watermark, regenerate the current day file, publish it, advance the watermark. Layout:

```
<root>/<slug>/export/<zone-slug>/2026/07/<zone-slug>_20260722.csv
```

Date partitioning caps directory sizes (25 accounts at hourly cycles produce hundreds of thousands of files per year if left flat). Filenames carry no colons; `2026-07-22T10:30:00` is an illegal Windows name.

Publish is `putAtomic`: write `<name>.csv.tmp`, delete the existing target, rename. SMB rename does not overwrite, so the delete is required; the sub-second window where no file exists is acceptable under D6. Files are never appended in place, because researchers hold CSVs open in Excel for days and an open file rejects writers.

CSV format, fixed by the consult's Swiss-Excel findings: semicolon delimiter, UTF-8 with BOM (without it, `Bewässerung` renders as mojibake in Excel), header row naming the timezone (Europe/Zurich local time), and formula-injection sanitization: any cell starting with `=`, `+`, `-`, or `@` gets a leading apostrophe. Columns reuse the existing zone CSV export definition, including the paired `_pf` rows for positive SWT kPa values.

Watermarks live in `drive_export_state` (§8). Catch-up after an outage is regeneration from the oldest stale watermark forward. A staleness alarm fires when an account's last successful export is older than 3 cycle intervals; it appears in the GUI and in health telemetry, because the natural failure mode of scheduled file drops is silent rot, not loud errors.

## 7. Import pipeline

A second worker polls each account's `import/` folder every 15 minutes. A file qualifies for ingestion when all of the following hold: extension `.csv`, size at most 10 MB, and identical size+mtime across two consecutive polls (the producer finished writing). Qualified files are fetched and content-hashed; a hash already present in the `drive_import_files` ledger is skipped, which makes re-drops of renamed or re-copied files harmless.

Parsing goes through a parser seam. The initial parser targets the external-sensor CSV format to be agreed with Agroscope (open dependency, §14); the seam exists so a second format is a new parser, not a pipeline change. Parsed rows are hard-validated: known metric names, numeric ranges, plausible timestamps. This folder is a trust boundary. Anyone on the network drive, including malware on a researcher PC, can write here, and its content flows toward irrigation research data.

Accepted rows land in `external_readings` (D7). Rejected files are quarantined in place: the original is never moved or deleted, and the worker writes `<name>.rejected.txt` beside it with a human-readable reason, which prevents silent re-drop loops. Per-account import caps (files per cycle, rows per day) stop one account's dump from starving the batch window.

The GUI shows imported series as overlays in the existing history charts, filtered by the viewing account's scope.

## 8. Schema

Three new edge-local tables, all excluded from sync (D8):

- `drive_export_state` — account uuid, zone uuid, watermark timestamp, last success, last error.
- `drive_import_files` — account uuid, share path, size, mtime, content hash, status (`imported`/`rejected`), reason, timestamps.
- `external_readings` — source series (account uuid, series label, unit), reading timestamp, metric, value, importing file reference.

Column lists are indicative; the plan phase finalizes them under the osi-schema-change-control skill: ordered migration in the next free `NNNN` slot, seed parity, and the full verifier suite (`verify-migrations`, `verify-seed-replay`, `verify-runtime-schema-parity`, `verify-db-schema-consistency`). No trigger touches anything the boot node manages.

## 9. GUI

Researcher view (flag-gated section in account settings): the two folder paths in `O:\` notation with copy buttons, per-zone last-export timestamps, import history with per-file status and rejection reasons, and the staleness state.

Admin view: connection health (last successful contact, alarm state, a "test connection" action that runs `health()` on demand), gateway drive configuration status, per-account overview with override editing, and the audit log (§10).

All strings go through the standard i18n pipeline. German is the primary field language at Agroscope; French and Italian follow the existing locale set.

## 10. Security and audit

The service account is the only Windows identity. Its credentials live in `/etc/osi/drive.cred`, root-owned, mode `0600`, outside every path the 20–30 GUI accounts can read, and never in the database, sync payloads, or logs. Rotation is a documented runbook step: while the credential is stale the hub is in the D9 alarm state and transfers stop. The Windows-side ask (Appendix A) is an ACL scoping the account to the AgroLink subtree only, which contains the blast radius of a hub compromise, plus denied interactive logon.

Because NTFS attributes every file to the service account, per-user attribution exists only on the hub. `drive_audit_log` records acting GUI account, operation, share path, content hash, and timestamp, append-only. That log is the answer when an auditor asks who wrote a file, and it is offered to Agroscope proactively rather than on demand.

Path enforcement is restated here because it is the actual inter-researcher boundary (D5): seam-level canonicalization and root-prefix checks at time of use, case-insensitive non-overlap of account folders, no free-text paths for non-admins.

## 11. Reliability and operations

The workers run as scheduled flows isolated from irrigation, scheduling, and sync; no HTTP request handler and no actuation path ever performs drive I/O. Subprocess timeouts plus SIGKILL bound every operation. A down share costs nothing but staleness: skipped cycles, watermarks holding position, catch-up on recovery (D6).

Known environmental hazards, accepted and handled: nightly backup and AV windows on the file server (jitter plus per-cycle retry), Windows Offline Files caching on researcher PCs showing stale folder views (documented for support; Appendix A asks IT to disable client-side caching on the subtree), and quota exhaustion on the share (surfaces as write failures, alarmed via staleness; retention expectations are an IT question).

## 12. Testing

CI runs the real `smbclient` backend against a Samba container hardened to imitate the target: SMB3-only, signing mandatory. Integration tests cover put-temp-delete-rename semantics, listing, timeout kill behavior, and the auth-failure stop (D9). Unit tests cover slug and path sanitization (umlauts, reserved names, case collisions, `..`, ADS syntax), CSV generation (BOM, semicolons, injection escaping, timezone header), and import handling of truncated files, oversize files, re-drops, and hash dedupe. Product logic tests run on the `local` backend.

Pre-commit spikes for the plan phase: install `samba4-client` on a 24.10 bcm2712 image and confirm the dependency set stays client-only; exercise the backend against a real Windows share (lab VM or, once network access exists, the target share read-only) to confirm DFS referral following and rename semantics.

## 13. Contingencies, specced not built

**Kerberos client.** Trigger: Agroscope IT mandates Kerberos-only, or NTLM is later switched off (their answer to Appendix A question 3 may include a sunset date). Path: custom `samba4` build via the OpenWrt 24.10 SDK with ADS enabled (the stock feed package is built `--without-ads` and cannot do Kerberos), plus MIT krb5 with a keytab and chrony against their NTP. Ships as a userspace package over the normal deploy flow, no reflash. Timeboxed to two weeks; if the spike fails, fall through to option D, not to a kernel mount, which would need the same krb5 userland plus keyring plumbing plus a reflash.

**Option D: Windows-side intermediary.** Trigger: IT refuses direct SMB from the hub's network segment, or refuses the service account. Path: a scheduled task on a managed Windows server exchanges CSVs with the hub over its authenticated HTTPS API; the hub already serves per-zone CSV export routes, so the hub-side delta is an import-upload endpoint plus integration tokens. A reference PowerShell script lives in the repo so their IT evaluates a concrete artifact. Cost is organizational (a change request and an owner on their side), which is why this is the fallback rather than the default.

## 14. Open dependencies

| Dependency | Blocks | State |
|---|---|---|
| Agroscope IT general approval of the gateway joining the network | Everything network-facing; the Appendix A questions go out only after it | Waiting (user decision 2026-07-22) |
| Appendix A answers, then a one-page written interface agreement (paths, account, auth, flows, rotation, contacts) | Backend choice confirmation, VLAN reachability, folder provisioning | Not started |
| External-sensor CSV format agreement | Import parser | Not started; parser seam isolates it |
| Service-account credential delivery | First live connection | Not started |

None of these block implementation: the seam, `local` backend, both pipelines, schema, GUI, and tests proceed now (D1); the `smbclient` backend proceeds against the CI Samba container.

## Appendix A: questions for Agroscope IT

To send after general approval; answers select between D2, the Kerberos contingency, and option D.

1. **Pattern.** Will you permit a non-domain-joined Linux device with an AD service account speaking SMB directly to the AGROSCOPE share? If not: would you operate a scheduled task on a managed Windows server exchanging CSVs with the device's authenticated HTTPS API? We support both; your answer selects the architecture.
2. **Network.** Which VLAN/zone does the device land in, and is the port 802.1X/NAC-controlled? From that segment: TCP/445 to the file server, TCP/88 and 464 to domain controllers (needed for domain-based DFS referral and any Kerberos), DNS resolution for `agsad.admin.ch`, and an internal NTP source? The device currently uses a Tailscale VPN uplink for management; is that acceptable, or must egress change?
3. **Auth policy.** Is NTLMv2 permitted for this service account, and if yes, with what sunset date? If Kerberos-only: can the account get AES-256 encryption types and a keytab?
4. **SMB mandates.** Signing required? Encryption required, globally or per share? Minimum dialect?
5. **Account mechanics.** Standard service account or gMSA-only policy? Rotation interval and secret-delivery process, lockout threshold, workstation restrictions, and whom we contact when the account locks.
6. **Namespace and subtree.** We target `\\agsad.admin.ch\AGROSCOPE`; any planned migration we should know about? Can we get a dedicated subtree (proposal: `...\AgroLink\<account>\{export,import}`) with the service account's NTFS rights scoped to that subtree only, and denied interactive logon?
7. **Server-side services on the subtree.** Quotas, FSRM file screens, on-access AV, backup windows, retention rules, and guidance on file counts. Please disable Offline Files/client-side caching on the subtree.
8. **Detection.** Whom do we notify so hourly service-account SMB from a device VLAN gets allowlisted by your SOC rather than paged on?
9. **Data handling.** Classification constraints on this share, and your standard Excel locale conventions (we assume semicolon-delimited, UTF-8 with BOM).
