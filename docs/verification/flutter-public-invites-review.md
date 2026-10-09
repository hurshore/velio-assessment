# Issue #8 implementation review

Fixed point: `5f059d5f3b4303aaf8a466db0646c254aa6a8f23`, the starting commit for this slice. Two independent code-review agents inspected the staged implementation against repository standards and issue #8/PLANS.md. The final committed comparison is `git diff 5f059d5...HEAD`.

## Standards

No hard documented-standard violations or concrete correctness blockers remain. The duplicated request-cancellation logic identified during review was moved into `BoundedHttp`, shared by readiness and guest traffic and verified with an actual TCP peer.

One optional **Primitive Obsession** heuristic remains: validated activity, inviter and booking data use maps, with repeated indexing/casts in the Flutter screen. Immutable typed fields could make future maintenance easier. Current boundary validation rejects malformed payloads, so this is retained as a nonblocking follow-up rather than expanding the slice.

## Spec

No unresolved specification findings. Review initially found that same-invitation refresh cleared visible context and that real-simulator losing-claim coverage bypassed the guest screen. The implementation now retains in-memory details/confirmation during failed refresh, labels stale availability and blocks fresh claims until revalidation. Regression checks cover both details and an existing confirmation. The simulator now sends the guest-screen claim after a real competing booking consumes the final seat, verifies the rejection and retained input/place, then refreshes to full.

Standards: zero hard violations, one optional maintainability suggestion. Spec: zero unresolved findings; both initial findings were fixed and rechecked.

## PR #21 corrective review

Fixed point: `ed98697e2457a99addd38240d8a8c1ab184d8ce9`; command `git diff ed98697` before committing, including new configuration/API/restore test files. Independent Standards and Spec agents reviewed the completed correction and rechecked repairs.

### Standards

Zero hard violations and zero new actionable heuristic findings. Typed maps remain a scoped #9 follow-up.

### Spec

Zero unresolved findings. Review found malformed URI decoding escaping feedback, insufficient saved event timestamp/field validation (including invalid offsets), pending recovery being hidden by restart lookup failure, and terminal rejection disabling recovery when local resolution failed. All were corrected and rechecked. New malformed-envelope and restart-timeout regressions preserve original recovery data.

Standards: 0 unresolved findings. Spec: 0 unresolved findings.
