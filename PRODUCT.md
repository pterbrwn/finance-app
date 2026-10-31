# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Peter and his fiancée use Ledger to manage and understand their household finances. His fiancée is not especially comfortable with technology, so the product must make common tasks and financial concepts easy to understand without technical knowledge.

## Product Purpose

Ledger brings household financial records and planning into one self-hosted dashboard. It helps the couple review accounts and spending, manage budgets and savings goals, understand investments, and plan housing decisions. Success means both can understand the information and use the product confidently, including the less technical user.

## Positioning

Ledger combines day-to-day finance management and longer-term household planning in a private dashboard hosted on the household’s own Jetson. It supports manually recorded data, CSV imports, and optional Plaid connections, with local financial records and calculations.

## Operating Context

The app runs on the household’s Linux Jetson. It is available locally over loopback and remotely through private Tailscale access. Remote users need to be connected to Tailscale. The dashboard supports individual and joint record ownership; profile selection is organizational and is not a privacy boundary.

## Capabilities and Constraints

- Dashboard areas include Overview, Transactions, Budgets, Accounts, Investments, Goals, Home planner, and Settings.
- Users can add accounts manually, import and review CSV transactions, optionally connect supported institutions through Plaid, categorize and review transactions, and export filtered transactions to CSV.
- Budget plans, savings allocations, investments, property records, and home scenarios support household planning. Scenarios are estimates, not approval decisions.
- Financial records and credentials are stored on the Jetson. The database is not encrypted at rest by Ledger; device and backup security depend on operating-system controls and disk encryption.
- Plaid may process bank data when enabled. Bank sync is optional and must only be enabled after connection and recovery checks.
- Do not expose the app publicly or use Tailscale Funnel or public port forwarding. Do not place financial data, credentials, private configuration, or production records in the repository or sample fixtures.
- Balances, transaction totals, and projections follow the explicit rules documented in README.md. Stale, missing, excluded, and non-USD data must remain distinguishable; hypothetical values must not be presented as actual records.

## Brand Commitments

The interface should look world-class and feel enjoyable to use, while remaining conceptually simple for a less technical household member. No particular visual direction is established here.

## Evidence on Hand

The implemented app and README document the finance dashboard, import and account workflows, financial calculation rules, privacy boundaries, and deployment model. Real financial records and credentials live only in private runtime storage; they must not be copied into repository examples or fabricated as sample evidence.

## Product Principles

- Make routine finance tasks understandable without technical knowledge.
- Present actual records, estimates, stale data, and missing data clearly.
- Keep financial data and access private to the household.
- Preserve transparent, consistent financial calculations across dashboard views.
- Support both everyday money management and longer-term household planning.

## Accessibility & Inclusion

Simple, conceptually clear workflows are a product requirement for a nontechnical household member. No formal accessibility conformance target or individual accommodation has been specified.
