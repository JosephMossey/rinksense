"""
RINKSENSE preprocessing: Big Data Cup CSVs -> compact JS data files for the website.

Usage (Anaconda Prompt, from the repo folder):
    python scripts/preprocess.py --src "C:\\path\\to\\csv\\folder"

Every game found in --src (one *Events.csv per game) is written to
    data/games/<game-id>/meta.js, p1.js, p2.js, p3.js (+ p4.js for overtime)
plus one index of all games at data/games.js for the NHL hub page.
Each file sets a global, so the site also works opened straight from disk (file://).
"""
import argparse
import glob
import json
import math
import os
import re
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

import analytics as A

KEEP_EVERY = 2          # 30 fps -> 15 fps; the page interpolates between frames
SCALE = 10              # store feet * 10 as ints (0.1 ft precision)
GOAL_MARKER_TOL = 3     # seconds a tracking goal marker may differ from the event clock
CLOCK_MEDIAN_FRAMES = 151  # ~5 s window (30 fps) for cleaning the tracking clock
PERIOD_LENGTH = {1: 1200, 2: 1200, 3: 1200, 4: 300}   # regular-season OT is 5:00
POSSESSION_FT = 6       # nearest skater within this distance of the puck has it (possession / time with puck)
XG_FEATURES = ["dist", "angle", "rebound", "one_timer", "traffic", "deflection", "power_play"]
XG_L2 = 2.0             # ridge penalty for the xG logistic regression (picked by leave-one-game-out)
REBOUND_SECONDS = 3     # an attempt within this long after a same-team attempt counts as a rebound
PP_MINOR_SECONDS = 120  # a minor penalty's power play lasts at most 2:00
PP_SETTLE_SECONDS = 5   # ignore "back to even" readings in the first few seconds (delayed-penalty noise)
PUCK_OUTLIER_FT = 4    # puck points this far from their 7-frame median are treated as misreads
PUCK_FILL_FRAMES = 30   # fill puck gaps up to 1 s (30 fps), never across a camera cut
POSSESSION_EVENTS = {"Play", "Puck Recovery", "Takeaway", "Faceoff Win", "Zone Entry",
                     "Dump In/Out", "Incomplete Play", "Shot"}
OPP_POSSESSION = {"Play", "Puck Recovery", "Takeaway", "Faceoff Win", "Zone Entry", "Dump In/Out"}
PERIOD_FILES = {1: "Tracking_P1.csv", 2: "Tracking_P2.csv", 3: "Tracking_P3.csv", 4: "Tracking_POT.csv"}


def clock_to_sec(c):
    if pd.isna(c):
        return math.nan
    parts = str(c).split(":")
    return int(parts[0]) * 60 + int(float(parts[1]))


def pid(v):
    """Normalize a jersey / Player_Id value to a string label ('Go' stays 'Go')."""
    if pd.isna(v):
        return None
    s = str(v).strip()
    try:
        return str(int(float(s)))
    except ValueError:
        return s


def game_id(prefix):
    # "2025-10-11.Team.A.@.Team.D." -> "2025-10-11-a-at-d"
    m = re.match(r"(\d{4}-\d{2}-\d{2})\.Team\.(\w+)\.@\.Team\.(\w+)\.", prefix)
    return f"{m.group(1)}-{m.group(2).lower()}-at-{m.group(3).lower()}"


