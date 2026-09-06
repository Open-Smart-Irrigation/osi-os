# Panel seat: product strategist (verbatim report)

Reviewed 2026-09-06 against spec 0.6, catalogue 0.1, architecture 0.2.
Persona: product strategist for niche prosumer subscription apps; solo-founder
economics, music-app comparables, funnels, retention. Verbatim transcript;
the adjudication is in [../panel-review-2026-09-06.md](../panel-review-2026-09-06.md).

## 1. Verdict

This is a viable *asset*, not a viable *business as framed* — and the difference decides whether the founder is happy in eighteen months or bitter. The addressable population here is genuinely tiny: roughly 35,000 mostly part-time church organists in Germany, ~13,000 AGO members in the US, low thousands each in RCO/IAO/GdO, and a Hauptwerk/GrandOrgue community in the low tens of thousands worldwide. After filtering for "adult, reads music, wants structured self-study, will pay CHF 12/month, and will find you" you are fishing in a pond of maybe 30,000-60,000 people across DACH + anglophone. That pond supports a few hundred subscribers eventually, not a few thousand — which is fine, because the plan's burn is near zero and the marginal cost of a subscriber is zero. The right framing is: **a teaching practice with a compounding software asset, run alongside the founder's organ income for three years**, where every authored lesson is simultaneously a product SKU, a YouTube film, and a marketing asset. The plan as written breaks that framing in three places: it launches on the platform holding roughly a third of the money, it has no acquisition mechanism at all (a free lesson is a conversion step, not a growth loop), and it trades the founder's scarce authoring hours for tutoring priced at about a third of the Swiss market rate. Fix those three and year one is a legitimate signal-gathering year at ~CHF 8-10k. Leave them and the founder will conclude the market doesn't exist, when what actually failed was distribution.

## 2. Ranked findings

### F1 — BLOCKER: Android-first + phone-first points the product away from where this demographic and its money live
*spec.md 14.2 (D-33), 8 (D-3), 15 minimum OS, A-8*

The App Store takes roughly two-thirds of global consumer app spend despite Play's larger install base, and the skew is worse for this cohort: affluent classical enthusiasts aged 45-70 in CH (~55-60% iOS), UK (~50%), US (~57%). Germany/Austria are the only markets in your set where Android leads, and they lead on units, not spend. More damning: **forScore is iOS/iPadOS-only and is the de facto sheet-music reader for exactly this audience; Newzik is iOS-first.** That is not a coincidence — the music desk device in the organ world is an iPad. Launching Android-only and phone-only means shipping to perhaps 30-35% of your revenue market on a form factor the audience has already rejected for reading notation. Your realistic 70 year-one subscribers become ~25, which is below the threshold where you can tell signal from noise and decide whether to keep going.

The technical justification is also weak. The claim that "Android's USB host MIDI is the better-trodden path" is questionable — class-compliant USB MIDI over CoreMIDI is the single most battle-tested path in mobile music, because every iPad-using musician does it. And Expo/EAS builds iOS binaries without a Mac, so the incremental cost is $99/year plus review.

**Fix:** In the phase-0 spike (14.4), test the MIDI package on *both* platforms, not one — budget three extra days and the $99 Apple account. If CoreMIDI works (likely), ship iOS and Android simultaneously at B3, or flip the order. Separately, promote tablet layout from A-8 "later" to a B3 requirement: a `useWindowDimensions` breakpoint that renders two systems and larger glyphs on >=8" screens is days, not weeks, given the renderer already reflows. Keep phone-first as the *design constraint*; do not keep it as the *only supported form factor*.

### F2 — BLOCKER: there is no acquisition mechanism anywhere in the three documents
*spec.md 12 (funnel is one row: "the free lesson is the trial"); no distribution section exists*

The free-lesson-forever decision (D-17) is a good *conversion* instrument and a bad *funnel*, because it only acts on people who already installed. Nothing in the plan puts a person on the store page. And ASO cannot do that job here: store search for "Orgel lernen" / "organ lessons" is low-hundreds-of-searches territory, and the "organ" keyword itself is owned by dozens of Hammond/organ-sound toy apps whose traffic is the wrong traffic. You will not rank, and you would not want the ranking if you got it.

