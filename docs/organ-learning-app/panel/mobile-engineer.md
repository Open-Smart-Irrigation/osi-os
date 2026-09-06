# Panel seat: mobile/MIDI engineer (verbatim report)

Reviewed 2026-09-06 against spec 0.6, catalogue 0.1, architecture 0.2.
Persona: senior mobile engineer; React Native/Expo with native modules, MIDI
on Android and iOS, notation rendering, offline-first SQLite, solo-founder
codebases. Verbatim transcript; the adjudication is in
[../panel-review-2026-09-06.md](../panel-review-2026-09-06.md).

## 1. Verdict

Yes, this builder can ship something close to this — the product thinking is unusually disciplined for a spec at this stage (post-attempt-only feedback is the decision that makes the whole thing tractable, the `MidiSource` abstraction with an emulator is what a good engineer would have done, and the two-down/one-up correction in architecture 6.2 is a genuine catch), but three things in the stack will hurt far more than the docs anticipate. First, **Verovio's JS build almost certainly cannot run in the app's JS engine at all** — Hermes has no WebAssembly — and the entire rendering plan, the golden-snapshot test strategy, and the "preview equals device" claim rest on it; this is a week-one discovery that invalidates architecture 1 and spec 14.2 and needs its answer decided now, not in the spike. Second, **the scoring pipeline's premise (+-40 ms articulation and timing bands) is unverified at the layer that determines it** — where the MIDI timestamp is taken — and the alignment algorithm as written has a circular dependency and no model for chords, which means it breaks on lessons one and two of the ladder, not on the hard ones. Third, the schedule is authoring-bound and the plan is missing the authoring tool entirely: B1 cannot ship without a lesson package, a lesson package cannot exist without ~150 h of tooling, and 119 h of content plus that tool is roughly six months of the 20 h/week budget before a single beta screen is built. What will *not* hurt, contrary to the doc's own worry list: the TypeScript choice, the Flutter question, and the adaptivity engine, which is the best-specified part of the design.

## 2. Findings, strongest first

### F1 — Verovio's JS build will not run under Hermes (no WASM) — blocker
**architecture 1 and 2; spec 14.2 "Score renderer"; architecture 11 "rendering"**

`verovio` on npm is an Emscripten/WASM compile of the C++ toolkit. React Native's default engine is Hermes, which does not implement WebAssembly, and the RN JSC variants ship with WASM disabled. There is no `verovio.loadData()` in an Expo app as written. The asm.js fallback build is multi-megabyte JavaScript that Hermes will take seconds to parse and will not run at an acceptable speed. The doc treats this as settled ("Verovio's JavaScript build producing SVG, drawn with `react-native-svg`") and builds two further commitments on it — CI golden SVG snapshots, and "the authoring tool uses the same Verovio build, so preview equals device rendering."

**Fix — pre-render at authoring time and stop rendering on device.** The score content is fixed, exercises are 2-16 bars, and there is no live colouring (D-5), so nothing needs a layout engine at runtime. Have the authoring tool (which is a real browser, where Verovio WASM works perfectly) emit SVG for a fixed set of viewport widths — say 360/412/480 dp portrait and 780/900/1000 dp landscape — plus a per-note position table (`{noteId, x, y, staff, beat}`) extracted from Verovio's `getElementsAtTime`/`renderToTimemap` output. Ship those into the package as `render/<width>.svg` + `timemap.json`. This makes the "preview equals device" claim literally true (the preview *is* the shipped artifact), makes the golden-snapshot test in 11 test the thing that ships, removes the 500-900 ms WASM init from the <=3 s cold-start budget, and deletes an entire class of runtime failure. Cost: ~1-3 MB of SVG per piece inside the 25 MB budget, and a reflow requires a package republish, which is fine for a catalogue of six. Keep full-score reading view (spec 8) as pinch-zoom over the same pre-rendered SVG.

