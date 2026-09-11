const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';

// Apollo's bulk match endpoint accepts a limited number of people per call.
// Larger selections are split into sequential batches so a recruiter can
// enrich more people than one Apollo request allows.
export const BULK_MATCH_BATCH_SIZE = 10;

// Apollo returns this sentinel address instead of a real email when the
// contact is not unlocked on the current plan. It is not a real address.
const MASKED_EMAIL = /^email_not_unlocked@/i;

// Filler that can arrive in an email field from Apollo or a source behind it.
// None of these are addresses a recruiter can write to.
const PLACEHOLDER_EMAILS = new Set(['n/a', 'na', 'none', 'null', 'nil', 'unknown', 'not available', 'email_not_unlocked']);

// A shape check, not validation: Apollo owns whether an address is correct, we
// own not presenting something that plainly is not an address at all.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Consumer mailbox providers. An address on one of these is the candidate's
// own, whichever Apollo field carried it, so it is reported as personal rather
// than as a company address.
const CONSUMER_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'ymail.com', 'rediffmail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'gmx.com', 'mail.com'
]);

// `email_status` is a string enum. Truthiness is not availability: the value
// "unavailable" is truthy. Treat only statuses outside this set as available.
const UNAVAILABLE_EMAIL_STATUSES = new Set(['unavailable', 'bounced', 'no_status', 'pending_manual_fulfillment']);

function apolloHeaders() {
  if (!process.env.APOLLO_API_KEY) throw new Error('MISSING_APOLLO_API_KEY');
  return {
    'Content-Type': 'application/json',
    'x-api-key': process.env.APOLLO_API_KEY
  };
}

// Returns the parsed body and the raw text it came from. The text matters
// because JSON.parse cannot round-trip every value Apollo sends: see
// readRequestId below.
async function apolloRequestRaw(path, body) {
  const response = await fetch(`${APOLLO_BASE_URL}${path}`, {
    method: 'POST', headers: apolloHeaders(), body: JSON.stringify(body)
  });
  const text = await response.text();

  if (response.status === 401 || response.status === 403) throw new Error('APOLLO_AUTH');
  if (response.status === 429) throw new Error('APOLLO_RATE_LIMIT');
  if (!response.ok) {
    // An exhausted credit balance arrives as a 422 carrying a billing code. It
    // is not a transport failure and no retry clears it, so it is separated out
    // rather than folded into the generic unavailable case.
    if (response.status === 422 && /CREDITS_EXHAUSTED|insufficient credits/i.test(text)) {
      throw new Error('APOLLO_CREDITS_EXHAUSTED');
    }
    throw new Error('APOLLO_UNAVAILABLE');
  }

  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { data: data ?? {}, text };
}

async function apolloRequest(path, body) {
  return (await apolloRequestRaw(path, body)).data;
}

// Apollo's request_id is a signed 64-bit integer, which is wider than a
// JavaScript number can hold exactly: JSON.parse silently rounds
// 4681616607779935463 to 4681616607779935000, and polling with the rounded
// value answers request_id_unknown forever. So it is read out of the raw JSON
// text as a string and never allowed through a Number.
function readRequestId(text) {
  const match = /"request_id"\s*:\s*"?(-?\d+)"?/.exec(typeof text === 'string' ? text : '');
  return match ? match[1] : null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function realEmail(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || MASKED_EMAIL.test(trimmed)) return null;
  if (PLACEHOLDER_EMAILS.has(trimmed.toLowerCase())) return null;
  return EMAIL_SHAPE.test(trimmed) ? trimmed : null;
}

function emailStatusAvailable(status) {
  if (typeof status !== 'string' || status.trim() === '') return false;
  return !UNAVAILABLE_EMAIL_STATUSES.has(status.trim().toLowerCase().replace(/\s+/g, '_'));
}

// Apollo's own answer to "do you hold a phone number for this person", returned
// free on every search row. It is a string, not a boolean: "Yes" when Apollo
// has a direct dial, and "Maybe: please request direct dial via
// people/bulk_match" when it will not say without being asked (and paid). Only
// an explicit yes or no is reported; "Maybe" stays unknown rather than being
// read as either, because guessing wrong here either wastes a mobile credit or
// hides a reachable candidate.
function phoneOnFile(person) {
  const raw = firstValue(person.has_direct_phone, person.has_phone, person.phone_available);
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'yes' || value === 'true') return true;
  if (value === 'no' || value === 'false') return false;
  return null;
}

