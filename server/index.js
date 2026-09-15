import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { enrichPeople, matchPerson, normalizeWaterfallCandidate, pollWaterfallResult, requestPhoneNumbers, requestWaterfallEmails, searchPeople } from './apolloService.js';
import { NEEDS_ENRICHED, NEEDS_PHONE, NEEDS_REVEALED, readCached, saveCandidates, stated } from './store.js';

// Credit guard: the most people one /enrich call will forward to Apollo.
// Anything beyond this is reported back as skipped, never silently dropped.
const MAX_ENRICH_PER_REQUEST = 25;

// A reveal spends a credit per candidate, so it is capped tighter than plain
// enrichment. One mis-click on a large selection should not be able to drain an
// account; the remainder comes back as skippedIds for a deliberate second pass.
export const MAX_REVEAL_PER_REQUEST = 10;

// Waterfall searches outside Apollo's own database and is charged per record
// found, so it is capped tighter still until the per-record price is known.
export const MAX_WATERFALL_PER_REQUEST = 10;

// Phone reveal is the most expensive thing this app can ask Apollo for: mobile
// credits are charged per number and cost several times an email. So it is
// capped tightest of all, and the remainder comes back as skippedIds for a
// deliberate second pass rather than being spent on a single click.
export const MAX_PHONE_PER_REQUEST = 5;

// Apollo demands a webhook_url even when the caller polls for the result. Set
// APOLLO_WEBHOOK_URL to an endpoint you control; the found addresses are
// delivered there as well as being readable by polling.
const WATERFALL_WEBHOOK_URL = (process.env.APOLLO_WEBHOOK_URL || '').trim();

// Apollo delivers the found addresses by POSTing them to APOLLO_WEBHOOK_URL;
// polling only returns a summary and the person ids. So results are kept here
// as they arrive, keyed by the request id we issued. In memory on purpose: this
// is a short-lived handoff, not a store of candidate data.
const waterfallResults = new Map();
// Only ids this server handed out are accepted, so a public webhook cannot be
// used to inject arbitrary candidate records. The value is the question the
// request asked - 'email' or 'phone' - because a phone job's answer says
// nothing about a personal address, and reading one as the other would report
// "no personal email found" for a job that never looked for one.
const issuedWaterfallIds = new Map();
const MAX_REMEMBERED_WATERFALLS = 200;

function rememberWaterfall(requestId, kind) {
  issuedWaterfallIds.set(requestId, kind);
  // Bounded: drop the oldest rather than growing without limit.
  while (issuedWaterfallIds.size > MAX_REMEMBERED_WATERFALLS) {
    const oldest = issuedWaterfallIds.keys().next().value;
    issuedWaterfallIds.delete(oldest);
    waterfallResults.delete(oldest);
  }
}

// Mirrors the client. Kept here so the API cannot be driven past the rule.
//
// Nothing is required of a search any more. Every filter here narrows a pool
// rather than creating one, and each requirement in turn - skills, then
// location, then a role - turned out to be a way of refusing to answer a
// question Apollo answers perfectly well. Measured against the live API, one
// keyword cut a 3,088-candidate pool to 9, so demanding one was the most
// destructive default of the three.

const app = express();

// These endpoints spend Apollo credits, so they are same-origin only by
// default. The dev client reaches them through the Vite proxy and needs no
// CORS headers at all. Set ALLOWED_ORIGIN (comma separated) only when the
// frontend is genuinely deployed on a different origin.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean);
if (allowedOrigins.length) app.use(cors({ origin: allowedOrigins }));

