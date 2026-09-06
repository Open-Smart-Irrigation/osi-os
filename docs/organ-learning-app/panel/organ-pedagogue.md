# Panel seat: organ pedagogue (verbatim report)

Reviewed 2026-09-06 against spec 0.6, catalogue 0.1, architecture 0.2.
Persona: concert organist and conservatory pedagogue, 25 years teaching adult
amateurs and church musicians. Verbatim transcript; the adjudication is in
[../panel-review-2026-09-06.md](../panel-review-2026-09-06.md).

## 1. Verdict

The bones are the work of a musician, not an app designer, and that shows in the places it matters: repertoire-first, feedback only after the attempt, no correctness colouring while playing (D-5 — the single best decision in the document, because at the organ the eyes must stay on the score and off the feet), part isolation before pairing with RH+pedal and LH+pedal before the two hands, "no wrong pedal note" as an absolute gate, and registration expressed in families mapped once per instrument. An adult amateur would recognise a teacher behind all of that. What is not yet credible is the layer that converts musical judgment into numbers, and it fails in an organ-specific way: articulation is graded by distance from one organist's take, pedal technique is modelled as a single heel-toe axis across a catalogue that is two-thirds German Baroque, the grade-1 rung contradicts the piece placed on it, the "urtext" sources named are 19th-century editorial texts whose own articulation would be imported into the thing being scored, and nothing in the system knows where the bench is. Those are spec defects, not code defects, and they are all fixable before the spike. As it stands I would call the product musically credible in architecture and musically naive in measurement.

## 2. Findings, ranked

### F1 — Articulation scored against a single reference performance (blocker)
*spec 5.2 "Legato and articulation", 5.3 pass table; architecture 5.5*

On the organ, articulation is the interpretation — it is the only expressive parameter left once the stops are drawn, which the spec itself says. There is no correct gap value for a Bach note pair. Touch is a function of metrical position, note value, the room's decay, and the instrument's action and speech; the gap that makes a Silbermann in a four-second acoustic sound articulate makes a digital in a headphone-dry living room sound broken. Grading "80 % of scored note pairs within tolerance of the reference" trains imitation of one take by one player on one console, and it enshrines that take's agogics as law. Publish that as a pass condition and every experienced organist who tries the app will dismiss it in one session.

**Fix.** Replace distance-to-reference with three things a teacher would actually assess, all of which are objective:
1. **Intended touch category, authored as an editorial layer in the MEI** — legato / ordinary articulated touch / detached / staccato, per passage, exactly as a good edition's preface states its position. Score membership in a wide band, not proximity to a number.
2. **Consistency across like figures.** Does the learner treat the same motif the same way on its fourth appearance as on its first? This is the actual fault in amateur organ playing, it needs no reference take, and it is trivially computable from repeated annotated figures.
3. **Release behaviour.** Two objective sub-metrics: repeated notes must be genuinely re-articulated (a pipe that does not stop does not re-speak — this is a real, checkable, binary fault), and chord releases must be synchronous. Chord release synchrony is the organist's core craft, it is invisible to every piano-derived scoring model, and MIDI gives it to you for free.

Keep the reference overlay as *feedback* (the comparison plot is genuinely useful). Take it out of the gate.

### F2 — Pedal technique modelled as one axis; heel-toe introduced from grade 2 into a Baroque catalogue (blocker)
*catalogue 1 grading table; spec 5.2 "Pedal technique" template*

The ladder runs "toes only" then "first heel use" then "simple heel-toe" then "heel-toe throughout" as if that were a single progression. It is not. It is the modern/Romantic pedal technique, and it is stylistically wrong for four of the six launch pieces. Bach's pedalboards were flat, parallel, and short in compass; the historically informed technique is alternating toes, and its characteristic non-legato *is the articulation of the pedal line*, not a limitation to be trained away. Teaching heel-toe legato into BWV 639, 731, 645 and the Pachelbel and then shipping editorial pedaling to match it puts the app on the wrong side of an argument this audience has read about and has opinions on. Meanwhile the Boellmann and the Mendelssohn genuinely need heel-toe, so you cannot simply pick one.

**Fix.** Make pedal technique two axes in the grading table and two annotation layers in the package: *alternate-toe (early)* and *heel-toe (modern)*, each with its own editorial pedaling for the pieces where both are defensible, selected by style tag and by the learner's declared pedalboard type. State the choice and its rationale in the orientation commentary — that is the scholarly register the spec claims, and it converts a liability into the app's most distinctive feature (see E1).

