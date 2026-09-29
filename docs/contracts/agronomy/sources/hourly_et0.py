#!/usr/bin/env python3
"""Hourly FAO-56 Penman-Monteith reference ET (eq. 53) with the FAO-56 hourly radiation chain.

Equations (FAO-56, Allen et al. 1998):
  7  P = 101.3 ((293 - 0.0065 z)/293)^5.26
  8  gamma = 0.665e-3 P
  11 e0(T) = 0.6108 exp(17.27 T / (T + 237.3))
  13 Delta = 4098 e0(T) / (T + 237.3)^2
  22-24 phi, dr = 1 + 0.033 cos(2 pi J/365), delta = 0.409 sin(2 pi J/365 - 1.39)
  25 omega_s = arccos(-tan(phi) tan(delta))
  28 Ra = 12(60)/pi Gsc dr [(w2-w1) sin(phi) sin(delta) + cos(phi) cos(delta)(sin w2 - sin w1)]
  29/30 w1 = w - pi t1/24, w2 = w + pi t1/24
  31 w = pi/12 [(t + 0.06667 (Lz - Lm) + Sc) - 12]      (Lz, Lm in degrees WEST of Greenwich)
  32/33 Sc = 0.1645 sin(2b) - 0.1255 cos(b) - 0.025 sin(b),  b = 2 pi (J - 81)/364
  37 Rso = (0.75 + 2e-5 z) Ra
  38 Rns = (1 - 0.23) Rs
  39 (hourly form) Rnl = sigma T_hr,K^4 (0.34 - 0.14 sqrt(ea)) (1.35 Rs/Rso - 0.35), sigma = 2.043e-10 MJ K-4 m-2 h-1
  40 Rn = Rns - Rnl
  45/46 G = 0.1 Rn (daylight), G = 0.5 Rn (night)
  47 u2 = uz 4.87 / ln(67.8 z - 5.42)
  53 ETo = [0.408 Delta (Rn - G) + gamma 37/(T+273) u2 (e0(T) - ea)] / [Delta + gamma (1 + 0.34 u2)]
  54 ea = e0(T) RH/100
"""
import datetime, json, math, os, sys

GSC = 0.0820            # MJ m-2 min-1
SIGMA_HR = 4.903e-9 / 24  # = 2.043e-10 MJ K-4 m-2 h-1 (FAO-56 ch. 4)


def u2_from_uz(uz, z):
    """Eq. 47: wind at height z (m) above short grass -> 2 m."""
    return uz * 4.87 / math.log(67.8 * z - 5.42)


