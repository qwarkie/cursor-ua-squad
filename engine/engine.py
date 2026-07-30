"""
True Take-Home engine for the daily-earnings budgeting app.

Computes, per worker, what a day's pay is REALLY worth after netting out
the recurring essential bills (rent/utilities/phone) that day's work is
quietly paying down, plus any earned-wage-advance (EWA) fees taken that day.

Data model (from data/*.csv):
  daily_earnings.csv        one row per worker per day actually worked
  recurring_obligations.csv fixed monthly/biweekly bills per worker (essential flag)
  earned_wage_advances.csv  EWA requests: amount_cad + fee_cad, requested_at
  workers.csv               worker profile (not required for the engine math)

Core idea ("True Take-Home"):
    daily_essential_reserve  = sum(essential obligations, normalized to $/day)
    ewa_fee_today            = sum(fee_cad for advances requested that date)
    true_take_home           = net_pay_cad - daily_essential_reserve - ewa_fee_today

Everything else (weather widget, "can I afford this?", micro-goals) is a
read on top of this one series — no separate math, no separate data source.

Usage:
    python3 engine.py build  --worker W-0001 [--out out.json]
    python3 engine.py build  --all [--outdir ../precomputed]
    python3 engine.py afford --worker W-0001 --amount 45
    python3 engine.py weather --worker W-0001
    python3 engine.py goal   --worker W-0001 --target 450 --saved 120 [--alloc-pct 20]

Stdlib only. Tested against Python 3.9.
"""
import argparse
import csv
import json
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta

DATA_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data"))

DAYS_PER_MONTH = 30.44  # average month length, avoids calendar-length bias
DAYS_PER_BIWEEK = 14.0


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def _read_csv(name):
    path = os.path.join(DATA_DIR, name)
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def load_all():
    return {
        "daily_earnings": _read_csv("daily_earnings.csv"),
        "recurring_obligations": _read_csv("recurring_obligations.csv"),
        "earned_wage_advances": _read_csv("earned_wage_advances.csv"),
        "workers": _read_csv("workers.csv"),
    }


