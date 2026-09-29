"""Build table11-stage-lengths.json from the fetched Table 11 rows (table11_rows.json beside this file)
and the OSI crop catalogue. Every number comes from the fetched FAO-56 page; the crop -> row
mapping and the proposals for crops without a row are editorial choices recorded per entry."""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOGUE_PATH = os.path.join(HERE, "..", "crop-kc.json")
with open(os.path.join(HERE, "table11_rows.json"), encoding="utf-8") as fh:
    ROWS = json.load(fh)
with open(CATALOGUE_PATH, encoding="utf-8") as fh:
    CAT = json.load(fh)

# ---- cleaning of cells that carry footnote markers, typos, slashes or split cells --------
# (stage values chosen per row; 'why' is recorded in transcription_note)
OVERRIDES = {
    2:  dict(stages=(20, 30, 30, 20), plant_date="Oct/Jan", note="mid printed '50/30', total printed 100; mid 30 is the value consistent with the printed total"),
    22: dict(stages=(20, 20, 15, 5), plant_date="Apr", note="mid printed '15/25', total '60/70', plant date 'Apr; Sep/Oct'; the April variant (mid 15, total 60) is used; Sep/Oct variant is mid 25, total 70"),
    26: dict(stages=(30, 40, 40, 20), note="total printed '130\\1' in the HTML (footnote marker residue); 130 = sum of stages"),
    27: dict(stages=(30, 45, 40, 25), note="total printed '40' in the HTML edition; the stages sum to 140 (printing error in the online edition)"),
    28: dict(stages=(30, 35, 40, 20), note="initial printed '25/30' for plant date 'April/June'; 30 chosen because it agrees with the printed total 125 (25 would give 120)"),
    51: dict(crop="Cassava: year 1", plant_date="Rainy season", region="Tropical regions", note="HTML splits the plant-date cell 'Rainy season' across the year-1 and year-2 rows; region cell spans both rows (interpretation of the HTML layout)"),
    52: dict(crop="Cassava: year 2", plant_date="Rainy season", region="Tropical regions", note="see year 1: plant date and region cells span both cassava rows (interpretation of the HTML layout)"),
    53: dict(stages=(25, 30, 30, 30), plant_date="Jan", note="mid printed '30/45', total '115/130', plant date 'Jan/Nov'; the Jan variant (mid 30, total 115) is used"),
    77: dict(plant_date="Dry season", note="HTML splits 'Dry season' across two rows; interpretation: West Africa = dry season (UNVERIFIED against the printed PDF)"),
    78: dict(plant_date="May", note="HTML plant-date cell reads 'season' (overflow of 'Dry season' from the row above); interpretation: High Latitudes row = May (UNVERIFIED against the printed PDF)"),
    79: dict(plant_date="May/June", note="HTML plant-date cell reads 'May May/June' (shifted cell); interpretation: Mediterranean row = May/June (UNVERIFIED against the printed PDF)"),
    86: dict(stages=(20, 35, 60, 25), note="development printed '30/35'; 35 chosen because it agrees with the printed total 140"),
    111: dict(stages=(20, 60, 70, 30), note="initial and development printed '20 2' and '60 2' (footnote 2 markers)"),
    124: dict(stages=(20, 30, 30, 10), note="mid printed '50/30', total 90; mid 30 agrees with the printed total"),
    125: dict(stages=(30, 30, 30, 10), note="late printed '103' = 10 with footnote 3 marker ('late season for sweet maize will be about 35 days if the grain is allowed to mature and dry')"),
    132: dict(stages=(30, 30, 80, 40), note="development printed '30.' (stray period)"),
    133: dict(stages=None, crop="Alfalfa, total season", note="mid, late and total printed 'var.'; season = last -4 degC in spring until first -4 degC in fall (footnote 4)"),
    134: dict(crop="Alfalfa, 1st cutting cycle", plant_date="Jan", note="HTML plant-date cell 'Jan Apr (last - 4°C)' spans the Calif. and Idaho rows; interpretation: Calif. = Jan"),
    135: dict(crop="Alfalfa, 1st cutting cycle", plant_date="Apr (last -4°C)", note="HTML plant-date cell of this row is empty; the shared cell above reads 'Jan Apr (last - 4°C)'; interpretation: Idaho = Apr (last -4 degC); these 10/30/25/10 lengths are the ones chapter 6 quotes for cutting cycle 1 in Figure 35"),
    136: dict(crop="Alfalfa, other cutting cycles"),
    137: dict(crop="Alfalfa, other cutting cycles", note="chapter 6 (Figure 35 text) quotes these Idaho lengths as 5/20/10/10 for cutting cycles 2-4"),
    140: dict(stages=None, crop="Grass Pasture", note="mid, late and total printed '--'; season = 7 days before last -4 degC in spring until 7 days after first -4 degC in fall (footnote 4; the footnote text itself says 'after last -4° C in fall')"),
    141: dict(crop="Sudan, 1st cutting cycle"),
    149: dict(crop="Banana, 1st yr"), 150: dict(crop="Banana, 2nd yr"),
    161: dict(stages=(30, 90, 60, 90), note="total printed '2705' = 270 with footnote 5 ('Olive trees gain new leaves in March. See footnote 24 of Table 12 ... where the Kc continues outside of the growing period')"),
    164: dict(region="Utah, USA; killing frost"),
}
FOOTNOTE_CROP = {"Crucifers 1": "Crucifers", "Alfalfa, total season 4": "Alfalfa, total season",
                 "Grass Pasture 4": "Grass Pasture"}