def hourly_et0(*, T, RH, u2, Rs, z, lat_deg, J, t, Lz, Lm, t1=1.0,
               night_rs_rso=None, clip_to_sunrise_sunset=False):
    """Return a dict with every intermediate value.

    Lz, Lm: degrees WEST of Greenwich (FAO-56 convention: Lz = 0 Greenwich, 345 for CET/UTC+1,
            330 for UTC+2; a site at 6.95 deg E has Lm = 353.05).
    t: standard clock time at the midpoint of the period [h] (14.5 for 14:00-15:00).
    night_rs_rso: Rs/Rso used for Rnl when Rso == 0 (sun below the horizon). FAO-56 ch. 4:
            use the ratio from the period 2-3 h before sunset, or 0.4-0.6 (humid/subhumid),
            0.7-0.8 (arid/semiarid); 0.3 = total cloud cover.
    clip_to_sunrise_sunset: clip w1/w2 to [-ws, ws] (ASCE-EWRI 2005 practice, NOT in FAO-56 text).
    """
    v = {}
    P = 101.3 * ((293 - 0.0065 * z) / 293) ** 5.26
    gamma = 0.665e-3 * P
    e0 = 0.6108 * math.exp(17.27 * T / (T + 237.3))
    delta_slope = 4098 * e0 / (T + 237.3) ** 2
    ea = e0 * RH / 100.0
    v.update(P_kPa=P, gamma=gamma, Delta=delta_slope, e0_T=e0, ea=ea, vpd=e0 - ea)

    phi = math.pi / 180 * lat_deg
    dr = 1 + 0.033 * math.cos(2 * math.pi / 365 * J)
    dec = 0.409 * math.sin(2 * math.pi / 365 * J - 1.39)
    ws = math.acos(-math.tan(phi) * math.tan(dec))
    b = 2 * math.pi * (J - 81) / 364
    Sc = 0.1645 * math.sin(2 * b) - 0.1255 * math.cos(b) - 0.025 * math.sin(b)
    w = math.pi / 12 * ((t + 0.06667 * (Lz - Lm) + Sc) - 12)
    w1 = w - math.pi * t1 / 24
    w2 = w + math.pi * t1 / 24
    sun_up = -ws <= w <= ws                       # FAO-56: w < -ws or w > ws -> Ra = 0
    if clip_to_sunrise_sunset:
        w1, w2 = max(w1, -ws), min(w2, ws)
    if sun_up and w2 > w1:
        Ra = 12 * 60 / math.pi * GSC * dr * ((w2 - w1) * math.sin(phi) * math.sin(dec)
                                             + math.cos(phi) * math.cos(dec) * (math.sin(w2) - math.sin(w1)))
        Ra = max(Ra, 0.0)
    else:
        Ra = 0.0
    v.update(phi_rad=phi, dr=dr, delta_rad=dec, omega_s=ws, b=b, Sc_h=Sc, omega=w, omega1=w1,
             omega2=w2, sun_above_horizon=sun_up, Ra=Ra)

    Rso = (0.75 + 2e-5 * z) * Ra
    Rns = (1 - 0.23) * Rs
    if Rso > 0:
        rs_rso = min(Rs / Rso, 1.0)
        rs_rso_source = "Rs/Rso (limited to <= 1.0)"
    else:
        if night_rs_rso is None:
            raise ValueError("sun below horizon: supply night_rs_rso")
        rs_rso = night_rs_rso
        rs_rso_source = "assumed night value"
    TK = T + 273.16
    sigmaT4 = SIGMA_HR * TK ** 4
    hum = 0.34 - 0.14 * math.sqrt(ea)
    cloud = 1.35 * rs_rso - 0.35
    Rnl = sigmaT4 * hum * cloud
    Rn = Rns - Rnl
    G = 0.1 * Rn if sun_up else 0.5 * Rn
    v.update(Rs=Rs, Rso=Rso, Rns=Rns, sigma_T4=sigmaT4, humidity_term=hum, Rs_Rso=rs_rso,
             Rs_Rso_source=rs_rso_source, cloud_term=cloud, Rnl=Rnl, Rn=Rn,
             G_rule="0.1 Rn (eq. 45, daylight)" if sun_up else "0.5 Rn (eq. 46, night)", G=G,
             Rn_minus_G=Rn - G, radiation_mm=0.408 * (Rn - G))

    denom = delta_slope + gamma * (1 + 0.34 * u2)
    rad_term = 0.408 * delta_slope * (Rn - G) / denom
    aero_term = gamma * 37 / (T + 273) * u2 * (e0 - ea) / denom
    et0 = rad_term + aero_term
    v.update(u2=u2, denominator=denom, radiation_term_mm_h=rad_term, aerodynamic_term_mm_h=aero_term,
             ET0_mm_h=et0)
    return v


def r(x, n=4):
    return round(x, n) if isinstance(x, float) else x


