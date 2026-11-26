# Art direction and rendering plan: OSI farming game

Research report, 2026-11-23. Scope: an original art direction for a top-down pixel-art farming game set in a fictional semi-arid, East-African-inspired landscape, and a plan to make every sprite in code (no artists, no third-party assets) and render it with modern shaders.

Validated example sprites and a preview render live next to this report:

- `<scratch>/artcheck/check.mjs` (palette, example grids, validator, PNG writer; `node check.mjs`)
- `<scratch>/artcheck/sheet.png` (example sprites at 8x)
- `<scratch>/artcheck/palette.png` (the 46-colour master palette)
- `<scratch>/artcheck/tiling.png` (3x3 tiling of dry, wet and cracked tilled soil, to check seams)

## 0. Decisions in one screen

| Topic | Decision |
|---|---|
| Working title for the look | "Red earth, gold grass, blue hills" (internal name only) |
| Tile | 16x16 px; 1 tile is about 1 m of farm |
| Characters | 24x32 px animation cell, body about 14x26 px; room above the head for head-carried jerrycans and baskets |
| Internal resolution | 480x270 logical px (30 x 16.9 tiles), integer-scaled: 4x at 1920x1080, 3x at 1440x810, 2x on phones in landscape; the logical size flexes by a few tiles instead of letterboxing |
| Palette | 46 colours, hand-picked for this project (not a community palette), every colour in at least one named ramp |
| Outlines | Selective outlines on characters, animals, crops and interactables; no outlines on terrain; full 1 px ink outline on inventory icons only |
| Lighting | Ramp-step lighting: lights and shadows move a pixel up or down its own palette ramp, then a time-of-day LUT grades the frame |
| Renderer | WebGL2, low-res G-buffer (palette index, height, flags), integer upscale; Canvas2D fallback without dynamic light |
| Authoring | TypeScript modules with string grids keyed to the palette, plus seeded procedural generators for terrain, variants, foliage scatter and fabric patterns; compiled to atlases by a Vite plugin at build time and in the browser during development |
| Seasons | Long rains (Mar-May), cool dry (Jun-Sep), short rains (Oct-Dec), hot dry (Jan-Feb); not four temperate seasons |
| Phone | The real edge React app in a DOM iframe, framed by a pixel-art bezel; exempt from pixel snapping and grading |

## 1. Art bible

### 1.1 Identity pillars

1. **Red earth is the canvas.** Laterite soil is the dominant ground colour, not green grass. Green is earned: it appears with the rains and around water, so that irrigated plots visibly stand out from the dry land around them. That contrast is the game's teaching image.
2. **Light is hot and vertical at noon, long and gold at the ends of the day.** Near the equator the midday sun stands almost overhead, so noon shadows shrink to a blob under each object; the drama sits in the short golden hours and in the storm light of the rains.
3. **Everyday objects carry the place.** Yellow jerrycans, iron-sheet roofs with rust streaks, mud-brick walls with a plaster band, three-stone fires, granaries on stilts, sisal and euphorbia hedges, termite mounds, goats on a tether. None of these is borrowed from another game; they come from the setting.
4. **Patterned cloth is the colour accent.** Bold, abstract, geometric cloth patterns (kitenge-like, never copied from a specific named design and never carrying text) give characters their saturated colour against an earth-toned world.
5. **Water is the brightest, coolest thing on screen.** Blue-white highlights (`X`, `u`) are reserved almost entirely for water, wet sheen and sky reflections, so the eye goes to where water is.

### 1.2 Mood boards in words

- **Hot dry season, 13:00.** Bleached sky near white. Ochre dust hanging in the air. Grass the colour of straw, acacia canopies grey-green and thin, baobab bare. Soil pale and cracked around unirrigated plots. Heat shimmer rising off the path. One irrigated plot is dark red-brown and green, with a glint off a puddle.
- **Long rains, 16:00.** A wall of cloud building over the blue hills, its anvil lit cream on top and slate-violet underneath. Cloud shadows sweeping across the fields. The first fat drops raise dust puffs, then the ground darkens tile by tile. Afterwards everything is saturated: wet red soil, vivid green, puddles reflecting a washed blue sky.
- **Golden hour, 18:00.** Sun low in the west, shadows stretching three tiles east. Grass tips glowing amber, iron roofs flashing orange. Smoke from a cooking fire. Goats walking home in a line.
- **Blue hour, 05:50.** Indigo and violet; a kerosene-type lamp glowing in a doorway; the gateway's small LED blinking on its pole; mist sitting in the sand river bed. At 06:00 a valve clicks open (the simulator's legacy SWT trigger, see section 2.6).
- **Night.** Deep indigo ambient, cool moonlight, warm pools of fire and lamp light, fireflies in the rains, stars over the horizon vista.

### 1.3 What to avoid (originality guardrails)