def row(idx):
    r = ROWS[idx]; p = r["printed"]; ov = OVERRIDES.get(idx, {})
    crop = ov.get("crop", FOOTNOTE_CROP.get(r["crop"], r["crop"]))
    if "stages" in ov:
        st = ov["stages"]
    else:
        st = tuple(int(p[k]) for k in ("init", "dev", "mid", "late"))
    out = {"table11_row": crop,
           "stage_lengths_days": None if st is None else dict(zip(["initial","development","mid_season","late_season"], st)),
           "total_days": None if st is None else sum(st),
           "plant_date": ov.get("plant_date", p["plant_date"]),
           "region": ov.get("region", p["region"]),
           "table11_section": r["group"],
           "html_cells": p,
           "verified": True}
    if st is not None and p["total"] not in ("var.", "--") and str(sum(st)) != p["total"]:
        out.setdefault("transcription_note", "")
    if "note" in ov:
        out["transcription_note"] = ov["note"]
    elif "transcription_note" in out:
        out["transcription_note"] = "printed total %r differs from the stage sum %d" % (p["total"], sum(st))
    return out

# ---- mapping --------------------------------------------------------------------------
# rule texts
R_EU = "European row (preferred: Europe first, then Mediterranean, then temperate, then first row)"
R_MED = "Mediterranean row (no European row; spring planting preferred among Mediterranean rows)"
R_TEMP = "temperate row (no European or Mediterranean row)"
R_FIRST = "first row (no European, Mediterranean or temperate row)"
R_ONLY = "only row"
CRUC = "class row: Table 11 footnote 1 says 'Crucifers include cabbage, cauliflower, broccoli, and Brussel sprouts'; own-named rows (if any) are Calif. Desert winter crops only, so the Mediterranean spring (April) Crucifers row is the default"
DECID = "class row 'Deciduous Orchard' (Table 11 has no apple/pear/stone-fruit rows; Table 12 groups these as deciduous fruit trees); High Latitudes = temperate row"

M = {}  # crop id -> (default idx, [candidate idxs], rule, extra note)
def m(cid, d, cands, rule, note=None): M[cid] = (d, cands, rule, note)

