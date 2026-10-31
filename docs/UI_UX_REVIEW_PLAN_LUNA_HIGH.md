# Ledger UI/UX review and Luna High implementation plan

Prepared 2026-10-31 from independent design and technical reviews of the current dashboard. Audience: Peter and his fiancée; the interface should be easy for a less technical household member and feel polished and enjoyable. Surface mode: Operate. Keep the existing green/off-white identity and improve clarity, consistency, and task flow; this is refinement, not a rebrand.

## Review findings

The dashboard has a coherent, calm visual foundation, direct finance workflows, explicit sample-data labeling, and useful safeguards around actuals, forecasts, pending transactions, and household records. The main weakness is that it currently asks users to interpret too much operational detail and financial terminology before they can confidently complete everyday tasks.

Highest-priority findings:

1. **Budget rows collide at desktop width.** On the 1440px capture, plan-frequency prose overlaps Actual Spent values. The budget page also overflows to 1472px. Preserve the compact row model and the current plan/actual/remaining semantics from `docs/BUDGET_PLAN_VS_ACTUAL_PLAN.md`; fix the columns and move frequency details into bounded secondary text or the editor.
2. **A false recovery warning appears throughout the app.** `ui/browser.js` reads `api.reloadRecoveryAvailable` from a profile wrapper that does not expose the property. The property belongs to `apiClient`; ordinary session storage works in the review browser. Correct the reference and retain accurate warnings for genuinely unavailable storage or an uncertain save.
3. **Text contrast and control labels need attention.** Axe reported serious contrast violations on Overview and Transactions, plus ten budget “Edit plan” buttons whose accessible names did not contain their visible label.
4. **The household scope and navigation are unclear.** “Combined Budget” appears as a global scope selector on unrelated pages, the sidebar says “Personal space,” and nine peer destinations become a partially hidden horizontal strip on mobile. Clarify what the existing selector controls; do not invent a joint access or privacy boundary.
5. **Complex planning screens assume financial expertise.** The purchase scenario form exposes up to 40 controls and technical terms. Progressive, understandable steps and field-level explanations would help users finish without weakening calculation rules or suggesting loan approval.
6. **Too much operator detail competes with daily money tasks.** Recovery and backup notices, filters, and advanced actions can dominate the initial view. Explain relevant state at the moment it matters, and group secondary controls.

Expert heuristic estimate: **22/40**. Axe ran on 27 synthetic route/viewport combinations across nine destinations at 1440, 390, and 320px. It found contrast issues, accessible-name mismatches, and 320px/desktop overflow. The rendered detector reported 31 warnings and 6 advisories on mobile Overview; treat the detector as supporting evidence, not as a substitute for judging the interface. Overlay injection was blocked by the app’s CSP, which was left unchanged. Reviews used synthetic data, not production records; they were not a usability study, screen-reader assessment, physical 200% zoom check, or financial calculation audit.

## Luna High execution order

### 1. Fix trust-breaking status and save feedback

- Correct the reload-recovery capability property reference and cover available storage, blocked storage, uncertain save response, and recovered save.
- Show recovery actions only when there is a pending or uncertain operation. State backup readiness in one concise notice with a useful Settings destination; keep operator details secondary.
- Protect meaningful unsaved dialog work from accidental Escape/close, with discard confirmation only for dirty forms.

**Impeccable:** `$impeccable harden ui/browser.js`, then `$impeccable clarify ui/browser.js`.

**Accept when:** no false recovery warning appears with working session storage; true storage failures and uncertain saves remain understandable and actionable; untouched dialogs close without confirmation and dirty forms have a clear recovery choice.

### 2. Make everyday information readable and stable

- Fix budget grid sizing and align Plan and Actual numbers. Keep the compact rows, actual/plan distinction, unplanned-spending warning, carryover meaning, and existing calculation contract.
- Rebalance type and contrast in ordinary finance data: labels, dates, merchant details, helper text, chart alternatives, selected/disabled states, credits/refunds, and pending records.
- Raise functional text sizes where currently 9–12px, with hierarchy rather than uniform enlargement. Use tabular numerals for money.
- Fix month control and page sizing at 320px; prevent document-level overflow at 320, 390, 768, and 1440px without hiding overflow.

**Impeccable:** `$impeccable layout ui/browser.js`, `$impeccable typeset ui/styles.css`, `$impeccable adapt ui/browser.js`.

**Accept when:** no text or numbers overlap; no page-level horizontal overflow at target widths; financial text meets WCAG AA contrast in actual rendered states; users can distinguish plan, actual, remaining, unknown, and incomplete values without relying on color.

### 3. Make household scope and navigation self-explanatory

