// Per-candidate enrichment lifecycle, keyed by Apollo Person ID.
export const NOT_ENRICHED = 'not_enriched';
export const ENRICHING = 'enriching';
export const REVEALING = 'revealing';
export const SEARCHING_SOURCES = 'searching_sources';
export const REVEALING_PHONE = 'revealing_phone';
export const ENRICHED = 'enriched';
export const FAILED = 'failed';

const LABELS = {
  [NOT_ENRICHED]: 'Not enriched',
  [ENRICHING]: 'Enriching...',
  [REVEALING]: 'Revealing contact details...',
  [SEARCHING_SOURCES]: 'Searching other sources...',
  [REVEALING_PHONE]: 'Revealing phone number...',
  // "Yes" answered a column headed "Enriched". The badge stands under the
  // candidate's name now, where it has to say what it means on its own.
  [ENRICHED]: 'Enriched',
  [FAILED]: 'Enrichment failed'
};

// A candidate Apollo is already working on is never sent twice, whichever of
// the two paths put it in flight.
const IN_FLIGHT = new Set([ENRICHING, REVEALING, SEARCHING_SOURCES, REVEALING_PHONE]);

export function stateOf(states, id) {
  return (id && states.get(id)) || NOT_ENRICHED;
}

export function enrichmentLabel(state) {
  return LABELS[state] || LABELS[NOT_ENRICHED];
}

// Which selected IDs actually go to Apollo. Already-enriched people are held
// back unless the recruiter explicitly asks for a refresh, and anything
// already in flight is never sent twice.
export function idsToEnrich(ids, states, { refresh = false } = {}) {
  return ids.filter((id) => {
    if (!id) return false;
    const state = stateOf(states, id);
    if (IN_FLIGHT.has(state)) return false;
    if (state === ENRICHED) return refresh;
    return true;
  });
}

// Which selected IDs a phone reveal sends to Apollo. Mobile credits are the
// dearest thing this app spends, so a candidate whose number is already in hand
// is never paid for twice, and one Apollo has already answered "none" for is not
// asked again unless the recruiter explicitly refreshes.
export function idsToRevealPhone(ids, states, revealed = new Map(), { refresh = false } = {}) {
  return ids.filter((id) => {
    if (!id || IN_FLIGHT.has(stateOf(states, id))) return false;
    if (refresh) return true;
    const candidate = revealed.get(id);
    return !candidate?.phone && !candidate?.phoneChecked;
  });
}

export function markState(states, ids, state) {
  const next = new Map(states);
  for (const id of ids) if (id) next.set(id, state);
  return next;
}

// Sorts one /enrich response into outcomes. Pure and independent of any
// previous state, so the callers below can apply it inside a functional
// update and never reconcile against a stale snapshot.
export function reconcile(requestedIds, data = {}) {
  const candidatesByKey = new Map();
  for (const candidate of data.candidates || []) {
    const key = candidate.requestedId || candidate.id;
    if (key) candidatesByKey.set(key, candidate);
  }
  const skippedIds = (data.skippedIds || []).filter(Boolean);
  const skipped = new Set(skippedIds);
  const failedIds = requestedIds.filter((id) => !candidatesByKey.has(id) && !skipped.has(id));
  return {
    candidatesByKey,
    matchedIds: [...candidatesByKey.keys()],
    failedIds,
    skippedIds,
    matched: candidatesByKey.size,
    failed: failedIds.length,
    skipped: skippedIds.length
  };
}

export function applyStates(states, outcome) {
  let next = markState(states, outcome.matchedIds, ENRICHED);
  next = markState(next, outcome.failedIds, FAILED);
  // Skipped by the backend credit cap: never asked, so back to square one.
  return markState(next, outcome.skippedIds, NOT_ENRICHED);
}

// contactRevealed records that this record came back from a request that asked
// Apollo for contact data. Plain enrichment does not ask, so its silence about a
// personal address is not evidence there is none - only a reveal's is.
export function applyEnriched(enriched, outcome, { contactRevealed = false } = {}) {
  const next = new Map(enriched);
  for (const [key, candidate] of outcome.candidatesByKey) {
    next.set(key, contactRevealed ? { ...candidate, contactRevealed: true } : candidate);
  }
  return next;
}

// A waterfall answer carries the person id and whatever the vendors found, and
// nothing else: no name, no title, no company, no employment history. Applying
// it the way an enrichment answer is applied replaced a full candidate record
// with that husk, which is what left rows showing a null name after a search of
// other sources. So a waterfall result is merged over what the row already
// holds, and only fields Apollo actually returned a value for may overwrite.
//
// A boolean is never merged as false: every flag on a candidate record is a
// positive assertion, so a false arriving on a sparse answer is an absence
// rather than a correction. An empty array is an absence for the same reason.
function present(value) {
  if (value === null || value === undefined || value === '' || value === false) return false;
  return Array.isArray(value) ? value.length > 0 : true;
}

export function mergeCandidate(base, incoming) {
  if (!base) return incoming;
  if (!incoming) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (present(value)) merged[key] = value;
  }
  // The row's identity is the ID the recruiter selected, never one echoed back
  // inside an answer.
  merged.id = base.id || incoming.id || null;
  return merged;
}

