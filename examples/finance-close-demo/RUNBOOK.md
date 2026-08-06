# Finance-close demo: an agent traces a reconciliation mismatch to root cause

**The pitch (one sentence):** month-end close shows the dashboard $50M higher
than the certified datamart; an agent using qseow-mcp walks KPI → object →
sheet → app → script → source and finds the double-loaded adjustment batch —
live, in under 10 minutes.

**State machine:** `setup.mjs` (idempotent, ends tied-out) → `plant.mjs`
(mismatch live) → *the trace* → `reset.mjs` (tied-out again). Re-runnable
forever; every value is deterministic to the cent.

| State | Dashboard KPI | Datamart truth |
|---|---|---|
| clean | $605,728,164.79 | $605,728,164.79 |
| planted | **$655,728,164.79** | $605,728,164.79 |

## Prerequisites

- qseow-mcp ≥ 0.3.0 registered with the MCP client, certificate mode,
  `QSEOW_ALLOW_MUTATIONS=true` (the fix step needs `set_script`/`reload_app`).
- `node setup.mjs` once, `node plant.mjs` before each run (same env as the server).
- App ids print at setup; the agent needs neither — it discovers them.

## The trace (agent turn by turn; ~8 min with narration, timed 2026-08-06)

Open with the business frame: *"Close review says revenue is $655.7M. The
certified datamart says $605.7M. Fifty million dollars of daylight, and the
month can't close until someone explains it."* Then hand the agent one
prompt: **"The Finance Close dashboard disagrees with the datamart by $50M.
Find the root cause."**

What a competent agent does with the tool surface (each step is one tool call
— show the calls on screen):

1. **`list_apps`** filter `name sw 'AT Finance Close'` → finds both apps. *(~10s)*
2. **`evaluate_master_measure`** on the dashboard, title `Revenue Q1 (Actual)`
   → **655,728,164.79**, and the governed expression comes back with it. *(~15s)*
3. **`evaluate_expression`** of that same expression against the **datamart**
   → **605,728,164.79**. Mismatch confirmed, definition identical — so the
   *definition* isn't the problem; the *data* is. *(~15s)*
4. **`create_hypercube`** on both apps: `DocType` × `Sum(Amount)` →
   datamart: Normalized 555.7M / Adjustment 50.0M;
   dashboard: Normalized 555.7M / **Adjustment 100.0M**. The delta is
   isolated to the adjustment slice. *(~30s)*
5. **`search_expressions`** (`term: "Revenue"`) on the dashboard → the KPI
   object on sheet "Close Review" + the master measure — the full UI-to-
   definition chain, annotated with the owning sheet. *(~20s)*
6. **`get_app_lineage`** on the dashboard → `revenue_close.qvd` appears
   **twice** as a source. Same QVD, two loads. *(~15s)*
7. **`get_script`** on the dashboard → the planted block, in plain sight:
   a `CONCATENATE ... WHERE DocType = 'Adjustment'` re-load commented as a
   *"late adjustment batch from close night — merged manually"*. Root cause:
   **the adjustment batch was loaded twice.** *(~30s)*
8. **The fix, live:** `set_script` (remove the duplicate block) →
   `reload_app` → `evaluate_master_measure` → **605,728,164.79. Tied out.**
   *(~60s)*

Close: *"No screen-sharing with three teams, no week of archaeology. The
agent walked the same path a senior support engineer walks — KPI, object,
sheet, definition, lineage, script, source — and it did it in minutes,
against a governed estate, with every step auditable."*

## Timing notes (for the video cut)

- Steps 1–7 are read-only: run them with mutations off if you want to show
  the read-only tool surface in `tools/list` first.
- Budget: ≤10 min total including narration; the tool calls themselves total
  ~3 min. Rehearse the hypercube step — it's the "aha" beat.
- After the fix step the box is in the CLEAN state; run `plant.mjs` to reset
  the demo (or `reset.mjs` if a run went sideways).

## Adapting to a real estate

Point the same trace at any QSEoW site: the loop (evaluate → compare →
hypercube-isolate → search → lineage → script) is estate-agnostic. On
published apps, script/lineage are hidden from user identities —
`copy_app` and trace the copy (see README "Published-app caveat").