// Classifies an address we already know is real. Source decides the default;
// a consumer mailbox domain overrides it, because an address on one of those is
// the candidate's own no matter which Apollo field carried it.
function classifyEmail(email, sourceType) {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return CONSUMER_EMAIL_DOMAINS.has(domain) ? 'personal' : sourceType;
}

// Every real address Apollo sent, in preference order, each tagged with the kind
// it is. Apollo spreads them across three shapes: a single `email`,
// `contact_emails` objects carrying their own `email_status`, and a list of
// plain `personal_emails` strings. Reading only `email` discards addresses
// Apollo has already sent and charged for. Every candidate must still survive
// the masked, placeholder and shape rules, and nothing is ever assembled from a
// name and a company domain.
function collectEmails(person) {
  const found = [];
  const seen = new Set();
  const add = (value, sourceType) => {
    const email = realEmail(value);
    if (!email || seen.has(email.toLowerCase())) return;
    seen.add(email.toLowerCase());
    found.push({ email, emailType: classifyEmail(email, sourceType) });
  };

  add(firstValue(person.email), 'work');

  for (const entry of (Array.isArray(person.contact_emails) ? person.contact_emails : [])) {
    // An entry with no status at all is not a claim of unavailability, so it
    // stays eligible; only an explicit unavailable status rules one out.
    const usable = entry?.email_status == null || entry.email_status === '' || emailStatusAvailable(entry.email_status);
    if (usable) add(entry?.email, 'work');
  }

  for (const value of (Array.isArray(person.personal_emails) ? person.personal_emails : [])) {
    add(value, 'personal');
  }

  return found;
}

// Apollo can return a work address and a personal one for the same person, and
// a recruiter wants both: the work address to approach them professionally, the
// personal one to reach them after they leave. So both are carried, rather than
// the second being dropped because the first was found. `email` stays the
// primary - a work address when there is one - so existing callers are
// unaffected.
//
// 'unknown' is a kind only the waterfall reader below ever produces: an address
// Apollo returned without saying what kind it is. It sorts last, so it can
// never displace a stated work or personal address, and collectEmails never
// yields one - which is why the enrichment path is unchanged by its existence.
function resolveFound(found) {
  const work = found.find((entry) => entry.emailType === 'work');
  const personal = found.find((entry) => entry.emailType === 'personal');
  const unstated = found.find((entry) => entry.emailType === 'unknown');
  const primary = work || personal || unstated || null;

  return {
    email: primary ? primary.email : null,
    emailType: primary ? primary.emailType : null,
    // Null when the primary already is the personal address: the same value is
    // never shown twice under two labels.
    personalEmail: personal && (!primary || personal.email !== primary.email) ? personal.email : null
  };
}

function resolveEmail(person) {
  return resolveFound(collectEmails(person));
}

// Returns the first non-empty list of strings among the candidates. Apollo
// spells these differently across endpoints and plans; an absent list stays
// empty rather than becoming a guessed value.
function stringList(...candidates) {
  for (const value of candidates) {
    if (!Array.isArray(value)) continue;
    const items = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
    if (items.length) return items;
  }
  return [];
}

function normalizeEmployment(entry = {}) {
  return {
    organization: firstValue(entry.organization_name, entry.organization?.name),
    title: firstValue(entry.title),
    startDate: firstValue(entry.start_date),
    endDate: firstValue(entry.end_date),
    current: entry.current === true
  };
}

function normalizeEmploymentHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter(Boolean)
    .map(normalizeEmployment)
    .filter((entry) => entry.organization || entry.title);
}

