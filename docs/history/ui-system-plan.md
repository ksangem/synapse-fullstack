# Synapse UI System Plan — Buttons, Cards, Motion

**Date:** 2026-07-23 · **Scope:** `packages/frontend`
**Status (2026-07-24): ALL PHASES 0-6 APPLIED**, plus the audit's Week-2 colour fix.
Class-less `<button>` count: **52 → 0**. Sub-24px tap targets app-wide: **0**.

> ### Applied so far
> · Motion tokens (`--dur-*`, `--ease-*`, `--t-interactive`), elevation scale (`--elev-0..4`,
>   with `--shadow-sm/md` aliased so 13 existing usages inherit it), z-layer scale (`--z-*`).
> · **`transition: all` 30 → 0.** All state transitions now use `--t-interactive`, which lists only
>   compositor-friendly + colour properties.
> · **`:active` press states 0 → 14 rules**, covering the whole control family: `scale(.97)` for
>   standard controls, `.92` for small round ones, `translateY(-1px) scale(.995)` for cards,
>   colour-only for links. Release eases with `--ease-spring`.
> · **One global `prefers-reduced-motion` guard** replaces the single component-scoped block —
>   it also stops the four infinite loops (`animation-iteration-count:1`).
> · Help panel slides on `transform` instead of `right` (it is `position:fixed`, so the 420px panel
>   no longer relayouts every frame). Sidebar + detail pane keep `width` — those are genuine layout
>   animations — but retimed onto tokens.
> · Verified in-browser: tokens resolve, press transform applies and returns, panels still open/close,
>   reduced-motion collapses transitions to 0.01ms and stops the loops.
>
> ### Card system (Phase 3 + 4) — applied
> · `components/ui/Card.jsx` (+ `CardSkeleton` / `CardEmpty` / `CardError`) and `.ucard*` CSS.
>   The base owns anatomy, focus/keyboard, selection, disabled and the status rail; pages compose slots.
> · Rolled onto: Registry cards (refactored, `.int-card` chrome retired), **Dashboard health tiles**
>   (`.adapter-tile` retired — they now show real last-run health instead of a config-state dot that
>   read identical for all 22), and the **Wizard system pickers** (were `<div onClick>`: unfocusable,
>   keyboard-inoperable, and signalled selection with `borderWidth:2`, reflowing the grid).
> · New states: `selected` (inset ring, zero layout shift), `disabled`, empty, error, card-shaped skeleton.
> · **New capability:** Registry card selection + a bulk Pause/Resume bar, using the `bulkConnected`
>   API that already existed but had no UI on that page.
> · `.ucard-grid` bakes in `grid-auto-rows:min-content` — required, not cosmetic, inside a fixed-height
>   scroll region (see the landmine note in the audit doc).
> · Verified: 24 cards no clipping, health split 13/1/10, selection causes zero layout shift, cards are
>   `role=button tabindex=0`, blocked pickers are non-focusable, keyboard Enter selects, dark theme clean.
**Companion doc:** `ui-audit-2026-07-23.md` (Week 1 applied; colour/type/token/a11y tiers still open)

---

## The principle this plan is built on

At enterprise scale, motion and component variety are **not decoration — they are feedback**.
Every animation must answer one of four questions the user is actually asking:

1. *Did my click register?* (press/feedback)
2. *Where did that come from / go?* (continuity)
3. *Is something still happening?* (progress)
4. *What just changed without me doing it?* (attention)

Anything that doesn't answer one of those is cost: frame budget, vestibular risk, and a slower-feeling
app. Synapse already has **four infinite loops** running (`.status-dot.red`, `.pulse-dot`,
`.pulse-indicator`, `.adapter-tile.error`) with only one `prefers-reduced-motion` block in the whole
stylesheet. "Industrial scale" here means **more system, less spectacle** — a small vocabulary applied
consistently everywhere, not more movement.

---

## Measured starting point

