# Ledger design system

This document records the settled interface patterns used by the household finance app. It is a working reference, not a marketing brand guide. Keep it aligned with `ui/browser.js` and `ui/styles.css` when a pattern changes.

## Product character

Ledger should feel calm, private, and concrete. The interface favours a quiet green and warm off-white palette, generous whitespace, and plain language over technical jargon. Financial meaning comes first: every screen should answer what was spent, what remains planned, what is due, and whether the underlying data is current.

Avoid decorative dashboards, dark-mode variants, and broad visual rewrites that do not improve a household task.

## Layout

- **Desktop:** fixed 228px sidebar on the left, content column up to 1620px wide. The sidebar carries the brand, main navigation, account summary, and household context.
- **Tablet:** 175px sidebar. Charts and multi-column forms collapse to one or two columns.
- **Phone:** the sidebar becomes a sticky top bar with direct links to Overview, Transactions, Budgets, and Bills plus a full-width page selector for other areas. Content padding drops to 16–17px.
- **Page head:** eyebrow, page title, short description, then context controls. On phones the context label is visually hidden but remains the accessible name, and profile/month selectors share one row.
- **Cards:** white surfaces, 1px warm border, 12px radius, compact headings. Primary content never lives inside a collapsed technical disclosure.
- **Tables:** transaction tables become stacked rows below 600px. Above phone width but below 900px, the table scrolls inside its card instead of widening the document.

## Typography

- Family: `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
- Page titles use a tight, confident scale; card headings stay small and functional.
- Money uses tabular numerals where alignment matters. Amounts are never clipped or wrapped mid-number.
- Secondary text may be smaller, but must retain AA contrast. Do not use pale grey for meaningful limits, dates, or status.
- Body copy is sentence case. Labels are short and literal.

## Colour

Core tokens live in `ui/styles.css`:

- `--green: #254f40` — primary actions and strong headings.
- `--muted: #65736b` — secondary text that still meets contrast.
- `--border: #e7eae3` — quiet separation.
- Background: `#f5f6f2`; card surface: white.
- Success/accent green: `#2f6d4f`; warning amber: `#8a5a2b`; error red: `#9c382d`.

Use semantic colour, not colour alone. A warning always has text; a healthy state always cites evidence.

## Primary actions

- Add transaction is the first visible action on Transactions, at every width. It is never inside Filters.
- Import and export are secondary and remain in the filter/action area.
- Review and rule management are visible peer actions with clear labels: `Needs review`, `Manage rules`.
- On phones primary actions stay visible; secondary filter controls can wrap. Occasional transaction actions live in a per-row Details disclosure.
- Destructive actions use explicit verbs (`Delete rule`, `Remove transaction`) and ask for confirmation when records or dependencies change.

## Review workflow

- The review inbox states the remaining count, why each row is flagged, and what acceptance will do.
- Each row offers `Accept category`; changing the category is a separate, reversible correction.
- `Mark N reviewed` applies to the visible page. `Undo last review` reverses the latest batch.
- A correctly matched transfer can be accepted without changing its category.
- Rules never exempt a transaction from review, and manual category choices are protected by `categoryEditVersion`.
- Review reasons use plain language, readable 13px or larger text, and remain visible on phones.

## Category rules

- Rules are explicit user records. The distributable defaults contain no household-specific merchants or amounts.
- The rule editor shows merchant/counterparty text, category, profile scope, account, amount, month bounds, and sources. Rule help uses readable 13px or larger text.
- `Preview changes` runs before saving and reports exact affected records. Saving with changes requires confirmation.
- Rules can be paused, enabled, edited, and deleted. Deleting a rule may return records to review, but manual choices stay protected.
- Precedence is deterministic: more constraints win; then amount, account, date bounds, sources, counterparty, merchant text, and finally text length.
- Rule controls use the shared input treatment and 44px minimum height. Category starts unselected; amount guidance uses readable text and explains receipt direction without requiring negative input.

## Daily overview and bills

- Overview leads with recorded spending, recorded income, actual cash flow, category allowance, and recent transactions. Personal/shared comparisons, income planning, account balances, and trends use labelled disclosures.
- Planned income is explicitly distinct from recorded deposits. Category allowance is a plan, not a bank balance.
- Bills leads with upcoming dates. `Add a bill` opens the creation form; unsaved drafts keep it open through refreshes. The first due date determines recurring day/month and a visible schedule explanation.
- Unconfirmed saves say they may still have saved. Offer `Check again` and `Dismiss after checking records`, preserving explicit confirmation and recovery metadata.

## Status and trust language

One shared readiness model drives the Settings summary, top bar, banners, and details.

- Backup states: current, stale, failed, incomplete, unverified, never run, not configured, unknown.
- Bank-update states: current, stale, error, never synced, manual/CSV.
- A schedule is never evidence that an update succeeded.
- Missing timestamps are described as unavailable; recency is never fabricated.
- Unknown or incomplete is never labelled healthy.
- The summary and the technical details must agree in every state.

## Forms and dialogs

- Forms keep drafts through conflicts and interrupted responses.
- Validation messages appear next to the field or action, not only in a toast.
- Save buttons disable while a request is in flight; stale revisions prompt a refresh rather than overwriting newer work.
- Dialogs trap focus, restore focus on close, and confirm before discarding edited content.
- Manual receipts can be income, a refund/reimbursement, or an own-account transfer. The category selector remains available for non-income receipts.
- Adding a transaction changes the transaction ledger; it does not silently change a dated account balance observation.

## Accessibility and interaction

- Minimum 44px touch targets for primary controls on phones; secondary disclosures keep at least a 24px target.
- Visible focus rings on buttons, links, inputs, selects, and summaries.
- No horizontal page overflow at 320, 390, 768, or 1440px.
- Motion respects `prefers-reduced-motion`.
- Automated checks cover keyboard workflows, dialog focus, 720px zoom proxy, and Axe A/AA in rendered states. Physical screen-reader and 200% browser zoom acceptance remain human checks.

## Responsive breakpoints

- `1180px` — tighten chart and metric spacing.
- `900px` — narrower sidebar, single-column charts, two-column forms.
- `768px` — tablet tables scroll inside their cards.
- `600px` — phone navigation, stacked tables, single-column forms, full-width primary controls.
- `420px` — transaction actions become one scrollable row.
- `360px` — reduced page padding and fully stacked selectors.

## Settled patterns to preserve

- Household, Peter, Maddie, and Joint are organisational views, not a privacy boundary. Say so once, in plain language.
- Account cash, budget allowance, and goal money set aside are distinct concepts and must never be presented as universally spendable.
- Projected and observed values are labelled separately.
- Rough estimates remain visibly separate from complete saves.
- The sample preview is clearly synthetic, does not write records, and never reveals saved balances.
- Every financial number should reconcile to the same integer-cent source across Overview, Transactions, Budgets, Bills, and export.


## Transaction and budget details

- Editable transaction rows keep merchant, category, date, amount, and review action visible. Ownership, split, bill/reimbursement links, and manual edit/removal are grouped under More actions.
- Split amounts are entered as positive values with an explicit Spent or Received direction. The interface converts direction to the established signed-cent representation when saving.
- Phone budget rows foreground planned amount, actual spending, and remaining allowance. Per-category unassigned projections remain available under Planning details.