m("broccoli", 9, [0, 9, 10, 11], CRUC)
m("brussels_sprouts", 9, [9, 10, 11], "class row: no own row; " + CRUC.split("; ", 1)[0].replace("class row: ", "") + "; Mediterranean spring (April) row")
m("cabbage", 9, [1, 9, 10, 11], CRUC)
m("cauliflower", 9, [5, 9, 10, 11], CRUC)
m("carrot", 3, [2, 3, 4], "Mediterranean row (only one)")
m("celery", 7, [6, 7, 8], "Mediterranean row (only one)")
m("lettuce", 12, [12, 13, 14, 15], R_MED)
m("onion", 16, [16, 17], "Mediterranean row (only one)")
m("onion_green", 18, [18, 19, 20], "Mediterranean row (only one)")
m("onion_seed", 21, [21], R_ONLY)
m("radish", 24, [24, 25], "Europe/Mediterranean row ('Medit.; Europe')")
m("spinach", 22, [22, 23], "Mediterranean row; April variant of the split 'Apr; Sep/Oct' entry")
m("eggplant", 27, [26, 27], "Mediterranean row (only one)")
m("pepper", 28, [28, 29], "Europe and Mediterranean row ('Europe and Medit.')")
m("tomato", 34, [30, 31, 32, 33, 34], "Mediterranean row (only one)")
m("cantaloupe", 35, [35, 36], R_FIRST)
m("cucumber", 37, [37, 38], R_FIRST)
m("cucumber_machine_harvest", 37, [37, 38], R_FIRST + "; Table 11 has one Cucumber entry for both harvest types")
m("pumpkin", 40, [39, 40], R_EU)
m("sweet_melon", 43, [43, 44, 45, 46], "Mediterranean row (only one)")
m("watermelon", 47, [47, 48], "European row (Italy)")
m("zucchini", 42, [41, 42], "Europe/Mediterranean row ('Medit.; Europe') preferred over 'Medit.; Arid Reg.'")
m("cassava", 51, [51], R_ONLY + " (year 1)")
m("cassava_year_2", 52, [52], R_ONLY + " (year 2)")
m("potato", 55, [53, 54, 55, 56, 57], R_EU)
m("sugar_beet", 64, [60, 61, 62, 63, 64, 65, 66], R_MED + " (May; the other Mediterranean row is a November planting)")
m("sweet_potato", 58, [58, 59], "Mediterranean row (only one)")
m("table_beet", 49, [49, 50], R_MED + " (Apr/May)")
m("dry_bean", 69, [69, 70, 71], R_TEMP + " ('Continental Climates'; chapter 6 Box 15 uses this row for Kimberly, Idaho)")
m("faba_bean", 72, [72, 73, 74, 75], R_EU + " (May spring planting)")
m("faba_bean_dry", 74, [72, 73, 74, 75], "row labelled '- dry' (harvest type matches the catalogue variant), Europe, November planting; the spring rows are alternatives")
m("green_bean", 67, [67, 68], "Mediterranean row ('Calif., Mediterranean')")
m("green_gram", 76, [76], R_ONLY + " (Mediterranean)")
m("groundnut", 79, [77, 78, 79], "Mediterranean row (only one)")
m("lentil", 80, [80, 81], R_EU)
m("peas", 82, [82, 83, 84], R_EU)
m("peas_dry", 82, [82, 83, 84], R_EU + "; Table 11 has one Peas entry for fresh and dry harvest")
m("soybean", 86, [85, 86, 87], R_TEMP + " (Central USA)")
m("artichoke", 88, [88, 89], R_FIRST + " (1st-year stand; the 2nd-year row, cut in May, is the alternative for established stands)")
m("asparagus", 91, [90, 91], "Mediterranean row (only one)")
m("cotton", 92, [92, 93, 94, 95], R_FIRST)
m("flax", 96, [96, 97], R_EU)
m("castor_bean", 98, [98, 99], R_FIRST)
m("safflower", 101, [100, 101, 102], R_TEMP + " (High Latitudes)")
m("sesame", 103, [103], R_ONLY)
m("sunflower", 104, [104], R_ONLY + " ('Medit.; California')")
BOW = "own-named 'Barley/Oats/Wheat' rows contain no European or Mediterranean row; temperate row '35-45 °L' (March/April) chosen. Own-named rows take precedence over the class row 'Grains (small)' (Mediterranean April, kept as alternative)"
m("barley", 106, [105, 106, 107, 108, 109, 110, 114, 115], BOW)
m("oats", 106, [105, 106, 107, 108, 109, 110, 114, 115], BOW)
m("wheat", 106, [105, 106, 107, 108, 109, 110, 114, 115], BOW + "; spring wheat")
m("winter_wheat", 112, [111, 112, 113], "Mediterranean row (non-frozen soils)")
m("winter_wheat_frozen", 113, [111, 112, 113], "frozen-soil variant: Table 11 footnote 2 says winter wheat periods 'will lengthen in frozen climates according to days having zero growth potential and wheat dormancy'; the Idaho October row (initial 160 d spanning winter) is the only row that includes winter dormancy")
m("maize", 120, [116, 117, 118, 119, 120, 121], "European row ('Spain (spr, sum.); Calif.')")
m("maize_sweet", 123, [122, 123, 124, 125, 126], "Mediterranean row (only one)")
m("millet", 128, [127, 128], R_TEMP + " (Central USA)")
m("rice", 131, [131, 132], "Mediterranean row ('Tropics; Mediterranean', plant date 'Dec; May')")
m("sorghum", 129, [129, 130], "row naming the Mediterranean ('USA, Pakis., Med.')")
m("sorghum_sweet", 129, [129, 130], "row naming the Mediterranean ('USA, Pakis., Med.'); Table 11 has one Sorghum entry for grain and sweet")
m("alfalfa", 135, [133, 134, 135, 136, 137], R_TEMP + " (Idaho) for the first cutting cycle; later cycles use 'other cutting cycles' Idaho 5/20/10/10 (as in chapter 6, Figure 35)")
m("bermuda", 139, [139], R_ONLY + " (hay, several cuttings)")
m("bermuda_seed", 138, [138], R_ONLY + " (seed)")
m("sudan_grass_cutting", 141, [141, 142], R_FIRST + " (1st cutting cycle); later cycles use the 'other cutting cycles' row")
m("sugarcane", 143, [143, 144, 145, 146, 147, 148], R_FIRST + " (virgin cane, Low Latitudes)")
m("banana", 149, [149], R_ONLY + " (Mediterranean)")
m("banana_year_2", 150, [150], R_ONLY + " (Mediterranean)")
m("pineapple", 151, [151], R_ONLY)
m("pineapple_grass_cover", 151, [151], R_ONLY + "; Table 11 has one Pineapple entry")
m("grapevine", 155, [152, 153, 154, 155], "temperate row labelled for wine ('Mid Latitudes (wine)')")
m("grapes_table", 154, [152, 153, 154, 155], R_TEMP + " (High Latitudes; first temperate row, the Mid Latitudes row is labelled wine)")
m("hops", 156, [156], R_ONLY)
for cid in ["almond", "apple", "apple_cover_frost", "apple_cover_no_frost", "apple_no_cover_no_frost",
            "apricot", "cherry", "pear", "peach", "peach_cover_frost", "peach_cover_no_frost",
            "peach_no_cover_no_frost", "plum"]:
    extra = None
    if "no_frost" in cid:
        extra = "catalogue variant is for frost-free climates; the Low Latitudes row (20/70/120/60 = 270 d) may fit better there - left to the regional selector"
    if cid == "almond":
        extra = "almond is mostly grown in Mediterranean/Californian climates; the Calif., USA or Low Latitudes rows may fit better there"
    m(cid, 158, [158, 159, 160], DECID, extra)
