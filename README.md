# Apollo Candidate Sourcing

Candidate search and selective enrichment through a server-side Apollo API integration. Recruiters search, select, enrich, and review Apollo-provided professional information without leaving this application. The frontend never calls Apollo directly and never visits or scrapes LinkedIn.

## Local setup

1. Copy `.env.example` to `.env` and set `APOLLO_API_KEY` on the server only.
2. Run `npm install`.
3. Run `npm run dev`.
4. Open `http://localhost:5173`.

Production build: `npm run build`
Tests: `npm test` (`npm run test:server` for the API, `npm run test:ui` for the UI)

## Recruiter flow

```text
Search Candidates -> Apollo People Search -> results table
  -> recruiter selects candidates
  -> Enrich Selected -> Apollo People Bulk Match
  -> Enriched Details shown inline, under the candidate row
```

Search never enriches. Enrichment is sent only for the Apollo Person IDs the recruiter explicitly selected.

## Enrichment in the UI

The results table has six columns: select, Candidate, Company, Location, Contact, and **Enriched**. Contact stacks the email, phone, and LinkedIn values under their own labels, which keeps the table inside a 1366px laptop with no horizontal scrolling. Below 900px each row becomes a card with every value labelled.

| State | Badge | Row controls |
|---|---|---|
| `not_enriched` | Not enriched | none |
| `enriching` | Enriching... | none, actions disabled |
| `enriched` | Yes | View details / Hide details, Refresh from Apollo |
| `failed` | Enrichment failed | Retry |

A successful enrichment opens the details panel automatically, since the recruiter just asked for that data.

Expanding an enriched candidate shows an **Enriched Details** panel containing the professional headline, seniority, department, skills, current employment, previous employment, email, phone, and the Apollo-provided LinkedIn URL. Any field Apollo did not return displays `Not available`. Nothing in this panel is inferred, reconstructed, or derived from a LinkedIn page.

Enrichment state is tracked per Apollo Person ID for the session. An already-enriched candidate is not sent to Apollo again unless the recruiter clicks **Refresh from Apollo**. A candidate Apollo returned no match for is marked `failed`, stays in the results, and can be retried individually.

## API

- `POST /api/candidates/search` accepts `jobTitle`, `location`, `seniority`, `keywords`, `company`, `industry`, and `page`. It returns `{ candidates, page, perPage, total }`. `jobTitle`, `location` and `keywords` are **required**; `company`, `industry` and `seniority` only narrow an already valid query. Apollo bills for every search, so a request missing any required filter answers `400` with `{ error, missing }` and never calls Apollo. The Search button stays disabled, listing what is still needed, until all three are filled in.
- `POST /api/candidates/enrich` accepts an explicit `ids` array and returns `{ requestedIds, candidates, failedIds, skippedIds }`. It sends `reveal_personal_emails: false`, so it never spends Apollo's contact credits.
- `POST /api/candidates/reveal` takes the same body and answers in the same shape plus `revealedPersonalEmails: true`. It is the only route that sends `reveal_personal_emails: true`, and it is reached only from the recruiter's explicit **Reveal contact details** action - never from search and never from plain enrichment. Both routes share the 25-per-request cap and the batching of 10, and both keep `reveal_phone_number: false`; phone reveal is asynchronous and lands separately.

`requestedIds`, `failedIds`, and `skippedIds` together account for every ID the client sent, so no selected candidate is silently dropped. `skippedIds` holds anything beyond `MAX_ENRICH_PER_REQUEST` (25), which the recruiter can enrich in a second pass.

The backend maps search to Apollo `POST /mixed_people/api_search` and enrichment to Apollo `POST /people/bulk_match`. Selections larger than `BULK_MATCH_BATCH_SIZE` (10) are split into sequential Apollo batches, for example 23 IDs become 10 + 10 + 3, with no candidate lost or duplicated between batches. A batch that fails does not discard the batches that succeeded; if every batch fails, the Apollo failure is surfaced to the recruiter.

Each candidate is normalized into an application-owned model before reaching the browser:

```json
{
  "id": "apollo-person-id",
  "requestedId": "apollo-person-id",
  "name": "Candidate Name",
  "title": "Senior Java Developer",
  "headline": "Senior Java Developer | Java | Spring Boot",
  "company": "Example Co",
  "location": "Hyderabad",
  "seniority": "senior",
  "departments": ["engineering"],
  "skills": ["Java", "Spring Boot"],
  "linkedinUrl": "https://www.linkedin.com/in/example",
  "email": null,
  "phone": null,
  "emailAvailable": true,
  "phoneAvailable": false,
  "employmentHistory": [
    { "organization": "Example Co", "title": "Senior Java Developer", "startDate": "2021-01-01", "endDate": null, "current": true }
  ],
  "enriched": true
}
```

`requestedId` is the ID the recruiter selected, which lets the client reconcile a response even when Apollo echoes a different canonical person ID. Raw Apollo responses are never returned to the frontend.

## LinkedIn policy

LinkedIn URLs are displayed only when Apollo returns them, as a normal external link for the recruiter to open manually. The application does not fetch, crawl, parse, or automate LinkedIn, does not open profiles automatically, and does not use iframes. Every enriched field comes from Apollo. `server/apolloService.test.js` asserts that every outbound request goes to `api.apollo.io` and that no LinkedIn URL is ever sent anywhere; `src/App.test.jsx` fails the run if the client requests any host other than our own backend.

## Security and limitations

`APOLLO_API_KEY` is read only by `server/apolloService.js`, is excluded from Git by `.gitignore`, and is never included in frontend code, browser storage, or API responses. `server/index.test.js` asserts this against both the API responses and the shipped frontend sources. Contact fields remain Apollo-controlled and are not reconstructed when masked or missing: the `email_not_unlocked@` sentinel is discarded rather than shown as an address, and `email_status: "unavailable"` reads as unavailable. An address is taken from whichever shape Apollo returned it in — `email`, `personal_emails`, or `contact_emails` — with the masked and unavailable rules applied to every one of them, so a real address is never dropped and a withheld one is never shown.

The `/api` endpoints spend Apollo credits and are same-origin only by default, sending no CORS headers. Set `ALLOWED_ORIGIN` (comma separated) only when the frontend is genuinely deployed on a different origin. There is no authentication or server-side rate limiting yet, so do not expose these endpoints beyond localhost without adding both.

Apollo endpoint availability, accepted filters, enrichment permissions, credits, rate limits, and returned fields depend on the Apollo account and current API plan. Apollo does not return a `skills` array on every plan; when it is absent the UI shows `Not available` rather than guessing. Confirm access to People Search and bulk enrichment for the account before production use; the service surfaces authentication and rate-limit failures without exposing upstream details.
