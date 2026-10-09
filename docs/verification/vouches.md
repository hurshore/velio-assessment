# Recipient-bound vouches — issue #6

Scope: PLANS.md §§1.2, 2.2, 2.4, 2.6, 2.9, 3.4 and 4.1. Node 24.21.0 and PostgreSQL 17.6. Real HTTP requests run with runtime credentials against a disposable database (`backend/test/vouches.test.ts`). The web uses jsdom component tests with a stubbed `fetch` (`web/src/VouchShare.test.tsx`, `web/src/GuestInvite.test.tsx`, `web/src/HostApp.test.tsx`).

## Verified behaviour

- **Creation.** A host or confirmed booker in treatment creates a vouch for one contact. Email input is lowercased and phone input stripped to digits, and the creator's response echoes the normalized contact. Expiry is exactly 24 hours, or the activity start if that is sooner. Creating a vouch reserves no seat. The rules match public sharing: outsiders, control activities and a disabled creation switch get 403 `INVITE_CREATION_UNAVAILABLE`, and a full activity gets 409 `SOLD_OUT`. A missing or malformed contact gets 400. So does a contact sent on a public link, and vouching for one's own contact gets 403 `SELF_INVITE`.
- **Recipient matching.** Identities with no contact or a different contact get 403 `RECIPIENT_MISMATCH`, and the message never contains the intended contact. These claims consume no seat and no redemption. The matching identity's claim commits with a `vouch` redemption, and its contact may differ in case from the one entered. After a direct booking fills the last seat, the recipient's retry with the same key, or with a new key, returns the same booking and redemption (200, `replayed`). Another identity presenting the used code still gets `RECIPIENT_MISMATCH`, and one redemption remains.
- **Race.** The activity row is held locked from outside while the same requests queue behind it, against 7 seats:
  - 8 recipient claims (4 with one shared key, 4 with fresh keys)
  - 6 claims from wrong recipients
  - 6 direct bookings

  At least 10 lock waiters are confirmed. Result:
  - The recipient's 8 requests commit exactly one booking (one 201) and converge on one redemption.
  - Every wrong-recipient request gets `RECIPIENT_MISMATCH`.
  - All 6 direct bookings commit.
  - There is exactly one redemption, and reconciliation is clean at 7 bookings.

  Contention for the last seat is covered separately: direct bookings and claims race in the public-invite suite, and the recipient-reopens-when-full scenario covers the full activity.
- **Rollback.** A failure injected on the outbox insert returns a retryable 500 and rolls back the booking, the count and the vouch redemption. The same key then succeeds.
- **Expiry at transaction time.** A vouch previews as `valid` and is moved to expire 500 ms later. A recipient claim after that time gets 410 `INVITE_EXPIRED`, and nothing is consumed.
- **Existing booking.** A recipient who already holds a direct booking gets it back with `redemption: null`. The vouch is not consumed and their attribution is unchanged.
- **Signup.** A vouch `inviteCode` with no contact, or with a different one, gets 403 `RECIPIENT_MISMATCH`. A matching signup is acquired at generation 1 with rail `vouch`, and `signup_attribution` matches. A second identity with the same contact gets 409 `CONTACT_IN_USE`. Identity responses do not include `contact`.
- **Privacy and events.** The preview returns `rail`/`trust` `vouch` and contains no contact. A duplicate `invite_opened` event ID is deduplicated. `invite_created`, `invite_opened`, `identity_created`, `invite_claim_attempted`, `booking_failed` (code `RECIPIENT_MISMATCH`) and `spot_claimed` (generation 1) all carry `rail: "vouch"`, and none contains the contact.
- **Database guards.**
  - A runtime insert of a vouch redemption for a non-matching invitee is refused by a trigger.
  - A second vouch redemption, for a different invitee with that invitee's own booking, is refused with constraint `invite_redemptions_one_vouch`. The recipient trigger is disabled inside a rolled-back transaction for that one statement, because unique contacts mean no second identity could match. Every other key is satisfied, so the named index is what rejects the row.
  - A runtime update of `invites.recipient_contact` or `users.contact` gets permission denied.
  - A migration-role update of an invite's recipient is refused as append-only.
  - A vouch invite without a recipient fails `invites_vouch_recipient`.
  - A forged vouch-acquired user with another contact is refused by a trigger.
- **Regression.** `backend/test/invites.test.ts` is unchanged and its 25 public-link scenarios pass, including distinct public guests, races, recovery, rollback, attribution and immutability. Its `rail: "vouch"` request with no contact still returns 400, now because the contact is missing rather than because the rail is unsupported.
- **Contact validation.** These are rejected with 400 `INVALID_REQUEST` on both vouch creation and signup, instead of the previous 500 from the database check:
  - U+0085
  - NUL
  - U+2028
  - no-break space
  - zero-width space
  - BEL
  - ideographic space
  - BOM

  International contacts are accepted: `José@Exämple.com`, `üser@例え.jp`, `+44 20 7946 0958`, `08035550101`. Phone input keeps its existing normalization: whitespace and punctuation are stripped before the digits-only check. A sweep of every BMP code point in each email position (local part, domain and suffix — 190,461 values) shows that `contact()` and `is_demo_contact` agree everywhere.
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
  - Identity creation sends `contact` only when one is entered. Both forms explain that matching ignores case, spaces and punctuation but nothing else, so the formats must match.
  - The contact input is `aria-invalid` and described by the validation error, and focus returns to it. Creation is announced in a persistent status region.
  - The created link is labelled "Vouch link for <contact>". Editing the contact hides it and announces that the earlier vouch remains valid until it expires.
  - The draft, an in-flight creation (button stays disabled) and the created result survive "Refresh details", which remounts the view. Switching identity resets them. The contact is read-only while a creation is pending. A late response is ignored even after switching away and back to the same identity, because each identity session has its own token.

## Commands and results (9 October 2026, after review corrections)

- `npm run typecheck`: passed.
- `npm test`: passed with none skipped:
  - 12 root tests
  - 118 backend tests, 12 of them vouch scenarios
  - 103 web tests
- The public-invite, vouch and booking suites were run again together (55 tests) and passed.
- `npm run build`: passed.
- `npm run mobile:check`: 13 Flutter tests passed. No Flutter files changed.
- `npm run migrate` applied `010` and then `011` to the existing local dev database.

## Not verified here

- Rendering in a real browser, and clipboard permissions.
- Claiming a vouch in the Flutter app. Flutter identity creation also needs the optional `contact` field (#8).
- Real contact verification. This is outside the assessment, and the demo states this on both the share panel and the preview.
- Follow-ups not built in this correction:
  - Invite-history management. Earlier vouches are not listed after they are replaced or hidden; they stay valid until they expire.
  - Staged production migrations (`NOT VALID`/`CONCURRENTLY`).
  - Phone canonicalization. Matching is exact in format.
  - Verified contacts and rate limits against contact enumeration.