m("pecan", 158, [158, 159, 160], DECID + "; Table 12 footnote 20: 'Stone fruit category applies to peaches, apricots, pears, plums and pecans'",
  "pecan has no Table 12 row of its own in the catalogue (fao_row null)")
for cid in ["citrus", "citrus_20_cover", "citrus_20_no_cover", "citrus_50_cover", "citrus_50_no_cover", "citrus_70_cover"]:
    m(cid, 157, [157], R_ONLY + " (Mediterranean)")
m("olive", 161, [161], R_ONLY + " (Mediterranean)")
m("pistachio", 162, [162], R_ONLY + " (Mediterranean)")
m("walnut", 163, [163], R_ONLY + " (Utah, USA)")
m("cattails_frost", 164, [164, 165], "row labelled 'killing frost' (matches the catalogue variant)")
m("cattails_no_frost", 165, [164, 165], "frost-free row (Florida, USA; matches the catalogue variant)")
m("short_vegetation_wetland", 166, [166], R_ONLY + " (frost-free climate)")

# rows exist but give no numeric lengths
PARTIAL = {
    "alfalfa_averaged": (133, "Table 11 'Alfalfa, total season' row: initial 10, development 30, mid/late/total 'var.'; the season runs from the last -4 degC in spring to the first -4 degC in fall (footnote 4). Build the averaged curve from that window: 10 d initial, 30 d development, then mid-season until the late season before frost; the late-season length is not given in Table 11."),
    "grass": (140, "Table 11 'Grass Pasture' row: initial 10, development 20, mid/late/total '--'; season = 7 days before last -4 degC in spring until 7 days after first -4 degC in fall (footnote 4). Mid and late lengths come from that window, not from the table."),
    "pasture_extensive": (140, "as 'grass': Table 11 'Grass Pasture' row gives only initial 10 and development 20; season window from footnote 4."),
    "pasture_rotated": (140, "as 'grass': Table 11 'Grass Pasture' row gives only initial 10 and development 20; season window from footnote 4."),
}

