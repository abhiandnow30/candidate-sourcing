# Apollo Candidate Sourcing

Candidate search and selective enrichment through a server-side Apollo API integration. Recruiters search, select, enrich, and review Apollo-provided professional information without leaving this application. The frontend never calls Apollo directly and never visits or scrapes LinkedIn.

## Local setup

1. Copy `.env.example` to `.env` and set `APOLLO_API_KEY` on the server only.
2. Run `npm install`.
3. Run `npm run dev`.
4. Open `http://localhost:5173`.

Production build: `npm run build`
Tests: `npm test` (`npm run test:server` for the API, `npm run test:ui` for the UI)

## Webhook configuration (`APOLLO_WEBHOOK_URL`)

Phone reveal and waterfall email are asynchronous at Apollo. The POST returns a
`request_id` immediately; **Apollo delivers the numbers and addresses themselves
by POSTing them to `APOLLO_WEBHOOK_URL`.** Polling
`/api/candidates/waterfall/:requestId` returns only the person IDs and a tally --
never the contact data. So the webhook is not optional plumbing: without it,
Apollo charges for results you never receive.

This app serves the receiver at `POST /api/apollo/waterfall-webhook`. Apollo
requires HTTPS.

The URL is read from the environment at startup and is used verbatim -- no code
change is needed to point it somewhere else:

```
APOLLO_WEBHOOK_URL=https://<host>/api/apollo/waterfall-webhook
```

`.env` is only read when the process starts, so **restart the API server after
changing it.**

### Local development: Cloudflare Quick Tunnel (temporary)

Local dev uses a quick tunnel to give Apollo a public HTTPS address:

```
cloudflared tunnel --url http://localhost:3000
```

> **The quick tunnel hostname is temporary.** Cloudflare issues a new random
> hostname (`something-random.trycloudflare.com`) *every time the tunnel
> restarts*, and the previous one stops resolving immediately. It is not
> reserved, cannot be renewed, and will not survive a laptop sleep, a dropped
> connection, or restarting `cloudflared`.
>
> Whenever the tunnel restarts you must copy the new URL into
> `APOLLO_WEBHOOK_URL` in `.env` **and restart the API server.** Until you do,
> phone reveal and waterfall email will refuse to run.

Two guards exist for this, because it happens constantly:

- **Before spending.** Each phone/waterfall request probes the webhook first. A
  hostname that no longer resolves is refused with a `503` naming the dead
  hostname, and no Apollo credit is spent.
- **After spending.** A tunnel that dies *mid-job* cannot be caught by the probe
  -- Apollo has already accepted the request. The UI reads Apollo's own tally to
  tell "nothing was found" apart from "something was found but never reached
  us", and reports the second as a delivery failure naming
  `APOLLO_WEBHOOK_URL`. Those candidates are left unanswered rather than marked
  as having no number, since it is not known whether one was found.

### Deployment: permanent URL

Replace the tunnel with a stable public HTTPS URL on the deployed host. Set it
through the environment -- **do not hardcode it**; nothing in the application
references a specific hostname:

```
APOLLO_WEBHOOK_URL=https://your-host/api/apollo/waterfall-webhook
```

Anything that reaches the deployed app over HTTPS works: the app's own domain, a
load balancer, or a named Cloudflare tunnel (unlike a quick tunnel, a *named*
tunnel keeps its hostname across restarts). The receiver ignores any
`request_id` this server did not issue, so the endpoint being public does not
let a third party write results into it.

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

### The two spending actions

Search and enrichment never spend contact credits. Two buttons do, each reached only from an explicit click, each showing what it would cost before it is pressed:

| Action | Spends | Runs |
|---|---|---|
| **Reveal email** | Apollo contact credit per candidate | Immediately |
| **Reveal phone** | Mobile credit per candidate — the dearest | Asynchronously, minutes |

### Why there is no "search other sources" button

`POST /api/candidates/waterfall` exists and works, but is deliberately **not** exposed in the UI.

It was wired to a button on 2026-09-14 and removed the same day after testing against live Apollo. Three candidates were searched; every one came back:

```
vendors: [{"name":"Apollo","status":"VERIFIED","statusCode":"apollo_step_success"}]
```

Only Apollo ran. **No third-party vendor was queried on any of them.** Apollo's waterfall stops as soon as its own step finds an address, and `apollo_step_success` is that stop — it looks for *an* email, not a *personal* one. All three already had a work address on file, so the waterfall was satisfied before it reached the vendors that were the entire reason for calling it.

The consequence: for any candidate Apollo already holds an email for, this route costs more than a reveal and returns exactly what a reveal returns. That is most candidates, since the app's search asks Apollo for people whose address it rates verified or likely.

If it is ever revisited, the open question is whether it behaves differently for a candidate with **no** email on file (`hasEmailOnFile: false`) — the only case where Apollo's own step cannot satisfy the waterfall. That was never tested. Anyone re-adding it should gate it to exactly those candidates and confirm a non-Apollo vendor appears in `vendors` before trusting it.

Expanding an enriched candidate shows an **Enriched Details** panel containing the professional headline, seniority, department, skills, current employment, previous employment, email, phone, and the Apollo-provided LinkedIn URL. Any field Apollo did not return displays `Not available`. Nothing in this panel is inferred, reconstructed, or derived from a LinkedIn page.

Enrichment state is tracked per Apollo Person ID for the session. An already-enriched candidate is not sent to Apollo again unless the recruiter clicks **Refresh from Apollo**. A candidate Apollo returned no match for is marked `failed`, stays in the results, and can be retried individually.

## API

- `POST /api/candidates/search` accepts `jobTitle`, `location`, `seniority`, `keywords`, `company`, `industry`, and `page`. It returns `{ candidates, page, perPage, total }`. `jobTitle`, `location` and `keywords` are **required**; `company`, `industry` and `seniority` only narrow an already valid query. Apollo bills for every search, so a request missing any required filter answers `400` with `{ error, missing }` and never calls Apollo. The Search button stays disabled, listing what is still needed, until all three are filled in.
- `POST /api/candidates/enrich` accepts an explicit `ids` array and returns `{ requestedIds, candidates, failedIds, skippedIds }`. It sends `reveal_personal_emails: false`, so it never spends Apollo's contact credits.
- `POST /api/candidates/reveal` takes the same body and answers in the same shape plus `revealedPersonalEmails: true`. It is the only route that sends `reveal_personal_emails: true`, and it is reached only from the recruiter's explicit **Reveal contact details** action - never from search and never from plain enrichment. Both routes share the 25-per-request cap and the batching of 10, and both keep `reveal_phone_number: false`; phone reveal is asynchronous and lands separately.

- `POST /api/candidates/waterfall` takes the same `ids` body and starts a **search of other sources**: it sends `reveal_personal_emails: true` *and* `run_waterfall_email: true`, asking Apollo to query third-party vendors for a personal address Apollo does not hold itself. It answers immediately with `{ requestedIds, requests, candidates, failedIds, skippedIds }` — `requests` are the `requestId`s to poll, and `candidates` is the synchronous half (whatever Apollo already held). The addresses the vendors find arrive later at `APOLLO_WEBHOOK_URL`. Capped at 10 per request.
- `GET /api/candidates/waterfall/:requestId` reads one asynchronous result, for both the waterfall and phone paths. It costs no credits, so it is safe to poll. Returns `status: 'pending' | 'ready' | 'expired'`, and on `ready` also Apollo's own tally (`summary.creditsConsumed`, `delivery.status`) — the only way to tell "nothing was found" from "something was found but never reached the webhook".

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