// Apollo posts waterfall results here. Mounted with a text parser because the
// payload carries a 64-bit request_id that JSON.parse would round away.
app.post('/api/apollo/waterfall-webhook', express.text({ type: '*/*', limit: '1mb' }), (request, response) => {
  const raw = typeof request.body === 'string' ? request.body : '';
  const match = /"request_id"\s*:\s*"?(-?\d+)"?/.exec(raw);
  const requestId = match ? match[1] : null;
  // Unknown ids are acknowledged but ignored: this endpoint is public, and only
  // jobs this server started may write into the store.
  if (!requestId || !issuedWaterfallIds.has(requestId)) return response.status(202).json({ received: false });
  const kind = issuedWaterfallIds.get(requestId);

  let payload = null;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  const result = payload?.webhook_result && typeof payload.webhook_result === 'object' ? payload.webhook_result : payload;
  const people = Array.isArray(result?.people) ? result.people : (Array.isArray(result?.matches) ? result.matches : []);
  // Read with the waterfall normalizer: a delivered payload carries the
  // vendors' findings in `emails`/`phone_numbers`/`waterfall`, not in the
  // enrichment fields, so the ordinary normalizer saw nothing in it.
  const delivered = people
    .filter((person) => person && (person.id || person.person_id))
    .map((person) => normalizeWaterfallCandidate(person, { requestedId: person.id || person.person_id, kind }));
  waterfallResults.set(requestId, delivered);
  // Apollo charged for these whether or not anybody looks at them twice, so
  // they are kept against the next time this candidate comes up.
  saveCandidates(delivered, kind === 'phone' ? { phone: true } : { revealed: true });
  response.json({ received: true });
});

app.use(express.json({ limit: '32kb' }));

function clean(value, max = 160) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function publicError(error) {
  const messages = {
    MISSING_APOLLO_API_KEY: ['Apollo API is not configured on the server.', 503],
    MISSING_LOOKUP_IDENTIFIER: ['Enter an email address, a LinkedIn URL, or a name to look one person up.', 400],
    MISSING_APOLLO_WEBHOOK_URL: ['Set APOLLO_WEBHOOK_URL on the server before searching other data sources. Apollo requires one even when results are polled.', 503],
    APOLLO_AUTH: ['Apollo API authentication failed.', 502],
    APOLLO_RATE_LIMIT: ['Apollo API rate limit reached. Please try again later.', 429],
    // Retrying cannot clear this, so the message says what to actually do
    // instead of inviting another attempt.
    APOLLO_CREDITS_EXHAUSTED: ['Your Apollo account has no credits left for this billing cycle. Add credits or upgrade the plan in Apollo, then try again.', 402],
    APOLLO_UNAVAILABLE: ['Unable to connect to Apollo. Please try again.', 502]
  };
  const [message, status] = messages[error.message] || ['Unable to complete the Apollo request.', 502];
  // The code lets the client tell a permanent condition from a transient one
  // without parsing prose. Only our own error names are ever exposed.
  return [message, status, messages[error.message] ? error.message : 'APOLLO_ERROR'];
}

app.post('/api/candidates/search', async (request, response) => {
  const filters = Object.fromEntries(['jobTitle', 'location', 'seniority', 'keywords', 'company', 'industry', 'personName']
    // Role, skills, location and seniority are comma-separated lists, so they
    // need more room than a single value; the rest keep the original bound.
    .map((key) => [key, clean(request.body?.[key],
      ['jobTitle', 'keywords', 'location', 'seniority'].includes(key) ? 400 : 160)]));
  const page = Math.max(1, Math.min(1000, Number.parseInt(request.body?.page, 10) || 1));
  // Costs nothing and keeps credits off candidates Apollo holds no address for.
  // Defaults on: the caller must opt out deliberately.
  const verifiedEmailOnly = request.body?.verifiedEmailOnly !== false;
  // Off by default: "any of these skills" finds people, "all of them" finds
  // almost nobody, and the recruiter should reach the strict version
  // deliberately rather than land on it.
  const matchAllSkills = request.body?.matchAllSkills === true;
  // Credit guard: Apollo bills for every search, so refuse one that cannot be
  // meaningful. Role, skills and location are required; company, industry and
  // seniority only narrow an already valid query.
  //
  // A name is exempt: looking a person up by name is a meaningful search in its
  // own right, and demanding a role and a location alongside it is what made a
  // name search return nothing. Apollo's q_person_name works on its own.
  // No filter is required. A search with none of them is the whole pool, which
  // is what the app opens on so a recruiter can see who is there before
  // describing who they want. Punctuation is still not a filter - " , , " in
  // the skills field reaches Apollo as no keywords rather than as a term that
  // matches nothing.
  try {
    const result = await searchPeople(filters, page, 25, { verifiedEmailOnly, matchAllSkills });
    // A candidate this account has already paid to enrich comes back enriched:
    // the details are ours to show from here on, so the row offers them
    // straight away instead of asking for a credit that was already spent.
    const ids = result.candidates.map((candidate) => candidate.id).filter(Boolean);
    const known = readCached(ids, NEEDS_ENRICHED);
    response.json({
      ...result,
      candidates: result.candidates.map((candidate) => {
        const held = candidate.id && known.get(candidate.id);
        // The search row is the newer statement of where somebody works, so it
        // wins on the fields it actually carries; the stored record supplies
        // everything a search never returns.
        return held
          ? { ...held, ...stated(candidate), enriched: true, fromCache: true }
          : candidate;
      })
    });
  } catch (error) {
    const [message, status, code] = publicError(error);
    response.status(status).json({ error: message, code });
  }
});

