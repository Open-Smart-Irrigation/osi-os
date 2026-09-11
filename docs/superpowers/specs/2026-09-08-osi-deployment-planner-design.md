# OSI deployment planner

Date: 8 September 2026. Status: proposed design, revised with user requirements for worldwide coverage, Swiss detail, continuous gain adjustment and the AgroLink device catalog.

## Outcome

Provide a reusable web application on the OSI test server for planning a gateway and its connected valves or sensors. Users enter coordinates or place markers on a topographic map, change installation and radio parameters, calculate individual links and surrounding coverage, and export a deployment plan. The interface, validation messages, legends and report labels support German, English, French and Italian.

Worldwide maps and elevation-based planning are required from the first version. Switzerland receives preferred national topographic layers and higher-resolution elevation data where available. Source selection and effective calculation resolution remain visible in each result.

## Application boundary

Build a separate OSI Planner application and source repository. Deploy its own Docker service behind the existing test-server Caddy proxy, provisionally at `https://server.opensmartirrigation.org/planner/`. Verify route availability before deployment. A path under the existing hostname avoids a new DNS dependency.

The application owns planning projects, calculation jobs and a terrain cache. It does not depend on gateway connectivity. Import/export files provide the first integration boundary; automatic import from live farm accounts is a later feature.

Alternatives considered: extending the static study would retain assumptions tied to one gateway and make arbitrary-coordinate calculations awkward. Embedding the planner directly in the existing server GUI would reuse its account system but couple a substantial geospatial workload to its release and deployment. A separate application offers a shorter path to a usable test deployment and a reusable calculation API.

## User workflow

The main view is a topographic map with a collapsible project panel. Users can:

- Name a project, choose DE/EN/FR/IT, and enter the gateway latitude/longitude in decimal degrees or degrees/minutes/seconds.
- Place or move the gateway and device markers on the map. Coordinate fields and markers update together.
- Add, duplicate and remove named devices. Coincident devices retain separate records and show grouped map markers.
- Set gateway height above ground, antenna gain anywhere from 0 through 13 dBi inclusive, feeder loss, conducted power and EIRP ceiling. Provide a synchronized slider and numeric input; the slider uses 0.1 dBi steps and direct entry accepts fractional values without restricting users to antenna presets. Apply the same 0–13 dBi editing range to device antenna gain, and validate finite in-range values in both client and API. Retain preset comparison buttons only as shortcuts.
- Select an editable device radio profile, with device height, transmit power, antenna gain, sensitivity, frequency, SF, bandwidth and additional local loss. Unknown manufacturer values are identified as assumptions.
- Calculate uplink and downlink power, limiting link margin, distance and terrain/Fresnel profile for each device.
- Calculate area coverage for a selected receiver profile. Compare antenna scenarios while holding other settings constant.
- Save projects in the browser, export/import a versioned project JSON file, export a results CSV and download a clean PNG in the selected language.

The device selector includes every supported type in the OSI OS AgroLink branch, plus a generic editable LoRa profile. Device support and RF specification confidence are separate: a supported device remains selectable even when sensitivity or antenna specifications need explicit assumptions. Do not invent verified manufacturer figures. Each profile records its source and whether each RF value is verified, assumed or user-specified. Language selection changes presentation only, never coordinates or model inputs. Entered decimal commas are normalized only in numeric fields, with unambiguous coordinate parsing.

## Supported device catalog

The catalog was cross-checked against the local `AgroLink` checkout at commit `488ef7d48bf5449f19dee30f278b1e908b857b91`, using the `DeviceType` union, the seed database constraint and ChirpStack bootstrap support. The checkout contains unrelated uncommitted work; it is a read-only reference for this task. The planner’s catalog must record the source commit and have a repeatable comparison check so future device additions are discoverable.

| OSI type | Device selection |
|---|---|
| `KIWI_SENSOR` | KIWI sensor |
| `STREGA_VALVE` | STREGA valve |
| `DRAGINO_LSN50` | Dragino LSN50 |
| `TEKTELIC_CLOVER` | TEKTELIC CLOVER |
| `SENSECAP_S2120` | SenseCAP S2120 weather station |
| `AQUASCOPE_LORAIN` | Aqua-Scope LoRain |
| `MILESIGHT_UC512` | Milesight UC512 dual-valve controller |
| `DRAGINO_SDI12` | Dragino SDI-12-LB / SDI-12-LS converter |

These are eight supported radio device types. Preserve hardware variant selection where OSI distinguishes a variant and it changes the RF assumptions; do not equate one type identifier with one verified antenna or receiver specification. The UC512’s two valve outputs share one radio endpoint. Probes wired to an LSN50 or SDI-12 converter are attached equipment, not independent LoRa radio endpoints; allow descriptive probe labels without fabricating additional wireless links. STREGA generations can be represented as variants under the supported valve type when their source evidence is available.

Local evidence:

- `../osi-os-agrolink/web/react-gui/src/types/farming.ts`, `DeviceType`.
- `../osi-os-agrolink/database/seed-blank.sql`, `devices.type_id` constraint.
- `../osi-os-agrolink/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js`, supported codecs/profiles.
- `../osi-os-agrolink/docs/devices/dragino-sdi12.md`, converter and attached-probe semantics.