def reference_report():
    out = {"generator": "hourly_et0.py (stdlib Python 3)", "cases": {}}

    # ---- Example 19 (FAO-56 ch. 4), published values from the fetched page -------------
    ex19_common = dict(z=8, lat_deg=16 + 13 / 60, J=274, Lz=15, Lm=16.25)
    published = {
        "02:00-03:00": dict(Delta=0.220, gamma=0.0673, e0_T=3.780, ea=3.402, vpd=0.378, omega=-2.46,
                            Ra=0.0, Rso=0.0, Rns=0.0, sigma_T4=1.681, humidity_term=0.082, Rs_Rso=0.8,
                            cloud_term=0.730, Rnl=0.100, Rn=-0.100, G=-0.050, Rn_minus_G=-0.050,
                            radiation_mm=-0.020, radiation_term_mm_h=-0.01, aerodynamic_term_mm_h=0.01,
                            ET0_mm_h=0.00),
        "14:00-15:00": dict(Delta=0.358, gamma=0.0673, e0_T=6.625, ea=3.445, vpd=3.180, omega=0.682,
                            omega1=0.5512, omega2=0.8130, Ra=3.543, Rso=2.658, Rns=1.887, sigma_T4=1.915,
                            humidity_term=0.080, Rs_Rso=0.922, cloud_term=0.894, Rnl=0.137, Rn=1.749,
                            G=0.175, Rn_minus_G=1.574, radiation_mm=0.642, radiation_term_mm_h=0.46,
                            aerodynamic_term_mm_h=0.17, ET0_mm_h=0.63),
    }
    shared_pub = dict(phi_rad=0.2830, dr=1.0001, delta_rad=-0.0753, b=3.3315, Sc_h=0.1889)
    inputs = {"02:00-03:00": dict(T=28, RH=90, u2=1.9, Rs=0.0, t=2.5, night_rs_rso=0.8),
              "14:00-15:00": dict(T=38, RH=52, u2=3.3, Rs=2.450, t=14.5)}
    for hour, inp in inputs.items():
        calc = hourly_et0(**ex19_common, **inp)
        pub = dict(shared_pub, **published[hour])
        cmp = {k: {"published": pv, "recomputed": r(calc[k]), "abs_diff": r(abs(calc[k] - pv), 4)}
               for k, pv in pub.items()}
        worst = max(c["abs_diff"] for c in cmp.values())
        out["cases"]["fao56_example19_" + hour.replace(":", "").replace("-", "_")] = {
            "status": "published (fetched from https://www.fao.org/4/x0490e/x0490e08.htm), recomputed here",
            "inputs": dict(ex19_common, **inp, note="N'Diaye (Senegal) 16°13'N 16°15'W, 8 m, 1 October; Lz/Lm in degrees west of Greenwich as printed"),
            "published_vs_recomputed": cmp, "max_abs_diff": worst,
            "recomputed_all": {k: r(v) for k, v in calc.items()}}

    # ---- computed_here vectors: 46.8 N, 6.95 E, 490 m ------------------------------------
    site = dict(z=490, lat_deg=46.8, Lm=360 - 6.95, Lz=345)   # CET standard time (UTC+1)
    a = hourly_et0(**site, J=200, t=12.5, T=28, RH=45, u2=2.0, Rs=3.0)
    out["cases"]["computed_here_a_summer_noon"] = {
        "status": "computed_here",
        "inputs": dict(site, J=200, t=12.5, T=28, RH=45, u2=2.0, Rs=3.0,
                       note="period 12:00-13:00 CET standard time (= 13:00-14:00 CEST); Lm = 360 - 6.95 = 353.05 deg W, Lz = 345 deg W (UTC+1)"),
        "values": {k: r(v, 5) for k, v in a.items()}}
    bnight = {}
    for ratio in (0.5, 0.4, 0.6, 0.8, 0.3):
        bnight[ratio] = hourly_et0(**site, J=355, t=2.5, T=1, RH=90, u2=1.0, Rs=0.0, night_rs_rso=ratio)
    out["cases"]["computed_here_b_winter_night"] = {
        "status": "computed_here",
        "inputs": dict(site, J=355, t=2.5, T=1, RH=90, u2=1.0, Rs=0.0, night_rs_rso=0.5,
                       note="period 02:00-03:00 CET; Rs = 0 so Rso = 0: Rs/Rso for Rnl assumed 0.5 (FAO-56 ch. 4: 0.4-0.6 for humid and subhumid climates at night; the preferred alternative is the ratio from the hour 2-3 h before sunset, which these inputs do not include)"),
        "values": {k: r(v, 5) for k, v in bnight[0.5].items()},
        "sensitivity_ET0_mm_h_by_night_Rs_Rso": {str(k): r(v["ET0_mm_h"], 5) for k, v in bnight.items()}}

    # eq. 47 example (FAO-56 Example 14: 3.2 m/s at 10 m -> 2.4 m/s) as a cross-check
    out["cases"]["eq47_check_example14"] = {"status": "published (FAO-56 ch. 3 Example 14, fetched): conversion factor 0.75, u2 = 2.4 m/s",
                                            "uz": 3.2, "z": 10, "u2_recomputed": r(u2_from_uz(3.2, 10), 4)}

    for name, c in out["cases"].items():
        if name.startswith("fao56"):
            print(name, "max |published - recomputed| =", c["max_abs_diff"])
            for k, d in c["published_vs_recomputed"].items():
                print("   %-22s pub %9.4f  calc %9.4f" % (k, d["published"], d["recomputed"]))
        elif name.startswith("computed_here"):
            vals = c["values"]
            print(name)
            for k in ("P_kPa", "gamma", "Delta", "e0_T", "ea", "vpd", "dr", "delta_rad", "omega_s", "b", "Sc_h", "omega",
                      "omega1", "omega2", "Ra", "Rso", "Rns", "sigma_T4", "humidity_term", "Rs_Rso", "cloud_term",
                      "Rnl", "Rn", "G", "radiation_term_mm_h", "aerodynamic_term_mm_h", "ET0_mm_h"):
                print("   %-22s %s" % (k, vals[k]))
            if "sensitivity_ET0_mm_h_by_night_Rs_Rso" in c:
                print("   sensitivity", c["sensitivity_ET0_mm_h_by_night_Rs_Rso"])
        else:
            print(name, c)