- No reference board from any specific game. Reference only the real world (soil, plants, buildings, light) described in words.
- No wooden-plank UI frames, no parchment scroll dialogs, no heart-shaped relationship meters, no gem-shaped currency, no festival calendars that mirror another game's. The UI direction is the painted signboard (1.10).
- No named community palettes; the palette below was picked for this setting.
- No real place names, no real people, no real brands. Devices are generic shapes, not reproductions of a commercial product.
- No specific culturally meaningful patterns (for example, named cloth designs, cloth with printed proverbs, or the exact check of a particular community's shuka). Patterns are generated from a small geometric grammar (1.7).

### 1.4 Master palette (46 colours)

Single-character keys are the palette keys used in sprite grids. `.` is transparent. Ramps share colours on purpose to stay inside 48.

| Key | Hex | Name | Ramps that use it |
|---|---|---|---|
| `K` | `#1f1720` | ink plum-black | outline, UI ink |
| `k` | `#3b2a33` | dark plum-brown | selective outline, deep shadow |
| `A` | `#f0c08a` | dust highlight | soil (dry end), dust, plaster |
| `B` | `#d98c52` | dry laterite | soil, mud brick |
| `C` | `#b8643a` | damp laterite | soil, brick shadow, rust |
| `D` | `#8e4530` | wet laterite | soil, rust shadow |
| `E` | `#5e2c26` | saturated laterite | soil (wet end), cracks |
| `G` | `#f4dc8c` | straw light | dry grass, thatch, dead crop |
| `H` | `#d6b25a` | straw | dry grass, thatch, wilted crop |
| `I` | `#a8823e` | straw dark | dry grass shadow, dead crop |
| `L` | `#b6d65a` | new leaf | foliage highlight |
| `M` | `#6fa83f` | leaf | foliage base |
| `N` | `#3f7a3a` | deep leaf | foliage shadow |
| `n` | `#24503a` | darkest foliage | foliage outline |
| `O` | `#7a8f55` | dull olive | stress: leaf rolling |
| `P` | `#5d6b5c` | green-grey | stress: greyish cast |
| `Q` | `#8b8f80` | grey | stress: severe, stone |
| `t` | `#fff4d6` | bleached sky | midday sky, sun, glints |
| `u` | `#9fd0e6` | midday sky | sky, water reflection |
| `v` | `#5b9fd0` | zenith blue | sky, water mid |
| `W` | `#3a6fa0` | deep water | water |
| `X` | `#bfe6f0` | water sheen | water highlight, wet-soil sheen, rain |
| `h` | `#7f9cc0` | far hills | distant hills, haze |
| `w` | `#f7b26a` | golden hour | sunrise/sunset light |
| `x` | `#e0735a` | dusk coral | dusk sky, clouds underside |
| `y` | `#6e4f86` | dusk violet | dusk sky, hill shadow, storm underside |
| `z` | `#2e3560` | night indigo | night ambient |
| `Z` | `#171c38` | deep night | night sky |
| `1` | `#e3a97c` | skin 1 | skin ramps |
| `2` | `#c0835a` | skin 2 | skin ramps |
| `3` | `#9a5e3e` | skin 3 | skin ramps |
| `4` | `#74402d` | skin 4 | skin ramps |
| `5` | `#532c23` | skin 5 | skin ramps |
| `6` | `#3a1f1b` | skin 6 | skin ramps |
| `r` | `#c8323c` | madder red | cloth, jerrycan cap, alert |
| `o` | `#f08a24` | marigold | cloth, jerrycan shade, warning |
| `Y` | `#f2c230` | sun yellow | cloth, jerrycan, lamp core |
| `g` | `#1f8a7a` | teal | cloth, OSI device accent, UI header |
| `i` | `#2f4fa0` | indigo | cloth |
| `p` | `#8a3a78` | plum | cloth |
| `c` | `#f6efe0` | cream | cloth, UI paper, device housings |
| `R` | `#8a9aa6` | galvanised grey | iron sheet, pipe, metal |
| `T` | `#c3ccd0` | metal highlight | iron sheet highlight, housings |
| `j` | `#7a5236` | wood | poles, tool handles |
| `J` | `#4e3426` | dark wood | wood shadow, door |
| `F` | `#fff1b8` | lamp glow | emissive highlight, fire tip |

Count check: 46 unique hex values (verified by `check.mjs`).

**Named ramps** (dark to light unless stated):

| Ramp | Keys | Notes |
|---|---|---|
| Soil, wet to dry | `E D C B A` | Wetness moves a pixel down this ramp (2.1); `X` adds sheen on wet tops |
| Dry grass | `I H G` | Shared with thatch and dead crops |
| Foliage, healthy | `n N M L` | |
| Foliage, stress | `O N n` (rolling), `P Q` (greyish), `P Q H` (wilted), `I H G` (dead) | Matches the extension-described progression, see 2.2 |
| Water | `W v u X` | `t` for sun glints |
| Sky, pre-dawn | `Z z y` | |
| Sky, sunrise/sunset | `y x w G` | |
| Sky, midday | `v u t` | |
| Sky, storm | `k y h Q T` | underside to lit anvil top `c` |
| Hills | `y h u` | far to near with haze |
| Skin A | `1 2 3` | light-medium brown |
| Skin B | `2 3 4` | medium brown |
| Skin C | `3 4 5` | deep brown |
| Skin D | `4 5 6` (+ `3` rim) | deepest brown |
| Cloth shading | `Y>o`, `o>r`, `r>p`, `p>k`, `g>n`, `i>z`, `c>G>H` | each fabric colour shades into a neighbour |
| Metal | `k R T c` | iron sheet; rust overlays use `C D` |
| Wood | `K J j` | |
| Fire/lamp | `r o Y F` | emissive flag set |
| UI | `c` paper, `K` ink, `g` header, `o` warn, `r` alert, `M` ok, `v` info | |

Rules:

- A sprite uses at most 12 palette entries (icons: 8). The validator enforces it.
- Skin tones: the setting implies mostly deep tones; spread NPCs across all four ramps with B, C and D most common. Faces are never outlined in `K`; their selective outline is the next-darker skin key, so deep skin never merges into the ink line. At night, characters get a rim light one ramp step up on the lit side so deep skin stays readable.
- Highlights on skin are warm (`1`, `2`), never grey.
- Post-processing (lights, grading, bloom) can move on-screen colours off the palette. The palette constrains authored pixels and ramp-step lighting; the final LUT is allowed to tint. See 3.6 for an optional re-quantisation step.

### 1.5 Camera, scale and projection

- **Projection:** top-down with front-facing elevations (walls, trunks and characters drawn as seen from the south, ground seen from above). Objects are Y-sorted by their foot point.
- **Tile 16x16.** It is the smallest size at which a crop can show five growth stages and four stress shapes distinctly, and at which furrow ridges and a 1 px drip line both read. 32 px tiles would cost four times the authoring and bring no extra legibility at 480x270.
- **Character cell 24x32, body about 14x26.** Taller than a tile so people read as adults, wide enough for a hoe swing. The extra headroom carries a jerrycan or basket on the head, which is part of the identity and does not fit in a 16x32 cell. Proportion about 3.5 heads; head 9-10 px wide.
- **Scale cues:** maize at maturity is about 2.4 m, so the mature sprite is 16x40 and overlaps the tiles above it. A house is 4x4 tiles. Trees are 3-4 tiles tall.
- **Horizon:** a top-down camera does not see the sky. The blue hills and storm towers appear in three places: (1) a lookout ridge on the north edge of the farm map where the map drops away and a parallax horizon band shows, (2) a 480x270 day-transition vignette rendered from the same procedural sky between days, (3) reflections in water and puddles, plus cloud shadows on the ground.

### 1.6 Outline policy

- **Terrain, water, paths:** no outlines. Edges are made by value contrast and autotile shapes.
- **Characters, animals, crops, interactable objects:** selective outline. The outline pixel takes the darkest key of the ramp it borders (`n` for foliage, `k` for most objects, the next-darker skin key for faces), and the lit (upper-left) edge may drop the outline entirely. This keeps sprites crisp without the heavy black-line look.
- **Buildings and trees:** outline only on the silhouette's bottom and shadow side, using `k` or `n`.
- **Inventory icons and UI glyphs:** full 1 px `K` outline so they read on any background.
- **Interaction highlight:** a shader adds a 1 px `F` outline pulse (2 frames) around the hovered object; never baked into sprites.

### 1.7 Fabrics

Cloth patterns are generated, not drawn per sprite:

- A motif grammar on an 8x8 cell: dots, rings, chevrons, zigzags, leaf lozenges, half-circles, stripes. A pattern is one motif, a repeat offset (none, half-drop, brick) and two or three colours from the cloth keys on a ground colour.
- Patterns live in a pattern atlas. Clothing pixels carry a "pattern" flag and a pattern id; the shader samples the pattern in sprite-pixel space (locked to the sprite's own grid, so it does not swim as the character walks) and then applies the cloth shading pair from 1.4 where the authored pixel is a shadow tone.
- Each NPC is a seed. The generator refuses combinations with text-like glyphs and limits saturation pairs so cloth never clashes with UI alert colours.

### 1.8 Lighting by time of day

The farm runs on the simulator's clock (`demo/model/clock.ts`) in the simulator's farm timezone (Africa/Kampala, UTC+3, from `demo/fixtures.ts`). Sunrise and sunset in the fictional region are set to about 06:30 and 18:40 local; the region is near the equator, so day length barely changes over the year. Civil twilight near the equator lasts only about 21-24 minutes ([timeanddate.com](https://www.timeanddate.com/astronomy/civil-twilight.html), [University of Alaska](https://www.gi.alaska.edu/alaska-science-forum/twilight-zone)), so dawn and dusk transitions are fast and should feel fast. The blue-hour and dusk keyframes below each span about 45 minutes: civil twilight plus the darker nautical twilight before it (dawn) or after it (dusk), lightly stretched so the colour change is visible at normal game speed. The simulator's 06:00 legacy SWT trigger therefore fires in deep blue light, before civil twilight starts.

| Keyframe | Local time | Sun light | Ambient | Shadows | Grading notes |
|---|---|---|---|---|---|
| Night | 19:25-05:45 | moon, cool `h` at 15% | `z` | soft, long, from moon | saturation -40%, blue lift; lamps and fire dominate |
| Blue hour | 05:45-06:30 | none | `z` to `y` | none | violet lift, mist in low tiles; 06:00 trigger here |
| Sunrise | 06:30-07:30 | `w` low from east | `x` | 3 tiles long, pointing west | warm gain, haze glows |
| Morning | 07:30-10:00 | `G` to `t` | `u` | 1-2 tiles, west | neutral, clear |
| Midday | 10:00-15:00 | `t` near overhead | `u` | under-object blob, 2-4 px offset | contrast up, highlights warm-clipped; dry season: saturation -15%, heat shimmer on |
| Afternoon | 15:00-17:30 | `t` to `w` | `u` | 1-2 tiles, east | rains: cloud build-up, cloud shadows |
| Golden hour | 17:30-18:40 | `w` to `o` | `x` | 3 tiles, east, clamped | rim light on characters, grass tips glow, roof glints |
| Dusk | 18:40-19:25 | none | `x` to `y` to `z` | none | quick fade, lamps on |

Shadow direction and length come from a simple sun model: azimuth sweeps east to west, elevation follows a sine over the day, and length = caster height / tan(elevation), clamped to 3 tiles so golden-hour shadows stay legible.

### 1.9 Lighting by season

Seasons follow the bimodal East African pattern: long rains roughly March-May, short rains roughly October-December ([Nature Reviews Earth & Environment](https://doi.org/10.1038/s43017-023-00397-x), [Eos](https://eos.org/editors-vox/short-rains-and-long-rains)). Timings vary by place, which suits a fictional region.

| Season | Look | Weather effects |
|---|---|---|
| Hot dry (Jan-Feb) | bleached, highest contrast, palest soil, bare baobab, grey-green acacia | heat shimmer, dust devils, cracked soil |
| Long rains (Mar-May) | saturated after rain, vivid greens, dark soil | convective towers in the afternoon, cloud shadows, heavy rain, puddles, the sand river flows for a few days |
| Cool dry (Jun-Sep) | hazy, gold grass, softer contrast, dusty air | dust, wind sway stronger, morning haze |
| Short rains (Oct-Dec) | greening, lighter showers | scattered showers, rainbows on the horizon vista |

Season is a modifier on the time-of-day LUT (saturation, haze, contrast) and on generator inputs (grass ramp position, leaf density on trees, river bed water).

### 1.10 UI direction: painted signboard

The UI takes its cue from hand-painted shop signs and painted metal boards, not from wood planks or parchment.

- **Panels:** flat cream (`c`) boards, 1 px ink (`K`) border, a 1 px corner cut instead of rounded corners, a 1 px `T` inner highlight on the top edge only (painted metal).
- **Headers:** a teal (`g`) band carrying a generated cloth strip (1.7) 8 px high; heading text in a bold original pixel face with a deliberate 1 px baseline wobble every few letters, like brush lettering.
- **Icons:** 16x16 with full ink outline (1.6), on cream.
- **State colours:** `M` ok, `o` warning, `r` alert, `v` info, always paired with a glyph so colour is never the only signal.
- **HUD layout:** clock and weather widget top-right, tool strip of 8 slots bottom-left, water-drop energy gauge beside it, phone button bottom-right. Everything else (shop, inventory, dialogue) is a centred board over a dimmed world.
- **Text:** the pixel font (3.7) must cover the strings the game reuses from the edge app's locales (`web/react-gui/public/locales`: de-CH, en, es, fr, it, lg, pt). Beyond Latin-1 those files use `ŋ` (Luganda), `œ` (French), and `’ – — … − ← → ≤ ≥ ≈ ₀ Ω`.

### 1.11 Animation budget

| Subject | Frames | Rate |
|---|---|---|
| Character idle | 2 (breath) | 2 fps |
| Character walk | 4 (contact, pass, contact, pass) | 8 fps |
| Tool action (hoe) | 5 (raise, raise, strike, recoil, return) | 12 fps |
| Tool action (watering can, jerrycan pour) | 4 + particle loop | 10 fps |
| Harvest | 4 | 10 fps |
| Plant seed | 3 | 10 fps |
| Carry on head, walk | 4 | 8 fps |
| Open valve | 3 | 8 fps |
| Look at phone | 2 (lift, hold loop) | 4 fps |
| Goat walk / graze / idle | 4 / 3 / 2 | 8 / 4 / 2 fps |
| Chicken walk / peck | 4 / 3 | 10 fps |
| Fire | 6 | 10 fps |
| Device LED | 2 | event-driven |
| Crops, grass, trees | 1 authored frame; motion by row shear in shader | continuous, quantised |
| Water | 1 authored ripple tile; motion by stepped scrolling | 8 fps steps |

Directions: author down, up and side; the other side is a mirror. Asymmetric items held in a hand are a separate layer so mirroring does not move them to the wrong hand.

## 2. Visual vocabulary for irrigation

### 2.0 Honesty boundary for visuals

Two kinds of things appear on screen, and the art keeps them apart:

- **World state** (soil colour, puddles, crop posture, water in furrows) is drawn from the game's own soil-water and plant model. It is never labelled as an OSI reading, recommendation or decision.
- **OSI output** (recommendations, scheduled opens, readings, the 06:00 trigger, valve commands) appears only inside the phone, which shows the real edge React app running against the simulator, or as a device event the simulator itself emitted (an LED blink when the simulator records an uplink, a valve opening when the simulator opens it). The game draws no imitation OSI screens, numbers or recommendation icons.
- **Required hook:** today the host-app protocol (`demo/protocol.ts`) only sends `time`, `notice`, guide results and a `next-event` preview whose kind is `valve-close`, `schedule-start` or `report`. There is no message for "uplink recorded" or "valve opened". Device animations driven by the simulator need a new, read-only world-event message from the runtime (device EUI, event kind, simulated time); until it exists, device sprites stay static rather than animate on guessed timing.

### 2.1 Soil moisture at a glance

Per-tile moisture lives in a small "moisture texture" (one texel per tile). The soil shader quantises it into five bands, with a 4x4 ordered dither across band edges so wet patches have organic edges instead of tile-shaped ones.

| Band | Visual | Implementation |
|---|---|---|
| Saturated / puddle | darkest soil (`E D`), standing water in low pixels, sky reflection | ramp shift -2, puddle blob autotile, `X` glints |
| Wet | dark red-brown, sparse `X` sheen pixels on ridge tops that sparkle with sun angle | ramp shift -2, sheen mask |
| Moist | slightly darker than dry, no sheen | ramp shift -1 |
| Dry | base laterite (`B A`) | ramp shift 0 |
| Very dry | lightest (`A` dominates), crack overlay, faint dust on wind | ramp shift +1 (clamped at `A`), crack overlay alpha 1 |

The band thresholds are a tunable table in game data, expressed as the game model's soil water tension in kPa so the same numbers can be compared with what the phone shows. Starting values, from extension guidance on tension sensors ([Alabama Extension](https://www.aces.edu/blog/topics/crop-production/irrigation-scheduling-using-soil-water-tension-sensors/), [UNH Extension](https://extension.unh.edu/resource/soil-moisture-sensors-fact-sheet), [Agriculture Victoria](https://agriculture.vic.gov.au/farm-management/water/irrigation/irrigation-factsheets-and-resources/Using-tension-based-soil-moisture-monitoring-tools.pdf)):

| Band | Game SWT (kPa) | Basis |
|---|---|---|
| Saturated | 0-8 | near 0 kPa is saturated |
| Wet | 8-25 | field capacity is roughly 10 kPa in light soils and 33 kPa in heavy soils |
| Moist | 25-50 | common irrigation triggers sit between 20 and 60 kPa depending on soil and crop |
| Dry | 50-100 | |
| Very dry | above 100 | Watermark-type sensors read up to about 200 kPa |

These are visual bands, not OSI thresholds. OSI thresholds are configured per schedule (`threshold_kpa` in `demo/model/triggers.ts`), and the sources disagree by soil texture. The table must be tuned once the game's soil model exists, and it must never be shown to the player as an irrigation rule.

The dry-to-wet change is an art choice (moist soil is darker in value, which soil scientists record by noting both a dry and a moist colour, see [Wikipedia: Soil color](https://www.wikipedia.org/wiki/Soil_color)); the size of the shift here is chosen for legibility, not measured.

Wetting and drying animate: rain darkens tiles from random pixels outward over about one in-game hour; irrigation darkens along the water front (2.3); drying lightens from ridge tops first, so the furrow bottoms stay dark longest, which is also what a farmer sees in the field.

### 2.2 Crop water stress stages

The stage sequence follows extension descriptions of drought-stressed maize: leaf rolling first, then leaves turning "from normal green to a dark green-gray, then to simply gray, and finally the straw color of complete death" ([Purdue Extension](https://agry.purdue.edu/ext/corn/news/timeless/CornRespDrought.html), checked by fetching the page). Rolling that recovers in the evening is mild; rolling from sunrise to dark is severe (same source), which the game shows by making rolling time-of-day dependent at the mild stage.

| Stage | Shape | Colour | Notes |
|---|---|---|---|
| 0 Turgid | leaves arched and open | `L M N n` | full sway |
| 1 Leaf rolling | leaves narrowed, more upright | `O N n` | at the mild level, only from 11:00 to 16:00; sway reduced |
| 2 Greyish | rolled shape | `P Q` (remap of stage 1: `O`,`N` to `P`, `n` to `Q`) | rolled all day |
| 3 Wilted | leaves drooping, tips down | `P Q H` | no sway |
| 4 Dead | wilted shape | `H I G` (remap of stage 3) | terminal; harvest yields nothing or straw |

**Reconciling five stages with "4 stress states":** each growth stage has four live states (0-3) plus one terminal dead sprite (4). Only two shapes per growth stage are hand-authored (open and rolled) plus one drooped shape; the other two states are palette remaps. Per crop: 5 growth stages x 3 authored shapes = 15 grids, giving 25 output sprites.

Tomato (second crop) uses its own vocabulary: stage 1 is leaflet curl and slight droop of the top, stage 2 a grey-green cast, stage 3 whole-plant flop over the cage, stage 4 brown. Fruit overlays (green, turning, red) are separate 16x16 layers.

Both crops exist in the real OSI crop coefficient table (`osi-crop-kc/crop-kc.json` has `maize` and `tomato`), so a Kc curve shown on the phone can come from real OSI code.

### 2.3 Water flow

- **Furrows and basins:** water is a separate layer on top of soil, using a 47-tile blob autotile so channels, junctions and basin edges join correctly. A 16x16 ripple pattern (authored, `W v u X`) scrolls along each tile's flow direction in whole-pixel steps at 8 fps. Each tile has a fill fraction; the shader masks water along the tile's flow axis so a visible front advances down the furrow. Behind the front, water fades over time and leaves the soil in the "wet" band, so the player sees infiltration.
- **Drip lines:** a 1 px dark line (`k` with `R` highlight) along the row, an emitter bump every 4 px. A drip is a 1x2 `X` particle (3 frames) and a slowly growing wet circle written into the moisture texture beneath each emitter, so drip irrigation reads as a row of dark spots, not a flooded field.
- **Watering can and jerrycan:** an arc of 1x1 and 1x2 `X`/`u` particles, then splash frames, then the target tile darkens.
- **Well and bucket:** rope and bucket animation (4 frames), a brief `X` spill on the rim.
- **Pipes from tank to valve:** pipe sprites are static; flow is shown by a travelling 2 px highlight along the pipe when the valve is open.

### 2.4 Devices (generic, not product reproductions)

All OSI-tier hardware shares one visual cue: a cream housing (`c T`) with a teal (`g`) accent. Players learn "cream and teal means a sensor or controller you installed". The shapes are generic and do not copy a commercial product.

| Device | Sprite | States |
|---|---|---|
| Soil tension probe (Kiwi-like role) | 16x16: small cream housing on a grey tube, short antenna, three depth bands drawn on a cutaway overlay when inspected | LED off / blink (2 frames), triggered by a simulator uplink event |
| Buried tension sensor with logger (Watermark-like role) | 16x16: low logger box on a stake, cable into soil | LED off / blink |
| Valve box | 16x16: low grey box on the pipe, teal lever | closed / open (lever and a flow highlight on the pipe); opening is a 3-frame lever swing |
| Gateway on a pole | 16x48: wooden pole (`j J`), cream enclosure, short antenna, small solar panel (12x8, `i z` cells with `T` frame) | LED idle / transmit (2 frames); solar panel glint by sun angle |
| Rain gauge | 8x16 funnel on a post | none |
| Water tank on a stand | 32x48 | level shown by 4 fill sprites |
| Drip line kit, valve kit, probe kit | 16x16 icons | none |

Device sprites never show numbers. Numbers live in the phone.

### 2.5 Phone UI frame

- The phone is a DOM overlay, not part of the canvas. It holds the simulator iframe, which runs the real edge React app (`demo/adapter.ts`, `demo/runtime.ts`). It is exempt from pixel snapping, the LUT and bloom.
- The app keeps its own CSS viewport: the existing demo hosts it in a 390x844 CSS-px iframe inside a 402 px frame and scales the whole frame with a CSS transform (`demo/host.css` `.phone iframe`, `demo/public/host.css` `--frame-width`). The game does the same: the iframe stays 390x844 and is transform-scaled to fit; non-integer scaling is acceptable here because it is DOM text, not pixel art.
- The bezel is a pixel-art 9-slice drawn in the same palette (`K k` body, `R T` edge highlight, a 1 px `g` status line, a speaker slot) and applied as a CSS `border-image` at the current integer world scale, so it matches the canvas pixel size.
- On small screens (roughly below 600 CSS px of height) the phone opens full-screen and the world pauses, so the app is never shrunk below readable size.
- When the phone is open, the world dims (ambient multiplied down) and a soft point light from the screen lights the player's face. That is a game-side effect, not an OSI one.
- The game may point at an object the app talks about (for example, outline the valve the app just opened) but only after the simulator emitted the corresponding event; it never invents an instruction.

### 2.6 Visible link between world and OSI events

The simulator ports real edge behaviour, including the 06:00 legacy SWT trigger (`demo/model/triggers.ts`) and timed valve opens and weekly plans (`demo/model/irrigation.ts`, `demo/model/plans.ts`). With sunrise at about 06:30, the 06:00 trigger fires in the blue hour: the gateway LED blinks, the valve lever swings, water starts down the pipe while the farm is still dark. That scene is a strong teaching image and costs no extra art, once the world-event hook in 2.0 exists.

## 3. Technical plan

### 3.1 Sprite source format

Sprites are TypeScript modules. A sprite is a list of fixed-width strings, one character per pixel, keyed to the master palette (`.` is transparent). Optional parallel grids carry extra channels:

```ts
// sprites/crops/maize.ts
import {sprite, derive} from '../core';

export const maizeS2Turgid = sprite({
  id: 'crop.maize.s2.turgid',
  size: [16, 16],
  anchor: [8, 13],             // foot point, used for Y-sort and shadow casting
  height: {mode: 'bevel', max: 6, base: 'anchor'}, // auto height map from silhouette (3.4)
  sway: {mode: 'rows', weight: 1}, // row shear in shader (3.6)
  rows: [ /* 16 strings of 16 chars */ ],
});

export const maizeS2Greyish = derive(maizeS2Rolling, {
  id: 'crop.maize.s2.greyish',
  remap: {O: 'P', N: 'P', n: 'Q'}, // stress colour as a palette remap
  sway: {mode: 'rows', weight: 0.3},
});
```

Supported channels and operations:

| Feature | Form |
|---|---|
| Colour | `rows: string[]` with palette keys |
| Height | `heightRows` with digits `0-9`, or `height: {mode: 'bevel'}` (distance-to-edge bevel from the silhouette), or per-key default heights (for example, ridge `A` = 3, trough `D` = 0) |
| Flags | `flagRows` with letters: `e` emissive, `w` wet-capable, `p` pattern (cloth), `s` sheen-capable, `h` hand-item layer |
| Frames | `frames: string[][]`, or `frames: [{base, patch: {x, y, rows}}]` for small per-frame changes |
| Derivation | `derive(src, {remap, mirror, shiftRamp, overlay, crop})` |
| Composition | `compose([layerA, layerB])` for paper-doll characters (body, clothing, headwear, held item) |
| Variants | `variants(src, seed, n, op)` with seeded ops: pebble scatter, tuft scatter, crack generation, colour jitter along ramp |

The validator (a build step and a unit test) checks: every row has the declared width, every key is in the palette, colour count per sprite is within budget, anchors lie inside the sprite, no orphan single pixels on outlines (warning), mirrored directions do not mirror hand layers. The prototype validator for this report is `check.mjs` next to this file.

**Hand grids or generators?** Hero assets (characters, crops, houses, devices, icons, signature trees) are hand-authored grids, because generators tend to produce generic shapes. Generators fill in volume: ground variants, grass tufts, pebbles, crack maps, cloth patterns, cloud and hill silhouettes, autotile expansions, and variant trees seeded from a hand-made base (canopy blobs moved and re-shaded).

### 3.2 Procedural generators

All generators take an integer seed and return the same pixels every time (a small PCG or xorshift PRNG; no `Math.random`).

| Generator | Method | Output |
|---|---|---|
| Ground variants | value noise in 2 octaves picks ramp positions; Poisson-disc scatter of 1-3 px pebbles (`A` top, `C` bottom) | 8 variants per material |
| Crack overlay | jittered Voronoi cell edges inside the tile, thinned to 1 px, `A` lip pixel on the lit side of each crack | 4 variants; cracks join across tile borders because the tiles share edge seeds |
| Grass tufts | small L-system blades (2-5 px) in `I H G` (dry) or `n N M L` (green) | 4 tuft sprites per season state |
| Tree variants | hand-made trunk plus canopy built from 6-10 hand-made blob stamps placed by seed; flat-top layering for acacia | 3 variants per species |
| Horizon | two ridge lines from 1D noise (`y` far, `h` near), haze gradient by ordered dither | 480x96 band per season |
| Clouds | metaball cumulus from 3-8 circles, shaded by sun direction into `c T h y`; cumulonimbus adds a flat anvil and dark base `k y` | 3 small, 2 large, 1 storm |
| Cloud shadows | tiled 2D noise thresholded and dithered, scrolled by wind | full-screen mask |
| Cloth patterns | motif grammar (1.7) | 8x8 or 16x16 tile per pattern |
| Autotile expansion | quarter-tile composition (3.3) | 16 or 47 tiles per material |

### 3.3 Autotiling

- **Corner-based (dual grid) for terrain blends:** each material pair (laterite/grass, laterite/tilled, laterite/sand bed, path/laterite) uses a 2-corner Wang set: 2^4 = 16 tiles, authored either directly as 16 grids or through the same 20-piece quadrant composer. Tilled soil is never rotated: furrows are directional. The dual-grid arrangement (display tiles offset by half a tile from the logic grid) lets each logic cell be one material while the display tiles show the transitions. Tilled soil uses this, so tilling one cell gives a rounded patch and tilling neighbours merges them.
- **Blob 47 for channels, puddles and hedges:** water channels, puddles and hedge rows need inner corners, so they use the 47-tile blob set, which is the 47-tile subset of the 256 possible 8-neighbour Wang combinations ([cr31 blob tileset, mirrored by boristhebrave](https://www.boristhebrave.com/permanent/24/06/cr31/stagecast/wang/blob.html), [Red Blob Games autotile notes](https://www.redblobgames.com/articles/autotile/claude/)). Tools exist that build the full 47-tile sheet from 6 base tiles ([Blobsmith](https://godotengine.org/asset-library/asset/5343)); we do the same in code. Each tile quadrant (NW, NE, SW, SE) has five possible states (fill, outer corner, inner corner, horizontal edge, vertical edge), so a material needs 20 quadrant pieces of 8x8. They are drawn as a small source sheet of four to six 16x16 tiles and sliced; they are not rotated, because light comes from the upper left and banks have a visible face only on their north side. The generator composes all 47 tiles by picking a quadrant piece from each quadrant's neighbour mask. A lookup table maps each of the 256 masks to one of the 47 tiles after clearing corner bits that have no adjacent edges.
- Tile choice runs on the CPU when the map changes (tilling, digging a channel) and writes a tile-index texture; the GPU draws terrain as one quad per layer.

### 3.4 Atlas build

- **Build time:** a Vite plugin imports every sprite module, runs generators, validates, packs a texture atlas (shelf or MaxRects packing, 1 px transparent gutter, power-of-two pages), and emits:
  - `atlas-index.png` (RGBA8): R = palette index (0 transparent), G = height (0-255), B = flags bitfield (emissive, wet-capable, sheen, pattern, hand layer), A = ramp id. Pattern id and sway weight are per-instance attributes, not per-pixel.
  - `atlas-normal.png` (RGBA8): normals baked from the height channel with a Sobel 3x3 kernel, encoded as RG (B and A free for an AO term). Sobel on a height map is the standard height-to-normal method and the one compared in the pixel-art normal-map literature ([arXiv 2212.09692](https://arxiv.org/abs/2212.09692)); no blur, since blurring widens slopes on pixel art ([ziva.sh notes](https://ziva.sh/tools/normal-map-generator)).
  - `palette.png`: 64x1 palette, plus a ramp table of 64 palette indices x 32 ramp ids, each texel storing the indices two and one steps down and one and two steps up. A ramp id is needed because several colours sit in more than one ramp (`c`, `k`, `H`, `Q`, `C`, `T`), and their neighbours differ per ramp. Each palette key has a default ramp; a sprite can override it per key (`ramps: {c: 'cloth', H: 'straw'}`), and the compiler writes the result into the A channel.
  - `atlas.json`: frames, anchors, animation clips, autotile tables.
  - a content hash, pinned by a test so accidental pixel changes show in review.
- **Development:** the same pipeline runs in the browser at boot (OffscreenCanvas) with hot reload of sprite modules, so an edit to a grid is visible in about a second.
- **Palette swaps for free:** because the atlas stores indices, character variety (skin ramp, cloth colours), stress remaps, season remaps and soil wetness are all palette or ramp lookups in the shader, not extra atlas pages.

### 3.5 Render pipeline

Target: WebGL2. A third-party survey puts WebGL2 support at about 98% of sampled clients, lowest on Linux at about 88% ([web3dsurvey.com](https://web3dsurvey.com/webgl2)); it is Baseline widely available since 2024 ([web-features explorer](https://web-platform-dx.github.io/web-features-explorer/features/webgl2)). These are survey figures, not caniuse figures. A Canvas2D fallback draws pre-baked palette variants with no dynamic light.

Passes, all at the 480x270 logical resolution plus a one-tile margin:

1. **G-buffer:** terrain layers (tile-index texture), then Y-sorted sprites (instanced quads). Outputs palette index, height, flags, normal.
2. **Shadow mask:** each caster draws its silhouette into an R8 mask, sheared along the sun vector with length = height / tan(elevation), clamped to 3 tiles. A 1 px dithered penumbra (4x4 Bayer) gives softness without blur. Cloud shadows add a scrolled noise mask in the rains.
3. **Light accumulation:** sun (directional, colour from the keyframe table), sky ambient, and up to 32 point lights (fire, lamps, phone screen, LEDs) with quantised falloff. Result is an intensity per pixel.
4. **Ramp-step resolve:** intensity becomes a ramp step in -2..+2; the shader looks up the ramp table with the pixel's palette index and ramp id to get the final palette colour. Shadow pixels step down one or two ramp steps and pick up the ambient tint, instead of being multiplied toward black. This keeps lit pixel art inside its own ramps.
5. **Effects at low resolution:** water ripples and fronts, rain and dust particles, heat shimmer, interaction outline.
6. **Grading:** a 3D LUT (32^3, packed into a 1024x32 texture) blended between the two nearest time-of-day keyframes, with season modifiers. LUTs are generated in code at boot from parameters (lift, gamma, gain, saturation, white balance); no image assets.
7. **Bloom:** threshold on emissive-flagged pixels and sun glints only, two blur passes at quarter resolution, added at 15-25%. Never on the whole frame.
8. **Upscale:** nearest-neighbour by the integer factor, offset by the camera's sub-pixel remainder (3.7). Vignette (stronger at night) is applied here.
9. **UI:** a separate low-res canvas layer at the same integer scale. The phone is a DOM overlay above both.

### 3.6 Shader list

| Shader | Purpose | Pixel-art rule |
|---|---|---|
| `terrain.frag` | tile layers, soil wetness ramp shift, sheen, crack overlay alpha | ramp shift, never alpha blending of colours |
| `sprite.vert/frag` | instanced sprites, palette and remap lookup, cloth pattern sampling | pattern sampled in sprite-pixel space |
| `sway` | wind on grass, crops, tree canopies | per-row horizontal shift in the fragment shader: offset(row) = round(amp * (1 - row/h)^2 * sin(t * f + phase + gust)); max 1-2 px; integer only. A classic vertex-shader shear moves the top vertices by fractional amounts and bends the sprite linearly, which shimmers on a pixel grid; the row shift keeps every pixel on the grid and the base planted. Small tufts may still use a vertex shear snapped to whole pixels, since they are one or two rows of motion. |
| `shadow.vert/frag` | sheared silhouettes, dithered penumbra, cloud shadows | dither, no blur |
| `light.frag` | sun, ambient, point lights, normal maps | quantised to ramp steps |
| `water.frag` | stepped ripple scroll along flow, fill-fraction front, sky reflection from current sky colour, glints | steps at 8 fps, 1 px |
| `particles` | rain streaks (1x3, 1x4 diagonal), splashes (4 frames), dust (2x2), drips, sparks, fireflies | particles drawn at integer positions in the low-res target |
| `shimmer.frag` | heat haze over hot ground at midday in dry seasons | horizontal row offsets of 0 or 1 px from noise, never fractional |
| `grade.frag` | LUT blend, optional re-quantisation (below) | at low resolution, before upscale |
| `bloom` | emissive glow | the only filtered element; quarter-res, low strength |
| `upscale.frag` | integer nearest upscale, sub-pixel camera offset, vignette | |

**Optional palette re-quantisation:** after grading, snap each pixel to the nearest colour in a per-keyframe "graded palette" (the 46 colours run through that keyframe's LUT). This guarantees no off-palette colours at all, at the cost of banding in fades. Recommendation: build it as a toggle and decide by eye in the vertical slice.

### 3.7 Pixel-perfect rules

1. Integer zoom only. The logical size flexes (by up to a few tiles) to fill the window at the chosen integer scale; no fractional scaling, no CSS scaling of the canvas.
2. All sprites, particles and tiles render at integer positions in the low-res target. Entity positions are stored in sub-pixels for physics but floored for drawing.
3. Smooth camera: the camera follows in sub-pixels; the low-res frame is rendered at the floored camera position, and the remainder (0..1 logical px) is applied as a screen-pixel offset in the upscale pass. The margin tile hides the edge. Scrolling is smooth while sprites stay on the grid.
4. No rotation (except 90 degrees), no non-integer scaling, no bilinear sampling of sprite textures. Motion effects (sway, shimmer, bob) are whole-pixel shifts.
5. One pixel size everywhere: UI, font and world share the logical pixel. On very small screens the UI may use scale - 1, never a fractional scale.
6. Text uses an original pixel font authored in the same grid format: 5x7 body, 6x9 headings, Latin-1 plus the extra characters listed in 1.10 for the edge app's locales.
7. Canvas set with `image-rendering: pixelated` and the device-pixel-ratio accounted for when choosing the integer factor.

### 3.8 Testing and determinism

- Atlas content hash pinned in a unit test; generator outputs pinned per seed.
- Playwright screenshot tests (the demo already uses Playwright) at fixed simulator times: blue hour 05:55, midday, golden hour, a rainy afternoon. Because the simulator clock is a deterministic event queue, frames are reproducible; compare the low-res frame buffer read back with `readPixels`, not the upscaled screenshot.
- A validator pass in CI over all sprite modules (3.1).

### 3.9 Performance budget

- 480x270 is about 130k pixels per pass; the full pipeline runs about ten such passes plus a quarter-res bloom, well within mid-range phone GPUs.
- Sprites are instanced in one draw call per layer; terrain is one quad per layer.
- Target 60 fps on a mid-range Android phone; degrade in this order: bloom off, point lights limited to 8, shimmer off, then the Canvas2D fallback.

## 4. Vertical-slice asset list (prioritised)

P0 is needed for the first playable day loop (till, plant, water, see stress, install a probe and valve, read the phone). P1 completes the slice. P2 is polish. "Grids" counts hand-authored grids; the rest are generated or derived.

### 4.1 Terrain

| Pri | Asset | Size | Frames / tiles | Source |
|---|---|---|---|---|
| P0 | Laterite ground | 16x16 | 8 variants | generator from 1 base grid |
| P0 | Dry grass ground + tuft overlays | 16x16 | 8 variants + 4 tufts (green and dry ramps) | generator |
| P0 | Tilled soil (dual-grid corner Wang) | 16x16 | 16 tiles | 20 quadrant pieces, composed |
| P0 | Crack overlay | 16x16 | 4 variants | generator |
| P0 | Furrow / channel water (blob) | 16x16 | 47 tiles + 1 ripple pattern | 20 quadrant pieces, composed; ripple 1 grid |
| P0 | Laterite/grass transition | 16x16 | 16 tiles | 20 quadrant pieces, composed |
| P1 | Footpath | 16x16 | 16 tiles | composed |
| P1 | Sand river bed + pebble overlays | 16x16 | 16 tiles + 4 overlays | composed + generator |
| P1 | Puddles (blob) | 16x16 | 47 tiles | shares channel generator |
| P1 | Planting holes / seed marks | 16x16 | 2 | grids |
| P2 | Horizon vista band (lookout ridge, day transition) | 480x96 | 4 season variants | generator |
| P2 | Clouds | 32x16 to 128x96 | 6 | generator |

### 4.2 Crops

| Pri | Asset | Size per stage (s1..s5) | Frames | Source |
|---|---|---|---|---|
| P0 | Maize, 5 growth stages x (4 live + dead) | 16x16, 16x16, 16x32, 16x40, 16x40 | 25 sprites | 15 grids + 10 remaps |
| P1 | Tomato, 5 growth stages x (4 live + dead) | 16x16, 16x16, 16x24, 16x24, 16x24 | 25 sprites | 15 grids + 10 remaps |
| P1 | Tomato fruit overlay (green, turning, red) | 16x16 | 3 | grids |
| P1 | Harvest pops (maize cob, tomato) | 16x16 | 3-frame pop | grids |

### 4.3 Structures and nature

| Pri | Asset | Size | Frames | Source |
|---|---|---|---|---|
| P0 | Farmhouse: mud brick, plaster band, iron-sheet roof with rust streaks | 64x64 | 1 + door 2 | grid; rust via overlay generator |
| P0 | Well with windlass and bucket | 32x32 | 4 (bucket) | grid |
| P0 | Acacia (flat-top) | 64x48 | 1 (sway in shader) + 2 seeded variants | grid + canopy stamps |
| P1 | Granary on stilts, thatched | 32x48 | 1 | grid |
| P1 | Water tank on stand | 32x48 | 4 fill levels | grid + overlays |
| P1 | Baobab | 48x64 | 2 (leafed, bare) | grid + remap |
| P1 | Euphorbia candelabra | 32x48 | 1 | grid |
| P1 | Sisal clump | 16x16 | 3 variants | grid + generator |
| P1 | Hedge row (euphorbia/sisal, blob) | 16x24 | 47 tiles | 20 quadrant pieces (taller sheet) |
| P1 | Termite mound | 16x32 | 2 variants | grids |
| P1 | Three-stone fire | 16x16 | 6 | grid frames; emissive |
| P2 | Fence posts and wire | 16x16 | 16 tiles | composed |
| P2 | Kerosene-type lamp (hanging, standing) | 8x12 | 2 (flicker) | grids; emissive |

### 4.4 OSI-tier devices

| Pri | Asset | Size | Frames | Source |
|---|---|---|---|---|
| P0 | Soil tension probe (cream, teal LED) | 16x16 | 2 (LED) + 1 cutaway inspect overlay 16x32 | grids |
| P0 | Valve box with lever on pipe | 16x16 | 3 (lever swing) + open/closed | grids |
| P0 | Gateway on pole with solar panel | 16x48 | 2 (LED) | grid |
| P0 | Pipe segments | 16x16 | 6 (straight, bend, tee, cap) | grids |
| P1 | Drip line segments and emitters | 16x16 | 6 tiles + 3-frame drip particle | grids |
| P1 | Buried sensor with logger box | 16x16 | 2 | grid |
| P2 | Rain gauge | 8x16 | 1 | grid |

### 4.5 Characters and animals

| Pri | Asset | Cell | Frames | Source |
|---|---|---|---|---|
| P0 | Player body (paper-doll base, 4 skin ramps by remap) | 24x32 | idle 2, walk 4, hoe 5, watering can 4, jerrycan pour 4, harvest 4, plant 3, carry on head walk 4, open valve 3, phone 2 = 35 per direction x 3 authored directions = 105 (side mirrored) | grids, frame patches |
| P0 | Player clothing layers (2 outfits, pattern-flagged) and 2 headwear | 24x32 | follows body frames | grids + pattern atlas |
| P0 | Held tools layer (hoe, can, jerrycan, sickle, phone) | 24x32 | follows action frames | grids |
| P1 | NPC 1: neighbour elder who keeps goats (fictional) | 24x32 | idle 2, walk 4, talk 2 = 8 per direction x 3 = 24 | shared body + own clothing |
| P1 | NPC 2: agro-dealer shopkeeper (fictional) | 24x32 | 24 | same |
| P1 | NPC 3: young technician who installs sensors (fictional) | 24x32 | 24 | same |
| P1 | Dialogue portraits, 3 NPCs + player | 48x48 | 4 expressions each (16) | grids |
| P1 | Goat | 24x16 | walk 4, graze 3, idle 2 per direction x 3 = 27 | grids |
| P1 | Chicken | 12x12 | walk 4, peck 3 per direction x 3 = 21 | grids |

### 4.6 Items and icons (16x16, full ink outline, 1 frame each)

| Pri | Items |
|---|---|
| P0 | hoe, watering can, jerrycan, sickle, maize seed packet, tomato seed packet, maize cob, tomato, phone, probe kit, valve kit, coin (fictional currency mark, no real currency symbol) |
| P1 | bucket, drip line roll, pipe kit, energy food (porridge bowl), water (cup) |

### 4.7 UI

| Pri | Asset | Size | Frames |
|---|---|---|---|
| P0 | Signboard panel 9-slice (cream `c`, ink border, 1 px corner cut) | 24x24 source | 1 |
| P0 | Header band with generated cloth strip | 8x8 pattern tiles | 1 |
| P0 | Button (idle, hover, pressed) | 9-slice 16x12 | 3 |
| P0 | Inventory slot and selection | 20x20 | 2 |
| P0 | Energy bar (water drop end cap) | 9-slice 32x8 | 1 |
| P0 | Clock and weather widget (sun arc, season glyph, rain glyph) | 64x32 | sun dot moves by position, glyphs 6 |
| P0 | Phone bezel 9-slice | 96x176 source | 1 |
| P0 | Pixel font, 5x7 and 6x9 | per glyph | Latin-1 |
| P1 | Dialogue box with portrait frame | 9-slice from 16x16 source; box 320x64 logical px with a 52x52 portrait well | 1 |
| P1 | Cursor and tile highlight | 8x8, 16x16 | 3 and 2 |

### 4.8 Effects

| Pri | Asset | Size | Frames |
|---|---|---|---|
| P0 | Water splash | 6x4 | 4 |
| P0 | Water arc droplet | 1x1, 1x2 | 1 |
| P0 | Wet sheen sparkle | 3x3 | 3 |
| P1 | Rain streaks | 1x3, 1x4 | 3 variants |
| P1 | Rain splash on soil | 3x2 | 4 |
| P1 | Dust puff and drift | 2x2, 6x4 | 4 |
| P1 | Smoke | 8x8 | 6 |
| P2 | Dust devil | 16x32 | 8 (generated) |
| P2 | Fireflies | 1x1 | emissive blink |

Rough authoring load for P0: 60 quadrant pieces (8x8) for the three P0 autotile sets, about 25 hand grids for crops, structures and devices (16x16 to 64x64); about 105 character frames, most of them small patches on a base frame; 12 icons; 8 UI pieces.

## 5. Example sprite definitions

These grids are copied from `check.mjs`, which validates that each is 16x16 and uses only palette keys, then renders `sheet.png`. Key reference in 1.4.

### 5.1 Tilled laterite, dry (terrain tile)

Ridges run left to right with a 4-row period (`A` ridge top catches light, `B` ridge face, `C` furrow side, `D` furrow bottom), so the tile repeats without a visible seam and also survives the dual grid's half-tile offset (4 divides 8). Four ridges per 1 m tile is denser than real furrows; it is stylised for legibility. A 3x3 tiling check is in `tiling.png` next to `sheet.png`. The wet version is not a second grid: the soil shader shifts each pixel two steps down the soil ramp (`A>C`, `B>D`, `C>E`, `D>E`) and sprinkles `X` sheen on ridge tops.

```ts
export const soilTilledDry = sprite({
  id: 'terrain.soil.tilled.dry', size: [16, 16],
  height: {keys: {A: 3, B: 2, C: 1, D: 0}},
  flags: {wetCapable: true, sheenKeys: 'A'},
  rows: [
    "AAABAAAAAAAABAAA",
    "BBBBBBABBBBBBBBB",
    "CCCCCCCCCCCCCCCC",
    "DCDDDDCDDDDDCDDD",
    "AAAAAAABAAAAAAAB",
    "BBBABBBBBBBBABBB",
    "CCCCCCCCCCCCCCCC",
    "DDDCDDDDDCDDDDDD",
    "ABAAAAAAAABAAAAA",
    "BBBBBBBBBABBBBBB",
    "CCCCCCCCCCCCCCCC",
    "DDDDCDDDDDDDCDDD",
    "AAAAABAAAAAAAABA",
    "BBBBBBBBBBBBBBBB",
    "CCCCCCCCCCCCCCCC",
    "DCDDDDDDCDDDDDCD",
  ],
});
```

### 5.2 Crack overlay (very dry band)

Drawn over any soil tile when the moisture band is "very dry". In production this comes from the Voronoi crack generator; this hand grid shows the format with transparency.

```ts
export const soilCracksA = sprite({
  id: 'terrain.soil.overlay.cracks.a', size: [16, 16],
  rows: [
    "......E.........",
    "......E.........",
    ".....EA.........",
    "....E...........",
    "...EEA....E.....",
    "..E...EE..E.....",
    ".E......EEA.....",
    "E.........E.....",
    "..........EE....",
    "............EE..",
    "..........E...EE",
    ".........EA.....",
    "........E.......",
    "........E.......",
    ".......EA.......",
    "......E.........",
  ],
});
```

### 5.3 Maize, growth stage 2: turgid and leaf rolling, with derived stress states

```ts
export const maizeS2Turgid = sprite({
  id: 'crop.maize.s2.turgid', size: [16, 16], anchor: [8, 13],
  height: {mode: 'bevel', max: 5}, sway: {mode: 'rows', weight: 1},
  rows: [
    "................",
    ".......LM.......",
    ".......LN.......",
    "..LL...MN...MM..",
    ".L..MM.MN.NN..n.",
    "L.....MMNN.....n",
    "......LMNN......",
    "...LMM.MN.NNn...",
    "..L....MN....n..",
    ".L....LMNN....n.",
    "......MMNn......",
    ".......MN.......",
    ".......MN.......",
    "......NMNn......",
    "................",
    "................",
  ],
});

export const maizeS2Rolling = sprite({
  id: 'crop.maize.s2.rolling', size: [16, 16], anchor: [8, 13],
  height: {mode: 'bevel', max: 5}, sway: {mode: 'rows', weight: 0.6},
  rows: [
    "................",
    ".......ON.......",
    ".......ON.......",
    "....O..ON..N....",
    "....O..ON..N....",
    ".....O.ON.N.....",
    ".....OOONNN.....",
    "....O..ON..n....",
    "...O...ON...n...",
    "......OONN......",
    "......OONn......",
    ".......ON.......",
    ".......ON.......",
    "......NONn......",
    "................",
    "................",
  ],
});

// Stage 2 (greyish) is a remap of the rolled shape:
export const maizeS2Greyish = derive(maizeS2Rolling, {
  id: 'crop.maize.s2.greyish', remap: {O: 'P', N: 'P', n: 'Q'}, sway: {mode: 'rows', weight: 0.3},
});
// Stage 3 (wilted) gets its own drooped grid; stage 4 (dead) is a remap of it to I H G.
```

### 5.4 Jerrycan (inventory icon, full ink outline)

```ts
export const iconJerrycan = sprite({
  id: 'item.jerrycan', size: [16, 16], kind: 'icon',
  rows: [
    "................",
    "....KKK.KKKK....",
    "...KrrrKKYYoK...",
    "...KKKKKYKKoK...",
    "..KFYYYYYYYYoK..",
    "..KYFYYYYYYYoK..",
    "..KYYYYYYYYYoK..",
    "..KYYoooooYYoK..",
    "..KYYoYYYoYYoK..",
    "..KYYoYYYoYYoK..",
    "..KYYoooooYYoK..",
    "..KYYYYYYYYYoK..",
    "..KYYYYYYYYorK..",
    "..KoooooooorrK..",
    "...KKKKKKKKKK...",
    "................",
  ],
});
```

### 5.5 Soil tension probe (world sprite, emissive LED)

The `g` pixel at row 5 is flagged emissive; a 2-frame clip swaps it to `F` when the simulator records an uplink.

```ts
export const probe = sprite({
  id: 'device.soil_probe', size: [16, 16], anchor: [7, 14],
  flagRows: {emissive: [[6, 5]]},
  frames: [
    {base: 'self'},
    {base: 'self', patch: {x: 6, y: 5, rows: ["F"]}},
  ],
  rows: [
    "................",
    ".......K........",
    ".......K........",
    ".....KKKKK......",
    "....KccccTK.....",
    "....KcgccTK.....",
    "....KccccTK.....",
    "....KTTTTRK.....",
    ".....KKKKK......",
    "......KRK.......",
    "......KTK.......",
    "......KRK.......",
    "......KTK.......",
    "....CCKRKCC.....",
    "...CBBDDDBBC....",
    "....CCCCCCC.....",
  ],
});
```

What the render (`sheet.png`) shows, left to right: dry tilled soil, crack overlay, maize turgid, maize rolling, jerrycan, probe, then derived states: wet tilled soil (ramp shift), maize greyish (remap), maize rolled shape in straw colours (remap preview), dry soil with cracks composited. At 8x the furrows, the stress progression and the jerrycan read clearly; the turgid maize leaves are 1 px lines and look thin, so the production maize grids should use 2 px leaf blades from stage 3 on.

## 6. Risks

- **Generic look from generators.** Procedural trees and terrain drift toward a bland, samey look. Mitigation: hero assets are hand grids; generators only vary hand-made bases.
- **Lighting can muddy pixel art.** Smooth per-pixel lighting and blur destroy crisp clusters. Mitigation: ramp-step lighting, dithered penumbras, bloom limited to emissive pixels, and the optional re-quantisation toggle.
- **Moisture visuals read as OSI advice.** If the player learns "dark soil = do not irrigate" from game visuals and then sees the phone disagree, the teaching backfires. Mitigation: game soil model drives both the visuals and the simulated sensors from one state, and the band table is tuned against the simulator's own readings once the soil model exists.
- **No world-event hook yet.** Device animations (LED on uplink, valve lever) need a read-only event message from the simulator runtime that `demo/protocol.ts` does not have today (2.0).
- **Simulator readings are synthetic today.** `ReadingLedger.sampleValues` (`demo/model/readings.ts`) returns sine curves around fixed seeds; the world's wet and dry tiles will not match the phone until readings come from the game's soil model. This is a dependency for the irrigation art to make sense, not an art problem.
- **Cultural representation.** An East-African-inspired setting drawn by a non-local pipeline risks caricature. Mitigation: no exaggerated facial features, a spread of skin ramps, generated abstract cloth patterns, everyday modern objects (phones, solar panels, jerrycans) alongside traditional ones; a review by people from the region before release.
- **Low-end Android devices.** WebGL2 coverage is high in survey data but performance on cheap phones is unknown; the Canvas2D fallback loses the lighting that carries much of the mood.
- **Authoring volume.** About 105 player frames and 72 NPC frames are a lot of string grids; frame patches and a shared body base are essential. A small in-browser grid editor (paint with palette keys, export the TS module) would pay for itself early.
- **Phone overlay seams.** The DOM phone sits outside the canvas pipeline; at non-matching device-pixel ratios the bezel can blur. Mitigation: bezel drawn at the same integer scale and positioned on whole device pixels.

## 7. Open questions for the owner

1. Renderer: a small custom WebGL2 renderer (full control over the G-buffer and ramp-step lighting) or a library such as PixiJS with custom filters (adds a dependency to a public repo)?
2. Device floor: which phone or browser class must run the full look, and is a Canvas2D fallback without dynamic light acceptable below it?
3. Second crop: tomato (irrigated cash crop, good for drip) or another crop from `crop-kc.json` such as cabbage or onion?
4. Should graded output be re-quantised to the palette (strict pixel-art look) or left free (smoother fades)? Best decided by eye in the slice.
5. Who reviews cultural representation (characters, cloth, buildings) before public release?

## 8. Sources

- Civil twilight near the equator: [timeanddate.com](https://www.timeanddate.com/astronomy/civil-twilight.html), [University of Alaska Geophysical Institute](https://www.gi.alaska.edu/alaska-science-forum/twilight-zone)
- East African rain seasons: [Nature Reviews Earth & Environment, doi 10.1038/s43017-023-00397-x](https://doi.org/10.1038/s43017-023-00397-x), [Eos, short rains and long rains](https://eos.org/editors-vox/short-rains-and-long-rains)
- Soil water tension bands: [Alabama Extension ANR-2774](https://www.aces.edu/blog/topics/crop-production/irrigation-scheduling-using-soil-water-tension-sensors/), [UNH Extension fact sheet](https://extension.unh.edu/resource/soil-moisture-sensors-fact-sheet), [Agriculture Victoria](https://agriculture.vic.gov.au/farm-management/water/irrigation/irrigation-factsheets-and-resources/Using-tension-based-soil-moisture-monitoring-tools.pdf), [MSU irrigation principles](https://www.canr.msu.edu/irrigation/upoads/files/N-extension-Principles-and-Operational-Characteristics.pdf)
- Soil colour depends on moisture: [Wikipedia: Soil color](https://www.wikipedia.org/wiki/Soil_color), [Purdue soil judging manual, colour](https://www.agry.purdue.edu/soils_judging/new_manual/Ch2-color.html)
- Maize drought stress progression: [Purdue Extension, corn response to drought](https://agry.purdue.edu/ext/corn/news/timeless/CornRespDrought.html), [Leaf rolling in maize, PMC5920318](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5920318/)
- Blob autotiling: [cr31 blob tileset (boristhebrave mirror)](https://www.boristhebrave.com/permanent/24/06/cr31/stagecast/wang/blob.html), [Red Blob Games autotile notes](https://www.redblobgames.com/articles/autotile/claude/), [Blobsmith](https://godotengine.org/asset-library/asset/5343)
- Normal maps for pixel art: [arXiv 2212.09692](https://arxiv.org/abs/2212.09692), [ziva.sh normal map notes](https://ziva.sh/tools/normal-map-generator)
- WebGL2 availability: [web3dsurvey.com](https://web3dsurvey.com/webgl2), [web-features explorer](https://web-platform-dx.github.io/web-features-explorer/features/webgl2)
