"""Turn the 2026 postseason game feeds into the static files the MLB pages read.

  python scripts/mlb_preprocess.py            # all games
  python scripts/mlb_preprocess.py --game 849799

Needs ../raw/mlb/feeds (mlb_fetch.py feeds), ../raw/mlb/statcast_2026.parquet and
../raw/mlb/models.joblib (mlb_models.py). Writes mlb/data/games.js and mlb/data/games/<pk>.js.

Every number a replay step shows is computed from the state before or at that pitch, so the
page can reveal steps one at a time without spoiling anything.
"""
import argparse
import json
import math
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

import mlb_models as mm

HERE = Path(__file__).resolve().parents[1]
RAW = HERE.parent / "raw" / "mlb"
OUT = HERE / "mlb" / "data"
FRONT_OF_PLATE = 17 / 12      # ft from the back tip of home plate
DECISION_S = 0.167            # a hitter commits roughly this long before the ball arrives
WOBA_SCALE = 1.25             # runs per point of wOBA per PA (approximate 2026 scale)
NEXT_BATTERS = 3
HITS = {"single", "double", "triple", "home_run"}

R = lambda x, n=1: None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), n)


# ---------------------------------------------------------------- physics
def traj(c):
    """Return (decision-point xz, plate xz) in feet from a pitch's 9-parameter fit."""
    try:
        x0, y0, z0 = c["x0"], c["y0"], c["z0"]
        vx, vy, vz, ax, ay, az = c["vX0"], c["vY0"], c["vZ0"], c["aX"], c["aY"], c["aZ"]
    except KeyError:
        return None
    disc = vy * vy - 2 * ay * (y0 - FRONT_OF_PLATE)
    if disc < 0 or ay == 0:
        return None
    tp = (-vy - math.sqrt(disc)) / ay
    pos = lambda t: (x0 + vx * t + .5 * ax * t * t, z0 + vz * t + .5 * az * t * t)
    return pos(max(tp - DECISION_S, 0)), pos(tp)


def dist_in(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1]) * 12


# ---------------------------------------------------------------- models
class Models:
    def __init__(self):
        m = joblib.load(RAW / "models.joblib")
        self.wp_model = m.pop("wp")
        self.__dict__.update(m)
        self.prof = m["profiles"]

    def wp(self, rows):
        X = np.array([[min(r["inn"], 10), r["bot"], min(r["outs"], 2), r["b"][0], r["b"][1], r["b"][2],
                       max(-8, min(8, r["sh"] - r["sa"])), min(r["balls"], 3), min(r["strikes"], 2)]
                      for r in rows], dtype=float)
        return self.wp_model.predict_proba(X)[:, 1]

    def xwoba(self, ev, la, coord, stand):
        spray = np.nan
        if coord and coord.get("coordX") is not None:
            a = math.degrees(math.atan2(coord["coordX"] - 125.42, 198.27 - coord["coordY"]))
            spray = -a if stand == "L" else a
        p = self.xw.predict_proba(np.array([[ev, la, spray]]))[0]
        return float(p @ self.xw_weights), float(1 - p[0]), float(p[4])

    def pitcher_xwoba(self, pid):
        return float(self.prof.xwoba.get(pid, self.lg_xwoba))


