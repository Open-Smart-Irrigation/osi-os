# Real target release evidence

This report records two target jobs for OSI OS source commit
`b31825becbb8abcef86cfad9dc756cd2e351f135` (`main`). On 2026-08-02, the Pi 5
image was published and independently verified, while the Pi 4 image completed
the sealed acceptance contract.

The jobs ran before the current uncommitted GUI hardening edits in this
worktree. Those edits are not part of either image. The image content remains
pinned to the source SHA above.

## Release files

The published release directories are below the configured approved root
`/home/phil/sdcard-images/0.7`.

| target | evidence status | modes | image path | size | image SHA256 |
| --- | --- | --- | --- | ---: | --- |
| Pi 5, job `job_462666fdc5e4408b977c2be138ebdcb6`, target `rpi-5` | published and independently verified; immutable-contract acceptance remains open | directory `0700`; four files `0600` | `/home/phil/sdcard-images/0.7/main/b31825becbb8abcef86cfad9dc756cd2e351f135/rpi-5/chirpstack-gateway-os-4.9.0-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz` | 81,169,953 | `034a2c3cbb1575a866024e65fe133f96b794f4361190e38ac99e522172f268b7` |
| Pi 4, job `job_511cb730d8874453b8a9cf7422a08c73`, target `rpi-2` | sealed and accepted | directory `0555`; four files `0444` | `/home/phil/sdcard-images/0.7/main/b31825becbb8abcef86cfad9dc756cd2e351f135/rpi-2/chirpstack-gateway-os-4.9.0-full-bcm27xx-bcm2709-rpi-2-squashfs-factory.img.gz` | 83,333,849 | `427e392e979fafa1a30f4f6e9df39613bc75b1c18536910d96898c568bdb86d2` |

The release-side files were independently hashed after publication:

| target | `build-manifest.json` | `sha256sums` | `verification.json` |
| --- | --- | --- | --- |
| Pi 5 | `812777aae6441f215634681affc40e3b18bfbe0806b1ac9c8b7b7d44d0c8d630` | `e094f3657cc9394fafa1d72d7bff7c31e3dc56948f8f841e79e4067d30d3df73` | `e7cddd81cbc8198332e66443be8e1d358e446540f8caabd9dff4d78293e48d79` |
| Pi 4 | `f0e329192746f179b0f8355f88e86665b52001c453a8ddb1bdfd60d1c1e8e1ec` | `18c63cbcc82296573f584403b3f02b9eb3bc259dccf1302932c056e95adc36ad` | `f7b897241bd128ca4f78b63c5e20942b35481f343fbdb8322fb3f6ccb02ef369` |

## Pi 5 published verification evidence

The job, publication, and independent verification records passed. The release
directory is mode `0700` and its four files are mode `0600`, so this report does
not label the Pi 5 release as immutable-contract accepted.

Evidence report:

```text
/home/phil/.local/state/osi-image-builder/jobs/job_462666fdc5e4408b977c2be138ebdcb6/evidence/real-acceptance-report.json
SHA256: 673f84e5b5048ba2a29f596a04657152033be803d2e7697a6c4ed37eea128a2a
```

| field | value |
| --- | --- |
| branch and source SHA | `main` / `b31825becbb8abcef86cfad9dc756cd2e351f135` |
| target | `rpi-5`, profile `DEVICE_rpi-5`, OpenWrt `bcm27xx/bcm2712` |
| rootfs part size | `14336` |
| release modes | directory `0700`; `build-manifest.json`, image, `sha256sums`, and `verification.json` each `0600` |
| generated report time | `2026-08-02T12:34:04.979Z` |
| installed lock path | `/home/phil/.local/lib/osi-image-builder/0.1.22/builder.lock.json` |
| target manifest path | `/home/phil/.local/lib/osi-image-builder/0.1.22/manifest/targets.json` |
| Docker inspection evidence path | `/home/phil/.local/state/osi-image-builder/jobs/job_462666fdc5e4408b977c2be138ebdcb6/evidence/docker-inspection.json` |
| installed lock SHA256 | `065583d578e0ea92fb0332afff03666926d3114722dacbebd4f0fd4e2cda4f69` |
| target manifest SHA256 | `6abb9d2986032624070ff185e8d8be612ff99691507361e859add1f21cbd055a` |
| build manifest SHA256 | `812777aae6441f215634681affc40e3b18bfbe0806b1ac9c8b7b7d44d0c8d630` |
| Docker inspection SHA256 | `5bf531b31304f6817a492d49c0dda690e0e51bedc5544cc61878185db855d34e` |
| builder image digest | `fd954f0c9dd60f4d6fd2200d6f45631ee901c237d43645599fbf75cae8fde066` |
| canonical builder image | `osi-image-builder@sha256:fd954f0c9dd60f4d6fd2200d6f45631ee901c237d43645599fbf75cae8fde066` |
| image ID | `fd954f0c9dd60f4d6fd2200d6f45631ee901c237d43645599fbf75cae8fde066` |
| source evidence SHA256 | `5396cd9f0b268e31b09fc34736f10e06489e88d1916090905ffd911388b05836` |
| verify evidence SHA256 | `63259bc625ce1c9c8942631437849912a5b1e6441947ee78ec8cb1b1863aaaea` |
| image mtime | `2026-08-02T12:33:50.097Z` |
| freshness | `unknown`; `newerSourceAvailable=false` |
| `targetOutputAbsent` | `true` |
| `sqliteIntegrity` | `ok` |
| `chameleonCalibrationCount` | `0` |

