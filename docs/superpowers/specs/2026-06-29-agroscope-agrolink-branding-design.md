# Agroscope AgroLink Branding Slice

Date: 2026-06-29
Status: Proposed
Decision: Brand the first Agroscope research network slice as AgroLink using official Agroscope assets and zone-first terminology.

This spec captures the approved branding and terminology design for the
Agroscope-branded OSI OS branch. Reckenholz is the first site context, but it
is not the product name or product boundary.

## 1. Goals

1. Present the edge GUI as **AgroLink** for Agroscope operators.
2. Keep **OSI OS** visible as the underlying platform via the login subtitle:
   `Powered by OSI OS`.
3. Use official Agroscope assets from the branding package provided outside
   this repository; do not approximate the logo, colors, or Balken treatment.
4. Make English the primary branding language and include German, French, and
   Italian assets in the first slice.
5. Change the gateway access point SSID pattern to `AgroLink-${GWID_END}` for
   the two supported full Raspberry Pi profiles: Pi 5 (`bcm2712`) and Pi 4
   (`bcm2709` in this repo's shared Pi 2/3/4/400 target).
6. Keep the existing hostname behavior.
7. Centralize brand names, attribution text, locale logo mapping, and brand
   colors so future copy or asset updates do not become scattered replacements.
8. Move user-facing terminology away from `irrigation zone` to `zone` because
   AgroLink is a multipurpose sensing platform.

## 2. Non-Goals

- Do not add research workflows, dendrometer controllers, new sensor behavior,
  or data-flow changes.
- Do not introduce a build-time white-label framework or multiple brand
  variants.
- Do not rename the repository, image profile, package names, hostname, REST
  endpoints, database schema, sync aggregates, or MQTT topics.
- Do not rename the existing `irrigation_zones` database tables,
  `/api/irrigation-zones` routes, sync contracts, or TypeScript compatibility
  fields in this slice.
- Do not change AP scripts for unsupported Agroscope targets in this slice:
  full `bcm2708`, base Raspberry Pi profiles, RAK profiles, SenseCAP, Dragino,
  or any other non-Pi-4/Pi-5 profile.
- Do not rewrite `OSI Server` labels that refer to the cloud sync service.
- Do not infer public Agroscope styling from the web; only use the provided
  official asset folder.

## 3. Approved Visual Treatment

The login screen uses the official WBF Agroscope **hoch** logo above the
platform name. The title text is `AgroLink`; the subtitle directly below it is
`Powered by OSI OS`.

`Powered by OSI OS` is intentionally fixed English brand attribution across all
GUI languages. In the AgroLink login screen, existing `auth.login.subtitle`
translations are no longer the source of the login subtitle.

The dashboard header uses the official `A_Balken_*` asset rotated 90 degrees
into a horizontal motif. This is an asset-derived visual element, not a
hand-drawn red bar. The dashboard title becomes `AgroLink Dashboard` and keeps
the existing welcome copy below it.

The register screen is not redesigned as a separate visual surface. It should
remove stale Open Smart Irrigation product copy and use AgroLink text so the
login/register pair is consistent.

User-facing copy should say `zone`, not `irrigation zone`. Examples:

- `Irrigation Zones` becomes `Zones`.
- `Create Irrigation Zone` becomes `Create Zone`.
- Empty-state text such as `creating an irrigation zone and adding devices`
  becomes `creating a zone and adding devices`.
- Assignment copy such as `not assigned to any irrigation zone` becomes
  `not assigned to any zone`.

## 4. Official Asset Inventory

Use the current WBF Agroscope raster assets:

| Locale | Login hoch source | Dashboard Balken source |
|---|---|---|
| English | `96447-WBF_agroscope_e_rgb_pos_hoch.png` | `96432-A_Balken_A4_en.png` |
| German | `96443-WBF_agroscope_d_rgb_pos_hoch.png` | `96457-A_Balken_A4_de.png` |
| French | `96451-WBF_agroscope_f_rgb_pos_hoch.png` | `96433-A_Balken_A4_fr.png` |
| Italian | `96455-WBF_agroscope_i_rgb_pos_hoch.png` | `96434-A_Balken_A4_it.png` |

The older HNS/SNG institute-specific files in the folder are not used for this
generic AgroLink branding slice.

Implementation should copy normalized runtime assets into
`web/react-gui/src/assets/agroscope/`. The Balken images should be generated
from the official vertical source assets by rotating them 90 degrees and should
remain checked in with clear filenames such as
`balken-horizontal-en.png`. Source provenance belongs in the brand config or a
small adjacent README so future maintainers can trace each copied asset.

## 5. Architecture

Add a central React brand module, for example
`web/react-gui/src/branding/agrolink.ts`. It owns:

- `productName`: `AgroLink`
- `dashboardTitle`: `AgroLink Dashboard`
- `loginSubtitle`: `Powered by OSI OS`
- `ssidPrefix`: `AgroLink`
- `zoneLabel`: `Zone`
- `zonesLabel`: `Zones`
- official Agroscope red and neutral color constants extracted from the assets
- locale-to-logo and locale-to-Balken resolvers

The resolver maps current GUI languages to Agroscope asset locales:

| GUI language | Asset locale |
|---|---|
| `en` | English |
| `de-CH` | German |
| `fr` | French |
| `it` | Italian |
| `es`, `pt`, `lg`, unknown | English fallback |

This keeps the product name stable while selecting the best available official
logo for the current GUI language. English fallback is explicit because the
approved brand language set is English primary with German, French, and Italian
secondary.

## 6. Components And Data Flow

`web/react-gui/src/pages/Login.tsx` consumes the brand module for the logo,
title, and subtitle. It should no longer import `osi_logo.png` directly or show
`OSI OS v0.6.5 (Alpha)` as the primary login title.

`web/react-gui/src/components/DashboardHeader.tsx` consumes the brand module
for the dashboard title and horizontal Balken image. The header keeps its
existing actions, language switcher, account menu, responsive wrapping, and
welcome text behavior.

`web/react-gui/src/pages/Register.tsx` and all supported
`web/react-gui/public/locales/*/auth.json` files should remove stale Open Smart
Irrigation product copy from the register path. The register screen does not
need a new logo unless the implementation can reuse the login branding without
increasing layout risk.

`web/react-gui/public/locales/*/dashboard.json` should set the dormant
`dashboard.title` key to `AgroLink Dashboard` so stale Open Smart Irrigation
product copy does not survive in locale resources. The rendered dashboard title
itself is still owned by the brand module, not by the `dashboard.title` locale
key. Dashboard locale files should also replace visible irrigation-only wording
with zone wording where that copy is rendered. Existing account-link copy that
names `OSI Server` stays as-is because it names the sync/cloud service, not the
edge platform brand.

`web/react-gui/public/locales/*/history.json`,
`web/react-gui/public/locales/*/dashboard.json`, and
`web/react-gui/public/locales/*/devices.json` should be scanned for visible
English text containing `irrigation zone`. Any such user-visible copy should be
renamed to `zone`, including fallback English strings embedded in secondary
locale files. Source code comments may be updated when touched, but internal
API names such as `irrigation_zone_id` and `/api/irrigation-zones` remain.

After the React build, the firmware GUI bundle under
`feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/` must be refreshed from
`web/react-gui/build/`; OpenWrt firmware builds do not compile the React app
themselves.

The SSID change is applied only in the two supported full Raspberry Pi profile
payload copies:

- `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap`
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap`

Both should set:

```sh
set wireless.default_radio0.ssid="AgroLink-${GWID_END}"
```

No hostname change is made.

`conf/full_raspberrypi_bcm27xx_bcm2708`, all base Raspberry Pi profiles, and
RAK/SenseCAP/Dragino profiles are deliberately out of scope for AgroLink
branding in this slice.

## 7. Error Handling And Fallbacks

If the GUI language has no official Agroscope asset, the brand module falls
back to the English logo and English Balken asset. This covers Spanish,
Portuguese, Luganda, browser language mismatches, and corrupted local storage
without blank image slots.

The visual surfaces should use normal `img` `alt` text such as `Agroscope` and
`Agroscope Balken`. Missing image imports should fail at build time through the
Vite asset pipeline rather than at runtime.

The SSID script keeps the existing guard that only changes a default OpenWrt
SSID. Already-provisioned gateways with a custom SSID are not overwritten by
this uci-defaults script.

## 8. Testing And Verification

The implementation plan should include focused tests before implementation:

1. A brand resolver unit test proves `en`, `de-CH`, `fr`, `it`, and fallback
   languages return the expected official assets.
2. `DashboardHeader` tests are updated to expect `AgroLink Dashboard` while
   preserving existing menu, account-link, and responsive wrapping behavior.
3. A login branding test verifies the Agroscope logo, `AgroLink`, and
   `Powered by OSI OS` are rendered.
4. A focused terminology check proves no user-visible locale copy still uses
   `irrigation zone` or `Irrigation Zones`.
5. A focused product-copy check proves no locale resource still uses Open Smart
   Irrigation as the GUI product name.
6. The brand resolver test directory must be included in the `npm run
   test:unit` Vitest allow-list so it is not only run by a one-off command.
7. A focused SSID check proves both supported AP scripts contain
   `AgroLink-${GWID_END}` and the Pi 4/Pi 5 AP files stay byte-identical for
   parity.
8. Locale JSON changes are covered through the React build and any existing
   i18n loading tests.

Verification commands:

```bash
cd web/react-gui && npm run test:unit
cd web/react-gui && npm run build
rsync -a --delete web/react-gui/build/ feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/
diff -qr web/react-gui/build feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
rg -n 'set wireless\.default_radio0\.ssid="AgroLink-\$\{GWID_END\}"' \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap
! rg -n "Open Smart Irrigation|Open Smart irrigation" web/react-gui/public/locales
cmp -s \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap
node scripts/verify-sync-flow.js
git diff --check
```

The explicit `rg` command validates the SSID content. The explicit `cmp`
validates the edited AP script parity for the supported Pi 5/Pi 4 full
profiles. `node scripts/verify-sync-flow.js` remains a broad regression check
and also chains `scripts/verify-profile-parity.js`, which includes
`files/etc/uci-defaults/99_config_chirpstack_ap`, but it is not the only SSID
assertion.

## 9. Open Decisions

None for this slice. The login title replacement intentionally removes the
visible `OSI OS v0.6.5 (Alpha)` string from the login screen; future work can
decide whether release/version information belongs in another operator-facing
surface such as a system/about panel. Future work may also decide whether
Agroscope branding should extend into ChirpStack tenant names, image release
names, cloud UI labels, unsupported profiles, or research-specific workflows,
but those are intentionally outside the approved branding and terminology
scope.