| Area | Today |
|---|---|
| Button class names | **22** distinct, of which only `.btn` + 4 variants + 2 sizes form a family |
| `<button>` with **no** class (ad-hoc inline styles) | **86** of 224 (38%) |
| **`:active` / pressed states in the entire stylesheet** | **0** |
| `:disabled` rules | 5 |
| Loading-button pattern | hand-rolled in 9 files (`{busy ? 'Saving…' : 'Save'}`), no shared component |
| `aria-busy` / `aria-live` | **0** / **0** — a working button announces nothing |
| Card variants | **8** (`card`, `kpi-card`, `adapter-tile`, `connector-card`, `entity-card`, `int-card`, `viz-card`, `.card` as generic box ×46) |
| Elevation tokens | **2** (`--shadow-sm/md`) + **10** one-off `box-shadow` values |
| `@keyframes` | 6 — and 4 of them are infinite loops |
| Transition durations | **7** different values; `--transition` exists but `.3s`, `.25s`, `.4s`, `.18s`, `.15s` bypass it |
| **`transition: all`** | **30 uses** — animates layout properties, causes jank |
| `transition: width/height/right` (layout-thrashing) | 5 |
| `prefers-reduced-motion` blocks | **1** (added with the registry cards) |

The gap isn't "we need more animation." It's that **there is no system**, so every new screen invents
its own button, its own card, and its own timing.

---

## Part 0 — Foundations (do this first; everything else depends on it)

Without these tokens, Parts 1–3 just add more one-offs.

```css
:root{
  /* Motion — duration by distance/complexity, not by taste */
  --dur-instant: 80ms;    /* colour/opacity swap: hover, focus ring       */
  --dur-fast:   140ms;    /* press, toggle, small reveal                  */
  --dur-base:   220ms;    /* panel/menu open, expand, tab change          */
  --dur-slow:   320ms;    /* drawer, detail pane, route transition        */
  --dur-deliberate: 480ms;/* first-load choreography only                 */

  /* Easing — entrances decelerate, exits accelerate, moves do both */
  --ease-out:   cubic-bezier(.16,.84,.44,1);    /* enters, expands        */
  --ease-in:    cubic-bezier(.55,0,.85,.35);    /* exits, collapses       */
  --ease-inout: cubic-bezier(.65,0,.35,1);      /* moves between states   */
  --ease-spring:cubic-bezier(.34,1.4,.64,1);    /* press release ONLY     */

  /* Elevation — a real scale, replacing 10 one-off shadows */
  --elev-0: none;
  --elev-1: 0 1px 2px rgba(15,23,42,.06), 0 1px 3px rgba(15,23,42,.08);
  --elev-2: 0 2px 4px rgba(15,23,42,.06), 0 4px 12px rgba(15,23,42,.08);
  --elev-3: 0 8px 16px rgba(15,23,42,.08), 0 16px 32px rgba(15,23,42,.10);
  --elev-4: 0 16px 32px rgba(15,23,42,.12), 0 32px 64px rgba(15,23,42,.14);

  /* Z-layers — replaces 15 raw z-index values */
  --z-base:0; --z-sticky:100; --z-drawer:200; --z-dropdown:300;
  --z-overlay:400; --z-modal:500; --z-toast:600; --z-tooltip:700;
}
```

**Global motion guard — one block, app-wide.** This is non-negotiable before adding any motion:

```css
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{
    animation-duration:.01ms !important; animation-iteration-count:1 !important;
    transition-duration:.01ms !important; scroll-behavior:auto !important;
  }
}
```

**Also in Part 0:** replace all 30 `transition: all` with explicit property lists. `all` animates
layout properties (width, padding, font-size) on the main thread and is the single biggest source of
jank in the app. Only `transform`, `opacity`, `filter` and `background-color` should ever be animated.

**Effort:** ~1 day. **Risk:** low. **Unblocks:** everything below.

---

## Part 1 — The button system

### 1.1 The matrix

Today's `.btn` family covers 5 variants × 2 sizes × 2 states. The industrial version is
**7 variants × 4 sizes × 6 states**, plus 6 composite types.

| Variant | Use | Notes |
|---|---|---|
| `primary` | the one committing action per view | max **one** per screen region |
| `secondary` | equal-weight alternatives | today's `btn-outline` |
| `ghost` | tertiary / in-table row actions | today's `btn-ghost` |
| `danger` | destructive | must pair with confirm-on-press (§1.4) |
| `success` | confirm/apply in wizards | ⚠ `#22c55e` fails contrast — needs the Week-2 colour fix first |
| `link` | inline navigation | today's `.link-btn` |
| `subtle` | selected/toggled state background | new — needed for toolbars & segmented groups |