Fallbacks if you insist on device rendering, in order of preference: (a) a hidden `react-native-webview` running the WASM build and `postMessage`-ing SVG strings out — works, costs ~40 MB RSS and an IPC hop; (b) a JSI native module wrapping Verovio's C++ directly (it builds under the Android NDK) — best performance, worst maintenance for a solo non-developer; (c) asm.js — do not.

### F2 — MIDI timestamp provenance is unspecified, and it is the only thing the +-40 ms thresholds rest on — blocker
**spec 5.3, 7.1, 14.2, 14.4; architecture 7 "what the emulator cannot test"**

Spec 14.1 argues MIDI latency stopped mattering because feedback is post-attempt. That is true for *latency* and false for *timestamp accuracy*, which is what scoring needs and which the doc never names. Android's `MidiReceiver.onSend(byte[], int, int, long timestamp)` gives nanoseconds from `System.nanoTime()`, stamped by the MIDI service when it read the USB frame — that is excellent, ~1-2 ms jitter from USB polling. BLE MIDI packets carry their own 13-bit millisecond timestamps in the packet header, which Android's `BluetoothMidiDevice` uses to reconstruct onsets — also usable. **But if the RN package stamps events on arrival in JavaScript instead of forwarding the native timestamp, you inherit bridge/queue jitter of 5-50 ms under load, and the "Articulation: 80 % of scored note pairs within tolerance" row becomes unmeasurable** — organ legato overlap is 0-15 ms, so the measurement noise exceeds the signal.

`@motiz88/react-native-midi` implements the Web MIDI shape (`MIDIMessageEvent.timeStamp`, a DOMHighResTimeStamp), which by Web MIDI's own definition is *receipt* time in the JS context, not source time. Check the commit history before adopting: it is a personal project with long dormancy, it is an old-architecture bridge module, and Expo SDKs from 52 onward default to (and increasingly require) the New Architecture, so you are betting on the interop layer.

**Fix.** Make the spike's exit criterion numeric and about timestamps, not about "does MIDI arrive": *play a known-tempo sequence from a hardware source, capture 500 note-ons, report the RMS and p99 deviation of inter-onset intervals against the source; pass at <=3 ms RMS.* And plan to write your own Expo Module in Kotlin over `android.media.midi` rather than adopt the package — it is ~300 lines, it lets you take the native timestamp and batch events across the JSI boundary, and it is more sustainable for a solo builder than depending on an unmaintained bridge. That, not Flutter, is your real fallback; "rewrite in Flutter" (14.1) is not a fallback, it is a restart.

Also missing from the Android MIDI plan: `<uses-feature android:name="android.software.midi" android:required="false"/>` (otherwise you exclude devices on Play), a `USB_DEVICE_ATTACHED` intent-filter plus `device_filter.xml` (otherwise the user re-grants USB permission on every connect), `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` runtime permissions on Android 12+, and an Expo config plugin to inject all of it — none of which exists for `@motiz88/react-native-midi`.

### F3 — The alignment window is anchored to the metronome grid, but tempo is fitted after alignment — blocker
**architecture 5.3 and 5.4**

Step 3 aligns with a "window +-2 beats around the metronome grid"; step 4 then fits the tempo curve to the matched onsets. If the learner drifts 15 % slow — the single most common amateur behaviour, and exactly what the "rushed take" and "drift" emulator parameters model — then by bar 8 the accumulated offset exceeds +-2 beats, the correct matches fall outside the window, and the DP reports a wall of missed notes. The pitch score collapses, the verdict is a fail, the staircase steps down, and the learner is punished for playing evenly at the wrong tempo. This is the failure mode, not an edge case.

**Fix.** Band the DP in *event-index* space, not beat-time space: band width `max(8, 0.10 x N)` around the diagonal, which is invariant to global tempo. Then fit the tempo curve, then optionally re-align once inside a narrow time window using the fitted curve. Two passes, still linear. Additionally, use *semi-global* alignment: free deletion of played events before the first match and after the last, so a false start ("wrong first note, restart") does not poison the head — currently a global edit distance charges for every one of them.

