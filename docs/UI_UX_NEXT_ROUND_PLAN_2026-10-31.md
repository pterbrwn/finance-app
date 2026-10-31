# Ledger UI/UX: next improvement round

> **Immediate implementation handoff:** The broad phases below remain the product context. After the 2026-10-31 latest critique (24/40), do the three concrete tasks in [the focused Luna High follow-up](UI_UX_LUNA_HIGH_FOLLOWUP_2026-10-31.md) first. Do not treat the prior implementation log as proof that the latest acceptance criteria passed.

Prepared 2026-10-31 from the current working tree, the fresh [Impeccable critique](../.impeccable/critique/2026-10-31T18-04-23Z__ui-browser-js.md), `PRODUCT.md`, and the prior [UI/UX execution plan](UI_UX_REVIEW_PLAN_LUNA_HIGH.md). This is an implementation plan, not a record of completed fixes. The current UI has uncommitted changes; compare against those bytes before starting and do not repeat work already completed in the prior round.

## Outcome and design direction

**Audience and mode:** Peter and his fiancée use an Operate-mode household finance dashboard. A less technical user should be able to review money, correct transactions, and explore a purchase without guessing which records will change or whether an estimate is complete.

**Direction:** Refine the existing green and off-white identity. Let product character come from calm hierarchy, plain financial language, visible data provenance, and safe actions. Preserve actual versus planned versus hypothetical distinctions. Keep advanced calculation details available without making them the first thing a household member must read.

**Success:** A user can select and edit exactly the intended transactions; leave any edited form without accidental loss; obtain a useful first purchase estimate without inventing unknown amounts; understand the scope and completeness of budget figures; and read or operate the core screens at phone width and 200% zoom.

## Product and implementation boundaries

- Preserve financial arithmetic, ownership rules, profile selection as an organizational filter rather than a privacy boundary, URL/history behavior, save and recovery guarantees, and the existing green/off-white visual identity.
- Preserve the distinction among blank/unknown, explicit zero, stale, excluded, pending, non-USD, actual, and hypothetical values. A partial scenario must never look like a verified affordability or loan decision.
- Use synthetic fixtures only. Do not copy production records, credentials, or private configuration into screenshots, tests, or documents. Keep the app local/private and do not weaken CSP for an Impeccable overlay.
- Work within `ui/browser.js`, `ui/dialogs.mjs`, `ui/styles.css`, relevant shared calculation modules only if required, and focused browser/source checks. Do not turn this into a rebrand or broad backend rewrite.

## Phase 1 — Make actions and drafts safe

### 1A. Transaction bulk selection

**Decision:** Clear the current selection when the result *scope* changes: search, category, account, owner/profile, date range, review-only state, or reporting month. Show a short status such as “Selection cleared because the results changed.” Do not clear for a sort or a page change within the same result scope; keep a persistent selected-count bar that says selection spans pages and provides **Review selected** and **Clear selection**. The review view lists the selected merchant/date/account/amount before a bulk change. If records change or disappear during review, block the write and ask for refresh rather than silently applying to a different set. Keep the 100-item cap explicit. A bulk success message states the number changed and retains the existing undo path.

**Why:** This removes invisible selections after filters while preserving useful cross-page bulk work. It also makes the exact action target visible before a high-impact edit.

**Implementation touchpoints:** Selection and filters in `ui/browser.js`; URL state in `ui/view-state.mjs` if needed; transaction browser cases in `scripts/check-browser.mjs`. Audit every control that changes the result scope, including browser back/forward and profile changes.

**Accept when:** A filter change always clears selection and announces it; page changes preserve a visible count; review and submit show the same IDs; no offscreen selected ID is changed without appearing in the review; the 100-item limit, failures, refresh, and undo are clear.

### 1B. Unsaved-work guard

Create one navigation/close decision path for dirty forms. Track meaningful user edits against the initial values, so merely focusing a field or opening a dialog does not trigger a warning. Apply it to Escape, Cancel, close control, route/page selector, month/year/profile selectors, browser back/forward, and in-app links that rerender the page. Preserve the draft and focus when the user chooses **Keep editing**; close or navigate only after **Discard changes**. For in-flight saves, block duplicate or conflicting navigation and show the save state. Successful save clears dirty state.

**Implementation touchpoints:** `ui/dialogs.mjs` and navigation/render paths in `ui/browser.js`. Centralize the guard rather than adding unrelated `confirm()` calls to each form.