// Looks one person up by the identifiers a recruiter already has, instead of
// filtering a pool. Bounded at one person by Apollo's endpoint itself, so it
// needs no per-request cap the way the batch routes do, and it never asks for
// personal emails or a phone number - the recruiter reaches those through the
// same explicit reveal as any other candidate.
app.post('/api/candidates/lookup', async (request, response) => {
  const identifiers = Object.fromEntries(['name', 'company', 'email', 'linkedinUrl']
    .map((key) => [key, clean(request.body?.[key], key === 'linkedinUrl' ? 400 : 160)]));
  // Refused here rather than sent: a lookup with nothing to match on would
  // spend a request to be told what we already know.
  if (!Object.values(identifiers).some(Boolean)) {
    return response.status(400).json({ error: 'Enter an email address, a LinkedIn URL, or a name to look one person up.' });
  }
  // A company on its own identifies an employer, not a person, and Apollo would
  // answer with whoever it happened to rank first.
  if (!identifiers.email && !identifiers.linkedinUrl && !identifiers.name) {
    return response.status(400).json({ error: 'A company on its own is not a person. Add a name, an email address, or a LinkedIn URL.' });
  }
  try {
    const candidate = await matchPerson(identifiers);
    // Apollo answering "no such person" is a result, not a failure, so it is a
    // 200 with an empty candidate rather than an error the client must parse.
    response.json({ candidate, matched: Boolean(candidate) });
  } catch (error) {
    const [message, status, code] = publicError(error);
    response.status(status).json({ error: message, code });
  }
});

// Both enrichment routes accept the same body, apply the same credit cap and
// answer in the same shape. They differ only in whether Apollo was asked to
// reveal personal emails, which spends extra credits per candidate.
async function enrichRoute(request, response, { revealPersonalEmails, max }) {
  const requested = Array.isArray(request.body?.ids)
    ? [...new Set(request.body.ids.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.slice(0, 120)))]
    : [];
  const ids = requested.slice(0, max);
  const skippedIds = requested.slice(max);
  if (!ids.length) return response.status(400).json({ error: 'Select at least one candidate to enrich.' });
  // "Refresh from Apollo" is the way past the stored copy: a recruiter who
  // thinks a record has gone stale must be able to buy a fresh one.
  const refresh = request.body?.refresh === true;
  // A stored enrichment cannot answer a reveal - it never held a personal
  // address - so each request is served only from the credit that paid for it.
  const need = revealPersonalEmails ? NEEDS_REVEALED : NEEDS_ENRICHED;
  const held = refresh ? new Map() : readCached(ids, need);
  const toAsk = ids.filter((id) => !held.has(id));
  try {
    const { candidates, failedIds } = toAsk.length
      ? await enrichPeople(toAsk, { revealPersonalEmails })
      : { candidates: [], failedIds: [] };
    saveCandidates(candidates, { enriched: true, revealed: revealPersonalEmails === true });
    // requestedIds lets the client resolve every selected ID to an outcome:
    // enriched, failed, skipped by the per-request cap - or served from the
    // record this account already owns, which cost nothing.
    response.json({
      requestedIds: ids,
      candidates: [...held.values(), ...candidates],
      failedIds,
      skippedIds,
      fromCacheIds: [...held.keys()],
      revealedPersonalEmails: revealPersonalEmails === true
    });
  } catch (error) {
    const [message, status, code] = publicError(error);
    response.status(status).json({ error: message, code });
  }
}

