"""Train the MLB models on the 2026 Statcast season and report honest validation.

  python scripts/mlb_models.py

Reads ../raw/mlb/statcast/*.csv (from mlb_fetch.py), writes:
  ../raw/mlb/models.joblib   fitted models + pitcher profiles (used by mlb_preprocess.py)
  mlb/data/models.js         validation numbers + calibration tables for the methods page

Models
  win prob  P(home wins | inning, half, outs, bases, score diff, count), pitch level.
  xwOBA     P(out/1B/2B/3B/HR | exit velo, launch angle, spray angle) -> expected wOBA, xBA.
  Stuff+    expected count-adjusted run value of a pitch from its physical traits only (no location).
  xWhiff    P(whiff | swing) from the same traits.
"""
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.model_selection import GroupKFold

HERE = Path(__file__).resolve().parents[1]
RAW = HERE.parent / "raw" / "mlb"
OUT_JS = HERE / "mlb" / "data" / "models.js"
SEED = 7

WP_FEATS = ["inning", "bot", "outs", "b1", "b2", "b3", "diff", "balls", "strikes"]
XW_FEATS = ["launch_speed", "launch_angle", "spray"]
XW_CLASSES = ["out", "single", "double", "triple", "home_run"]
ST_FEATS = ["velo", "hb", "ivb", "spin", "ext", "rel_x", "rel_z", "arm_angle",
            "d_velo", "d_hb", "d_ivb"]
FASTBALLS = {"FF", "SI", "FC"}


# ---------------------------------------------------------------- data
def load():
    cache = RAW / "statcast_2026.parquet"
    if cache.exists():
        return pd.read_parquet(cache)
    parts = []
    for f in sorted((RAW / "statcast").glob("*.csv")):
        d = pd.read_csv(f, low_memory=False)
        if len(d):
            parts.append(d)
    df = pd.concat(parts, ignore_index=True)
    df = df.sort_values(["game_pk", "at_bat_number", "pitch_number"]).reset_index(drop=True)
    df.to_parquet(cache)
    return df


def wp_frame(df):
    d = pd.DataFrame({
        "game_pk": df.game_pk,
        "inning": df.inning.clip(upper=10),
        "bot": (df.inning_topbot == "Bot").astype(int),
        "outs": df.outs_when_up,
        "b1": df.on_1b.notna().astype(int),
        "b2": df.on_2b.notna().astype(int),
        "b3": df.on_3b.notna().astype(int),
        "diff": (df.home_score - df.away_score).clip(-8, 8),
        "balls": df.balls.clip(upper=3),
        "strikes": df.strikes.clip(upper=2),
    })
    last = df.groupby("game_pk").tail(1).set_index("game_pk")
    home_won = (last.post_home_score > last.post_away_score).astype(int)
    d["y"] = d.game_pk.map(home_won)
    return d


def spray_angle(df):
    """Degrees from straight-away center; positive = pulled (flipped for lefties)."""
    ang = np.degrees(np.arctan2(df.hc_x - 125.42, 198.27 - df.hc_y))
    return np.where(df.stand == "L", -ang, ang)


def batted_balls(df):
    b = df[(df.type == "X") & df.launch_speed.notna() & df.launch_angle.notna()
           & (df.woba_denom == 1)].copy()
    b["spray"] = spray_angle(b)
    ev = b.events.fillna("")
    b["cls"] = np.select([ev == c for c in XW_CLASSES[1:]], [1, 2, 3, 4], 0)
    return b


def stuff_frame(df):
    s = df[df.pitch_type.notna() & ~df.pitch_type.isin(["PO", "FA", "EP", "IN", "AB", "UN"])].copy()
    flip = np.where(s.p_throws == "R", -1.0, 1.0)  # catcher-view x -> arm side positive
    s["velo"] = s.release_speed
    s["hb"] = s.pfx_x * 12 * flip          # inches, arm-side positive for both hands
    s["ivb"] = s.pfx_z * 12
    s["spin"] = s.release_spin_rate
    s["ext"] = s.release_extension
    s["rel_x"] = s.release_pos_x * flip
    s["rel_z"] = s.release_pos_z
    # each pitcher's primary fastball (most thrown of FF/SI/FC) is the reference pitch
    fb = s[s.pitch_type.isin(FASTBALLS)]
    prim = fb.groupby(["pitcher", "pitch_type"]).size().reset_index(name="n")
    prim = prim.sort_values("n").groupby("pitcher").tail(1)
    ref = fb.merge(prim[["pitcher", "pitch_type"]], on=["pitcher", "pitch_type"])
    ref = ref.groupby("pitcher")[["velo", "hb", "ivb"]].mean()
    for c in ["velo", "hb", "ivb"]:
        s["d_" + c] = s[c] - s.pitcher.map(ref[c])
    s = s.dropna(subset=["velo", "hb", "ivb", "spin", "delta_run_exp"])
    return s, ref