**Accept when:** A dirty budget, annual income, goal, property, CSV import, and purchase scenario survive accidental close/navigation; clean dialogs close immediately; save failure keeps entered values; browser history and keyboard behavior remain predictable.

**Impeccable pass:** `$impeccable harden` followed by `$impeccable clarify` for selection, save, discard, and undo language.

## Phase 2 — Make a purchase scenario approachable

Use a staged flow: **(1) Purchase and loan**, **(2) Ongoing costs**, **(3) Cash and household context**, **(4) Review**. Show a clearly labeled *rough payment estimate* after the minimal valid first-stage inputs. As more inputs are entered, show what the estimate now includes and what remains unknown. Keep additional costs optional at the UI level where the calculation supports unknown values; where persistence requires a field, either adapt the domain contract safely or clearly require it only at final save. Do not silently convert blank to zero.

Replace unexplained PMI, DTI, escrow, and “fixed note rate” wording with plain labels and concise inline help. Group optional advanced fields by decision they affect. Give the first invalid field a visible, local explanation and focus; open its section automatically. Review shows a compact summary of assumptions, excluded/unknown costs, source dates, and whether the scenario is saved. Saved existing scenarios must reopen with all values and calculation semantics intact.

**Implementation touchpoints:** `scenarioDialog` and result presentation in `ui/browser.js`, scenario validation/calculation boundaries in shared modules only if the partial-estimate contract requires it, scenario browser cases. Keep hypothetical scenarios separate from accounts, goals, and budgets until an existing explicit confirmation applies them.

**Accept when:** A novice can reach a rough result from purchase price, down payment, term, and rate; blank unknown costs remain unknown; a saved scenario gives the same complete result as before for the same inputs; no copy implies approval or guaranteed affordability; cancel/reopen/error recovery retain the right values.

**Impeccable pass:** `$impeccable shape` for the staged interaction, then `$impeccable onboard`, `$impeccable clarify`, and `$impeccable harden` during implementation.

## Phase 3 — Improve readability and everyday scanability

### 3A. Contrast, type, targets, and motion

Fix the remaining rendered transaction contrast failures: category selects, dates, and positive amounts. Recheck normal, hover, focus, selected, disabled, pending, and credit/refund states against WCAG AA text contrast; do not rely on green alone to identify a positive amount. Raise functional 9–11px text and tiny links to a readable size with an intentional hierarchy, especially in mobile transactions, filters, budget details, and chart alternatives. Give touch actions adequate target size and spacing without turning dense data into oversized cards. Use tabular numerals for finance figures. Respect `prefers-reduced-motion` for navigation scrolling and any transitions.

### 3B. Transaction task order

Make search and current filters immediately legible; group less-used date/account/owner/review controls under a clear **Filters** affordance with an active-filter count and one **Clear filters** action. Keep import/export and category administration available as secondary actions. Do not hide active filter state or selection state. Place the transaction list close enough to the page heading that a mobile user can begin reviewing records without crossing a wall of controls.

### 3C. Scope and budget confidence

Add visible “Viewing records for” context to Household/Peter/Maddie selection, using page-specific supporting text where the selection affects the figures or actions. State once, accessibly, that changing the selection changes the view and is not an access restriction. Surface **Incomplete estimate** or **Unplanned spending** beside the budget result rather than only in the dense result cell or long note below. Keep the underlying arithmetic and carryover explanation in expandable detail, with a short plain-language summary at the point of decision.

### 3D. Route announcement

After an SPA route change, move focus to the new page heading or announce it through a stable live region, without surprising pointer users. Preserve the existing focus return for closed dialogs and the caret behavior in debounced search. Test with keyboard and an actual screen reader.

**Implementation touchpoints:** `ui/styles.css`, `ui/browser.js`, browser accessibility cases. Fresh visual review should cover Overview, Transactions, Budgets, Goals, Home planner, and the new annual review at 320, 390, 768, and 1440 CSS px plus physical 200% zoom.

**Accept when:** Axe reports zero contrast violations on the representative screens and states; transaction dates/credits remain distinguishable without color; all primary actions are comfortably operable on a phone; route changes are announced; active filters and bulk selection are never hidden; the budget result communicates its completeness before the calculation detail.

**Impeccable pass:** `$impeccable typeset`, `$impeccable layout`, `$impeccable adapt`, and `$impeccable clarify` on the named surfaces.

