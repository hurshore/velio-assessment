# Issue tracker: GitHub

Issues live in `hurshore/velio-assessment`. Use `gh` with explicit `--repo hurshore/velio-assessment` for issue commands. Implementation tickets and any parent/spec issue chosen for this work belong to the existing project below.

## Authoritative plan

Read root `PLANS.md` before `/to-tickets`, `/implement`, `/implement-spec`, or other planning/implementation work. It already defines product intent, scope assumptions, technical architecture and invariants, product flows, tracking, verification, and build sequence.

Every implementation ticket must link to `https://github.com/hurshore/velio-assessment/blob/main/PLANS.md` and identify relevant section numbers and headings. Use section anchors where helpful. Include acceptance criteria and validation derived from those sections. Parent/spec issues, if chosen, organize and reference the existing plan; they do not replace it. Follow section 5's build sequence, including the monorepo foundation before dependent features.

Flag proposed changes to implementation decisions and append the changed decision, reasoning, and impact to `PLANS.md` section 6. Preserve its original reasoning. Do not restart discovery through Wayfinder or create a competing specification.

## Existing GitHub Project

| Setting | Value |
|---|---|
| Repository | `hurshore/velio-assessment` |
| Project URL | `https://github.com/users/hurshore/projects/1` |
| Project owner | `hurshore` (user) |
| Project number | `1` |
| Project node ID | `PVT_kwHOA18OXc4BmNAy` |
| Status field node ID | `PVTSSF_lAHOA18OXc4BmNAyzhk28ZY` |

Use this project; do not create another. Project IDs and option IDs must come from GitHub, never from guesses or a different project.

Verified from GitHub on 8 October 2026: project title `Velio Engineering Assessment`. Project reads require appropriate read access; item/status writes require project write access. Report access failures explicitly.

Resolve metadata using this read-only GraphQL query through `gh api graphql`. Continue field pagination if `hasNextPage` is true; find the single-select field named `Status` and record all its options.

```graphql
query {
  user(login: "hurshore") {
    projectV2(number: 1) {
      id
      title
      url
      fields(first: 100) {
        nodes {
          ... on ProjectV2FieldCommon { id name }
          ... on ProjectV2SingleSelectField { options { id name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
```

Before publication, validate stored project, field, and option IDs against GitHub. Re-resolve and report drift if an ID is missing or belongs to a different field/project.

## Status mapping and maintenance

The following names, IDs, and order were independently re-read from GitHub after the approved setup on 8 October 2026.

| Project Status option | Option ID | Meaning |
|---|---|---|
| Backlog | `f75ad846` | Specified work with unresolved blockers |
| Ready | `2c793de4` | All blockers completed and available to start |
| In progress | `47fc9ee4` | Implementation has started |
| In review | `80146157` | Awaiting review or integration |
| Done | `98236657` | Reviewed, integrated, and verified |

### Board view

The existing `View 1` has view ID `PVTV_lAHOA18OXc4BmNAyzgL-IHc` and layout `BOARD_LAYOUT`. Its column field (`verticalGroupByFields`) is Status, ID `PVTSSF_lAHOA18OXc4BmNAyzhk28ZY`, with no view filter. The Status field defines the five columns above in that order. This configuration was verified through the GitHub API at setup; the existing view was preserved.

When repairing the board, reuse this view and check its layout, column field, filter, and Status options. Preserve unrelated views and options. Re-read and verify any configuration changes. Report view/project access failures rather than silently creating another project or hiding missing statuses.

Implementation agents must maintain and verify Status when publishing, starting work, requesting review, integrating, completing, reopening, or changing blockers:

- New specified tickets: Backlog while any blocker is unresolved; Ready when every blocker is completed and the work is available to start. A parent/spec issue follows its own lifecycle; organizing unfinished children is active work, not proof of completion.
- Before claiming a Ready ticket, refresh blocker states and verify it is available. Assign the driving developer and set In progress when implementation actually starts.
- Set In review when implementation is awaiting review or integration.
- Set Done only after review, integration, and required verification. Close the issue as completed and reconcile its board status; neither closing alone nor merging without verification proves Done.
- After a blocker completes, recheck affected unstarted tickets and move eligible tickets to Ready. Reopened/new blockers return unstarted tickets to Backlog. If work already started, retain its actual lifecycle status and report the blocker; do not hide implementation/review activity behind a readiness label.
- A blocker closed as not planned is not a completed dependency. Flag it and resolve/replan the requirement before declaring the dependent ticket Ready. Reopened work leaves Done and is classified by its current lifecycle and blockers.

The project Status describes workflow. Dependency relationships establish blocking; status never replaces those relationships. `ready-for-agent` certifies specification quality even when a ticket remains blocked in Backlog. Missing/inaccessible blockers mean readiness is unknown; report them and do not start the ticket.

## Publish tickets and reconcile project membership

Applies whenever `/to-tickets`, `/implement`, `/implement-spec`, or another skill publishes an implementation ticket or a chosen parent/spec issue. Treat issue creation, project membership, and status verification as one publication workflow. A URL alone is not successful publication.

