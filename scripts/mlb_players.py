"""Build MLB player pages data for everyone who played in the 2026 postseason.

  python scripts/mlb_players.py

Run after mlb_preprocess.py. Reads mlb/data/games/*.js, ../raw/mlb/statcast_2026.parquet and
../raw/mlb/models.joblib. Writes mlb/data/players.js (list) and mlb/data/players/<id>.js (pages).
Playoff numbers are the headline; regular-season numbers are only context.
"""
import json
import math
from collections import defaultdict
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

import mlb_models as mm

HERE = Path(__file__).resolve().parents[1]
RAW = HERE.parent / "raw" / "mlb"
DATA = HERE / "mlb" / "data"
HITS = {"single", "double", "triple", "home_run"}
NO_AB = {"walk", "intent_walk", "hit_by_pitch", "sac_fly", "sac_bunt", "catcher_interf",
         "sac_fly_double_play", "sac_bunt_double_play"}
NON_PA = ("caught_stealing", "pickoff", "stolen_base", "wild_pitch", "passed_ball", "balk",
          "other_advance", "runner", "defensive_indiff", "other_out")
SWING_MISS = {"S", "W", "T", "M", "O"}
GROUP = {"FF": "Fastball", "SI": "Fastball", "FC": "Fastball", "FA": "Fastball",
         "SL": "Breaking", "ST": "Breaking", "SV": "Breaking", "CU": "Breaking", "KC": "Breaking", "CS": "Breaking",
         "CH": "Offspeed", "FS": "Offspeed", "FO": "Offspeed", "SC": "Offspeed"}
R = lambda x, n=1: None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), n)


def load_js(p):
    t = p.read_text(encoding="utf-8")
    return json.loads(t[t.index("=") + 1:].rstrip().rstrip(";"))


def label(g):
    d = (g.get("desc") or "").split(",")[0].replace("'", "")
    return (d.replace("World Series", "WS").replace("Game ", "G").replace("NL Wild Card", "NLWC")
             .replace("AL Wild Card", "ALWC"))


def is_pa(pa):
    return not any(x in (pa.get("et") or "") for x in NON_PA)


def season_context(M):
    """Regular-season Stuff+, whiff%, velo per pitcher pitch type; chase/whiff/hard-hit per batter."""
    sc = pd.read_parquet(RAW / "statcast_2026.parquet")
    reg = sc[sc.game_type == "R"]
    post = sc[sc.game_type != "R"]
    s, _ = mm.stuff_frame(reg)
    X = s[mm.ST_FEATS].values
    s["stuff"] = 100 - 10 * (M["stuff"].predict(X) - M["stuff_mu"]) / M["stuff_sd"]
    s["swing"] = s.description.isin(mm.SWINGS)
    s["whiff"] = s.description.isin(mm.WHIFFS)
    pt = s.groupby(["pitcher", "pitch_type"]).agg(n=("stuff", "size"), stuff=("stuff", "mean"), velo=("velo", "mean"),
                                                   sw=("swing", "sum"), wh=("whiff", "sum"))
    pall = s.groupby("pitcher").agg(n=("stuff", "size"), stuff=("stuff", "mean"))

    def disc(d):
        d = d.assign(swing=d.description.isin(mm.SWINGS), whiff=d.description.isin(mm.WHIFFS),
                     out=d.zone.isin([11, 12, 13, 14]), bbe=d.type.eq("X") & d.launch_speed.notna())
        g = d.groupby("batter")
        return pd.DataFrame({
            "pitches": g.size(),
            "chase": g.apply(lambda x: (x.swing & x.out).sum() / max(x.out.sum(), 1), include_groups=False),
            "whiff": g.apply(lambda x: x.whiff.sum() / max(x.swing.sum(), 1), include_groups=False),
            "hard": g.apply(lambda x: (x.bbe & (x.launch_speed >= 95)).sum() / max(x.bbe.sum(), 1), include_groups=False),
            "bbe": g.bbe.sum(),
        })
    return pt, pall, disc(reg), disc(post)