def build_period(path, period, home_team, away_team, shift_wins=None):
    t = pd.read_csv(path, low_memory=False)
    ids = pd.unique(t["Image Id"])
    frame_of = {fid: i for i, fid in enumerate(ids)}
    t["f"] = t["Image Id"].map(frame_of)
    t["clock_s"] = t["Game Clock"].map(clock_to_sec)

    # Clock per (30 fps) frame. The raw clock has short stray blocks (e.g. a '20:00' run in the
    # middle of a period, or '0:00' on pre-faceoff OT frames), so: fill gaps, compare each
    # value with a ~5 s rolling median, swap out values that disagree by more than 2 s, then
    # force it to only count down. Values that agree are kept exactly (20:00 stays 20:00).
    raw_clock = t.groupby("f")["clock_s"].first().reindex(range(len(ids))).ffill().bfill()
    med = raw_clock.rolling(CLOCK_MEDIAN_FRAMES, center=True, min_periods=1).median()
    fixed = raw_clock.where((raw_clock - med).abs() <= 2, med.round()).to_numpy()
    full_clock = np.minimum.accumulate(fixed).astype(int)

    goal_frames = sorted(set(t.loc[t["Goal Score"].astype(str) == "G", "f"].tolist()))

    # Camera cuts: the Image Id sequence skips when the broadcast footage jumps ahead
    # (stoppages, replays). Positions legitimately teleport there, so nothing should be
    # interpolated across one. cut_after[f] = True means a cut between frame f and f+1.
    img_no = np.array([int(str(s).rsplit("_", 1)[-1]) for s in ids])
    cut_after = np.append(np.diff(img_no) != 1, False)
    segment = np.concatenate([[0], np.cumsum(cut_after[:-1])])   # footage segment of each frame

    n = (len(ids) - 1) // KEEP_EVERY + 1
    clock = full_clock[::KEEP_EVERY][:n].tolist()
    # downsampled frame k covers raw frames [k*KEEP_EVERY, (k+1)*KEEP_EVERY)
    cuts = sorted({int(f // KEEP_EVERY) for f in np.nonzero(cut_after)[0] if f // KEEP_EVERY < n - 1})

    # Puck, cleaned at full 30 fps within each footage segment: drop points that sit far from
    # their neighbours (impossible jumps), fill gaps up to PUCK_FILL_FRAMES, light smoothing.
    pk = t[t["Player or Puck"] == "Puck"].drop_duplicates("f").set_index("f").reindex(range(len(ids)))
    pxs = pk["Rink Location X (Feet)"].astype(float)
    pys = pk["Rink Location Y (Feet)"].astype(float)
    seg = pd.Series(segment)
    clean_x, clean_y = pxs.copy(), pys.copy()
    for _, idx in seg.groupby(seg).groups.items():
        x, y = pxs.loc[idx], pys.loc[idx]
        mx = x.rolling(7, center=True, min_periods=3).median()
        my = y.rolling(7, center=True, min_periods=3).median()
        bad = np.hypot(x - mx, y - my) > PUCK_OUTLIER_FT
        x, y = x.mask(bad), y.mask(bad)
        x = x.interpolate(limit=PUCK_FILL_FRAMES, limit_area="inside")
        y = y.interpolate(limit=PUCK_FILL_FRAMES, limit_area="inside")
        sx = x.rolling(3, center=True, min_periods=1).mean().where(x.notna())
        sy = y.rolling(3, center=True, min_periods=1).mean().where(y.notna())
        clean_x.loc[idx], clean_y.loc[idx] = sx, sy
    px, py = [None] * n, [None] * n
    for k in range(n):
        x, y = clean_x.iat[k * KEEP_EVERY], clean_y.iat[k * KEEP_EVERY]
        if not (np.isnan(x) or np.isnan(y)):
            px[k], py[k] = int(round(x * SCALE)), int(round(y * SCALE))

    # Recover jersey numbers missing on some rows from the tracklet's other rows.
    pl_all = t[t["Player or Puck"] == "Player"]
    known = (pl_all.dropna(subset=["Player Jersey Number"])
             .groupby(["Team", "Player Id"])["Player Jersey Number"].agg(lambda s: s.mode().iat[0]))
    keep = t[t["f"] % KEEP_EVERY == 0].copy()
    keep["k"] = keep["f"] // KEEP_EVERY
    pl = keep[keep["Player or Puck"] == "Player"].copy()
    miss = pl["Player Jersey Number"].isna()
    if miss.any():
        fill = pd.MultiIndex.from_arrays([pl.loc[miss, "Team"], pl.loc[miss, "Player Id"]]).map(known.to_dict().get)
        pl.loc[miss, "Player Jersey Number"] = list(fill)
    pl["team"] = pl["Team"].map({"Home": home_team, "Away": away_team})
    pl["jersey"] = pl["Player Jersey Number"].map(pid)
    pl = pl.dropna(subset=["team", "jersey", "Rink Location X (Feet)", "Rink Location Y (Feet)"])
    ents = sorted(set(zip(pl["team"], pl["jersey"])))
    ent_idx = {e: i for i, e in enumerate(ents)}
    pl["e"] = [ent_idx[(a, b)] for a, b in zip(pl["team"], pl["jersey"])]
    pl["xi"] = (pl["Rink Location X (Feet)"] * SCALE).round().astype(int)
    pl["yi"] = (pl["Rink Location Y (Feet)"] * SCALE).round().astype(int)

    frames = [[] for _ in range(n)]
    for k, e, x, y in zip(pl["k"], pl["e"], pl["xi"], pl["yi"]):
        frames[k].extend((int(e), int(x), int(y)))

    # Puck control: in each frame, the nearest tracked skater (not goalie) within POSSESSION_FT of
    # the puck "has it" (-1 = nobody). Drives both team possession and player time with puck.
    puck_k = pd.DataFrame({"k": range(n), "pkx": [v / SCALE if v is not None else np.nan for v in px],
                           "pky": [v / SCALE if v is not None else np.nan for v in py]})
    sk = pl[pl["jersey"] != "Go"][["k", "e", "team", "Rink Location X (Feet)", "Rink Location Y (Feet)"]].merge(puck_k, on="k")
    sk["d"] = np.hypot(sk["Rink Location X (Feet)"] - sk["pkx"], sk["Rink Location Y (Feet)"] - sk["pky"])
    sk = sk[sk["d"] <= POSSESSION_FT]
    win = sk.loc[sk.groupby("k")["d"].idxmin()].set_index("k")
    own = win["e"].reindex(range(n)).fillna(-1).astype(int)
    owner_team = win["team"].reindex(range(n))
    poss_tot = [int((owner_team == home_team).sum()), int((owner_team == away_team).sum())]
    twp = {f"{ents[e][0]}|{ents[e][1]}": int(c) for e, c in own[own >= 0].value_counts().items()}

    # movement / team-shape analytics from the full 30 fps tracking (kept out of pN.js)
    mv = A.movement_period(t, full_clock, segment, (clean_x.to_numpy(), clean_y.to_numpy()),
                           home_team, away_team, PERIOD_LENGTH[period], shift_wins or {})

    return {
        "_mv": mv,
        "period": period,
        "fps": 30 / KEEP_EVERY,
        "n": n,
        "clock": clock,
        "ents": [[team, j] for team, j in ents],
        "frames": frames,
        "px": px,
        "py": py,
        "cuts": cuts,
        "own": own.tolist(),
        "possTot": poss_tot,
        "twpTot": twp,
        "goalMarkers": [[g // KEEP_EVERY, int(full_clock[g])] for g in goal_frames],
    }


def estimate_assists(ev, gi):
    """Walk back from a goal: up to two distinct teammates (not the scorer) who touched
    the puck since the scoring team last gained possession."""
    goal = ev.loc[gi]
    team, scorer = goal["Team"], goal["pid"]
    out = []
    for i in range(gi - 1, -1, -1):
        e = ev.loc[i]
        if e["Period"] != goal["Period"]:
            break
        if e["Team"] != team:
            if e["Event"] in OPP_POSSESSION:
                break
            continue
        if e["Event"] not in POSSESSION_EVENTS:
            continue
        p = e["pid"]
        if p and p != scorer and p not in out:
            out.append(p)
        if len(out) == 2:
            break
    return out


def write_js(path, var, obj):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f"window.{var}=")
        json.dump(obj, fh, separators=(",", ":"))
        fh.write(";\n")


# ---------- expected goals (xG) ----------

def shot_features(ev):
    """One row per shot attempt (Shot or Goal) in a game's events, indexed like `ev`.
    Coordinates are flipped per team and period so every attempt attacks the +x net at (89, 0);
    the attack direction comes from where that team shot from in that period."""
    ev = ev.copy()
    ev["clock_s"] = ev["Clock"].map(clock_to_sec)
    att = ev[ev["Event"].isin(["Shot", "Goal"])].copy()
    if att.empty:
        return att
    med = att.groupby(["Team", "Period"])["X_Coordinate"].median()
    sgn = np.array([1 if med[(t, p)] >= 0 else -1 for t, p in zip(att["Team"], att["Period"])])
    xa, ya = att["X_Coordinate"].to_numpy() * sgn, att["Y_Coordinate"].to_numpy() * sgn
    att["dist"] = np.hypot(89 - xa, ya)
    att["angle"] = np.degrees(np.arctan2(np.abs(ya), 89 - xa))
    att["rebound"] = [int(((att["Period"] == p) & (att["Team"] == t) & (att["clock_s"] > c)
                           & (att["clock_s"] <= c + REBOUND_SECONDS)).any())
                      for p, t, c in zip(att["Period"], att["Team"], att["clock_s"])]
    att["one_timer"] = att["Detail_4"].fillna(0).astype(int)
    att["traffic"] = att["Detail_3"].fillna(0).astype(int)
    att["deflection"] = (att["Detail_1"] == "Deflection").astype(int)
    home = ev["Home_Team"].iloc[0]
    own = np.where(att["Team"] == home, att["Home_Team_Skaters"], att["Away_Team_Skaters"])
    opp = np.where(att["Team"] == home, att["Away_Team_Skaters"], att["Home_Team_Skaters"])
    att["power_play"] = (own > opp).astype(int)
    att["unblocked"] = att["Detail_2"] != "Blocked"
    att["goal"] = (att["Event"] == "Goal").astype(int)
    return att


def _design(df, mu, sd):
    X = df[XG_FEATURES].astype(float).to_numpy()
    return np.c_[np.ones(len(X)), (X - mu) / sd]


def _fit_logistic(X, y, lam):
    w = np.zeros(X.shape[1])
    R = lam * np.eye(len(w))
    R[0, 0] = 0
    for _ in range(50):
        p = 1 / (1 + np.exp(-X @ w))
        w += np.linalg.solve(X.T @ (X * (p * (1 - p))[:, None]) + R, X.T @ (y - p) - R @ w)
    return w


def _auc(y, p):
    order = np.argsort(p)
    ranks = np.empty(len(p))
    ranks[order] = np.arange(1, len(p) + 1)
    n1 = y.sum()
    return float((ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * (len(y) - n1)))


def fit_xg(src, prefixes):
    """Fit a ridge logistic regression P(goal) on unblocked attempts from every game, and report
    leave-one-game-out log loss / AUC so the model's quality is measured on unseen games."""
    rows = []
    for pre in prefixes:
        f = shot_features(pd.read_csv(os.path.join(src, pre + "Events.csv")))
        rows.append(f.assign(game=pre))
    U = pd.concat(rows)
    U = U[U["unblocked"]]
    y = U["goal"].to_numpy()
    X_all = U[XG_FEATURES].astype(float).to_numpy()
    mu, sd = X_all.mean(0), X_all.std(0) + 1e-9
    w = _fit_logistic(_design(U, mu, sd), y, XG_L2)

    pred, base = np.zeros(len(U)), np.zeros(len(U))
    for g in U["game"].unique():
        tr = (U["game"] != g).to_numpy()
        m, s = X_all[tr].mean(0), X_all[tr].std(0) + 1e-9
        wg = _fit_logistic(_design(U[tr], m, s), y[tr], XG_L2)
        pred[~tr] = 1 / (1 + np.exp(-_design(U[~tr], m, s) @ wg))
        base[~tr] = y[tr].mean()
    ll = lambda p: float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
    model = {
        "features": XG_FEATURES, "mu": mu.round(5).tolist(), "sd": sd.round(5).tolist(), "w": w.round(5).tolist(),
        "attempts": int(len(U)), "goals": int(y.sum()), "games": len(prefixes),
        "cv": {"auc": round(_auc(y, pred), 3), "logloss": round(ll(pred), 4), "baseline_logloss": round(ll(base), 4),
               "xg_total": round(float(pred.sum()), 1)},
    }
    print(f"xG model: {len(U)} unblocked attempts, {int(y.sum())} goals | leave-one-game-out AUC {model['cv']['auc']}, "
          f"log loss {model['cv']['logloss']} vs baseline {model['cv']['baseline_logloss']}")
    return model


def xg_for(feat, model):
    """xG for each unblocked attempt in `feat` (blocked attempts get no xG)."""
    U = feat[feat["unblocked"]]
    if U.empty:
        return {}
    X = _design(U, np.array(model["mu"]), np.array(model["sd"]))
    p = 1 / (1 + np.exp(-X @ np.array(model["w"])))
    return dict(zip(U.index, np.round(p, 3)))


# ---------- power plays ----------

def power_plays(ev, xg, periods):
    """One window per penalty that put the other team on a power play.
    Starts at the penalty; ends at the first of: the minor expiring (2:00), the power-play team
    scoring, or the skater counts going back to even (e.g. a coincidental penalty). Each event
    carries both teams' skater counts, which is what tells us when strength actually changes.
    Penalties that never produce an uneven strength (coincidental minors) are skipped; a pulled
    goalie with no penalty is never a power play because every window starts at a penalty."""
    home = ev["Home_Team"].iloc[0]
    teams = (home, ev["Away_Team"].iloc[0])
    sk = lambda r, t: r["Home_Team_Skaters"] if t == home else r["Away_Team_Skaters"]
    out = []
    for gi, pen in ev[ev["Event"] == "Penalty Taken"].iterrows():
        p = int(pen["Period"])
        if p not in periods:
            continue
        shorthanded = pen["Team"]
        pp_team = teams[1] if shorthanded == teams[0] else teams[0]
        start = int(pen["clock_s"])
        cap = max(0, start - PP_MINOR_SECONDS)
        after = ev[(ev.index > gi) & (ev["Period"] == p) & (ev["clock_s"] <= start) & (ev["clock_s"] >= cap)]
        end, reason, seen_uneven = cap, "expired", False
        for _, r in after.iterrows():
            up = sk(r, pp_team) > sk(r, shorthanded)
            if up:
                seen_uneven = True
            elif seen_uneven and r["clock_s"] <= start - PP_SETTLE_SECONDS:
                end, reason = int(r["clock_s"]), "even"
                break
        if not seen_uneven:
            continue   # coincidental minors (4 on 4) or no strength change recorded: not a power play
        out.append({"gi": gi, "p": p, "team": pp_team, "opp": shorthanded, "pl": pid(pen["Player_Id"]),
                    "why": None if pd.isna(pen["Detail_1"]) else str(pen["Detail_1"]),
                    "start": start, "end": end, "reason": reason})

    # A power-play goal ends the window that expires first among that team's active windows.
    for gi, g in ev[ev["Event"] == "Goal"].iterrows():
        act = [w for w in out if w["p"] == g["Period"] and w["team"] == g["Team"]
               and w["end"] <= g["clock_s"] <= w["start"] and w["reason"] != "goal" and gi > w["gi"]]
        if act:
            w = min(act, key=lambda w: w["end"])
            w["end"], w["reason"] = int(g["clock_s"]), "goal"

    for w in out:
        inside = ev[(ev.index > w["gi"]) & (ev["Period"] == w["p"]) & (ev["clock_s"] <= w["start"]) & (ev["clock_s"] >= w["end"])]
        mine = inside[inside["Team"] == w["team"]]
        w["goals"] = int((mine["Event"] == "Goal").sum())
        w["att"] = int(mine["Event"].isin(["Shot", "Goal"]).sum())
        w["xg"] = round(float(sum(xg.get(i, 0) for i in mine.index)), 2)
        w["shg"] = int(((inside["Team"] == w["opp"]) & (inside["Event"] == "Goal")).sum())
        w.pop("gi")
    return out


def build_report(ev, events, pp, periods, home, away, wpm):
    """Everything the Game report page needs (and the replay's live Movement tab)."""
    lens = {p: PERIOD_LENGTH[p] for p in periods}
    dirs = A.attack_dirs(ev, list(periods))

    players = {}
    shape = {t: {"spacing": [0.0, 0], "react": [0.0, 0], "oz": 0} for t in (home, away)}
    for p in sorted(periods):
        mv = periods[p]["_mv"]
        for key, s in mv["players"].items():
            g = players.setdefault(key, {"frames": 0, "dist": 0, "zones": [0, 0, 0, 0], "with": [0, 0], "without": [0, 0],
                                         "bursts": 0, "top": None, "acc": None, "buckets": {}, "entry": []})
            g["frames"] += s["frames"]; g["dist"] += s["dist"]; g["bursts"] += s["bursts"]
            g["zones"] = [a + b for a, b in zip(g["zones"], s["zones"])]
            for side in ("with", "without"):
                g[side] = [g[side][0] + s[side][0], g[side][1] + s[side][1]]
            g["buckets"][str(p)] = s["buckets"]
            g["entry"] += [[p] + e for e in s["entry"]]
            tops = [b[3] for b in s["buckets"] if b[3] is not None]
            accs = [b[4] for b in s["buckets"] if b[4] is not None]
            if tops:
                g["top"] = max(tops + ([g["top"]] if g["top"] else []))
            if accs:
                g["acc"] = max(accs + ([g["acc"]] if g["acc"] else []))
        for t in (home, away):
            sp = mv["spacing"].get(t, [0, 0])
            shape[t]["spacing"][0] += sp[0]; shape[t]["spacing"][1] += sp[1]
            rc = mv["react"].get(t, [0, 0])
            shape[t]["react"][0] += rc[0]; shape[t]["react"][1] += rc[1]
            oz = mv["oz"].get(t, [0, 0])
            shape[t]["oz"] += oz[0] if dirs.get((t, p), 1) == 1 else oz[1]
    team_shape = {t: {"spacing": round(v["spacing"][0] / v["spacing"][1], 1) if v["spacing"][1] else None,
                      "react": round(v["react"][0] / v["react"][1], 1) if v["react"][1] else None,
                      "ozSeconds": int(round(v["oz"] / A.FPS))} for t, v in shape.items()}

    wp = A.win_probability(events, pp, home, away, list(periods), lens, wpm)
    passes = A.pass_network(ev, list(periods), dirs, pid)
    return {"players": players, "shape": team_shape, "winProb": wp, "passes": passes,
            "buckets": {str(p): periods[p]["_mv"]["nb"] for p in periods},
            "bucketSeconds": A.BUCKET, "fps": A.FPS}


def process_game(args):
    src, prefix, out_root, model, wpm = args
    gid = game_id(prefix)
    out = os.path.join(out_root, "games", gid)
    os.makedirs(out, exist_ok=True)

    ev = pd.read_csv(os.path.join(src, prefix + "Events.csv"))
    sh = pd.read_csv(os.path.join(src, prefix + "Shifts.csv"))
    home, away = ev["Home_Team"].iloc[0], ev["Away_Team"].iloc[0]

    shift_wins = {}
    for _, s in sh.iterrows():
        j = pid(s["Player_Id"])
        if j and j != "Go":
            shift_wins.setdefault(int(s["period"]), {}).setdefault(f"{s['Team']}|{j}", []).append(
                (clock_to_sec(s["start_clock"]), clock_to_sec(s["end_clock"])))

    periods = {}
    for p, suffix in PERIOD_FILES.items():
        path = os.path.join(src, prefix + suffix)
        if os.path.exists(path):
            periods[p] = build_period(path, p, home, away, shift_wins.get(p, {}))

    ev["pid"] = ev["Player_Id"].map(pid)
    ev["pid2"] = ev["Player_Id_2"].map(pid)
    ev["clock_s"] = ev["Clock"].map(clock_to_sec)
    xg = xg_for(shot_features(ev), model)

    # Map each event to a playback frame. Goals use the tracking 'Goal Score = G' frame when
    # one sits within a few seconds of the event clock; everything else uses the first frame
    # at (or after) its clock second. Frames stay non-decreasing in event-log order.
    events = []
    markers_used = 0
    for p in sorted(periods):
        P = periods[p]
        clock = P["clock"]
        markers = list(P["goalMarkers"])
        sub = ev[ev["Period"] == p]
        goal_frame = {}
        for gi, e in sub[sub["Event"] == "Goal"].iterrows():
            near = [m for m in markers if abs(m[1] - e["clock_s"]) <= GOAL_MARKER_TOL]
            if near:
                m = min(near, key=lambda m: abs(m[1] - e["clock_s"]))
                markers.remove(m)
                goal_frame[gi] = m[0]
        markers_used += len(goal_frame)
        last = 0
        goal_idx = [gi for gi in sub.index if sub.loc[gi, "Event"] == "Goal"]
        for gi, e in sub.iterrows():
            if gi in goal_frame:
                f = goal_frame[gi]
            else:
                f = next((k for k, c in enumerate(clock) if c <= e["clock_s"]), P["n"] - 1)
                nxt = next((goal_frame[g] for g in goal_idx if g > gi and g in goal_frame), None)
                if nxt is not None:  # never place a pre-goal event after the next goal
                    f = min(f, nxt)
            f = max(f, last)
            last = f
            rec = {
                "p": p, "f": int(f), "c": int(e["clock_s"]), "t": e["Team"], "pl": e["pid"],
                "ev": e["Event"], "d1": None if pd.isna(e["Detail_1"]) else str(e["Detail_1"]),
                "d2": None if pd.isna(e["Detail_2"]) else str(e["Detail_2"]),
            }
            if e["pid2"]:
                rec["pl2"] = e["pid2"]
            if e["clock_s"] > clock[0] + 1:
                rec["pre"] = 1   # happened before this period's tracking starts
            if gi in xg:
                rec["xg"] = float(xg[gi])

            if e["Event"] == "Goal":
                rec["ast"] = estimate_assists(ev, gi)
                x, y = e["X_Coordinate"], e["Y_Coordinate"]
                if not (pd.isna(x) or pd.isna(y)):
                    # mirror so every goal is shown attacking the right-hand net
                    rec["xy"] = [round(abs(x), 1), round(y if x >= 0 else -y, 1)]
            events.append(rec)

    shifts = []
    for _, s in sh.iterrows():
        if int(s["period"]) in periods and pid(s["Player_Id"]):
            shifts.append([s["Team"], pid(s["Player_Id"]), int(s["period"]),
                           clock_to_sec(s["start_clock"]), clock_to_sec(s["end_clock"])])

    pp = power_plays(ev, xg, periods)

    roster = {home: set(), away: set()}
    for team, j, *_ in shifts:
        roster[team].add(j)
    for e in events:
        if e["pl"] and e["t"] in roster:
            roster[e["t"]].add(e["pl"])

    meta = {
        "id": gid, "date": str(ev["Date"].iloc[0]), "home": home, "away": away,
        "periods": {str(p): {"n": periods[p]["n"], "fps": periods[p]["fps"],
                             "start": periods[p]["clock"][0], "len": PERIOD_LENGTH[p],
                             "poss": periods[p]["possTot"], "twp": periods[p]["twpTot"]} for p in periods},
        "events": events, "shifts": shifts, "pp": pp,
        "roster": {k: sorted(v, key=lambda j: (j != "Go", int(j) if j.isdigit() else 0)) for k, v in roster.items()},
    }
    write_js(os.path.join(out, "meta.js"), "RS_META", meta)
    report = build_report(ev, events, pp, periods, home, away, wpm)
    write_js(os.path.join(out, "report.js"), "RS_REPORT", report)
    for p in periods:
        P = dict(periods[p])
        for k in ("goalMarkers", "possTot", "twpTot", "_mv"):
            P.pop(k)
        write_js(os.path.join(out, f"p{p}.js"), f"RS_P{p}", P)

    goals = [e for e in events if e["ev"] == "Goal"]
    count = lambda team, pred: sum(1 for e in events if e["t"] == team and pred(e))
    sog = lambda e: e["ev"] == "Goal" or (e["ev"] == "Shot" and e["d2"] == "On Net")
    summary = {
        "id": gid, "date": meta["date"], "home": home, "away": away,
        "score": {home: count(home, lambda e: e["ev"] == "Goal"), away: count(away, lambda e: e["ev"] == "Goal")},
        "sog": {home: count(home, sog), away: count(away, sog)},
        "pen": {home: count(home, lambda e: e["ev"] == "Penalty Taken"), away: count(away, lambda e: e["ev"] == "Penalty Taken")},
        "xg": {t: round(sum(e.get("xg", 0) for e in events if e["t"] == t), 2) for t in (home, away)},
        "pp": {t: [sum(w["goals"] for w in pp if w["team"] == t), sum(1 for w in pp if w["team"] == t)] for t in (home, away)},
        "poss": {home: sum(periods[p]["possTot"][0] for p in periods), away: sum(periods[p]["possTot"][1] for p in periods)},
        "ot": 4 in periods,
        "goals": [{"p": g["p"], "c": g["c"], "t": g["t"], "pl": g["pl"], "d1": g["d1"], "xy": g.get("xy")} for g in goals],
        "periodLength": {str(p): PERIOD_LENGTH[p] for p in periods},
        "trackStart": {str(p): periods[p]["clock"][0] for p in periods},
        "frames": sum(P["n"] for P in periods.values()) * KEEP_EVERY,
        "wpBrier": report["winProb"]["brier"], "wpOutcome": report["winProb"]["outcome"],
        "events": len(events),
    }
    print(f"  {gid}: {away} {summary['score'][away]} @ {home} {summary['score'][home]}"
          f"{' (OT)' if summary['ot'] else ''}  periods={sorted(periods)}  goals synced to tracking={markers_used}/{len(goals)}")
    return summary


def fit_wp(src, prefixes):
    """League scoring rate and power-play multipliers for the win-probability model."""
    rows = []
    for pre in prefixes:
        ev = pd.read_csv(os.path.join(src, pre + "Events.csv"))
        ev["clock_s"] = ev["Clock"].map(clock_to_sec)
        per = sorted(int(p) for p in ev["Period"].unique())
        pp = power_plays(ev, {}, {p: 1 for p in per})
        evs = [{"ev": e} for e in ev["Event"]]
        rows.append((evs, pp, sum(PERIOD_LENGTH[p] for p in per), None))
    wpm = A.fit_wp_rates(rows)
    print(f"Win prob model: {wpm['goals']} goals over {wpm['team_seconds']} team-seconds "
          f"({wpm['rate'] * 3600:.2f} per team per 60), PP x{wpm['pp_mult']}, SH x{wpm['sh_mult']}")
    return wpm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="raw", help="folder with the Big Data Cup CSVs")
    ap.add_argument("--out", default="data")
    ap.add_argument("--game", default=None, help="only write games whose id contains this (models still fit on all)")
    ap.add_argument("--workers", type=int, default=max(1, min(5, (os.cpu_count() or 2) - 1)))
    a = ap.parse_args()

    prefixes = sorted(os.path.basename(f)[: -len("Events.csv")] for f in glob.glob(os.path.join(a.src, "*Events.csv"))
                      if "checkpoint" not in f)
    if not prefixes:
        raise SystemExit(f"No *Events.csv files found in {a.src}")
    os.makedirs(os.path.join(a.out, "games"), exist_ok=True)
    model = fit_xg(a.src, prefixes)
    write_js(os.path.join(a.out, "xg_model.js"), "RS_XG", model)
    wpm = fit_wp(a.src, prefixes)
    write_js(os.path.join(a.out, "wp_model.js"), "RS_WP", wpm)
    print(f"Processing {len(prefixes)} games with {a.workers} workers...")
    todo = [p for p in prefixes if not a.game or a.game in game_id(p)]
    with ProcessPoolExecutor(a.workers) as pool:
        games = list(pool.map(process_game, [(a.src, p, a.out, model, wpm) for p in todo]))
    games.sort(key=lambda g: (g["date"], g["id"]))
    if a.game:
        print("(--game set: games.js not rewritten)")
        return
    write_js(os.path.join(a.out, "games.js"), "RS_GAMES", games)
    print(f"Wrote {len(games)} games to {a.out}")


if __name__ == "__main__":
    main()
