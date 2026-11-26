# Farm-sim: browser technology and engine architecture

Research date: 2026-11-23. Worktree head: `4682fb17b1` (PR #658 branch). Scope: renderer and engine choice, sim/render split, how the game coexists with the OSI OS simulator iframe, PWA delivery, asset pipeline and performance budgets.

Evidence labels: **[measured]** means I ran it here; the command or script is named. **[source]** means I read it in the repo or in an installed package. **[web]** means it comes from a URL listed in Sources. **[assumption]** means an unmeasured estimate. **[target]** marks a budget, which is a goal and has not been measured.

All scratch scripts are in `<scratch>/` (`simbench*.ts|mts`, `simprof2.mts`, `smoke-run.mjs`, `heap-run.mjs`, `closure.mjs`, `bundle/src/*.js`). No repo file was changed, and `git status --porcelain` is clean.

---

## 1. Findings that shape the architecture

1. **The OSI simulator model has no DOM dependency and is cheap to import.** [measured] `demo/model.ts` bundles with esbuild (`--platform=neutral`) from 43 inputs and pulls in no npm packages. The bundle is 688 KB raw and 115 KB gzip. Most of it is `demo/journal-catalog.json` (322 KB) and `src/agronomy/crop-kc.json` (151 KB). The existing port tests already run the model under `node:test`/tsx (`demo/tests/*.test.ts`). The game can therefore own a `Simulator` instance inside its headless sim core.
2. **Simulator time advance is the dominant CPU risk today.** [measured, `simbench2.ts`, Node 22.23.1, desktop x86]
   - `new Simulator({mode:'public'})` takes about 1.1 s.
   - Each 30-minute "report" event costs about 52 ms, a single long task. The cost scales with sim time, not with step size: 30 sim-days took 76 s whether advanced in 1-minute steps, 1-hour steps or one jump. That is about 2.5 s of CPU per sim-day.
   - Profile (`--cpu-prof`, then `simprof2.mts` after construction): the hot spot is `localCalendarDayStart` in `demo/model.ts:70-78`. It builds a new `Intl.DateTimeFormat` and walks up to 48 h minute by minute through `formatToParts` to find local midnight.
   - An external formatter cache plus a `formatToParts` memo (`simbench3.mts CACHE=1`) was only a partial fix. Construction fell to 411 ms and per-report p99 to about 25 ms, but max rose to 166 ms, because the scan loop itself stays.
   - **Post-fix measurement** [measured, `simbench4.mjs` + `fmtcache.mjs`]. I took an unminified esbuild copy of `demo/model.ts` (`model-unmin.mjs`), memoised `localCalendarDayStart` per `(localDate, timezone)` in that copy only (`model-fixed.mjs`), then added a formatter-instance cache (one `Intl.DateTimeFormat` per locale+options, no result memo) to cover the second hotspot. That hotspot is a new formatter built on every call in `localCalendarDate` (`demo/model.ts:63`) and in `dateParts` in `demo/model/aggregation.ts`, seen in `simprof3.mjs`.

     | Variant | ctor | 3 days in 1-min steps | per-step p99 | max | steps > 16 ms | 30-day jump | 8 h skip |
     |---|---:|---:|---:|---:|---:|---:|---:|
     | Today (`model-unmin.mjs`) | 1,071 ms | 8,352 ms | 52.5 ms | 57 ms | 147 | 74,455 ms | 849 ms |
     | Memo only | 975 ms | 1,232 ms | 2.5 ms | 38 ms | 4 | 3,256 ms | 27 ms |
     | Memo + formatter cache | **301 ms** | **171 ms** | **0.62 ms** | **11.9 ms** | **0** | **817 ms** | **6 ms** |

   - **Fix (upstream, small):** memoise `localCalendarDayStart`, and keep one cached `Intl.DateTimeFormat` per zone in `localCalendarDate` and `aggregation.ts` `dateParts`. With both changes the simulator fits the main-thread budget on desktop. On a phone that is 4-6x slower [assumption; Lighthouse uses 4x as its mobile CPU proxy [web: L1]], that means a worst step of about 50-70 ms once per sim-day, which can be hidden behind the day transition. Without the fix, each of the 48 daily reports would freeze a frame for about 200-300 ms on such a phone.
   - `SimulationClock.advanceTo` (`model/clock.ts:52-67`) runs each callback atomically, so time-slicing can only happen between events and cannot hide a 52 ms event. **The fix is a prerequisite.** Do not try to engineer around it with Workers.
3. **Readings are synthetic, with no hook for external values.** [source] `ReadingLedger.sampleValues` (`demo/model/readings.ts:232`) takes values from `deviceValues(device, at)` (sine curves), offset only by an internal `soilResponse` that irrigation raises (`applySoilResponse`, capped at 18). The 90-day seed (`readings.ts:158-172`) is synthetic too. `append()` is public, but scheduled reports call `sampleValues`, so a game-side soil-water model cannot drive what OSI "measures".
   - Without an injection seam, OSI advice would be computed on curves unrelated to the player's field. That breaks the honesty goal in substance even though the code path is real.
   - The fix is an upstream `readingSource(device, at) => ReadingValues` option, defaulting to today's behaviour. The game passes its soil-water state, quantised to sensor resolution.
   - The ledger, including the seed history, must be inside the snapshot scope (finding 4).
   - `aggregate()` and `between()` filter the whole per-device array (`readings.ts:220-223`, `283-285`), so cost grows with history length. Watch this on long saves.
4. **The simulator has no snapshot/restore API.** [source] Clock events are closures (`ClockEvent.callback`), so the state cannot be serialised as it is. Save/load needs an upstream `Simulator.snapshot(): JsonValue` / `Simulator.restore(snapshot)` that re-schedules events from descriptors. Replaying the whole log from day 0 costs O(days) of the advance cost above, which is unacceptable at day 60 on a phone. This is the second prerequisite.
5. **The phone iframe works by patching globals in its own realm.** [source, `demo/runtime.ts`] It replaces `window.Date` with a proxy that reads `sim.now`, and replaces `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` and `geolocation`. It then sets the axios adapter to `createDemoAdapter(sim, …)`, whose request path is synchronous: `sim.requestResponse(...)` at `adapter.ts:64`. It also runs its own `setInterval(tick, 100)` that advances the sim by wall time. Keeping that app in an iframe is therefore required, not optional: the patches must not leak into the game realm. <!-- slop-allow: "realm" is the ECMAScript term for a JS global environment -->
6. **Model code does not read the wall clock on the paths it uses.** [source] The only `Date.now()` and `new Date()` defaults (`model/triggers.ts:74`, `model/preferences.ts:31`) are always given an explicit `at`/`iso(this.now)` by their callers (`triggers.ts:184`, `model.ts:271`). A `Simulator` living in the game realm, with no Date proxy, stays deterministic. `Math.random` is not used in `model.ts` or `model/`. <!-- slop-allow: "realm" is the ECMAScript term for a JS global environment -->
7. **A shared simulator across realms needs a structured-clone bridge.** [source] `model.ts:667,672` checks request bodies with `instanceof FormData/Blob/ArrayBuffer`, and `adapter.ts:66` checks `instanceof DemoError`. Both fail across realms: an iframe Blob is not a game-realm Blob. The game-mode phone entry should call a narrow synchronous bridge, `parent.__osiFarmBridge.request(method, path, body)`. Cloning has to happen on the **receiving** side, because `structuredClone` returns objects in the realm of whoever calls it. The bridge (game realm) clones the incoming body before handing it to the `Simulator`. The iframe facade clones the returned response before giving it to axios. That way no live object crosses realms. FormData is not structured-cloneable, so that route has to be serialised first or left unsupported in game mode. <!-- slop-allow: "realm" is the ECMAScript term for a JS global environment -->
8. **Same-origin iframes share the game's main thread.** [web: W1, W2] The HTML spec allows one event loop per unit of similar-origin browsing contexts, and Chromium keeps same-origin frames in one renderer process. Every React render, SWR revalidation, MutationObserver callback and the 100 ms tick in the phone iframe therefore runs on the game's main thread and costs frame time.
   - Chrome's render throttling for `display:none` or off-screen frames was historically limited to cross-origin frames. [web: W3, W4] The sources are dated 2016-2023 and I did not verify current behaviour, so it is **unverified for same-origin frames** and the design must not rely on it.
   - `Origin-Agent-Cluster` could move the phone to another agent, but that would break the synchronous bridge. Rejected.
9. **The phone app is heavy relative to the game.** [measured, `vite build --config vite.demo.config.ts --mode public --outDir <scratchpad>/pubdemo`, `heap-run.mjs`]
   - Public build: 4.2 MB on disk, 21 files. JS+CSS+HTML total 4.10 MB raw, 1.14 MB gzip, 881 KB brotli. The largest chunks are `mount` (1.50 MB raw), `i18n` (1.12 MB raw, all locales) and `EChart` (491 KB raw).
   - In headless Chromium at 402×844: time to the first dashboard selector was 1.7 s at 1x CPU and 8.7 s under 6x CDP CPU throttle. JS heap after GC was 20.9 MB against 0.9 MB for a blank page, with 431 DOM nodes. There were 0 long tasks in 10 s idle at speed 1.
   - Conclusion: load it lazily, never on the critical path, and pre-warm it during an in-game "phone boots" moment.
10. **PixiJS defaults to WebGL.** [source] `pixi.js@8.23.0` `lib/rendering/renderers/autoDetectRenderer.mjs` has `renderPriority = ["webgl", "webgpu", "canvas"]`. The headless smoke test with `preference:'webgpu'` fell back cleanly to WebGL2 [measured]. Pixi 8.23 also ships `lib/environment-webworker/WebWorkerAdapter.mjs` for OffscreenCanvas rendering in a Worker [source].
11. **@pixi/tilemap works with Pixi 8.23.** [measured, `smoke-run.mjs`, headless Chromium 1243, SwiftShader WebGL2] `@pixi/tilemap@5.0.2` was last published 2025-07-14, with peer `pixi.js >=8.5.0`. It rendered 64 chunks of 32×32 tiles (65,536 tiles) plus 3,000 y-sorted sprites (`sortableChildren`, `zIndex = y`) with 0 console errors at a 60 fps vsync cap. The SwiftShader timing is not representative of a GPU; the result only proves correctness. Screenshot: `bundle/out/smoke-webgl.png`.
12. **Compressed bundle size, minimal app per engine.** [measured, esbuild 0.28.2 `--bundle --minify`, ES2022, Node brotli default quality, script `closure.mjs`] Method: Pixi is built with `--splitting`, and I counted the static-import closure of entry + WebGL renderer + `browserAll`. Both renderer paths are linked statically in that closure. Phaser is one monolith.

    | Engine (version) | raw | gzip | brotli |
    |---|---:|---:|---:|
    | pixi.js 8.23.0 (Sprite, Text, Graphics, Container) | 584 KB | 171 KB | **141 KB** |
    | pixi.js + @pixi/tilemap 5.0.2 + ColorMatrixFilter | 613 KB | 180 KB | 147 KB |
    | phaser 4.2.1 (Game + text) | 1,395 KB | 370 KB | **297 KB** |
    | excalibur 1.0.1 (Engine + Actor) | 582 KB | 152 KB | 124 KB |
    | kaplay 3001.0.19 (rect) | 188 KB | 70 KB | 60 KB |
    | three 0.187.0 (WebGLRenderer + ortho + plane) | 532 KB | 132 KB | 110 KB |

13. **TypeScript 7.0.2 rejects code that 5.9.3 accepts.** [measured] TS 7.0.2 is npm `latest`. Running `tsc -p web/react-gui/demo/tsconfig.json --noEmit` with 7.0.2 reported 2 errors (TS7053 in `src/components/history/visualizations/DendroGrowthTimelineView.tsx:179` and `DendroLineChartView.tsx:129`); 5.9.3 reported none. TS 7 took 1.9 s against 15 s for 5.9. A farm-sim that typechecks react-gui sources must pin **5.9.3** until react-gui migrates.
14. **WebGL2 is almost universal; WebGPU is not.** [web: G1, G2]
    - web3dsurvey: WebGL2 at 97.78% overall and 99% on Android; WebGPU at 83.23% overall and 71% on Android.
    - `MAX_TEXTURE_SIZE` on Android: ≥4096 on 100% of devices, ≥8191 on 81%. Atlas pages must stay at **2048 or 4096**.
    - Chrome enabled WebGPU on Android only from Chrome 121, and only for Android 12+ with Qualcomm/ARM GPUs [web: G3].
15. **The edge helper modules are CommonJS and use transcendental math.** [source] `osi-agronomy-daily/et0.js` has 19 `Math.exp/pow/sin/cos/acos/tan/log` call sites. ECMA-262 lets those functions be implementation-approximated [web: E1]. Results therefore match within V8 (Chrome and Node), but can differ in the last ULP in Firefox or Safari. This matters for cross-browser replay hashes; see §4.4.

---

## 2. Engine comparison

| Criterion | **PixiJS 8.23** | **Phaser 4.2.1** | Excalibur 1.0.1 | Kaplay 3001.0.19 | Custom WebGL2/WebGPU | Three.js 0.187 ortho |
|---|---|---|---|---|---|---|
| Role | Renderer plus scene graph; you own the loop | Full framework: scenes, loader, input, audio, tween, tilemap | Full engine with built-in ECS | Small fun-first framework | Everything is yours | 3D engine used in 2D |
| Pixel-perfect integer scaling | `TextureSource.defaultOptions.scaleMode='nearest'`, `roundPixels`, render to a low-res `RenderTexture`, then nearest upscale [source + smoke] | `pixelArt:true`; `roundPixels` now defaults to false; `smoothPixelArt` option [web: P1] | `pixelArt` engine option [source: `excalibur/build/esm/src/engine/engine.d.ts`] | Not checked [assumption: less control] | Full | Needs manual texel snapping and ortho camera math |
| Large tilemaps | `@pixi/tilemap` chunked meshes, verified with 65k tiles [measured]; or your own chunk meshes | `TilemapGPULayer`: one quad, data texture, ≤4096×4096 tiles, one tileset, ortho only [source: `phaser/types/phaser.d.ts:139515-139526`] | Has a TileMap [assumption, not verified] | Not verified [assumption: weak] | Best possible | InstancedMesh per chunk |
| Thousands of y-sorted sprites | `sortableChildren` + zIndex, batched; `ParticleContainer` for particles (claimed >3x v7) [web: X2] | `SpriteGPULayer` (GPU buffer, segment updates) [source: d.ts:68206-68242]; depth sort | Not measured | Not measured [assumption: per-object component overhead] | Best | Manual sort |
| Custom shaders, filters, post | `Filter` with GLSL (and WGSL for WebGPU), RenderTexture chains, `pixi-filters@6.1.5` | Node-based renderer; large filter set (ImageLight, GradientMap, Quantize, Mask, Blend); built-in lighting with normal maps; WebGL only [web: P1, P2] | Not verified [assumption: more limited] | Not verified [assumption: limited] | Full | Full (ShaderMaterial, EffectComposer) |
| WebGPU | Yes, opt-in; default order is webgl, webgpu, canvas [source] | No (WebGL/WebGL2 only) [web: P1] | No | No | Optional | WebGPURenderer exists |
| UI text | BitmapText, Text, HTMLText; DOM overlay root via `app.domContainerRoot` [web: X1] | BitmapText, Text, DOM element | Text/Label | Text | DIY | troika (extra) |
| Bundle brotli [measured] | **141 KB** | 297 KB | 124 KB | 60 KB | ~30-60 KB [assumption] | 110 KB + 2D helpers |
| Headless sim / determinism | No game loop forced on you, so the sim core stays engine-free | Owns the step loop; fixed-step and sim separation need extra discipline | Owns the loop [assumption] | Owns the loop [assumption] | Full | Neutral |
| Worker rendering | `WebWorkerAdapter` shipped [source] | Not a primary path | No | No | Yes | Yes (OffscreenCanvas) |
| Risk | Low; active monthly releases [web: X1] | Low-medium; v4 GA April 2026 [web: P3] | Medium (new 1.0) | High for this scope | High schedule risk | Medium; wrong tool for 2D |

**Verdict.** PixiJS 8 is the best fit, with Phaser 4 as the strong runner-up.

Pixi wins on four counts:
1. It is a renderer rather than a framework, which matches a pure-TS deterministic core with a thin view.
2. Its bundle is half the size of Phaser's, which matters for LMIC bandwidth.
3. It gives full control of the low-res render-texture pipeline where the lighting and grading look comes from.
4. It is the only mature option with WebGPU and Worker paths for later.

Phaser 4 would be the better pick if the team wants built-in normal-map lighting and `TilemapGPULayer` without writing shaders, and accepts about 150 KB more and an engine-owned loop. Excalibur and Kaplay are not justified for this scale. Writing a custom renderer is not worth the months it costs: text, batching, context loss and filters already exist in Pixi. Three.js only makes sense if the art direction moves to true 3D lighting.

---

## 3. Rendering pipeline for pixel-art quality on low-end GPUs

The key decision: **render the world at native pixel-art resolution into a RenderTexture, do all post-processing at that resolution, then do one nearest-neighbour integer upscale to the canvas.**

At a 480×270 logical size that is 129,600 pixels per full-screen pass, about 1/16 of a 1080p pass. Five post passes then cost less than one native-resolution pass, so the "expensive" effects become affordable on Mali-G52 or Adreno 610 class GPUs [assumption: GPU class examples; fill-rate scaling is arithmetic].

- **Logical viewport:** 16 px tiles. Compute `scale = floor(min(deviceW/minW, deviceH/minH))` in device pixels (CSS px × devicePixelRatio). Then widen the logical width to fill the screen rather than letterbox: roughly 400-560 × 225-300 logical px. Camera position is quantised to whole logical pixels, and sub-pixel motion lives only in the sim.
- **Passes, all at logical resolution:**
  1. **World albedo.** Static chunk meshes for ground layers, ≤ 1 draw call per visible chunk. Actors, crops and props go in one y-sorted container, so batches break only on texture page changes: keep everything on ≤ 2 atlas pages.
  2. **Normal/height buffer** (Quality "high" only). The same scene drawn with the normal-atlas page. Normals come from the bake step (§6), not from hand painting.
  3. **Light buffer.** Additive light sprites (radial falloff, palette-quantised) for lamps, fireflies and windows. On "high", N·L with the normal buffer gives a rim/self-shadow look.
  4. **Composite shader**, one pass: `albedo × (ambient(timeOfDay) + lights)` → **day/night LUT** (two 32³ LUTs stored as 1024×32 strips, lerped by sun phase) → **heat haze** (noise UV offset, masked by a "hot hours" uniform and a distance band) → **water reflection** (water mask from the palette index; sample albedo mirrored above the waterline with a ripple offset). Rain and dust are not in this pass; they are particles.
  5. **Upscale** with nearest sampling to the backbuffer. An optional 1-device-pixel scanline/vignette pass is the only effect run at device resolution, and it is off on the low tier.
- **Shadows:** baked blob shadows plus sun-angle skewed silhouette sprites (shear transform driven by time of day), drawn in a multiply layer before actors. Soft edges come from 2-3 dithered ramp steps in the palette, not blur.
- **Particles:** Pixi `ParticleContainer` with static properties disabled except position and alpha. Rain, dust, pollen and splashes are capped per quality tier (§8).
- **Wind sway:** a vertex-offset filter or mesh shader on the crop layer driven by one uniform, so crops sway at no CPU cost.
- **Renderer preference:** `['webgl']` in v1, so only GLSL is written. Evaluate `['webgpu','webgl']` behind a flag once field telemetry exists. Android WebGPU reach is 71% against 99% for WebGL2 [web: G1].
- **Context loss:** handle `webglcontextlost`/`restored` by rebuilding GPU resources from the baked atlas, which is cached in Cache Storage. This happens often on Android when the app is backgrounded.

---

## 4. Engine architecture

### 4.1 Layers

```
input adapters ─► Command queue ─► SIM CORE (pure TS, no DOM) ─► read-only view model ─► Pixi view + DOM UI
                                   │  fixed 20 Hz tick, seeded RNG
                                   ├─ farm: tile layers in typed arrays, crops, inventory, economy, NPC schedules
                                   ├─ soil-water model (interface to OSI readings)
                                   └─ OSI adapter ─► Simulator (react-gui/demo/model.ts) + vendored edge modules
phone iframe (lazy) ──sync bridge (structuredClone)──► same Simulator instance
```

- **Fixed timestep:** 20 Hz sim ticks with an accumulator. Clamp to at most 5 catch-up ticks per frame; drop excess time when the tab was hidden, and log it in the replay as a `pause` command. Render interpolates actor positions between ticks.
- **Game clock and the OSI clock:** the game owns time and calls `sim.advanceTo(gameEpochMs)` once per tick. The OSI simulator is event-driven, so steps with no due event cost about 0.007 ms p50 once the two Intl fixes are in (§1.2 table) [measured]. Sleeping or skipping time calls `advanceTo(morning)` once, which is cheap only after the `localCalendarDayStart` fix (§1.2).
- **State stores, no ECS library:** a farm sim has a few hundred live actors and a large grid.
  - Grid layers are struct-of-arrays per chunk (`Uint16Array` tile IDs, `Uint8Array` tilled/wet flags, `Float32Array` soil water, `Uint16Array` crop refs).
  - Entities are plain typed records in `Map<EntityId, T>` with explicit system functions.
  - This keeps snapshots trivial (typed arrays plus JSON). `bitecs@0.4.0` or `koota@0.6.6` are not needed. Revisit only if live entities exceed about 10k.
- **Determinism rules:**
  - No `Math.random`; one seeded PRNG (sfc32 or xoshiro128**, about 20 lines, in-repo) with named sub-streams per system, so adding a system does not shift other systems' random sequences.
  - No `Date.now` or `performance.now` inside the core; time is the tick counter.
  - Iterate `Map` in insertion order only, never over an object's numeric keys after deletes.
  - Sort with total comparators.
  - Quantise any transcendental-derived value that enters persistent state at the boundary, for example ET0 rounded to 0.01 mm. Replay hashes then stay valid across V8, SpiderMonkey and JavaScriptCore (§1.15).
- **Honesty boundary:** anything shown as "OSI recommendation" or "OSI automation" must come from calls into `Simulator` (its ported triggers, plans and irrigation) or from the vendored edge modules. Vendoring means a build step bundles the CommonJS files (`et0.js`, `osi-crop-kc`, `osi-matric-potential`, `osi-irrigation-policy/{evaluate,model,observations,occurrences}`, `osi-daily-scheduler/decision.js`) to ESM unchanged and records each source file's SHA-256. A test re-hashes the sources and fails on drift. The game UI layer cannot import anything under `osi/` except through `osi/adapter.ts`; an ESLint `no-restricted-imports` rule or a small verifier script enforces this.

### 4.2 Main thread or Web Worker

**Recommendation: keep the sim core, including the OSI `Simulator`, on the main thread. Use Workers only for off-path jobs.**

Reasons:
- The phone iframe needs synchronous access: the adapter calls `sim.requestResponse` inline, and the Date proxy reads `sim.now` synchronously. A Worker would turn every call into an async round trip and would force the Date proxy onto a mirrored clock.
- The renderer reads the view model every frame. Doing that from a Worker means per-frame snapshot transfer, or `SharedArrayBuffer`, which requires COOP/COEP cross-origin isolation on the host and the iframe.
- With both Intl fixes, a desktop step has p99 0.62 ms and max 11.9 ms, and an 8 h skip takes 6 ms (§1.2 table) [measured]. At an assumed 4-6x phone slowdown that is still within the §8.5 sim budget, apart from about one 50-70 ms step per sim-day, which the day transition hides.

Workers are for:
- Atlas bake when running in dev boot mode.
- Save compression and IndexedDB writes. `CompressionStream('gzip')` is native, so no library is needed.
- Replay verification and "what if" forecasting: running a second `Simulator` headless for a planning preview.
- Future escape hatch: Pixi's `WebWorkerAdapter` [source] can move *rendering* to an OffscreenCanvas Worker while sim and bridge stay on the main thread. Only do this if profiling shows render submission, not the sim, is the bottleneck.

### 4.3 Save and load (IndexedDB)

- `idb@8.0.4`, database `osi-farm-sim`, stores `saves` (slot → metadata), `snapshots` (slot+version → gzip blob), `replay` (slot → chunked command log), `bake` (art hash → atlas blobs).
- Record format: `{schema: n, game: semver, seed, tick, core: <typed arrays + JSON>, osi: <Simulator.snapshot()>, hash}`.
- Migrations: an ordered list of pure functions `vN → vN+1`, each with a frozen fixture save in `tests/fixtures/saves/` and a test that loads every historical fixture. This is the same discipline as the repo's migration ledger.
- Autosave at each in-game morning. The main thread takes the snapshot in a `requestIdleCallback` (Workers have none) and transfers the typed arrays to the Worker, which compresses and writes to IndexedDB.
- Use `navigator.storage.persist()` and show used/available space from `navigator.storage.estimate()` on the settings screen. Low-storage phones evict data.
- **Blocked on §1.4:** an upstream `Simulator.snapshot()/restore()` is required first.

### 4.4 Replay log

- Log commands, not raw input events: `{tick, cmd}` such as `till(x,y)`, `water(x,y,litres)`, `phone.request(method,path,body)`, `speed`, `pause`. Every 600 ticks, also log a state hash (FNV-1a over the core snapshot plus a digest of `sim` state).
- **Phone requests are part of the log.** Since the iframe talks to the sim through the bridge, the bridge records each mutating request. A replay re-issues them without the React app, which makes replays headless.
- Replays double as integration tests: a fixed seed plus a recorded session must reproduce the hash sequence in Node (`tsx`) and in Chromium.

### 4.5 Input

- Use one `InputMap` that turns device events into `Command`s per frame.
  - Keyboard: rebindable.
  - Mouse: click to move or act, wheel for the tool belt.
  - Touch: virtual stick plus tap-to-act on the target tile, long-press for context, two-finger pinch disabled because zoom is integer steps only.
  - Gamepad: Gamepad API polled once per frame.
- Pointer events only, with `touch-action: none` on the canvas.
- Tap targets in the DOM UI are at least 44 CSS px.

### 4.6 UI layer

- **Canvas** holds world-space text such as floating "+3" labels and tile hints. It uses `BitmapText` with a pixel font authored in code (glyph strings baked into the atlas) covering Latin Extended for en, de-CH, fr, it, es, pt and lg.
- **DOM overlay** holds menus, inventory, dialogue, shops, the OSI explanation panels and settings.
  - Why DOM: accessibility (real buttons, focus order, ARIA live regions for notices), text scaling, i18n line breaking, and screen readers.
  - Framework: Preact 11.2.0 with `@preact/signals@2.11.4`; Preact 11.0.0 was released 2026-09-30 [npm time]. React itself stays only inside the phone iframe.
  - Styling: pixel-art 9-slice frames applied with CSS `border-image` from atlas regions exported as data URLs at boot.
  - Font: the same code-authored pixel font, turned into a TTF at build time with `opentype.js@2.0.0` (a devDependency only) and served brotli-compressed. No third-party fonts, which keeps the originality constraint simple.
- **i18n:** `i18next` with per-locale JSON. Reuse locale codes from `demo/protocol.ts` (`DEMO_LANGUAGES`) so the game and the phone switch language together through the existing `language` message.

### 4.7 Audio

- Use raw WebAudio with no library; `howler@2.2.4` was last published 2023.
- **Procedural ambience** costs no bytes: wind (filtered noise with LFO cutoff), insects (AM oscillators gated by time and temperature), rain (noise bursts through a band-pass, density from the sim's rain), irrigation flow (pink noise gated by valve state from `Simulator`).
- **Music:** a small in-code step sequencer with authored patterns and synthesised instruments, which fits the "authored in code, original" rule and costs no download. Optionally add a few short Opus clips for signature stingers, with a `decodeAudioData` capability probe and an AAC fallback.
- Unlock the `AudioContext` on first user gesture. Suspend it on `visibilitychange`.

### 4.8 Coexisting with the phone iframe (PR #658 React app)

The phone is the real edge React app (React 18.3.1 and tailwind 4.1.18 installed, built with react-gui's Vite 5.4.21). Rules:

1. **Add a game-mode phone entry** (for example `web/react-gui/demo/game/app.html` + `game-runtime.ts`; new files, not edits to `runtime.ts`). It keeps all of `runtime.ts`'s boundary patches (fetch/XHR/WebSocket blocks, navigation guard, Date proxy). It does **not** construct its own `Simulator` and does **not** run `setInterval(tick, 100)`. It binds the axios adapter to a sim facade that proxies `requestResponse`, `now` and `nextEventDescriptor` through the structured-clone bridge to `parent.__osiFarmBridge`. Revalidation runs only when the game says so (`requestDemoRevalidation(['*'])` after a tick whose OSI clock revision changed, and only while the phone is visible).
2. **Lazy mount.** Do not create the iframe until the player first opens the phone, or until the story introduces the OSI tier. Pre-warm it during an in-game "phone is starting" animation, since boot takes 1.7 s at 1x and 8.7 s at 6x throttle [measured].
3. **While closed:** hide it with `visibility:hidden` + `inert`, stop revalidation, and keep it mounted on devices with `navigator.deviceMemory >= 4` (21 MB heap [measured]). Unmount it on `deviceMemory <= 2` or on a memory-pressure signal. The sim lives in the game window, so unmounting loses nothing.
4. **While open:** pause or slow the world render, for example by rendering the world only every other frame behind the phone and reusing the last frame as a blurred backdrop. The React app then gets main-thread headroom. The sim keeps ticking.
5. **Build:** the phone is built by react-gui's own Vite 5 config (a new mode, for example `--mode game`) into `web/react-gui/game-phone-build/`. farm-sim copies that output into `dist/phone/`. Mixing Vite 8 (farm-sim) and Vite 5 (phone) is safe because they are separate builds. farm-sim imports only plain TS/JSON from `react-gui/demo/model*`, which has no npm dependencies [measured].
6. **Build isolation:** `demo/check-build-isolation.mjs` keeps simulator markers out of the production edge build. The farm-sim and game-phone builds are new outputs; extend the check so the production build also rejects a `farm-sim` marker.

---

## 5. Offline PWA and bandwidth

- `vite-plugin-pwa@2.0.0` (peer `vite ^3…^8`, workbox 7.4.1) in `generateSW` mode.
  - Precache the game shell, engine, core, atlas pages and locale for the current language.
  - The phone bundle is a second precache group: it downloads in the background after first play on Wi-Fi or when `navigator.connection.saveData` is false. Otherwise it downloads on first phone open, with a progress UI.
- The phone's `i18n` chunk is 1.12 MB raw because it carries every locale [measured]. A game-mode phone build should split locales per language. This is the largest single bandwidth saving available.
- Add a manifest with `display: fullscreen`, `orientation: landscape` (with portrait fallback UI), and icons generated from the code-authored atlas.
- Network budget at Lighthouse Slow-4G (1,638.4 Kbps, 150 ms RTT [web: L1]): a 600 KB brotli critical path is about 3 s of transfer plus RTTs, which is the target.
- No CDN fonts, no analytics on the critical path, no runtime network calls; the phone's boundary already blocks them.

---

## 6. Asset pipeline for original pixel art authored in code

- **Source format** (`art/` TS modules, reviewed like code):
  - A master palette of about 48 colours in hue-shifted ramps (warm highlights, cool shadows), with named ramps such as `soilDry`, `soilWet`, `leaf`, `water` and `skin*`.
  - Sprites are palette-indexed row strings (`'..aab..'`) with an optional second layer: a height mask in the same grid for normal generation.
  - **Generators** are pure functions of `(seed, params)`:
    - Crop growth stages: leaf count, angle and stress tint come from the sim's water stress, so drought looks visibly different.
    - Blob-47 autotiles for soil/grass/water/path edges.
    - Ordered-dither noise for ground detail.
    - Furrow and irrigation-line variants.
    - NPC bodies from part palettes, so every character is original and composable.
    - Animation frames with squash/stretch.
- **Bake** (`scripts/bake-atlas.ts`, Node; no runtime dependencies; a minimal indexed-PNG encoder over `node:zlib`; the only build-time devDependency is `opentype.js` for the font):
  - Rasterise, pack into 2048² pages (`MAX_TEXTURE_SIZE ≥4096` on 100% of Android [web: G2]).
  - Generate normal maps by Sobel over the height mask, plus a distance-transform bevel when no mask is given.
  - Emit `atlas-<hash>.png`, `normals-<hash>.png`, `atlas.json`, `palette.png`, `lut-*.png` and the font.
  - The same code runs at dev boot in a Worker via OffscreenCanvas for hot reload.
- **Quality levers in code-authored art:** consistent light direction (top-left), 1-px selective outlines (darker ramp, not black), hue-shifted shading, sub-tile ground variation, secondary motion (wind sway, water shimmer through a palette-cycling uniform), and colour grading through the LUT. The palette keeps the look cohesive, and the LUT does most of the mood work.
- **Review:** CI renders a contact sheet of every sprite and tile set and compares it against committed PNG baselines (`toHaveScreenshot` with `maxDiffPixels: 0`; nearest sampling makes output exact). Art changes become visible image diffs in PRs.
- **Originality guard:** forbid importing any binary image under `art/`. A verifier fails if PNG, GIF or Aseprite files appear outside `dist/` or the screenshot baselines.

---

## 7. Testability and performance measurement in CI

- **Unit and property tests** on the core: Vitest 4.1.6, matching react-gui. A headless run of N sim-days with fixed seed checks the hash chain. Port tests reuse the `demo/tests` style.
- **Deterministic screenshots:** Playwright against `vite preview`. The ticker is stopped (`app.ticker.stop()`), state is loaded from a fixture save at a fixed tick, one frame is rendered, then the screenshot is taken. Chromium runs with `--use-angle=swiftshader --enable-unsafe-swiftshader`, which produced WebGL2 output in the smoke test [measured]. Pin the Playwright version and browser build; baselines are per platform.
- **Performance harness** (`tests/perf/*.spec.ts`, Chromium only):
  - CDP `Emulation.setCPUThrottlingRate` at 4 (mid proxy, the Lighthouse mobile default [web: L1]) and 6 (low-end proxy [assumption]).
  - A scripted replay drives 60 s of play.
  - In-page instrumentation: rAF delta ring buffer; `performance.now()` spans around `core.step`, `osi.advance`, `view.sync` and `renderer.render`; `PerformanceObserver({type:'longtask'})`.
  - A debug-build wrapper counts `drawElements`/`drawArrays*` calls per frame and texture bytes allocated.
  - `Performance.getMetrics` gives JS heap and DOM nodes, as in `heap-run.mjs`.
  - Optional `browser.startTracing()` captures traces as CI artefacts for regressions.
- **What CI can gate:** CPU-side metrics (JS ms per frame, sim ms per tick, draw calls, texture bytes, heap, bundle sizes) and visual diffs. GPU frame time under SwiftShader is meaningless, so **do not gate on FPS in CI**. GPU time is checked on a physical low-end Android board, manually or through Chrome remote debugging, before releases.
- **Bundle gate:** a script measures brotli sizes of the critical-path chunks from the Vite manifest and fails if a budget is exceeded. The method is the same as `closure.mjs`.

---

## 8. RECOMMENDATION

### 8.1 Prerequisites (upstream, in `web/react-gui/demo`, before game work depends on them)
1. Memoise `localCalendarDayStart` (`demo/model.ts:70-78`) per `(localDate, timezone)`. Cache one `Intl.DateTimeFormat` per zone and options in `localCalendarDate` (`demo/model.ts:63`) and in `dateParts` (`demo/model/aggregation.ts`). Add a port test that pins local-midnight results for DST and non-DST zones. Add a perf test: advancing 1 sim-day must take < 100 ms in Node. The measured equivalent is about 27 ms per day (817 ms for 30 days).
2. Add `Simulator.snapshot()` / `Simulator.restore()`, with clock events re-created from serialisable descriptors (id, atMs, kind, entity, generation), plus a round-trip test.
3. Add a game-mode phone entry (`demo/game/app.html`, `demo/game/game-runtime.ts`) and a `--mode game` path in `vite.demo.config.ts`, as in §4.8.
4. Add a reading-source seam to `ReadingLedger` (`demo/model/readings.ts:232`): an injectable `readingSource(device, at)` with the current sine model as default. The values OSI reports then come from the game's soil-water state (§1.3). Include ledger samples and `soilResponse` in the snapshot.

### 8.2 Stack and versions (verified with `npm view` on 2026-11-23)

| Purpose | Package | Version | Note |
|---|---|---|---|
| Renderer | `pixi.js` | **8.23.0** | `preference: ['webgl']` in v1; WebGPU behind a flag later |
| Tilemap | `@pixi/tilemap` | **5.0.2** | Smoke-tested against 8.23 [measured]; keep an own chunk-mesh fallback (`view/tilemap/`) in case it goes unmaintained |
| Extra filters (optional, cherry-pick) | `pixi-filters` | 6.1.5 | Most effects are custom GLSL in the composite pass |
| UI overlay | `preact` + `@preact/signals` | **11.2.0** + **2.11.4** | |
| i18n | `i18next` | 27.2.4 | react-gui uses 25.x; the phone keeps its own |
| Storage | `idb` | **8.0.4** | Compression via native `CompressionStream` |
| Build | `vite` | **8.3.8** | farm-sim only; the phone stays on react-gui's Vite 5.4.21 |
| PWA | `vite-plugin-pwa` (+ `workbox-window`) | **2.0.0** (7.4.1) | |
| Preact JSX | `@preact/preset-vite` | **2.10.6** | Peer covers vite 8 |
| Types | `typescript` | **5.9.3** (pin) | 7.0.2 is latest but fails 2 react-gui files [measured]; move with react-gui |
| Unit tests | `vitest` | **5.1.1** | 4.1.6 (react-gui's version) made npm 10.9.8 crash during resolution (`Cannot read properties of null (reading 'edgesOut')`) together with this stack; 5.1.1 resolved cleanly [measured] |
| Script runner | `tsx` | **4.20.6** (match repo) | |
| Font build | `opentype.js` | **2.0.0** | devDependency only |
| Browser tests | `@playwright/test` | **1.63.0** (match repo pin) | 1.65.1 is latest; bump repo-wide together |
| RNG | own `core/rng.ts` (sfc32) | — | No dependency |
| Audio | WebAudio | — | No dependency |
| Not used | phaser, excalibur, kaplay, three, howler, bitecs, comlink | — | See §2 |

Runtime: Node 22.12+ (`v22.23.1` installed), npm 10.9+.

### 8.3 Folder layout: `web/farm-sim/`

```
web/farm-sim/
  package.json            # private; scripts below
  tsconfig.json           # strict; path alias @osi-demo -> ../react-gui/demo
  vite.config.ts          # Vite 8, Preact preset, PWA plugin, copies phone build
  index.html
  src/
    main.ts               # boot: feature detect, quality tier, load atlas, start loop
    loop.ts               # rAF + fixed-step accumulator, interpolation alpha
    core/                 # PURE TS: no DOM, no Pixi, no Date.now, no Math.random
      rng.ts  tick.ts  commands.ts  hash.ts
      world/  (chunks.ts, tiles.ts, layers.ts)
      farm/   (crops.ts, soil-water.ts, tools.ts, inventory.ts, economy.ts)
      npc/    (schedules.ts, relationships.ts)
      osi/
        adapter.ts        # only door to OSI code; owns the Simulator instance
        bridge.ts         # structuredClone sync bridge for the phone iframe
        edge/             # generated ESM wrappers of edge CJS modules + SHA pins (build output, committed)
      save/   (schema.ts, migrations/, snapshot.ts)
      replay/ (log.ts, verify.ts)
    view/                 # Pixi only; reads core view model, never mutates core
      renderer.ts  camera.ts  tilemap/  actors.ts  particles.ts
      post/ (composite.frag, lut.ts, lights.ts, haze.ts, water.ts)
    ui/                   # Preact DOM overlay
      hud/  menus/  dialogue/  osi-panels/  phone-frame.tsx  i18n.ts
    input/ (keyboard.ts, pointer.ts, touch.ts, gamepad.ts, input-map.ts)
    audio/ (engine.ts, ambience.ts, sequencer.ts, patterns/)
    platform/ (idb.ts, storage-estimate.ts, quality-tier.ts, workers/)
  art/                    # code-authored pixel art: palette.ts, sprites/*.ts, generators/*.ts, font.ts
  locales/<lang>/*.json
  scripts/
    bake-atlas.ts         # art/ -> public/generated/atlas-*.png, normals, luts, font
    vendor-edge.mjs       # bundle edge CJS -> src/core/osi/edge/*.mjs + SHA-256 pins
    verify-edge-pins.mjs  # fails if conf/.../osi-* sources drift from pins
    verify-no-binary-art.mjs
    check-budgets.mjs     # brotli sizes from Vite manifest vs budget table
  public/generated/       # baked outputs (gitignored or committed; decide once)
  tests/
    core/*.test.ts        # vitest, headless
    replay/*.test.ts      # seed + log -> hash chain
    fixtures/saves/       # one frozen save per schema version
    e2e/*.spec.ts         # Playwright screenshots (ticker stopped)
    perf/*.spec.ts        # CDP throttle + rAF/longtask/draw-call sampling
  playwright.config.ts
```

### 8.4 Build scripts (`web/farm-sim/package.json`)

```json
{
  "scripts": {
    "bake": "tsx scripts/bake-atlas.ts",
    "vendor:edge": "node scripts/vendor-edge.mjs",
    "phone:build": "npm --prefix ../react-gui run demo:build:game",
    "dev": "npm run bake && vite",
    "build": "npm run vendor:edge && npm run bake && npm run phone:build && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run tests/core tests/replay",
    "test:e2e": "playwright test tests/e2e",
    "test:perf": "playwright test tests/perf",
    "verify": "node scripts/verify-edge-pins.mjs && node scripts/verify-no-binary-art.mjs && node scripts/check-budgets.mjs"
  }
}
```

`demo:build:game` is a new react-gui script (`vite build --config vite.demo.config.ts --mode game`) that writes `game-phone-build/`. farm-sim's Vite config copies that output to `dist/phone/`.

### 8.5 Performance budget (all values are **[target]**; "low-end" means CI CPU throttle 6x plus a physical low-end Android check before release)

| Metric | Desktop / mid (4x throttle) | Low-end Android (6x proxy + device) | How measured |
|---|---|---|---|
| Frame rate | 60 fps, p95 frame ≤ 16.7 ms | Locked 30 fps, p95 ≤ 33.3 ms, ≤ 1% frames > 50 ms | rAF deltas (device run only for GPU) |
| Main-thread JS per frame (core + view sync + submit) | ≤ 6 ms p95 | ≤ 12 ms p95 | `performance.now` spans |
| Sim tick (20 Hz) | ≤ 0.5 ms avg | ≤ 2 ms avg, ≤ 6 ms p99 | span around `core.step` |
| OSI report event (`advanceTo` crossing a report) | ≤ 3 ms | ≤ 16 ms (today ~52 ms desktop [measured], so §8.1.1 is required) | span around `osi.advance` |
| Sleep / skip 8 h | ≤ 100 ms | ≤ 600 ms behind a fade | span |
| Long tasks during play (no phone) | 0 > 50 ms per minute | ≤ 1 > 50 ms per minute | `longtask` observer |
| Draw calls per frame | ≤ 40 world + ≤ 6 post | same | GL call wrapper (debug build) |
| Full-screen passes | ≤ 5 at logical resolution, 1 upscale | ≤ 3 (normals/haze off) | renderer config |
| Texture memory | Mid: 2 atlas pages 2048² (≈ 34 MB); High: + normals page (≈ 50 MB); RTs ≤ 4 MB | Low: 2 pages, no normals page (≈ 34 MB + RTs) | allocation counter |
| JS heap (game, after GC) | ≤ 60 MB | ≤ 60 MB | CDP `Performance.getMetrics` |
| JS heap with phone mounted | ≤ 85 MB (phone ≈ 21 MB [measured]) | phone unmounted when `deviceMemory ≤ 2` | same |
| Critical download (first play, brotli) | ≤ 600 KB = Pixi ≈ 141 KB [measured] + game ≤ 180 KB + OSI core ≤ 120 KB (115 KB gzip measured; brotli not measured) + atlas ≤ 130 KB + locale ≤ 25 KB | same; OSI core can be split off until the first OSI tier | `check-budgets.mjs` |
| Phone bundle (deferred, brotli) | ≤ 600 KB after per-locale i18n split (881 KB today [measured]) | same | same |
| Full offline install | ≤ 2.5 MB | same | precache manifest sum |
| Time to first playable frame (cached) | ≤ 1.5 s | ≤ 4 s | Playwright timing |
| Phone first open | ≤ 2 s | ≤ 9 s with a progress animation (8.7 s today at 6x [measured]) | Playwright timing |

### 8.6 Quality tiers

The tier is picked at boot from `deviceMemory`, a GPU renderer string probe and a 2 s frame-time probe. It is adjusted live if p95 exceeds budget for 10 s.
- **Low:** 30 fps cap, no normal or haze pass, at most 150 particles, phone unmounted while closed.
- **Mid:** 60 fps, haze on, at most 400 particles.
- **High:** normals and lighting, at most 1,000 particles, reflections with ripple.

---

## 9. Risks

- The performance, save and honesty designs depend on the upstream simulator changes in §8.1: the Intl fixes, snapshot/restore and the reading-source seam. Without the Intl fixes and snapshot/restore, report-event hitches and replay-only saves make low-end play unworkable.
- Without the reading-source seam, "OSI advice" would run on synthetic sine readings unrelated to the player's field: real code fed fake data.
- If farm-sim pins a different vitest major than react-gui, test tooling diverges between the two packages. Plan one repo-wide bump.
- Sharing one `Simulator` across realms through a bridge is new. React-side code that relies on `instanceof` checks against response objects has not been audited; structured-clone at the bridge is the mitigation.
- `@pixi/tilemap` has had no release for 16 months. Pin it and keep the chunk-mesh fallback path.
- The SwiftShader screenshot baselines differ between platforms. Run CI in one pinned container.
- Whether Chrome throttles a hidden same-origin iframe is unverified. The design pauses the phone explicitly, so this is not on the critical path.
- Cross-browser determinism is limited by implementation-approximated `Math` functions. Quantise at state boundaries; treat V8 (Chrome and Node) as the reference.

## Sources

- [L1] Lighthouse throttling docs: Slow 4G 150 ms RTT, 1,638.4 Kbps; 4x CPU. https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md
- [G1] web3dsurvey overview: WebGL2 97.78% overall / 99% Android, WebGPU 83.23% / 71% Android. https://web3dsurvey.com/
- [G2] web3dsurvey MAX_TEXTURE_SIZE: Android ≥4096 100%, ≥8191 81%. https://web3dsurvey.com/webgl2/parameters/MAX_TEXTURE_SIZE
- [G3] Chrome 121: WebGPU on Android 12+ with Qualcomm/ARM GPUs. https://developer.chrome.com/blog/new-in-webgpu-121
- [P1] Phaser 4 renderer article (WebGL-only features, roundPixels default false, smoothPixelArt). https://phaser.io/news/2026/04/phaser-4-renderer-faster-cleaner-and-built-for-modern-games
- [P2] Phaser v4.0.0 changelog (filters, lighting, GPU layers). https://raw.githubusercontent.com/phaserjs/phaser/HEAD/changelog/v4/4.0/CHANGELOG-v4.0.0.md
- [P3] Phaser 4 release coverage (April 2026). https://gamedev.net/news/2759-phaser-4-released/
- [X1] PixiJS June 2026 update (renderer preference arrays, `domContainerRoot`, transient MSAA). https://pixijs.com/blog/june-2026
- [X2] PixiJS ParticleContainer v8. https://pixijs.com/blog/particlecontainer-v8
- [W1] Chromium scheduler-dev: one event loop per unit of related similar-origin browsing contexts. https://groups.google.com/a/chromium.org/d/msg/scheduler-dev/6xQ33iNoE7o/1h4aELPpAwAJ
- [W2] Chromium site allocation discussion: same-origin iframes share an event loop and renderer process. https://groups.google.com/a/chromium.org/g/chromium-dev/c/dTQt2r-YFxA
- [W3] blink-dev PSA on iframe render throttling (cross-origin scope). https://groups.google.com/a/chromium.org/g/blink-dev/c/op-z7fMMmWY
- [W4] Edge iframe throttling note. https://learn.microsoft.com/en-us/deployedge/edge-learnmore-iframe-throttling-display
- [E1] ECMA-262 Math function properties (implementation-approximated). https://tc39.es/ecma262/#sec-function-properties-of-the-math-object
- npm registry (`npm view <pkg> version|peerDependencies|dist-tags|time`), queried 2026-11-23.