### F4 — There is no chord model; the alignment is a sequence edit distance over polyphonic material — blocker
**architecture 5.1-5.3; spec 5.2**

Channel splitting separates pedal from manuals, but a *manual part is still polyphonic*. Brahms op. 122/8 is chordal legato throughout — grade 1, lesson two. BWV 639's left hand is a chordal quaver figure. Edit distance over a linear sequence is undefined when four notes share an onset: their arrival order over the wire is arbitrary (whichever key contact closes first, within a few ms), so the "played" sequence and the "expected" sequence disagree on ordering and the DP pays substitution costs for correct playing.

**Fix.** Align *onset clusters*, not notes. Group played events whose onsets fall within ~40 ms into a cluster; group expected notes by notated onset. Run the DP over clusters with a set-matching cost inside each cell (Hungarian on a <=8x8 pitch-distance matrix, or just sorted pitch multiset difference — at this size the difference does not matter). Report per-note results by unpacking the cluster match. This also fixes the extras count, which currently inflates on every rolled chord. <!-- slop-allow: verbatim panel transcript -->

Second gap in the same section: pitch score is `matched / expected` — pure recall. A learner who plays every correct note plus thirty wrong ones scores 100 %. Report precision alongside recall, or the emulator's "extra rate" parameter has no observable effect on the score.

### F5 — The authoring tool is absent from the build order, and it is on the critical path for B1 — blocker (schedule)
**spec 14.4; architecture 10; catalogue 4**

Architecture 10 says "B1 needs neither the booking service nor RevenueCat, so the first testable build is the app plus static content alone." But static content requires a lesson package, and a lesson package requires MusicXML import with staff-to-part mapping, sectioning, per-bar annotation editing, MIDI-to-score alignment, and signed export — the four features catalogue 4 explicitly credits with saving the most hours. That is a second application, 120-180 h, and it is nowhere in B1/B2/B3.

Worse, catalogue 4's 22.5 h/piece estimate *presumes the tool already exists* ("the tool pre-fills texture class and voice count", "alignment in the tool"). Without it, per-piece cost is materially higher.

**Fix — shrink the tool rather than schedule it.** Make MuseScore the source of truth and MEI a build artifact: fingering, pedaling, and manual indications go into the MuseScore file (where the organist is already fluent), a CLI step runs `musicxml -> verovio -> MEI + pre-rendered SVG + timemap`, and the tool becomes an *annotation editor over the timemap* — a Vite page that loads the rendered SVG, lets you drag section boundaries and tag bars, plays the reference MIDI against the timemap for alignment, and writes the sidecar JSONs plus the signed zip. That is 40-60 h, not 180, and it removes the need to ever hand-edit MEI (which without a real MEI editor is miserable).

### F6 — `react-native-svg` will not carry a page of three-staff organ notation — major
**spec 14.2; spec 8; architecture 11**

`react-native-svg` maps each SVG element to a native shadow node and view. One system of three-staff organ music with ornaments and editorial fingering is roughly 400-900 elements; a full page 2,500-6,000. Mount cost on a Pixel 8 Pro is in the hundreds of milliseconds and the memory per view is not trivial. Verovio's default output uses `<use xlink:href="#E0A4">` against a `<defs>` symbol table for SMuFL glyphs — `react-native-svg`'s `<Use>`/`<Symbol>` support is partial and historically fragile; forcing outline paths instead (`--smufl-text-font none`) multiplies node count again.

Note also the display: the Pixel 8 Pro is 120 Hz LTPO. The target is an 8.3 ms frame, not 16.7 ms.

**Fix.** With F1's pre-rendering, use `@shopify/react-native-skia`'s `Skia.SVG.MakeFromString` + `<ImageSVG>` — the whole system becomes one GPU-composited node instead of thousands of views (verify Skia's SVG DOM handles Verovio's output; emit outline paths rather than `<use>` if not). Then draw the cursor as a separate `Animated.View` overlay driven by Reanimated shared values on the UI thread, reading positions from `timemap.json` — never re-render the score to move the cursor. Because there is no correctness colouring during play (D-5), the score is a static texture for the whole attempt, which is the cheapest possible case. Set an NFR: *first system visible <= 250 ms after exercise start; zero dropped frames during a 60 s cursor sweep at 120 Hz*.

