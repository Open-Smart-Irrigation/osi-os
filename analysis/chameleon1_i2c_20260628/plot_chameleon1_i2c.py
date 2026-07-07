#!/usr/bin/env python3
from __future__ import annotations

import csv
from datetime import UTC, datetime
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt


ROOT = Path(__file__).resolve().parent
INPUT_CSV = ROOT / "chameleon1_server_readings.csv"
BLOCKS_CSV = ROOT / "chameleon1_i2c_blocks.csv"
SUMMARY_TXT = ROOT / "chameleon1_i2c_summary.txt"
PNG_OUT = ROOT / "chameleon1_i2c_timeline.png"
SVG_OUT = ROOT / "chameleon1_i2c_timeline.svg"


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.strip()).replace(tzinfo=UTC)


def parse_bool(value: str) -> bool:
    return value.strip().lower() in {"t", "true", "1", "yes"}


def parse_float(value: str) -> float | None:
    value = value.strip()
    if value == "":
        return None
    return float(value)


def parse_int(value: str) -> int | None:
    value = value.strip()
    if value == "":
        return None
    return int(value)


def read_rows() -> list[dict]:
    with INPUT_CSV.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    parsed: list[dict] = []
    for row in rows:
        item = dict(row)
        item["recorded_at_utc"] = parse_time(row["recorded_at_utc"])
        item["f_cnt"] = parse_int(row["f_cnt"])
        item["status_flags"] = parse_int(row["status_flags"])
        item["temp_c"] = parse_float(row["temp_c"])
        item["swt_1"] = parse_float(row["swt_1"])
        item["swt_2"] = parse_float(row["swt_2"])
        item["swt_3"] = parse_float(row["swt_3"])
        item["bat_v"] = parse_float(row["bat_v"])

        for col in [
            "i2c_missing",
            "timeout",
            "temp_fault",
            "id_fault",
            "ch1_open",
            "ch2_open",
            "ch3_open",
            "data_invalid",
        ]:
            item[col] = parse_bool(row[col])

        item["has_swt"] = any(item[col] is not None for col in ["swt_1", "swt_2", "swt_3"])
        if item["i2c_missing"]:
            item["state"] = "i2c_missing"
        elif item["data_invalid"]:
            item["state"] = "other_invalid"
        else:
            item["state"] = "good"
        parsed.append(item)

    parsed.sort(key=lambda x: x["recorded_at_utc"])
    previous = None
    for item in parsed:
        if previous is None:
            item["gap_min"] = None
        else:
            item["gap_min"] = (
                item["recorded_at_utc"] - previous["recorded_at_utc"]
            ).total_seconds() / 60
        previous = item
    return parsed


def build_blocks(rows: list[dict]) -> list[dict]:
    blocks: list[dict] = []
    current: dict | None = None
    for row in rows:
        if current is None or row["state"] != current["state"]:
            current = {
                "block_id": len(blocks) + 1,
                "state": row["state"],
                "start_utc": row["recorded_at_utc"],
                "end_utc": row["recorded_at_utc"],
                "rows": 0,
                "min_f_cnt": row["f_cnt"],
                "max_f_cnt": row["f_cnt"],
                "swt_rows": 0,
                "min_bat_v": row["bat_v"],
                "max_bat_v": row["bat_v"],
                "distinct_payloads": set(),
            }
            blocks.append(current)

        current["end_utc"] = row["recorded_at_utc"]
        current["rows"] += 1
        current["swt_rows"] += 1 if row["has_swt"] else 0
        current["distinct_payloads"].add(row["payload_b64"])

        for key, value in [("min_f_cnt", row["f_cnt"]), ("max_f_cnt", row["f_cnt"])]:
            if value is None:
                continue
            if current[key] is None:
                current[key] = value
            elif key.startswith("min"):
                current[key] = min(current[key], value)
            else:
                current[key] = max(current[key], value)

        bat_v = row["bat_v"]
        if bat_v is not None:
            current["min_bat_v"] = bat_v if current["min_bat_v"] is None else min(current["min_bat_v"], bat_v)
            current["max_bat_v"] = bat_v if current["max_bat_v"] is None else max(current["max_bat_v"], bat_v)

    for block in blocks:
        block["duration_h"] = round(
            (block["end_utc"] - block["start_utc"]).total_seconds() / 3600, 2
        )
        block["distinct_payloads"] = len(block["distinct_payloads"])
    return blocks


def write_blocks(blocks: list[dict]) -> None:
    fieldnames = [
        "block_id",
        "state",
        "rows",
        "start_utc",
        "end_utc",
        "duration_h",
        "min_f_cnt",
        "max_f_cnt",
        "swt_rows",
        "min_bat_v",
        "max_bat_v",
        "distinct_payloads",
    ]
    with BLOCKS_CSV.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for block in blocks:
            out = dict(block)
            out["start_utc"] = out["start_utc"].isoformat()
            out["end_utc"] = out["end_utc"].isoformat()
            writer.writerow({key: out[key] for key in fieldnames})


def series(rows: list[dict], key: str) -> list:
    return [row[key] for row in rows]