Three loops exist and none are in the docs:

1. **Institutional (highest leverage, lowest effort).** The *Kirchenmusikalische C-Ausbildung* courses run by every German Landeskirche and Catholic diocese, plus the Swiss equivalents, train hundreds of adult part-time organists annually whose curriculum is literally "pianist learns pedal technique inside repertoire." That is your ICP, pre-assembled, with a decision-maker per cohort. Also: Gesellschaft der Orgelfreunde (~4,000-5,000 German-speaking members, exactly this demographic), AGO's chapter structure and *The American Organist*, RCO, IAO. <!-- slop-allow: verbatim panel transcript -->
2. **YouTube organ scene.** Paul Fey, Anna Lapwood, Jonathan Scott, Fraser Gartshore and the surrounding channels have built audiences in the hundreds of thousands from *exactly* the asset your founder already produces. See E2.
3. **Hauptwerk / GrandOrgue forums and Contrebombarde.** By definition the MIDI-capable segment. See F7 for why launch currently locks them out.

**Fix:** Add a "Distribution" section to spec.md with named targets, an owner, and a weekly hour budget carved out of the 20 (D-32) — I would take 4 h/week from build, permanently. Recruit the 20 closed-test testers (D-36) *from AGO/GdO chapters and one C-course cohort* rather than from friends, so compliance and seeding are the same act, and ask each for a Play review at launch.

### F3 — BLOCKER: no analytics + no email + no push makes the funnel unmeasurable, the thresholds untunable, and lapsed learners unreachable — and this contradicts the plan's own tuning strategy
*spec.md 14.2 (Analytics: none; Push: none), 15 Privacy, D-38; architecture.md 9 "kill switch", 6.5 "beta tuning is a data change"; spec A-1*

Three internal contradictions:

- 5.3 marks pass thresholds as placeholders "to tune with data (A-1)" and arch 6.5 says constants are tuned in beta — but attempts never leave the device, and analytics are absent. After the 20 testers stop hand-delivering backup zips, you can never tune again.
- The entire subscription promise is "new lessons as they are published" (12), and you have no channel to tell anyone a lesson published. Store listings don't notify.
- Conversion decisions happen 2-3 weeks post-install (catalogue 3.1: BWV 639 takes 2-3 weeks), with no way to observe or influence that window.

Data you don't collect is not recoverable later. This is the finding with the shortest expiry.

**Fix, three pieces, all compatible with the device-local principle and revDSG:**
- **Local scheduled notifications** (not remote push). Expo does this with no server, no account, no personal data: practice reminders, "your retention probe on the BWV 645 fugue is due," "a new lesson is available to download." The spec conflates local with remote under "No push at launch." This is roughly two days of work and is the single largest retention lever available under D-38.
- **Anonymous, opt-in metrics** — install, activation (first attempt), free-lesson completion, paywall view, conversion, plus aggregate attempt verdicts for threshold tuning. Self-hosted PostHog on the container you're already paying for. Default on for beta, prompted at launch.
- **Email capture as an explicit, valued opt-in**: "tell me when a new lesson ships." Not an account, not a wall. For a product whose value prop *is* new content, this list is the asset — and it becomes the account migration path when iOS sync arrives.

### F4 — MAJOR: the tutor session is underpriced by ~3x and its booking system is the worst effort-to-revenue line in the plan
*spec.md 13 (D-19, D-31), 14.2 tutor payments (A-14), 19 R-1; architecture.md 2 `apps/booking-api`, 9*

Unit economics of one session as specified:

| Line | Value |
|---|---|
| Price | USD 100 / 2 h |
| Less Stripe | ~USD 96.60 (~CHF 86) |
| Time actually consumed | 2 h session + ~0.5 h prep (lesson map, attempts) + ~0.3 h notes writeback + scheduling |
| Effective rate | **~CHF 30/hour** |
| Swiss private organ lesson, market | CHF 80-120/hour |