### F7 — "Follow my playing" is online score following, and it contradicts 14.1 — major
**spec 7.2; spec 15 NFR "MIDI event to cursor update <= 30 ms"**

Spec 14.1 justifies the TypeScript stack on the grounds that "MIDI-to-screen latency no longer matters." Spec 7.2 then offers a cursor that "tracks the matched notes" and 15 sets a 30 ms budget for it. Real-time score following — matching a stream with no future information, surviving hesitation, wrong notes, and restarts without the cursor jumping — is a substantially harder algorithm than post-hoc alignment (it is the Antescofo/online-DTW problem), and a naive nearest-match implementation will make the cursor twitch, which on a music desk is worse than no cursor.

**Fix.** Ship metronome-driven cursor only in v1. Move follow-my-playing behind the launch. Delete the 30 ms NFR and replace it with the one that actually governs the product: *onset timestamp accuracy <= 3 ms RMS* (F2).

### F8 — "States are derived and rebuildable from attempts plus package data" is not true as designed — major
**architecture 4 and 4.1; spec 3 lesson package versioning; spec A-1**

Three concrete breaks:

1. **No package version on attempts.** `attempts` has no `package_version`, and `section_state` has no content revision. Architecture 3 explicitly supports lesson updates ("the app compares versions to offer updates"). If v2 moves bar ranges or changes annotations, replaying old attempts against new package data yields different states, silently. Fix: put `package_version` on `attempts`, a per-section `revision` hash in `manifest.json`, and a rule — a section whose revision changed resets to `in_progress` with a note to the learner; sections that did not change keep their state. Never renumber `section_id`.
2. **No scoring version.** A-1 says thresholds are placeholders to be tuned; architecture 6.1 rescales dimension scores so "its pass threshold lands at 0.75", so changing a threshold changes historical mastery. Add `scoring_version` and `thresholds_version` to `attempt_scores` and forbid rebuild across a version boundary — replay from the last frozen state instead.
3. **90-day pruning destroys the rebuild.** A-3 prunes `attempt_events`, after which nothing can be rescored. That is fine, but it means `attempt_scores` *is* the immutable record, not `attempt_events`, and the derived-state claim should be restated as "states are rebuildable from `attempt_scores` + `part_ratings`, which are append-only and never rewritten." Awarded achievements must be explicitly excluded from any rebuild — un-awarding an achievement on a replay is the kind of bug that ends a beta.

Schema hygiene while you are in there: no primary key is stated on `attempt_events` (use `(attempt_id, seq)`), no index on `attempt_events(attempt_id)` or `attempts(exercise_id, started_at)`. Store times as `integer('...', { mode: 'timestamp_ms' })`, not ISO strings — Drizzle supports it, and string comparison only works while every writer agrees on the exact format. Enable `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON` explicitly; neither is on by default per connection in `expo-sqlite`.

### F9 — The thresholds can never be tuned, because no attempt data leaves the device — major
**spec A-1, D-38; spec 15 "Privacy"; spec 14.2 "Analytics: none at launch"**

A-1 commits to tuning the pass thresholds "with data". D-38 keeps every attempt on the phone, there is no analytics, and A-5 in architecture says thresholds are "only tuned on real-console data". Nothing connects the two. At launch you will have twenty closed testers and no way to see a single number they produced.

**Fix.** Add an opt-in "share my practice data with the developer" export in beta builds: a signed POST of a compact per-attempt row (exercise id, package version, tempo ratio, the three scores, verdict, input type — no note events, no email) to a single endpoint. Gate it behind an explicit consent screen and ship it *off* in the production build if you prefer, but without it, A-1 is unclosable and F13's constants stay at their guesses forever.