def main():
    M = joblib.load(RAW / "models.joblib")
    w = dict(zip(mm.XW_CLASSES, M["xw_weights"]))
    pt_season, p_season, bat_reg, bat_post = season_context(M)
    games = sorted((load_js(p) for p in (DATA / "games").glob("*.js")), key=lambda g: (g["date"], g["pk"]))

    names, team = {}, {}
    P = defaultdict(lambda: {"bf": 0, "outs": 0, "h": 0, "hr": 0, "bb": 0, "k": 0, "pitches": 0, "top": 0, "wpa": 0.0,
                             "xw": [], "st": [], "log": [], "types": defaultdict(list), "pairs": defaultdict(list),
                             "tun_wh": [0, 0, 0, 0], "pulled": [], "move": []})
    H = defaultdict(lambda: {"pa": 0, "ab": 0, "h": 0, "d2": 0, "d3": 0, "hr": 0, "bb": 0, "hbp": 0, "k": 0, "sf": 0,
                             "rbi": 0, "wpa": 0.0, "woba": [], "xw": [], "ev": [], "spray": [], "moments": [],
                             "log": [], "grp": defaultdict(list)})

    for g in games:
        S, PAs = g["steps"], g["pas"]
        names.update({int(k): v for k, v in g["names"].items()})
        glabel = label(g)
        per_p, per_h = defaultdict(lambda: defaultdict(float)), defaultdict(lambda: defaultdict(float))
        prev_outs, half = 0, None
        for pa in PAs:
            if (pa["inn"], pa["top"]) != half:
                half, prev_outs = (pa["inn"], pa["top"]), 0
            field = "home" if pa["top"] else "away"
            bat_side = "away" if pa["top"] else "home"
            team[pa["pit"]] = g["teams"][field]["abbr"]
            team[pa["bat"]] = g["teams"][bat_side]["abbr"]
            d_home = pa["wp1"] - pa["wp0"]
            d_field = d_home if field == "home" else -d_home
            outs = max(0, min(pa["o"], 3) - prev_outs)
            prev_outs = min(pa["o"], 3)
            et = pa["et"]
            # pitcher (charged with the PA's pitcher of record)
            p, q = P[pa["pit"]], per_p[pa["pit"]]
            p["outs"] += outs; q["outs"] += outs
            p["wpa"] += d_field; q["wpa"] += d_field
            if is_pa(pa):
                p["bf"] += 1
                if et in HITS: p["h"] += 1; q["h"] += 1
                if et == "home_run": p["hr"] += 1
                if et in ("walk", "intent_walk"): p["bb"] += 1; q["bb"] += 1
                if "strikeout" in et: p["k"] += 1; q["k"] += 1
                if pa.get("xw") is not None: p["xw"].append(pa["xw"])
            # hitter
            if is_pa(pa):
                h, r = H[pa["bat"]], per_h[pa["bat"]]
                h["pa"] += 1; r["pa"] += 1
                if et not in NO_AB: h["ab"] += 1; r["ab"] += 1
                if et in HITS: h["h"] += 1; r["h"] += 1
                if et == "double": h["d2"] += 1
                if et == "triple": h["d3"] += 1
                if et == "home_run": h["hr"] += 1; r["hr"] += 1
                if et in ("walk", "intent_walk"): h["bb"] += 1; r["bb"] += 1
                if et == "hit_by_pitch": h["hbp"] += 1
                if "strikeout" in et: h["k"] += 1; r["k"] += 1
                if et.startswith("sac_fly"): h["sf"] += 1
                h["rbi"] += pa.get("rbi") or 0; r["rbi"] += pa.get("rbi") or 0
                d_bat = -d_field
                h["wpa"] += d_bat; r["wpa"] += d_bat
                if pa.get("xw") is not None:
                    actual = w.get(et, 0.0) if et in HITS else (0.69 if et in ("walk", "intent_walk") else 0.72 if et == "hit_by_pitch" else 0.0)
                    h["woba"].append(actual); h["xw"].append(pa["xw"])
                    lastp = S[pa["p1"]].get("t")
                    if lastp in GROUP: h["grp"][GROUP[lastp]].append(pa["xw"])
                if pa.get("hit"):
                    hit = pa["hit"]
                    h["ev"].append(hit["ev"])
                    if hit.get("x") is not None:
                        h["spray"].append([hit["x"], hit["y"], hit["ev"], et, g["pk"], pa["p1"]])
                h["moments"].append([round(d_bat, 3), g["pk"], pa["p1"], glabel, pa["inn"], pa["top"], pa["desc"]])
        # pitch-level
        for k, s in enumerate(S):
            if not s.get("t"):
                continue
            p, q = P[s["pit"]], per_p[s["pit"]]
            p["pitches"] += 1; q["pitches"] += 1
            if s.get("v") and s["v"] > p["top"]: p["top"] = s["v"]
            if s.get("st") is not None: p["st"].append(s["st"]); q["st_sum"] += s["st"]; q["st_n"] += 1
            p["types"][s["t"]].append(s)
            pa = PAs[s["a"]]
            if s.get("hb") is not None and s.get("iv") is not None and len(p["move"]) < 600:
                p["move"].append([s["t"], s["hb"], s["iv"]])
            if s.get("v") and s["t"] in mm.FASTBALLS:
                q[f"fb{pa['inn']}"] += s["v"]; q[f"fn{pa['inn']}"] += 1
            prev = S[k - 1] if k > 0 else None
            if s.get("tu") and prev and prev.get("t") and prev["a"] == s["a"] and prev["t"] != s["t"]:
                p["pairs"][f"{prev['t']}>{s['t']}"].append(s["tu"])
                strong = s["tu"][0] <= 6 and s["tu"][1] >= 10
                swung = s.get("c") in SWING_MISS or s.get("c") in ("F", "L", "X", "D", "E")
                if swung:
                    p["tun_wh"][0 if strong else 2] += 1
                    if s["c"] in SWING_MISS: p["tun_wh"][1 if strong else 3] += 1
        for d in g["decisions"]:
            P[d["out"]]["pulled"].append({"g": glabel, "pk": g["pk"], "step": d["step"], "inn": d["inn"], "top": d["top"],
                                          "pitches": d["pitches"], "proc": d["proc"], "res": d["res"], "to": d["in"]})
        opp = lambda side: g["teams"]["home" if side == "away" else "away"]["abbr"]
        for pid, q in per_p.items():
            fside = "home" if team[pid] == g["teams"]["home"]["abbr"] else "away"
            first = next(i for i, s in enumerate(S) if s.get("pit") == pid)
            inn_velo = {int(key[2:]): round(q[key] / q["fn" + key[2:]], 1) for key in list(q) if key.startswith("fb") and q["fn" + key[2:]]}
            P[pid]["log"].append({"g": glabel, "pk": g["pk"], "date": g["date"], "opp": opp(fside), "step": first,
                                  "outs": int(q["outs"]), "h": int(q["h"]), "bb": int(q["bb"]), "k": int(q["k"]),
                                  "p": int(q["pitches"]), "st": round(q["st_sum"] / q["st_n"]) if q["st_n"] else None,
                                  "wpa": round(q["wpa"], 3), "iv": inn_velo})
        for bid, r in per_h.items():
            bside = "home" if team[bid] == g["teams"]["home"]["abbr"] else "away"
            first = next(pa["p0"] for pa in PAs if pa["bat"] == bid)
            H[bid]["log"].append({"g": glabel, "pk": g["pk"], "date": g["date"], "opp": opp(bside), "step": first,
                                  "pa": int(r["pa"]), "ab": int(r["ab"]), "h": int(r["h"]), "hr": int(r["hr"]),
                                  "rbi": int(r["rbi"]), "bb": int(r["bb"]), "k": int(r["k"]), "wpa": round(r["wpa"], 3)})

    (DATA / "players").mkdir(parents=True, exist_ok=True)
    listing = []
    ids = set(P) | {b for b, h in H.items() if h["pa"]}
    for pid in ids:
        page = {"id": pid, "name": names.get(pid, str(pid)), "team": team.get(pid, "")}
        row = {"id": pid, "name": page["name"], "team": page["team"]}
        p = P.get(pid)
        if p and p["pitches"]:
            arsenal = []
            for t, ps in sorted(p["types"].items(), key=lambda kv: -len(kv[1])):
                sw = sum(1 for s in ps if s.get("c") in SWING_MISS or s.get("c") in ("F", "L", "X", "D", "E"))
                wh = sum(1 for s in ps if s.get("c") in SWING_MISS)
                seas = pt_season.loc[(pid, t)] if (pid, t) in pt_season.index else None
                mean = lambda key: R(np.mean([s[key] for s in ps if s.get(key) is not None])) if any(s.get(key) is not None for s in ps) else None
                arsenal.append({
                    "t": t, "n": len(ps), "use": R(len(ps) / p["pitches"], 3), "v": mean("v"), "iv": mean("iv"),
                    "hb": mean("hb"), "s": R(np.mean([s["s"] for s in ps if s.get("s")]), 0) if any(s.get("s") for s in ps) else None,
                    "st": R(np.mean([s["st"] for s in ps if s.get("st") is not None]), 0) if any(s.get("st") is not None for s in ps) else None,
                    "xw": R(np.mean([s["xw"] for s in ps if s.get("xw") is not None]), 0) if any(s.get("xw") is not None for s in ps) else None,
                    "sw": sw, "wh": wh,
                    "sv": R(seas.velo) if seas is not None else None, "sst": R(seas.stuff, 0) if seas is not None else None,
                    "swh": R(seas.wh / seas.sw, 3) if seas is not None and seas.sw else None,
                })
            pairs = []
            for key, tus in p["pairs"].items():
                if len(tus) >= 3:
                    a, b = key.split(">")
                    pairs.append({"a": a, "b": b, "n": len(tus), "dec": R(np.mean([t[0] for t in tus])),
                                  "pl": R(np.mean([t[1] for t in tus]))})
            pairs.sort(key=lambda x: -x["pl"] / max(x["dec"], 1))
            st = round(np.mean(p["st"])) if p["st"] else None
            k_rate = p["k"] / p["bf"] if p["bf"] else 0
            xw = R(np.mean(p["xw"]), 3) if p["xw"] else None
            sea = p_season.loc[pid] if pid in p_season.index else None
            page["pit"] = {"outs": p["outs"], "bf": p["bf"], "h": p["h"], "hr": p["hr"], "bb": p["bb"], "k": p["k"],
                           "pitches": p["pitches"], "top": p["top"], "st": st, "sst": R(sea.stuff, 0) if sea is not None else None,
                           "xw": xw, "wpa": R(p["wpa"], 3), "arsenal": arsenal, "pairs": pairs[:4],
                           "tun": p["tun_wh"], "move": p["move"], "log": p["log"], "pulled": p["pulled"]}
            best = max((a for a in arsenal if a["n"] >= 15 and a["st"] is not None), key=lambda a: a["st"], default=None)
            row["p"] = {"outs": p["outs"], "k": R(k_rate, 3), "top": p["top"], "st": st, "xw": xw, "wpa": R(p["wpa"], 3),
                        "g": len(p["log"]), "best": [best["t"], best["st"]] if best else None}
        h = H.get(pid)
        if h and h["pa"]:
            ab, hits = h["ab"], h["h"]
            obp_den = ab + h["bb"] + h["hbp"] + h["sf"]
            tb = hits + h["d2"] + 2 * h["d3"] + 3 * h["hr"]
            moments = sorted(h["moments"], key=lambda m: -m[0])[:4]
            dreg = bat_reg.loc[pid] if pid in bat_reg.index else None
            dpost = bat_post.loc[pid] if pid in bat_post.index else None
            dd = lambda d: {"chase": R(d.chase, 3), "whiff": R(d.whiff, 3), "hard": R(d.hard, 3), "bbe": int(d.bbe)} if d is not None else None
            page["bat"] = {
                "pa": h["pa"], "ab": ab, "h": hits, "d2": h["d2"], "d3": h["d3"], "hr": h["hr"], "bb": h["bb"], "k": h["k"],
                "rbi": h["rbi"], "avg": R(hits / ab, 3) if ab else None, "obp": R((hits + h["bb"] + h["hbp"]) / obp_den, 3) if obp_den else None,
                "slg": R(tb / ab, 3) if ab else None, "woba": R(np.mean(h["woba"]), 3) if h["woba"] else None,
                "xw": R(np.mean(h["xw"]), 3) if h["xw"] else None, "maxev": max(h["ev"]) if h["ev"] else None,
                "wpa": R(h["wpa"], 3), "spray": h["spray"], "moments": [m for m in moments if m[0] > 0],
                "disc": {"post": dd(dpost), "reg": dd(dreg)},
                "grp": {k: [R(np.mean(v), 3), len(v)] for k, v in h["grp"].items()}, "log": h["log"],
            }
            row["h"] = {"pa": h["pa"], "avg": page["bat"]["avg"], "obp": page["bat"]["obp"], "slg": page["bat"]["slg"],
                        "hr": h["hr"], "xw": page["bat"]["xw"], "maxev": page["bat"]["maxev"], "wpa": R(h["wpa"], 3),
                        "g": len(h["log"])}
        if "p" not in row and "h" not in row:
            continue
        (DATA / "players" / f"{pid}.js").write_text("window.RS_MLB_PLAYER=" + json.dumps(page, separators=(",", ":")) + ";\n",
                                                    encoding="utf-8")
        listing.append(row)
    listing.sort(key=lambda r: r["name"].split(" ")[-1])
    (DATA / "players.js").write_text("window.RS_MLB_PLAYERS=" + json.dumps(listing, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(len(listing), "players,", sum("p" in r for r in listing), "pitchers,", sum("h" in r for r in listing), "hitters")


if __name__ == "__main__":
    main()