## Phase 4 — Integrate, verify, and finish

1. Review the three phases together on live rendered synthetic data, then run `$impeccable polish` as a design review if the launcher supports it. Do not treat a missing launcher verb as proof that visual review passed. Capture the current design system in `DESIGN.md` after the refined patterns settle.
2. Run focused tests after each behavior change, then the existing build, source, browser, and relevant finance checks. Add meaningful cases for filter-change selection clearing, cross-page selection visibility/review, stale ID rejection, Escape and route draft protection, scenario partial versus full results, and accessible route announcement. Verify with the real rendered DOM and axe; the Impeccable detector is supplemental.
3. Exercise empty, populated, sample, loading, save-in-flight, conflict, stale/unknown, and failed states. Check browser back/forward, keyboard-only operation, actual screen-reader use, physical 200% zoom, and 320/390/768/1440px layouts. Verify no document overflow and no data loss. Do not use pre-fix screenshots as evidence of the final state.
4. Ask the fiancée to attempt four uncoached tasks: identify whose records are shown; select and recategorize only two intended transactions; explain whether a budget surplus is complete; create and revise a purchase scenario while leaving unknown costs blank. Record completion, wrong turns, comprehension, and confidence. Fix observed confusion before treating the round as finished.

**Release gate:** No accidental offscreen bulk edits, no accidental loss of meaningful drafts, no misleading partial estimate, zero serious/critical axe findings and zero known contrast failures on representative routes, preserved financial regression results, and successful human task completion. Re-run `$impeccable critique ui/browser.js` after implementation to compare with the 23/40 baseline; a score increase alone is not the release gate.

## Execution order and ownership of decisions

1. Phase 1 is first because data-changing actions and unsaved work affect trust. Implement selection semantics and the shared draft guard before changing visual structure.
2. Phase 2 defines the scenario interaction and partial-result contract before styling its screens.
3. Phase 3 applies readability and hierarchy across both updated workflows and the everyday dashboard.
4. Phase 4 validates the integrated result. Keep a short implementation log with completed items, test evidence, unresolved issues, and any deliberate product contract change.

The selected transaction behavior is decided above. Other routine layout/copy choices should follow the audience and acceptance criteria without pausing implementation. Escalate only if a change would alter financial arithmetic, privacy/ownership boundaries, or the meaning of an unknown value.

## Implementation status — 2026-10-31

Implemented in the current working tree:

- Transaction selection clears on search, category, owner, account, date, review-state, and reset changes. It remains across pages in the same result set, shows a selected count, and has a review dialog listing selected merchant, date, account, and amount before categorizing.
- Dirty-form protection now covers Escape, dialog cancel controls, route changes, profile changes, and month changes. It prompts only after actual edits. Successfully saved statement reviews clear their dirty state.
- Purchase scenarios show an early principal-and-interest estimate once the core purchase and loan values are valid. The estimate labels the costs it excludes and retains blank costs as unknown. A complete scenario switches to the existing full calculation; saving still uses the existing complete-scenario validation and persistence contract.
- Transaction controls use darker, larger text and larger mobile targets. Reduced-motion preferences are honored. The household selector has a visible purpose label, incomplete budget estimates have a separate warning treatment, and route navigation can focus the page heading.

Verification completed:

- `npm run build`, JavaScript syntax checks, `npm run check:source`, and `impeccable detect --json ui/browser.js` passed. The detector returned no findings.
- Fresh rendered pages at 320, 390, 768, and 1440px had no document overflow or page errors.
- A focused rendered scenario check produced a $1,422.15 monthly principal-and-interest estimate for synthetic inputs, with the excluded costs stated beside it.
- The full `npm run check:browser` run did not complete in this session: after multiple minutes without output or a new failure artifact, it was interrupted. Earlier attempts exposed and helped correct pagination selection and saved-form state behavior. The complete suite remains outstanding.
- A clean review server is available at `http://127.0.0.1:4173` on a newly created local-only store verified to contain zero accounts. Do not reuse the earlier temporary review store; it already contained 15 accounts.

Still outstanding before calling the round complete: finish the full browser suite and add focused regression coverage for the selection review/filter clearing and dirty-form guard; verify contrast with axe on representative live screens; exercise browser history and keyboard navigation; do an actual screen-reader and physical 200% zoom check; and run the uncoached household acceptance tasks in Phase 4. These are tracked as acceptance work, not claimed as passed.
