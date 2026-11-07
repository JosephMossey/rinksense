"""
RINKSENSE player pages: every skater across all games -> data/players.js.

Built from what preprocess.py already wrote (data/games.js, each game's meta.js and report.js),
so it can be re-run on its own in a second:
    python scripts/players.py

Players are identified by team + jersey only (the data is anonymized). The skater list comes
from the shift charts, which leaves out goalies.
"""
import json
import os
import sys

MPH = 0.681818            # ft/s -> mph
MIN_TRACKED = 10          # tracked minutes needed to be ranked in the percentiles
MIN_GAME_TRACKED = 2      # tracked minutes needed for a game's skating numbers (same as the report)
LEAD = 5                  # replay links start this many seconds before the shot
TOP_MATES = 6


def load_js(path):
    s = open(path, encoding="utf-8").read()
    return json.loads(s[s.index("=") + 1: s.rstrip().rindex(";")])


def slug(team, j):
    return f"{team.lower().replace(' ', '-')}-{j}"


def r1(v):
    return None if v is None else round(v, 1)


def build_players(out_root="data"):
    games = load_js(os.path.join(out_root, "games.js"))
    gids = [g["id"] for g in games]
    P = {}

    def player(team, j):
        k = f"{team}|{j}"
        if k not in P:
            P[k] = {"team": team, "j": j, "games": {}, "shots": [], "mates": {}, "passes": 0}
        return P[k]

    for gi, g in enumerate(games):
        M = load_js(os.path.join(out_root, "games", g["id"], "meta.js"))
        R = load_js(os.path.join(out_root, "games", g["id"], "report.js"))
        lens = g["periodLength"]
        fps = R["fps"]

        def line(team, j):
            pl = player(team, j)
            if g["id"] not in pl["games"]:
                opp = g["away"] if team == g["home"] else g["home"]
                us, them = g["score"][team], g["score"][opp]
                res = "W" if us > them else ("OTL" if g["ot"] else "L") if us < them else "SO"
                pl["games"][g["id"]] = {"gi": gi, "opp": opp, "home": team == g["home"], "res": res,
                                        "score": [us, them], "toi": 0, "g": 0, "a": 0, "sog": 0, "att": 0,
                                        "xg": 0.0, "twp": 0.0}
            return pl["games"][g["id"]]

        # skaters and time on ice come from the shift chart
        for team, j, p, start, end in M["shifts"]:
            if j and j != "Go":
                line(team, j)["toi"] += max(0, start - end)
        skaters = {(pl["team"], pl["j"]) for pl in P.values() if g["id"] in pl["games"]}

        for e in M["events"]:
            t, j = e["t"], e.get("pl")
            if e["ev"] == "Goal":
                for a in e.get("ast", []):
                    if (t, a) in skaters:
                        line(t, a)["a"] += 1
            if (t, j) not in skaters or e["ev"] not in ("Shot", "Goal"):
                continue
            L = line(t, j)
            goal = e["ev"] == "Goal"
            on = goal or e.get("d2") == "On Net"
            L["att"] += 1
            L["g"] += goal
            L["sog"] += on
            L["xg"] += e.get("xg", 0)
            if e.get("sxy"):
                kind = 3 if goal else 1 if on else 2 if e.get("d2") == "Blocked" else 0
                lead = min(lens[str(e["p"])], e["c"] + LEAD)
                player(t, j)["shots"].append([gi, e["p"], e["c"], e["sxy"][0], e["sxy"][1], e.get("xg"), kind,
                                              e.get("d1"), lead])

        # time with puck (frames at the replay's frame rate)
        for p, info in M["periods"].items():
            for key, n in (info.get("twp") or {}).items():
                t, j = key.split("|")
                if (t, j) in skaters:
                    line(t, j)["twp"] += n / info["fps"]

        # skating (report.js movement, per tracked minute)
        for key, v in R["players"].items():
            t, j = key.split("|")
            if (t, j) not in skaters:
                continue   # tracked numbers with no shifts are goalies
            L = line(t, j)
            L["mv"] = {"frames": v["frames"], "dist": v["dist"], "sprint": v["zones"][3], "bursts": v["bursts"],
                       "top": v["top"], "acc": v["acc"], "entry": [e[2] for e in v["entry"]]}

        # completed passes between teammates
        for team, nets in R["passes"].items():
            for a, b, n in nets.get("all", {}).get("edges", []):
                for x, y in ((a, b), (b, a)):
                    if (team, x) in skaters:
                        pl = player(team, x)
                        pl["mates"][y] = pl["mates"].get(y, 0) + n
                        pl["passes"] += n

    out = []
    for pl in P.values():
        lines = sorted(pl["games"].items(), key=lambda kv: kv[1]["gi"])
        mv = [L["mv"] for _, L in lines if "mv" in L]
        frames = sum(m["frames"] for m in mv)
        tmin = frames / 30 / 60
        toi = sum(L["toi"] for _, L in lines)
        xg = sum(L["xg"] for _, L in lines)
        twp = sum(L["twp"] for _, L in lines)
        tops = [m["top"] for m in mv if m["top"] is not None and m["frames"] >= MIN_GAME_TRACKED * 1800]
        accs = [m["acc"] for m in mv if m["acc"] is not None and m["frames"] >= MIN_GAME_TRACKED * 1800]
        entries = [v for m in mv for v in m["entry"]]
        log = []
        for gid, L in lines:
            m = L.get("mv")
            ok = m and m["frames"] >= MIN_GAME_TRACKED * 1800
            log.append({
                "g": gid, "opp": L["opp"], "home": L["home"], "res": L["res"], "score": L["score"],
                "toi": L["toi"], "gl": L["g"], "a": L["a"], "sog": L["sog"], "att": L["att"], "xg": round(L["xg"], 2),
                "twp": round(L["twp"]), "tmin": r1(m["frames"] / 1800) if m else 0,
                "top": r1(m["top"] * MPH) if ok and m["top"] is not None else None,
                "ftm": round(m["dist"] / (m["frames"] / 1800)) if ok else None,
                "sprint": r1(m["sprint"] / m["frames"] * 100) if ok else None,
                "entry": r1(sum(m["entry"]) / len(m["entry"]) * MPH) if ok and m["entry"] else None,
            })
        mates = sorted(pl["mates"].items(), key=lambda kv: (-kv[1], int(kv[0]) if kv[0].isdigit() else 999))
        out.append({
            "id": slug(pl["team"], pl["j"]), "team": pl["team"], "j": pl["j"], "gp": len(lines),
            "toi": toi, "tmin": round(tmin, 1),
            "g": sum(L["g"] for _, L in lines), "a": sum(L["a"] for _, L in lines),
            "sog": sum(L["sog"] for _, L in lines), "att": sum(L["att"] for _, L in lines),
            "xg": round(xg, 2), "twp": round(twp),
            "top": r1(max(tops) * MPH) if tops else None,
            "acc": r1(max(accs) * MPH) if accs else None,
            "ftm": round(sum(m["dist"] for m in mv) / tmin) if tmin >= MIN_GAME_TRACKED else None,
            "sprint": r1(sum(m["sprint"] for m in mv) / frames * 100) if tmin >= MIN_GAME_TRACKED else None,
            "entry": r1(sum(entries) / len(entries) * MPH) if entries else None,
            "xg60": round(xg / (toi / 3600), 2) if toi >= 600 else None,
            "twpPct": r1(twp / (tmin * 60) * 100) if tmin >= MIN_GAME_TRACKED else None,
            "q": tmin >= MIN_TRACKED,
            "log": log, "shots": sorted(pl["shots"], key=lambda s: (s[0], s[1], -s[2])),
            "passes": pl["passes"], "mates": [[j, n] for j, n in mates[:TOP_MATES]],
        })

    # percentiles: share of the other qualified skaters this player beats (ties count half)
    metrics = ["top", "acc", "xg60", "ftm", "twpPct"]
    pool = {m: [p[m] for p in out if p["q"] and p[m] is not None] for m in metrics}
    for p in out:
        pct = {}
        for m in metrics:
            v, xs = p[m], pool[m]
            if v is None or len(xs) < 2:
                pct[m] = None
                continue
            others = len(xs) - (1 if p["q"] else 0)
            below = sum(x < v for x in xs) + 0.5 * (sum(x == v for x in xs) - (1 if p["q"] else 0))
            pct[m] = round(100 * below / max(1, others))
        p["pct"] = pct

    out.sort(key=lambda p: (p["team"], int(p["j"]) if p["j"].isdigit() else 999))
    data = {"games": [{"id": g["id"], "date": g["date"], "home": g["home"], "away": g["away"],
                       "len": g["periodLength"], "trackStart": g["trackStart"]} for g in games],
            "minTracked": MIN_TRACKED, "minGameTracked": MIN_GAME_TRACKED,
            "qualified": sum(p["q"] for p in out), "players": out}
    path = os.path.join(out_root, "players.js")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("window.RS_PLAYERS=")
        json.dump(data, fh, separators=(",", ":"))
        fh.write(";\n")
    print(f"Players: {len(out)} skaters ({data['qualified']} with {MIN_TRACKED}+ tracked min) -> {os.path.normpath(path)} "
          f"({os.path.getsize(path) // 1024} KB)")
    return data


if __name__ == "__main__":
    build_players(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "data"))