# ---------------------------------------------------------------- models
def fit_wp(X, y):
    m = HistGradientBoostingClassifier(
        max_iter=400, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=200,
        monotonic_cst=[0, 0, 0, 0, 0, 0, 1, 0, 0], random_state=SEED)
    return m.fit(X, y)


def calib(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    out = []
    for b in range(bins):
        m = idx == b
        if m.sum() >= 50:
            out.append([round(float(p[m].mean()), 3), round(float(y[m].mean()), 3), int(m.sum())])
    return out


def train_wp(df, M):
    reg = df[df.game_type == "R"]
    d = wp_frame(reg)
    X, y, g = d[WP_FEATS].values, d.y.values, d.game_pk.values
    oof = np.zeros(len(d))
    for tr, te in GroupKFold(5).split(X, y, g):
        oof[te] = fit_wp(X[tr], y[tr]).predict_proba(X[te])[:, 1]
    model = fit_wp(X, y)

    post = df[df.game_type != "R"]
    dp = wp_frame(post)
    pp = model.predict_proba(dp[WP_FEATS].values)[:, 1]
    mlb = post.home_win_exp.values
    ok = ~np.isnan(mlb)
    M["wp"] = {
        "train_games": int(reg.game_pk.nunique()), "train_pitches": int(len(d)),
        "cv_brier": round(brier_score_loss(y, oof), 4), "cv_logloss": round(log_loss(y, oof), 4),
        "base_brier": round(brier_score_loss(y, np.full(len(y), y.mean())), 4),
        "post_games": int(post.game_pk.nunique()), "post_pitches": int(ok.sum()),
        "post_brier": round(brier_score_loss(dp.y.values[ok], pp[ok]), 4),
        "post_brier_mlb": round(brier_score_loss(dp.y.values[ok], mlb[ok]), 4),
        "post_brier_base": round(brier_score_loss(dp.y.values[ok], np.full(ok.sum(), 0.5)), 4),
        "calib": calib(y, oof),
    }
    print("win prob", M["wp"])
    return model


def fit_xw(X, y):
    m = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=31,
                                       min_samples_leaf=100, random_state=SEED)
    return m.fit(X, y)


def train_xwoba(df, M):
    b = batted_balls(df[df.game_type == "R"])
    weights = b.groupby("cls").woba_value.mean().reindex(range(5)).fillna(0).values
    tr = b.game_date < "2026-08-01"
    m = fit_xw(b.loc[tr, XW_FEATS].values, b.loc[tr, "cls"].values)
    te = b[~tr]
    pr = m.predict_proba(te[XW_FEATS].values)
    xw = pr @ weights
    sav = te.estimated_woba_using_speedangle.values
    ok = ~np.isnan(sav)
    act = te.woba_value.values
    rmse = lambda a, p: float(np.sqrt(np.mean((a - p) ** 2)))
    # batter level: does xwOBA on contact track actual wOBA on contact?
    t2 = te.assign(xw=xw)
    bat = t2.groupby("batter").agg(n=("xw", "size"), xw=("xw", "mean"), act=("woba_value", "mean"))
    bat = bat[bat.n >= 50]
    M["xwoba"] = {
        "train_bbe": int(tr.sum()), "test_bbe": int(len(te)),
        "weights": dict(zip(XW_CLASSES, [round(float(w), 3) for w in weights])),
        "test_logloss": round(log_loss(te.cls.values, pr, labels=range(5)), 4),
        "test_auc_hit": round(roc_auc_score(te.cls.values > 0, 1 - pr[:, 0]), 4),
        "test_auc_hr": round(roc_auc_score(te.cls.values == 4, pr[:, 4]), 4),
        "test_rmse": round(rmse(act[ok], xw[ok]), 4),
        "test_rmse_savant": round(rmse(act[ok], sav[ok]), 4),
        "batters": int(len(bat)),
        "batter_r": round(float(np.corrcoef(bat.xw, bat.act)[0, 1]), 3),
    }
    print("xwOBA", M["xwoba"])
    return fit_xw(b[XW_FEATS].values, b.cls.values), weights


def fit_st(X, y):
    m = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, max_leaf_nodes=31,
                                      min_samples_leaf=500, random_state=SEED)
    return m.fit(X, y)


def stuff_scale(pred):
    return float(pred.mean()), float(pred.std())


SWINGS = ["swinging_strike", "swinging_strike_blocked", "foul", "foul_tip", "hit_into_play",
          "foul_bunt", "missed_bunt"]
WHIFFS = ["swinging_strike", "swinging_strike_blocked", "foul_tip", "missed_bunt"]


def fit_wh(X, y):
    m = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, min_samples_leaf=300,
                                       random_state=SEED)
    return m.fit(X, y)


