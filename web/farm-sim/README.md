# OSI farm sim

An original educational farming game about irrigation decisions. The player runs a smallholder tomato farm in a fictional semi-arid region with two rainy seasons, where water is scarce and moving it is the main labour cost. The phone in the game runs the real OSI OS React app (`web/react-gui/src`) against the OSI OS simulator (`web/react-gui/demo/model.ts`), so the recommendations and automated valve runs it shows come from OSI code. The first milestone, M1, is a 14-day slice with one OSI tier per run. Nothing in this package reaches a gateway, the firmware image or the GUI bundle.

The design, the decisions behind it and the M1 scope are in [docs/plan.md](docs/plan.md). Working title: OSI Farm Sim.

## Tiers

The facilitator panel offers five tiers. The names below are the panel's labels (`TIER_NAMES` in `src/ui/overlays.tsx`).

| Tier | Panel label | What the player has |
|---|---|---|
| T0 | Manual farm | Hoe, seedlings, can, jerrycan, basket, a hand pump and a tank with a manual tap. The phone cannot be raised. |
| T1 | Soil readings | T0 plus a soil probe at 20 and 40 cm and a gateway pole; the phone shows soil cards, the wet, moist or dry pill and history. |
| T2 | Water demand | T1 plus a rain gauge, a flow meter on the tank outlet and the game's weather service; the Water tab shows ET0, crop demand, the balance and a verdict labelled "Simulated sensor advice". |
| T3 | Phone valve | T2 with a valve in place of the manual tap: timed opens of 1 to 255 minutes, early close, weekly and one-time plans. |
| T4 | Automatic trigger | T3 plus the daily 06:00 trigger on the 20 cm reading, preset by the scenario file to 25 kPa and 45 minutes (`reference` in `src/scenarios/*.json`); the player can change both in the app. |

## Run it locally