- Use a clear label such as Household / Peter / Maddie only where supported by existing behavior. Explain whether selection filters records; preserve the fact that profile selection is organizational, not an access-control boundary.
- Reorganize navigation so daily money tasks are easiest to find and settings remain secondary. Keep every destination reachable on mobile through an obvious navigation control; retain routes, query links, and browser history.
- Clarify sample preview coverage. Do not offer “Explore sample data” from a page already in sample mode; provide a clear route back to sample Overview or an exit action.

**Impeccable:** `$impeccable shape navigation and household scope`, then `$impeccable clarify ui/browser.js`, `$impeccable adapt ui/browser.js`.

**Accept when:** a first-time user can say whose records are being shown, reach every destination at 320px without guessing or horizontal hunting, and leave sample mode explicitly.

### 4. Reduce the cost of planning tasks

- Restructure purchase planning into a small sequence: purchase and loan, ongoing ownership costs, cash to close, then review. Put units beside fields and translate technical terms into plain language; retain optional details as optional.
- Keep unknown amounts unknown; do not imply approval, guarantee affordability, or turn estimates into actual balances. Explain goal allocations as earmarks that do not move money.
- Review form cancel/save states, validation, confirmation, and error recovery on property, goal, budget, and import flows. Preserve existing calculation and data contracts.

**Impeccable:** `$impeccable shape home planner and goals`, `$impeccable onboard ui/browser.js`, `$impeccable clarify ui/browser.js`, `$impeccable harden ui/browser.js`.

**Accept when:** a novice can complete a sample scenario and explain what each result means, what remains unknown, and whether anything was saved; goal funding does not look like a bank transfer.

### 5. Finish as one product, then verify

- Capture the incumbent visual system with `$impeccable document` if no DESIGN.md exists; keep its restrained identity and document reusable patterns only after the refined surfaces settle.
- Run `$impeccable polish ui/browser.js` after the batches above. Use `$impeccable critique ui/browser.js` for a fresh independent assessment only after fixes, then `$impeccable audit ui/browser.js` for final accessibility, responsive, and technical review. Use `$impeccable live` only if the app’s local serving setup supports its live workflow; do not weaken CSP to enable injection.
- Validate empty, populated, sample, warning, error, and saved states. Cover keyboard use, visible focus, browser back/forward, 320/390/768/1440px, screen reader, and physical 200% zoom. Ask the fiancée to perform: identify the household scope, understand this month’s plan versus actual, correct a transaction category, find an upcoming bill, create a savings goal, and create/review a purchase scenario without coaching. Record completion, wrong turns, comprehension, and confidence.

## Rules for the implementer

- Keep all financial calculations, data ownership, privacy boundaries, URL behavior, and save/recovery guarantees intact unless a separately reviewed product change explicitly alters them.
- Use synthetic fixtures only. Never copy private financial records or credentials into source, screenshots, plans, or test data.
- Fix root causes rather than suppressing warnings or hiding overflow. Recheck real rendered contrast and accessible names.
- Treat “world-class” as polished hierarchy, readable data, consistent controls, calm confidence, and low-friction tasks; do not add decorative complexity to a finance tool.

## Review artifacts

- Design assessment and screenshots: `outputs/ux-review-2026-10-31/`.
- Independent full review notes: `/tmp/ledger-assessment-a.md` and `/tmp/ledger-assessment-b.md` (temporary session artifacts).
- Existing calculation and interaction contract: `docs/BUDGET_PLAN_VS_ACTUAL_PLAN.md`.

## Implementation progress (2026-10-31)

Completed in `ui/browser.js` and `ui/styles.css`:

- Fixed the false reload-recovery warning by reading the capability from `apiClient`.
- Kept the no-verified-backup notice in Settings; actual failed or stale backup states remain visible across the app.
- Improved finance text contrast and functional type sizes, budget wrapping, and narrow-screen sizing.
- Changed the household selector label and sidebar identity to describe household records; budget edit buttons now use a visible, row-specific accessible name.
- Replaced the hidden mobile route strip with a labeled page selector containing all nine destinations.
- Replaced the repeated sample-data action on sample-only pages with a route back to Sample Overview.
- Simplified goal funding language while retaining stale-balance and no-transfer meaning.
- Added a short orientation sentence to purchase scenarios and collapsed the detailed ownership-cost section by default. Invalid required fields still open their section and receive focus.

Updated browser acceptance checks to derive goal dates dynamically and exercise the mobile selector and collapsed scenario section.

Verification: `npm run build`, `npm run check:source`, `npm run check:browser`, and `impeccable detect --json ui/browser.js` passed. Browser acceptance covered 1440, 390, 320, and 720 CSS px at 200% zoom-equivalent, import/undo, budget edits, goals, scenarios, keyboard flows, and axe checks with zero serious or critical violations.

Still requires human acceptance: the fiancée usability exercise from the plan, actual screen-reader use, and physical 200% zoom/device checks. The Impeccable launcher in this environment does not expose a `polish` command; the visual finish was checked through the rendered browser suite and detector instead.