1. Preflight repository and project access, resolve current IDs/options, and check intended dependencies. If project access fails, report the exact failure before creating issues.
2. Give each planned work item a stable key, e.g. `velio-assessment/monorepo-foundation`. Store it in the issue body as `<!-- velio-work-item: <key> -->`. Use a distinct stable key for a chosen parent/spec issue. Search all repository issues, open and closed, across all pages; compare the exact marker in issue bodies and exclude pull requests. Reuse a unique match. Multiple matches require reconciliation, not another issue. Inspect any existing matching closed issue instead of recreating it.
3. Serialize publication for each stable key; GitHub issue titles/markers do not provide atomic uniqueness. Recheck immediately before creation. Create only when absence is established, using `gh issue create --repo hurshore/velio-assessment --title '<title>' --body-file <file>`. Preserve the resulting URL. If a request times out or its result is ambiguous, re-query the exact key and recover the existing issue; never blindly retry creation. Report unresolved ambiguity and stop that publication.
4. Establish and verify blocker relationships using the dependency section below before computing initial readiness. Reused issues retain their current lifecycle; do not reset active/reviewed work to a new-ticket status.
5. Enumerate project items with GraphQL cursor pagination to exhaustion and match issue node ID or exact issue URL, including archived items. Reuse the matching item ID. Restore an archived matching item when returning it to active work; do not add a second item. If no item exists, add the issue using `gh project item-add 1 --owner hurshore --url <issue-url> --format json`. Serialize this operation, and recover ambiguous results by re-reading membership before retrying. Report any multiple matches for reconciliation.
6. Set the appropriate status using the resolved IDs:

   ```sh
   gh project item-edit --id <item-id> --project-id <project-id> --field-id <status-field-id> --single-select-option-id <status-option-id>
   ```

7. Re-read the project item from GitHub. Verify its project ID, issue node ID/URL, and Status field/option ID match the intended values. A successful mutation response alone is insufficient. Report the issue URL, membership, verified status, and blockers.

For full issue enumeration, use `gh api --paginate 'repos/hurshore/velio-assessment/issues?state=all&per_page=100'`. Follow GraphQL `pageInfo.hasNextPage`/`endCursor` for project items; a fixed CLI result limit is not complete enumeration.

If any step after issue creation fails, report the issue URL and exact incomplete operation. Keep the existing issue for repair. Retry by locating that same issue and project item, then repairing only missing operations. Do not silently leave issues outside the project or call incomplete publication successful.

## Dependencies and ready frontier

These rules apply to `/to-tickets`, `/implement`, and `/implement-spec` and any agent selecting implementation work.

Use native GitHub issue dependencies where supported. Parent/child hierarchy groups work; it does not itself establish a blocking relationship. Add edges explicitly between prerequisite issues and dependent issues. Guard against self-dependencies and cycles.

- List a ticket's native blockers with `gh api --paginate 'repos/<owner>/<repo>/issues/<number>/dependencies/blocked_by?per_page=100'` and consume every page. Fetch the actual blocker issues and check their current states and completion reason. Read-only listing failure must never be interpreted as zero blockers. The dependency summary count is a hint, not the readiness authority.
- Resolve a blocker's numeric database `id` through `gh api repos/<owner>/<repo>/issues/<number> --jq .id`. This differs from both the issue number and GraphQL node ID.
- Before adding an edge, list existing blockers and reuse an existing edge. Add only missing edges with `gh api --method POST repos/<owner>/<repo>/issues/<dependent-number>/dependencies/blocked_by -F issue_id=<blocker-database-id>`. Re-read the list to verify the relationship. After an ambiguous/duplicate response, check existing edges before retrying.
- If native dependencies are confirmed unavailable, report the reason and record an explicit `Blocked by:` section near the top of the dependent issue with full issue links and a `Dependency tracking: linked fallback` marker. Preserve it on edits. Add links once and verify the saved body. Fetch every linked blocker and check its actual state and completion reason. Report fallback use in publication and readiness results.
- Authentication, authorization, network, or unreadable-issue errors are not evidence that dependencies are unsupported. Fix/report those errors and leave readiness unknown. Use a linked fallback only after native unavailability is established; retain readable native edges when present, and account for any documented fallback blockers too.

For frontier selection, enumerate the chosen parent issue's children or explicit linked task list completely, with pagination for API lists. If no parent was chosen, use the plan-derived implementation ticket set in this project. Read each candidate's current issue, assignment, lifecycle, and complete blocker list. Eligible work is open, sufficiently specified, unclaimed, available, and has every blocker completed. Use `PLANS.md` section 5 order and documented ticket order to break ties. Recheck eligibility before assigning work. Board Ready alone does not establish eligibility.

After a dependency change, reconcile the board status under the maintenance rules and verify the result. When completing work, recheck newly unblocked dependent tickets. A missing or inaccessible dependency blocks the readiness decision rather than disappearing from it.

## Routine issue operations

Use `gh issue view <number> --repo hurshore/velio-assessment --comments` to fetch a ticket. Use `gh issue edit` for body, labels, and assignments; `gh issue comment` for updates; and `gh issue close` for completed work, always with the explicit repository. Write multiline bodies/comments to a temporary Markdown file and pass `--body-file`; preserve exact newlines. Keep existing author content and workflow markers when editing. Repeat label/assignment updates by reconciling the desired state, not by creating new issues.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## API references

- [GitHub issue dependency endpoints](https://docs.github.com/en/rest/issues/issue-dependencies)
- [GitHub CLI project item editing](https://cli.github.com/manual/gh_project_item-edit)
