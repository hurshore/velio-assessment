# Recipient-bound vouches — issue #6

Scope: PLANS.md §§1.2, 2.2, 2.4, 2.6, 2.9, 3.4 and 4.1. Node 24.21.0 and PostgreSQL 17.6. Real HTTP requests run with runtime credentials against a disposable database (`backend/test/vouches.test.ts`). The web uses jsdom component tests with a stubbed `fetch` (`web/src/VouchShare.test.tsx`, `web/src/GuestInvite.test.tsx`, `web/src/HostApp.test.tsx`).

## Verified behaviour

- **Creation.** A host or confirmed booker in treatment creates a vouch for one contact. Email input is lowercased and phone input stripped to digits, and the creator's response echoes the normalized contact. Expiry is exactly 24 hours, or the activity start if that is sooner. Creating a vouch reserves no seat. The rules match public sharing: outsiders, control activities and a disabled creation switch get 403 `INVITE_CREATION_UNAVAILABLE`, and a full activity gets 409 `SOLD_OUT`. A missing or malformed contact gets 400. So does a contact sent on a public link, and vouching for one's own contact gets 400 `SELF_INVITE`.
- **Recipient matching.** Identities with no contact or a different contact get 403 `RECIPIENT_MISMATCH`, and the message never contains the intended contact. These claims consume no seat and no redemption. The matching identity's claim commits with a `vouch` redemption, and its contact may differ in case from the one entered. After a direct booking fills the last seat, the recipient's retry with the same key, or with a new key, returns the same booking and redemption (200, `replayed`). Another identity presenting the used code still gets `RECIPIENT_MISMATCH`, and one redemption remains.
- **Race.** The activity row is held locked from outside while the same requests queue behind it: 8 recipient claims (4 with one shared key, 4 with fresh keys), 6 claims from wrong recipients and 6 direct bookings, all against 2 seats. At least 10 lock waiters are confirmed. Result: the recipient's 8 requests converge on one booking (or all get `SOLD_OUT` if they lose the race), every wrong-recipient request gets `RECIPIENT_MISMATCH`, and there is at most one redemption. Reconciliation is clean at 2 bookings. The race test passed in three consecutive focused runs.
- **Rollback.** A failure injected on the outbox insert returns a retryable 500 and rolls back the booking, the count and the vouch redemption. The same key then succeeds.
- **Expiry at transaction time.** A vouch previews as `valid` and is moved to expire 500 ms later. A recipient claim after that time gets 410 `INVITE_EXPIRED`, and nothing is consumed.
- **Existing booking.** A recipient who already holds a direct booking gets it back with `redemption: null`. The vouch is not consumed and their attribution is unchanged.
- **Signup.** A vouch `inviteCode` with no contact, or with a different one, gets 403 `RECIPIENT_MISMATCH`. A matching signup is acquired at generation 1 with rail `vouch`, and `signup_attribution` matches. A second identity with the same contact gets 409 `CONTACT_IN_USE`. Identity responses do not include `contact`.
- **Privacy and events.** The preview returns `rail`/`trust` `vouch` and contains no contact. A duplicate `invite_opened` event ID is deduplicated. `invite_created`, `invite_opened`, `identity_created`, `invite_claim_attempted`, `booking_failed` (code `RECIPIENT_MISMATCH`) and `spot_claimed` (generation 1) all carry `rail: "vouch"`, and none contains the contact.
- **Database guards.**
  - A runtime insert of a vouch redemption for a non-matching invitee is refused by a trigger.
  - A second vouch redemption is refused by the partial unique index.
  - A runtime update of `invites.recipient_contact` or `users.contact` gets permission denied.
  - A migration-role update of an invite's recipient is refused as append-only.
  - A vouch invite without a recipient fails `invites_vouch_recipient`.
  - A forged vouch-acquired user with another contact is refused by a trigger.
- **Regression.** The public-invite suite (25 scenarios) and the booking suites pass unchanged. Its only adjustment is that the existing test still rejects a `vouch` request with no contact.
- **Web.**
  - Before creation, the vouch panel explains:
    - recipient matching
    - personal-vouch trust
    - that contacts are not verified in this demo
    - single use and the 24-hour/activity-start expiry
    - that no seat is reserved
    - the seats remaining
  - It sends `{rail: "vouch", recipientContact, platform, journeyId}`. It then shows the intended contact to its creator, with the link and the grouped code.
  - An empty contact is caught before any request. Server rejections keep the contact that was entered. A full activity disables creation.
  - The public panel keeps its own state.
  - The guest preview says "vouched for you" and explains recipient-bound demo matching without any contact.
  - Identity creation sends `contact` only when one is entered.

## Commands and results (9 October 2026)

- `npm run typecheck`: passed.
- `npm test`: 12 root tests, 116 backend tests (10 of them vouch scenarios) and 100 web tests passed, none skipped.
- `npm run build`: passed.
- `npm run migrate` applied `010_recipient_bound_vouches.sql` to the existing local dev database.
- `npm run mobile:check` was not run. No Flutter files changed in this lane.

## Not verified here

- Rendering in a real browser, and clipboard permissions.
- Claiming a vouch in the Flutter app. Flutter identity creation also needs the optional `contact` field (#8).
- Real contact verification. This is outside the assessment, and the demo states this on both the share panel and the preview.