# ---- contract v2 chain (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, A7) ----
# Differs from hourly_et0() above in four contract rules: omega1/omega2 are always
# clipped to [-ws, ws]; Rso is floored at 1e-4; a day hour's Rs/Rso is clamped to
# [0.3, 1.0]; a night hour takes the carried ratio. Clock time is UTC with the
# longitude in degrees east (eq. 31 with Lz = 0, Lm = -lon).
HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS_PATH = os.path.join(HERE, "..", "et0-vectors.json")
NIGHT_DEFAULT = 0.5


def epoch_ms(iso):
    return int(datetime.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)


def contract_solar_hour(lat_deg, J, start_ms, lon_deg):
    phi = math.pi / 180 * lat_deg
    dr = 1 + 0.033 * math.cos(2 * math.pi / 365 * J)
    dec = 0.409 * math.sin(2 * math.pi / 365 * J - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(dec))))
    b = 2 * math.pi * (J - 81) / 364
    Sc = 0.1645 * math.sin(2 * b) - 0.1255 * math.cos(b) - 0.025 * math.sin(b)
    mid = math.fmod(math.fmod(start_ms / 3600000 + 0.5, 24) + 24, 24)
    w = math.pi / 12 * ((mid + lon_deg / 15 + Sc) - 12)
    w = math.atan2(math.sin(w), math.cos(w))
    w1 = max(-ws, min(ws, w - math.pi / 24))
    w2 = max(-ws, min(ws, w + math.pi / 24))
    Ra = 0.0
    if w2 > w1:
        Ra = max(0.0, 12 * 60 / math.pi * GSC * dr * ((w2 - w1) * math.sin(phi) * math.sin(dec)
                                                    + math.cos(phi) * math.cos(dec) * (math.sin(w2) - math.sin(w1))))
    return ws, w, Ra


def contract_terms(*, T, RH, uz, zw, Rs, z, lat_deg, lon_deg, J, hour_start, night):
    u2 = uz if abs(zw - 2) < 1e-9 else u2_from_uz(uz, zw)
    P = 101.3 * ((293 - 0.0065 * z) / 293) ** 5.26
    gamma = 0.000665 * P
    es = 0.6108 * math.exp(17.27 * T / (T + 237.3))
    delta = 4098 * es / (T + 237.3) ** 2
    ea = es * RH / 100
    ws, w, Ra = contract_solar_hour(lat_deg, J, epoch_ms(hour_start), lon_deg)
    sun_up = -ws <= w <= ws
    Rso = max(1e-4, (0.75 + 2e-5 * z) * Ra)
    Rns = 0.77 * Rs
    ratio = max(0.3, min(1.0, Rs / Rso)) if sun_up else night
    Rnl = SIGMA_HR * (T + 273.16) ** 4 * (0.34 - 0.14 * math.sqrt(ea)) * (1.35 * ratio - 0.35)
    Rn = Rns - Rnl
    G = 0.1 * Rn if sun_up else 0.5 * Rn
    D = delta + gamma * (1 + 0.34 * u2)
    rad = 0.408 * delta * (Rn - G) / D
    aero = gamma * 37 / (T + 273) * u2 * (es - ea) / D
    carry = sun_up and ws - 0.79 <= w <= ws - 0.52
    return dict(ra=Ra, rso=Rso, rn=Rn, g=G, rsRso=ratio, et0=rad + aero, sunUp=sun_up, carry=carry)