### F10 — No crash reporting and no OTA update path — major
**spec 14.2 "Analytics", "CI and release"**

A solo builder shipping a custom native MIDI module to twenty testers on unknown Android OEM builds, with no error telemetry, is flying blind: Play Console's Android vitals reports native crashes but not JS exceptions, and an RN JS error is an invisible white screen, not a crash. Separately, every fix — including a one-character scoring bug found mid-beta — costs a store review round trip.

**Fix.** `@sentry/react-native` with `sendDefaultPii: false` and Sentry's EU (Frankfurt) data region, which is compatible with the Swiss/EU posture in 14.3; and `expo-updates` + EAS Update from B1, so JS fixes ship in minutes. Both are hours of work and each will pay for itself in the first month of the closed test.

### F11 — Package signing and hashing as specified will not work in RN, and the verification order is inverted — major
**architecture 3**

- Ed25519 itself is fine: `@noble/ed25519` runs in Hermes; you need `react-native-get-random-values` (or `expo-crypto`) for `getRandomValues` and must wire `ed.etc.sha512Sync` to `@noble/hashes/sha512`. Signature verification over a small manifest is single-digit milliseconds.
- **The file hashes are the problem.** SHA-256 over a 25 MB package in pure JS under Hermes is tens of seconds, and the obvious workaround — read the file into a base64 string and call `expo-crypto`'s `digestStringAsync` — allocates ~33 MB of JS string and will OOM on low-end Android 10 devices. `expo-file-system`'s `getInfoAsync(uri, { md5: true })` is native but MD5, which is not acceptable when the manifest hashes are the integrity boundary. Use `react-native-quick-crypto` (JSI over OpenSSL, streaming `createHash('sha256')`), and unzip with `react-native-zip-archive` (native) — `fflate`/JSZip in JS will OOM on the same file.
- **Verification order is backwards.** The manifest and signature live *inside* the zip, so you must extract untrusted archive contents before you can verify anything. Publish a detached `bwv639.sig` and `bwv639.manifest.json` next to `bwv639.zip`, verify the signature over the zip *bytes*, then extract. And validate every entry path before extraction anyway (zip-slip: reject `..`, absolute paths, symlinks).
- **One pinned key is a one-way door.** Pin two — current and next — and put `key_id` in the manifest, so a rotation does not require every installed app to update first.

### F12 — Audio: the built-in organ is uncosted, and there is no accompaniment-timing story — major
**spec 7.4; spec 14.2 "Audio"; spec 15 "Lesson package size <= 25 MB"**

Three separate problems bundled into one line of spec.

1. **Sample set size and licence.** "One principal chorus, one flute, one reed, pedal 16'+8'" multisampled across a 61-note compass with release tails is 30-60 MB even at Opus, and it cannot live in the 25 MB lesson package, so it is an app-binary asset. No source is identified. Most of the free Hauptwerk/GrandOrgue sets in circulation are non-commercial-only — a real trap for a CHF 12/month product, and a licence audit the catalogue's 2 does for scores but not for sound.
2. **Synthesise instead.** Organ pipes are close to a fixed harmonic spectrum with a chiff transient; a single-cycle wavetable per stop family, looped in an `AudioBufferSourceNode` with pitch shift and a short attack/release envelope, is a few kilobytes per stop, sounds genuinely credible for practice accompaniment, and maps one-to-one onto D-6's "generic stop families". This is the right call for a product that explicitly says the built-in set "is not a substitute for the instrument."
3. **Sync with the learner's own instrument is not addressed.** If accompaniment comes out of the phone speaker at 20-40 ms output latency (Oboe/AAudio on a Pixel 8 Pro, best case) — or 150-300 ms over Bluetooth headphones — while the learner plays a pipe organ with its own action delay, the parts will not line up, and a professional organist will notice immediately. Add a one-time **audio offset calibration** to the Setup screen (play a click, tap along, or better: with MIDI connected, sound a note and measure the loopback) and apply the offset to accompaniment scheduling.
4. **Metronome scheduling.** Do not schedule the click from `setTimeout`; the jitter is 10-50 ms under GC and it is the metronome, so the learner will hear every one of them. Use the standard lookahead scheduler (a 25 ms JS timer scheduling audio events 100 ms ahead on `AudioContext.currentTime`). `react-native-audio-api` is the right choice — it is actively maintained by Software Mansion and sits on Oboe — but confirm in the spike that `start(when)` scheduling holds sample accuracy with 16+ simultaneous voices and long release tails.

