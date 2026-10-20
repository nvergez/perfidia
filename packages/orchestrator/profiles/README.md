# Calibration profiles

`perfidia-profile/1` files (`@perfidia/protocol` `TokenProfileSchema`), one per key: provider,
model, endpoint, effort, prompt variant, reminder cadence, `maxTokens`, `PROMPT_VERSION` and
ruleset major. `arena estimate` and `arena run` read this directory by default (`--profiles <dir>`
reads another, `--profiles off` none) and predict a lockstep seat whose key has a profile from it:

- 1–2 seat-days: `measured-point` (phase 2's projection of the measured spend, re-priced; no
  percentiles);
- 3 or more: `calibrated` (a seeded bootstrap of 2,000 replicates; p10 / p50 / p90).

Other seats keep the `scenario`. The source is printed per seat and stored in `estimate.json`
(and `arena.json` `budget.estimate.source`).

Build or extend them from real runs (a run measured again replaces its seat-days):

```
bun run arena -- calibrate runs/budget-mix-cal runs/growth-7d
```

Only real lockstep runs that ended, or stopped at a day boundary (`--stop-after`), with Level E ok
give seat-days, each seat until its hand-off. A `--fake` run gives only the briefing growth, and
only when it played at least 7 game days with its transcripts (`--transcripts full`, the default):

```
bun run arena -- run --fake --lineup budget-mix --seed 1 --id-key seed --out runs/growth-7d
```

This directory holds no profile until the owner's first calibration. Committing one changes the
default predictions of `arena estimate` and `arena run` for its key.