### F3 — Nothing in the system observes the body, and the instrument profile's pedalboard data is never used (blocker)
*spec 4 (instrument profile), 5.2, 7; architecture 8 Setup*

The ordered list of what actually goes wrong with adult pedal beginners is: bench height and fore-aft distance wrong, so the weight sits on the feet instead of the seat bones and the sharps are unreachable with the heel; looking down; moving the leg from the hip instead of pivoting at the ankle; knees splaying; street shoes. MIDI reports none of it. A learner playing every pedal note at the right pitch and the right moment, with the wrong foot, hunched, looking at their feet, scores 100 % and secures the section. That habit then takes two years to unlearn. The documents never acknowledge this gap, which is the one place where "app instead of teacher" has a hard limit.

**Fix.** Three concrete things, none of which need machine learning:
- A one-time **bench-and-posture setup** in the Setup area: rear camera, phone propped, a side-on still, with an overlay rubric (heel resting on a natural key with the ankle relaxed; knee angle; the sharps reachable without shifting) and reference photographs. Self-checked, but it forces the question to be asked once.
- **Pedalboard type in the instrument profile** — AGO concave-radiating, German parallel/flat, RCO, historical short compass — and make it *drive the editorial pedaling shown*. Heel-toe indications on a flat short-compass pedalboard are not merely unidiomatic, they are physically wrong. The profile already records compass; it currently changes nothing.
- Say out loud, in onboarding, that the first tutor session is best spent on bench position and foot geometry, and that organ shoes are not an affectation.

### F4 — Percentage accuracy thresholds and a constant-millisecond timing window are blind to exercise length and tempo (major)
*spec 5.3; architecture 5.5*

Two separate errors in one table. First, "95 % correct notes" means something wildly different across the exercise sizes the spec itself specifies (two to sixteen bars): a twelve-note loop drill passes only at zero errors, a sixteen-bar four-voice full texture passes with ten wrong notes. Meanwhile one wrong pedal note fails outright. That asymmetry — ten wrong manual notes tolerated, one pedal note fatal — is not defensible. Second, +-60 ms as a fixed band is a piano assumption. At a chorale-prelude tempo it is musically invisible; in the Widor it is enormous. And a uniform grid ignores that agogic lengthening at phrase ends and cadences is *correct playing*, not error.

**Fix.** Express pitch demands as errors per bar, weighted by voice — a wrong note in a fugue subject or a cantus firmus entry is not the same event as a wrong filler alto, and the annotation layer already knows which voice is which. Express timing tolerance as a fraction of the local inter-onset interval (the articulation metric already does this — be consistent), floored at a fixed ms value, and widen it at annotated cadences, phrase ends, and ornaments.

### F5 — Grade 1 contradicts the piece placed on it, and the ladder has no true first rung (major)
*catalogue 1 and 3; catalogue 3.1; spec 12*

Grade 1 is defined as "two-voice or chordal, one manual". BWV 639 is a three-voice trio requiring two manuals set up from the first bar, in F minor, with a heavily ornamented solo line in the right hand over continuous even semiquavers in the left and a detached pedal underneath. It is the *hand-and-foot independence problem in its purest form*. Calling its two-manual layout a "manual change at the start" also misreads the piece — nothing changes; two divisions are in play throughout. The pedal line is indeed learnable in days, and the piece is a fine choice musically, but it is grade 2-3 on this ladder and it is being used as the free trial: the first impression for a pianist who has never sat at a pedalboard is a trio.

The deeper problem is that principle 1 ("never as an abstract drill") removes the one thing beginners actually need at this stage — finding pedal notes by feel and by body measurement rather than by looking.

**Fix.** Either rewrite grade 1 to describe what BWV 639 is, or — better — insert a genuine grade-1 rung ahead of it and keep 639 as the free lesson's *goal*. Franck's *L'Organiste*, Bach's four-part chorale settings with a slow pedal bass, Pachelbel or Walther chorale preludes, and the manualiter movements of the Eight Little Preludes all cost 8-12 authoring hours each. And permit one class of non-repertoire task: pedal orientation drawn from the piece's own pitch set (play this line's notes as a slow ladder, without looking, naming each), which honours the principle without pretending the problem does not exist.

### F6 — The named source editions are not urtext, and one of them would import the articulation you then score (major)
*catalogue 2; spec 9.1 and principle 2*