export function normalizeCandidate(person = {}, { enriched = false, requestedId = null } = {}) {
  const organization = person.organization || person.current_organization || {};
  const location = firstValue(person.location, person.city, person.state, person.country);
  const linkedinUrl = firstValue(person.linkedin_url, person.linkedinUrl);
  const { email, emailType, personalEmail } = resolveEmail(person);
  const phone = firstValue(person.phone_number, person.phone);
  const hasPhoneOnFile = phoneOnFile(person);
  return {
    id: firstValue(person.id, person.person_id, requestedId),
    // The ID the recruiter selected, so the client can reconcile an Apollo
    // response even when Apollo echoes a different canonical person ID.
    requestedId,
    name: firstValue(person.name, [person.first_name, person.last_name].filter(Boolean).join(' ')),
    title: firstValue(person.title, person.job_title),
    headline: firstValue(person.headline),
    company: firstValue(person.organization_name, organization.name),
    location,
    seniority: firstValue(person.seniority),
    departments: stringList(person.departments, person.subdepartments, person.functions),
    skills: stringList(person.skills, person.keywords),
    linkedinUrl,
    email,
    // 'work' | 'personal' | null - which kind of address the above is, so the
    // UI can label it honestly instead of assuming.
    emailType,
    // Apollo's own has_email flag, returned free on every search result. false
    // means Apollo holds no address at all, so revealing that candidate can only
    // ever come back empty. null when Apollo did not say.
    hasEmailOnFile: typeof person.has_email === 'boolean' ? person.has_email : null,
    // A personal address Apollo returned alongside the primary one. Null when
    // Apollo sent none, or when the primary already is the personal address.
    personalEmail,
    phone,
    // Apollo's own has_direct_phone, returned free on every search result.
    // true means it holds a direct dial, false means it holds none, and null
    // means Apollo would not say without being asked. It is what lets a
    // recruiter see which candidates a mobile credit is worth spending on.
    hasPhoneOnFile,
    emailAvailable: Boolean(email) || emailStatusAvailable(person.email_status)
      || person.email_available === true || person.has_email === true,
    phoneAvailable: Boolean(phone) || hasPhoneOnFile === true,
    employmentHistory: normalizeEmploymentHistory(person.employment_history),
    enriched
  };
}

export function batchIds(ids, size = BULK_MATCH_BATCH_SIZE) {
  const batches = [];
  for (let index = 0; index < ids.length; index += size) batches.push(ids.slice(index, index + size));
  return batches;
}

// Apollo's own status values for an address it holds. Narrowing to these costs
// nothing - search is free - and keeps enrichment credits off candidates Apollo
// has no address for at all.
const REACHABLE_EMAIL_STATUSES = ['verified', 'likely to engage'];

export async function searchPeople(filters, page = 1, perPage = 25, { verifiedEmailOnly = false } = {}) {
  const body = { page, per_page: perPage };
  if (verifiedEmailOnly) body.contact_email_status = REACHABLE_EMAIL_STATUSES;
  // Apollo's own name filter, which searches the whole pool rather than the
  // page in hand. Without it, looking for one person means paging through
  // every result by hand.
  if (filters.personName) body.q_person_name = filters.personName;
  if (filters.jobTitle) body.person_titles = [filters.jobTitle];
  if (filters.location) body.person_locations = [filters.location];
  if (filters.seniority) body.person_seniorities = [filters.seniority];
  if (filters.keywords) body.q_keywords = filters.keywords;
  if (filters.company) body.organization_names = [filters.company];
  if (filters.industry) body.organization_industries = [filters.industry];
  const result = await apolloRequest('/mixed_people/api_search', body);
  const people = result.people || result.contacts || [];
  return {
    candidates: people.map((person) => normalizeCandidate(person)),
    page,
    perPage,
    total: firstValue(result.total_entries, result.total_results, result.pagination?.total_entries)
  };
}

// Enriches exactly the supplied IDs, in sequential batches of
// BULK_MATCH_BATCH_SIZE. Pass revealPersonalEmails to spend the extra credits
// Apollo charges for contact data; the default never does. Apollo aligns
// `matches` positionally with the `details` it was sent, so an ID whose slot
// comes back empty is reported as failed instead of silently dropped.
export async function enrichPeople(ids, { revealPersonalEmails = false } = {}) {
  const candidates = [];
  const failedIds = [];
  const errors = [];

  for (const batch of batchIds(ids)) {
    let result;
    try {
      result = await apolloRequest('/people/bulk_match', {
        details: batch.map((id) => ({ id })),
        // Credit guard: personal emails cost extra, so they are revealed only
        // when the recruiter explicitly asked for them. Never on a search, and
        // never on plain enrichment.
        reveal_personal_emails: revealPersonalEmails === true
        // reveal_phone_number is deliberately absent. Phone reveal is a
        // separate task: it is asynchronous, needs a webhook or polling, and
        // costs far more per record. This request is email-only, and sending
        // the flag at all - even as false - would misstate that.
      });
    } catch (error) {
      // One failed batch must not discard the batches that succeeded.
      errors.push(error);
      failedIds.push(...batch);
      continue;
    }
    const matches = Array.isArray(result.matches) ? result.matches : (Array.isArray(result.people) ? result.people : []);
    batch.forEach((id, index) => {
      const person = matches[index];
      if (person && firstValue(person.id, person.person_id, person.name)) {
        candidates.push(normalizeCandidate(person, { enriched: true, requestedId: id }));
      } else {
        failedIds.push(id);
      }
    });
  }

  // Nothing came back at all and Apollo reported a reason: surface it so the
  // recruiter sees "rate limit" rather than a silent empty result.
  if (!candidates.length && errors.length) throw errors[0];
  return { candidates, failedIds };
}

