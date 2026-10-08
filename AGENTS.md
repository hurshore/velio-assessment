## Agent skills

### Contribution and coding conventions

Before implementation or review, read and follow `CONTRIBUTING.md` and `CODING_STANDARDS.md`. When creating PRs, use `.github/pull_request_template.md`.

### Implementation plan

Read root `PLANS.md` before planning, ticketing, or implementing work. It is the authoritative product and technical plan. Tickets must identify relevant sections. Flag proposed deviations and record their reasoning in section 6, the decision log, preserving the original reasoning. Implement the existing plan without generating a competing specification or restarting discovery through Wayfinder.

### Issue tracker

Track work in GitHub Issues for `hurshore/velio-assessment` and the existing GitHub Project owned by `hurshore`, number `1`. Before publishing, claiming, or updating tickets, read `docs/agents/issue-tracker.md` for project membership, status, dependency, and repeatability rules.

### Triage labels

Use the five default triage labels. Before triaging issues, read `docs/agents/triage-labels.md`. `ready-for-agent` means sufficiently specified; dependency checks determine readiness to start.

### Domain docs

The planned `backend/`, `web/`, and `mobile/` applications share one product domain. Use a single-context layout: root `CONTEXT.md` and `docs/adr/`. Before exploring the codebase, read `docs/agents/domain.md`.
