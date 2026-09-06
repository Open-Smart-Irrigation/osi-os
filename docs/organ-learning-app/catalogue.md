# PocketMaestro: catalogue plan (draft 0.1)

Companion to [spec.md](spec.md), section 9. Everything here is a proposal for
the in-house organist to revise; the grading criteria are the part most worth
arguing about, because the adaptivity engine and the free-lesson choice both
depend on them.

## 1. Grading scale

Six grades, defined by the hardest sustained demand in the piece rather than
by its overall length. A piece with one demanding bar is graded for that bar
and the bar is flagged in the difficulty annotations.

| Grade | Pedal | Manuals | Texture and tempo | Typical length |
|---|---|---|---|---|
| 1 | Slow bass line, stepwise or small leaps, toes only, no crossing | Two-voice or chordal, one manual | Chorale prelude at a quiet tempo | 1 to 2 pages |
| 2 | Walking bass, occasional leap of a fifth or more, first heel use | Ornamented line over accompaniment, one manual change | Moderate tempo, three or four voices | 2 to 3 pages |
| 3 | Independent pedal voice at moderate tempo, crossings, simple heel-toe | Cantus firmus in an inner voice, two manuals in use | Trio-like independence, ritornello form | 3 to 5 pages |
| 4 | Pedal melody or sustained motion, wide leaps, heel-toe throughout | Rapid repeated figuration, frequent manual changes | Fast steady tempo with stamina demand | 4 to 8 pages |
| 5 | Pedal solo passages, double pedal | Contrapuntal four-voice fugue, virtuoso passagework | Free rhythm sections, long fugue | 8 to 12 pages |
| 6 | Pedal theme against fast manual figuration for the whole piece | Toccata figuration at high tempo, double-note passages | Sustained virtuosity | 6 to 12 pages |

The ladder is meant to be climbed by a pianist with no pedal experience who
starts at grade 1. Grades 1 to 3 teach pedal technique inside the pieces;
grades 4 to 6 assume it.

## 2. Licensing check

Public domain in Switzerland and the EU means the composer died more than 70
years ago. The edition used as source must also be free: engraving in house
from an old edition or autograph facsimile avoids the question, and no
fingering or pedaling from a protected edition is copied.

| Composer | Died | Public domain (CH, EU) | Safe source editions |
|---|---|---|---|
| J. S. Bach | 1750 | Yes | Bach-Gesellschaft (1851 to 1899), Peters editions before 1930 |
| Buxtehude | 1707 | Yes | Spitta edition (1875 to 1876), Breitkopf collected works before 1930 |
| Pachelbel | 1706 | Yes | Denkmäler der Tonkunst in Bayern (1901) |
| Brahms | 1897 | Yes | First edition of op. 122 (Simrock, 1902) |
| Mendelssohn | 1847 | Yes | First edition of op. 65 (Coventry, 1845) |
| Boëllmann | 1897 | Yes | First edition (Durand, 1895) |
| Widor | 1937 | Yes since 2008 | Hamelle editions before 1930 |
| Vierne | 1937 | Yes since 2008 | Hamelle and Lemoine editions before 1930 |
| Franck | 1890 | Yes | Durand first editions |

Editions to avoid as sources: Dupré's Bach and Franck editions (Dupré died
1971), Bornemann's Bach (1938 onwards, editor died 1998), the Neue
Bach-Ausgabe (Bärenreiter, under copyright), and any modern urtext. The
United States is not a launch market, but for completeness every piece above
was published before 1930 and is public domain there too.

## 3. Launch ladder

The ten pieces from draft 0.2, now with grade, sections, technique tags, and
an authoring estimate. Sections are counted, not yet defined by bar numbers;
bar numbers are fixed during authoring.

| Grade | Piece | Sections | Technique tags | Hours |
|---|---|---|---|---|
| 1 | J. S. Bach, "Ich ruf zu dir, Herr Jesu Christ" BWV 639 | 3 | trio texture, toes-only pedal, legato melody, manual change at the start | 14 |
| 1 | Brahms, "Es ist ein Ros entsprungen" op. 122 no. 8 | 3 | chordal legato, finger substitution, quiet pedal | 15 |
| 2 | J. S. Bach, "Liebster Jesu, wir sind hier" BWV 731 | 3 | ornamented cantus, walking pedal, trills on a held voice | 16 |
| 2 | Pachelbel, Ciacona in F minor | 6 | variation form, optional pedal, manual changes between variations | 22 |
| 3 | J. S. Bach, "Wachet auf, ruft uns die Stimme" BWV 645 | 5 | tenor cantus in LH, ritornello, independent pedal, two manuals | 24 |
| 3 | Buxtehude, "Nun bitten wir den heiligen Geist" BuxWV 208 | 3 | North German ornamentation, coloratura over pedal | 16 |
| 4 | Boëllmann, Toccata from Suite gothique | 5 | repeated figuration, pedal melody, stamina, registration build | 28 |
| 4 | Mendelssohn, Sonata no. 6 op. 65, chorale and variations | 6 | Romantic legato, manual changes, running pedal in variation 4 | 34 |
| 5 | J. S. Bach, Toccata and Fugue in D minor BWV 565 | 9 | pedal solo, free rhythm, fugue with pedal subject, recitative coda | 44 |
| 6 | Widor, Toccata from Symphony no. 5 | 6 | staccato figuration at tempo, pedal theme, double-note passages | 40 |

