"""
RINKSENSE analytics used by preprocess.py:
  - movement metrics per player from raw 30 fps tracking (speed, acceleration, bursts, distance,
    speed zones, with/without the puck, shift-start speed), stored per 1-minute bucket so the replay
    can show them "through now" without spoilers
  - team shape: spacing, offensive-zone time, reaction burst after turnovers
  - win probability timeline (per game-second) and turning points
  - pass networks
"""
import math

import numpy as np
import pandas as pd

FPS = 30
JUMP_FT = 3.0            # >3 ft in 1/30 s (90 ft/s) = tracker ID swap / teleport -> break the track
SMOOTH = 15              # 0.5 s centered rolling mean on positions
MIN_RUN = 30             # ignore tracklets shorter than 1 s
BURST_LO, BURST_HI, BURST_WIN = 10.0, 20.0, 2 * FPS   # under 10 ft/s to over 20 ft/s within 2 s
ZONES = (3.0, 14.0, 22.0)  # standing < 3 <= cruising < 14 <= striding < 22 <= sprinting (ft/s)
POSS_FT = 6.0
BUCKET = 60              # seconds of game clock per bucket
BUCKET_MIN_FRAMES = 60   # a bucket needs 2 s of skating to report a top speed / acceleration
ENTRY_SECONDS = 10       # "shift entry speed" = mean speed in the first 10 s of a shift
REACT_FRAMES = 2 * FPS   # reaction burst window after a turnover
OZ_LINE = 25.0           # blue line (ft from center)
WP_PRIOR_SECONDS = 1200  # weight of the league-average scoring rate (one period of "evidence")
WP_MAX_GOALS = 12


# ---------------------------------------------------------------- movement (one period)

def _bursts(v):
    """Indices where a burst starts: speed under BURST_LO, then over BURST_HI within BURST_WIN."""
    out, i, n = [], 0, len(v)
    while i < n:
        if v[i] < BURST_LO:
            hit = np.nonzero(v[i:i + BURST_WIN] > BURST_HI)[0]
            if len(hit):
                out.append(i)
                i += hit[0]
                while i < n and v[i] > BURST_LO:
                    i += 1
                continue
        i += 1
    return out


