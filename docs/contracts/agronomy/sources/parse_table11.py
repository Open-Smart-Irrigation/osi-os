"""Parse Table 11 rows from a text rendering of the fetched FAO-56 chapter 6 page
(https://www.fao.org/4/x0490e/x0490e0b.htm) into table11_rows.json beside this file.
The text rendering is not committed; pass its path as the first argument."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
with open(sys.argv[1], encoding="utf-8") as fh:
    txt = fh.read()
start = txt.index("TABLE 11. Lengths")
blk = txt[txt.index("[TABLE]", start)+7 : txt.index("[/TABLE]", start)]
lines = [l.strip() for l in blk.strip().split("\n")][1:]  # drop header
rows = []; group = None; crop = None
for l in lines:
    cells = [c.strip() for c in l.split("|")]
    if len(cells) == 1:
        group = cells[0]; continue
    if len(cells) == 9 and cells[0] == "":           # faba "- dry"/"- green" sub-rows
        cells = ["Faba bean, broad bean " + cells[1]] + cells[2:]
    if len(cells) == 8:
        crop = cells[0]; vals = cells[1:]
    elif len(cells) == 7:
        vals = cells
    else:
        raise SystemExit("bad row: %r" % l)
    rows.append({"idx": len(rows), "group": group, "crop": crop,
                 "printed": dict(zip(["init","dev","mid","late","total","plant_date","region"], vals))})
with open(os.path.join(HERE, "table11_rows.json"), "w", encoding="utf-8") as fh:
    json.dump(rows, fh, indent=1, ensure_ascii=False)
for r in rows:
    p = r["printed"]; print(r["idx"], "|", r["crop"], "|", p["init"], p["dev"], p["mid"], p["late"], p["total"], "|", p["plant_date"], "|", p["region"])
