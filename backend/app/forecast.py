"""How likely the station is to run out, and when.

`days_of_cover` answers "at today's rate, how long". It is the right figure
to put on a dashboard and it is silent about the thing a commander actually
has to decide: whether to wait for the tanker window or act now. Thirty days
of cover at a steady rate and thirty days at a rate that swings by a factor
of four are different propositions, and the deterministic number cannot tell
them apart.

This adds the spread, without becoming a black box:

* **The distribution is the station's own history.** Daily consumption is
  resampled from the days actually observed — a bootstrap, not a fitted
  curve. There is no assumption that burn is normal, Poisson or anything
  else, and nothing is learned from another station or another season.
* **It refuses when it cannot see enough.** Two draws in a week is not a
  distribution. The gate is the same discipline the observed rate uses: say
  "not enough history" rather than produce a confident-looking figure from
  three numbers.
* **The deterministic answer is unchanged and still primary.** This sits
  beside `days_of_cover`, never in place of it. A probability is worth
  having precisely because an operator can compare it with the straight-line
  figure and see how much room the estimate has.
"""

import random

# Enough distinct days that resampling them means something. Below this the
# "distribution" is a handful of points and the percentiles it produces are
# an artefact of which days happened to be observed.
MIN_OBSERVED_DAYS = 5

# Trials per forecast. Large enough that P50/P90 are stable to about a day,
# small enough to run inside a request on a station laptop.
TRIALS = 400

# Do not project further than this. Past it the answer is "plenty" rather
# than a date, and a 400-day figure invites a precision nobody should read
# into it.
HORIZON_DAYS = 180


def _percentile(sorted_values: list[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    index = min(len(sorted_values) - 1, max(0, int(round(fraction * (len(sorted_values) - 1)))))
    return sorted_values[index]


def stockout_forecast(*, quantity: float, daily_consumption: dict[str, float],
                      multiplier: float = 1.0, trials: int = TRIALS,
                      horizon_days: int = HORIZON_DAYS, seed: int = None) -> dict | None:
    """When this row runs out, as a distribution rather than a single date.

    `daily_consumption` is {day: amount} from the station's own log.
    `multiplier` scales every sampled day by the conditions the *forecast*
    runs under — the blizzard load and the crew on station — so the forecast
    answers "at the weather we have now", not "at the weather we happened to
    have while the history was being recorded".

    Returns None when there is too little history. The caller shows the
    deterministic figure alone rather than a fabricated band.
    """
    days = [amount for amount in daily_consumption.values() if amount > 0]
    if len(days) < MIN_OBSERVED_DAYS:
        return {
            'available': False,
            'observed_days': len(days),
            'reason': f'only {len(days)} day(s) of recorded consumption — at least '
                      f'{MIN_OBSERVED_DAYS} are needed before a spread means anything',
        }

    # Seeded so the same station state gives the same answer twice. An
    # operator who refreshes and sees P90 move by four days has learned to
    # distrust the number, and rightly.
    rng = random.Random(seed if seed is not None else _stable_seed(quantity, days))

    exhausted_on: list[float] = []
    survived = 0
    for _ in range(trials):
        remaining = quantity
        for day in range(1, horizon_days + 1):
            remaining -= rng.choice(days) * multiplier
            if remaining <= 0:
                exhausted_on.append(day)
                break
        else:
            survived += 1

    exhausted_on.sort()
    # P50 is the day by which half the trials had run out; P90 the day by
    # which nine in ten had. Reported this way round because the question is
    # "how soon could this bite", not "how long might it last".
    p50 = _percentile(exhausted_on, 0.5) if exhausted_on else None
    p10 = _percentile(exhausted_on, 0.1) if exhausted_on else None

    return {
        'available': True,
        'observed_days': len(days),
        'trials': trials,
        'horizon_days': horizon_days,
        # The soonest realistic date, and the middle one. p10 is the planning
        # figure: it is the bad case that is not an outlier.
        'p10_days': p10,
        'p50_days': p50,
        'survived_horizon_pct': round(100 * survived / trials, 1),
        'mean_daily': round(sum(days) / len(days) * multiplier, 2),
        'spread': _spread(days, multiplier),
        'reason': None,
    }


def probability_lasts(forecast_input: dict, *, until_days: float) -> float | None:
    """Chance the row is still holding at `until_days`.

    The question an operator actually asks is not "when does it run out" but
    "does it reach the next tanker window", and that is this.
    """
    days = [amount for amount in forecast_input.get('daily_consumption', {}).values()
            if amount > 0]
    if len(days) < MIN_OBSERVED_DAYS or until_days <= 0:
        return None
    quantity = forecast_input['quantity']
    multiplier = forecast_input.get('multiplier', 1.0)
    trials = forecast_input.get('trials', TRIALS)
    rng = random.Random(_stable_seed(quantity, days))

    survived = 0
    for _ in range(trials):
        remaining = quantity
        for _day in range(int(until_days)):
            remaining -= rng.choice(days) * multiplier
            if remaining <= 0:
                break
        else:
            survived += 1
    return round(100 * survived / trials, 1)


def _spread(days: list[float], multiplier: float) -> dict:
    """Low, middle and high observed days, so the band can be read without
    a statistics background."""
    ordered = sorted(amount * multiplier for amount in days)
    return {
        'low': round(_percentile(ordered, 0.1), 2),
        'median': round(_percentile(ordered, 0.5), 2),
        'high': round(_percentile(ordered, 0.9), 2),
    }


def _stable_seed(quantity: float, days: list[float]) -> int:
    """A seed derived from the inputs, so the same station state forecasts
    the same way every time it is asked."""
    return hash((round(quantity, 3), tuple(sorted(round(d, 3) for d in days)))) & 0xFFFFFFFF