The Bach-Gesellschaft is a 19th-century critical edition with editorial layers and known readings since rejected; it is not an urtext, and for the Orgelbuechlein the autograph and for the Schuebler chorales Bach's own corrected print are both available and both free. Peters (Griepenkerl/Roitzsch) is worse for this product specifically: it carries added slurs, phrasing and dynamics, which means a lesson engraved from it would score the learner's articulation against a Romantic editor's reading of Bach while the app's preface claims scholarly register. Spitta's Buxtehude is likewise superseded. Widor is the sharpest case: the Fifth Symphony was revised repeatedly and the Toccata's readings and tempo indication differ materially between issues — "Hamelle before 1930" does not identify a text.

**Fix.** Declare a source hierarchy in the pipeline: autograph or composer-supervised first print first, 19th-century collected edition only where nothing earlier survives, Peters excluded as a musical text (usable for reference, never as the engraving source). Record the exact source *and its date and plate* in the manifest, which the format already has room for, and name the Widor version. And note that editorial pedaling in an old edition, though free of copyright, is not free of ideology — see F2.

### F7 — The self-assessed track has no legato dimension at all (major)
*spec 6.1 skill-profile table*

"Legato control — not estimated" for the self-assessed track, next to a spec that calls articulation "the main expressive parameter" on the instrument. Forty per cent of the userbase therefore receives no development, no probe, and no adaptation on the dimension the product says is central. That is a hole in the design, not a limitation of the medium — and it is the hole that will make the non-MIDI track feel like a second-class product to exactly the people most likely to be playing a real pipe organ.

