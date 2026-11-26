# Asset provenance

Every image the game draws is generated from TypeScript in this package, and the package holds no third-party asset. No image, audio or font file is tracked under `web/farm-sim/`: apart from `.gitignore`, the tracked files are `.ts`, `.tsx`, `.mjs`, `.json`, `.css`, `.html`, `.md` and `.txt` sources, and none of them embeds an image, audio or font `data:` URI. M1 has no audio (plan 1.2). The built phone also carries images that come with the OSI app, among them third-party Leaflet images; see "Assets from outside the package". The plan's originality rules (sections 1.1 and 8.1) apply to all art: real-world references described in words, no sprite packs, and a palette picked for this setting.

## How the art is made

| File | Role |
|---|---|
| `art/palette.ts` | The 46-colour palette, each colour behind a one-character key, plus named colour ramps such as soil, foliage, water, golden hour and four skin tones. |
| `art/core.ts` | `sprite`, `derive` (remap, mirror, ramp shift, overlay), `compose`, `variants`, a seeded random generator and the `Pixels` drawing helper. The validator checks row widths, palette keys, anchors and colour budgets (12 colours per sprite, 8 per icon). |
| `art/sprites/*.ts` | Hand-authored sprites: literal rows of palette keys, or shapes drawn with `Pixels` lines, rectangles and ellipses. |
| `art/generators/*.ts` | Terrain and crop sprites produced by code from a few hand-drawn bases, seeded variation and palette remaps. |
| `art/font.ts` | The pixel font, written as literal brush patterns. |
| `scripts/bake-atlas.ts` | Rasterises all of the above with a small PNG encoder over `node:zlib` and writes `atlas-<hash>.png`, `atlas.json`, `font.png` and `font.json` into `public/generated/`. |

`public/generated/` is build output and is ignored by git (`.gitignore`). Both JSON files record `provenance: 'original'`. The atlas hash is pinned in `tests/unit/art-atlas.test.ts`, so any change to a sprite has to be deliberate.

## Sprite families

The families are the keys of `spriteFamilies` in `scripts/bake-atlas.ts`; the font is baked to its own page.

| Family | Atlas ids | Source | How it is drawn |
|---|---|---|---|
| terrain | `terrain.laterite.*`, `terrain.tilled.*`, `terrain.grass.*`, `terrain.path.*`, `terrain.crack.*` | `art/generators/terrain.ts` | A laterite base in 8 seeded variants; dual-grid corner sets for grass, path and tilled soil, the tilled set in 5 wetness bands; 4 seeded crack overlays. |
| water | `water.drip.*`, `water.tank.*`, `water.hand-pump`, `water.well.*` | `art/sprites/world.ts` | Drip line in four shapes, dry and wet; the tank at four levels; the hand-dug well and the shared well in four phases, all drawn with `Pixels`. The hand pump is literal rows. |
| structures | `structure.*`, `nature.acacia`, `nature.rock.*` | `art/sprites/world.ts` | The farmhouse with a lit frame, the three unplaced farmhouses below, the acacia, two rocks, the nursery tray, bed pegs and twine. |
| structures | `nature.hedge.*`, `nature.tuft.*` | `art/generators/terrain.ts` | Sisal hedge tiles for the 47 blob neighbour cases, plus two extra clump layouts for each straight run (51 tiles); four grass tufts. |
| crop | `crop.tomato.*` | `art/generators/crops.ts` | Five hand-drawn canopies, one per growth stage, and a hand-drawn rolled transplant. Five stress states come from palette remaps and three sway frames from posture shifts; the ripe fruit is a separate overlay. |
| devices | `device.soil-probe.*`, `device.valve-box.*`, `device.gateway.*` | `art/sprites/world.ts` | Generic shapes, not copies of commercial products (plan 8.1): a probe with an LED frame, a valve box in three positions and a gateway pole with a small solar panel. |
| player | `player.<direction>.<clip>.<frame>` | `art/sprites/player.ts` | A 24 x 32 cell drawn facing down, up and right; the left-facing frames mirror the right ones. Seven clips: idle, walk, hoe, pour, carry, pump and harvest. |
| icons | `icon.*` | `art/sprites/ui.ts` | Twelve hand-drawn grids, centred in 16 x 16 and outlined by code. |
| ui | `ui.signboard`, `ui.phone-bezel` | `art/sprites/ui.ts` | Rectangles drawn with `Pixels`, with nine-slice margins. |
| effects | `effect.rain.*`, `effect.splash.*`, `effect.drip.*`, `effect.dust.*`, `effect.sheen.*` | `art/sprites/world.ts` | Literal rows of palette keys. |
| shadows | `shadow.<id>` | `art/sprites/shadows.ts` | A one-colour cream mask of each frame that casts a long shadow (farmhouse, acacia, tank, wells, gateway pole, farmer), made by `silhouette` in `art/core.ts`. The view tints it with the colour of the hour. |
| font | `font.body.*`, `font.heading.*` | `art/font.ts` | A 5 x 7 body face for printable ASCII and Latin-1. Accented letters without a glyph of their own are composed from a base letter and a mark; the 6 x 9 heading face widens the body glyphs. |

### Unplaced farmhouses

Three alternative farmhouses are drawn but not placed: round thatch, hipped thatch and gable tin (`roundThatchFarmhouse`, `hippedThatchFarmhouse` and `gableTinFarmhouse` in `art/sprites/world.ts`). They are baked into the atlas with day and lit frames, but the renderer draws only `structure.farmhouse` and its lit frame (`src/view/actors.ts`). Comments above each function list the pixel fixes it needs before it can become a house choice on the run-setup screen planned for M2 (plan section 14).

## Fonts

Text in the game's overlay uses the browser's system fonts: `system-ui, sans-serif` in `src/view/farm.css` and `ui-monospace, monospace` in `src/ui/farm-ui.css`. The phone test host page uses `system-ui, sans-serif` (`src/phone-host.css`), and `src/phone/phone.css` sets only a size. No CSS file or HTML entry declares `@font-face` or loads a font. In M1 the baked pixel font is read only by the art review script (`scripts/render-art-review.ts`), which writes its contact sheet to a directory given on the command line; the game does not draw text with it. The three HTML entries (`index.html`, `phone.html`, `phone-host.html`) set an empty `data:,` favicon and load no external resource.

## Assets from outside the package

The phone build compiles the OSI app from `web/react-gui/src` (plan 10.2), and the app's static imports bring two image sources with it. `web/react-gui/src/App.tsx` imports `src/pages/Login.tsx`, which imports the OSI logo, `web/react-gui/src/assets/osi_logo.png`, a file of this repository. It also imports `src/pages/NetworkPage.tsx`, which imports `leaflet/dist/leaflet.css`; that stylesheet references Leaflet's control and marker images (`layers.png`, `layers-2x.png`, `marker-icon.png`). Leaflet 1.9.4 is BSD-2-Clause licensed, per `web/react-gui/package-lock.json`. This section follows the import graph and has not been checked against a phone build. The app's own text uses a system font stack (`web/react-gui/src/index.css`).

Runtime libraries are npm dependencies, not assets. The game's three are `pixi.js` 8.23.0, `preact` 11.2.0 and `@noble/hashes` 1.8.0, all MIT per `package-lock.json`; the phone's React stack is listed in `web/react-gui/package-lock.json`.

## Licence

The package declares no licence of its own: `package.json` is marked `private` and has no `license` field. Its code and the art generated from it ship under the repository's MIT licence (`LICENSE` at the repository root, copyright 2025 Project-OSI). A third-party asset added later needs an entry in this file with its source and licence (plan section 2).