def contract_day(hours, *, zw, z, lat_deg, lon_deg, J, prior):
    carried = NIGHT_DEFAULT if prior is None else prior
    source = "default" if prior is None else "prior"
    total = 0.0
    hourly = []
    for h in hours:
        t = contract_terms(T=h["tMeanC"], RH=h["rhPct"], uz=h["windSpeedMs"], zw=zw, Rs=h["solarRadMjM2h"], z=z,
                           lat_deg=lat_deg, lon_deg=lon_deg, J=J, hour_start=h["hourStartUtc"], night=carried)
        hourly.append({"hourStartUtc": h["hourStartUtc"], "et0Mm": round(t["et0"], 5), "sunUp": t["sunUp"],
                       "rsRsoSource": "measured" if t["sunUp"] else source})
        if t["carry"]:
            carried, source = t["rsRso"], "carried"
        total += t["et0"]
    return total, carried, hourly


def num(x):
    """Integral floats as integers, so the file keeps the JSON.stringify style of the rest."""
    return int(x) if isinstance(x, float) and x.is_integer() else x


def hourly_entry(name, inp, **extra):
    t = contract_terms(T=inp["tMeanC"], RH=inp["rhPct"], uz=inp["windSpeedMs"], zw=inp["windHeightM"],
                       Rs=inp["solarRadMjM2h"], z=inp["elevationM"], lat_deg=inp["latDeg"], lon_deg=inp["lonDeg"],
                       J=inp["dayOfYear"], hour_start=inp["hourStartUtc"],
                       night=NIGHT_DEFAULT if inp["nightRsRso"] is None else inp["nightRsRso"])
    entry = {"name": name, "input": {k: num(v) for k, v in inp.items()}, "et0Mm": round(t["et0"], 5), "tolerance": 0.0001}
    entry.update(extra)
    if "terms" in extra and extra["terms"] == "computed":
        entry["terms"] = {k: round(t[k], 5) for k in ("ra", "rso", "rn", "g")}
    return entry


