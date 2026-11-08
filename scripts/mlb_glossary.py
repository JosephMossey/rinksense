"""Numbers for the MLB glossary: 'what good looks like' scales and real October examples.

  python scripts/mlb_glossary.py

Run after mlb_players.py. Scales are percentiles (10th, 50th, 75th, 90th) of qualified 2026
regular-season players, so "average" and "elite" come from the data, not from memory.
Examples come from the postseason files the site already publishes. Writes mlb/data/glossary.js.
"""
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

import mlb_models as mm

HERE = Path(__file__).resolve().parents[1]
RAW = HERE.parent / "raw" / "mlb"
DATA = HERE / "mlb" / "data"
HITS = {"single", "double", "triple", "home_run"}
NO_AB = {"walk", "intent_walk", "hit_by_pitch", "sac_fly", "sac_bunt", "catcher_interf", "sac_fly_double_play",
         "sac_bunt_double_play", "truncated_pa"}


def load_js(p):
    t = p.read_text(encoding="utf-8")
    return json.loads(t[t.index("=") + 1:].rstrip().rstrip(";"))


def q(series, digits=3, higher_better=True):
    v = np.nanpercentile(series.dropna().values, [10, 50, 75, 90] if higher_better else [90, 50, 25, 10])
    return {"cuts": [round(float(x), digits) for x in v], "n": int(series.notna().sum()), "hb": higher_better}