## Calculation semantics

Use the reviewed complete delta-Bullington model from the study behind a generalized service. Eliminate fixed gateway coordinates, Swiss projection assumptions and hard-coded receiver sensitivities from the calculation path. Compute distances geodesically and use an appropriate local metric projection for gridded coverage.

Every result records its input snapshot, terrain source/version, resolution and model version. Radio budgets enforce the user-selected EIRP cap before local attenuation. The Swiss study's 16 dBm cap is an editable planning default, not a universal legal rule. Frequency and sensitivity remain explicit so the tool can represent other regional installations.

Coverage is specific to a receiver profile and installation height. A project with different devices must not display one area layer as if it covered all profiles. Display both received power and the minimum uplink/downlink margin, and distinguish missing terrain from below-threshold coverage.

The circle radius is the farthest sampled reachable point in any bearing, including isolated pockets. It does not indicate continuous coverage. The user chooses an initial search extent; the job expands within an explicit resource limit if passing cells touch its boundary. If computation reaches the configured limit, show that the result is bounded by the search extent rather than claiming a maximum. Missing terrain, interrupted downloads or cancelled jobs cannot produce an apparently complete result.

The previous 89 km example remains a regression fixture and demonstration project, not a promise for other sites. Terrain-only estimates do not establish packet-delivery reliability or characterize real high-gain antenna patterns.

## Terrain and topographic layers

Prefer the swisstopo national topographic map in Switzerland. For detailed Swiss link profiles and local coverage, use swissALTI3D bare-earth terrain at 2 m, with an optional 0.5 m detail mode where source data and job limits permit. Swisstopo publishes both grid sizes; source cell size must not be described as the precision of the RF prediction. Use swissALTIRegio for regional searches and its neighbouring footprint, refining selected Swiss locations with swissALTI3D. Download and cache only the raster windows required for a job, preserving source attribution and vertical-reference metadata. Keep visual topographic basemap resolution, source elevation resolution and calculation sampling resolution separate in the result metadata. Explicitly report a fallback to a coarser source; never silently describe it as high-resolution Swiss terrain.

For worldwide coverage, use Copernicus GLO-30 Public and GLO-90 as explicitly labelled alternatives. Copernicus is a digital surface model, so vegetation and built features can affect its elevations; it must not be presented as equivalent to the Swiss bare-earth terrain model. GLO-30 has some unavailable land tiles; GLO-90 provides the global fallback. Missing downloads remain unavailable rather than becoming zero elevation. Avoid combining vertical datums within a path without an explicit transformation or a documented single-source selection.

Sources checked: [Copernicus open-data registry](https://registry.opendata.aws/copernicus-dem/) [swissALTIRegio](https://www.swisstopo.admin.ch/en/height-model-swissaltiregio), and [swissALTI3D](https://www.swisstopo.admin.ch/en/height-model-swissalti3d). Basemap service terms, attribution, permitted PNG export and availability will be verified before choosing the worldwide visual layer. The service must show a clear basemap error while retaining user coordinates and calculated results if that external layer is unavailable.

## Implementation shape

Use a TypeScript/React map interface and a Python geospatial API with the existing reviewed numerical kernel. Separate coordinate parsing, project validation, terrain acquisition, propagation calculations and export composition. Submit expensive coverage work as queued jobs with progress and cancellation; individual links can use the same backend with a smaller workload.

Keep project files in the browser for the first version, with explicit JSON download/import for transfer between machines. The server retains bounded calculation inputs/results for job completion and expiry, not an unprotected shared project directory. Reuse an existing suitable test-access mechanism if available; otherwise establish access control before exposing resource-intensive job endpoints. Apply request limits, input bounds, one calculation worker initially and a disk-capped terrain cache.

Test-server inspection found Docker and Caddy already serving the OSI backend and Odoo, approximately 6.3 GiB available memory and 25 GiB free disk. Set explicit container memory/CPU limits and a cache budget that fits alongside those services. Deployment uses a distinct service/network alias, health checks and a reversible Caddy route change.

## Acceptance and deployment checks

Verify coordinate parsing with hemispheres, decimal commas, malformed input and boundary coordinates. Validate invalid heights/powers and out-of-range model frequencies before submitting work. Check the radio budget against the study, including EIRP caps, gain changes and SF power invariance. Confirm geography-independent distance/profile sampling with Swiss and non-European fixtures, including locations near longitude wrapping and terrain source boundaries. Check the gain endpoints 0 and 13 dBi, fractional values such as 8.35 dBi, out-of-range rejection and EIRP clamping after gain edits. Verify the device selector against the pinned AgroLink catalog and ensure all four languages include each device’s descriptive text.

Coverage tests must cover terrain gaps, isolated distant pockets, search-boundary truncation, worker errors, cancellation and stale results after input edits. Project import must validate its version and schema. Browser tests must exercise creating a fresh project, editing coordinates and markers, adding devices, calculating a link, running a coverage job, switching all four languages, saving/reopening and exporting a PNG.

An independent reviewer checks the execution plan before implementation. A separate verifier runs the finished application and relevant tests. Deployment is complete only after the HTTPS planner route works on the test server, an actual server-side calculation succeeds and the existing hosted applications still pass their health checks.