You are selling a Swiss professional organist's time at roughly a third of local market rate, and building bespoke infrastructure to do it. The opportunity cost is worse than the cash cost: an authoring hour produces an asset that earns from every future subscriber forever; a tutoring hour earns once. At 22.5 h/lesson (catalogue 4), each fully-booked tutoring week destroys most of a lesson.

The volume math makes it worse. At a realistic 50-100 year-one subscribers, expect on the order of 20-30 bookings in year one — about CHF 2,000 net — in exchange for the Hono service, Postgres, Stripe webhooks, slot calendar, tutor web view, consented snapshot upload, the VAT question (R-1), and the App Store 3.1.3(d) / Play exemption review risk. Ten slots/week (D-31) fully booked would be 30 h/week including prep against a 20 h/week total budget — the ceiling is set above the founder's entire capacity.

**Fix:** Price at CHF 150 for 90 minutes (~CHF 100/hour, at market, and the shorter format is pedagogically better for remote). Cap at 2 slots/week, not 10 — scarcity is correct here and protects authoring. And see section 4 for the build.

### F5 — MAJOR: value is framed as catalogue depth, which is the one axis where you lose 500:1
*spec.md 12; catalogue.md 3.2*

Six pieces at CHF 12/month invites the comparison the product cannot win: flowkey at ~EUR 19.99/mo with 1,500+ songs, Tomplay at ~EUR 12.99-17.99 with thousands of interactive scores, Simply Piano at ~$150/yr. Anyone building a comparison table kills you on the first row. Nothing in 12 states the anchor you *do* win on.

The correct anchor is not a library. It is a teacher. One CHF 96 annual subscription is roughly **one hour** of a private organ lesson in Switzerland, and the product delivers structured practice for a year. That framing also makes six pieces a feature — a curriculum, not a catalogue — and it is defensible against every comparable, because none of them teaches organ at all.

**Fix:** Rewrite 12's tier table with the anchor stated ("CHF 96/year — less than one hour with an organ teacher"), and rewrite the store listing around *lessons and technique acquired*, never piece counts. Never show a number-of-pieces figure in marketing. Second: rename the unit consistently to "lesson," which the spec already does internally (4) but the catalogue doc undermines by counting pieces.

Related pricing correction: CHF 12/96 makes annual only a 33% saving, which is too weak a nudge given that annual is worth roughly 1.6x monthly in LTV here (monthly ~CHF 10.20 net x ~8 months ~ CHF 82; annual ~CHF 81.60 net x ~1.6 renewals ~ CHF 130). **Move monthly to CHF 15 and hold annual at 96** — a 47% saving, annual as the default-selected option. This also front-loads cash for a founder who needs it, and it neutralizes the completion-churn moment in F6 by moving the cancel decision to a renewal date instead of a "finished the catalogue" week.

### F6 — MAJOR: the catalogue spreads across grades 1-4 when per-learner depth is what retains
*catalogue.md 3, 3.2, 5*

A learner does not consume "six pieces." A grade-3 learner consumes the grade-3 pieces: **two**. At 1 lesson/month sustainable throughput (catalogue 5 concedes 2/month is a full-time load), year-end is ~18 pieces across 6 grades — still three per band. Meanwhile churn in hobbyist learning products concentrates precisely at "nothing here is my next step," and the product has no channel to survive that moment (F3).

**Fix:** Own grades 1-3 completely and defer 5-6 entirely as *lesson* content. Grades 1-3 are also the largest segment (the pianist-to-organist transition), the segment with zero competition, and the segment where the free lesson's promise generalizes. Target six pieces per grade in 1-3 before authoring anything at grade 5. Then reserve BWV 565 and the Widor for the marketing role they actually serve — see E3, which gets you the most famous 30 seconds in organ music for ~6 hours instead of 44.

### F7 — MAJOR: "60% can connect MIDI" is an unevidenced assumption recorded as a decision, and it funds roughly half the engineering
*spec.md 2, 7.1, D-1; architecture.md 5, 7*

D-1 sits in the decisions table with no source. Interrogate it segment by segment and it looks optimistic:

- **Church consoles**: MIDI out is uncommon outside recent digital instruments. Most pipe organs: no.
- **Digital home organs** (Johannus, Content, Viscount, Allen): yes — this is the real MIDI segment.
- **Hauptwerk / GrandOrgue**: MIDI-capable by definition and the *densest* concentration of your MIDI users — but their console MIDI is already cabled into a PC, and **7.1 defers Network MIDI (RTP) to "later."** Launch therefore excludes the segment with the highest MIDI density and the highest willingness to pay (these are people who spend EUR 1,000+ on sample sets).

Reachable MIDI at launch is plausibly 25-35%, not 60%. That does not kill the scored track — the scored track is your differentiation and the reason CHF 12 is defensible against IMSLP-plus-a-metronome — but it changes the sequencing.

**Fix:** (a) Validate D-1 with the 20 testers before B2 — one question at recruitment: *what instrument do you practise on, does it have a MIDI or USB socket, and is it free?* Record the real number and demote D-1 to an assumption. (b) Move RTP-MIDI from "later" into B2. Reaching a Hauptwerk rig over the local network is a bounded piece of work and unlocks your best segment. (c) Because the self-assessed track is now the majority path, make it first-class in marketing, not the fallback — 3 principle 6 has this right internally, but the store listing must say "works on any organ, MIDI optional."

### F8 — MAJOR: device-local loss protection will not survive contact with a 60-year-old organist, and Android-to-iOS migration is unaddressed
*architecture.md 4.1 (A-1), 9; spec.md D-38*

"Export a zip through the system share sheet" is a feature a small single-digit percentage of any consumer base ever uses, and this cohort skews older than average. Realistically the first phone loss or upgrade destroys a year of practice history, and that user does not come back. Worse, the plan's own upgrade path creates the failure: an Android subscriber who buys the iPad this audience is drawn to (F1) has **no entitlement transfer** — store entitlements don't cross platforms without an account — and no progress transfer. You will be issuing refunds by hand.

**Fix:** Enable Android Auto Backup (`allowBackup` with a backup agent covering the SQLite file) so restore is automatic on device change, with the manual export kept as the explicit/portable path. Then make the F3 email opt-in double as the pre-account: an email on file at launch means that when accounts arrive with iOS you can bind existing progress and existing entitlement to a person instead of a device. Add a line to 14.3/9 stating the cross-platform entitlement policy *before* launch, not after the first request.

### F9 — MINOR: the Play closed-test requirement is smaller than stated, and there is a cheaper way around it that also closes R-1
*spec.md 14.3, D-36, 19 R-1*

Google reduced the personal-developer-account closed test from 20 testers to **12 testers over 14 continuous days** (late 2024 — verify current policy text before planning around it). More usefully: the requirement applies to *personal* accounts. A Swiss Einzelfirma plus a free D-U-N-S number gets an **organization** Play account, which is exempt from the closed-test gate, keeps the founder's home address off the public store listing, and simultaneously gives R-1 a clean answer on VAT and invoicing for tutor sessions. Registration cost is on the order of CHF 120 and it removes an item from the launch critical path.

**Fix:** Get the D-U-N-S in week 1 of phase 0 (it takes days to weeks and is free). Still recruit 20 testers — but for F2 seeding reasons, not compliance ones.

### F10 — MINOR: the name carries no category signal, and it collides inside your own repo
*spec.md 11, D-16, D-24; architecture.md 11 (Maestro flows)*

"PocketMaestro" tells a store visitor nothing about organs, competes semantically with a card scheme and a dozen "Maestro" apps, and — awkwardly — with the Maestro UI-testing framework listed in architecture 11. In a category where you will never win generic search, the store *title* is your only free keyword slot.

**Fix:** Play title limit is 30 characters. Ship as `PocketMaestro: Organ` (20 chars) or `PocketMaestro - Orgel lernen` on the DE listing, with "organ / Orgel / pedal / Kirchenorgel" worked into the short description. Run a trademark search (Swiss IGE + EUIPO) before the brand exploration in D-34 spends design hours on a name that may not survive.