def train_stuff(df, M):
    """Stuff+: count-adjusted run value from pitch traits. xWhiff: P(whiff | swing) from traits."""
    reg = df[df.game_type == "R"]
    s, _ = stuff_frame(reg)
    s["swing"] = s.description.isin(SWINGS)
    s["whiff"] = s.description.isin(WHIFFS)
    cnt = s.balls.clip(upper=3).astype(str) + s.strikes.clip(upper=2).astype(str)
    count_mean = s.groupby(cnt).delta_run_exp.mean()
    s["rv"] = s.delta_run_exp - cnt.map(count_mean)
    h1 = s.game_date < "2026-07-01"
    X = s[ST_FEATS].values
    s["pred"] = fit_st(X[h1.values], s.loc[h1, "rv"].values).predict(X)
    sw1 = (h1 & s.swing).values
    s["xwh"] = fit_wh(X[sw1], s.whiff.values[sw1]).predict_proba(X)[:, 1]

    def agg(x):
        return x.groupby(["pitcher", "pitch_type"]).agg(
            n=("pred", "size"), pred=("pred", "mean"), xwh=("xwh", "mean"), rv=("rv", "mean"),
            sw=("swing", "sum"), wh=("whiff", "sum"))
    a, b = agg(s[h1]), agg(s[~h1])
    j = a.join(b, lsuffix="1", rsuffix="2", how="inner")
    j = j[(j.n1 >= 100) & (j.n2 >= 100) & (j.sw1 >= 30) & (j.sw2 >= 30)]
    j["whiff1"], j["whiff2"] = j.wh1 / j.sw1, j.wh2 / j.sw2
    r = lambda a, b: round(float(np.corrcoef(a, b)[0, 1]), 3)
    M["stuff"] = {
        "train_pitches_h1": int(h1.sum()), "pitch_types": int(len(j)),
        "r_stuff_rv2": r(j.pred1, j.rv2), "r_rv1_rv2": r(j.rv1, j.rv2),
        "r_xwhiff_whiff2": r(j.xwh1, j.whiff2), "r_whiff1_whiff2": r(j.whiff1, j.whiff2),
    }
    print("stuff", M["stuff"])
    model = fit_st(X, s.rv.values)
    mu, sd = stuff_scale(model.predict(X))
    whiff = fit_wh(X[s.swing.values], s.whiff.values[s.swing.values])
    return model, mu, sd, whiff


# ---------------------------------------------------------------- profiles
def pitcher_profiles(df, xw_model, weights, M):
    """Season xwOBA allowed (shrunk to league), times-through-order penalty, fastball velo."""
    reg = df[df.game_type == "R"]
    pa = reg[reg.woba_denom == 1].copy()
    pa["xw"] = pa.woba_value
    bb = (pa.type == "X") & pa.launch_speed.notna() & pa.launch_angle.notna()
    pa.loc[bb, "spray"] = spray_angle(pa[bb])
    pa.loc[bb, "xw"] = xw_model.predict_proba(pa.loc[bb, XW_FEATS].values) @ weights
    lg = float(pa.xw.mean())
    PRIOR = 200
    g = pa.groupby("pitcher").xw.agg(["sum", "size"])
    prof = pd.DataFrame({"n_pa": g["size"], "xwoba": (g["sum"] + lg * PRIOR) / (g["size"] + PRIOR)})
    # TTO penalty: same pitcher, same game, later trips through the order (starters only)
    tto = pa[pa.n_thruorder_pitcher.between(1, 4)]
    base = tto[tto.n_thruorder_pitcher == 1].groupby("pitcher").xw.mean()
    pen = {}
    for k in (2, 3, 4):
        t = tto[tto.n_thruorder_pitcher == k]
        d = t.xw - t.pitcher.map(base)
        pen[k] = round(float(d.mean()), 4) if len(d.dropna()) else 0.0
    pen[1] = 0.0
    # every pitch's velo vs that pitcher's season average for the type (fatigue check)
    velo = reg.groupby(["pitcher", "pitch_type"]).release_speed.mean()
    M["profiles"] = {"lg_xwoba": round(lg, 4), "prior_pa": PRIOR, "tto_penalty": pen,
                     "pitchers": int(len(prof))}
    print("profiles", M["profiles"])
    return prof, pen, lg, velo


def main():
    df = load()
    print(len(df), "pitches", df.game_pk.nunique(), "games")
    M = {}
    wp = train_wp(df, M)
    xw, weights = train_xwoba(df, M)
    st, mu, sd, wh = train_stuff(df, M)
    prof, pen, lg, velo = pitcher_profiles(df, xw, weights, M)
    _, fbref = stuff_frame(df[df.game_type == "R"])
    joblib.dump({"wp": wp, "xw": xw, "xw_weights": weights, "stuff": st, "stuff_mu": mu,
                 "stuff_sd": sd, "whiff": wh, "profiles": prof, "tto": pen, "lg_xwoba": lg, "velo": velo,
                 "fbref": fbref}, RAW / "models.joblib")
    OUT_JS.parent.mkdir(parents=True, exist_ok=True)
    OUT_JS.write_text("window.RS_MLB_MODELS=" + json.dumps(M, separators=(",", ":")) + ";\n")
    print("wrote", OUT_JS)


if __name__ == "__main__":
    main()