def main():
    M = joblib.load(RAW / "models.joblib")
    sc = pd.read_parquet(RAW / "statcast_2026.parquet")
    reg = sc[sc.game_type == "R"].copy()
    S = {}

    # ---- hitters (300+ PA) ----
    pa = reg[reg.events.notna() & (reg.events != "truncated_pa")].copy()
    pa["hit"] = pa.events.isin(HITS)
    pa["ab"] = ~pa.events.isin(NO_AB)
    pa["tb"] = pa.events.map({"single": 1, "double": 2, "triple": 3, "home_run": 4}).fillna(0)
    pa["onb"] = pa.hit | pa.events.isin(["walk", "intent_walk", "hit_by_pitch"])
    pa["obpden"] = pa.ab | pa.events.isin(["walk", "intent_walk", "hit_by_pitch", "sac_fly", "sac_fly_double_play"])
    w = pa[pa.woba_denom == 1].copy()
    bb = (w.type == "X") & w.launch_speed.notna() & w.launch_angle.notna()
    w["xw"] = w.woba_value
    w.loc[bb, "spray"] = mm.spray_angle(w[bb])
    w.loc[bb, "xw"] = M["xw"].predict_proba(w.loc[bb, mm.XW_FEATS].values) @ M["xw_weights"]
    g = pa.groupby("batter")
    bat = pd.DataFrame({"pa": g.size(), "avg": g.hit.sum() / g.ab.sum(), "obp": g.onb.sum() / g.obpden.sum(),
                        "slg": g.tb.sum() / g.ab.sum()})
    gw = w.groupby("batter")
    bat["woba"], bat["xwoba"] = gw.woba_value.mean(), gw.xw.mean()
    pit = reg.assign(swing=reg.description.isin(mm.SWINGS), whiff=reg.description.isin(mm.WHIFFS),
                     out=reg.zone.isin([11, 12, 13, 14]), bbe=(reg.type == "X") & reg.launch_speed.notna())
    gp = pit.groupby("batter")
    bat["chase"] = (pit.swing & pit.out).groupby(pit.batter).sum() / pit.out.groupby(pit.batter).sum()
    bat["whiff"] = gp.whiff.sum() / gp.swing.sum()
    bat["ev"] = pit[pit.bbe].groupby("batter").launch_speed.mean()
    bat["hard"] = (pit.bbe & (pit.launch_speed >= 95)).groupby(pit.batter).sum() / gp.bbe.sum()
    bat["batspeed"] = pit[pit.swing].groupby("batter").bat_speed.mean()
    bat["swinglen"] = pit[pit.swing].groupby("batter").swing_length.mean()
    qb = bat[bat.pa >= 300]
    for k, d in [("avg", 3), ("obp", 3), ("slg", 3), ("woba", 3), ("xwoba", 3), ("chase", 3), ("whiff", 3), ("ev", 1),
                 ("hard", 3), ("batspeed", 1), ("swinglen", 2)]:
        S[k] = q(qb[k], d, higher_better=k not in ("chase", "whiff"))
    S["qual_hit"] = int(len(qb))

    # ---- pitchers ----
    s, _ = mm.stuff_frame(reg)
    s["stuff"] = 100 - 10 * (M["stuff"].predict(s[mm.ST_FEATS].values) - M["stuff_mu"]) / M["stuff_sd"]
    s["swing"] = s.description.isin(mm.SWINGS)
    s["wh"] = s.description.isin(mm.WHIFFS)
    pt = s.groupby(["pitcher", "pitch_type"]).agg(n=("stuff", "size"), stuff=("stuff", "mean"), velo=("velo", "mean"),
                                                   spin=("spin", "mean"), ivb=("ivb", "mean"), sw=("swing", "sum"), whf=("wh", "sum"))
    S["stuff"] = q(pt[pt.n >= 200].stuff, 0)
    ff = pt.xs("FF", level="pitch_type")
    ff = ff[ff.n >= 200]
    S["velo"], S["spin"], S["ivb"] = q(ff.velo, 1), q(ff.spin, 0), q(ff.ivb, 1)
    S["whiffpct"] = q((pt.whf / pt.sw)[pt.sw >= 100], 3)
    S["ext"] = q(s.groupby("pitcher").ext.mean()[s.groupby("pitcher").size() >= 500], 1)
    pk = pa.groupby("pitcher")
    kp = pk.events.apply(lambda e: e.str.contains("strikeout").mean())
    S["kpct"] = q(kp[pk.size() >= 150], 3)
    md = reg[reg.description.isin(["swinging_strike", "swinging_strike_blocked"])].miss_distance
    S["missdist"] = {"cuts": [round(float(x), 1) for x in np.nanpercentile(md.dropna(), [25, 50, 75, 90])], "n": int(md.notna().sum())}

    # ---- October examples ----
    E = {}
    players = load_js(DATA / "players.js")
    hit = [p for p in players if "h" in p and p["h"]["pa"] >= 30]
    pitc = [p for p in players if "p" in p and p["p"]["outs"] >= 30]
    link = lambda p: f"player.html?p={p['id']}"
    top = max(hit, key=lambda p: p["h"]["xw"] or 0)
    E["xwoba"] = {"t": f"Best in October (30+ PA): {top['name']}, {top['h']['xw']:.3f}".replace("0.", "."), "href": link(top)}
    top = max(hit, key=lambda p: p["h"]["obp"] or 0)
    E["obp"] = {"t": f"Best OBP in October (30+ PA): {top['name']}, {top['h']['obp']:.3f}".replace("0.", "."), "href": link(top)}
    top = max(hit, key=lambda p: p["h"]["slg"] or 0)
    E["slg"] = {"t": f"Best slugging in October (30+ PA): {top['name']}, {top['h']['slg']:.3f}".replace("0.", "."), "href": link(top)}
    top = max(pitc, key=lambda p: p["p"]["k"])
    E["kpct"] = {"t": f"Best in October (10+ IP): {top['name']}, {round(top['p']['k'] * 100)}%", "href": link(top)}
    top = max(pitc, key=lambda p: p["p"]["st"] or 0)
    E["stuff"] = {"t": f"Best in October (10+ IP): {top['name']}, {top['p']['st']}", "href": link(top)}
    top = max(players, key=lambda p: max(p.get("p", {}).get("wpa", -9), p.get("h", {}).get("wpa", -9)))
    v = max(top.get("p", {}).get("wpa", -9), top.get("h", {}).get("wpa", -9))
    E["wpa_player"] = {"t": f"Most in October: {top['name']}, +{v:.2f} wins", "href": link(top)}

    best = {}
    for f in sorted((DATA / "games").glob("*.js")):
        G = load_js(f)
        nm = lambda i: G["names"].get(str(i), "")
        lab = (G.get("desc") or "").split(",")[0].replace("'", "")
        href = lambda st: f"game.html?g={G['pk']}#s-{st}"
        for k, s_ in enumerate(G["steps"]):
            pa_ = G["pas"][s_["a"]]
            if s_.get("v") and s_["v"] > best.get("velo", (0,))[0]:
                best["velo"] = (s_["v"], f"Fastest October pitch: {nm(s_['pit'])}, {s_['v']} mph ({lab})", href(k))
            if s_.get("s") and s_["s"] > best.get("spin", (0,))[0]:
                best["spin"] = (s_["s"], f"Most spin in October: {nm(s_['pit'])}, {s_['s']} rpm ({lab})", href(k))
            if s_.get("bs") and s_["bs"] > best.get("batspeed", (0,))[0]:
                best["batspeed"] = (s_["bs"], f"Fastest October swing: {nm(pa_['bat'])}, {s_['bs']} mph ({lab})", href(k))
            if s_.get("md") is not None and s_.get("c") in ("S", "W") and -s_["md"] > best.get("missdist", (-99,))[0]:
                best["missdist"] = (-s_["md"], f"Closest October miss: {nm(pa_['bat'])}, {s_['md']} in ({lab})", href(k))
        for pa_ in G["pas"]:
            h = pa_.get("hit")
            if h and h["ev"] > best.get("ev", (0,))[0]:
                best["ev"] = (h["ev"], f"Hardest-hit October ball: {nm(pa_['bat'])}, {h['ev']} mph ({lab})", href(pa_["p1"]))
            if h and pa_["et"] in ("field_out", "force_out", "grounded_into_double_play", "double_play", "sac_fly", "fielders_choice_out") and h.get("xba") is not None and h["xba"] > best.get("xba", (0,))[0]:
                best["xba"] = (h["xba"], f"Most robbed: {nm(pa_['bat'])} made an out on a ball with xBA {h['xba']:.3f} ({lab})".replace(" 0.", " ."), href(pa_["p1"]))
            if pa_["et"] == "home_run" and h and (h.get("d") or 0) > best.get("la", (0,))[0]:
                best["la"] = (h["d"], f"Longest October homer: {nm(pa_['bat'])}, {int(h['d'])} ft at {int(h['la'])}° ({lab})", href(pa_["p1"]))
            d = abs(pa_["wp1"] - pa_["wp0"])
            if d > best.get("wpa", (0,))[0]:
                best["wpa"] = (d, f"Biggest single swing in October: {round(d * 100)}% on one play, {nm(pa_['bat'])} ({lab})", href(pa_["p1"]))
        for dd in G["decisions"]:
            if dd["proc"] > best.get("proc", (-9,))[0]:
                best["proc"] = (dd["proc"], f"Best-graded move: {nm(dd['out'])} → {nm(dd['in'])}, +{dd['proc'] * 100:.1f}% ({lab})", href(dd["step"]))
        # biggest comeback: lowest win probability the eventual winner had
        home_won = G["final"][1] > G["final"][0]
        wps = [G["wp0"]] + [s_["wp"] for s_ in G["steps"]]
        low = min(wps) if home_won else min(1 - x for x in wps)
        if -low > best.get("wp", (-9,))[0]:
            winner = G["teams"]["home" if home_won else "away"]["abbr"]
            best["wp"] = (-low, f"Biggest October comeback: {winner} won {lab} after falling to {round(low * 100)}%", f"game.html?g={G['pk']}")
    for k, v in best.items():
        E[k] = {"t": v[1], "href": v[2]}

    models = load_js(DATA / "models.js")
    out = {"scales": S, "ex": E, "tto": models["profiles"]["tto_penalty"], "brier": models["wp"]}
    (DATA / "glossary.js").write_text("window.RS_MLB_GLOSS=" + json.dumps(out, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(json.dumps({k: v["cuts"] for k, v in S.items() if isinstance(v, dict)}, indent=None))
    for k, v in E.items():
        print(k, "|", v["t"])


if __name__ == "__main__":
    main()