# ---------------------------------------------------------------- one game
def build_game(pk, sched, sc_game, M):
    feed = json.loads((RAW / "feeds" / f"{pk}_feed.json").read_text(encoding="utf-8"))
    gd, ld = feed["gameData"], feed["liveData"]
    teams = {s: {"id": gd["teams"][s]["id"], "abbr": gd["teams"][s]["abbreviation"],
                 "name": gd["teams"][s]["teamName"], "full": gd["teams"][s]["name"]} for s in ("away", "home")}
    names = {}
    sc_idx = {(int(r.at_bat_number), int(r.pitch_number)): r for r in sc_game.itertuples()}

    # Stuff+ / xWhiff for every Statcast pitch in this game
    st = {}
    if len(sc_game):
        s, _ = mm.stuff_frame(sc_game)
        ref = M.fbref
        for c in ["velo", "hb", "ivb"]:
            own = s["d_" + c]
            s["d_" + c] = s[c] - s.pitcher.map(ref[c]).fillna(s[c] - own)
        ok = s[mm.ST_FEATS[:4]].notna().all(axis=1)
        if ok.any():
            X = s.loc[ok, mm.ST_FEATS].values
            stuff = 100 - 10 * (M.stuff.predict(X) - M.stuff_mu) / M.stuff_sd
            xwh = M.whiff.predict_proba(X)[:, 1]
            for (ab, pn), v, w, hb, ivb in zip(zip(s.loc[ok, "at_bat_number"], s.loc[ok, "pitch_number"]),
                                               stuff, xwh, s.loc[ok, "hb"], s.loc[ok, "ivb"]):
                st[(int(ab), int(pn))] = (v, w, hb, ivb)

    steps, pas, subs = [], [], []
    state = {"inn": 1, "bot": 0, "outs": 0, "b": [0, 0, 0], "r": [0, 0, 0], "sa": 0, "sh": 0, "balls": 0, "strikes": 0}
    cur_p = {"home": None, "away": None}   # current pitcher by fielding side

    for play in ld["plays"]["allPlays"]:
        ab = play["about"]
        top = ab["isTopInning"]
        if (ab["inning"], 0 if top else 1) != (state["inn"], state["bot"]):
            state.update(inn=ab["inning"], bot=0 if top else 1, outs=0, b=[0, 0, 0], r=[0, 0, 0])
            if ab["inning"] >= 10:   # extra innings start with a runner on second
                state["b"] = [0, 1, 0]
        state.update(balls=0, strikes=0)
        mu = play["matchup"]
        bat, pit = mu["batter"]["id"], mu["pitcher"]["id"]
        names[bat], names[pit] = mu["batter"]["fullName"], mu["pitcher"]["fullName"]
        field = "home" if top else "away"
        if cur_p[field] is None:
            cur_p[field] = pit
        pa_i = len(pas)
        pa = {"i": pa_i, "inn": ab["inning"], "top": top, "bat": bat, "pit": pit,
              "bs": mu["batSide"]["code"], "ph": mu["pitchHand"]["code"],
              "ev": play["result"].get("event", ""), "et": play["result"].get("eventType", ""),
              "desc": play["result"].get("description", ""), "rbi": play["result"].get("rbi", 0),
              "p0": len(steps)}
        notes, prev_traj = [], None
        for e in play["playEvents"]:
            det = e.get("details", {})
            if not e.get("isPitch"):
                et = det.get("eventType")
                if et == "pitching_substitution":
                    pid = e.get("player", {}).get("id")
                    subs.append({"step": len(steps), "side": field, "in": pid, "out": cur_p[field]})
                    cur_p[field] = pid
                    notes.append(det.get("description", "Pitching change"))
                elif et in ("mound_visit", "offensive_substitution", "defensive_switch", "defensive_substitution") \
                        or (et and ("stolen" in et or "caught" in et or "pickoff" in et or et in
                                    ("wild_pitch", "passed_ball", "balk", "defensive_indiff"))):
                    if det.get("description"):
                        notes.append(det["description"])
                if "awayScore" in det:
                    state["sa"], state["sh"] = det["awayScore"], det["homeScore"]
                continue
            pd_ = e.get("pitchData", {})
            co = pd_.get("coordinates", {})
            key = (ab["atBatIndex"] + 1, e.get("pitchNumber"))
            sc = sc_idx.get(key)
            pre = dict(state, b=list(state["b"]), r=list(state["r"]))
            if sc is not None:   # Statcast's pre-pitch state is the most reliable (steals, wild pitches)
                pre.update(outs=int(sc.outs_when_up), b=[int(pd.notna(sc.on_1b)), int(pd.notna(sc.on_2b)),
                                                         int(pd.notna(sc.on_3b))],
                           sa=int(sc.away_score), sh=int(sc.home_score),
                           balls=int(sc.balls), strikes=int(sc.strikes),
                           r=[int(x) if pd.notna(x) else 0 for x in (sc.on_1b, sc.on_2b, sc.on_3b)])
            tr = traj(co)
            tun = None
            if tr and prev_traj:
                tun = [R(dist_in(tr[0], prev_traj[0])), R(dist_in(tr[1], prev_traj[1]))]
            prev_traj = tr if tr else prev_traj
            stv = st.get(key)
            typ = det.get("type", {}).get("code")
            velo = pd_.get("startSpeed")
            season = M.velo.get((pit, typ)) if typ else None
            step = {"a": pa_i, "t": typ, "v": R(velo), "s": pd_.get("breaks", {}).get("spinRate"),
                    "iv": R(stv[3]) if stv else R(pd_.get("breaks", {}).get("breakVerticalInduced")),
                    "hb": R(stv[2]) if stv else None,
                    "x": R(co.get("pX"), 3), "z": R(co.get("pZ"), 3),
                    "zt": R(pd_.get("strikeZoneTop"), 2), "zb": R(pd_.get("strikeZoneBottom"), 2),
                    "c": det.get("code"), "d": det.get("description"),
                    "cnt": [e["count"]["balls"], e["count"]["strikes"]], "o": e["count"]["outs"],
                    "st": int(round(stv[0])) if stv else None, "xw": int(round(stv[1] * 100)) if stv else None,
                    "tu": tun, "dv": R(velo - season) if velo and season and not math.isnan(season) else None,
                    "pit": pit, "_pre": pre}
            if sc is not None:   # Statcast bat tracking: bat speed, swing length, how far a whiff missed
                for k2, col in (("bs", "bat_speed"), ("sl", "swing_length"), ("md", "miss_distance")):
                    v = getattr(sc, col, None)
                    if v is not None and pd.notna(v):
                        step[k2] = R(v)
            if notes:
                step["n"] = notes
                notes = []
            hd = e.get("hitData")
            if hd and hd.get("launchSpeed") is not None and hd.get("launchAngle") is not None:
                xw, xba, phr = M.xwoba(hd["launchSpeed"], hd["launchAngle"], hd.get("coordinates"), pa["bs"])
                pa["hit"] = {"ev": R(hd["launchSpeed"]), "la": R(hd["launchAngle"], 0), "d": hd.get("totalDistance"),
                             "x": R(hd.get("coordinates", {}).get("coordX")), "y": R(hd.get("coordinates", {}).get("coordY")),
                             "tj": hd.get("trajectory"), "xw": R(xw, 3), "xba": R(xba, 3), "hr": R(phr, 3)}
            steps.append(step)
            state.update(balls=e["count"]["balls"], strikes=e["count"]["strikes"])
        if len(steps) == pa["p0"]:   # no pitch (automatic intentional walk etc.): add a placeholder step
            steps.append({"a": pa_i, "t": None, "c": None, "d": pa["ev"], "cnt": [play["count"]["balls"], play["count"]["strikes"]],
                          "o": play["count"]["outs"], "pit": pit, "_pre": dict(state, b=list(state["b"]), r=list(state["r"])),
                          **({"n": notes} if notes else {})})
        pa["p1"] = len(steps) - 1
        # post-PA state
        state["outs"] = play["count"]["outs"]
        state["sa"], state["sh"] = play["result"]["awayScore"], play["result"]["homeScore"]
        state["r"] = [mu.get(k2, {}).get("id", 0) for k2 in ("postOnFirst", "postOnSecond", "postOnThird")]
        for k2 in ("postOnFirst", "postOnSecond", "postOnThird"):
            if k2 in mu:
                names[mu[k2]["id"]] = mu[k2]["fullName"]
        state["b"] = [int(bool(x)) for x in state["r"]]
        if state["outs"] >= 3:
            state["b"], state["r"] = [0, 0, 0], [0, 0, 0]
        pa["runners"] = list(state["r"])
        pa["sc"] = [state["sa"], state["sh"]]
        pa["o"] = state["outs"]
        pa["bases"] = list(state["b"])
        pas.append(pa)

    # win probability: before every step, then after = before the next step
    pre_wp = M.wp([s["_pre"] for s in steps])
    fa, fh = pas[-1]["sc"]
    final = 1.0 if fh > fa else 0.0
    wp0 = float(pre_wp[0])
    for k, s in enumerate(steps):
        s["wp"] = R(pre_wp[k + 1] if k + 1 < len(steps) else final, 3)
        s["wpb"] = float(pre_wp[k])
    for pa in pas:
        pa["wp0"] = R(steps[pa["p0"]]["wpb"], 3)
        pa["wp1"] = steps[pa["p1"]]["wp"]
        # xwOBA for the PA: model value on contact, else the actual wOBA weight of the outcome
        if "hit" in pa:
            pa["xw"] = pa["hit"]["xw"]
        elif pa["et"] in ("strikeout", "strikeout_double_play"):
            pa["xw"] = 0.0
        elif pa["et"] in ("walk", "intent_walk"):
            pa["xw"] = 0.69
        elif pa["et"] == "hit_by_pitch":
            pa["xw"] = 0.72

    # bases (bitmask 1=1B 2=2B 4=3B) and score right after each step, for the scoreboard
    for k, s in enumerate(steps):
        pa = pas[s["a"]]
        nxt = steps[k + 1] if k + 1 < len(steps) else None
        if nxt is not None and nxt["a"] == s["a"]:
            b, sc, rn = nxt["_pre"]["b"], [nxt["_pre"]["sa"], nxt["_pre"]["sh"]], nxt["_pre"]["r"]
        else:
            b, sc, rn = pa["bases"], pa["sc"], pa["runners"]
        s["rn"] = rn
        for rid in rn:   # pinch runners may never bat, so look their names up
            if rid and rid not in names:
                names[rid] = gd["players"].get(f"ID{rid}", {}).get("fullName", f"#{rid}")
        s["bb"] = b[0] + 2 * b[1] + 4 * b[2]
        s["sc"] = sc

    decisions = grade_subs(subs, steps, pas, M)
    for s in steps:
        s.pop("_pre"), s.pop("wpb")

    # line score (runs/hits/errors per half-inning) for progressive reveal
    line = [{"a": [i["away"].get("runs", 0), i["away"].get("hits", 0), i["away"].get("errors", 0)],
             "h": [i["home"].get("runs", 0), i["home"].get("hits", 0), i["home"].get("errors", 0)]}
            for i in ld["linescore"]["innings"]]

    swings = sorted(pas, key=lambda p: -abs(p["wp1"] - p["wp0"]))[:6]
    drama = sum(abs(p["wp1"] - p["wp0"]) for p in pas)
    velo_max = max((s for s in steps if s.get("v")), key=lambda s: s["v"])
    whiffs = sum(1 for s in steps if s.get("c") in ("S", "W", "T"))
    last = pas[-1]
    walkoff = (not last["top"]) and fh > fa and last["sc"][1] - last["sc"][0] <= 4 and \
        (len(pas) < 2 or pas[-2]["sc"][1] <= pas[-2]["sc"][0])

    game = {
        "pk": pk, "date": sched["officialDate"], "round": sched.get("seriesDescription", ""),
        "gnum": sched.get("seriesGameNumber"), "desc": sched.get("description", ""),
        "venue": gd["venue"]["name"], "teams": teams, "final": [fa, fh],
        "innings": len(line), "wp0": R(wp0, 3), "names": {str(k): v for k, v in names.items()},
        "pas": pas, "steps": steps, "line": line, "decisions": decisions,
        "turning": [p["i"] for p in swings],
    }
    summary = {
        "pk": pk, "date": game["date"], "round": game["round"], "gnum": game["gnum"], "desc": game["desc"],
        "teams": teams, "final": [fa, fh], "innings": len(line), "pitches": sum(1 for s in steps if s.get("t")),
        "drama": R(drama, 2), "walkoff": walkoff, "whiffs": whiffs,
        "topVelo": [velo_max["v"], names.get(velo_max["pit"], "")],
        "spark": [R(wp0, 2)] + [R(p["wp1"], 2) for p in pas],
        "swing": {"inn": swings[0]["inn"], "top": swings[0]["top"], "desc": swings[0]["desc"],
                  "d": R(swings[0]["wp1"] - swings[0]["wp0"], 3)},
        "decisions": len(decisions),
    }
    return game, summary


