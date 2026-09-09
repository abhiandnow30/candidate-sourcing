const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';

// Apollo's bulk match endpoint accepts a limited number of people per call.
// Larger selections are split into sequential batches so a recruiter can
// enrich more people than one Apollo request allows.
export const BULK_MATCH_BATCH_SIZE = 10;

// Apollo returns this sentinel address instead of a real email when the
// contact is not unlocked on the current plan. It is not a real address.
const MASKED_EMAIL = /^email_not_unlocked@/i;

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

async function apolloRequest(path, body) {
  const response = await fetch(`${APOLLO_BASE_URL}${path}`, {
    method: 'POST', headers: apolloHeaders(), body: JSON.stringify(body)
  });
  if (response.status === 401 || response.status === 403) throw new Error('APOLLO_AUTH');
  if (response.status === 429) throw new Error('APOLLO_RATE_LIMIT');
  if (!response.ok) throw new Error('APOLLO_UNAVAILABLE');
  return response.json();
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function realEmail(value) {
  return typeof value === 'string' && value !== '' && !MASKED_EMAIL.test(value) ? value : null;
}

function emailStatusAvailable(status) {
  if (typeof status !== 'string' || status.trim() === '') return false;
  return !UNAVAILABLE_EMAIL_STATUSES.has(status.trim().toLowerCase().replace(/\s+/g, '_'));
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
  const email = realEmail(firstValue(person.email));
  const phone = firstValue(person.phone_number, person.phone);
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
    phone,
    emailAvailable: Boolean(email) || emailStatusAvailable(person.email_status) || person.email_available === true,
    phoneAvailable: Boolean(phone) || person.phone_available === true,
    employmentHistory: normalizeEmploymentHistory(person.employment_history),
    enriched
  };
}

export function batchIds(ids, size = BULK_MATCH_BATCH_SIZE) {
  const batches = [];
  for (let index = 0; index < ids.length; index += size) batches.push(ids.slice(index, index + size));
  return batches;
}

export async function searchPeople(filters, page = 1, perPage = 25) {
  const body = { page, per_page: perPage };
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

// Enriches exactly the supplied IDs, in sequential batches. Apollo aligns
// `matches` positionally with the `details` it was sent, so an ID whose slot
// comes back empty is reported as failed instead of silently dropped.
export async function enrichPeople(ids) {
  const candidates = [];
  const failedIds = [];
  const errors = [];

  for (const batch of batchIds(ids)) {
    let result;
    try {
      result = await apolloRequest('/people/bulk_match', {
        details: batch.map((id) => ({ id })),
        reveal_personal_emails: false,
        reveal_phone_number: false
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
