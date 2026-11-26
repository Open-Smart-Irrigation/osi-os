# Agronomy and world research: a fictional semi-arid East African dryland

Research for the OSI farming-simulation game. Researched 2026-11-23. The region in the game is
fictional. It is modelled on the lower-eastern Kenya drylands (bimodal rainfall, about 600 mm a
year, 900-1300 m elevation), with notes where the Sahel or unimodal East African drylands differ.
No real village, person, farm or gateway is depicted or named.

## How to read the numbers

Every number carries a provenance tag:

- **[C]**: cited. I opened the URL and saw the value myself.
- **[S]**: search-snippet. The value appeared in a search-engine summary of the URL, but I could
  not open the page itself (paywall, 403 or timeout). Use it as an indicator and re-check it
  before you rely on it.
- **[S?]**: search-snippet where the summary did not tie the value to one specific result link.
  The URL given is a candidate source from that search's result list, not a confirmed one.
- **[R]**: from this repository (path given). These are the values OSI code already uses.
- **[D]**: derived by me from cited inputs. The formula or script is named.
- **[A]**: assumed, i.e. a game-design choice. It is plausible but not sourced. Calibrate or
  replace it.

The scripts I used live in the scratchpad (`.../scratchpad/scripts/`). They are `calc.js`, which
runs the real OSI `et0.js` on the monthly normals, `vg.js`, which produces the van Genuchten and
depletion tables, and `wgen-final.js`, the weather-generator simulation. The scripts only read
from the repo.

## Five decisions that matter most

1. **Bimodal rainfall belongs to lower-eastern Kenya only.** North-eastern Uganda (Karamoja) and
   central Tanzania are *unimodal*. Karamoja is described as unimodal [C: Ocen et al. 2021]. The
   central Tanzania gridded climatology shows one season, Dec-Apr, with about 0 mm in Jun-Oct
   [C: NASA POWER]. The task brief lists them as bimodal examples, so the game should pick one
   model: bimodal (Kenya type, the recommended default) or unimodal (Sahel, Karamoja or central
   Tanzania type, offered as an alternative map).
2. **ET0 should come from OSI's own code.** Running the real
   `osi-agronomy-daily/et0.js::fao56Et0` on the monthly normals gives 3.4-5.2 mm/day and about
   1,590 mm a year [D]. Published values for nearby semi-arid Voi are 4.8-5.7 mm/day [S]. The
   game's weather generator should emit `tMinC, tMaxC, meanRhPct, windSpeedMs, solarRadMjM2` and
   rain, and let OSI compute ET0. It should not carry its own ET0 numbers.
3. **Kc values should come from `osi-crop-kc/crop-kc.json`** [R]. That file is a FAO-56
   Table 11/12 transcription. It already has maize, sorghum, millet, green gram (FAO's shared
   "green gram and cowpeas" row), dry bean, tomato, onion, cabbage and spinach. It has **no kale
   and no amaranth row** (an open question for the owner).
4. **The game needs a soil curve so it can emit SWT.** The Rosetta class-average van Genuchten
   parameters [C: USDA ARS] with field capacity anchored at 20 kPa give TAW of 135 mm/m (sandy
   loam) and 144 mm/m (sandy clay loam). The sandy loam value falls inside the FAO-56 Table 19 range (110-150 mm/m) [C]. Table 19 has no
   sandy clay loam row; 144 mm/m sits between its sandy loam and loam ranges. The
   depletion-to-kPa table (section 2.6) puts FAO's p thresholds for vegetables at 40-60 kPa.
   That lines up with the 20/50 kPa Chameleon colour bands the OSI GUI already uses [R].
5. **Weather generator:** a first-order Markov chain with gamma amounts plus a per-season
   lognormal "regime" factor (sigma 0.3). It reproduces about 580 mm a year with CV 0.33, and
   seasonal CVs of 0.55-0.59, close to the cited 45-58% [S]. It slightly **underestimates**
   flowering-window dry spells: 12% against Barron et al.'s floor of 20% [S]. A tuning knob is
   documented in section 1.6.

---

## 1. Climate

### 1.1 Rainfall totals and seasons

