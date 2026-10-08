# Contributing

Read [AGENTS.md](AGENTS.md) and [CODING_STANDARDS.md](CODING_STANDARDS.md) before implementation or review. [PLANS.md](PLANS.md) remains the canonical assessment specification. Follow [the issue tracker instructions](docs/agents/issue-tracker.md) for dependencies, project membership, readiness, and lifecycle maintenance; this document adds contribution conventions without replacing that workflow.

## Branches

Use `<type>/<issue-number>-<short-kebab-description>` for issue-backed implementation. Choose `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, or `perf` according to the change. For example, `feat/42-monorepo-foundation` uses an illustrative issue number; use the actual originating issue number for real work.

For work without an issue, omit the number: `docs/contribution-conventions`.

Before implementation, inspect the current branch and working tree. When starting from `main`, create an appropriate feature branch. Preserve existing implementation work and an appropriate ticket branch or worktree. Keep unrelated tickets on separate branches.

## Commits

Use `<type>(<optional-scope>): <description>`, with the same types as branches. The scope is optional: write `docs: define contribution and coding conventions` when a scope adds no value. Useful monorepo scopes include `backend`, `web`, `mobile`, `infra`, and `repo`.

Use a concise imperative description without a trailing period. Keep each commit focused on a coherent change. For issue-backed work, include `Refs #<issue-number>` in the commit body so the originating requirement is discoverable. Use the body for meaningful rationale or trade-offs when needed; omit boilerplate.

## Pull requests

Normally create one PR per implementation ticket. Use the commit title convention and describe the delivered outcome. Use [the PR template](.github/pull_request_template.md), keeping the description proportional to the change and removing inapplicable guidance.

- Lead with the problem and resulting behavior.
- Reference the originating issue and relevant `PLANS.md` sections. Use `Closes #<issue-number>` only when the PR fully resolves the issue; otherwise use a reference that does not close it.
- Report checks actually run and their results. State unrun checks, relevant unverified behavior, and material limitations honestly.
- Explain meaningful deviations and trade-offs. Record changed implementation decisions in `PLANS.md` section 6, preserving the original reasoning. Leave out conversational history, abandoned approaches, and exhaustive file lists.

After implementation, checks, and review, push the ticket branch and open its PR. Do not automatically merge it. Follow the existing GitHub Project lifecycle: reviewed code awaiting integration remains **In review**; **Done** requires integration and verification under the issue tracker instructions.