// --- Apollo's waterfall response shape --------------------------------------
//
// A waterfall answer is not an enrichment record. Apollo returns the person id
// plus what the vendors found, in fields the enrichment payload never uses:
//
//   { id, waterfall: { emails: [{ vendors: [{ name, status, emails: [...] }] }] },
//     emails: [...], phone_numbers: [...] }
//
// Every field normalizeCandidate reads is therefore absent, and it produced a
// record with a null name and a null email even when Apollo had found an
// address. The readers below cover the waterfall fields. Each value still
// passes the same masked, placeholder and shape rules as any other address, and
// nothing is ever assembled from a name and a domain.

// Filler that can arrive where a number should be. None of these are numbers a
// recruiter can dial.
const PLACEHOLDER_PHONES = new Set(['n/a', 'na', 'none', 'null', 'nil', 'unknown', 'not available']);

// A shape check, not validation, matching EMAIL_SHAPE's intent: Apollo owns
// whether a number is correct, we own not presenting something that plainly is
// not a number at all. Seven digits is the shortest real subscriber number.
function realPhone(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || PLACEHOLDER_PHONES.has(trimmed.toLowerCase())) return null;
  return (trimmed.match(/\d/g) || []).length >= 7 ? trimmed : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// Apollo's own word for what kind of address an entry is. Only these exact
// values are a claim; anything else - including a missing field - leaves the
// kind unstated rather than assumed, because guessing "work" would label a
// candidate's own mailbox as their employer's.
function statedEmailType(entry) {
  const raw = firstValue(entry?.type, entry?.email_type, entry?.kind, entry?.category);
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase().replace(/\s+/g, '_');
  if (value === 'personal' || value === 'personal_email' || value === 'home') return 'personal';
  if (value === 'work' || value === 'work_email' || value === 'professional' || value === 'business' || value === 'office') return 'work';
  return null;
}

// An entry may be a bare string or an object, and Apollo is not consistent
// about which key carries the value. Anything else - a number, null, a nested
// array - yields nothing rather than being coerced into a string.
function emailFromEntry(entry) {
  if (typeof entry === 'string') return { value: entry, emailType: null };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const value = firstValue(entry.email, entry.email_address, entry.address, entry.value);
  return { value, emailType: statedEmailType(entry) };
}

function phoneFromEntry(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return firstValue(entry.sanitized_number, entry.raw_number, entry.number, entry.phone_number, entry.phone, entry.value);
}

// Every real address in a waterfall answer, tagged with the kind Apollo stated
// for it. An entry Apollo gave no kind for is 'unknown' unless it sits on a
// consumer mailbox domain, which is the same rule the enrichment path already
// applies: the domain is data Apollo sent, not an inference about the person.
// An unstated kind is never reported as 'work'.
function collectWaterfallEmails(person) {
  const found = [];
  const seen = new Set();
  const add = (entry) => {
    const parsed = emailFromEntry(entry);
    if (!parsed) return;
    const email = realEmail(parsed.value);
    if (!email || seen.has(email.toLowerCase())) return;
    seen.add(email.toLowerCase());
    found.push({ email, emailType: parsed.emailType || classifyEmail(email, 'unknown') });
  };

  for (const entry of asArray(person?.emails)) add(entry);
  for (const group of asArray(person?.waterfall?.emails)) {
    for (const entry of asArray(group?.emails)) add(entry);
    for (const vendor of asArray(group?.vendors)) for (const entry of asArray(vendor?.emails)) add(entry);
  }
  return found;
}