# crops without a Table 11 row -> proposal (idx or special) + basis
EVERGREEN = ("no stage progression: evergreen, year-round crop. Chapter 5: 'For some perennial vegetation in frost free climates, crops may grow year round so that the date of termination may be taken as the same as the date of planting'; chapter 6: 'The Kc ini and Kc end for evergreen non dormant trees and shrubs are often not different, where climatic conditions do not vary much'. Table 12 lists nearly equal Kc ini/mid/end for this crop. Proposal: a 365-day cycle with Kc interpolated only between near-equal values (or constant Kc mid).")
NOROW = {
    "garlic": (16, "Onion (dry), Mediterranean April row: closest bulb crop in the same Table 11/12 section (small vegetables); garlic Kc 0.7/1.00/0.70 vs onion dry 0.7/1.05/0.75."),
    "parsnip": (3, "Carrots, Mediterranean Feb/Mar row: parsnip is a taproot vegetable like carrot (Table 12 parsnip 0.5/1.05/0.95 vs carrot 0.7/1.05/0.95)."),
    "turnip": (49, "Beets, table, Mediterranean Apr/May row: root crop harvested fresh in the same Table 12 group (turnip 1.10/0.95 vs table beet 1.05/0.95). Rutabaga has a longer season; local lengths should replace this."),
    "chickpea": (80, "Lentil, Europe April row: cool-season grain legume harvested dry (Table 12 chickpea mid/end 1.00/0.35 vs lentil 1.10/0.30)."),
    "garbanzo": (80, "Lentil, Europe April row (same basis as chickpea; 'Grabanzo' in Table 12 is the same species as chick pea)."),
    "mint": ("group", "perennial_vegetables group default."),
    "strawberry": ("group", "perennial_vegetables group default."),
    "sisal": ("evergreen", "Table 12 lists sisal with Kc mid = Kc end = 0.4-0.7 (planting density and water management, footnote 8); a perennial with no seasonal stages. " + EVERGREEN),
    "rapeseed": (101, "Safflower, High Latitudes March row: spring-sown oil crop in the same Table 12 group (rapeseed Kc mid 1.0-1.15, end 0.35; safflower 1.0-1.15, 0.25). Winter (autumn-sown) rapeseed, the usual European form, over-winters like winter wheat and needs local lengths."),
    "alfalfa_seed": (133, "Alfalfa total-season window (Table 11 'Alfalfa, total season', footnote 4); Table 11 has no seed-crop row."),
    "clover_hay": (133, "Alfalfa, total season window (footnote 4): clover/berseem is the other multi-cut legume hay in Table 12; averaged-cutting curve over the frost-to-frost season."),
    "clover_hay_cutting": (135, "Alfalfa 1st cutting cycle Idaho row, followed by the 'other cutting cycles' Idaho row (5/20/10/10) for later cuts, as chapter 6 builds Figure 35 for alfalfa."),
    "ryegrass_hay": (140, "Grass Pasture window (footnote 4): cool-season grass."),
    "sudan_grass": (141, "no averaged-cutting row: concatenate 'Sudan, 1st cutting cycle' (25/25/15/10) and 'Sudan, other cutting cycles' (3/15/12/7) and use the averaged Kc mid of Table 12 over the span, or model individual cuts."),
    "turf_cool": (140, "Grass Pasture window (footnote 4): cool-season turf is a grass; chapter 6 notes turf can go dormant under long high temperatures (> 35 degC)."),
    "turf_warm": (140, "Grass Pasture window (footnote 4); warm-season turf in frost-free climates grows year round (chapter 5 year-round rule)."),
    "cocoa": ("evergreen", EVERGREEN), "coffee": ("evergreen", EVERGREEN), "coffee_with_weeds": ("evergreen", EVERGREEN),
    "date_palm": ("evergreen", EVERGREEN), "palm": ("evergreen", EVERGREEN), "rubber": ("evergreen", EVERGREEN),
    "tea": ("evergreen", EVERGREEN), "tea_shaded": ("evergreen", EVERGREEN),
    "mango": ("evergreen", "mango has no Table 11 or Table 12 row (catalogue fao_row null). " + EVERGREEN.replace("Table 12 lists nearly equal Kc ini/mid/end for this crop. ", "")),
    "papaya": ("evergreen", "papaya has no Table 11 or Table 12 row (catalogue fao_row null). " + EVERGREEN.replace("Table 12 lists nearly equal Kc ini/mid/end for this crop. ", "")),
    "conifer": ("evergreen", "Table 12 conifer Kc 1.00/1.00/1.00. " + EVERGREEN),
    "berries": (158, "Deciduous Orchard, High Latitudes row: chapter 6 says 'The lengths of the initial and development periods may be relatively short for deciduous trees and shrubs that can develop new leaves in the spring at relatively fast rates'; berry bushes are deciduous shrubs."),
    "blueberry": (158, "Deciduous Orchard, High Latitudes row (deciduous shrub; no Table 11 or 12 row, catalogue fao_row null)."),
    "raspberry": (158, "Deciduous Orchard, High Latitudes row (deciduous cane fruit; no Table 11 or 12 row, catalogue fao_row null)."),
    "avocado": (157, "Citrus, Mediterranean row (365 d): avocado is an evergreen subtropical orchard tree like citrus; Table 12 avocado 0.60/0.85/0.75."),
    "fig": ("group", "fruit_trees group default (deciduous tree; no Table 11 or 12 row, catalogue fao_row null)."),
    "hazelnut": ("group", "fruit_trees group default (deciduous tree; no Table 11 or 12 row, catalogue fao_row null)."),
    "pomegranate": ("group", "fruit_trees group default (deciduous shrub/tree; no Table 11 or 12 row, catalogue fao_row null)."),
    "kiwi": ("group", "fruit_trees group default (kiwi is a deciduous vine; Table 12 has a Kiwi row, Table 11 does not)."),
    "reed_swamp_moist_soil": (164, "Wetlands (Cattails, Bulrush) row matching the frost regime: Utah killing-frost row for temperate sites, Florida row (365 d) for frost-free sites; reed swamp is listed next to cattails in the Table 12 wetlands section."),
    "reed_swamp_standing_water": (164, "same basis as reed_swamp_moist_soil."),
}

GROUP_DEFAULTS = {
    "small_vegetables": (9, "Crucifers, Mediterranean April: the multi-species row of the small-vegetables section, spring planting, 80 d."),
    "vegetables_solanum": (34, "Tomato, Mediterranean April/May row."),
    "vegetables_cucumber": (42, "Squash, Zucchini, 'Medit.; Europe' May/June row: the only row of the section naming Europe with a spring planting besides pumpkin (June)."),
    "roots_tubers": (55, "Potato, Europe April row."),
    "legumes": (82, "Peas, Europe May row (grain legumes harvested dry: use Lentil Europe April, 20/30/60/40)."),
    "perennial_vegetables": (140, "No Table 11 row fits herbaceous perennials such as mint or strawberry. Proposal: treat like the Grass Pasture window (footnote 4: greenup ~7 d before last -4 degC in spring to ~7 d after first -4 degC in fall) with initial 10 and development 20 d, mid-season until the late season before frost. Chapter 5: for perennials the planting date is replaced by the greenup date."),
    "fibre": (96, "Flax, Europe April row."),
    "oil_crops": (104, "Sunflower, 'Medit.; California' April/May row."),
    "cereals": (106, "Barley/Oats/Wheat, 35-45 °L March/April row."),
    "forages": (140, "Grass Pasture window (initial 10, development 20, rest from the frost-to-frost season, footnote 4)."),
    "sugar_cane": (143, "Sugarcane virgin, Low Latitudes (first row)."),
    "tropical_fruits": ("evergreen", EVERGREEN),
    "grapes_berries": (154, "Grapes, High Latitudes May row (first temperate row); berries use the deciduous-orchard proposal."),
    "fruit_trees": (158, "Deciduous Orchard, High Latitudes March row (temperate); evergreen citrus/olive/avocado have their own rows or proposals."),
    "wetlands": (164, "Wetlands (Cattails, Bulrush), Utah killing-frost row (temperate)."),
}