app.post('/api/candidates/enrich', (request, response) => enrichRoute(request, response, { revealPersonalEmails: false, max: MAX_ENRICH_PER_REQUEST }));

// Costs more Apollo credits than /enrich, so it is a route of its own that the
// recruiter reaches only through an explicit "Reveal contact details" action.
// Nothing on the search path can reach it.
app.post('/api/candidates/reveal', (request, response) => enrichRoute(request, response, { revealPersonalEmails: true, max: MAX_REVEAL_PER_REQUEST }));

// Apollo delivers waterfall results by POST, and charges for what it finds
// whether or not that delivery lands. A stale tunnel hostname or an unreachable
// host therefore costs real money for data that is thrown away. So the URL is
// tested before any search starts: a few hundred milliseconds against a credit.
async function webhookUnreachableReason(url) {
  if (!url) return 'not set';
  let target;
  try {
    target = new URL(url);
  } catch {
    return 'not a valid URL';
  }
  if (target.protocol !== 'https:') return 'not an https:// URL, which Apollo requires';

  try {
    const probe = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A request id this server never issued: the receiver acknowledges and
      // discards it, so the probe cannot alter any stored result.
      body: JSON.stringify({ request_id: 0, preflight: true }),
      signal: AbortSignal.timeout(8000)
    });
    // Any answer at all proves Apollo can reach it. A 404 is the exact failure
    // that silently loses results, so it is called out by name.
    if (probe.status === 404) return 'reachable but returns 404 - it must point at this app\'s /api/apollo/waterfall-webhook';
    if (probe.status >= 500) return `reachable but returns ${probe.status}, so Apollo cannot deliver to it`;
    return null;
  } catch (error) {
    if (error?.name === 'TimeoutError') return 'unresponsive - it did not answer within 8 seconds';
    // A hostname that no longer resolves is the common case with a quick
    // tunnel: the hostname is issued per run and is gone once that run ends.
    // Naming it saves hunting for a server fault behind an expired URL.
    const code = error?.cause?.code || error?.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return `pointing at a hostname that no longer exists (${target.hostname} does not resolve). A trycloudflare quick tunnel gets a new hostname every run, so restart the tunnel and put the new URL in .env`;
    }
    if (code === 'ECONNREFUSED') return 'refusing connections - nothing is listening at that address';
    return `unreachable${code ? ` (${code})` : ''}`;
  }
}

// Starts a waterfall search. Answers immediately with the request IDs to poll;
// the addresses themselves arrive later.
app.post('/api/candidates/waterfall', async (request, response) => {
  const requested = Array.isArray(request.body?.ids)
    ? [...new Set(request.body.ids.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.slice(0, 120)))]
    : [];
  const ids = requested.slice(0, MAX_WATERFALL_PER_REQUEST);
  const skippedIds = requested.slice(MAX_WATERFALL_PER_REQUEST);
  if (!ids.length) return response.status(400).json({ error: 'Select at least one candidate to search other data sources for.' });

  // Checked before Apollo is called, so an unreachable webhook costs nothing.
  const unreachable = await webhookUnreachableReason(WATERFALL_WEBHOOK_URL);
  if (unreachable) {
    return response.status(503).json({
      error: `APOLLO_WEBHOOK_URL is ${unreachable}. Apollo posts the found addresses there and charges for them either way, so the search was not started and no credit was spent. Fix the URL in .env, then restart the API server - .env is only read when the process starts, so editing it alone changes nothing.`,
      code: 'APOLLO_WEBHOOK_UNREACHABLE'
    });
  }

  try {
    const { requests, candidates, failedIds } = await requestWaterfallEmails(ids, WATERFALL_WEBHOOK_URL);
    for (const job of requests) rememberWaterfall(job.requestId, 'email');
    response.json({ requestedIds: ids, requests, candidates, failedIds, skippedIds });
  } catch (error) {
    const [message, status, code] = publicError(error);
    response.status(status).json({ error: message, code });
  }
});