// The same walk for numbers. Apollo mirrors the email structure for phone, and
// its own result summary counts `mobile_records_enriched` alongside the email
// tally, so both nestings are read; an absent one simply yields nothing.
function collectWaterfallPhones(person) {
  const found = [];
  const seen = new Set();
  const add = (entry) => {
    const phone = realPhone(phoneFromEntry(entry));
    if (!phone || seen.has(phone)) return;
    seen.add(phone);
    found.push(phone);
  };

  for (const entry of asArray(person?.phone_numbers)) add(entry);
  // Apollo nests revealed contact data under `contact` on some responses, and
  // carries a single number in a field of its own on others. Missing those
  // would mean a mobile credit spent and nothing shown for it.
  //
  // organization.phone is deliberately never read: that is the employer's
  // switchboard, and presenting it as the candidate's own number would be a
  // fabrication dressed up as data.
  for (const entry of asArray(person?.contact?.phone_numbers)) add(entry);
  for (const value of [
    person?.sanitized_phone, person?.contact?.sanitized_phone,
    person?.mobile_phone, person?.contact?.mobile_phone,
    person?.direct_phone, person?.contact?.direct_phone,
    person?.contact?.phone_number, person?.contact?.phone
  ]) add(value);
  for (const group of asArray(person?.waterfall?.phone_numbers)) {
    for (const entry of asArray(group?.phone_numbers)) add(entry);
    for (const vendor of asArray(group?.vendors)) {
      for (const entry of asArray(vendor?.phone_numbers)) add(entry);
      for (const entry of asArray(vendor?.phones)) add(entry);
    }
  }
  return found;
}

// The vendors Apollo actually queried and what each answered. Reported so the
// recruiter can be told which sources were checked instead of a vague "other
// data sources"; a vendor is only ever named because Apollo named it. A
// NOT_FOUND vendor is a completed lookup with no result, not an error.
function collectWaterfallVendors(person) {
  const vendors = [];
  const groups = [...asArray(person?.waterfall?.emails), ...asArray(person?.waterfall?.phone_numbers)];
  for (const group of groups) {
    for (const vendor of asArray(group?.vendors)) {
      if (!vendor || typeof vendor !== 'object' || Array.isArray(vendor)) continue;
      const name = firstValue(vendor.name, vendor.id);
      if (typeof name !== 'string') continue;
      vendors.push({
        name,
        status: firstValue(vendor.status),
        statusCode: firstValue(vendor.statusCode, vendor.status_code)
      });
    }
  }
  return vendors;
}

// One entry per vendor name, keeping the first status seen for it. A batch
// asks every vendor about every person, so the raw list repeats each vendor
// once per candidate.
function dedupeVendors(vendors) {
  const byName = new Map();
  for (const vendor of vendors) {
    if (vendor?.name && !byName.has(vendor.name)) byName.set(vendor.name, vendor);
  }
  return [...byName.values()];
}

// Normalizes one person out of a waterfall answer. It starts from the ordinary
// normalizer, so a payload that does carry enrichment fields is still read the
// way it always was, and then overlays what the waterfall-only fields hold.
// Contact fields are only overwritten when Apollo actually returned a value:
// "Apollo found nothing" must leave a null behind, never a placeholder.
export function normalizeWaterfallCandidate(person = {}, { requestedId = null, kind = 'email' } = {}) {
  const base = normalizeCandidate(person, { enriched: true, requestedId });
  // Addresses Apollo stated a kind for come first, so a stated kind always wins
  // over an unstated one for the same person.
  const found = [...collectEmails(person), ...collectWaterfallEmails(person)]
    .filter((entry, index, all) => all.findIndex((other) => other.email.toLowerCase() === entry.email.toLowerCase()) === index);
  const { email, emailType, personalEmail } = resolveFound(found);
  const phones = collectWaterfallPhones(person);
  const phone = base.phone || phones[0] || null;
  const vendors = collectWaterfallVendors(person);

  return {
    ...base,
    email,
    emailType,
    personalEmail,
    phone,
    emailAvailable: Boolean(email) || base.emailAvailable,
    phoneAvailable: Boolean(phone) || base.phoneAvailable,
    // What Apollo's vendors reported, so "no personal email found" can say
    // which sources were actually checked.
    vendors,
    // Which question this record answers. A phone job says nothing about a
    // personal address and an email job says nothing about a number, so a blank
    // field only means "none found" for the one that was actually asked.
    waterfallChecked: kind === 'email',
    phoneChecked: kind === 'phone'
  };
}