### F13 — Organ MIDI reality: couplers, note-on velocity 0, and non-note messages — major
**spec 7.1, D-30, A-17; architecture 5.2; spec 14.4 gate G1**

The channel-map wizard confirms one key per manual, which is right, but it will not survive a real console:

- **Couplers.** With Swell-to-Great engaged, one physical key press emits note-ons on *two* channels. Part splitting then double-counts every note, "extras" explodes, and the Manual-change template's channel check reports the wrong manual. This is not exotic — an organist registering a chorus will have couplers drawn most of the time. The wizard must detect it explicitly ("you pressed one key on the Great and we saw channels 1 and 2 — a coupler is engaged; draw it off for this exercise, or we will treat channel 2 as a duplicate") and the splitter needs a de-duplication rule for identical pitch+onset within ~10 ms across channels.
- **Note-on with velocity 0 is a note-off.** Extremely common on older consoles. Handle it or every note appears to sustain forever and articulation scoring returns nonsense.
- **Filter non-note traffic.** Stop changes arrive as program changes and CCs, swell shoes as CC11, and some consoles emit active sensing at 300 ms intervals. Ignore all of it. Ignore velocity entirely — organs do not have it.

### F14 — Gate G1 is a year too late; the console is available now — major
**spec D-39; architecture 7 and A-5**

The design assumes no organ at the dev site and defers real-console validation to between B1 and B2. But the builder *is* the professional organist who will record every reference performance on that console (spec 9.6). One two-hour trip in spike week 1 with the Pixel 8 Pro, the USB-C cable, and a throwaway capture screen answers, at once: whether the timestamps are native (F2), what the channel layout is, whether couplers duplicate (F13), whether the console is USB-B and A-4 holds, and what the real onset jitter is. It also produces genuine MIDI fixtures.

That matters because of the emulator's structural weakness: `EmulatedConsoleSource` generates takes *from the same expected-note expansion the scorer uses*, so a bug in expansion — ornaments, repeats, chords, voice-to-staff mapping, exactly the hard cases — is invisible to every CI fixture. Likewise architecture 11's adaptivity assertion ("success rate lands in the 60 to 85 % band") is checked against simulated learners whose parameters you choose, so it can always be made to pass.

**Fix.** Add a fourth `MidiSource`: `RecordedMidiSource`, replaying a captured `(bytes, native_timestamp)` log. Capture 20 minutes of real playing in week 1, hand-label a small golden set, and make *those* the CI fixtures for ornaments, chords, and repeats. Keep the emulator for adaptivity simulation, where it is genuinely the right tool.

### F15 — Ornaments, repeats, and the tempo fit have unhandled edge cases — major
**architecture 5.1, 5.4; catalogue 3 (BWV 731 is lesson three)**

