# Domain Docs

## Product and application layout

Read root `PLANS.md` before exploring, planning, ticketing, or implementing work. It is the authoritative product and technical plan. Future implementation tickets identify its relevant sections. Flag changed implementation decisions and record their reasoning and impact in section 6, preserving original reasoning.

The planned monorepo contains:

- `backend/`: Node.js and TypeScript API using Express, PostgreSQL, and Redis.
- `web/`: React, TypeScript, and Vite.
- `mobile/`: Flutter.

These applications have not been scaffolded at setup time. They share one product domain, so this repo uses one root `CONTEXT.md` and root `docs/adr/`. Application boundaries do not require separate domain contexts.

## Before exploring, read these

- Root `PLANS.md` for the agreed plan and decision log.
- Root `CONTEXT.md`, when present, for domain vocabulary and rules.
- ADRs in root `docs/adr/` that touch the area you are about to work in.

If `CONTEXT.md` or ADRs do not exist, proceed silently. `/domain-modeling` creates them lazily when terms or decisions get resolved. They clarify the agreed plan; avoid creating a competing specification or restarting discovery through Wayfinder. An ADR changing a planned implementation decision must also be referenced with its reasoning in the plan's decision log.

## File structure

```text
/
├── PLANS.md
├── CONTEXT.md
├── docs/adr/
├── backend/
├── web/
└── mobile/
```

This is the intended documentation/application layout, not a setup scaffolding instruction.

## Use the glossary's vocabulary

Use domain terms defined in `CONTEXT.md` when naming issues, hypotheses, proposals, and tests. Until a glossary exists, use `PLANS.md` terminology. Resolve gaps through `/domain-modeling` when needed, without restarting settled product discovery.

## Flag decision conflicts

If a proposal contradicts an existing ADR or `PLANS.md`, identify the affected decision and explain the proposed change and its impact. Preserve prior reasoning and record changed implementation decisions in `PLANS.md` section 6.