Source and rootfs hashes:

| observation | SHA256 |
| --- | --- |
| source config | `1777a383e6160e8da61e38e91203a5e3d1a8fa94b2197c0bb287ffd0514afdc2` |
| resolved config | `6a2851e0a3bd96cfab0e4a47b398e86ac22f07701fb85408c2598a47cd581189` |
| source flows / rootfs flows | `ad41a82802da18049d09930eace9cefda523074b64df7de8dac646c3877d0df0` |
| source DB / rootfs DB | `f407b6f9386614573ec795eb6a868dc9cfacc7f9bf4d5cac21554acbd8faef02` |
| source GUI / feed GUI / rootfs GUI tree | `4955d5c73e8b9704451ca2693ee4d2dd2d5bb8be79abe0f9f5efea6058abf83b` |

All ten stage records have `outcome=passed`:

| stage | evidence path | SHA256 | operation ID or pass statement |
| --- | --- | --- | --- |
| preflight | `jobs/job_462666fdc5e4408b977c2be138ebdcb6/evidence/00-preflight.json` | `6a619efaad34f70b470e77aa1ac9be726af46e21f8b9dce058beb87c18ea7907` | host, Docker, SQLite, systemd, disk, and manifest checks passed |
| source | `jobs/job_462666fdc5e4408b977c2be138ebdcb6/evidence/01-source.json` | `5396cd9f0b268e31b09fc34736f10e06489e88d1916090905ffd911388b05836` | clean worktree and pinned head passed |
| release-gates | `jobs/job_462666fdc5e4408b977c2be138ebdcb6/evidence/02-release-gates.json` | `9fb0c77f4bf46cf7be70f7ac334986fd99b58cd299ba27ae5c28d6516e91490e` | `check-mqtt-topics` and listed release gates passed |
| frontend | `jobs/job_462666fdc5e4408b977c2be138ebdcb6/evidence/03-frontend.json` | `0d8adfb55c17833d4e105689e1ab30f9505cb63900a29fbf0bcbeba3ea2d8019` | `mirror-gui` and frontend operations passed |
| target-setup | `jobs/job_462666fdc5e4408b977c2be138ebdcb6/evidence/04-target-setup.json` | `f15f9a5c548f92f07ffd79f3978cf7e29058bbe4c7b8b03c03cc538fe0f8c46d` | `activate-target` selected `rpi-5` |
| feeds | `jobs/job_462666fdc5e4408b977c2be138ebdcb6/evidence/05-feeds.json` | `7bf3ad83cf43b4325ee39e9daadddff91626d9577dfdffde1de7e75f674a6257` | `install-feeds` passed |
| config | `jobs/job_462666fdc5e4408b977c2be138ebdcb6/evidence/06-config.json` | `a882c05094b8a50d84307ccdfb49f62a029f9bdda446f6e4435c075d81a3ef3d` | `resolve-config` selected `DEVICE_rpi-5` and `bcm27xx/bcm2712` |
| build | `jobs/job_462666fdc5e4408b977c2be138ebdcb6/evidence/07-build.json` | `ecc6373cfe4050d4086933d578feea5bbea92496e871b270c4d8830723b1ea17` | `build-image` passed |
| verify | `jobs/job_462666fdc5e4408b977c2be138ebdcb6/evidence/08-verify.json` | `63259bc625ce1c9c8942631437849912a5b1e6441947ee78ec8cb1b1863aaaea` | `verify-image` passed artifact, gzip, checksum, rootfs, SQLite, and runtime checks |
| publish | `jobs/job_462666fdc5e4408b977c2be138ebdcb6/evidence/09-publish.json` | `fc49f3de4ddd5e28cca8f9bc692077ff04e89fedd2db2f812f4f8ad55f10d2b5` | `final.verified=true`; publication committed |

## Pi 4 sealed acceptance evidence

The release directory is mode `0555` and its four files are mode `0444`. The
stored job and independent checks therefore support the sealed/accepted label.

