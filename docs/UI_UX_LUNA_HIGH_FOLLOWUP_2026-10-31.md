# Luna High handoff: close the remaining Ledger review issues

**Target:** `ui/browser.js`, `ui/styles.css`, `shared/scenarios.mjs`, and focused browser checks. Product mode: Operate. Design direction: keep Ledger’s existing green/off-white identity and financial calculation rules.

**Current baseline:** Impeccable critique on 2026-10-31 scored 24/40. The full browser suite did not finish in the last run. The latest review used synthetic data only. Do not claim a score improvement until a new critique is run after implementation.

## Required order

1. Make scenario preview and save requirements consistent.
2. Preserve mobile filter disclosure state and expose active filters.
3. Move mobile transaction and budget results higher.
4. Run the focused acceptance cases below, then the full checks. Fix any failed acceptance case before reporting completion.

Keep financial arithmetic, ownership rules, unknown-versus-zero meaning, data persistence contracts, URL/history behavior, and privacy boundaries unchanged. Use synthetic records only.

## 1. Scenario: explain complete-save requirements before the action

**Current problem:** The dialog offers a rough principal-and-interest preview with unknown costs, while the existing validator requires several additional fields before saving. The Save action does not state which fields are needed; native validation opens their sections only after the user submits.

**Files:** `ui/browser.js` scenario dialog (`scenarioDialog`, around lines 227–228); `shared/scenarios.mjs` `REQUIRED_COST_FIELDS` and conditional validation (around lines 3–5); scenario case in `scripts/check-browser.mjs`.

**Implementation:**

- Keep the early principal-and-interest calculation and complete-scenario validator unchanged.
- Remove duplicated “Start with” instructions. Give the two states distinct labels: **Rough payment preview** and **Complete scenario**.
- Before the Save button, show a compact **To save this scenario** checklist generated from the same required-field rules as validation. Include conditional requirements only when they apply (for example, current housing when it is not being replaced; other debt payments when gross income is entered; PMI or explicit “No PMI”).
- For every cost, explain whether the user may enter **0** when none applies or leave it **unknown** in the preview. Never describe a save-required field as optional without saying that it is required to save.
- Change submit behavior only enough to focus/open the first missing section and identify its field. Do not convert blank to zero or persist incomplete scenarios under the existing complete-scenario operation.

**Accept when:** With only price, down payment, term, and rate entered, the rough preview appears and is visibly labeled incomplete. The checklist accurately matches `validateScenarioInput` for at least: minimal inputs, net income present, gross income present, explicit no-PMI, and PMI estimate missing. On submit, the first applicable missing field is focused and its section opens. A complete scenario still saves and calculates the same result as before.

## 2. Mobile Transactions: retain disclosure state and show active filters

**Current problem:** The disclosure is collapsed at mobile width, but `bind()` closes it after every render. A user who opens it and changes one filter must reopen it. When collapsed, the summary does not show active filter state.

**Files:** `ui/browser.js` `transactions()` and `bind()` (around lines 152 and 294); `ui/styles.css` `.transaction-filter-details`; `scripts/check-browser.mjs`.

**Implementation:**

- Store disclosure state separately from rendered markup. Initialize it once when entering Transactions at mobile width; do not overwrite it on each `bind()` or render.
- Preserve expanded/collapsed state through category, account, owner, date, review, and clear-filter rerenders. Search remains outside the disclosure.
- Compute an active-filter count from the current search, category, account, owner, date range, and Needs review state. Display **Filters · N active** in the summary. Search must be included even though its field remains visible.
- Keep the existing Clear filters action visible inside the expanded panel. Clearing filters must also use the existing selection-scope clearing behavior and status message.
- On desktop, keep the controls visible as they are today. On mobile, start collapsed only on the first entry into Transactions; preserve the user’s choice afterward.

**Accept when:** At 390px, opening the panel and changing any one filter leaves it open and updates the active count. Closing it retains the count. Clear filters resets the count to zero and clears any transaction selection with an announcement. Navigating away and back initializes to the documented default. At desktop width, every control remains visible.