# perennial dormancy / growing-season notes
DECID_SEASON = ("growing season only: Table 11 lengths cover greenup (leaf initiation, the 'planting' date for perennials per chapter 5) to leaf drop; the rest of the year is dormancy. Table 12 footnote 18: after leaf drop Kc end ~0.20 for bare, dry soil or dead ground cover and ~0.50-0.80 for actively growing ground cover (consult chapter 11). The curve restarts at the next greenup.")
def season_note(cid, grp, r):
    tot = r["total_days"]
    if grp == "fruit_trees" and cid.startswith(("citrus",)):
        return "evergreen, 365-day cycle starting January (Table 11); no dormancy gap. Chapter 6: evergreen orchard Kc ini varies less from Kc mid (Table 12 fn 21, 22)."
    if cid == "olive":
        return ("growing season 270 d from March (Table 11 footnote 5: 'Olive trees gain new leaves in March'); Table 12 footnote 24 continues Kc outside the growing period: Kc during the winter ('off season') December to February = 0.50; the Spanish monthly series (Pastor and Orgaz 1994) is invoked with Kc ini 0.65, mid 0.45, end 0.65 and stage lengths 30/90/60/90.")
    if grp in ("fruit_trees", "grapes_berries") and tot:
        return ("growing season %d d of 365; dormancy the remaining %d d. " % (tot, 365 - tot)) + DECID_SEASON
    if cid in ("asparagus", "artichoke"):
        return "Table 11 section f: 'Perennial Vegetables (with winter dormancy and initially bare or mulched soil)'. Growing season %d d; the curve restarts each spring at greenup/regrowth." % tot
    return None

def entry_from(idx, rule):
    r = row(idx); d = {"table11_row": r["table11_row"], "stage_lengths_days": r["stage_lengths_days"],
                       "total_days": r["total_days"], "plant_date": r["plant_date"], "region": r["region"],
                       "selection_rule": rule, "verified": True, "table11_section": r["table11_section"],
                       "html_cells": r["html_cells"]}
    if "transcription_note" in r: d["transcription_note"] = r["transcription_note"]
    return d

def proposal(p, basis):
    if p == "evergreen":
        return {"kind": "year_round_no_stages", "table11_row": None, "stage_lengths_days": None,
                "total_days": 365, "basis": basis, "numbers_verified": False,
                "equivalence": "UNVERIFIED: agronomic judgement built on quoted chapter 5/6 text, not a Table 11 row"}
    r = row(p)
    return {"kind": "borrowed_table11_row", "table11_row": r["table11_row"], "plant_date": r["plant_date"],
            "region": r["region"], "stage_lengths_days": r["stage_lengths_days"], "total_days": r["total_days"],
            "basis": basis, "numbers_verified": True,
            "equivalence": "UNVERIFIED: the numbers are verbatim Table 11 values, but applying this row to this crop is agronomic judgement, not stated in FAO-56"}

out_crops = []; n_ver = 0; n_none = 0; n_partial = 0
for c in CAT["crops"]:
    cid, grp = c["id"], c["group"]
    base = {"id": cid, "name": c["label"], "group": grp, "variant_of": c["variant_of"],
            "catalogue_fao_row": c["fao_row"], "catalogue_source": c.get("source")}
    if cid in M:
        d, cands, rule, extra = M[cid]
        e = dict(base); e.update(entry_from(d, rule))
        e["alternatives"] = [entry_from(i, "alternative") for i in cands if i != d]
        if extra: e["note"] = extra
        sn = season_note(cid, grp, e)
        if sn: e["growing_season_note"] = sn
        n_ver += 1
    elif cid in PARTIAL:
        idx, txt = PARTIAL[cid]; r = row(idx)
        e = dict(base); e.update({"table11_row": r["table11_row"], "stage_lengths_days": None, "total_days": None,
             "partial_stage_lengths_days": {"initial": int(r["html_cells"]["init"]), "development": int(r["html_cells"]["dev"]),
                                            "mid_season": r["html_cells"]["mid"], "late_season": r["html_cells"]["late"]},
             "plant_date": r["plant_date"], "region": r["region"],
             "selection_rule": "only row; Table 11 gives no numeric mid/late lengths",
             "verified": True, "note": txt, "html_cells": r["html_cells"], "alternatives": []})
        if cid == "alfalfa_averaged":
            e["alternatives"] = [entry_from(i, "alternative (cutting-cycle rows)") for i in (134, 135, 136, 137)]
        n_partial += 1
    else:
        p, basis = NOROW[cid]
        if p == "group":
            gp, gb = GROUP_DEFAULTS[grp]
            prop = proposal(gp, gb); ptxt = "group default %s" % grp
        else:
            prop = proposal(p, basis); ptxt = "proposed row '%s'" % (prop["table11_row"] or "year-round, no stages")
        e = dict(base); e.update({"table11_row": None, "stage_lengths_days": None, "total_days": None,
             "plant_date": None, "region": None, "selection_rule": None, "verified": False,
             "note": "no Table 11 row; use %s. %s" % (ptxt, basis), "proposed_default": prop, "alternatives": []})
        n_none += 1
    out_crops.append(e)