def main() -> None:
    rows = read_rows()
    blocks = build_blocks(rows)
    write_blocks(blocks)

    i2c_rows = sum(1 for row in rows if row["i2c_missing"])
    good_rows = sum(1 for row in rows if row["state"] == "good")
    other_invalid_rows = sum(1 for row in rows if row["state"] == "other_invalid")
    swt_rows = sum(1 for row in rows if row["has_swt"])
    last_bad = max((row["recorded_at_utc"] for row in rows if row["i2c_missing"]), default=None)
    first_good_after_last_bad = None
    if last_bad is not None:
        first_good_after_last_bad = next(
            (
                row["recorded_at_utc"]
                for row in rows
                if row["recorded_at_utc"] > last_bad and row["state"] == "good"
            ),
            None,
        )
    latest = rows[-1]
    max_gap = max((row["gap_min"] for row in rows if row["gap_min"] is not None), default=0)
    cadence_gaps = [row for row in rows if row["gap_min"] is not None and row["gap_min"] > 7.5]

    summary = [
        f"rows={len(rows)}",
        f"first_utc={rows[0]['recorded_at_utc'].isoformat()}",
        f"latest_utc={latest['recorded_at_utc'].isoformat()}",
        f"good_rows={good_rows}",
        f"i2c_missing_rows={i2c_rows}",
        f"other_invalid_rows={other_invalid_rows}",
        f"swt_rows={swt_rows}",
        f"last_i2c_missing_utc={last_bad.isoformat() if last_bad else ''}",
        "first_good_after_last_i2c_utc="
        + (first_good_after_last_bad.isoformat() if first_good_after_last_bad else ""),
        f"latest_state={latest['state']}",
        f"latest_f_cnt={latest['f_cnt']}",
        f"latest_swt_1={latest['swt_1']}",
        f"latest_swt_2={latest['swt_2']}",
        f"latest_swt_3={latest['swt_3']}",
        f"max_gap_min={max_gap:.2f}",
        f"cadence_gaps_over_7_5_min={len(cadence_gaps)}",
    ]
    SUMMARY_TXT.write_text("\n".join(summary) + "\n", encoding="utf-8")

    fig, (ax_quality, ax_swt) = plt.subplots(
        2,
        1,
        figsize=(16, 8),
        sharex=True,
        gridspec_kw={"height_ratios": [1, 3]},
        constrained_layout=True,
    )

    for block in blocks:
        start = block["start_utc"]
        end = block["end_utc"]
        if block["state"] == "i2c_missing":
            ax_quality.axvspan(start, end, color="#d73027", alpha=0.9)
            ax_swt.axvspan(start, end, color="#d73027", alpha=0.18)
        elif block["state"] == "other_invalid":
            ax_quality.axvspan(start, end, color="#fdae61", alpha=0.9)
            ax_swt.axvspan(start, end, color="#fdae61", alpha=0.16)
        else:
            ax_quality.axvspan(start, end, color="#1a9850", alpha=0.55)

    for row in cadence_gaps:
        ax_quality.axvline(row["recorded_at_utc"], color="black", lw=1.2, alpha=0.75)
        ax_swt.axvline(row["recorded_at_utc"], color="black", lw=1.0, alpha=0.45)

    ax_quality.set_ylim(0, 1)
    ax_quality.set_yticks([])
    ax_quality.set_title(
        "Chameleon 1 data quality: green = SWT present, red = I2C missing, black line = cadence gap"
    )

    colors = {"swt_1": "#1f78b4", "swt_2": "#33a02c", "swt_3": "#6a3d9a"}
    labels = {"swt_1": "SWT 1", "swt_2": "SWT 2", "swt_3": "SWT 3"}
    dates = series(rows, "recorded_at_utc")
    for col in ["swt_1", "swt_2", "swt_3"]:
        ax_swt.plot(
            dates,
            series(rows, col),
            color=colors[col],
            lw=1.2,
            marker=".",
            ms=2,
            alpha=0.92,
            label=labels[col],
        )

    ax_swt.set_ylabel("Soil water tension / SWT")
    ax_swt.set_xlabel("UTC time")
    ax_swt.grid(True, axis="y", color="#dddddd", lw=0.8)
    ax_swt.legend(loc="upper left", ncol=3, frameon=False)
    ax_swt.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d\n%H:%M"))
    ax_swt.xaxis.set_major_locator(mdates.AutoDateLocator(minticks=8, maxticks=18))

    if last_bad is not None:
        last_bad_label = last_bad.strftime("%Y-%m-%d %H:%M UTC")
    else:
        last_bad_label = "none"
    subtitle = (
        f"Latest: {latest['recorded_at_utc'].strftime('%Y-%m-%d %H:%M UTC')} "
        f"state={latest['state']} f_cnt={latest['f_cnt']}; "
        f"last I2C missing: {last_bad_label}"
    )
    fig.suptitle(subtitle, y=1.02, fontsize=11)

    fig.savefig(PNG_OUT, dpi=180, bbox_inches="tight")
    fig.savefig(SVG_OUT, bbox_inches="tight")

    print(SUMMARY_TXT.read_text(encoding="utf-8"))
    print(f"wrote {PNG_OUT}")
    print(f"wrote {SVG_OUT}")
    print(f"wrote {BLOCKS_CSV}")


if __name__ == "__main__":
    main()