def grade_subs(subs, steps, pas, M):
    """Grade each pitching change: projected next-3-batter cost (process) vs what happened (result)."""
    out = []
    for sub in subs:
        k = sub["step"]
        if k >= len(steps) or sub["out"] is None or sub["in"] is None or sub["out"] == sub["in"]:
            continue
        pre = steps[k]["_pre"]
        side = sub["side"]                       # fielding team
        sign = 1 if side == "home" else -1        # convert home WP to fielding-team WP
        prev = [s for s in steps[:k] if s.get("pit") == sub["out"] and s.get("t")]
        bf = len({s["a"] for s in prev})
        trip = min(bf // 9 + 1, 4)
        types = pd.Series([s["t"] for s in prev if s["t"] in mm.FASTBALLS])
        fb = types.mode().iat[0] if len(types) else None
        fbv = [s["dv"] for s in prev if s["t"] == fb and s.get("dv") is not None][-10:]
        stuff = [s["st"] for s in prev if s.get("st") is not None]
        w_out = M.pitcher_xwoba(sub["out"]) + float(M.tto.get(trip, 0.0))
        w_in = M.pitcher_xwoba(sub["in"])
        runs = (w_out - w_in) * NEXT_BATTERS / WOBA_SCALE   # runs saved by the move (positive = good)
        # how much one run is worth right now, for the fielding team
        bat_home = pre["bot"] == 1
        plus = dict(pre, sh=pre["sh"] + (1 if bat_home else 0), sa=pre["sa"] + (0 if bat_home else 1))
        w0, w1 = M.wp([pre, plus])
        run_wp = abs(w1 - w0)
        proc = runs * run_wp
        # result: fielding-team WP change while the new pitcher was in
        mine = [i for i, s in enumerate(steps) if i >= k and s.get("pit") == sub["in"]]
        end = mine[-1] if mine else k
        res = sign * (steps[end]["wp"] - steps[k]["wpb"])
        out.append({
            "step": k, "pa": steps[k]["a"], "side": side, "inn": pre["inn"], "top": pre["bot"] == 0,
            "outs": pre["outs"], "b": pre["b"], "sc": [pre["sa"], pre["sh"]],
            "out": sub["out"], "in": sub["in"], "pitches": len(prev), "bf": bf, "trip": trip,
            "fb": fb, "fbdv": R(np.mean(fbv)) if len(fbv) >= 5 else None,
            "stuff": int(round(np.mean(stuff[-15:]))) if len(stuff) >= 5 else None,
            "xw_out": R(w_out, 3), "xw_in": R(w_in, 3), "runs": R(runs, 2), "runwp": R(run_wp, 3),
            "proc": R(proc, 3), "res": R(res, 3), "endStep": end,
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", type=int)
    a = ap.parse_args()
    M = Models()
    sc = pd.read_parquet(RAW / "statcast_2026.parquet")
    sc = sc[sc.game_type != "R"]
    sched = json.loads((RAW / "feeds" / "schedule.json").read_text())
    (OUT / "games").mkdir(parents=True, exist_ok=True)
    idx_path = OUT / "games.js"
    summaries = {}
    if a.game and idx_path.exists():
        txt = idx_path.read_text(encoding="utf-8")
        summaries = {g["pk"]: g for g in json.loads(txt[txt.index("=") + 1:].rstrip().rstrip(";"))}
    for g in sched:
        pk = g["gamePk"]
        if a.game and pk != a.game:
            continue
        game, summ = build_game(pk, g, sc[sc.game_pk == pk], M)
        (OUT / "games" / f"{pk}.js").write_text(
            "window.RS_MLB_GAME=" + json.dumps(game, separators=(",", ":")) + ";\n", encoding="utf-8")
        summaries[pk] = summ
        print(pk, g["description"], f"{summ['teams']['away']['abbr']} {game['final'][0]}-{game['final'][1]} "
              f"{summ['teams']['home']['abbr']}", len(game["steps"]), "steps", len(game["decisions"]), "changes")
    allg = sorted(summaries.values(), key=lambda s: (s["date"], s["pk"]))
    idx_path.write_text("window.RS_MLB_GAMES=" + json.dumps(allg, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(len(allg), "games ->", OUT)


if __name__ == "__main__":
    main()
