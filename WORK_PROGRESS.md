# Work Progress

Running log of what has been built on the Apollo Candidate Sourcing app.
Newest entry first. Branch: `dev-branch`.

---

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