assert set(M) | set(PARTIAL) | set(NOROW) == {c["id"] for c in CAT["crops"]}
assert not (set(M) & set(NOROW)) and not (set(M) & set(PARTIAL))

group_defaults = {}
for g, (p, basis) in GROUP_DEFAULTS.items():
    group_defaults[g] = proposal(p, basis)

doc = {
  "source": {
    "title": "FAO Irrigation and Drainage Paper 56 (Allen, Pereira, Raes, Smith 1998), chapter 6, Table 11 'Lengths of crop development stages for various planting periods and climatic regions (days)'",
    "url": "https://www.fao.org/4/x0490e/x0490e0b.htm",
    "fetched": "2026-09-26 (parsed rows in table11_rows.json, written by parse_table11.py from a text rendering of the page; the raw HTML is not committed)",
    "table_caveats_quoted": [
      "* Lengths of crop development stages provided in this table are indicative of general conditions, but may vary substantially from region to region, with climate and cropping conditions, and with crop variety. The user is strongly encouraged to obtain appropriate local information.",
      "The values in Table 11 are useful only as a general guide and for comparison purposes. The listed lengths of growth stages are average lengths for the regions and periods specified and are intended to serve only as examples.",
      "Primary source: FAO Irrigation and Drainage Paper 24 (Doorenbos and Pruitt, 1977), Table 22."],
    "table11_footnotes_quoted": {
      "1": "Crucifers include cabbage, cauliflower, broccoli, and Brussel sprouts. The wide range in lengths of seasons is due to varietal and species differences.",
      "2": "These periods for winter wheat will lengthen in frozen climates according to days having zero growth potential and wheat dormancy. Under general conditions and in the absence of local data, fall planting of winter wheat can be presumed to occur in northern temperate climates when the 10-day running average of mean daily air temperature decreases to 17° C or December 1, whichever comes first. Planting of spring wheat can be presumed to occur when the 10-day running average of mean daily air temperature increases to 5° C. Spring planting of maize-grain can be presumed to occur when the 10-day running average of mean daily air temperature increases to 13° C.",
      "3": "The late season for sweet maize will be about 35 days if the grain is allowed to mature and dry.",
      "4": "In climates having killing frosts, growing seasons can be estimated for alfalfa and grass as: alfalfa: last -4° C in spring until first -4° C in fall ... grass: 7 days before last -4° C in spring and 7 days after last -4° C in fall",
      "5": "Olive trees gain new leaves in March. See footnote 24 of Table 12 for additional information, where the Kc continues outside of the \"growing period\"."}
  },
  "selection_policy": [
    "Candidate rows = the crop's own-named Table 11 rows; class rows (Crucifers, Deciduous Orchard) are used when the crop has no own row, or when its own rows contain no European, Mediterranean or temperate row (broccoli, cabbage, cauliflower).",
    "Default = first European row (Europe, Italy, Spain), else first Mediterranean row with a spring planting (Mar-Jun) when several exist, else first temperate row (Continental, High/Mid Latitudes, 35-45 °L, Central USA, Idaho, Utah), else the first row. Catalogue variants override this where the row label matches the variant (winter wheat frozen soils -> Idaho dormancy row; faba dry -> '- dry' row; grapes wine -> '(wine)' row; cattails frost/no frost).",
    "Every other row of the crop (and of the applicable class row) is kept in 'alternatives' with the same fields.",
    "total_days is the sum of the four stage lengths; where the printed total differs (typo, footnote marker) the entry carries a transcription_note and the raw HTML cells in html_cells.",
    "verified: true = the numbers were read from the fetched FAO page. Crops with no Table 11 row have verified: false, stage_lengths_days: null and a proposed_default whose numbers are verbatim Table 11 values but whose applicability is marked UNVERIFIED (judgement)."],
  "counts": {"crops": len(out_crops), "with_verified_numeric_row": n_ver,
             "row_exists_but_no_numeric_lengths": n_partial, "no_table11_row": n_none},
  "group_defaults": group_defaults,
  "crops": out_crops,
}
with open(os.path.join(HERE, "table11-stage-lengths.json"), "w", encoding="utf-8") as fh:
    fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
print(doc["counts"])

# ---- crop-kc.json v2 (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, A1-A4) ----
# Every crop keeps its v1 fields and gains stage_lengths_days (the default row the
# code uses, provenance inline) and stage_length_alternatives (every other row).
STAGE_KEYS = ("initial", "development", "mid_season", "late_season")
V1_KEYS = ("id", "group", "label", "kc_ini", "kc_mid", "kc_end", "variant_of", "fao_row")