| Quantity | Value | Tag / source |
|---|---|---|
| Seasons (lower-eastern Kenya) | Long rains Mar-May (MAM), short rains Oct-Dec (OND) | [S] Ukambani studies, e.g. https://dx.doi.org/10.1007/s00704-009-0113-1 |
| Annual rainfall across the region | ~500 mm (lowlands) to >1,050 mm (hills) | [S] same search; https://repository.seku.ac.ke/handle/123456789/975 |
| Gridded climatology, 1,233 m semi-arid point (2001-2025) | 570 mm/yr; monthly mm: Jan 40, Feb 29, Mar 64, Apr 101, May 60, Jun 15, Jul 11, Aug 14, Sep 14, Oct 51, Nov 96, Dec 78 | [C] NASA POWER climatology API, PRECTOTCORR, lon 37.6, lat -1.8 (https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=T2M_MAX,T2M_MIN,RH2M,WS2M,ALLSKY_SFC_SW_DWN,PRECTOTCORR&community=AG&longitude=37.6&latitude=-1.8&format=JSON) |
| Station normals, semi-arid Kenya lowland (WMO, Voi) | 555 mm/yr, 58 rain days; monthly mm 34/29/79/100/30/6/3/8/15/26/106/119; rain days 5/3/8/7/5/2/1/2/3/4/10/8 | [C] https://en.wikipedia.org/wiki/Voi (WMO World Weather Information Service) |
| Drier end (Garissa, 1961-90) | 374 mm/yr, 29 rain days (>=1 mm), bimodal Apr and Nov peaks | [C] https://en.wikipedia.org/wiki/Garissa (NOAA) |
| Inter-seasonal CV | 45-58% | [S?] Katumani/Kambi ya Mawe search snippet (source paper s40066-015-0028-2, https://link.springer.com/article/10.1186/s40066-015-0028-2) |
| Long rains good / failed, 51-yr record | 31.4% good, 35.3% failed; short rains 15.7% good, 43.1% failed | [S?] same candidate |
| "Low rainfall" season threshold for maize | <=250 mm per season | [S?] same candidate |
| Seasonal rainfall trend | declining 0.15-2.1 mm/yr | [S?] same candidate |

### 1.2 Onset, false starts, dry spells

| Quantity | Value | Tag / source |
|---|---|---|
| Kenya Met onset definition | >=20 mm within 3 consecutive days, no subsequent dry spell >7 days | [S?] candidate: https://www.citizen.digital/news/kenya-met-announces-dates-for-short-rains-across-counties-n348537 (search summary) |
| Stern onset rule | 20 mm over 1-2 consecutive days | [C] Ocen, de Bie & Onyutha 2021, Heliyon 7:e08428, https://pmc.ncbi.nlm.nih.gov/articles/PMC8637494/ |
| Agronomic onset rule used for Makueni | no 10-day dry period after onset | [S] https://meteorology.uonbi.ac.ke/sites/default/files/cbps/sps/meteorology/Amukono.pdf |
| False-start probability (Uganda; highest in semi-arid NE) | 0-53% across Uganda; 0.53 in Karamoja (>=10 of 19 years) | [C] Ocen et al. 2021 (above) |
| Onset variability (CHIRPS, eastern Uganda MAM) | SD about 1 dekad (10 days); early dekad 6, late dekad 11 | [C] Ocen et al. 2021 |
| Example short-rains onset forecast (one semi-arid county, 2025) | onset 17-24 Nov, cessation 15-22 Dec | [S] https://meteo.go.ke/documents/1307/MACHAKOS_COUNTY_OND_2025_SEASONAL_FORECAST.pdf (a single season's forecast, not a climatology) |
| Dry spells >10 d around maize flowering (two semi-arid East African sites) | at least 20% probability, rising to >=70% depending on onset | [S] Barron, Rockström, Gichuki & Hatibu 2003, Agric. For. Meteorol. 117:23-37, doi 10.1016/S0168-1923(03)00037-6 |
| Agricultural dry spell >=10 d per season | 74-80% of seasons | [S] same |
| October dry-spell probability | >90% | [S] Katumani study snippet (above) |

### 1.3 Temperature, humidity, wind, radiation and ET0 by month

Inputs come from the NASA POWER 2001-2025 climatology for a 1,233 m semi-arid point, lon 37.6,
lat -1.8 [C]. Tmax and Tmin are derived as T2M ± T2M_RANGE/2 [D]; the POWER "T2M_MAX" field is a
monthly extreme, not the mean daily maximum. ET0 is the output of
`osi-agronomy-daily/et0.js::fao56Et0` with elevation 1,233 m [D, real OSI code]. Hargreaves comes
from the same module.

| Month | Tmax °C | Tmin °C | RH % | u2 m/s | Rs MJ/m²/d | **ET0 PM (OSI) mm/d** | ET0 Hargreaves mm/d | Rain mm |
|---|---|---|---|---|---|---|---|---|
| Jan | 29.3 | 15.6 | 64 | 1.54 | 23.3 | 4.78 | 5.16 | 40 |
| Feb | 30.6 | 16.2 | 60 | 1.62 | 24.2 | 5.19 | 5.55 | 29 |
| Mar | 30.2 | 16.8 | 65 | 1.64 | 23.4 | 4.99 | 5.40 | 64 |
| Apr | 28.5 | 16.4 | 73 | 1.62 | 20.9 | 4.23 | 4.79 | 101 |
| May | 27.3 | 15.1 | 74 | 1.51 | 19.0 | 3.73 | 4.36 | 60 |
| Jun | 26.9 | 13.8 | 69 | 1.47 | 16.3 | 3.37 | 4.23 | 15 |
| Jul | 27.1 | 13.2 | 64 | 1.73 | 15.8 | 3.54 | 4.41 | 11 |
| Aug | 27.7 | 13.5 | 63 | 2.20 | 17.0 | 4.00 | 4.78 | 14 |
| Sep | 29.3 | 14.2 | 60 | 2.48 | 21.0 | 4.93 | 5.36 | 14 |
| Oct | 29.6 | 15.2 | 63 | 2.32 | 21.9 | 4.93 | 5.39 | 51 |
| Nov | 28.1 | 16.0 | 73 | 1.87 | 20.6 | 4.22 | 4.79 | 96 |
| Dec | 28.0 | 15.9 | 72 | 1.63 | 21.6 | 4.29 | 4.71 | 78 |
| Year | | | 67 | 1.80 | 20.4 | ~1,590 mm/yr | | 570 |

Cross-checks:

- **Voi** (lower and hotter): ET0 148-175 mm/month, i.e. 4.8-5.7 mm/d [S]
  (https://ojs.mtak.hu/index.php/hungeobull/article/view/8466).
- **Garissa/Voi ERA5:** 4.2-5.2 mm/d [S] (https://meetingorganizer.copernicus.org/EMS2023/EMS2023-331.html).
- **Ocen et al.** use "ETo about 5 mm" for Uganda [C].
- **FAO** gives semi-arid ETo ranges of 6-7 mm/d at 15-25 °C mean and 8-9 at >25 °C [C]
  (https://www.fao.org/4/s2022e/s2022e07.htm). FAO's band is a coarse planning range; the OSI
  values are lower because RH is moderate and wind is light at this elevation.
- **Station temperatures, Voi lowland (WMO):** Tmax 28.0-33.3 °C, Tmin 17.2-20.8 °C [C]. The
  1,233 m point is about 2-3 °C cooler, which is consistent.

### 1.4 Sahel contrast (unimodal)

| Quantity | Value | Tag / source |
|---|---|---|
| Niamey airport normals, 1991-2020 | 554 mm/yr, 40.1 rain days (>=1 mm); Jun 78.6 mm/6.0 d, Jul 145.6/9.7, Aug 192.6/12.1, Sep 85.1/6.8, May 25.3/2.7, Oct 16.7/1.7; Nov-Mar ~0 | [C] https://en.wikipedia.org/wiki/Niamey (NOAA NCEI / WMO normals) |
| Niamey temperatures | Tmax 32.4 (Jan)-41.6 (Apr) °C; Tmin 16.9-28.3 °C; RH 17-74% | [C] same |
| Gridded climatology, 13.8 N 3.0 E (251 m) | Rs 20.0-23.8 MJ/m²/d; RH 12-72%; u2 1.9-3.3 m/s; rain 0-5.3 mm/d (Aug peak) | [C] NASA POWER climatology API, lon 3.0, lat 13.8 |
| Agronomic onset near Niamey | around the 3rd dekad of June; hydrological onset ~6 weeks earlier | [S] https://iri.columbia.edu/~ousmane/print/Onset/BalmeGalleLebel05_Secheresse.pdf |
| Farmer sowing rule / failed sowings | wait for a 2-day wet spell >=10 mm; ~22-23% of sowings fail after a >=7-day dry spell | [S] same search (Agric. For. Meteorol. 2011 village survey) |

Design differences for the Sahel variant: one 3-4 month season; a long, hot (40 °C) dry season
with very low RH and higher wind; pearl millet and cowpea in place of maize; replanting after a
failed sowing is a core mechanic.

### 1.5 Central Tanzania (unimodal) for reference

The NASA POWER climatology at lon 35.8, lat -6.2 (1,089 m) gives rain of 5.9 mm/d in Jan,
3.8-3.9 in Feb-Mar, 2.6 in Apr, 5.3 in Dec, and ~0 from Jun to Oct; about 730 mm/yr [C].

### 1.6 Stochastic daily weather generator (recommended)

The structure is the standard first-order two-state Markov chain for occurrence (p01 = P(wet |
dry yesterday), p11 = P(wet | wet yesterday)) with a two-parameter gamma distribution for wet-day
amounts. For Kenya and north-eastern Tanzania, a 121-station study found that first-order chains
reproduce dry/wet spell frequencies at 88%/99% of station-months, and that the gamma fits amounts
at two-thirds of stations [S] (Climate Research 59:39-60, https://int-res.com/abstracts/cr/v59/n1/p39-60).
The gamma tail is too light for extremes [S]
(https://hess.copernicus.org/articles/21/6541/2017/hess-21-6541-2017.pdf).

I found no published station table of p01, p11, shape and scale for this zone, so the parameters
are **derived** [D] from cited monthly totals and rain-day counts:

- π (wet-day fraction) = rain days / days in month, using the Voi WMO rain days [C].
- Mean wet-day amount = monthly total / rain days, using the NASA POWER totals [C].
- Persistence r = p11 - p01 [A]: 0.35 in rain-season months (Mar-May, Oct-Dec), 0.20 otherwise.
- Then p01 = π(1 - r) and p11 = r + p01.
- Gamma shape k = 0.75 [A]; scale = mean / k.
- **Seasonal regime factor** [A]: once per season (MAM and OND separately), draw
  f ~ lognormal(mean 1, sigma 0.30) and multiply both the wet-day probability and the amount
  by sqrt(f). Without this factor a plain Markov-gamma chain underestimates year-to-year
  variance, giving a seasonal CV of only 0.35-0.38 in my run.

Validation from a 2,000-year simulation (`wgen-final.js`, args `0.3 0.35 1`) [D]:

| Statistic | Simulated | Target / reference |
|---|---|---|
| Annual mean | 579-589 mm | 555-570 mm [C] |
| Annual CV | 0.33 | (no direct reference) |
| MAM / OND seasonal CV | 0.55-0.59 | 0.45-0.58 [S] |
| P(season < 250 mm) | 0.61-0.65 | "failed" long rains 35%, short rains 43% at wetter Katumani [S] |
| Short-rains onset (2-day >=20 mm, no >10-day dry spell in next 30 d) | found in ~75% of years; median Nov 6; p10-p90 Oct 14 to Dec 18; SD 23 d | onset SD ~10 d (Uganda CHIRPS) [C]; no Kenya value found |
| P(>10-day dry spell in a 30-day window, 50-80 days after onset) | 0.12-0.13 | >=0.20 [S] Barron et al. 2003 |
| P(any >=10-day dry spell in the 100 days after onset) | 0.54-0.55 | 74-80% *agricultural* dry spells [S] |
| Annual maximum daily rain | median 55 mm, p90 88 mm | (no reference) |

Two tuning knobs remain:

1. **Flowering-window dry spells:** the simulated rate (0.12) is below Barron's floor (0.20).
   - Option (a): lower p01 by about 20% from Dec to Jan and in May.
   - Option (b): add a hidden two-state "break" regime.
   - My quick try at option (b) changed this statistic very little (0.13-0.14) and raised totals,
     so I dropped it.
   - Barron's "agricultural" dry spells come from a soil water balance, so the game's FAO-56
     bucket should show them naturally.
2. **Onset spread:** my strict rule gives SD 23 days, wider than the Uganda value (one dekad).
   The game can expose the onset date as an emergent event.

Other daily variables need conditioning on wet/dry days, WGEN style [A; calibrate later against
NASA POWER daily data]:

- **Temperature:** Tmax = monthly Tmax + N(0, 1.5 °C), minus 2.0 °C on wet days; Tmin =
  monthly Tmin + N(0, 1.2 °C), plus 0.5 °C on wet days.
- **Radiation:** Rs = monthly Rs × (0.70 on wet days, 1.07 on dry days), clipped to
  [0.3·Rso, 0.95·Rso]. OSI's `et0.js` clamps Rs/Rso to [0.3, 1] internally.
- **Humidity:** mean RH = monthly RH + 10 on wet days and -3 on dry days, clipped to 15-98.
- **Wind:** u2 = monthly u2 × lognormal(sigma 0.25).

Sub-daily output is needed for the 30-minute KIWI samples the simulator emits
(`demo/model/readings.ts`):

- **Temperature:** a sine between Tmin at about 06:15 local and Tmax at about 14:30 local [A].
  Near the equator the day length is 12 h ± 10 min.
- **RH:** computed from a constant daily vapour pressure, so it is high at dawn and low in the
  afternoon.
- **light_lux:** global radiation (W/m²) × **120**. That is `luxPerWm2: 120` from
  `osi-crop-kc/crop-kc.json` [R], which OSI uses to convert lux back to radiation. Use the same
  constant so OSI's ET0-from-sensor path round-trips.

---

## 2. Soils and the soil water balance

### 2.1 Regional soils (qualitative)

- The semi-arid soils have low infiltration from **surface sealing and crusting**, low organic
  matter and high runoff [C] (Karuma et al. 2014,
  https://pmc.ncbi.nlm.nih.gov/articles/PMC4897449, citing regional work). Its own Mwala site is
  a clay loam with 39% clay [C].
- Rainfall-simulator runoff ranged from 0-71% on crusting Luvisols at a semi-arid station and
  0.2-17% at a sub-humid one [S] (search summary; Machakos-area study).
- Bare, denuded plots in a semi-arid district lost 53% of rainfall as runoff, against 38% on
  covered plots [S] (https://agris.fao.org/search/en/records/68d2a3b3b3b40a20d6188fd5).
- Game soils, recommended:
  - **sandy loam:** the default plain soil, prone to crusting;
  - **sandy clay loam:** valley-bottom or better soil;
  - optional **loamy sand:** riverbank and sand-dam areas.

### 2.2 FAO-56 soil water characteristics (Table 19) [C]

Source: https://www.fao.org/4/x0490e/x0490e0c.htm

| Soil | θFC | θWP | θFC-θWP | REW mm | TEW mm (Ze 0.10 m) |
|---|---|---|---|---|---|
| Loamy sand | 0.11-0.19 | 0.03-0.10 | 0.06-0.12 | 4-8 | 9-14 |
| Sandy loam | 0.18-0.28 | 0.06-0.16 | 0.11-0.15 | 6-10 | 15-20 |
| Loam | 0.20-0.30 | 0.07-0.17 | 0.13-0.18 | 8-10 | 16-22 |

Table 19 has no sandy clay loam row.

### 2.3 van Genuchten parameters

These are the Rosetta class averages from USDA ARS [C]
(https://www.ars.usda.gov/pacific-west-area/riverside-ca/agricultural-water-efficiency-and-salinity-research-unit/docs/model/rosetta-class-average-hydraulic-parameters/).
They are derived from US soils; note this limitation.

| Soil | θr | θs | log10 α (1/cm) → α | log10 n → n | log10 Ks (cm/d) → Ks |
|---|---|---|---|---|---|
| Sandy loam (N=476) | 0.039 | 0.387 | -1.574 → **0.0267 /cm** (0.272 /kPa) | 0.161 → **1.449** | 1.583 → **38.3 cm/d** |
| Sandy clay loam (N=87) | 0.063 | 0.384 | -1.676 → **0.0211 /cm** (0.215 /kPa) | 0.124 → **1.330** | 1.120 → **13.2 cm/d** |
| Loamy sand (N=201) | 0.049 | 0.390 | -1.459 → 0.0348 /cm | 0.242 → 1.746 | 2.022 → 105 cm/d |

Unit note: α is per cm of water head. Convert kPa to head with h_cm = 10.197 × kPa. The
retention curve is θ(h) = θr + (θs-θr) / [1 + (αh)^n]^(1-1/n).

### 2.4 Derived FC, WP and TAW [D] (script `vg.js`)

| Soil | θ at 10 kPa | θ at 20 kPa (**chosen FC**) | θ at 33 kPa | θ at 1500 kPa (WP) | **TAW (FC20) mm/m** | TAW with FC10 / FC33 | SAT-FC (drainable) mm/m |
|---|---|---|---|---|---|---|---|
| Sandy loam | 0.247 | **0.198** | 0.167 | 0.062 | **135** | 185 / 105 | 189 |
| Sandy clay loam | 0.294 | **0.255** | 0.228 | 0.111 | **144** | 183 / 117 | 129 |

I anchored FC at 20 kPa because it lands both TAW values inside the FAO Table 19 ranges
(110-150 mm/m for sandy loam). The FC10 convention overshoots and FC33 sits at the bottom edge.
This is a modelling choice [D/A].

### 2.5 FAO-56 single-coefficient daily water balance (recommended implementation)

Sources: FAO-56 chapter 8 [C] (https://www.fao.org/4/x0490e/x0490e0e.htm) and chapter 7 [C]
(https://www.fao.org/4/x0490e/x0490e0c.htm).

- **Root-zone depletion:** Dr,i = Dr,i-1 - (P - RO)i - Ii - CRi + ETc,adj,i + DPi, clamped to
  0 ≤ Dr ≤ TAW. Capillary rise CR = 0 (deep water table).
- **TAW = 1000 (θFC - θWP) · Zr** and **RAW = p · TAW**.
- **p adjusted for ETc:** p = p_table + 0.04 (5 - ETc), limited to 0.1-0.8 [C].
- **Ks = 1 while Dr ≤ RAW**, otherwise Ks = (TAW - Dr) / ((1 - p) TAW) [C, text of eq. 84];
  ETc,adj = Ks · Kc · ET0.
- **Deep percolation:** DP = (P - RO) + I - ETc - Dr,i-1 ≥ 0, and 0 while below FC [C, eq. 88].
  For a game, drain to FC within 1 day on sandy loam and within 2 days on sandy clay loam [A].
- **Root growth** [A, following the FAO-56 practice of a linear increase to the full depth by
  the start of mid-season]: Zr from Zr_min = 0.15 m at sowing (0.10 m for transplanted seedlings
  in pots) to Zr_max at the end of the development stage, linear in days.
- **Kc curve:** piecewise linear from the four stage lengths (ini flat, dev ramp, mid flat, late
  ramp to Kc_end). Use `osi-crop-kc` [R] so the game's crop-water demand is OSI's own.
- **Soil-surface evaporation:**
  - During a crop, the single-coefficient Kc_ini already includes soil evaporation. Do not add a
    separate term.
  - For fallow or bare soil between crops, use the FAO-56 two-stage model [C]:
    - TEW = 1000 (θFC - 0.5 θWP) · Ze, with Ze = 0.10 m. That gives 17 mm for sandy loam and
      20 mm for sandy clay loam [D], in line with Table 19's 15-20 mm.
    - REW = 8 mm for sandy loam and 9 mm for sandy clay loam [A, within Table 19].
    - Kr = 1 while De ≤ REW, else Kr = (TEW - De)/(TEW - REW).
    - E = Kr · 1.15 · ET0 [Kc_max simplified; FAO-56 gives about 1.2 adjusted for wind and RH,
      and 1.1-1.2 with frequent wetting].
  - Mulch reduces E by 5% per 10% of soil covered [A; FAO-56 gives a mulch reduction rule;
    verify before you rely on it].
- **Runoff:** use the SCS curve number [C] (https://en.wikipedia.org/wiki/Runoff_curve_number).
  - S = 25400/CN - 254 (mm). Q = 0 if P ≤ 0.2S, else Q = (P - 0.2S)² / (P + 0.8S).
  - **Crusted sandy loam:** hydrologic soil group C [A]. The assumption is that crusting lowers
    the final infiltration rate into group C's 1.3-3.8 mm/h band (HSG definitions [C]).
  - **Values:** bare fallow C = 91; row crop, straight rows, poor = 88; contoured, good = 82;
    contoured and terraced, good = 78. For sandy clay loam valley soil (HSG B): 86 / 81 / 75 / 71
    [C, TR-55 table].
  - **In-game mechanics** [A]: tied ridges, zai pits and terraces lower CN by 5-10; mulch or
    residue lowers it by 3-5.
  - Real CNs measured on Ethiopian plots came out about 21% below handbook values (range 34-91)
    [S] (https://doaj.org/article/692c0992f82c48da870d5fe4bb4e4a78). Treat the handbook CN as
    an upper bound.
  - A simpler alternative [A]: runoff fraction = max(0, (P - 12 mm) × 0.35) on crusted bare soil.

### 2.6 Depletion to soil water tension (kPa) for sensor emission [D] (script `vg.js`, FC = 20 kPa)

The "depletion fraction" is Dr/TAW within a layer.

| Dr/TAW | 0.00 | 0.10 | 0.20 | 0.30 | 0.40 | 0.50 | 0.60 | 0.70 | 0.80 | 0.90 | 1.00 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Sandy loam kPa | 20 | 25 | 31 | 40 | 53 | 72 | 104 | 160 | 271 | 544 | 1500 |
| Sandy clay loam kPa | 20 | 26 | 34 | 46 | 64 | 91 | 135 | 211 | 357 | 673 | 1500 |

Above FC, during the drainage day after rain or irrigation, the fraction of the drainable store
(SAT - FC) that is still filled maps as follows:

| Fraction of drainable store filled | 0.25 | 0.50 | 0.75 | 1.00 |
|---|---|---|---|---|
| Sandy loam kPa | 10.3 | 5.5 | 2.6 | 0 |
| Sandy clay loam kPa | 11.3 | 6.2 | 2.9 | 0 |

Interpolate on these points in log(kPa), or compute the closed form:
h = [(Se^(-1/m) - 1)^(1/n)]/α with m = 1 - 1/n and Se = (θ - θr)/(θs - θr).

What this means at the FAO p thresholds on sandy loam:

| Crop | p | Threshold kPa |
|---|---|---|
| Onion | 0.30 | ~40 |
| Tomato | 0.40 | ~53 |
| Cabbage, beans | 0.45 | ~62 |
| Maize, sorghum | 0.55 | ~86 |

The OSI GUI colour bands are blue < 20, green 20-50 and red > 50 kPa
[R: `docs/superpowers/specs/2026-09-24-swt-water-status-colors-design.md`, citing
https://via.farm/chameleon-soil-water-sensor/]. Vegetables turn "red" close to their RAW limit,
which is pedagogically consistent.

**Emitting swt_1/swt_2/swt_3 at three depths needs a layered rule.** A single FAO bucket yields
one depletion value. The rule below is a **game-side design choice [A]**, not sourced, and the UI
should not label it OSI output. Only the downstream recommendation logic (triggers, policy) is
OSI code.

- **Layers:** split the soil into three layers centred on the sensor depths. Suggested defaults
  are 20/40/60 cm; the simulator reads per-device depths from `chameleon_swtN_depth_cm` or
  `soil_moisture_probe_depths_json`.
- **Infiltration:** fill top-down as a cascade. Each layer fills to FC, and the excess passes to
  the next layer and then to deep percolation.
- **Transpiration** = Ks · Kc · ET0, split across the layers the roots currently reach in the
  common 40/30/20/10 extraction proportions, renormalised to the occupied layers.
- **Soil evaporation** comes from the top layer only.
- **Ks** uses the root-zone-weighted depletion, so the balance stays equal to the single FAO
  bucket.
- **Sensor value:** layer depletion mapped to kPa through the table above, plus Gaussian noise
  (sd 5% of value, minimum 0.5 kPa) and a daily cycle (+3-8% in the afternoon at 20 cm) [A].
  Clip to the **device's measurement range**, not the GUI domain:
  - **KIWI** (Tektelic Watermark input): saturates at **200 kPa** (`freqToWatermark` returns
    200) [R: `codecs/tektelic_agriculture_decoder.js`]. The device catalogue lists only
    `swt_1`/`swt_2` for KIWI, although the demo also emits `swt_3` [R].
  - **Chameleon:** clamps to **0-300 kPa** [R: `osi-chameleon-helper/index.js`
    `resistanceOhmsToKpa`, via the agronomy skill].
  - **Irrigation thresholds:** validated 0 < x ≤ 300 kPa [R: agronomy skill,
    `soil-water-tension.md`].
  - The 0-1,000,000 kPa range is only the GUI display domain [R]. So a bucket at 1,500 kPa
    (wilting point) must read as 200 on KIWI and 300 on Chameleon.

---

## 3. Crops

### 3.1 FAO water parameters

**How OSI resolves Kc, which matters for the honesty rule** [R:
`osi-crop-kc/index.js::resolveKc`]:

- The phenological stage is **set by the user per zone**, together with `stageStartedOn`.
  OSI does not infer it from a planting date.
- Within the development and late stages, OSI ramps Kc day by day (FAO-56 eq. 66) using the
  **edge table's stage length L**. Once the days in a stage exceed L it sets `stageOverrun`.
- Consequences for the game:
  - The game may legitimately advance stages on its own calendar and pass `phenologicalStage`
    and `stageStartedOn` to OSI.
  - If a game stage is shorter than the edge row (e.g. maize development 30 d in the game vs
    40 d in the edge table), OSI's Kc lags the game crop's "true" Kc. If it is longer, OSI
    clamps and flags an overrun.
  - Any "OSI recommendation" must use OSI's resolved Kc, never the game's own curve.
  - For the hidden "true" crop physiology the game can either reuse the edge stage lengths (no
    divergence) or accept and document the mismatch.

Sources:

- **Kc and stage lengths:** `osi-crop-kc/crop-kc.json` [R], which equals FAO-56 Tables 11 and 12
  [C] (https://www.fao.org/4/x0490e/x0490e0b.htm).
- **Root depth and p:** FAO-56 Table 22 [C] (https://www.fao.org/4/x0490e/x0490e0e.htm).
- **Ky:** FAO-33 seasonal values reproduced in FAO-66 Table 1 [C]
  (https://www.fao.org/4/i2800e/i2800e02.pdf).
- **Seasonal water need:** FAO Training Manual 3, Table 14 [C]
  (https://www.fao.org/4/s2022e/s2022e07.htm).

| Crop | crop-kc.json id | Kc ini / mid / end | Stage days ini/dev/mid/late (edge row, region) | Regional stage days (game) | Root depth m | p | Ky | Water need mm/season |
|---|---|---|---|---|---|---|---|---|
| Maize (grain) | `maize` | 0.30 / 1.20 / 0.35 | 30/40/50/30 = 150 (Spain/Calif.) | 20/30/40/25 = 115 [A, scaled to a short-season drought-escape variety]; FAO also lists 25/40/45/30 "Arid climate" and 30/50/60/40 "East Africa (alt.)" [C] | 1.0-1.7 | 0.55 | 1.25 | 500-800 |
| Sorghum (grain) | `sorghum` | 0.30 / 1.00 / 0.55 | 20/35/40/30 = 125 | 20/35/45/30 = 130 (FAO "Arid region") [C] | 1.0-2.0 | 0.55 | 0.90 | 450-650 |
| Pearl millet | `millet` | 0.30 / 1.00 / 0.30 | 20/30/55/35 = 140 (Central USA) | 15/25/40/25 = 105 (FAO "Pakistan" row) [C]; about 3 months to harvest for new varieties [S] | 1.0-2.0 | 0.55 | not in FAO-33 table; use 0.9 like sorghum [A] | 450-650 |
| Finger millet | `millet` (no own row) | as millet | as millet | 20/30/45/25 = 120 [A] | 1.0-2.0 | 0.55 | 0.9 [A] | 450-650 |
| Cowpea | `green_gram` (FAO shared row) | 0.40 / 1.05 / 0.35 | 20/30/30/20 = 100 | 15/25/30/15 = 85 [A; 70-76 d to maturity in a Kenyan coastal trial S] | 0.6-1.0 | 0.45 | not in table; 1.1 [A] | 300-500 [A, bean range] |
| Green gram | `green_gram` | 0.40 / 1.05 / 0.35 | 20/30/30/20 = 100 | 12/20/25/13 = 70 [D from KALRO maturity 65-75 d, S] | 0.6-1.0 | 0.45 | not in table; 1.15 like beans [A] | 300-500 [A] |
| Beans (dry) | `dry_bean` | 0.40 / 1.15 / 0.35 | 20/30/40/20 = 110 | 15/25/35/20 = 95 (FAO "Pakistan, Calif.") [C] | 0.6-0.9 | 0.45 | 1.15 | 300-500 |
| Tomato (transplanted) | `tomato` | 0.60 / 1.15 / 0.70 | 30/40/45/30 = 145 (Medit.) | 25/35/40/25 = 125 after transplant [A; maturity 75-85 d after transplant, harvest over 3-4 months, S/C SHEP]; nursery 30-45 d [C SHEP] | 0.7-1.5 | 0.40 | 1.05 | 400-800 |
| Onion (dry) | `onion` | 0.70 / 1.05 / 0.75 | 15/25/70/40 = 150 | 15/25/60/25 = 125 [A] | 0.3-0.6 | 0.30 | 1.10 | 350-550 |
| Cabbage | `cabbage` | 0.70 / 1.05 / 0.95 | 20/30/20/10 = 80 (crucifers, Medit.) | 25/35/30/10 = 100 after transplant [A] | 0.5-0.8 | 0.45 | 0.95 | 350-500 |
| Kale (sukuma wiki) | **none**; use `cabbage` (FAO "crucifers") | 0.70 / 1.05 / 0.95 | as cabbage | 20 d nursery + first harvest 45 d after transplant, then picking for 4-6 months [C SHEP: harvest starts 45 days after transplanting] | 0.5-0.8 [A, as cabbage] | 0.45 [A] | 0.95 [A] | - |
| Amaranth (leaf) | **none**; use `spinach` (closest FAO leafy row) | 0.70 / 1.00 / 0.95 | 20/20/15/5 = 60 | first cut about 6 weeks after transplant [S JICA] | 0.3-0.5 (spinach) | 0.20 (spinach; amaranth is more drought-tolerant, so 0.35 [A]) | - | - |

FAO-56 Table 12 rows confirmed on the FAO page [C]:

- Cowpeas / green gram: Kc mid 1.05, end 0.60-0.35, height 0.4 m.
- Maize grain: mid 1.20, end 0.60-0.35.
- Sorghum: mid 1.00-1.10, end 0.55.
- Millet: mid 1.00, end 0.30.

These match crop-kc.json.

### 3.2 Yields, spacing, seed, prices and pests

Prices are KES, 2025 unless stated. USD at **KES 129.3 per USD**, the 2025 average [S]
(https://peopledaily.digital/business/why-kenyan-shilling-recorded-a-slight-gain-against-the-us-dollar-in-2025;
CBK weekly bulletin, 24 Jul 2025: 129.26 [S]).

| Crop | Rainfed smallholder t/ha | Good / irrigated t/ha | Spacing | Seed | Price (date) | Major pests and diseases |
|---|---|---|---|---|---|---|
| Maize | ~2 national average; farmers' fields in drylands often ≤0.5-1.5 | potential >6 | 75×25-30 cm [A] | 2 kg certified seed KES 525 (2025/26 directive) or KES 300 after a 50% subsidy (2026) [S] | NCPB buying price KES 4,000 per 90 kg = KES 44/kg (Jan 2026) [S]; wholesale dry maize KES 38/kg (Nov 2025) [S]; 90 kg bag KES 4,670-5,600 regionally (Apr 2025) [S] | Fall armyworm (in Kenya since 2016; 21-53% maize loss without control) [S]; stem borers (*Busseola fusca*, 82% of maize losses in one estimate) [S]; Striga [S] |
| Sorghum | 0.7 national (FAOSTAT 2010-11) | 3-4 [A] | 60×20 cm [A] | [A] KES 150-250/kg | [A] KES 40-60/kg | Stem borer (*Chilo partellus*, up to 80% loss) [S]; shoot fly, chafer grub, aphids [S]; quelea birds [S]; Striga [S] |
| Pearl millet | 0.2-0.8 in East Africa (potential 1.5-3) [S]; improved 1.2 [S] | 1.5-1.7 best trial varieties [S] | 75×20 cm [A] | [A] | [A] | Birds, Striga, downy mildew [A]; FAW [S] |
| Finger millet | ~1 national average [S] | up to 4.7 on-station with P [S] | rows 30 cm, 6 kg/ha seed [S] | 6 kg/ha [S] | [A] | Blast [S]; birds |
| Cowpea | 0.5 national (FAOSTAT 2010-11) [S] | 1.0-1.5 [A] | 60×30 cm (trial) [S] | [A] | [A] | Aphids, pod borers, thrips [A; common knowledge, not sourced] |
| Green gram | <1 on-farm [S]; 0.5 national [S] | 1.5-2.1 (Karembo, Biashara), 2-3 (new varieties) [S] | 50×10 cm, or 45×15 cm under conservation agriculture [S] | [A] | farm gate KES 30-45/kg after a drop from KES 65 (undated; low confidence) [S] | Powdery mildew, aphids, thrips [A] |
| Beans | <1 national (potential 2) [S] | 1.5-2 [A] | 50×10 cm [A] | [A] | [A] KES 100-130/kg | Bean fly, anthracnose, rust [A] |
| Tomato | open-field smallholder 10-25 [A] | SHEP: 12,000-40,000 kg/acre = 30-99 t/ha, depending on variety and husbandry (high-input potential) [C] | 75-100 × 40-60 cm [C SHEP] | 40-75 g seed/acre [C SHEP] | retail KES 79-87/kg (Sep 2025) [S]; **60 kg crate swings from KES 1,000 (Jan 2026 glut) to KES 6,800-7,000 (Apr 2026 shortage)** [S] | African bollworm (up to 70% loss) [S, infonet-biovision]; Tuta absoluta [A]; early blight spread by overhead irrigation [C SHEP]; bacterial and fusarium wilt [C SHEP variety notes]; whitefly-borne viruses [C SHEP] |
| Onion | 10-25 [A] | 30-40 [A] | 30×10 cm [A] | [A] | farm gate KES 80-100/kg, retail KES 120-150 (Sep 2025 shortage) [S] | Thrips, purple blotch, downy mildew [A] |
| Cabbage | 20-30 [A] | 40-60 [A] | 60×45 cm [A] | [A] | retail KES 52.7/kg (May 2025), 76.9/kg (Jan 2025) [S] | Diamondback moth, aphids, black rot [A] |
| Kale | ~20 (8,000 kg/acre, Uganda guidance) [S] | 37 (15,000 kg/acre, SHEP) [C] | 60 cm rows × 40-60 cm, i.e. 11,111-16,666 plants/acre [C SHEP] | 50 g/acre [C SHEP] | retail KES 89.5/kg (May 2025) [S] | Diamondback moth, cabbage sawfly, aphids, cutworms [C SHEP]; black rot [A] |
| Amaranth (leaf) | 12-19 [D from S] | 18.8-27.7 (Tanzanian trials) [S]; 12 t/acre = 30 t/ha (JICA) [S] | 30×15 cm [S] | [A] | [A] KES 40-60/kg | Spider mites, weevils [S] |

Source URLs for section 3.2:

- FAOSTAT national averages snippet [S?]: candidate https://pmc.ncbi.nlm.nih.gov/articles/PMC7743974
- Maize ~2 vs >6 t/ha: search summary (Kenyan government figure)
- Maize prices: https://www.the-star.co.ke/counties/rift-valley/2026-01-15-cereals-board-raises-maize-price-to-sh4000
  and https://www.foodsecurityportal.org/sites/default/files/2026-03/Monthly%20Report_Kenya_November_2025_final.pdf
- Seed: https://peopledaily.digital/news/govt-sets-nationwide-subsidised-maize-seed-prices-to-take-effect-immediately/amp
  and https://www.standardmedia.co.ke/smart-harvest/article/2001543431/maize-seed-prices-cut-in-state-subsidy-push
- Pests: https://pmc.ncbi.nlm.nih.gov/articles/PMC10693822/,
  https://link.springer.com/article/10.1186/s40066-024-00470-8,
  https://pmc.ncbi.nlm.nih.gov/articles/PMC8955010,
  https://assets.publishing.service.gov.uk/media/57a08cfb40f0b652dd0016ae/R7572_FTR.pdf
- Millets: https://icrisat.org/assets/Flyers/Country-Flyers/ICRISAT-in-Kenya.pdf,
  https://oar.icrisat.org:443/9911/1/Wafula%20et%20al.%20Plant%20Research%20Journal.pdf,
  https://www.the-star.co.ke/news/big-read/2026-04-21-millet
- Green gram: https://snv.kalro.org/good-agricultural-practices/3/1,
  https://keep.kalro.org/appfiles/media/vc_files/New_improved_market-preferred_green_gram_varieties.pdf,
  https://farmbizafrica.com/tag/kitui/
- Tomato and kale (SHEP PLUS, Kenya Ministry of Agriculture / JICA; opened and text-extracted):
  https://www.jica.go.jp/project/english/kenya/015/materials/c8h0vm0000f7o8cj-att/materials_15.pdf
  (tomato) and https://www.jica.go.jp/project/english/kenya/015/materials/c8h0vm0000f7o8cj-att/materials_11.pdf (kale)
- Tomato, onion and kale prices:
  https://www.the-star.co.ke/news/2026-04-21-tomato-price-surge-after-january-excess-supply,
  https://www.the-star.co.ke/counties/2025-09-17-onion-prices-surge-as-traders-turn-to-tanzania-imports-to-address-shortage,
  https://thekenyatimes.com/latest-kenya-times-news/kenya-inflation-report-tomato-prices-surge-by-45-as-food-costs-rise/,
  https://standardmedia.co.ke/sports/amp/business/2001539781/plate-of-pain-how-sukuma-ugali-became-a-luxury-meal-in-2025
- Amaranth: https://www.gov.uk/research-for-development-outputs/yield-of-vegetable-amaranth-in-diverse-tanzanian-production-environments
  and https://www.jica.go.jp/project/english/kenya/015/materials/c8h0vm0000f7o8cj-att/materials_01.pdf
- Kale (Uganda guidance): https://www.monitor.co.ug/uganda/magazines/farming/agronomy-tips-for-planting-sukuma-wiki-this-season-3784868

Game-economy notes:

- **Price volatility is the most teachable economic fact.** The 7× swing in the tomato crate
  price between a glut and a shortage [S] is a strong case for an irrigated off-season harvest.
  Let prices follow supply: rains-season glut, dry-season premium [A].
- **Use a fictional currency.** Display a fictional unit and keep KES only as the calibration
  basis [A]. One option is 1 coin = KES 1 at 2025 prices.

### 3.3 Post-harvest loss and storage

| Quantity | Value | Tag / source |
|---|---|---|
| Kenya maize post-harvest loss | 16.5-25.0% over the years; 16.7% in 2020-21 (6.4% at harvest/field drying, 2.5% in household storage) | [S] https://www.aphlis.net/en/data/tables/overview/KE/maize/all-years |
| Kenya sorghum loss | 12.6% in 2021 (4.6% field drying, 1.0% storage) | [S] same site |
| Game mechanic | Hermetic bags or a raised crib cut storage loss [A]; selling at harvest means the lowest price [A] | |

---

## 4. Water and the smallholder irrigation ladder

| Rung | Cost (date) | Capacity / labour | Application efficiency | Tag / source |
|---|---|---|---|---|
| Jerrycan, carried | jerrycan ~KES 300-500 [A] | 20 L per trip (~20 kg); average rural SSA round trip **33 min** (urban 25 min) [S UNICEF]; West Cameroon 37 ± 39 min incl. queuing [S]; adult women are the main collectors where trips exceed 30 min [S] | (as watering can) | https://www.unicef.org/press-releases/unicef-collecting-water-often-colossal-waste-time-women-and-girls ; https://pmc.ncbi.nlm.nih.gov/articles/PMC4889070 |
| Watering can / bucket | can KES 500-1,000 [A] | 10-15 L per fill; ~4 min per can at a nearby source [A] | ~70-80% when placed at plant bases [A; FAO gives no figure for hand watering] | |
| Shallow hand-dug well / scoop hole in a sand river | dug by household labour [A] | yield limited by the season [A] | - | no numeric source found |
| Sand dam (community) + shallow well | ~USD 9,000 for a 30 m long, 3 m high dam plus well; community provides 30-35% as labour; KES 1-4 million in news reports | stores 3,500-5,000 m³ in sand (range 2,000-10,000) | - | [S?] candidates: https://en.wikipedia.org/wiki/Sand_dam ; https://www.the-star.co.ke/news/2023-11-28-kitui-sand-dams-improve-access-to-water-end-cycles-of-hunger |
| Water pan / farm pond | excavation KES 150/m³ (government rehabilitation) to ~KES 400/m³ market rate; household pans quoted at 1,000-3,000 m³; one farmer's liner KES 160,000 | evaporation and seepage losses not found; a liner cuts seepage [A] | - | [S?] candidates: https://www.the-star.co.ke/news/world/2019-04-25-farmers-harvest-water-to-fight-cycle-of-drought ; https://nation.africa/kenya/life-and-style/dn2/with-my-own-water-pan-i-can-farm-all-year-round-428862 |
| Borehole / communal kiosk | water fee [A] KES 2-5 per 20 L | queue time [A] | - | not sourced |
| Hip or treadle pump | USD 20-70 (hip pump; sources conflict); KES 6,090 (hip pump, 2015); ~USD 100 (older large treadle model) | up to 60 L/min, 14 m head; vendor claims 1-2 acres/day | surface 60% (hose or furrow) | [S] https://www.engineeringforchange.org/solutions/product/moneymaker-hip-pump/ ; https://techxlab.org/solutions/moneymaker-max-pump/ ; https://akvopedia.org/wiki/Special:MobileDiff/13326...38107 |
| Petrol pump | [A] KES 20,000-35,000 plus fuel | high flow; noisy; fuel cost per hour [A] | 60% furrow | not sourced |
| Solar pump kit (pay-as-you-go) | cash KES 64,999-77,999; deposit KES 4,999-5,199 plus KES 3,809-4,900 per month over 24-30 months (vendor price list, 2026) | vendor: "up to 2 acres" | depends on hose or drip | [S] https://sunculture.io/product/rain-maker-kubwa/ (use a fictional generic brand in game) |
| Drip kit | small kit KES 20,000 excl. tank (2013); quarter-acre kit KES 40,000 excl. tank, tank ≥1.5 m above ground; bucket kits serve plots from 15 m² | gravity-fed from a raised bucket or drum (~1 m) | **90%** | [S] https://www.standardmedia.co.ke/counties/article/2000091944/farmers-warm-up-to-sh20000-kadogo-drip-kit ; https://avrdc.org/download/project-support/v4pp/training-trainers/1-3-water-mgmt/QUARTER-ACRE-DRIP-KIT.docx ; https://cgspace.cgiar.org/rest/bitstreams/82498/retrieve |
| FAO default field application efficiencies | surface **60%**, sprinkler **75%**, drip **90%** | | | [C] FAO Training Manual 4, ch. 3, https://www.fao.org/4/t7202e/t7202e06.htm |
| Surface efficiency with good design | basin 70-90%, border 70-85%, furrow 65-85% | | | [S] https://www.fao.org/3/w4367e/w4367e0c.htm |
| Drip adoption barriers (Kenya) | lack of maintenance, unreliable water supply, cultural fit; bucket kits "not appropriate in some situations" | | | [S] https://core.ac.uk/download/40105469.pdf |

Game sizing [A]:

- The garden plot starts at 0.01-0.05 ha (100-500 m²) and grows to 0.1-0.5 ha with a pump and a
  water source.
- Check against water demand: at ET0 5 mm/d and Kc 1.1, a 500 m² vegetable plot needs about
  2.75 m³/day of net water [D]. At 60% efficiency that is about 4.6 m³ gross, or 230 jerrycans,
  so hand-carrying caps the irrigated area at a few tens of m². This is the core pedagogical
  arc of the ladder.

---

## 5. Daily life and economy

| Topic | Value | Tag / source |
|---|---|---|
| Unpaid care and domestic work, rural Kenya | women ~4.5 h/day vs men ~1 h/day; national ~5 h vs ~1 h | [S] KNBS / UN Women 2023, https://data.unwomen.org/sites/default/files/documents/Publications/2024/Kenya_time-use_care-assessment_summarybrief.pdf |
| Water fetching | adult women are the main collectors; ~17 million women and children in 24 SSA countries make trips of >30 min | [S] https://pmc.ncbi.nlm.nih.gov/articles/PMC4889070 |
| Mobile money use | 77.0% rural, 89.7% urban; daily use 52.6% (2024) | [S] 2024 FinAccess, https://www.centralbank.go.ke/wp-content/uploads/2024/12/2024-FINACCESS-HOUSEHOLD-SURVEY-MAIN-REPORT.pdf (rural figure from secondary coverage) |
| Savings groups (VSLA) | 15-30 members (~20 typical); ~12-month cycle ending in a share-out; loans capped at ~3× savings, repaid within ~3 months at a group-set rate; lending starts slowly | [S?] candidates: https://spex.agrocenta.com/docs/main/vsla ; https://povertyactionlab.org/media/file-research-paper/community-lending-external-capital-evidence-randomized-evaluation-uganda |
| Extension coverage | ~1 extension agent per 1,380 farmers (target 1:600; FAO recommends 1:400); some counties 1:5,000-6,000 | [S] https://nation.africa/kenya/climate/digital-tools-bridge-kenya-s-extension-gap-as-farmers-face-climate-shocks-5599768 |
| Rural poverty line | KES 4,358 per adult equivalent per month; food line KES 2,668; national headcount 39.8% (2022) | [S] https://www.knbs.or.ke/reports/kenya-poverty-report-2022/ |
| Land holdings | 85% of surveyed smallholders in three semi-arid counties own <5 acres | [S] yield search summary |
| Goats | 19-20 kg goat KES 9,000-12,000 (Feb 2026, a pastoral market); prices fall in droughts as condition drops | [S] https://www.kenyanews.go.ke/?p=120392 ; https://www.kenyanews.go.ke/dry-season-upsets-livestock-prices-in-maralal/ |
| Chickens, cow | no reliable source found | [A] |
| Input credit, cooperatives | not quantified in this research | [A] |
| Market days | weekly rural market day [A] | not sourced |

Suggested daily rhythm for the game (design default [A], not sourced; check against the KNBS
time-use report tables before you treat it as realistic):

| Time | Activity |
|---|---|
| 05:30-06:30 | Wake, water collection (one round trip ~33 min [S]), animals |
| 06:30-11:00 | Field work while it is cool |
| 11:00-15:00 | Heat of the day: market, household tasks, rest, school pickup |
| 15:00-18:30 | Field work and irrigation |
| 18:30-21:00 | Cooking, care work, savings-group meetings (weekly) |

Children: school days on weekdays; school fees due at term start (3 terms) [A].

Household income for a game calibration [D/A]:

- A household of 5 at about 3.5 adult equivalents sits at the rural poverty line when it spends
  about KES 15,000 per month, or ~USD 116 [D from KNBS].
- Start the player household near this line.
- Income sources: one rains-season staple harvest (mostly eaten at home), small vegetable sales,
  goat sales as a savings buffer, and off-farm casual work [A].

Design cautions (respectful, non-stereotyping):

- **Show the work, not suffering.** Women's labour burden is real and documented [S].
  - Show who does the work, and let the player's household redistribute tasks: shared
    water-fetching, a pump that frees time.
  - Do not frame women or children as helpless.
  - Children's schooling should be a positive goal that irrigation income can protect.
    Child labour should never be a reward mechanic.
- **Avoid the "poverty tourism" and "Western saviour" arcs.** Local expertise should be central.
  - The extension officer, the savings-group treasurer and experienced neighbours are competent
    NPCs.
  - OSI tools are offered as options with costs and trade-offs.
- **No real ethnic, linguistic or place references.** Use invented names, clothing and
  architecture that read as "East African dryland" without copying a specific community.
  - Avoid caricatured accents and dialogue.
  - Swahili-like words should be checked with native speakers or avoided.
- **Show farmers' knowledge as valid.** VIA field reports note low literacy alongside rich tacit
  knowledge [C: ACIAR FR2024-006].
  - The game should treat farmer knowledge as something the sensor makes visible, not something
    it replaces.

---

## 6. Evidence on sensor-based irrigation decision support with smallholders

| Finding | Number | Tag / source |
|---|---|---|
| VIA phase 2 (15 schemes, Tanzania and Malawi; 358 farmers; 736 crops; 3 years) | farmers judged that 70% (Tanzania) and 63% (Malawi) of crops yielded more; one-quarter reported >50% gains; one-quarter (Tanzania) and over one-third (Malawi) reported the same or lower yields, mostly from **running out of water**; **none blamed misleading sensor information** | [C] ACIAR final report FR2024-006 (Stirzaker, 2024), https://www.aciar.gov.au/sites/default/files/2024-03/wac-2018-162-final-report.pdf |
| Water use | Tanzania: sensor users cut water applications by **65% over three years**; neighbours without sensors cut theirs by **47%**; in Zimbabwe, farmers without equipment got about two-thirds of the benefits | [C] same |
| One Tanzanian scheme (Mdemu et al. 2020, as quoted) | yields +30%, water use -65%, upstream/downstream conflict -83%; knowledge spread from 20 monitoring farmers to most of 200 irrigators | [C] same |
| Ethiopia | 373 farmers in 36 water-user groups: +40% wheat water productivity | [C] same |
| Self-reported effects | 90% (Tanzania) and 71% (Malawi) reported using less water; 86% in Tanzania reduced fertiliser after seeing leaching | [C] same |
| Over-irrigation is the main problem | "Irrigated fields are kept too wet, and nutrients are washed out" | [C] same |
| One Malawi scheme | 15% less time in the blue (wet) zone came with a >50% yield increase | [C] same |
| Malawi four-scheme case study, 2017-18 | yield +80%, gross margin more than tripled (no control group) | [C] Chikankheni et al. 2025, Irrig. Drain. 74(1):458-470, doi 10.1002/ird.3013, https://researchportalplus.anu.edu.au/en/publications/simple-soil-water-monitoring-tools-increase-yield-and-income-of-s/ |
| Wireless sensor scheduling, drip wheat, Zimbabwe | up to 25% water saving vs a fixed schedule | [S] https://doaj.org/article/07af205bbbea4457add77ac49fce54da |
| Cost barrier | the wetting front detector at USD 20-30 was "far too expensive", and almost none were bought by the intended smallholders; the Chameleon Wi-Fi system cost USD 250; farmers need USD 5-10 per sensor; a USD 5 sensor became available in Malawi in 2023 | [C] ACIAR FR2024-006 |
| Chameleon colour bands | blue < 20 kPa (wet), green 20-50, red > 50 (dry) | [R] repo spec citing via.farm; [S] 2024 VIA paper, https://informahealthcare.com/doi/full/10.1080/07900627.2024.2322153 |
| Randomised evidence in sub-Saharan Africa | none found; an RCT exists in Nepal (Chameleon) | [S] https://cgspace.cgiar.org/server/api/core/bitstreams/e192a474-271e-4cc1-a97b-b88a67f60923/content |

Implications for the education design [A, drawn from the evidence above]:

1. **Teach "stop over-watering" as the first lesson, not "water more".** The strongest documented
   effect is a large cut in water use with stable or higher yields. The game's soil model should
   show leaching or nutrient loss and waterlogging from over-irrigation, not just drought stress.
2. **Run the tier ladder from "see" to "decide" to "automate".** Each tier must call real OSI
   logic (the honesty constraint):
   - **Tier 0:** no sensor; the player judges by eye and the calendar.
   - **Tier 1:** a colour sensor; the game shows SWT and the 20/50 kPa colours the OSI GUI uses.
   - **Tier 2:** the OSI recommendation, using the 06:00 SWT trigger port and `osi-irrigation-policy`.
   - **Tier 3:** automation, using timed valve opens and weekly plans from the simulator.
3. **Model the social spillover.** Neighbours learn from the player's sensor and get about
   two-thirds of the benefit [C]. A scheme-level water-sharing quest, where reduced conflict
   upstream and downstream is the reward, mirrors the evidence.
4. **Be honest about the limits.** Sensors don't help when the water source runs dry, which was
   the most common reason for no gain [C]. Cost is the main adoption barrier [C]. The game should
   price sensors realistically and offer group purchase through a savings group.

---

## PARAMETER TABLES (for simulation code)

Units are in the key names. The provenance tag sits in `src` per row or block. Values tagged A
are tuning defaults.

### A. Weather generator (bimodal default)

Monthly parameters, index 0 = January. Derived [D] from NASA POWER totals [C] and Voi WMO rain
days [C]; persistence and gamma shape are assumed [A].

| Month | rain_mm (target) | wet_days | p01 | p11 | mean_wet_mm | gamma_k | gamma_scale_mm | tmax_c | tmin_c | rh_mean_pct | u2_ms | rs_mj_m2_d |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Jan | 40 | 5 | 0.129 | 0.329 | 8.0 | 0.75 | 10.67 | 29.3 | 15.6 | 64 | 1.54 | 23.3 |
| Feb | 29 | 3 | 0.086 | 0.286 | 9.7 | 0.75 | 12.89 | 30.6 | 16.2 | 60 | 1.62 | 24.2 |
| Mar | 64 | 8 | 0.168 | 0.518 | 8.0 | 0.75 | 10.67 | 30.2 | 16.8 | 65 | 1.64 | 23.4 |
| Apr | 101 | 7 | 0.152 | 0.502 | 14.4 | 0.75 | 19.24 | 28.5 | 16.4 | 73 | 1.62 | 20.9 |
| May | 60 | 5 | 0.105 | 0.455 | 12.0 | 0.75 | 16.00 | 27.3 | 15.1 | 74 | 1.51 | 19.0 |
| Jun | 15 | 2 | 0.053 | 0.253 | 7.5 | 0.75 | 10.00 | 26.9 | 13.8 | 69 | 1.47 | 16.3 |
| Jul | 11 | 1 | 0.026 | 0.226 | 11.0 | 0.75 | 14.67 | 27.1 | 13.2 | 64 | 1.73 | 15.8 |
| Aug | 14 | 2 | 0.052 | 0.252 | 7.0 | 0.75 | 9.33 | 27.7 | 13.5 | 63 | 2.20 | 17.0 |
| Sep | 14 | 3 | 0.080 | 0.280 | 4.7 | 0.75 | 6.22 | 29.3 | 14.2 | 60 | 2.48 | 21.0 |
| Oct | 51 | 4 | 0.084 | 0.434 | 12.8 | 0.75 | 17.00 | 29.6 | 15.2 | 63 | 2.32 | 21.9 |
| Nov | 96 | 10 | 0.217 | 0.567 | 9.6 | 0.75 | 12.80 | 28.1 | 16.0 | 73 | 1.87 | 20.6 |
| Dec | 78 | 8 | 0.168 | 0.518 | 9.8 | 0.75 | 13.00 | 28.0 | 15.9 | 72 | 1.63 | 21.6 |

```json
{
  "weatherGenerator": {
    "src": "D from NASA POWER 2001-2025 climatology (lon 37.6, lat -1.8, 1233 m) + WMO Voi rain days; persistence/gamma k/regime/noise = A",
    "site": { "latDeg": -1.8, "elevationM": 1233, "windHeightM": 2, "utcOffsetH": 3 },
    "wetDayDefinition": "Markov wet state; wet-day amount = max(0.3 mm, gamma(k, scale)) as validated. About 12-26% of draws fall below 1 mm (more in Sep), while the rain-day counts used are >=1 mm counts. A shifted gamma (1 mm + gamma, scale reduced by 1/k mm) is the cleaner alternative but needs re-validation.",
    "monthly": {
      "p01":        [0.129,0.086,0.168,0.152,0.105,0.053,0.026,0.052,0.080,0.084,0.217,0.168],
      "p11":        [0.329,0.286,0.518,0.502,0.455,0.253,0.226,0.252,0.280,0.434,0.567,0.518],
      "gammaShape": [0.75,0.75,0.75,0.75,0.75,0.75,0.75,0.75,0.75,0.75,0.75,0.75],
      "gammaScaleMm": [10.67,12.89,10.67,19.24,16.00,10.00,14.67,9.33,6.22,17.00,12.80,13.00],
      "tMaxC":      [29.3,30.6,30.2,28.5,27.3,26.9,27.1,27.7,29.3,29.6,28.1,28.0],
      "tMinC":      [15.6,16.2,16.8,16.4,15.1,13.8,13.2,13.5,14.2,15.2,16.0,15.9],
      "rhMeanPct":  [64,60,65,73,74,69,64,63,60,63,73,72],
      "windSpeed2mMs": [1.54,1.62,1.64,1.62,1.51,1.47,1.73,2.20,2.48,2.32,1.87,1.63],
      "solarRadMjM2": [23.3,24.2,23.4,20.9,19.0,16.3,15.8,17.0,21.0,21.9,20.6,21.6]
    },
    "seasonRegime": { "seasons": {"MAM":[2,3,4], "OND":[9,10,11]}, "lognormalSigma": 0.30, "applyAs": "sqrt(f) to wet probability and to amount" },
    "dailyNoise": { "tMaxSdC": 1.5, "tMinSdC": 1.2, "wetDayTMaxShiftC": -2.0, "wetDayTMinShiftC": 0.5,
                    "wetDayRsFactor": 0.70, "dryDayRsFactor": 1.07, "rsClampOfRso": [0.3,0.95],
                    "wetDayRhShiftPct": 10, "dryDayRhShiftPct": -3, "rhClampPct": [15,98], "windLognormalSigma": 0.25 },
    "diurnal": { "tMinLocalHour": 6.25, "tMaxLocalHour": 14.5, "luxPerWm2": 120, "luxPerWm2Src": "R osi-crop-kc/crop-kc.json" },
    "et0": "call osi-agronomy-daily/et0.js fao56Et0({tMinC,tMaxC,meanRhPct,windSpeedMs,windHeightM:2,solarRadMjM2,elevationM:1233,latDeg:-1.8,dayOfYear})",
    "validation2000yr": { "annualMeanMm": 584, "annualCv": 0.33, "seasonCv": [0.55,0.59], "pDrySpellGt10dFloweringWindow": 0.12, "targetBarron2003": ">=0.20" }
  },
  "weatherGeneratorSahelVariant": {
    "src": "C Niamey airport 1991-2020 WMO normals (Wikipedia); p01/p11/gammaScale D by the same method (persistence 0.35 Jun-Sep, else 0.2, k 0.75 = A); months with <0.5 wet days set to 0 (dry). Not simulated or validated.",
    "p01":      [0.0,0.0,0.0,0.027,0.07,0.13,0.203,0.254,0.147,0.044,0.0,0.0],
    "p11":      [0.0,0.0,0.0,0.227,0.27,0.48,0.553,0.604,0.497,0.244,0.0,0.0],
    "gammaShape": 0.75,
    "gammaScaleMm": [0.0,0.0,0.0,13.07,12.49,17.47,20.01,21.22,16.69,13.1,0.0,0.0],
    "rainMm":   [0.0,0.3,0.2,9.8,25.3,78.6,145.6,192.6,85.1,16.7,0.0,0.0],
    "wetDays":  [0.0,0.0,0.1,1.0,2.7,6.0,9.7,12.1,6.8,1.7,0.0,0.0],
    "tMaxC":    [32.4,35.8,39.5,41.6,40.7,37.9,34.6,32.8,34.9,38.0,37.1,33.6],
    "tMinC":    [16.9,19.8,24.3,27.8,28.3,26.6,24.4,23.4,24.2,25.1,21.0,17.4],
    "rhMeanPct":[22,17,18,27,42,55,67,74,73,53,34,27]
  }
}
```

### B. Soils

```json
{
  "soils": {
    "sandy_loam": {
      "src": "C Rosetta class averages (USDA ARS); FC anchored at 20 kPa (D); REW/TEW D/A within FAO-56 Table 19; CN C (TR-55) with crusting -> HSG C (D)",
      "vanGenuchten": { "thetaR": 0.039, "thetaS": 0.387, "alphaPerCm": 0.0267, "n": 1.449, "ksCmPerDay": 38.3 },
      "thetaFc": 0.198, "thetaWp": 0.062, "tawMmPerM": 135, "drainableSatMinusFcMmPerM": 189,
      "drainToFcDays": 1, "rewMm": 8, "tewMm": 17, "zeM": 0.10,
      "curveNumber": { "hsg": "C", "bareFallow": 91, "rowCropStraightPoor": 88, "rowCropContouredGood": 82, "contouredTerracedGood": 78 },
      "depletionToKpa": { "fraction": [0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0],
                          "kpa":      [20,24.8,31.1,40.0,52.8,72.3,103.8,159.6,271.2,543.6,1500] },
      "aboveFcToKpa":   { "fractionOfDrainableFilled": [0.25,0.5,0.75,1.0], "kpa": [10.3,5.5,2.6,0] }
    },
    "sandy_clay_loam": {
      "src": "same method",
      "vanGenuchten": { "thetaR": 0.063, "thetaS": 0.384, "alphaPerCm": 0.0211, "n": 1.330, "ksCmPerDay": 13.2 },
      "thetaFc": 0.255, "thetaWp": 0.111, "tawMmPerM": 144, "drainableSatMinusFcMmPerM": 129,
      "drainToFcDays": 2, "rewMm": 9, "tewMm": 20, "zeM": 0.10,
      "curveNumber": { "hsg": "B", "bareFallow": 86, "rowCropStraightPoor": 81, "rowCropContouredGood": 75, "contouredTerracedGood": 71 },
      "depletionToKpa": { "fraction": [0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0],
                          "kpa":      [20,26.1,34.4,46.3,63.8,90.8,134.7,211.2,357.1,673.1,1500] },
      "aboveFcToKpa":   { "fractionOfDrainableFilled": [0.25,0.5,0.75,1.0], "kpa": [11.3,6.2,2.9,0] }
    },
    "management": { "src": "A", "tiedRidgesCnDelta": -7, "mulchCnDelta": -4, "mulchEvapReductionPer10PctCover": 0.05 },
    "layers": { "src": "A (game-side, not OSI)", "sensorDepthsCm": [20,40,60], "rootUptakeShares": [0.4,0.3,0.2,0.1],
                "evaporationFrom": "top layer only", "sensorNoiseRel": 0.05, "sensorNoiseMinKpa": 0.5 },
    "sensorKpaClamp": { "src": "R", "KIWI_SENSOR": [0, 200], "CHAMELEON": [0, 300], "thresholdKpaValid": "0 < x <= 300",
                        "guiDisplayDomain": [0, 1000000], "note": "clamp emitted values per device; GUI domain is display-only" },
    "osiSwtColours": { "src": "R docs/superpowers/specs/2026-09-24-swt-water-status-colors-design.md", "blueBelowKpa": 20, "redAboveKpa": 50 }
  }
}
```

### C. Crops

Kc values and the "edge" stage rows are OSI's [R]. The "game" stage rows are regional
adaptations [A unless noted]. Root depth and p come from FAO-56 Table 22 [C]; Ky from FAO-33 /
FAO-66 Table 1 [C] unless marked A. Yields are t/ha; prices KES/kg, 2025 [S] unless marked A.

```json
{
  "crops": [
    { "id": "maize", "osiKcId": "maize", "kc": [0.30,1.20,0.35], "stageDaysEdge": [30,40,50,30], "stageDaysGame": [20,30,40,25],
      "rootMinM": 0.15, "rootMaxM": 1.2, "p": 0.55, "ky": 1.25, "seasonWaterMm": [500,800],
      "yieldRainfedTHa": [0.5,2.0], "yieldGoodTHa": [4,6], "spacingCm": [75,30], "seedKgHa": 25, "seedCostKesPerKg": 262,
      "priceKesPerKg": 44, "priceSrc": "S NCPB Jan 2026 KES 4,000/90 kg", "seasons": ["MAM","OND"],
      "pests": ["fall armyworm","stem borer","striga"], "provenance": "kc R; p/root/Ky C; stageDaysGame A; seedKgHa A; seed cost S (KES 525/2 kg)" },
    { "id": "sorghum", "seasons": ["MAM","OND"], "seedCostKes": null, "osiKcId": "sorghum", "kc": [0.30,1.00,0.55], "stageDaysEdge": [20,35,40,30], "stageDaysGame": [20,35,45,30],
      "rootMinM": 0.15, "rootMaxM": 1.5, "p": 0.55, "ky": 0.90, "seasonWaterMm": [450,650],
      "yieldRainfedTHa": [0.5,1.0], "yieldGoodTHa": [3,4], "spacingCm": [60,20], "seedKgHa": 8, "priceKesPerKg": 50,
      "pests": ["stem borer (Chilo)","shoot fly","quelea birds","striga"], "provenance": "stageDaysGame C (FAO Arid region); yields rainfed S/A; good A; price A" },
    { "id": "pearl_millet", "seasons": ["MAM","OND"], "seedCostKes": null, "osiKcId": "millet", "kc": [0.30,1.00,0.30], "stageDaysEdge": [20,30,55,35], "stageDaysGame": [15,25,40,25],
      "rootMinM": 0.15, "rootMaxM": 1.5, "p": 0.55, "ky": 0.90, "seasonWaterMm": [450,650],
      "yieldRainfedTHa": [0.2,0.8], "yieldGoodTHa": [1.2,1.7], "spacingCm": [75,20], "seedKgHa": 5, "priceKesPerKg": 55,
      "pests": ["birds","striga","downy mildew","fall armyworm"], "provenance": "stageDaysGame C (FAO Pakistan row); ky A; yields S; spacing/seed/price A" },
    { "id": "cowpea", "seasons": ["MAM","OND","irrigated dry season (leaf)"], "seedCostKes": null, "osiKcId": "green_gram", "kc": [0.40,1.05,0.35], "stageDaysEdge": [20,30,30,20], "stageDaysGame": [15,25,30,15],
      "rootMinM": 0.15, "rootMaxM": 0.8, "p": 0.45, "ky": 1.10, "seasonWaterMm": [300,500],
      "yieldRainfedTHa": [0.3,0.6], "yieldGoodTHa": [1.0,1.5], "spacingCm": [60,30], "seedKgHa": 20, "priceKesPerKg": 90, "leafHarvest": true,
      "pests": ["aphids","pod borer","thrips"], "provenance": "FAO shared 'green gram and cowpeas' Kc row R/C; ky A; yields S/A; price A" },
    { "id": "green_gram", "seasons": ["OND","MAM"], "seedCostKes": null, "osiKcId": "green_gram", "kc": [0.40,1.05,0.35], "stageDaysEdge": [20,30,30,20], "stageDaysGame": [12,20,25,13],
      "rootMinM": 0.15, "rootMaxM": 0.8, "p": 0.45, "ky": 1.15, "seasonWaterMm": [300,500],
      "yieldRainfedTHa": [0.3,0.9], "yieldGoodTHa": [1.5,2.1], "spacingCm": [50,10], "seedKgHa": 15, "priceKesPerKg": 60,
      "pests": ["powdery mildew","aphids","thrips"], "provenance": "maturity 65-75 d S (KALRO); yields S; price S low confidence; ky/seed A" },
    { "id": "dry_bean", "seasons": ["MAM","OND"], "seedCostKes": null, "osiKcId": "dry_bean", "kc": [0.40,1.15,0.35], "stageDaysEdge": [20,30,40,20], "stageDaysGame": [15,25,35,20],
      "rootMinM": 0.15, "rootMaxM": 0.75, "p": 0.45, "ky": 1.15, "seasonWaterMm": [300,500],
      "yieldRainfedTHa": [0.3,0.9], "yieldGoodTHa": [1.5,2.0], "spacingCm": [50,10], "seedKgHa": 60, "priceKesPerKg": 115,
      "pests": ["bean fly","anthracnose","rust"], "provenance": "stageDaysGame C; yields S/A; price/seed A" },
    { "id": "tomato", "seasons": ["irrigated dry season (Jun-Sep, Jan-Feb)","rains (higher disease)"], "seedCostKes": null, "osiKcId": "tomato", "transplanted": true, "nurseryDays": 35, "kc": [0.60,1.15,0.70], "stageDaysEdge": [30,40,45,30], "stageDaysGame": [25,35,40,25],
      "rootMinM": 0.10, "rootMaxM": 1.0, "p": 0.40, "ky": 1.05, "seasonWaterMm": [400,800],
      "yieldRainfedTHa": null, "yieldIrrigatedSmallholderTHa": [10,25], "yieldHighInputTHa": [30,99], "spacingCm": [90,50], "seedGPerAcre": [40,75],
      "priceKesPerKg": { "glut": 17, "typical": 50, "shortage": 115, "retailSep2025": 83 }, "priceSrc": "S crate 60 kg KES 1,000 (Jan 2026) to 6,800-7,000 (Apr 2026)",
      "pests": ["african bollworm","early blight (overhead watering raises risk)","bacterial/fusarium wilt","whitefly-borne virus"], "provenance": "SHEP C for spacing/seed/high-input yield; smallholder yield A" },
    { "id": "onion", "seasons": ["irrigated dry season"], "seedCostKes": null, "osiKcId": "onion", "kc": [0.70,1.05,0.75], "stageDaysEdge": [15,25,70,40], "stageDaysGame": [15,25,60,25],
      "rootMinM": 0.10, "rootMaxM": 0.45, "p": 0.30, "ky": 1.10, "seasonWaterMm": [350,550],
      "yieldIrrigatedSmallholderTHa": [10,25], "spacingCm": [30,10], "priceKesPerKg": 90, "priceSrc": "S farm gate KES 80-100 Sep 2025 (shortage)",
      "pests": ["thrips","purple blotch","downy mildew"], "provenance": "yields/spacing A" },
    { "id": "cabbage", "seasons": ["irrigated dry season","rains"], "seedCostKes": null, "osiKcId": "cabbage", "transplanted": true, "nurseryDays": 30, "kc": [0.70,1.05,0.95], "stageDaysEdge": [20,30,20,10], "stageDaysGame": [25,35,30,10],
      "rootMinM": 0.10, "rootMaxM": 0.65, "p": 0.45, "ky": 0.95, "seasonWaterMm": [350,500],
      "yieldIrrigatedSmallholderTHa": [20,40], "spacingCm": [60,45], "priceKesPerKg": 53, "priceSrc": "S retail May 2025",
      "pests": ["diamondback moth","aphids","black rot"], "provenance": "yields/spacing A" },
    { "id": "kale", "osiKcId": "cabbage", "osiKcNote": "no kale row in crop-kc.json; FAO groups it under crucifers", "transplanted": true, "nurseryDays": 30,
      "kc": [0.70,1.05,0.95], "firstHarvestDaysAfterTransplant": 45, "pickingWindowDays": 150, "pickEveryDays": 7,
      "rootMinM": 0.10, "rootMaxM": 0.65, "p": 0.45, "ky": 0.95,
      "yieldTHa": [20,37], "spacingCm": [60,50], "seedGPerAcre": 50, "priceKesPerKg": 90, "priceSrc": "S retail May 2025",
      "pests": ["diamondback moth","cabbage sawfly","aphids","cutworms"], "seasons": ["year-round irrigated"], "seedCostKes": null, "provenance": "first harvest/spacing (60 x 40-60)/seed/yield 37/pests C SHEP; 20 S; p/ky/root A" },
    { "id": "amaranth", "seasons": ["year-round with water"], "seedCostKes": null, "osiKcId": "spinach", "osiKcNote": "no amaranth row; spinach is the closest FAO leafy row", "kc": [0.70,1.00,0.95],
      "firstCutDaysAfterTransplant": 42, "stageDaysEdge": [20,20,15,5],
      "rootMinM": 0.10, "rootMaxM": 0.5, "p": 0.35, "ky": 1.0,
      "yieldTHa": [12,28], "spacingCm": [30,15], "priceKesPerKg": 50,
      "pests": ["spider mites","weevils"], "provenance": "first cut/spacing/yield S; p/ky/price A" }
  ],
  "rootGrowth": { "src": "A (FAO-56 practice)", "rule": "linear from rootMinM at sowing/transplant to rootMaxM at end of development stage" },
  "pAdjust": { "src": "C FAO-56", "formula": "p = p_table + 0.04*(5 - ETc_mm_d), clamp [0.1, 0.8]" },
  "yieldResponse": { "src": "C FAO-33", "formula": "1 - Ya/Ym = Ky * (1 - ETa/ETc), seasonal" },
  "postHarvestLoss": { "src": "S APHLIS Kenya 2021", "maize": { "fieldDrying": 0.064, "storage": 0.025, "total": 0.167 },
                       "sorghum": { "fieldDrying": 0.046, "storage": 0.010, "total": 0.126 } },
  "currency": { "src": "S", "kesPerUsd2025": 129.3 }
}
```

### D. Water ladder (game economy)

```json
{
  "waterLadder": [
    { "id": "jerrycan", "litresPerTrip": 20, "roundTripMin": 33, "efficiency": 0.75, "src": "S UNICEF (trip); efficiency A" },
    { "id": "watering_can", "litresPerFill": 12, "efficiency": 0.75, "costKes": 800, "src": "A" },
    { "id": "scoop_hole_or_shallow_well", "costKes": 0, "labourDays": 3, "seasonalYieldFactor": "drops in dry season", "src": "A" },
    { "id": "hip_or_treadle_pump", "flowLMinMax": 60, "headMMax": 14, "costKes": [6090, 13000], "efficiency": 0.60, "src": "S E4C/JETRO 2015; efficiency C FAO surface" },
    { "id": "petrol_pump", "costKes": [20000,35000], "fuelLPerHour": 0.6, "efficiency": 0.60, "src": "A" },
    { "id": "solar_pump_kit", "cashKes": [64999,77999], "depositKes": 4999, "monthlyKes": [3809,4900], "months": [24,30], "src": "S vendor list (use fictional brand)" },
    { "id": "drip_kit_small", "costKes": 20000, "excludesTank": true, "efficiency": 0.90, "minAreaM2": 15, "src": "S 2013 news; efficiency C FAO" },
    { "id": "drip_kit_quarter_acre", "costKes": 40000, "excludesTank": true, "tankHeightM": 1.5, "efficiency": 0.90, "src": "S" },
    { "id": "farm_pond", "excavationKesPerM3": [150,400], "linerKesExample": 160000, "src": "S" },
    { "id": "sand_dam_community", "costUsd": 9000, "communityLabourShare": [0.30,0.35], "storageM3": [3500,5000], "src": "S" },
    { "id": "kiosk_water", "kesPer20L": [2,5], "src": "A" }
  ],
  "applicationEfficiency": { "src": "C FAO TM4 ch3", "surface": 0.60, "sprinkler": 0.75, "drip": 0.90 }
}
```

---

## Not verified or not found (re-check before shipping)

- I could not open any station table of Markov-chain or gamma parameters for semi-arid Kenya.
  The generator is derived; see section 1.6.
- FAO-33 has no Ky for millet, cowpea or green gram; those values are assumed.
- Smallholder tomato, onion and cabbage yields, and the prices of sorghum, millet, cowpea and
  beans, are assumed.
- Sources for water-kiosk fees, petrol-pump prices, chicken and cow prices, market-day patterns
  and hand-dug-well yields were not found.
- Several Kenya climate statistics are [S]: Springer, ICRISAT and the University of Nairobi
  blocked or refused fetches.
- The 31.4%/35.3% good/failed long-rains figures and the 45-58% CV come from a summary of a
  paper I could not open.
- Seed costs are missing for every crop except maize; `seedCostKes` is null for those crops.
- No quantified source was found for:
  - a full daily time budget per household member;
  - school attendance and fees;
  - chicken and cow prices;
  - input-credit terms;
  - cooperative membership;
  - market-day frequency.
  Section 5 gives design defaults only.