You need Node 22.12 or a later 22.x release, or Node 24 or later (react-gui's `engines` field); the plan's CI pins Node 22. The phone is built with react-gui's own Vite and plugins, so react-gui needs its dependencies too. From the repository root:

```bash
cd web/react-gui && npm ci
cd ../farm-sim && npm ci
npm run build
npx vite preview --host 127.0.0.1
```

Open the address that `vite preview` prints. `npm run build` runs three steps in order (plan 10.2): `npm run bake` writes the sprite atlas and pixel font into `public/generated/`, `npm run build:game` writes `dist/`, and `npm run build:phone` writes `dist/phone/`. The game loads `phone/phone.html` only when the phone is first raised. The preview server sends the same content security policy as production (`vite.shared.mjs`), and the game makes no network request beyond its own static files.

### Facilitator mode and choosing a tier

A plain page load starts the `baseline` scenario at T0, at pace 150, with pause-while-phone-open and hints on and the moisture lens off (`defaultHeader` in `src/core/scenario.ts`). No URL flag sets the tier; only the facilitator panel does.

- Append `?facilitator` to the address to open the panel at start, or press Shift+F during play. The run is paused while the panel is open.
- The panel sets the scenario (`baseline`, `dry-spell`, `storm`), the tier, the pace (75, 150 or 300: a 06:00 to 21:00 day takes 12, 6 or 3 real minutes), pause while the phone is open, the moisture lens and hints. "Start new run" applies them; any change restarts the run.
- The panel also exports the event log (`farm-log.jsonl`), saves a replay (`farm-replay.json`) and loads one. A replay loads only into the build that made it.
- `?lang=<code>` sets the phone's language: `en`, `de-CH`, `fr`, `it`, `es`, `pt` or `lg`; any other value gives English. Game text outside the phone is English in M1.
- `?render-review` boots a fixed-frame render harness instead of the game, for `scripts/render-screenshots.ts`.

Keys: WASD or arrows to move, E to interact, Space to use the selected tool, 1 to 5 to pick a tool, P to raise or lower the phone, and B to walk home and sleep (from 18:00). A click or tap on a tile walks there.

## Package structure

| Path | Contents |
|---|---|
| `src/core/` | The deterministic core in plain TypeScript: time, weather, soil, crop, water, labour, map, world, tutorial, report, log and replay. No DOM and no clock. |
| `src/core/osi/` | The OSI adapter: the farm builder that registers devices per tier, the reading and weather sources the simulator calls, the water tap with its dry-run cutoff, stepping, and the phone bridge with its allow-list. |
| `src/scenarios/` | The three frozen scenarios, each with a seed, a start time, the initial farm state and reference policies. |
| `src/view/` | The PixiJS renderer: camera, terrain, actors, particles, lighting and quality tiers. It reads a frozen view model and never advances time. |
| `src/ui/`, `src/input/` | The Preact overlay (HUD, tool belt, hints, About panel, facilitator panel, report, log export) and keyboard, mouse and touch input. |
| `src/phone/`, `src/phone-host.ts` | The phone page that mounts the OSI app with copy overrides, a time-zone shim and a device-location stub, and the game side of its iframe. |
| `art/`, `scripts/bake-atlas.ts` | Palette, sprite helpers and validator, sprite modules, generators and the pixel font, baked into `public/generated/` (not committed). Provenance: [ASSETS.md](ASSETS.md). |
| `tests/unit/`, `tests/integration/`, `tests/e2e/` | Node unit tests; headless closed-loop, parity, cutoff, honesty, allow-list and replay tests; Playwright tests against the built files. |
| `scripts/` | Test runner and file reporter, the bake, the seed search (`find-seeds.ts`), golden regeneration (`update-golden.ts`), and art review and screenshot tools. |

The entry points are `src/main.ts`, `src/game.tsx` and `src/loop.ts`.

## Determinism and replay

One save reproduces a run: the replay header (scenario, seed, tier, start, pace and the panel switches), the command log and a terminal cursor (plan 4.8). The core in `src/core/` uses no `Math.random`, `Date.now` or `performance.now`; its randomness comes from an sfc32 generator with named sub-streams (`namedStream` in `src/core/rng.ts`), so adding a system does not shift another's draws. Every player action, phone write and raising or lowering of the phone enters one queue and is logged as `{tick, seq, cmd}`. A tick is 50 ms of real time and advances game time by 50 ms times the pace. Every 600 ticks the run records a SHA-256 hash of the core state and a simulator digest, and replay throws when the log, cursor or hashes disagree (`src/core/replay.ts`). Wall-clock fields are added outside the core, by `src/ui/export.ts`. V8 is the reference engine; other engines can differ in the last bit of `Math.exp` and `Math.pow` inside the edge ET0 code.

## What is simulated and what is real OSI code

Anything the game presents as an OSI reading, recommendation or automated action is the output of OSI code: the simulator's ported logic in `web/react-gui/demo/model/`, or an unmodified edge module under `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/` (plan section 2). The game world supplies only the physical inputs.

| What the player sees | Where it comes from |
|---|---|
| Weather, soil water, crop growth, tank and well levels, labour | The game world in `src/core/` |
| Soil readings on the phone | World soil state sent through the simulator's uplink path (`src/core/osi/reading-source.ts`) |
| Soil pill and history charts | The OSI app (`web/react-gui/src/utils/swt.ts`) |
| ET0 | The edge function `fao56Et0` (`osi-agronomy-daily/et0.js`) on the game's weather |
| Kc, crop demand, balance and the verdict | Kc from the app's copy of the edge `osi-crop-kc` module (`web/react-gui/src/agronomy/cropKc.ts`), the rest from the simulator's verdict port, inside the parity envelope of plan 5.2 |
| Timed opens, plans and the 06:00 trigger | Simulator ports of the edge logic, pinned by tests in `web/react-gui/demo/tests/` |
| Current conditions, hourly temperature, rain chances, day-card highs and lows | Illustrative; the phone labels each one as a game value |
| Moisture lens, plant cues, litres calculator | Game aids outside the phone, labelled "game" |

The rules that keep the table true (plan 5.3 and 5.4):

- The phone labels the verdict "Simulated sensor advice" and the meter litres as a simulated flow meter, and replaces every real weather provider, country and place name in all seven locales (`src/phone/copy.ts`).
- Phone writes are refused unless the per-tier allow-list at the bridge accepts them (`src/core/osi/allow-list.ts`), so the phone cannot add a device, remove the meter or change the valve's flow rate.
- When the tank runs dry, a game device, the dry-run switch, closes the valve; the About panel says so.
- Simulator-only behaviour, such as the busy-valve skip and the English advisory sentences in trigger evaluations, is never attributed to OSI.
- A field-classification test fails when a numeric field in a phone response is not classified as world, OSI code or illustrative (`tests/integration/honesty.test.ts`).

## Tests and gates

Run from `web/farm-sim`, in this order, with the pass signal of plan 11.3:

```bash
npm run typecheck      # exit 0
npm run bake
npm test               # all pass
npm run build          # exit 0
npx playwright install --with-deps chromium
npm run test:e2e       # all pass
npm run verify         # each check prints OK
```

`npm run verify` runs core purity, no binary art, isolation, package hygiene, the download-size budgets (atlas, game and phone bundles) and the test coverage guard. The coverage guard reads the results of both test runs and fails on any test file with no executed test, so it runs last. One test file runs with `node scripts/run-tests.mjs tests/unit/soil.test.ts`.

From the repository root, the repository gates for this package are `node scripts/verify-test-inventory.js` (OK), `node scripts/verify-doc-hygiene.js` and its `--stdin` mode on PR text and commit messages (OK), `node .claude/skills/anti-slop-writing/slop-check.js web/farm-sim/README.md web/farm-sim/ASSETS.md web/farm-sim/docs/plan.md` (PASS) and `git diff --check` (no output).

CI is `.github/workflows/farm-sim.yml`: it runs these steps on pull requests and pushes that touch `web/farm-sim/**` or the four simulator hook files, plus a weekly run, and it is not a required check.

## Further reading

- [docs/plan.md](docs/plan.md): the normative design and M1 plan. Values marked [tune] may change.
- [docs/research/](docs/research/): seven dated research reports and a cross-check. They are snapshots and are not maintained.
- [docs/research/evidence/](docs/research/evidence/): the script that runs the plan's farm recipe against the simulator, and its output.
- [ASSETS.md](ASSETS.md): where every asset comes from and its licence.