## 3. Mobile: put useful transaction and budget content above the fold

**Current problem:** At 390×844, the first transaction row starts around y=649 and the planned budget result around y=683. Both are visible only near the bottom of the initial viewport.

**Files:** `ui/browser.js` page heading, mobile page context, `transactions()`, and `budgetPage()`; `ui/styles.css` mobile pagehead, spacing, transaction controls, and `.mobile-budget-result`; `scripts/check-browser.mjs`.

**Implementation:**

- Keep the page title, month/profile context, search field, active-filter summary, and incomplete-budget status. Do not hide these to gain vertical space.
- At 390px, reduce excess vertical spacing in the page heading and between heading, controls, and content. Keep targets at least 44px high and preserve visible keyboard focus.
- Put the first transaction row directly after the search/disclosure/count region. Do not place import/export/category administration ahead of the list.
- Place the mobile planned result directly below the Budget heading and income input. Keep its incomplete/unplanned warning beside the result; do not duplicate a warning in a way that changes its meaning.
- Keep the existing desktop composition unchanged unless a shared spacing correction is required.

**Acceptance measurements:** On a populated synthetic Transactions view at 390×844, the first transaction row’s top is **≤560 CSS px**. On a populated synthetic Budgets view at 390×844, the planned result card’s top is **≤600 CSS px**. At 320, 390, 768, and 1440px, document scroll width must not exceed viewport width. Verify the row and result are still readable, not clipped or covered by sticky controls.

## 4. Verification and reporting gate

Add or update browser cases for the acceptance criteria above. Specifically cover cancel confirmation accept/decline, month-change selection clearing, scenario conditional requirements, disclosure persistence after rerender, active-filter count, clear filters, and mobile placement measurements. Use a fresh isolated synthetic store. If the full suite stalls, run the focused cases independently and report the full suite as incomplete; do not describe it as passing.

Run `node --check` on touched JavaScript modules, `npm run build`, `npm run check:source`, and `git diff --check`. Run axe WCAG A/AA on populated Transactions and Budgets at 390px. Capture the measured bounding boxes and attach them to the implementation report.

After all criteria pass, run `$impeccable critique ui/browser.js` again. Report the new score separately from the prior 24/40 and include any acceptance item that could not be verified. The prior critique is archived at `.impeccable/critique/2026-10-31T19-26-03Z__ui-browser-js.md`.

## Implementation status — 2026-10-31

Implemented in `ui/browser.js`, `ui/dialogs.mjs`, and `ui/styles.css`:

- Scenario save requirements are generated from the form’s live `required` fields, grouped by section, and update when net/gross income, housing replacement, or explicit no-PMI changes conditional requirements. The preview is labeled separately; unknown values stay unknown and complete-save validation is unchanged.
- The mobile transaction disclosure now keeps its user-selected open state through rerenders. Its summary reports the active count across search, category, account, owner, date range, and review-only. Desktop still opens the controls by default.
- Mobile page heading and control spacing were reduced without lowering the 44px filter control target. Budget page copy was shortened while retaining carryover meaning.

Browser regression coverage in `scripts/browser-cases.mjs` now checks filter state/count, clear behavior, month-change selection clearing, dynamic scenario save requirements, and mobile placement/accessibility gates. Focused checks passed:

- `BROWSER_CASE=sample-transaction-filters npm run check:browser`: first transaction at **556.4px**, planned budget result at **213.6px** at 390×844; axe WCAG A/AA reported zero violations on both populated synthetic views.
- `BROWSER_CASE=form-drafts npm run check:browser`: scenario checklist, conditional requirements, discard accept/decline, and draft recovery passed.
- `npm run build`, `npm run check:source`, JavaScript syntax checks, and `git diff --check` passed.

The full browser suite was not run to completion; the two focused cases above are the evidence for this handoff’s targeted behavior.