def _parse_date(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def _parse_ts_date(s):
    # requested_at / repaid_at look like "2026-05-13T23:57:00"
    return datetime.strptime(s.split("T")[0], "%Y-%m-%d").date()


# ---------------------------------------------------------------------------
# Core engine
# ---------------------------------------------------------------------------

def daily_essential_reserve(obligations, worker_id):
    """$/day rate of this worker's ESSENTIAL recurring bills only."""
    total = 0.0
    for o in obligations:
        if o["worker_id"] != worker_id:
            continue
        if o["essential"] != "1":
            continue
        amount = float(o["amount_cad"])
        freq = o["frequency"]
        if freq == "monthly":
            total += amount / DAYS_PER_MONTH
        elif freq == "biweekly":
            total += amount / DAYS_PER_BIWEEK
        else:
            raise ValueError("unrecognized frequency: %r" % freq)
    return round(total, 4)


def ewa_fees_by_date(advances, worker_id):
    """{date: total fee_cad} for advances requested by this worker on that date.
    Fee is charged at request time regardless of repayment status."""
    fees = defaultdict(float)
    for a in advances:
        if a["worker_id"] != worker_id:
            continue
        d = _parse_ts_date(a["requested_at"])
        fees[d] += float(a["fee_cad"])
    return fees


def build_worker_series(data, worker_id):
    """Returns a list of daily dicts, chronological, one per row in
    daily_earnings.csv for this worker, enriched with true take-home,
    rolling averages, and cumulative surplus."""
    earnings = [r for r in data["daily_earnings"] if r["worker_id"] == worker_id]
    if not earnings:
        raise ValueError("no daily_earnings rows for worker_id=%r" % worker_id)
    earnings.sort(key=lambda r: r["work_date"])

    reserve = daily_essential_reserve(data["recurring_obligations"], worker_id)
    fees_by_date = ewa_fees_by_date(data["earned_wage_advances"], worker_id)

    series = []
    cum_true_take_home = 0.0
    window = []  # true_take_home values for trailing rolling calcs (calendar-aware)

    for r in earnings:
        d = _parse_date(r["work_date"])
        gross = float(r["gross_pay_cad"])
        net = float(r["net_pay_cad"])
        tips = float(r["tips_cad"])
        fee_today = round(fees_by_date.get(d, 0.0), 2)

        true_take_home = round(net - reserve - fee_today, 2)
        cum_true_take_home = round(cum_true_take_home + true_take_home, 2)

        window.append((d, true_take_home))
        # trailing 7 calendar days (inclusive of today)
        cutoff7 = d - timedelta(days=6)
        last7 = [v for (dd, v) in window if dd >= cutoff7]
        cutoff_prev7 = d - timedelta(days=13)
        prev7 = [v for (dd, v) in window if cutoff_prev7 <= dd < cutoff7]

        row = {
            "date": r["work_date"],
            "shift_type": r["shift_type"],
            "hours_worked": float(r["hours_worked"]),
            "gross_pay_cad": gross,
            "tips_cad": tips,
            "net_pay_cad": net,
            "essential_reserve_cad": reserve,
            "ewa_fee_cad": fee_today,
            "true_take_home_cad": true_take_home,
            "cum_true_take_home_cad": cum_true_take_home,
            "rolling7_sum_cad": round(sum(last7), 2),
            "rolling7_avg_cad": round(sum(last7) / len(last7), 2) if last7 else None,
            "prev7_sum_cad": round(sum(prev7), 2) if prev7 else None,
        }
        series.append(row)

    return {
        "worker_id": worker_id,
        "daily_essential_reserve_cad": reserve,
        "series": series,
    }


# ---------------------------------------------------------------------------
# Feature 1: weather widget
# ---------------------------------------------------------------------------

def compute_weather(built):
    """Buckets the LATEST point in the series into a 5-state weather read.

    Thresholds are relative to THIS worker's own weekly essential-bill
    burden (essential_reserve_cad * 7), not a flat dollar cutoff — a
    moving helper and a rideshare driver have very different pay scales,
    so "how many weeks of your own rent/utilities/phone does your
    trailing surplus cover" is the meaningful, worker-relative signal.
    Deterministic thresholds -> unit-testable.
    """
    series = built["series"]
    if not series:
        return {"state": "unknown", "reason": "no data"}

    latest = series[-1]
    last7 = latest["rolling7_sum_cad"]
    prev7 = latest["prev7_sum_cad"]
    trend_up = (prev7 is not None) and (last7 > prev7)

    weekly_essentials = built["daily_essential_reserve_cad"] * 7
    # ratio > 1 means the trailing surplus fully covers another week of
    # this worker's own essential bills; ratio <= 0 means the true
    # take-home has run this week's essentials into deficit already.
    ratio = (last7 / weekly_essentials) if weekly_essentials else float("inf")

    has_recent_advance_fee = any(
        row.get("ewa_fee_cad", 0) for row in series[-3:]
    )  # cheap proxy: EWA fee activity in the last 3 worked days

    if ratio <= 0:
        state = "storm" if has_recent_advance_fee else "rainy"
        reason = ("true take-home is running a %.0f CAD deficit against essentials this week"
                  % (-last7))
    elif ratio < 0.5:
        state = "overcast"
        reason = ("surplus covers only %.0f%% of a week's essential bills (%.0f CAD/7d)"
                  % (ratio * 100, last7))
    elif trend_up:
        state = "sunny"
        reason = ("surplus covers %.1fx a week's essentials (%.0f CAD/7d) and is improving"
                  % (ratio, last7))
    else:
        state = "partly_cloudy"
        reason = ("surplus covers %.1fx a week's essentials (%.0f CAD/7d) but is flat or softening"
                  % (ratio, last7))

    return {
        "state": state,
        "as_of": latest["date"],
        "rolling7_sum_cad": last7,
        "prev7_sum_cad": prev7,
        "weekly_essentials_cad": round(weekly_essentials, 2),
        "surplus_to_essentials_ratio": round(ratio, 2) if ratio != float("inf") else None,
        "reason": reason,
    }


# ---------------------------------------------------------------------------
# Feature 2: "Can I afford this?"
# ---------------------------------------------------------------------------

def _trailing_avg_true_take_home(series, n=14):
    tail = series[-n:] if len(series) >= 1 else []
    vals = [row["true_take_home_cad"] for row in tail]
    return round(sum(vals) / len(vals), 2) if vals else 0.0


def _phrase_for_days(cost_days):
    if cost_days < 0.15:
        return "pocket change"
    if cost_days < 0.5:
        return "about half a slow day"
    if cost_days < 1.0:
        return "almost a full day's work"
    if cost_days < 2.0:
        return "more than a full day's work"
    return "%.1f days of work" % cost_days


def compute_afford(built, amount, lookback_days=14):
    series = built["series"]
    avg_daily = _trailing_avg_true_take_home(series, n=lookback_days)
    latest = series[-1] if series else None
    buffer_available = latest["rolling7_sum_cad"] if latest else 0.0

    if avg_daily <= 0:
        cost_days = None
        phrase = "your recent take-home is at or below zero — this isn't affordable right now"
    else:
        cost_days = round(amount / avg_daily, 2)
        phrase = _phrase_for_days(cost_days)

    can_afford = buffer_available >= amount

    return {
        "amount_cad": amount,
        "avg_daily_true_take_home_cad": avg_daily,
        "lookback_days": lookback_days,
        "cost_in_days_worked": cost_days,
        "trade_off": "%.2f CAD = %s" % (amount, phrase),
        "current_7d_buffer_cad": buffer_available,
        "can_afford_now": can_afford,
    }


# ---------------------------------------------------------------------------
# Feature 3: micro-goals
# ---------------------------------------------------------------------------

def compute_goal(built, target_amount, saved_amount, alloc_pct=20, lookback_days=14):
    series = built["series"]
    avg_daily_surplus = _trailing_avg_true_take_home(series, n=lookback_days)
    remaining = round(target_amount - saved_amount, 2)
    daily_contribution = round(max(avg_daily_surplus, 0) * (alloc_pct / 100.0), 2)

    if remaining <= 0:
        days_to_goal = 0
    elif daily_contribution <= 0:
        days_to_goal = None  # unreachable at current pace
    else:
        days_to_goal = int((remaining + daily_contribution - 0.01) // daily_contribution) + 1

    latest_true_take_home = series[-1]["true_take_home_cad"] if series else 0.0
    todays_contribution = round(max(latest_true_take_home, 0) * (alloc_pct / 100.0), 2)

    return {
        "target_amount_cad": target_amount,
        "saved_amount_cad": saved_amount,
        "remaining_cad": remaining,
        "alloc_pct": alloc_pct,
        "avg_daily_surplus_cad": avg_daily_surplus,
        "daily_contribution_at_pace_cad": daily_contribution,
        "days_to_goal_at_current_pace": days_to_goal,
        "todays_contribution_cad": todays_contribution,
        "todays_feedback": "$%.2f -> %s closer to your goal" % (
            todays_contribution,
            ("%d days" % days_to_goal) if days_to_goal else "goal reached" if remaining <= 0 else "keep going",
        ),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="build the true-take-home series for one worker or all")
    b.add_argument("--worker", help="worker_id, e.g. W-0001")
    b.add_argument("--all", action="store_true", help="build for every worker in workers.csv")
    b.add_argument("--out", help="output json path (single worker mode)")
    b.add_argument("--outdir", default=os.path.join(os.path.dirname(__file__), "precomputed"),
                   help="output dir for --all mode")

    a = sub.add_parser("afford", help="'Can I afford this?' check for one worker")
    a.add_argument("--worker", required=True)
    a.add_argument("--amount", required=True, type=float)
    a.add_argument("--lookback-days", type=int, default=14)

    w = sub.add_parser("weather", help="financial weather widget state for one worker")
    w.add_argument("--worker", required=True)

    g = sub.add_parser("goal", help="micro-goal progress for one worker")
    g.add_argument("--worker", required=True)
    g.add_argument("--target", required=True, type=float)
    g.add_argument("--saved", required=True, type=float)
    g.add_argument("--alloc-pct", type=float, default=20)
    g.add_argument("--lookback-days", type=int, default=14)

    args = p.parse_args()
    data = load_all()

    if args.cmd == "build":
        if args.all:
            os.makedirs(args.outdir, exist_ok=True)
            worker_ids = sorted({r["worker_id"] for r in data["daily_earnings"]})
            written = 0
            for wid in worker_ids:
                try:
                    built = build_worker_series(data, wid)
                except ValueError:
                    continue
                out_path = os.path.join(args.outdir, "%s.json" % wid)
                with open(out_path, "w") as f:
                    json.dump(built, f, indent=2)
                written += 1
            print("wrote %d worker files to %s" % (written, args.outdir))
        else:
            if not args.worker:
                p.error("--worker or --all is required")
            built = build_worker_series(data, args.worker)
            out = json.dumps(built, indent=2)
            if args.out:
                with open(args.out, "w") as f:
                    f.write(out)
                print("wrote %s" % args.out)
            else:
                print(out)

    elif args.cmd == "afford":
        built = build_worker_series(data, args.worker)
        result = compute_afford(built, args.amount, lookback_days=args.lookback_days)
        print(json.dumps(result, indent=2))

    elif args.cmd == "weather":
        built = build_worker_series(data, args.worker)
        result = compute_weather(built)
        print(json.dumps(result, indent=2))

    elif args.cmd == "goal":
        built = build_worker_series(data, args.worker)
        result = compute_goal(built, args.target, args.saved, alloc_pct=args.alloc_pct,
                               lookback_days=args.lookback_days)
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    sys.exit(main())