**Fix.** Give the self-assessed track two things, neither of which requires transcription. First, phone-microphone **recording for playback** (not scoring — the spec's rejection of mic transcription is correct and unrelated): the learner hears their own last take against the reference, with a targeted listening prompt ("the last chord of each phrase — do the four voices leave together?"). Hearing yourself is the closest available substitute for a teacher in the room. Second, **ear-calibration items** using the answer-key machinery already built for the Listening and analysis template: play two takes of the same bar, one with ragged releases or a late pedal, ask which is which. That calibrates the self-rating that everything downstream depends on.

### F8 — The registration model has no vocabulary for couplers, the swell box, the tremulant, or registration changes (major)
*spec 5.1, principle 5, D-6*

Generic families and a per-instrument mapping is the right instinct. But stop names are not where amateurs go wrong. They go wrong on **couplers** — the single most consequential control on the console and the one that turns a clear plenum into mud — and on the balance between divisions and the weight of the pedal, which is a listening decision, not a stop list. "Pedal 16'+8'" gives a Subbass-and-Gedackt fog on a small two-manual and drowns the manuals on an instrument with an open wood. Then there is the **swell box** and the **tremulant**, both absent from the model: the Boellmann in your own launch six is a piece about box technique and adding weight, and BuxWV 208's coloratura wants a tremulant. And the hardest practical question in the Boellmann and the Mendelssohn is *who changes the stops* — no assistant, no sequencer on most instruments, so registration is a choreography of hands-free adds or a crescendo pedal, not a list.

**Fix.** Extend the family vocabulary with couplers, box, tremulant, and a change timeline (bar, action, foot/hand free?). Give each proposal as **three concrete recipes** — small two-manual, neo-baroque tracker, romantic three-manual with box — rather than one abstract one, plus a balance *procedure*: "play the pedal line and the melody alternately; the pedal must be present and never louder."

### F9 — The Pachelbel is misgraded and its pedal is called optional (major)
*catalogue 3*

The Ciacona in F minor is Pachelbel's most serious organ work: twenty-two variations, chromatic, seven to eight minutes, with a bass line that is a pedal part. Grade 2 is defined as "walking bass, occasional leap of a fifth, first heel use / 2 to 3 pages". "Optional pedal" guts the piece — the ground *is* the pedal — and the stamina demand alone puts it a grade above where it sits. Six sections for twenty-two variations is also far too coarse for an engine that selects by section.

**Fix.** Grade 3, pedal not optional, and section it by variation groups (the natural groupings of texture and figuration), which also gives the adaptivity engine the modular practice unit that makes a chaconne the ideal teaching piece in the first place.

### F10 — The Mendelssohn entry is one movement of a three-movement sonata (major)
*catalogue 3; spec 1 "one lesson is one piece"*

"Sonata no. 6 op. 65, chorale and variations" is the first movement. The Fuga and the Finale are where the work resolves, and variation 4's running pedal — correctly tagged — is not the piece's summit, the fugue is. Serving the movement alone while the product promises "complete classical pieces" is exactly the kind of thing this audience notices.

**Fix.** Either author the whole sonata (and re-estimate the hours honestly), or title the lesson as the movement it is and say in the commentary why it stands alone and what follows. The second is defensible; silence is not.

### F11 — Sight reading is tested on material the learner has already studied (major)
*spec 5.2 "Sight reading" template*

The template reads a section of the piece the lesson is about, after the orientation, the bar map, the form outline and the reference performance. Nothing about it is unseen. Worse, organ sight reading is a specific skill — three staves plus a pedal line whose fingering and *pedaling* must be invented in real time — and it is the skill the church-organist half of the persona needs most.

**Fix.** Ship a small separate corpus of unseen material: Franck's *L'Organiste*, four-part chorale harmonisations, easy hymn-tune settings. All public domain, one engraving pass each, no reference recording needed. Or cut the template.

### F12 — The reference-recording estimate is fiction, and which take is the reference is undefined (major)
*catalogue 4 effort model; spec 9 step 6 vs D-26*

Two hours to record MIDI and audio, per section plus a full performance, aligned to the score, for a piece like the Widor Toccata or BWV 565. That is a day's work at minimum for takes of a standard this audience will accept as a model, and the estimate is doing a lot of load-bearing in the six-versus-ten decision. Separately: spec 9 says "in one take" and D-26 agrees, while the effort model says "one take per section plus a full performance". Sectional takes will differ in tempo and articulation from the complete take. The scoring pipeline reads `reference.mid` as *the* reference for articulation. Which one is it?

**Fix.** Split the estimate into recording, retakes, and alignment, and scale it by grade — the Widor is not the Brahms. Define the reference explicitly: the complete take is the interpretive reference and the tempo source; sectional takes, if kept, are practice aids and are never the articulation reference.

### F13 — BWV 565: silence on attribution, and the free recitative breaks the aligner (major)
*catalogue 3 and 3.2; architecture 5.3-5.4*

Two problems. The scholarly one: the attribution has been seriously contested since Williams, and a product whose second principle is "commentary at the level of a good edition preface" cannot publish this piece without the discussion. Handled well, it is a gift — it is the most interesting piece of musicology in the entire catalogue. Handled by omission, it is embarrassing. The technical one: your own grading table names "free rhythm sections" as a grade-5 property, and the scoring pipeline aligns against a metronome grid with a +-2-beat window and a tempo curve knotted every two bars. The opening flourish, the recitative passages and the coda have no metrical grid to align to. The piece the marketing depends on is the piece the scoring model cannot handle.

**Fix.** Mark sections as *metrical* or *free* in `sections.json`. In free sections, disable timing and articulation scoring entirely and score pitch and order only, with the analysis screen showing an overlay against the reference rather than a verdict. Say so in the lesson. And write the attribution paragraph.

### F14 — Target tempo is a single number and the acoustic is nowhere in the model (major)
*spec 5.3, 6.3 rule 4; architecture 6.2, package `sections.json`*

The whole staircase converges on one target tempo per section, taken from the organist's take on the organist's instrument in the organist's building. There is no correct tempo for a chorale prelude — the room decides. A learner in a dry practice cell and a learner in a five-second church need materially different tempi for the same articulation to read as the same music, and driving both to one number teaches one of them to play badly.

**Fix.** Make the target a range per section, with the commentary stating which end suits which acoustic, and add reverberation time (a three-way choice: dry / church / very live) to the instrument profile. Let it shift the staircase's ceiling. Relatedly, note that a metronome is inaudible at a real console in a live building — the count-in and a pulse the learner internalises matter more than a click, and "secured only ever with the metronome" is not secured.

### F15 — Ornaments are handled as a scoring tolerance rather than as content (minor)
*architecture 5.1; catalogue 3 (BWV 731, BuxWV 208)*

"Any of the ornament's realisations accepts" is a sensible engineering hedge, but the ornament is where a large part of the teaching lives in this repertoire, and an enumerated realisation set will punish stylistically correct playing the author did not think of — particularly in BuxWV 208, where the written line is already a coloratura and further freedom is expected. "Trills on a held voice" in BWV 731 is not a tolerance question at all: it is a fingering problem (trilling 2-3 while the thumb holds).

**Fix.** Ship Bach's own *Explication* from the 1720 Clavier-Buechlein and the relevant French agrement tables as orientation assets (public domain, high delight, near-zero cost), let the author mark passages as *ornamentation free*, and give the held-voice trill an authored fingering rather than a scoring exemption.

### F16 — The retention probe fires cold at the start of every session (minor)
*spec 6.3 rule 1; architecture 6.3 rule 2*

An organ session starts with the body: the feet have to find the pedalboard again. Opening with a probe on the oldest secured section at its achieved tempo will fail for reasons that have nothing to do with retention, and the engine then halves the interval and corrupts the profile.

**Fix.** Run one short warm-up cell first, or run the probe's first attempt a step below target and only count a fail on the second.

### F17 — The MIDI model assumes one device and defers the cohort most able to use it (minor)
*spec 7.1, D-30; architecture 5.2*

On a great many consoles the pedalboard is a separate MIDI device on its own port, not a channel on one — so the channel-map model misses the split that matters most. And Network MIDI is deferred, which removes the Hauptwerk/GrandOrgue users: the most MIDI-capable, most technically willing segment of the 60 %, whose console USB is already occupied by the computer running the organ.

**Fix.** Support multiple simultaneous MIDI sources with a per-source part mapping, not just channels within one. And either bring RTP forward or document a splitter/thru path for the virtual-organ cohort in onboarding, because they will try on day one.

## 3. Enhancements

**E1 — Two editorial layers, toggled: early and modern.** Ship both an alternate-toe/early-fingering layer and a heel-toe/modern layer for the pieces where both are defensible, with a one-paragraph statement of what each assumes and why. Nothing else on the market does this, it turns F2 from a liability into the product's signature, and it is an annotation layer — cheap next to a second recording. For paired "good-bad" manual fingering in the Baroque pieces, the same layer carries the historical fingering that produces the articulation, which is a far better way to teach touch than telling someone to imitate a gap.

**E2 — Hear yourself, then calibrate your ear.** Phone-mic recording for playback comparison (not transcription) plus A/B ear-calibration items built on the existing answer-key infrastructure: two takes of the same bar, one with a late pedal entry or unsynchronised chord releases, which is which. This is the highest-value thing available to the 40 % without MIDI, it fills F7, and it improves the reliability of every self-rating downstream — which the adaptivity engine explicitly depends on.

**E3 — An acoustic switch on the built-in sound.** Let the learner hear their own attempt and the reference through a dry, a church, and a very live acoustic. This is the fastest way to teach why articulation exists on this instrument: the same detached quaver that sounds fussy dry sounds necessary at four seconds, and the same legato that sounds warm dry turns to porridge. It directly supports the articulation teaching, it makes the acoustic setting in F14 tangible, and it costs one convolution reverb and three impulse responses.

**E4 — Registration recipes per instrument archetype, with audio.** Three concrete registrations per piece — small two-manual, neo-baroque tracker, romantic three-manual with box — each with a fifteen-second audio demo recorded during the reference session, plus the balance procedure from F8. An amateur with one specific instrument does not need an abstraction, they need to know what to pull on Sunday.

**E5 — A source-critical layer in the score view.** Tap a note, see the variant: "the BG reads e-flat; the autograph has e-natural." Ship the ornament tables (F15) and the sources' own prefaces alongside. This is the exact register the spec claims and almost never delivers, it costs authoring time rather than engineering, and for a subscriber who already owns three editions of the Orgelbuechlein it is the thing that justifies the twelve francs.

## 4. One thing to cut from v1

**The Memory template** (spec 5.2; architecture 6.3, and its share of authoring time).

Organists play from the score. Memorisation in this repertoire is a recitalist's specialism, it is largely kinaesthetic and registration-bound, and it is close to worthless for the two people this product is actually for — the pianist learning the pedalboard and the church musician who needs Sunday's music secure. Worse, progressively hiding the score at the console removes the one thing keeping the learner's eyes *up*, and the eyes that leave the page go straight to the feet. That is the single habit adult organ students spend years unlearning, and this template rewards it.

Spend the slot on a **continuity template** instead: play the section through without stopping, from a cold start, without a preparatory run — a stop or a restart counts as a fail, and the score shows a recovery point every two bars rather than a hidden staff. That measures the thing that actually decides whether a piece is playable in public, it needs no new authoring beyond a recovery-point pass in sectioning, and it gives the repertoire list a meaningful second column: not just "secured at 88", but "played through cold". <!-- slop-allow: verbatim panel transcript -->