// Applies a waterfall outcome. `baseById` supplies the record to merge each
// result over when the row has nothing enriched yet - the candidate the search
// returned - so a sparse answer adds contact data instead of erasing the rest.
//
// `checkedIds` are the IDs this answer covers. Apollo finishing with no record
// at all for an ID is still an answer about that ID, so they are marked as
// checked; that is what lets the UI say "no personal email found" for them
// rather than leaving them looking unasked.
export function applyWaterfall(enriched, outcome, { baseById = new Map(), checkedIds = [], mark = { contactRevealed: true, waterfallChecked: true } } = {}) {
  const next = new Map(enriched);

  for (const [key, candidate] of outcome.candidatesByKey) {
    const base = next.get(key) || baseById.get(key) || null;
    next.set(key, { ...mergeCandidate(base, candidate), ...mark });
  }
  for (const id of checkedIds) {
    if (!id || outcome.candidatesByKey.has(id)) continue;
    const base = next.get(id) || baseById.get(id);
    // Nothing known about this row at all: there is no record to annotate, and
    // inventing one would put a candidate on screen that Apollo never returned.
    if (base) next.set(id, { ...base, ...mark });
  }
  return next;
}

// Whether a finished job was charged for but never reached us.
//
// Apollo posts the found addresses and numbers to APOLLO_WEBHOOK_URL; polling
// returns the person ids and a tally, not the contact data itself. So a job
// whose delivery failed looks exactly like a job that found nothing - same
// empty fields, same "ready" status - except that Apollo charged for it and
// says so in its own tally.
//
// This matters most on a Cloudflare Quick Tunnel, whose hostname changes every
// time the tunnel restarts. The pre-flight probe catches a dead URL before a
// request is sent, but a tunnel that dies mid-job cannot be caught that way:
// the request was already accepted and the answer is already lost. Without
// this, that case reported "Apollo holds no number for these candidates" - a
// confident false negative on data the account had just paid for.
//
// Returns null when there is no evidence of loss. Silence is the honest answer
// here: a job that genuinely found nothing must not be reported as a failure.
export function deliveryShortfall(result, { kind = 'email' } = {}) {
  if (!result || result.status !== 'ready') return null;
  // The webhook copy is the one that carries the contact data. If it arrived,
  // nothing was lost.
  if (result.deliveredByWebhook) return null;

  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const hasContact = (candidate) => (kind === 'phone'
    ? Boolean(candidate?.phone)
    : Boolean(candidate?.personalEmail || candidate?.email));
  // Delivery is all-or-nothing per request, so anything with contact data on it
  // means the payload reached us.
  if (candidates.some(hasContact)) return null;

  const creditsConsumed = Number(result.summary?.creditsConsumed) || 0;
  const emailsFound = Number(result.summary?.emailsFound) || 0;
  // Only Apollo's own words count as a stated failure; an unrecognised status
  // is not read as one.
  const stated = /fail|error/i.test(String(result.delivery?.status || ''));

  if (!stated && !creditsConsumed && !emailsFound) return null;
  return {
    creditsConsumed,
    emailsFound,
    // Apollo's reason when it gave one, so the recruiter sees what Apollo said
    // rather than only what we inferred.
    failureReason: result.delivery?.failureReason || null
  };
}

// What to tell the recruiter when a job was charged for but never delivered.
// Names the environment variable and the restart, because on a Quick Tunnel
// that is always the fix.
export function deliveryShortfallMessage(jobs, { kind = 'email' } = {}) {
  const thing = kind === 'phone' ? 'phone number' : 'email address';
  const credits = jobs.reduce((total, job) => total + (job.creditsConsumed || 0), 0);
  const reason = jobs.map((job) => job.failureReason).find(Boolean);
  return [
    `Apollo finished ${jobs.length === 1 ? 'this request' : `${jobs.length} of these requests`} and charged for ${jobs.length === 1 ? 'it' : 'them'}`,
    credits ? ` (${credits} credit${credits === 1 ? '' : 's'})` : '',
    `, but could not deliver the result to APOLLO_WEBHOOK_URL, so the ${thing}s it found never arrived.`,
    reason ? ` Apollo reported: ${reason}.` : '',
    ' This is what happens when a Cloudflare Quick Tunnel restarts: it issues a new hostname and the old one stops answering.',
    ' Restart the tunnel, put the new URL in APOLLO_WEBHOOK_URL, and restart the API server - .env is only read at startup.',
    ` These candidates are left unanswered rather than marked as having no ${thing}, because it is not known whether one was found.`
  ].join('');
}

// Strips the flags by which a record claims to be an answer about somebody.
//
// A polled record carries phoneChecked/waterfallChecked set by the server,
// because normally it *is* the answer. When its delivery failed it is not: the
// contact data went to a dead webhook and what is left says only "Apollo
// finished". Merging those flags told the row it had been answered - so it
// showed "No phone number found" and the retry guard blocked asking again -
// while the status message said the opposite. Passing `mark: {}` did not stop
// it, because the flags ride in on the record itself, not on the mark.
export function withoutAnswerFlags(candidate) {
  const { phoneChecked, waterfallChecked, contactRevealed, ...rest } = candidate || {};
  return rest;
}

export function enrichmentSummary({ matched, failed, skipped }) {
  const parts = [`Enrichment complete. ${matched} candidate${matched === 1 ? '' : 's'} enriched.`];
  if (failed) parts.push('Unable to enrich this candidate.');
  if (skipped) parts.push(`${skipped} candidate${skipped === 1 ? '' : 's'} were not sent because of the per-request limit. Enrich them in a second batch.`);
  return parts.join(' ');
}