- **Ornaments.** "Matched leniently: any of the ornament's realisations accepts" is under-specified. A trill's note count is performer-determined. Specify: for an ornament-tagged note, accept any alternation of principal and auxiliary within the note's notated span as *one* matched item, exclude those events from the extras count, and exclude them from timing scoring entirely (only the ornament's start onset is timed). Without this, BWV 731 — "trills on a held voice", grade 2 — scores as a catastrophe on a correct performance.
- **Repeats.** "Unfolded" turns a skipped repeat into a solid block of missed notes. Add zero-cost skip arcs at volta/repeat boundaries in the DP. Scope relief: exercises are 2-16 bars, so repeats only bite on the full play-through that completes a lesson — say so, and bound the work.
- **Tempo fit.** "Piecewise linear, one knot per two bars" over a 2-bar loop drill gives you one knot and eight notes — degenerate; require a minimum of ~12 matched onsets per knot or fall back to a single global tempo. Fit robustly (Huber loss or median-of-slopes) — plain least squares lets one wrong note drag a knot. Constrain the beat-to-ms map to be strictly increasing, or a bad fit produces negative local tempo. <!-- slop-allow: verbatim panel transcript -->
- **Conceptually:** fitting a curve and scoring residuals means unwritten rubato is fully absorbed and scores perfectly. Architecture 5.4 half-acknowledges this but spec 5.3 has one number. On the organ, which has no dynamics, steadiness *is* the expressive parameter. Report three: evenness (residual RMS), tempo accuracy (mean fitted vs target), stability (max per-bar tempo change), with a threshold on each.

### F16 — The staircase cannot converge at these sample sizes; drop the 71 % claim — minor
**architecture 6.2 and 6.5; spec 6.3 rule 4**

The two-down/one-up correction is right and well caught, but a Levitt staircase reaches its 70.7 % asymptote after roughly 15-30 reversals. A cell is secured after two passes on separate days (spec 5.3) — call it four to eight attempts. The staircase never converges; it is a sensible ramp, not an estimator, and stating "settles by itself at the tempo where about 71 % of attempts succeed" invites treating it as a guarantee during beta tuning. Either state it as a heuristic, or run the staircase at *section* or *skill-dimension* level where attempts accumulate across cells.

### F17 — USB host mode blocks charging; a 90-minute practice session ends flat — minor
**spec D-35, architecture A-4, spec 15**

A Pixel 8 Pro acting as USB host cannot charge over the same port. Landscape score view keeps the screen awake at high brightness on a music desk, with audio running — that is roughly 15-20 %/hour. A learner practising for 90 minutes with the score on the phone will hit a low-battery warning mid-lesson. Recommend a powered USB-C OTG hub in the setup guide, or BLE MIDI when charging is needed, and add a battery note to 15's NFRs. Also confirm A-4: most church and home consoles expose USB-B, so the cable is C-to-B — cheap, but worth having in hand before the week-1 console trip.

### F18 — Free loss protection is being left on the table — minor
**architecture 4.1, A-1**

A manual share-sheet export is loss protection only for users who remember to use it, which is nobody. Android's Auto Backup (`android:allowBackup`, `dataExtractionRules`) backs up the app's SQLite file to the user's Google Drive and restores it on reinstall or new device, at no cost and no server. Check-point WAL before backup (`PRAGMA wal_checkpoint(TRUNCATE)`) and exclude `-wal`/`-shm` from the rules, or you restore a torn database. Keep the manual export as the account-migration path, which is its real job.

### F19 — Verify the Play closed-test numbers, and test Verovio on the hardest piece first — minor
**spec 14.3, Q-2; catalogue 3**

Google reduced the individual-account closed-test requirement from 20 testers to 12 (continuously opted in for 14 days) — verify the current rule rather than plan against 20, and recruit 20 to *keep* 12, since attrition over 14 days is the actual failure mode.

Separately: run the Verovio rendering acceptance test on BWV 565 and the Widor, not BWV 639. Organ-specific notation is where MusicXML-to-MEI conversion and Verovio's coverage are thinnest — pedal-staff labelling, heel/toe marks (SMuFL `keyboardPedalHeel1`/`Toe1`, U+E660 range, which Verovio does not render as first-class organ elements and which you will place as `<dir>`), manual-change indications, and cross-staff beaming. Discovering that in month nine is much worse than discovering it in week two.

### F20 — Schedule arithmetic — major (as a planning finding)
**spec 14.4, D-32; catalogue 3.2 and 4**

Adding it up at 20 h/week: spike 40 h; authoring tool 60-180 h (F5); B1 (player, SQLite, screens, i18n, emulator, brand) 250-350 h; B2 (MIDI module, scoring, four analysis visualisations, G1) 180-220 h; B3 (adaptivity, subscription, booking service, release compliance) 230-280 h; plus 119 h of content that comes out of the same budget. That is 880-1,190 h, i.e. **11-15 months**, with no dead ends — and F1 alone is a dead end the plan does not know about yet. The docs state milestones but never a total, which is the number that decides whether this is a project or a hobby.

Two levers, both in catalogue 4: **buy the engraving** (6 h/piece x 6 = 36 h; PD organ engraving is a few hundred francs on the open market, and MuseScore.com/IMSLP already carry community-typeset MusicXML for BWV 639/645/731 — check licences, several are CC0), and **cut launch to three pieces** (BWV 639 free + Brahms + BWV 731 ~ 45 h). The product's claim is the adaptive engine, not catalogue breadth; three pieces demonstrate it, and pieces four to six ship in the first quarter alongside the ones already promised there.

## 3. Enhancements

1. **Make MuseScore the source of truth and MEI a build artifact.** Fingering, pedaling, and manual indications go where the organist is already fluent; a CLI step produces MEI + pre-rendered SVG + timemap; the authoring tool becomes an annotation editor over the rendered SVG rather than an MEI editor. Cuts F5's cost by two thirds and eliminates hand-editing MEI, which without a dedicated editor is the worst hour of any authoring day.

2. **Ship a `RecordedMidiSource` and a hidden capture screen in the very first dev build.** Every trip to the console then produces reusable CI fixtures instead of notes. Combined with F14, it converts the emulator from "the thing we test with" to "the thing we test *alongside*", which is the difference between a fixture suite that catches ornament bugs and one that agrees with them.

3. **Wavetable organ instead of a sample set.** Single-cycle wavetables per stop family plus a chiff transient and a short release: kilobytes instead of 40 MB, no licence question, and it maps directly onto D-6's generic stop families so the built-in sound and the registration vocabulary are the same abstraction.

4. **Exploit the constants module over EAS Update.** Architecture 6.5 already puts every tunable in one place; wire that module to an OTA-updatable JSON so beta threshold tuning (A-1) is a ten-minute publish, not a store round trip. Paired with F9's opt-in data export, this is the only way A-1 actually closes.

5. **Add a `couplers_detected` field to the instrument profile and a coupler check to the wizard.** It costs an hour, and it is the difference between "the app doesn't work on my organ" and "the app understood my organ better than I expected" for the exact audience being targeted. Same category: record the console's make/model in the instrument profile so support requests from twenty testers are diagnosable.

## 4. One thing to cut from v1

**The in-app booking flow and the entire `apps/booking-api` server side** — the Hono service, Postgres, the Stripe webhook, the container host, nightly backups, and the consented snapshot upload (architecture 9, spec 13, A-2).

Keep the tutor offer; cut the infrastructure. Replace it with a hosted scheduler (Cal.com or similar, EU-hosted, with Stripe already wired in) opened from a button in the app, and let the learner email or share their exported progress zip before the session. That deletes: the only server code with learner state, the only Postgres instance, the only backup obligation, the only webhook to secure, the DPA surface for the snapshot upload, and — because the authoring tool was going to be "served from the same host" — the container host entirely (a Vite build behind basic auth on Cloudflare Pages does the job).

The argument is D-31 and D-32 sitting next to each other. Ten two-hour slots per week is 20 hours of tutoring against a 20-hour build week; at launch, with a few dozen users, real bookings will be near zero. You would be building and operating 80-120 hours of infrastructure, permanently, to remove two taps from a transaction that will happen once a fortnight. Every hour of that is an hour not spent on F1 through F4, which are the hours that decide whether the app works at all. Build the booking service when bookings exist to justify it — and by then, accounts will have arrived with the iOS port, which is when a server that knows who the learner is finally starts earning its keep.