def movement_period(t, full_clock, segment, puck_x, home, away, period_len, shift_wins):
    """t: raw tracking rows with column 'f' (30 fps frame index). Returns players/team dicts."""
    nb = int(math.ceil(period_len / BUCKET))
    pl = t[t["Player or Puck"] == "Player"].dropna(subset=["Player Jersey Number", "Rink Location X (Feet)", "Rink Location Y (Feet)"]).copy()
    pl["team"] = pl["Team"].map({"Home": home, "Away": away})
    pl["j"] = pl["Player Jersey Number"].astype(str).str.replace(r"\.0$", "", regex=True)
    pl = pl.dropna(subset=["team"])
    pl = pl[pl["j"] != "Go"].sort_values(["team", "j", "f"]).drop_duplicates(["team", "j", "f"])
    pl["seg"] = segment[pl["f"].to_numpy()]
    x, y = pl["Rink Location X (Feet)"], pl["Rink Location Y (Feet)"]
    g = pl.groupby(["team", "j"])
    step = np.hypot(x - g["Rink Location X (Feet)"].shift(), y - g["Rink Location Y (Feet)"].shift())
    pl["run"] = ((g["f"].diff() != 1) | (g["seg"].diff() != 0) | (step > JUMP_FT)).cumsum()
    pl = pl[pl.groupby("run")["f"].transform("size") >= MIN_RUN].copy()
    r = pl.groupby("run")
    roll = lambda s: s.rolling(SMOOTH, center=True, min_periods=SMOOTH // 2 + 1).mean()
    pl["sx"] = r["Rink Location X (Feet)"].transform(roll)
    pl["sy"] = r["Rink Location Y (Feet)"].transform(roll)
    r = pl.groupby("run")
    pl["v"] = np.hypot(r["sx"].diff(), r["sy"].diff()) * FPS
    pl["v"] = pl.groupby("run")["v"].transform(lambda s: s.rolling(5, center=True, min_periods=1).mean())
    pl["acc"] = pl.groupby("run")["v"].diff(FPS)
    pl = pl.dropna(subset=["v"])
    pl["clock"] = full_clock[pl["f"].to_numpy()]
    pl["b"] = np.clip(((period_len - pl["clock"]) // BUCKET).astype(int), 0, nb - 1)

    # puck owner (team + key) per frame: nearest tracked skater within POSS_FT of the puck
    pk = pd.DataFrame({"f": np.arange(len(puck_x[0])), "px": puck_x[0], "py": puck_x[1]}).dropna()
    m = pl[["f", "team", "j", "sx", "sy"]].merge(pk, on="f")
    m["d"] = np.hypot(m["sx"] - m["px"], m["sy"] - m["py"])
    m = m[m["d"] <= POSS_FT].sort_values("d").drop_duplicates("f")
    owner_team = pd.Series(m["team"].to_numpy(), index=m["f"].to_numpy())
    pl["owner"] = pl["f"].map(owner_team)
    pl["side"] = np.where(pl["owner"].isna(), 0, np.where(pl["owner"] == pl["team"], 1, 2))   # 1 with, 2 without

    players = {}
    for (team, j), p in pl.groupby(["team", "j"]):
        key = f"{team}|{j}"
        v = p["v"].to_numpy()
        burst_rows = []
        for _, rr in p.groupby("run"):
            burst_rows += list(rr.index[_bursts(rr["v"].to_numpy())])
        burst_b = p.loc[burst_rows, "b"].value_counts() if burst_rows else pd.Series(dtype=int)
        buckets = []
        for b, q in p.groupby("b"):
            qv, qa = q["v"].to_numpy(), q["acc"].dropna().to_numpy()
            ok = len(qv) >= BUCKET_MIN_FRAMES
            buckets.append([
                int(b), int(len(qv)), int(round(qv.sum() / FPS)),
                round(float(np.percentile(qv, 98)), 1) if ok else None,
                round(float(np.percentile(qa, 98)), 1) if ok and len(qa) else None,
                int(burst_b.get(b, 0)), int((qv >= ZONES[2]).sum()),
            ])
        zones = np.digitize(v, ZONES)
        entry = []
        for (start, end) in shift_wins.get(key, []):
            q = p[(p["clock"] <= start) & (p["clock"] >= start - ENTRY_SECONDS)]
            if len(q) >= FPS:
                entry.append([int(start), round(float(q["v"].mean()), 1)])
        players[key] = {
            "frames": int(len(v)), "dist": int(round(v.sum() / FPS)),
            "zones": [int((zones == i).sum()) for i in range(4)],
            "with": [int((p["side"] == 1).sum()), int(round(p.loc[p["side"] == 1, "v"].sum() / FPS))],
            "without": [int((p["side"] == 2).sum()), int(round(p.loc[p["side"] == 2, "v"].sum() / FPS))],
            "bursts": len(burst_rows), "buckets": buckets, "entry": entry,
        }

    # team spacing: mean distance between tracked teammates (frames with 3+ of them), every 5th frame
    sub = pl[pl["f"] % 5 == 0]
    spacing = {}
    for team, q in sub.groupby("team"):
        vals = []
        for _, fr in q.groupby("f"):
            if len(fr) >= 3:
                pts = fr[["sx", "sy"]].to_numpy()
                d = np.hypot(pts[:, None, 0] - pts[None, :, 0], pts[:, None, 1] - pts[None, :, 1])
                vals.append(d[np.triu_indices(len(pts), 1)].mean())
        spacing[team] = [round(float(np.sum(vals)), 1), len(vals)]

    # reaction burst: after the puck changes hands from team A to B, A's tracked skaters' best
    # 1-s speed gain in the next 2 s (averaged per turnover)
    react = {home: [0.0, 0], away: [0.0, 0]}
    own = owner_team.sort_index()
    prev_f, prev_t = None, None
    acc_by_f = pl.dropna(subset=["acc"]).groupby(["f", "team"])["acc"].max()
    acc_frame = acc_by_f.reset_index()
    for f, tm in own.items():
        if prev_t is not None and tm != prev_t and f - prev_f <= FPS and segment[f] == segment[prev_f]:
            w = acc_frame[(acc_frame["f"] > f) & (acc_frame["f"] <= f + REACT_FRAMES) & (acc_frame["team"] == prev_t)]
            if len(w):
                react[prev_t][0] += float(w["acc"].max())
                react[prev_t][1] += 1
        prev_f, prev_t = f, tm

    # offensive-zone puck control frames, split by which end the puck is at (direction applied later)
    px = puck_x[0]
    oz = {}
    for team in (home, away):
        fs = own[own == team].index.to_numpy()
        xs = px[fs]
        oz[team] = [int(np.nansum(xs > OZ_LINE)), int(np.nansum(xs < -OZ_LINE))]

    return {"players": players, "spacing": spacing, "react": react, "oz": oz, "nb": nb}


# ---------------------------------------------------------------- win probability

def _pois(mu, k):
    k = np.arange(k + 1)
    lg = np.array([math.lgamma(i + 1) for i in k])
    return np.exp(-mu + k * np.log(max(mu, 1e-12)) - lg)


def _p_home_wins(mu_h, mu_a, diff, ot_rh, ot_ra):
    """P(home wins) with remaining-regulation goal means mu_h/mu_a, current diff = home - away;
    a tie goes to sudden-death OT (5:00) then a 50/50 shootout."""
    ph, pa = _pois(mu_h, WP_MAX_GOALS), _pois(mu_a, WP_MAX_GOALS)
    grid = np.outer(ph, pa)
    k = np.arange(WP_MAX_GOALS + 1)
    margin = diff + k[:, None] - k[None, :]
    win, tie = grid[margin > 0].sum(), grid[margin == 0].sum()
    return float(win + tie * _ot_win(ot_rh, ot_ra, 300))


def _ot_win(rh, ra, secs):
    tot = rh + ra
    if tot <= 0:
        return 0.5
    none = math.exp(-tot * secs)
    return rh / tot * (1 - none) + 0.5 * none


def win_probability(events, pp, home, away, periods, lens, wpm):
    """Per-second home win probability for each period, plus turning points and Brier score."""
    lam = wpm["rate"]
    pp_mult, sh_mult = wpm["pp_mult"], wpm["sh_mult"]
    reg_total = sum(lens[p] for p in periods if p <= 3)
    order = sorted(periods)
    elapsed_before = {}
    acc = 0
    for p in order:
        elapsed_before[p] = acc
        acc += lens[p]
    goals = [e for e in events if e["ev"] == "Goal"]
    xg_ev = [e for e in events if e.get("xg")]
    final = (sum(e["t"] == home for e in goals), sum(e["t"] == away for e in goals))
    outcome = 1.0 if final[0] > final[1] else 0.0 if final[0] < final[1] else 0.5

    def state(p, c):
        done = lambda e: e["p"] < p or (e["p"] == p and e["c"] >= c)
        hs = sum(1 for e in goals if e["t"] == home and done(e))
        as_ = sum(1 for e in goals if e["t"] == away and done(e))
        xh = sum(e["xg"] for e in xg_ev if e["t"] == home and done(e))
        xa = sum(e["xg"] for e in xg_ev if e["t"] == away and done(e))
        return hs, as_, xh, xa

    wp = {}
    for p in order:
        L = lens[p]
        arr = []
        for c in range(L, -1, -1):
            hs, as_, xh, xa = state(p, c)
            el = elapsed_before[p] + (L - c)
            rh = (lam * WP_PRIOR_SECONDS + xh) / (WP_PRIOR_SECONDS + el)
            ra = (lam * WP_PRIOR_SECONDS + xa) / (WP_PRIOR_SECONDS + el)
            if p == order[-1] and c == 0:
                v = outcome
            elif p <= 3:
                rem = max(0, reg_total - el)
                mh, ma = rh * rem, ra * rem
                for w in pp:   # active power play: extra / fewer expected goals for its remaining time
                    if w["p"] == p and w["start"] >= c > w["end"]:
                        left = max(0, c - max(0, w["start"] - 120))
                        r_pp = rh if w["team"] == home else ra
                        r_sh = ra if w["team"] == home else rh
                        if w["team"] == home:
                            mh += (pp_mult - 1) * r_pp * left
                            ma += (sh_mult - 1) * r_sh * left
                        else:
                            ma += (pp_mult - 1) * r_pp * left
                            mh += (sh_mult - 1) * r_sh * left
                v = _p_home_wins(max(mh, 1e-9), max(ma, 1e-9), hs - as_, rh, ra)
            else:   # overtime, sudden death
                v = 1.0 if hs > as_ else 0.0 if hs < as_ else _ot_win(rh, ra, c)
            arr.append(round(v, 3))
        wp[p] = arr   # index i = clock (L - i)

    # turning points: biggest one-second swings at a goal or a penalty
    swings = []
    for e in events:
        if e["ev"] not in ("Goal", "Penalty Taken") or e["p"] not in wp:
            continue
        L = lens[e["p"]]
        i = L - e["c"]
        before = wp[e["p"]][i - 1] if i - 1 >= 0 else (wp[order[order.index(e["p"]) - 1]][-1] if order.index(e["p"]) else 0.5)
        after = wp[e["p"]][i]
        swings.append({"p": e["p"], "c": e["c"], "ev": e["ev"], "t": e["t"], "pl": e["pl"], "d1": e.get("d1"),
                       "before": round(before, 3), "after": round(after, 3), "delta": round(after - before, 3)})
    seen, turning = set(), []
    for s in sorted(swings, key=lambda s: -abs(s["delta"])):
        if (s["p"], s["c"]) in seen:
            continue
        seen.add((s["p"], s["c"]))
        turning.append(s)
        if len(turning) == 3:
            break
    turning.sort(key=lambda s: (s["p"], -s["c"]))

    allv = np.concatenate([np.array(wp[p]) for p in order])
    brier = None if outcome == 0.5 else round(float(np.mean((allv - outcome) ** 2)), 4)
    return {"wp": {str(p): wp[p] for p in order}, "turning": turning, "outcome": outcome, "brier": brier}


def fit_wp_rates(all_events):
    """League scoring rate per team-second, and power-play / shorthanded multipliers, from all games.
    all_events: list of (events, pp_windows, total_seconds, team_names)."""
    goals = sum(sum(1 for e in ev if e["ev"] == "Goal") for ev, _, _, _ in all_events)
    secs = sum(s for _, _, s, _ in all_events)
    rate = goals / (2 * secs)
    pp_goals = sum(w["goals"] for _, pp, _, _ in all_events for w in pp)
    sh_goals = sum(w["shg"] for _, pp, _, _ in all_events for w in pp)
    pp_secs = sum(w["start"] - w["end"] for _, pp, _, _ in all_events for w in pp)
    # shrink toward 1x with a prior worth 1,200 team-seconds, since there are few power plays
    prior = 1200
    pp_mult = (pp_goals + rate * prior) / (rate * (pp_secs + prior)) if pp_secs else 1.0
    sh_mult = (sh_goals + rate * prior) / (rate * (pp_secs + prior)) if pp_secs else 1.0
    return {"rate": rate, "pp_mult": round(pp_mult, 3), "sh_mult": round(sh_mult, 3),
            "goals": goals, "team_seconds": 2 * secs, "pp_goals": pp_goals, "sh_goals": sh_goals, "pp_seconds": pp_secs}


# ---------------------------------------------------------------- pass network

def attack_dirs(ev, periods):
    """+1 if a team attacks +x in a period (from where it shot), else -1."""
    att = ev[ev["Event"].isin(["Shot", "Goal"])]
    teams = list(ev["Team"].dropna().unique())
    out = {}
    for p in periods:
        for tm in teams:
            q = att[(att["Period"] == p) & (att["Team"] == tm)]["X_Coordinate"]
            if len(q):
                out[(tm, p)] = 1 if q.median() >= 0 else -1
        for tm in teams:
            if (tm, p) not in out:
                other = [o for o in teams if o != tm and (o, p) in out]
                out[(tm, p)] = -out[(other[0], p)] if other else 1
    return out


def pass_network(ev, periods, dirs, pid):
    """Completed passes (Play events with a receiver), positions mirrored so each team attacks right."""
    res = {}
    plays = ev[(ev["Event"] == "Play") & ev["Player_Id_2"].notna() & ev["Period"].isin(list(periods))]
    for tm, q in plays.groupby("Team"):
        res[tm] = {}
        for key, sel in [("all", q)] + [(str(p), q[q["Period"] == p]) for p in periods]:
            pos, edges = {}, {}
            for _, e in sel.iterrows():
                a, b = pid(e["Player_Id"]), pid(e["Player_Id_2"])
                if not a or not b or a == b:
                    continue
                d = dirs.get((tm, e["Period"]), 1)
                for who, x, y in ((a, e["X_Coordinate"], e["Y_Coordinate"]), (b, e["X_Coordinate_2"], e["Y_Coordinate_2"])):
                    if pd.isna(x) or pd.isna(y):
                        continue
                    s = pos.setdefault(who, [0.0, 0.0, 0])
                    s[0] += x * d; s[1] += y * d; s[2] += 1
                k = tuple(sorted((a, b)))
                edges[k] = edges.get(k, 0) + 1
            nodes = [[j, round(s[0] / s[2], 1), round(s[1] / s[2], 1), s[2]] for j, s in pos.items() if s[2]]
            res[tm][key] = {"nodes": nodes, "edges": [[a, b, c] for (a, b), c in sorted(edges.items(), key=lambda kv: -kv[1])]}
    return res