// Matches one person the recruiter already knows, rather than filtering a pool.
// Apollo's match endpoint takes any combination of identifiers and answers with
// at most one person, so a lookup can never return a list to page through.
//
// The reveal flags are handled exactly as plain enrichment handles them:
// personal emails are explicitly not asked for, and phone reveal is not
// mentioned at all. A lookup therefore costs whatever a match costs and never
// the extra that contact data costs; the recruiter still reaches a personal
// address only through the reveal action.
export async function matchPerson({ name = '', company = '', email = '', linkedinUrl = '' } = {}) {
  const body = {};
  // Sent in order of how precisely each one identifies a person, so Apollo has
  // the strongest identifier available to it. Only non-empty ones are sent: an
  // empty string is a filter Apollo would try to match on.
  if (email) body.email = email;
  if (linkedinUrl) body.linkedin_url = linkedinUrl;
  if (name) body.name = name;
  if (company) body.organization_name = company;
  if (!Object.keys(body).length) throw new Error('MISSING_LOOKUP_IDENTIFIER');
  body.reveal_personal_emails = false;
  // reveal_phone_number is deliberately absent, for the same reason as in
  // enrichPeople: phone reveal is a separate, far costlier task.

  const result = await apolloRequest('/people/match', body);
  // Apollo has answered this in more than one shape across versions, and an
  // unmatched lookup answers with a null person rather than an error.
  const person = result.person
    || (Array.isArray(result.people) ? result.people[0] : null)
    || (Array.isArray(result.matches) ? result.matches[0] : null);
  if (!person || !firstValue(person.id, person.person_id, person.name)) return null;
  return normalizeCandidate(person, { enriched: true });
}

// Waterfall enrichment is a different thing from reveal. Reveal unlocks an
// address Apollo already holds; waterfall asks Apollo to go and look through
// third-party data sources for one it does not. It is asynchronous: the POST
// answers immediately with a request_id and the found addresses arrive later,
// either at a webhook or - as here - by polling for the same request_id.
export const WATERFALL_PENDING = 'pending';
export const WATERFALL_READY = 'ready';
export const WATERFALL_EXPIRED = 'expired';

// Apollo's own advice when it has nothing yet, used only if it sends no number.
const DEFAULT_RETRY_SECONDS = 10;

// Starts a waterfall search for the given IDs. Apollo requires a webhook_url
// even when the caller intends to poll, so a missing one is refused here rather
// than becoming an opaque 400 from Apollo.
export async function requestWaterfallEmails(ids, webhookUrl) {
  if (!webhookUrl) throw new Error('MISSING_APOLLO_WEBHOOK_URL');
  const requests = [];
  const candidates = [];
  const failedIds = [];
  const errors = [];

  for (const batch of batchIds(ids)) {
    let result;
    let rawText = '';
    try {
      const answer = await apolloRequestRaw('/people/bulk_match', {
        details: batch.map((id) => ({ id })),
        reveal_personal_emails: true,
        run_waterfall_email: true,
        webhook_url: webhookUrl
        // run_waterfall_phone stays off: phone is a separate, far costlier task.
      });
      result = answer.data;
      rawText = answer.text;
    } catch (error) {
      // One failed batch must not discard the batches that succeeded.
      errors.push(error);
      failedIds.push(...batch);
      continue;
    }

    // Read from the raw text, never from result.request_id, which JSON.parse
    // has already rounded past the point of being usable.
    const requestId = readRequestId(rawText);
    if (requestId) requests.push({ requestId, ids: batch });

    // The synchronous half still carries whatever Apollo already held, so the
    // recruiter sees work addresses immediately instead of waiting on the
    // waterfall for data that was never going to change.
    const matches = Array.isArray(result.matches) ? result.matches : (Array.isArray(result.people) ? result.people : []);
    batch.forEach((id, index) => {
      const person = matches[index];
      if (person && firstValue(person.id, person.person_id, person.name)) {
        candidates.push(normalizeCandidate(person, { enriched: true, requestedId: id }));
      }
    });
  }

  if (!requests.length && errors.length) throw errors[0];
  return { requests, candidates, failedIds };
}