def contract_vectors():
    ex19 = dict(windHeightM=2, elevationM=8, latDeg=16.21667, lonDeg=-16.25, dayOfYear=274)
    night19 = dict(tMeanC=28, rhPct=90, windSpeedMs=1.9, solarRadMjM2h=0, hourStartUtc="2026-10-01T03:00:00Z", nightRsRso=0.8)
    day19 = dict(tMeanC=38, rhPct=52, windSpeedMs=3.3, solarRadMjM2h=2.45, hourStartUtc="2026-10-01T15:00:00Z", nightRsRso=None)
    order = ("tMeanC", "rhPct", "windSpeedMs", "windHeightM", "solarRadMjM2h", "elevationM", "latDeg", "lonDeg", "dayOfYear", "hourStartUtc", "nightRsRso")
    def inp(**kw):
        return {k: kw[k] for k in order}
    payerne = dict(elevationM=490, latDeg=46.8, lonDeg=6.95)
    u10 = round(2 / (4.87 / math.log(67.8 * 10 - 5.42)), 10)
    hourly = [
        # FAO-56 Example 19, published values (https://www.fao.org/4/x0490e/x0490e08.htm); A8 tolerances.
        {"name": "fao56_example19_0200_0300", "input": inp(**ex19, **night19), "et0Mm": 0, "tolerance": 0.005,
         "terms": {"delta": 0.22, "gamma": 0.0673, "es": 3.78, "ea": 3.402, "omega": -2.46, "ra": 0, "rso": 0, "rns": 0,
                   "rsRso": 0.8, "rnl": 0.1, "rn": -0.1, "g": -0.05, "radTerm": -0.01, "aeroTerm": 0.01},
         "termTolerance": {"default": 0.001, "radTerm": 0.01, "aeroTerm": 0.01}},
        {"name": "fao56_example19_1400_1500", "input": inp(**ex19, **day19), "et0Mm": 0.63, "tolerance": 0.005,
         "terms": {"delta": 0.358, "gamma": 0.0673, "es": 6.625, "ea": 3.445, "omega": 0.682, "ra": 3.543, "rso": 2.658,
                   "rns": 1.887, "rsRso": 0.922, "rnl": 0.137, "rn": 1.749, "g": 0.175, "radTerm": 0.46, "aeroTerm": 0.17},
         "termTolerance": {"default": 0.001, "radTerm": 0.005, "aeroTerm": 0.005}},
        hourly_entry("payerne_summer_noon", inp(tMeanC=28, rhPct=45, windSpeedMs=2, windHeightM=2, solarRadMjM2h=3, **payerne,
                     dayOfYear=200, hourStartUtc="2026-07-19T11:00:00Z", nightRsRso=None), terms="computed"),
        hourly_entry("payerne_summer_noon_10m", inp(tMeanC=28, rhPct=45, windSpeedMs=u10, windHeightM=10, solarRadMjM2h=3, **payerne,
                     dayOfYear=200, hourStartUtc="2026-07-19T11:00:00Z", nightRsRso=None)),
        hourly_entry("payerne_winter_night", inp(tMeanC=1, rhPct=90, windSpeedMs=1, windHeightM=2, solarRadMjM2h=0, **payerne,
                     dayOfYear=355, hourStartUtc="2026-12-21T01:00:00Z", nightRsRso=0.5)),
    ]
    # One synthetic station day (A9): local day 2026-07-19 in Europe/Zurich.
    start = epoch_ms("2026-07-18T22:00:00Z")
    hours = []
    for h in range(24):
        iso = datetime.datetime.fromtimestamp((start + h * 3600000) / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        s_ = math.sin(2 * math.pi * (h - 9) / 24)
        ra_h = contract_solar_hour(46.8, 200, epoch_ms(iso), 6.95)[2]
        hours.append({"hourStartUtc": iso, "tMeanC": num(round(20 + 7 * s_, 4)), "rhPct": num(round(65 - 20 * s_, 4)),
                      "windSpeedMs": 2, "solarRadMjM2h": num(round(0.6 * ra_h, 4))})
    total, last, per_hour = contract_day(hours, zw=2, z=490, lat_deg=46.8, lon_deg=6.95, J=200, prior=None)
    day = {"name": "payerne_synthetic_2026_07_19",
           "input": {"hours": hours, "windHeightM": 2, "elevationM": 490, "latDeg": 46.8, "lonDeg": 6.95, "dayOfYear": 200, "priorRsRso": None},
           "sumMm": round(total, 6), "et0Mm": math.floor(max(0.0, total) * 100 + 0.5) / 100, "lastRsRso": round(last, 4), "hourly": per_hour}
    return hourly, [day]


def main():
    if "--reference" in sys.argv:
        reference_report()
        return
    with open(VECTORS_PATH, encoding="utf-8") as fh:
        doc = json.load(fh)
    doc["fao56Hourly"], doc["fao56HourlyDays"] = contract_vectors()
    note = (" fao56Hourly and fao56HourlyDays: written by docs/contracts/agronomy/sources/hourly_et0.py (stdlib Python, sigma = 4.903e-9 / 24)"
            " with the contract chain of spec 2026-09-27-daily-agronomy-parity A7, reproduced by osi-agronomy-daily/et0.js;"
            " the two Example 19 entries carry the values FAO-56 prints, with the A8 tolerances.")
    base = doc["provenance"].split(" fao56Hourly and fao56HourlyDays:")[0]
    doc["provenance"] = base + note
    with open(VECTORS_PATH, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    day = doc["fao56HourlyDays"][0]
    print("et0-vectors.json: %d hourly entries, synthetic day sumMm %s et0Mm %s lastRsRso %s"
          % (len(doc["fao56Hourly"]), day["sumMm"], day["et0Mm"], day["lastRsRso"]))


if __name__ == "__main__":
    main()
