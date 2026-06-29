# OSI OS Agroscope Context

Domain language for the Agroscope-branded research sensor network variant of OSI OS.

## Language

**Agroscope research network**:
The Agroscope-branded OSI OS deployment profile for research sensor networks.
_Avoid_: Reckenholz product, Reckenholz OSI

**Reckenholz site**:
The Agroscope field deployment context that informs initial defaults and validation scenarios.
_Avoid_: Product boundary, brand

**Branding slice**:
The first implementation slice that changes Agroscope-facing identity only, without new research data flows or controller behavior.
_Avoid_: Research network MVP, dendrometer controller

**Operator-visible identity**:
The subset of branding visible in the GUI and local operator surfaces such as build labels, login text, and system identity strings.
_Avoid_: Full image identity

**Official Agroscope assets**:
Agroscope-provided logo, colors, and copy from `/home/phil/kDrive/OSI OS/Agroscope/Logo Agroscope`, used as the only source for first-slice visual branding.
_Avoid_: Public-brand guesswork, approximate Agroscope styling

**Brand language set**:
The Agroscope branding language priority: English primary, German, French, and Italian secondary.
_Avoid_: locale set without priority

**Italian branding coverage**:
Italian GUI branding and logo selection are included in the first branding slice, alongside English, German, and French.
_Avoid_: Italian as future-only asset coverage

**AgroLink**:
The visible platform name for the Agroscope-branded OSI OS experience.
_Avoid_: Agroscope OSI, Agroscope Research Network, Open Smart Irrigation for Agroscope

**Login screen attribution**:
The exact login screen subtitle shown below **AgroLink**: "Powered by OSI OS".
_Avoid_: Powered by Open Smart Irrigation, OSI-powered

**AgroLink operator identity**:
The use of **AgroLink** across primary GUI screens and local operator-visible surfaces such as AP/SSID, build labels, and visible system identity text.
_Avoid_: GUI-only AgroLink, OSI OS operator label

**AgroLink SSID**:
The gateway Wi-Fi access point name pattern: `AgroLink-${GWID_END}`.
_Avoid_: OSI-OS-${GWID_END}, AgroLink-OSI-${GWID_END}

**Stable gateway hostname**:
The existing OSI OS hostname behavior, retained for the branding slice instead of renaming hostnames to AgroLink.
_Avoid_: agrolink-${GWID_END}, agrolink-gateway-${GWID_END}

**Central brand config**:
The single source of truth for AgroLink product names, attribution copy, locale-specific Agroscope logo assets, brand colors, and operator-facing labels.
_Avoid_: scattered string replacement, build-time brand variant

**Login hoch logo**:
The official Agroscope `WBF_agroscope_*_rgb_pos_hoch.png` logo variant used on the AgroLink login screen.
_Avoid_: square OSI logo, approximate Agroscope logo

**Dashboard Balken header**:
The official Agroscope `A_Balken_*` asset rotated 90 degrees into a horizontal dashboard header motif.
_Avoid_: hand-drawn red bar, approximate Agroscope accent

**Zone**:
The user-facing term for a logical grouping of field devices, sensors, and local context in AgroLink. A zone is not inherently an irrigation-only concept.
_Avoid_: irrigation zone, watering zone

**Irrigation zone technical contract**:
The existing internal API, database, sync, and TypeScript contract vocabulary that still uses names such as `irrigation_zones`, `/api/irrigation-zones`, and `irrigation_zone_id`.
_Avoid_: renaming storage or API contracts as part of the first branding slice

## Relationships

- The **Agroscope research network** may include one or more field sites.
- The **Reckenholz site** is the first known site context for the **Agroscope research network**.
- The **Branding slice** is the first deliverable for the **Agroscope research network**.
- The **Branding slice** targets **Operator-visible identity**, not full image/profile renaming.
- The **Branding slice** uses **Official Agroscope assets** rather than inferred public branding.
- The **Branding slice** uses the **Brand language set** for logo and copy selection.
- **Italian branding coverage** is part of the **Branding slice**.
- **AgroLink** is the product name shown on the login screen and primary GUI surfaces.
- **Login screen attribution** preserves OSI OS as the underlying platform identity.
- **AgroLink operator identity** extends the product name beyond the GUI while retaining OSI OS attribution where needed.
- **AgroLink SSID** is one concrete surface of **AgroLink operator identity**.
- **Stable gateway hostname** keeps low-level device identity separate from human-facing **AgroLink operator identity**.
- **Central brand config** defines the first branding slice without introducing a full build-variant system.
- **Login hoch logo** and **Dashboard Balken header** are the visual identity surfaces for the first branding slice.
- **Zone** is the canonical user-facing term because AgroLink is a multipurpose sensing platform, not only an irrigation controller.
- **Irrigation zone technical contract** remains stable during the first branding slice while user-facing copy moves to **Zone**.

