# Work Progress

Running log of what has been built on the Apollo Candidate Sourcing app.
Newest entry first. Branch: `dev-branch`.

---

## 2026-09-13 — In progress (uncommitted)

Webhook delivery-failure handling and configuration docs. Keeps the Cloudflare
Quick Tunnel as the local dev webhook; no change to the webhook implementation.

- **Delivery loss is now detected** — `src/enrichment.js` gains
  `deliveryShortfall()` and `deliveryShortfallMessage()`. Apollo posts the found
  contact data to `APOLLO_WEBHOOK_URL` and charges either way; polling returns
  only person IDs and a tally. `pollWaterfallResult` already computed that tally
  (`summary.creditsConsumed`, `delivery.status`) and the API already forwarded
  it — nothing read it. So a tunnel that died mid-job reported "Apollo holds no
  phone number for these candidates": a false negative on data just paid for.
- **Those rows are no longer marked answered** — `src/App.jsx` applies a lost
  result with no `phoneChecked` mark, so the row stays unanswered instead of
  claiming no number exists. The recruiter is told which env var to fix and that
  the API server must restart.
- **Pre-flight guard unchanged** — `webhookUnreachableReason` already refuses a
  dead hostname before spending, naming it. That covers the URL changing between
  requests; the new code covers it changing mid-request, which a probe cannot.
- **Docs** — README gains a "Webhook configuration" section: the URL is env-only
  and used verbatim, the quick tunnel hostname is temporary and changes on every
  restart, and deployment swaps in a permanent HTTPS URL with no code change.
  `.env.example` carries the same warning where it is actually read.
- **Tests** — 7 added to `src/enrichment.test.js` (253 passing: 121 server, 132
  UI). Covers charged-but-undelivered, Apollo-stated failure, genuine empty
  result, webhook-delivered, unfinished jobs, and email/phone kind separation.

**Search other sources: wired up, tested against live Apollo, removed.**

Added as a third spending button, then removed the same day once live testing
showed what Apollo actually does with it.

- **The finding.** Three candidates were searched. Every stored record came back
  `vendors: [{"name":"Apollo","status":"VERIFIED","statusCode":"apollo_step_success"}]`
  — only Apollo ran, no third-party vendor was queried on any of them. Apollo's
  waterfall stops as soon as its own step finds an address; it searches for *an*
  email, not a *personal* one. All three already had a work address, so it was
  satisfied before reaching the vendors that were the whole point.
- **Why that kills the feature as offered.** For any candidate Apollo already
  holds an email for, the route costs more than a reveal and returns what a
  reveal returns. The app's search asks Apollo for people whose address it rates
  verified or likely, so that is most of them.
- **It corrected an earlier mistake of mine.** When wiring it up I argued a
  reveal first was wasteful because the waterfall does one anyway, so the button
  was offered on every candidate. The evidence inverts that: an email already on
  file is precisely what *stops* the waterfall. Gating should have been to
  `hasEmailOnFile: false`, not to everyone.
- **Not a delivery failure.** The tunnel was up, the webhook delivered, and the
  records are in the store. The empty result was real.
- **Removed:** button, `searchOtherSources`/`runSourceSearch`, `sourceIds`,
  `WATERFALL_LIMIT`, `idsToSearchSources`, the `.reveal.deep` style, and the 11
  tests covering them. Back to 253 passing (121 server, 132 UI).
- **Kept:** the backend route, parser and polling (untouched and still tested);
  `collectAsyncJobs`, now phone-only; and `deliveryShortfall`, which the phone
  path uses.
- **Open question if revisited:** whether the waterfall reaches outside vendors
  for a candidate with no email on file. Never tested. Gate to those candidates
  and confirm a non-Apollo name appears in `vendors` before trusting it.

## 2026-09-11 — In progress (uncommitted)

Multi-location search plus chip editing for list fields. 6 files changed, ~340 lines.

- **Multi-location search** — `server/apolloService.js` splits the Location field
  on commas and sends every value as `person_locations`. Apollo ORs that list the
  same way it ORs `person_titles`, so more cities widen the pool: measured on one
  job title, Hyderabad alone returned 444 and Hyderabad + Bangalore + Pune
  returned 1,971. Only cities the recruiter actually typed are sent — no radius,
  no neighbouring-city expansion.
- **Location validation counts a list, not text** — `server/index.js` treats
  `" , , "` as no location instead of letting punctuation satisfy the required
  filter and then sending Apollo nothing. Field length raised to 400 characters
  for the comma-separated fields (role, skills, location).
- **Removable chips** — `src/App.jsx` renders Location and Skills as
  de-duplicated chips with an `×`, so one value can be dropped without retyping
  the rest.
- **Markup and layout cleanup** — wrapping `<label>` replaced with
  `htmlFor`/`id` pairs, header and search-button rows restructured, ~114 lines of
  supporting CSS.
- **Tests** — 61 lines added to `server/index.test.js`, 102 lines to
  `src/App.test.jsx` covering the above.

Next: run the full suite (`npm test`) and commit.

## 2026-09-11 — `574e315` added dropdown in roles and the skills

Suggestion dropdowns on the Role / Job Title and Skills fields, so common values
can be picked instead of typed.

## 2026-09-11 — `f07a822` phone number is fetching for the candidate

Phone number retrieval for enriched candidates. Phone reveal is asynchronous at
Apollo, so it lands on its own path rather than inside plain enrichment, and
`reveal_phone_number` stays `false` on the enrich and reveal routes.

## 2026-09-09 — `53fa4aa` Add Apollo candidate sourcing application

Initial application.

- React + Vite frontend, Express backend. The browser never calls Apollo
  directly and never visits or scrapes LinkedIn; `APOLLO_API_KEY` stays on the
  server.
- Recruiter flow: search → review results → select candidates → enrich only the
  selected Apollo Person IDs. Search never enriches.
- Credit guards: at most 25 IDs per enrich request (the remainder returned as
  `skippedIds`, never dropped), forwarded to Apollo in batches of 10, and a
  failed batch does not discard the batches that succeeded.
- Routes: `POST /api/candidates/search`, `/enrich` (`reveal_personal_emails:
  false`), and `/reveal` — the only route that spends contact credits, reached
  only from an explicit recruiter action.
- Apollo responses normalized into an application-owned candidate model before
  reaching the browser; missing fields show as `Not available`.
- Per-session enrichment state per Person ID (`not_enriched` / `enriching` /
  `enriched` / `failed`) with per-candidate retry and refresh.
- Tests on both sides: `npm run test:server` (node --test) and `npm run test:ui`
  (vitest).