## 3. Enhancements

**E1 — An institutional seat SKU, priced for cohorts.** CHF 60/seat/year at 10+ seats, sold to *Kirchenmusikalische C-Ausbildung* course leaders, Landeskirchen and diocesan music offices, AGO and GdO chapters, and conservatory continuing-education programmes. One email exchange with one C-course of 25 students is CHF 1,500 and 25 subscribers — more than a month of organic acquisition, with a decision-maker who repeats annually and whose curriculum already matches grades 1-3. Ten such relationships would exceed everything else in year one combined. This needs no code beyond a promo-code redemption path (RevenueCat handles offer codes), so it is the cheapest revenue in the plan.

**E2 — One lesson, one film.** catalogue 4 already budgets 2 hours for recording the reference performance as MIDI and audio (D-26). Add a camera and a second angle on the pedalboard and the same session yields a YouTube video at near-zero marginal cost. A founder-organist who can play *and* explain is holding the exact asset the organ YouTube scene rewards, and the app becomes the CTA under the video rather than a thing nobody can find in a store. This converts the 22.5 h/lesson from pure cost into cost-plus-marketing, which materially changes whether 1 lesson/month is affordable.

**E3 — Ship the BWV 565 pedal solo as a free standalone showcase exercise.** Full lesson authoring is 44 hours (catalogue 3); the opening pedal solo and toccata bars alone are perhaps 5-6. That gets you: the most recognizable passage in organ music as your primary store screenshot, the hook for E2's first video, a paywall teaser that shows what a hard lesson looks like, and press-friendly imagery — without spending the 44 hours the six-piece scope decision (D-28) correctly refused. Do the same later for the Widor opening. <!-- slop-allow: verbatim panel transcript -->

**E4 — A founding-member lifetime tier, first 150 subscribers only, CHF 249.** Your earliest adopters are the highest-enthusiasm, highest-churn-risk cohort (they will finish the catalogue fastest). Converting 100 of them into ~CHF 21k net upfront funds the build year, immunizes against completion churn entirely, and creates a genuinely evangelical group with skin in the game — the exact people who will carry E1 and E2 into their chapters. Cap it hard and close it publicly; the scarcity is real, not manufactured.

**E5 — Ship learner-request voting at launch, not "after the first year".** catalogue 5 defers the one-tap "I want to learn this." Move it to B3. It costs almost nothing, it gives you a free roadmap-prioritization signal you otherwise have no way to obtain (F3), it is a commitment device that measurably reduces the "nothing here is my next step" churn moment (F6) — and it is the most natural possible pretext for the email opt-in.

## 4. What I would cut from v1

**The in-app tutor booking system in its entirety** — `apps/booking-api`, the Hono service, Postgres, Stripe Checkout integration, the slot calendar, the tutor web view, and the consented progress-snapshot upload (architecture 2, 9; spec 13).

It is the worst effort-to-revenue trade in the plan: weeks of engineering plus a permanent operational surface, in exchange for perhaps 20-30 bookings and ~CHF 2,000 net in year one. Cutting it removes, in one stroke: the only server holding learner-facing state, the only place personal data leaves the phone, the entire Stripe/webhook/contract-test workstream, the App Store 3.1.3(d) and Play external-payments review risk (A-14), the R-1 VAT blocker on the launch path, and one of the two containers you are paying a Swiss provider to run.

Replace it with a Calendly link and a manual invoice — one screen, one URL, half a day — at the corrected price from F4 (CHF 150 / 90 min, 2 slots/week). Build the in-app version when monthly bookings exceed eight, which is the point where manual scheduling actually hurts and where the revenue justifies the code. If bookings never exceed eight, you have learned something valuable for free instead of paying six weeks to learn it.

*(I considered cutting the MIDI scoring track instead — it is a larger engineering line and serves a minority per F7. I rejected that: scoring is the only thing separating this from a PDF on IMSLP plus a metronome, and it is what makes CHF 12/month defensible against Tomplay. Cut the commerce plumbing, keep the differentiation.)*