## Example dialogue

> **Dev:** "Should this branch be called the Reckenholz variant?"
> **Domain expert:** "No. Reckenholz is context for the first deployment; the product should be branded for Agroscope."

> **Dev:** "Should the first slice add publishing or dendrometer control?"
> **Domain expert:** "No. First only branding."

> **Dev:** "Should branding stop at the GUI or extend into the local system?"
> **Domain expert:** "Use GUI plus local system identity, but do not rename the full image profile yet."

> **Dev:** "Should I look up Agroscope colors and logos?"
> **Domain expert:** "No. Use official assets that we provide."

> **Dev:** "Which Agroscope language variant leads the branded build?"
> **Domain expert:** "Primary English, secondary German, French, and Italian."

> **Dev:** "Should Italian wait until later?"
> **Domain expert:** "No. Include Italian too."

> **Dev:** "What should the login screen title and subtitle say?"
> **Domain expert:** "Show AgroLink, with Powered by OSI OS below."

> **Dev:** "Should AgroLink be only a GUI name?"
> **Domain expert:** "No. Use AgroLink in GUI plus operator-visible local identity surfaces."

> **Dev:** "What Wi-Fi AP name should the branded gateway broadcast?"
> **Domain expert:** "Use AgroLink-${GWID_END}."

> **Dev:** "Should the hostname change to AgroLink too?"
> **Domain expert:** "No. Keep existing hostname behavior; change human-facing labels and SSID."

> **Dev:** "How should the branding be implemented?"
> **Domain expert:** "Use a central brand config, not scattered replacements or a build-time brand variant."

> **Dev:** "Which Agroscope assets should drive the login and dashboard?"
> **Domain expert:** "Use the hoch logo on the login screen and rotate the Balken asset horizontally for the dashboard header."

> **Dev:** "Should the GUI still say irrigation zone?"
> **Domain expert:** "No. AgroLink is a multipurpose sensing platform. User-facing copy should say zone."

> **Dev:** "Should the first slice rename `/api/irrigation-zones` and the database tables too?"
> **Domain expert:** "No. Keep technical contracts stable for now; rename visible copy first."

## Flagged ambiguities

- "Reckenholz" was initially used as shorthand for the target branch. Resolved: use **Agroscope research network** for the variant and **Reckenholz site** only for initial deployment context.
- "first" could mean a functional research MVP or a branded build. Resolved: the first deliverable is the **Branding slice** only.
- "branding surface" could mean GUI-only, operator-visible system identity, or full image identity. Resolved: target **Operator-visible identity** for this slice.
- "Agroscope branding" could mean inferred public web styling. Resolved: only **Official Agroscope assets** should define logo, color, and copy.
- "primary language" could follow the Reckenholz site language. Resolved: English is primary for the Agroscope-branded build; German, French, and Italian are secondary.
- "Italian coverage" could be future-only despite official Italian assets existing. Resolved: include **Italian branding coverage** in the first slice.
- "platform name" could mean an Agroscope-prefixed OSI name. Resolved: use **AgroLink** and keep OSI OS as attribution.
- "AgroLink scope" could mean GUI-only. Resolved: use **AgroLink operator identity** for GUI, local AP/SSID, build labels, and visible system identity text.
- "SSID compatibility" could keep the old OSI-OS prefix. Resolved: use **AgroLink SSID** for the branded build.
- "system label" could include hostname renaming. Resolved: preserve **Stable gateway hostname** and use AgroLink for human-facing labels and SSID only.
- "branding implementation" could mean editing strings wherever they appear. Resolved: use **Central brand config** as the source of truth.
- "visual treatment" could mean approximate brand-colored UI accents. Resolved: use **Login hoch logo** and **Dashboard Balken header** from official Agroscope assets.
- "zone" could mean an irrigation-specific control area or a generic sensing context. Resolved: use **Zone** for the user-facing multipurpose concept and keep **Irrigation zone technical contract** names unchanged in this slice.