def lengths_of(idx, first_two_only=False):
    r = row(idx)
    if r["stage_lengths_days"] is not None:
        st = [r["stage_lengths_days"][k] for k in STAGE_KEYS]
    else:  # 'var.' and '--' rows print only the initial and development lengths (A4)
        st = [int(r["html_cells"]["init"]), int(r["html_cells"]["dev"]), None, None]
    if first_two_only:
        st = st[:2] + [None, None]
    return r, st

def v2_object(idx, selection_rule, verified, first_two_only=False):
    r, st = lengths_of(idx, first_two_only)
    out = dict(zip(STAGE_KEYS, st))
    out.update({"table11_row": r["table11_row"], "plant_date": r["plant_date"] or "", "region": r["region"] or "",
                "selection_rule": selection_rule, "verified": verified})
    return out

def null_object(selection_rule):
    out = dict.fromkeys(STAGE_KEYS)
    out.update({"table11_row": "", "plant_date": "", "region": "", "selection_rule": selection_rule, "verified": False})
    return out

def group_default_object(group_id):
    rule = "group default (%s): no Table 11 row for this crop" % group_id
    idx = GROUP_DEFAULTS[group_id][0]
    return null_object(rule) if idx == "evergreen" else v2_object(idx, rule, False)

# A3, controller ruling (b) and R4: the reference's closer row becomes the default;
# the basis is the agronomy review's reason. sudan_grass keeps the first two lengths.
PROMOTED = {
    "garlic": "bulb allium, 150-day season",
    "parsnip": "Apiaceae taproot like carrot",
    "turnip": "fresh root of 60-80 days",
    "chickpea": "cool-season grain legume harvested dry",
    "garbanzo": "same species as chickpea",
    "sisal": "perennial agave without seasonal stages",
    "rapeseed": "spring-sown oil crop of the same group",
    "alfalfa_seed": "same species",
    "clover_hay": "multi-cut legume hay, averaged cuttings",
    "clover_hay_cutting": "consistent with the alfalfa default",
    "sudan_grass": "averaged cuttings, as alfalfa_averaged",
    "berries": "deciduous shrubs leafing out in March-April",
    "blueberry": "as berries",
    "raspberry": "as berries",
    "avocado": "evergreen subtropical tree, no concerted leaf drop",
    "conifer": "evergreen with Kc 1.00 in every stage",
}
# A1, ruling R9: three defaults changed in the agronomy review.
SWAPS = {
    "cantaloupe": (43, False, "the policy's pick (Cantaloupe, Calif., January) is a desert winter planting; Sweet melons, Mediterranean, May fits a European sowing"),
    "sugar_beet": (63, True, "Idaho is closer to Swiss sowing (March-April) and lifting (September-November)"),
    "almond": (160, True, "almonds grow where that row applies"),
}

v2_crops = []
for c in CAT["crops"]:
    cid, grp = c["id"], c["group"]
    e = {k: c[k] for k in V1_KEYS}
    if cid in SWAPS:
        idx, verified, why = SWAPS[cid]
        cands = M[cid][1]
        e["stage_lengths_days"] = v2_object(idx, "agronomy review 2026-09-27: " + why, verified)
        e["stage_length_alternatives"] = [v2_object(i, "alternative", True) for i in cands if i != idx]
    elif cid in M:
        d, cands, rule, _extra = M[cid]
        e["stage_lengths_days"] = v2_object(d, rule, True)
        e["stage_length_alternatives"] = [v2_object(i, "alternative", True) for i in cands if i != d]
    elif cid in PARTIAL:
        e["stage_lengths_days"] = v2_object(PARTIAL[cid][0], "only row; Table 11 gives no numeric mid/late lengths", True)
        e["stage_length_alternatives"] = [v2_object(i, "alternative (cutting-cycle rows)", True) for i in (134, 135, 136, 137)] if cid == "alfalfa_averaged" else []
    elif cid in PROMOTED:
        idx = NOROW[cid][0]
        rule = "reference proposal (UNVERIFIED): " + PROMOTED[cid]
        e["stage_lengths_days"] = null_object(rule) if idx == "evergreen" else v2_object(idx, rule, False, first_two_only=(cid == "sudan_grass"))
        e["stage_length_alternatives"] = [group_default_object(grp)]
    else:
        e["stage_lengths_days"] = group_default_object(grp)
        e["stage_length_alternatives"] = []
    v2_crops.append(e)

assert len(v2_crops) == 136 and len(PROMOTED) == 16 and set(PROMOTED) <= set(NOROW)
catalogue = {k: CAT[k] for k in ("version", "luxPerWm2", "stationWindHeightM", "stages", "groups")}
catalogue["version"] = 2
catalogue["crops"] = v2_crops
with open(CATALOGUE_PATH, "w", encoding="utf-8") as fh:
    fh.write(json.dumps(catalogue, indent=2, ensure_ascii=False) + "\n")
print("crop-kc.json v2:", len(v2_crops), "crops,",
      sum(1 for e in v2_crops if e["stage_lengths_days"]["verified"]), "verified defaults,",
      sum(1 for e in v2_crops if e["stage_lengths_days"]["initial"] is None), "without lengths")
