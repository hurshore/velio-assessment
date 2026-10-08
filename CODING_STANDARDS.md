# Coding standards

Apply these readability and comment principles in TypeScript, Dart, SQL, and configuration files.

## Readability

Prefer clear names, straightforward control flow, and small coherent functions. Comments should support reading understandable code, rather than substitute for it. A comment or documentation block is not required for every function.

## Comments

Add comments when they explain intent, non-obvious behavior, constraints, invariants, or a decision the code alone does not make clear. Avoid narrating obvious statements or repeating function names, types, or implementation details already apparent from the code.

Keep comments concise by default. Longer explanations are appropriate when complexity warrants them, especially around concurrency, transaction ordering, idempotency, attribution, or recovery. Explain the constraint or reason the reader needs to preserve.

Update or remove comments when behavior changes so they remain accurate. Put extended architectural reasoning in [PLANS.md](PLANS.md), relevant ADRs under `docs/adr/`, or other documentation, with a short reference in code where useful. `PLANS.md` remains the canonical assessment specification; follow its decision-log rules for changes to planned decisions.