// Asks Apollo for phone numbers. Answers immediately with the request IDs to
// poll; the numbers themselves arrive later, at the webhook or by polling.
//
// This is the only route that ever sets reveal_phone_number, and it is reached
// only from an explicit action the recruiter confirmed. Nothing on the search,
// enrich, reveal or waterfall paths can trigger it.
app.post('/api/candidates/phone', async (request, response) => {
  const requested = Array.isArray(request.body?.ids)
    ? [...new Set(request.body.ids.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.slice(0, 120)))]
    : [];
  const askedFor = requested.slice(0, MAX_PHONE_PER_REQUEST);
  const skippedIds = requested.slice(MAX_PHONE_PER_REQUEST);
  if (!askedFor.length) return response.status(400).json({ error: 'Select at least one candidate to reveal a phone number for.' });

  // A number this account already bought is handed straight back. Mobile
  // credits are the dearest thing this app spends, so this is the one worth
  // getting right.
  const held = request.body?.refresh === true ? new Map() : readCached(askedFor, NEEDS_PHONE);
  const ids = askedFor.filter((id) => !held.has(id));
  if (!ids.length) {
    return response.json({
      requestedIds: askedFor, requests: [], candidates: [...held.values()],
      failedIds: [], skippedIds, fromCacheIds: [...held.keys()]
    });
  }

  // Checked before Apollo is called: Apollo delivers the numbers by POST and
  // charges for them either way, so an unreachable webhook would cost mobile
  // credits for data that is thrown away.
  const unreachable = await webhookUnreachableReason(WATERFALL_WEBHOOK_URL);
  if (unreachable) {
    return response.status(503).json({
      error: `APOLLO_WEBHOOK_URL is ${unreachable}. Apollo posts the phone numbers there and charges for them either way, so nothing was requested and no credit was spent. Fix the URL in .env, then restart the API server - .env is only read when the process starts, so editing it alone changes nothing.`,
      code: 'APOLLO_WEBHOOK_UNREACHABLE'
    });
  }

  try {
    const { requests, candidates, failedIds } = await requestPhoneNumbers(ids, WATERFALL_WEBHOOK_URL);
    for (const job of requests) rememberWaterfall(job.requestId, 'phone');
    // A number that came back on the spot is kept; the ones that arrive later
    // are kept when the webhook or the poll delivers them.
    saveCandidates(candidates.filter((candidate) => candidate.phone), { phone: true });
    response.json({
      requestedIds: askedFor,
      requests,
      candidates: [...held.values(), ...candidates],
      failedIds,
      skippedIds,
      fromCacheIds: [...held.keys()]
    });
  } catch (error) {
    const [message, status, code] = publicError(error);
    response.status(status).json({ error: message, code });
  }
});

// Reads one waterfall result. Costs no credits, so it is safe to poll.
app.get('/api/candidates/waterfall/:requestId', async (request, response) => {
  const requestId = String(request.params.requestId || '');
  // Apollo's request ids are signed 64-bit integers; anything else is ours to
  // reject rather than forward.
  if (!/^-?\d{1,20}$/.test(requestId)) return response.status(400).json({ error: 'Unrecognised waterfall request.' });
  // Anything the webhook already delivered wins: it is the only copy that
  // carries the addresses themselves.
  // Only this server knows which question a request asked; Apollo's answer for
  // a job that found nothing looks the same either way.
  const kind = issuedWaterfallIds.get(requestId) || 'email';
  const delivered = waterfallResults.get(requestId);
  if (delivered) return response.json({ status: 'ready', kind, candidates: delivered, deliveredByWebhook: true });
  try {
    response.json({ kind, ...await pollWaterfallResult(requestId, { kind }) });
  } catch (error) {
    const [message, status, code] = publicError(error);
    response.status(status).json({ error: message, code });
  }
});

const port = Number(process.env.PORT) || 3000;
if (process.env.NODE_ENV !== 'test') app.listen(port, () => console.log(`Candidate API listening on ${port}`));
export default app;