Total: 253 hours for all ten.

### 3.1 The free lesson

BWV 639 is the free lesson. It has a real pedal line that any pianist can
learn in days, one manual change, and enough musical weight that finishing it
feels like an achievement. It is also short, so the whole adaptive cycle
(isolation, pairing, full texture, retention) can be experienced in two or
three weeks.

### 3.2 Two launch scopes

| Scope | Pieces | Authoring hours | Grades covered |
|---|---|---|---|
| Six at launch | BWV 639, Brahms op. 122/8, BWV 731, Pachelbel Ciacona, BWV 645, Boëllmann Toccata | 119 | 1 to 4 |
| Ten at launch | All of section 3 | 253 | 1 to 6 |

The difference is 134 hours, which at 20 hours per week is seven weeks of the
organist's time taken from the app build. The six-piece scope covers the
grades most learners start in and includes one aspirational piece (the
Boëllmann). BWV 565 and the Widor are marketing assets and belong in the
first quarter after launch, announced in the store listing as coming.
Recommendation: six at launch (A-10 in the spec).

## 4. Authoring effort model

Hours per step for a piece of average length (4 pages); the estimates in
section 3 scale these by page count and texture.

| Step | Hours | Notes |
|---|---|---|
| Source selection and licensing note | 0.5 | Record source edition and its date in the package metadata. |
| Engraving in MuseScore and MusicXML export | 6 | About 1.5 hours per page for three-staff organ music with ornaments. |
| Proofreading on device | 1.5 | Against the source, in landscape on the phone. |
| Fingering and pedaling, marked editorial | 3 | Faster once the organist has performed the piece. |
| Sectioning and difficulty annotations | 2 | Per-bar tags; the tool pre-fills texture class and voice count. |
| Commentary in German and English | 4 | Written once, translated once; the tool holds both side by side. |
| Analysis questions | 1 | Three to six per piece. |
| Per-piece achievements | 0.5 | Two or three per piece. |
| Reference recording, MIDI and audio | 2 | One take per section plus a full performance; alignment in the tool. |
| Validation on the console | 2 | Every exercise configuration played once; self-assessed walk-through. |
| Total | 22.5 | |

The tool features that save the most hours are MusicXML import with automatic
staff-to-part mapping, pre-filled annotations, and automatic MIDI-to-score
alignment; those three are the authoring tool's first milestones.

## 5. Second quarter and beyond

Two pieces per month after launch, at roughly 25 hours each, is 50 hours a
month of authoring; alongside app maintenance this is a full-time load for
one person. One piece per month is the sustainable rate once the four
remaining launch-ladder pieces are done. Candidates, in a suggested order:

| Grade | Piece | Reason |
|---|---|---|
| 2 | J. S. Bach, Prelude and Fugue in C major BWV 553 | Short fugue, first fugue for the ladder |
| 3 | J. S. Bach, Pastorella BWV 590, first movement | Drone pedal, siciliano rhythm |
| 3 | Franck, Prélude from Prélude, fugue et variation op. 18 | Lyrical manuals, gentle pedal, French legato |
| 4 | Buxtehude, Praeludium in G minor BuxWV 149 | Stylus fantasticus, pedal solo of moderate difficulty |
| 4 | Vierne, Berceuse from 24 pièces en style libre | Harmonic study, soft registration, expression |
| 5 | Vierne, Carillon de Westminster | Ostinato theme against figuration; a crowd favourite |
| 5 | J. S. Bach, Prelude and Fugue in G major BWV 541 | Athletic pedal, joyful fugue |
| 5 | Mendelssohn, Sonata no. 2 op. 65, Fugue | Romantic fugue writing |
| 6 | J. S. Bach, Passacaglia BWV 582 | The summit of the pedal ostinato repertoire |

Learner requests, collected in the app with a one-tap "I want to learn
this", feed the order after the first year.