Evidence report:

```text
/home/phil/.local/state/osi-image-builder/jobs/job_511cb730d8874453b8a9cf7422a08c73/evidence/real-acceptance-report.json
SHA256: a35f4033ac2eea6f3acc33fddba2668f83ae0f2f9e0d0f4f22edbc042783cfd7
```

| field | value |
| --- | --- |
| branch and source SHA | `main` / `b31825becbb8abcef86cfad9dc756cd2e351f135` |
| target | `rpi-2`, profile `DEVICE_rpi-2`, OpenWrt `bcm27xx/bcm2709` |
| rootfs part size | `14336` |
| release modes | directory `0555`; `build-manifest.json`, image, `sha256sums`, and `verification.json` each `0444` |
| generated report time | `2026-08-02T19:23:23.223Z` |
| installed lock path | `/home/phil/.local/lib/osi-image-builder/0.1.23/builder.lock.json` |
| target manifest path | `/home/phil/.local/lib/osi-image-builder/0.1.23/manifest/targets.json` |
| Docker inspection evidence path | `/home/phil/.local/state/osi-image-builder/jobs/job_511cb730d8874453b8a9cf7422a08c73/evidence/docker-inspection.json` |
| installed lock SHA256 | `7b502053c1fad7f63b573c00df07af0589292e7275bd7e82884706f828bfdad1` |
| target manifest SHA256 | `6abb9d2986032624070ff185e8d8be612ff99691507361e859add1f21cbd055a` |
| build manifest SHA256 | `f0e329192746f179b0f8355f88e86665b52001c453a8ddb1bdfd60d1c1e8e1ec` |
| Docker inspection SHA256 | `8a0ef27fa040c76c975c6e801f01e4be630c60cfc40c53b259337b619d4abfad` |
| builder image digest | `6496788cce5e2c8ad4d4ea3aab39e8bd0b85ee0272333715d948c2f9a2a1d740` |
| canonical builder image | `osi-image-builder@sha256:6496788cce5e2c8ad4d4ea3aab39e8bd0b85ee0272333715d948c2f9a2a1d740` |
| image ID | `6496788cce5e2c8ad4d4ea3aab39e8bd0b85ee0272333715d948c2f9a2a1d740` |
| source evidence SHA256 | `49d8549812cb1ce55541fc8c75823732ea03dc6822e70b0839fb6c47d795a783` |
| verify evidence SHA256 | `2788d1869039939db5eece29b760e0ab35448499ea72779bd2cf34b9e2dd6a71` |
| image mtime | `2026-08-02T19:23:07.519Z` |
| freshness | `unknown`; `newerSourceAvailable=false` |
| `targetOutputAbsent` | `true` |
| `sqliteIntegrity` | `ok` |
| `chameleonCalibrationCount` | `0` |

Source and rootfs hashes:

| observation | SHA256 |
| --- | --- |
| source config | `a478add1008d9be7b3595b7b62f1a353cbe38130e3a6ac84b41fbd14cdfce828` |
| resolved config | `fd8878c023ec4bfc896021ca88b9096e04976c04cc9134536b0aa7dbb4768a79` |
| source flows / rootfs flows | `ad41a82802da18049d09930eace9cefda523074b64df7de8dac646c3877d0df0` |
| source DB / rootfs DB | `f407b6f9386614573ec795eb6a868dc9cfacc7f9bf4d5cac21554acbd8faef02` |
| source GUI / feed GUI / rootfs GUI tree | `4955d5c73e8b9704451ca2693ee4d2dd2d5bb8be79abe0f9f5efea6058abf83b` |

All ten stage records have `outcome=passed`:

| stage | evidence path | SHA256 | operation ID or pass statement |
| --- | --- | --- | --- |
| preflight | `jobs/job_511cb730d8874453b8a9cf7422a08c73/evidence/00-preflight.json` | `a304eddafebbaf4809cada3480f974036157a4cc284402d9457900e8716df35c` | host, Docker, SQLite, systemd, disk, and manifest checks passed |
| source | `jobs/job_511cb730d8874453b8a9cf7422a08c73/evidence/01-source.json` | `49d8549812cb1ce55541fc8c75823732ea03dc6822e70b0839fb6c47d795a783` | clean worktree and pinned head passed |
| release-gates | `jobs/job_511cb730d8874453b8a9cf7422a08c73/evidence/02-release-gates.json` | `72f80ac47f09078f905f7b18b11aa9c91877f0aab3e2d6a1b92aef2431d2b796` | `check-mqtt-topics` and listed release gates passed |
| frontend | `jobs/job_511cb730d8874453b8a9cf7422a08c73/evidence/03-frontend.json` | `43a2cb4e8aae0db2e389f7f5fc74e4018a2f1a7e88cf6912657e5c9eed3d418e` | `mirror-gui` and frontend operations passed |
| target-setup | `jobs/job_511cb730d8874453b8a9cf7422a08c73/evidence/04-target-setup.json` | `dfcea6a5b4e51db87dd63620059454cb596f51141dd68407d9d6be68fccbb243` | `activate-target` selected `rpi-2` |
| feeds | `jobs/job_511cb730d8874453b8a9cf7422a08c73/evidence/05-feeds.json` | `53acbabc561895cc0459fcfcfd1f7fa2d24fce00b7b9106c91dcaa15e3968fca` | `install-feeds` passed |
| config | `jobs/job_511cb730d8874453b8a9cf7422a08c73/evidence/06-config.json` | `ef1cced89b5ee58e4db07225409e774777534e2cdf5c866668d58ee169d2a781` | `resolve-config` selected `DEVICE_rpi-2` and `bcm27xx/bcm2709` |
| build | `jobs/job_511cb730d8874453b8a9cf7422a08c73/evidence/07-build.json` | `94b8bc89d6d5f503ab32030a49917c9e514ed381a62224e287fa6cfabf68825c` | `build-image` passed |
| verify | `jobs/job_511cb730d8874453b8a9cf7422a08c73/evidence/08-verify.json` | `2788d1869039939db5eece29b760e0ab35448499ea72779bd2cf34b9e2dd6a71` | `verify-image` passed artifact, gzip, checksum, rootfs, SQLite, and runtime checks |
| publish | `jobs/job_511cb730d8874453b8a9cf7422a08c73/evidence/09-publish.json` | `b86406114c0d55d1639156a5e1d500a25ca4b50893c0353c6be27b9f0a62b520` | `final.verified=true`; publication committed |

## Node resolution observations

The following 21 package results come from each target's
`08-verify.json` at `observations.rootfs.nodeResolution`. Every stored value is
the boolean `true`.

| package | Pi 5 `rpi-5` | Pi 4 `rpi-2` |
| --- | --- | --- |
| `@chirpstack/chirpstack-api` | `true` | `true` |
| `@grpc/grpc-js` | `true` | `true` |
| `google-protobuf` | `true` | `true` |
| `osi-chameleon-helper` | `true` | `true` |
| `osi-chirpstack-helper` | `true` | `true` |
| `osi-cloud-http` | `true` | `true` |
| `osi-command-ledger` | `true` | `true` |
| `osi-db-helper` | `true` | `true` |
| `osi-dendro-analytics` | `true` | `true` |
| `osi-dendro-helper` | `true` | `true` |
| `osi-device-writer` | `true` | `true` |
| `osi-health-helper` | `true` | `true` |
| `osi-history-helper` | `true` | `true` |
| `osi-history-router` | `true` | `true` |
| `osi-history-sync-helper` | `true` | `true` |
| `osi-journal` | `true` | `true` |
| `osi-lib` | `true` | `true` |
| `osi-lsn50-normalize` | `true` | `true` |
| `osi-uc512-normalize` | `true` | `true` |
| `osi-zone-env` | `true` | `true` |
| `protobufjs` | `true` | `true` |

## Cross-target scope

Both reports bind their image content to source SHA
`b31825becbb8abcef86cfad9dc756cd2e351f135`, target manifest SHA
`6abb9d2986032624070ff185e8d8be612ff99691507361e859add1f21cbd055a`, and
the corresponding target release paths. The reports do not prove one shared
builder installation: the Pi 5 lock and builder digest differ from the Pi 4
lock and builder digest.

| identity | Pi 5 | Pi 4 |
| --- | --- | --- |
| installed lock SHA256 | `065583d578e0ea92fb0332afff03666926d3114722dacbebd4f0fd4e2cda4f69` | `7b502053c1fad7f63b573c00df07af0589292e7275bd7e82884706f828bfdad1` |
| canonical builder image | `osi-image-builder@sha256:fd954f0c9dd60f4d6fd2200d6f45631ee901c237d43645599fbf75cae8fde066` | `osi-image-builder@sha256:6496788cce5e2c8ad4d4ea3aab39e8bd0b85ee0272333715d948c2f9a2a1d740` |
| image ID | `fd954f0c9dd60f4d6fd2200d6f45631ee901c237d43645599fbf75cae8fde066` | `6496788cce5e2c8ad4d4ea3aab39e8bd0b85ee0272333715d948c2f9a2a1d740` |

The Pi 5 record supports publication and independent content verification. The
Pi 4 record supports sealed acceptance. Aggregate Task 35 acceptance remains
open pending a new hardened `accept:all` run that seals both releases and uses
one matching builder identity.