| Size | Height | Use |
|---|---|---|
| `xs` | 24px | table row actions, chips (**meets the WCAG 2.5.8 24px floor — today's `.btn-ghost` is 22px**) |
| `sm` | 28px | toolbars, card actions |
| `md` | 36px | default, forms |
| `lg` | 44px | primary CTA, login |

**States — all six, for every variant:**

| State | Spec | Status today |
|---|---|---|
| rest | — | ✅ |
| hover | bg step + `--elev-1`, `--dur-instant` | ✅ partial |
| **press (`:active`)** | `transform: scale(.97)`, `--dur-fast`, `--ease-spring` on release | ❌ **0 in codebase** |
| focus-visible | 2px ring, 2px offset | ✅ global |
| disabled | 40% opacity + `cursor:not-allowed` + `aria-disabled` | ⚠ 5 rules only |
| **loading** | inline spinner, label held, width locked, `aria-busy` | ❌ hand-rolled in 9 files |

### 1.2 The missing composite types

These don't exist at all today and each has a concrete home in Synapse:

| Type | Where it's needed now |
|---|---|
| **Loading button** | Wizard "Test connection", Registry "Run", Vault "Rotate", DLQ "Replay all", Login "Sign in" — all currently hand-rolled |
| **Icon-only button** | table row actions, card overflow menus (needs mandatory `aria-label` + tooltip) |
| **Split button** | Registry "Run ▾" (Run now / Run with date range / Dry run) |
| **Toggle button** | Monitor "Real-time" (today a checkbox with the box on the *wrong side* vs `.check-item`) |
| **Button group** | Monitor Network/DLQ, Dashboard time range — today `.seg-toggle`, inconsistent with `.chip` filters |
| **Destructive-confirm** | delete actions — press-and-hold or two-step inline, replacing a modal round-trip |

### 1.3 Motion for buttons

| Moment | Spec |
|---|---|
| hover in | `background` + `box-shadow`, `--dur-instant`, `--ease-out` |
| press down | `scale(.97)`, `--dur-fast` |
| press release | `scale(1)`, `--ease-spring` — the "alive" feeling, ~1 line of CSS |
| → loading | label crossfades to spinner, **width locked** so the row doesn't reflow |
| → success | brief ✓ swap for 900ms, then back (only for actions with no other feedback) |
| disabled → enabled | opacity `--dur-base`; never animate the reverse (it reads as a bug) |

### 1.4 Deliverable

`components/ui/Button.jsx` + `.btn-*` CSS rewrite. Migrate the **86 class-less buttons** onto it.
That migration is where most of the effort is — and where the biggest consistency win comes from.

**Effort:** 2 days build + 2 days migration. **Risk:** medium (touches every page).

---

## Part 2 — The card system

Eight bespoke card types exist with no shared model. Replace with **one base + modifiers**.

### 2.1 Elevation & interaction model

| Level | Elevation | Interaction |
|---|---|---|
| `flat` | `--elev-0`, border only | static container (form sections) |
| `raised` | `--elev-1` | default content card |
| `interactive` | `--elev-1` → `--elev-2` + `translateY(-2px)` on hover | clickable (Registry, Dashboard tiles) |
| `floating` | `--elev-3` | popovers, detail pane, dropdowns |
| `modal` | `--elev-4` | dialogs |

### 2.2 Card anatomy (a fixed slot order, so every card reads the same way)

```
┌─ status rail (optional, 3px, semantic) ─────────────┐
│ [eyebrow / status pill]              [kind badge]   │  ← identity
│ Title                                                │
│ subtitle / route                                     │  ← what it is
│ ─────────────────────────────────────────────────── │
│ [ metric | sparkline | body content ]                │  ← the payload
│ ─────────────────────────────────────────────────── │
│ footer meta                          [overflow ⋯]    │  ← context
│ ▸ action bar (revealed on hover/focus)               │  ← act
└──────────────────────────────────────────────────────┘
```

The new `IntegrationCard` already implements this. **Roll the same anatomy onto**: Dashboard adapter
tiles, Connector Studio cards, Entity Catalog entries, Vault credential cards, My Connections rows.

### 2.3 States every card must support

rest · hover · **press** · focus-visible · **selected** (multi-select for bulk ops) · loading
(skeleton, not spinner) · **empty** · **error** · disabled/paused.

`selected` matters: Dashboard and Registry both have bulk actions (`bulkConnected`) with **no way to
select cards**. Bulk pause/resume currently applies to *everything* with no selection UI.

### 2.4 Motion for cards

| Moment | Spec |
|---|---|
| grid enter (first load) | fade + `translateY(8px)`, **stagger 30ms**, cap at 12 items then instant |
| hover | `translateY(-2px)` + elevation, `--dur-fast` |
| action bar reveal | `translateY(100%→0)`, `--dur-base`, `--ease-out` |
| skeleton → content | crossfade `--dur-base`; **never** a layout jump (reserve the height) |
| status change (live) | 600ms background flash in the semantic tint — the "something changed" cue |
| removal | collapse height + fade, `--dur-base`, `--ease-in` |
| reorder/filter | FLIP transform, `--dur-base` — currently items teleport |

**Effort:** 3 days. **Risk:** medium.

---

## Part 3 — The motion system, by purpose

### 3.1 Taxonomy

| Class | Duration | Where |
|---|---|---|
| **Feedback** | 80–140ms | press, hover, toggle, checkbox, focus ring |
| **Transition** | 220ms | expand/collapse, tab change, dropdown, accordion |
| **Continuity** | 320ms | detail pane, help panel, sidebar drawer, route change |
| **Progress** | loop, indeterminate | skeletons, spinners, progress bars, live polling |
| **Attention** | ≤3 loops **then stop** | new alert, run completed, value changed |

**Rule: nothing loops forever except an indeterminate progress indicator.** The four existing infinite
pulses must become 3-cycle-then-rest, or a static dot + text. With 20 errored integrations today the
dashboard runs 40+ simultaneous infinite animations.

### 3.2 Placement map — where each page gains

| Page | Add | Purpose |
|---|---|---|
| **All** | route crossfade (`--dur-slow`), global reduced-motion guard | continuity |
| **Login** | logo settle on load; shake on auth failure; button → loading | feedback |
| **Dashboard** | KPI **count-up** on load (600ms, respects reduced-motion); tile stagger; chart bars grow from baseline; live-poll flash on change | attention |
| **Registry** | grid stagger; FLIP on filter/search; card press; run → live status swap | continuity |
| **Monitor** | new rows slide in from top + 600ms highlight; realtime pulse **only while polling**; expand row accordion | attention |
| **Alerts** | severity pulse ×3 then rest; resolve → collapse + fade | attention |
| **Wizard** | step transition slide (direction-aware: forward=left, back=right); progress bar fill; field validation shake; mapping line draw-in | continuity |
| **Studio** | canvas node drag-lift; connect-line draw; publish success choreography | feedback |
| **Canvas** | mapping connector draw `--dur-base`; auto-map staggered reveal | continuity |
| **Vault** | reveal → blur-out transition; expiry countdown; rotate → loading → success | feedback |
| **Monitor DLQ** | replay → row progress → collapse on success | progress |
| **Detail pane / Help** | slide `--dur-slow` + backdrop fade; content fade 60ms behind the panel | continuity |
| **Toasts** | slide+fade in, **stack** (today a single slot clobbers), swipe/click to dismiss | feedback |

### 3.3 What NOT to animate

- Table rows on scroll (jank at 200+ rows)
- Anything on every poll tick (Monitor polls every 4s — animating each tick is a strobe)
- Chart re-render on live data (animate **enter only**, not every update)
- Page content on route change *beyond* a crossfade — enterprise users navigate fast
- Number tickers on anything that updates more than once per 10s

**Effort:** 3–4 days across pages. **Risk:** low if Part 0 lands first.

---

## Sequencing

This slots **after** the audit's Week 2 (colour) — several button/card states depend on the
status-colour fix (`btn-success` at 2.28:1 can't ship as-is), and both land in the same files.

| Phase | Content | Days | Depends on |
|---|---|---|---|
| **0** | Motion/elevation/z tokens · kill `transition:all` · global reduced-motion guard | 1 | — |
| **1** | Button system + `Button.jsx` | 2 | Phase 0, colour fix |
| **2** | Migrate 86 class-less buttons | 2 | Phase 1 |
| **3** | Card base + modifiers; roll onto 5 remaining card types | 3 | Phase 0 |
| **4** | Card states: selected (unblocks real bulk ops), empty, error | 1.5 | Phase 3 |
| **5** | Page motion per §3.2 placement map | 3.5 | Phases 0–4 |
| **6** | Loading/skeleton pass + `aria-busy`/`aria-live` on every async action | 1.5 | Phase 1 |

**Total ≈ 14.5 days.** Phases 0–2 alone (5 days) deliver most of the perceived quality jump, because
the pressed state and a consistent button are what make an app feel responsive.

---

## Highest value per hour

If only three things get done:

1. **Phase 0** (1 day) — tokens + kill `transition: all` + reduced-motion guard. Everything gets
   smoother with no component rewrites, and it removes a real accessibility liability.
2. **`:active` press states** (~2 hours) — zero exist today. One rule, applied across the button
   family, is the single biggest "this feels alive" change available.
3. **The loading button** (~half a day) — replaces 9 hand-rolled implementations and finally makes
   async actions announce themselves to assistive tech (`aria-busy` is currently 0 across the app).

---

## Final status — 2026-07-24

### Applied
| Phase | State |
|---|---|
| **0** Tokens · `transition:all` → 0 · global reduced-motion guard | ✅ |
| **Week-2 colour fix** (audit) — gated Phase 1 | ✅ |
| **1** Button variants + sizes + loading button | ✅ |
| **2** Migrate ~86 class-less buttons onto `<Button>` | ❌ **not done** |
| **3+4** Card base, anatomy, states (selected/empty/error/skeleton) | ✅ |
| **5** Per-page motion (§3.2) | ✅ |
| **6** Loading/`aria-busy`/`aria-live` on async actions | ✅ |

### Colour fix — measured before → after

| | Before | After |
|---|---|---|
| Light `badge-success` on its tint | **2.09** | **4.60** ✅ |
| Light `badge-warning` | **1.99** | **4.65** ✅ |
| Light `badge-error` / `info` / `primary` | 3.29 / 3.29 / 3.95 | 5.66 / 5.99 / 6.99 ✅ |
| `.btn-success` white-on-fill | **2.28** | **5.02** ✅ |
| `.btn-danger` / `.btn-primary` | 3.76 / 4.47 | 4.83 / 6.29 ✅ |
| `<th>` text on input bg | **2.34** | **4.97** ✅ |
| `--text-dim` on card / page | 2.56 / 2.16 | 5.45 / 4.59 ✅ |
| Input border vs card (WCAG 1.4.11) | **1.48** | **3.71** ✅ (new `--border-strong`) |
| Row hover step | **1.04** (3% opacity) | 1.18 (real token) |
| Dark: sidebar vs card | **1.00 — identical** | 1.05 (elevation exists) |
| Dark badges (all five) | 3.25–6.08 | 5.31–7.82 ✅ |

New tokens: `--{success,warning,error,info,primary}-on` (text on tint) and `--*-solid` (fills that can
carry white). The old hues stay as *fills* — dots, bars, rails — where the bright value is correct.
54 inline `color: 'var(--error)'`-style usages were swapped to the on-tint tokens.

### Phase 2 — done (2026-07-24)
The real count was **52**, not 86: the audit's figure came from a grep that mis-handled multi-line
opening tags. They sat in just four files, and 47 of them were two *parallel design systems*:

| File | Was | Now |
|---|---|---|
| `ConnectedPage` (27) | `btnStyle`/`btnPrimaryStyle`/`btnDangerStyle`/`smallBtn`/`chipStyle` from `connected/styles.js` | `.btn .btn-*`, `.chip`, `.dp-close`, shared `th`/`td` |
| `JoinsPanel` (20) | local `S.addBtn`/`S.ghost`/`S.link`/`S.head`/`S.card` | `.btn .btn-*`, `.link-btn`, `.joins-*` |
| `WizardPage` (3) | unstyled | `.btn btn-ghost btn-xs`, `.multi-field-remove` |
| `VaultPage` (2) | inline icon-button styles | `.btn btn-ghost btn-xs` |

Deleting those two shadow systems fixed several audit findings at once:
* `connected/styles.js` — `inputStyle` used `--bg-main` (page lavender) instead of `--bg-input`;
  `overlayStyle` used `zIndex: 999`, the *exact* value the toast stack uses, so their stacking order
  was undefined; `fmtDate` hardcoded `en-US` while every other surface used the viewer's locale;
  `thStyle`/`tdStyle` shadowed the global table rules with different padding and no uppercase header.
  `statusColor`/`statusBadgeClass` handled no `PARTIAL` case, so a partial push rendered grey here and
  amber on the Dashboard.
* `JoinsPanel` — `S.inp` used `var(--bg)`, a variable defined **nowhere**, so those inputs rendered
  with no background at all.
* **15 `var(--X, fallback)` references to undefined variables** (`--danger`, `--bg-alt`,
  `--primary-soft`) across 7 files always resolved to their hardcoded fallback and never followed the
  theme. All now point at real tokens.
* `.dp-close` sizing was scoped to `.detail-pane-header`; reusing the class in the Connections modals
  left it at **21px**, under the 24px floor. It is now a standalone rule.

Verified: 0 class-less buttons, **0 sub-24px targets app-wide**, 11 pages clean in both themes,
no console errors, My Connections expands to 276 correctly-classed buttons.