// Asks Apollo for the phone numbers it holds for the given people.
//
// Phone reveal is asynchronous in the same way waterfall email is: the POST
// answers with a request_id and the numbers themselves arrive later, at the
// webhook or by polling. It is also the most expensive thing this app can ask
// for - Apollo charges mobile credits per number, well above an email - which
// is why it is a request of its own that nothing else can trigger.
export async function requestPhoneNumbers(ids, webhookUrl) {
  if (!webhookUrl) throw new Error('MISSING_APOLLO_WEBHOOK_URL');
  const requests = [];
  const candidates = [];
  const failedIds = [];
  const errors = [];

  for (const batch of batchIds(ids)) {
    let result;
    let rawText = '';
    try {
      const answer = await apolloRequestRaw('/people/bulk_match', {
        details: batch.map((id) => ({ id })),
        reveal_phone_number: true,
        webhook_url: webhookUrl
        // reveal_personal_emails stays off. Email is its own action with its own
        // price, and folding it in here would spend those credits again on
        // people whose address the recruiter already has.
      });
      result = answer.data;
      rawText = answer.text;
    } catch (error) {
      // One failed batch must not discard the batches that succeeded.
      errors.push(error);
      failedIds.push(...batch);
      continue;
    }

    // Read from the raw text: JSON.parse has already rounded request_id past
    // the point of being usable.
    const requestId = readRequestId(rawText);
    if (requestId) requests.push({ requestId, ids: batch });

    // Whatever Apollo already held comes back synchronously, so a number it
    // had on file appears at once instead of waiting on the slow half.
    const matches = Array.isArray(result.matches) ? result.matches : (Array.isArray(result.people) ? result.people : []);
    batch.forEach((id, index) => {
      const person = matches[index];
      if (person && firstValue(person.id, person.person_id, person.name)) {
        candidates.push(normalizeWaterfallCandidate(person, { requestedId: id, kind: 'phone' }));
      }
    });
  }

  if (!requests.length && errors.length) throw errors[0];
  return { requests, candidates, failedIds };
}

// Reads the result of one waterfall request. Costs no credits. Apollo answers a
// job still running with 404 result_pending and a retry hint, which is a normal
// state here rather than an error.
export async function pollWaterfallResult(requestId, { kind = 'email' } = {}) {
  const response = await fetch(`${APOLLO_BASE_URL}/webhook_result/${encodeURIComponent(requestId)}`, {
    headers: apolloHeaders()
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }

  if (response.status === 401 || response.status === 403) throw new Error('APOLLO_AUTH');
  if (response.status === 429) throw new Error('APOLLO_RATE_LIMIT');

  if (response.status === 404 && /result_pending/i.test(text)) {
    return {
      status: WATERFALL_PENDING,
      retryAfterSeconds: Number(data?.retry_after_seconds) > 0 ? Number(data.retry_after_seconds) : DEFAULT_RETRY_SECONDS,
      candidates: []
    };
  }
  // Unknown, expired or malformed request ids are terminal: stop polling.
  if (response.status === 400 || response.status === 404 || response.status === 410) {
    return { status: WATERFALL_EXPIRED, candidates: [] };
  }
  if (!response.ok) throw new Error('APOLLO_UNAVAILABLE');

  // The finished job nests its payload under webhook_result: the top level only
  // carries delivery status. Reading the top level finds no people at all.
  const result = data?.webhook_result && typeof data.webhook_result === 'object' ? data.webhook_result : data;
  const people = Array.isArray(result?.people) ? result.people : (Array.isArray(result?.matches) ? result.matches : []);
  const candidates = people
    .filter((person) => person && firstValue(person.id, person.person_id))
    .map((person) => normalizeWaterfallCandidate(person, { requestedId: firstValue(person.id, person.person_id), kind }));

  return {
    status: WATERFALL_READY,
    candidates,
    // Apollo's own tally. It is the only way to tell "nothing was found" from
    // "something was found but never reached us", which look identical in the
    // people array when webhook delivery failed.
    summary: {
      emailsFound: Number(result?.email_records_enriched) || 0,
      emailsNotFound: Number(result?.email_records_not_found) || 0,
      creditsConsumed: Number(result?.credits_consumed) || 0,
      // Which sources Apollo actually queried, deduplicated across the batch.
      // Only vendors Apollo named appear here, so the recruiter is never told
      // a source was checked that Apollo did not report.
      vendors: dedupeVendors(candidates.flatMap((candidate) => candidate.vendors || []))
    },
    // Apollo's own word for what job this was, so a caller reading a result it
    // did not start can tell what it is looking at.
    requestType: firstValue(result?.request_type, data?.request_type) || null,
    // Apollo posts the addresses themselves to the webhook. When that delivery
    // fails, the polled copy carries person ids but no contact data, so this is
    // reported rather than passed off as an empty result.
    delivery: {
      status: firstValue(data?.webhook_status) || null,
      failureReason: firstValue(data?.failure_reason) || null
    }
  };
}
