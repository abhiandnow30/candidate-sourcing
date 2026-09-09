import assert from 'node:assert/strict';
import test from 'node:test';
import { BULK_MATCH_BATCH_SIZE, batchIds, enrichPeople, normalizeCandidate, searchPeople } from './apolloService.js';

// Every test drives Apollo through a stub. No real Apollo call is made and no
// real candidate personal data appears anywhere in this file.
function stubApollo(handler) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.APOLLO_API_KEY;
  process.env.APOLLO_API_KEY = 'test-only-key';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), headers: options?.headers || {}, body });
    return handler({ url: String(url), body, index: calls.length - 1 });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.APOLLO_API_KEY;
      else process.env.APOLLO_API_KEY = originalKey;
    }
  };
}

const ok = (payload) => new Response(JSON.stringify(payload), { status: 200 });
const fail = (status) => new Response(JSON.stringify({ error: 'upstream detail that must not leak' }), { status });

test('normalizes Apollo people without inventing unavailable fields', () => {
  const candidate = normalizeCandidate({
    id: 'person-1', first_name: 'Test', last_name: 'Candidate', title: 'Engineer',
    organization: { name: 'Example Co' }, city: 'Hyderabad',
    linkedin_url: 'https://www.linkedin.com/in/apollo-result'
  });
  assert.deepEqual(candidate, {
    id: 'person-1', requestedId: null, name: 'Test Candidate', title: 'Engineer', headline: null,
    company: 'Example Co', location: 'Hyderabad', seniority: null, departments: [], skills: [],
    linkedinUrl: 'https://www.linkedin.com/in/apollo-result', email: null, phone: null,
    emailAvailable: false, phoneAvailable: false, employmentHistory: [], enriched: false
  });
});

test('treats the email_status enum as a value, not a truthy string', () => {
  assert.equal(normalizeCandidate({ id: 'a', email_status: 'unavailable' }).emailAvailable, false);
  assert.equal(normalizeCandidate({ id: 'a', email_status: '  Unavailable ' }).emailAvailable, false);
  assert.equal(normalizeCandidate({ id: 'a', email_status: 'verified' }).emailAvailable, true);
  assert.equal(normalizeCandidate({ id: 'a', phone_available: 'false' }).phoneAvailable, false);
});

test('never surfaces Apollo masked-email sentinels as a real address', () => {
  const candidate = normalizeCandidate({ id: 'a', email: 'email_not_unlocked@domain.com' });
  assert.equal(candidate.email, null);
  assert.equal(candidate.emailAvailable, false);
});

test('normalizes enriched professional fields and employment history', () => {
  const candidate = normalizeCandidate({
    id: 'person-9', name: 'Test Candidate', headline: 'Senior Java Developer | Java | Spring Boot',
    seniority: 'senior', departments: ['engineering'], skills: ['Java', ' Spring Boot ', '', 'SQL'],
    employment_history: [
      { organization_name: 'ABC Technologies', title: 'Senior Java Developer', current: true, start_date: '2021-01-01' },
      { organization_name: 'XYZ Technologies', title: 'Java Developer', current: false, start_date: '2018-01-01', end_date: '2020-12-01' },
      { organization_name: '', title: '' }
    ]
  }, { enriched: true, requestedId: 'person-9' });
  assert.equal(candidate.headline, 'Senior Java Developer | Java | Spring Boot');
  assert.equal(candidate.seniority, 'senior');
  assert.deepEqual(candidate.departments, ['engineering']);
  assert.deepEqual(candidate.skills, ['Java', 'Spring Boot', 'SQL']);
  assert.equal(candidate.enriched, true);
  assert.equal(candidate.requestedId, 'person-9');
  assert.equal(candidate.employmentHistory.length, 2, 'entries with neither org nor title are dropped');
  assert.deepEqual(candidate.employmentHistory[0], { organization: 'ABC Technologies', title: 'Senior Java Developer', startDate: '2021-01-01', endDate: null, current: true });
  assert.equal(candidate.employmentHistory[1].current, false);
});

test('leaves skills empty rather than guessing when Apollo omits them', () => {
  assert.deepEqual(normalizeCandidate({ id: 'a' }).skills, []);
  assert.deepEqual(normalizeCandidate({ id: 'a', skills: [] }).skills, []);
  assert.deepEqual(normalizeCandidate({ id: 'a', skills: 'Java' }).skills, [], 'a non-array is not coerced into a skill');
});

test('maps search filters and pagination to Apollo', async (t) => {
  const apollo = stubApollo(() => ok({ people: [{ id: 'person-2', name: 'Another Candidate' }], total_entries: 101 }));
  t.after(() => apollo.restore());
  const result = await searchPeople({ jobTitle: 'Java Developer', location: 'Hyderabad', seniority: 'senior', keywords: 'Java Spring Boot', company: 'Example Co', industry: 'Software' }, 3, 25);
  assert.equal(apollo.calls[0].url, 'https://api.apollo.io/api/v1/mixed_people/api_search');
  assert.deepEqual(apollo.calls[0].body, { page: 3, per_page: 25, person_titles: ['Java Developer'], person_locations: ['Hyderabad'], person_seniorities: ['senior'], q_keywords: 'Java Spring Boot', organization_names: ['Example Co'], organization_industries: ['Software'] });
  assert.equal(result.total, 101);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].enriched, false, 'search results are never marked enriched');
});

test('search sends no filter keys when the recruiter supplies none', async (t) => {
  const apollo = stubApollo(() => ok({ people: [] }));
  t.after(() => apollo.restore());
  const result = await searchPeople({ jobTitle: '', location: '', seniority: '', keywords: '', company: '', industry: '' }, 1, 25);
  assert.deepEqual(apollo.calls[0].body, { page: 1, per_page: 25 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.total, null);
});

test('batchIds splits without losing or duplicating IDs', () => {
  const ids = Array.from({ length: 23 }, (_, index) => `person-${index}`);
  const batches = batchIds(ids);
  assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 3]);
  assert.deepEqual(batches.flat(), ids);
  assert.equal(new Set(batches.flat()).size, 23);
  assert.equal(BULK_MATCH_BATCH_SIZE, 10);
});

test('enriches only the supplied person IDs', async (t) => {
  const apollo = stubApollo(() => ok({ matches: [{ id: 'person-3', name: 'Enriched Candidate', linkedin_url: 'https://www.linkedin.com/in/result' }] }));
  t.after(() => apollo.restore());
  const { candidates, failedIds } = await enrichPeople(['person-3']);
  assert.equal(apollo.calls.length, 1);
  assert.equal(apollo.calls[0].url, 'https://api.apollo.io/api/v1/people/bulk_match');
  assert.deepEqual(apollo.calls[0].body.details, [{ id: 'person-3' }]);
  assert.deepEqual(failedIds, []);
  assert.equal(candidates[0].email, null, 'a field Apollo withheld is not reconstructed');
  assert.equal(candidates[0].enriched, true);
});

test('splits a large selection across several Apollo batches', async (t) => {
  const ids = Array.from({ length: 23 }, (_, index) => `person-${index}`);
  const apollo = stubApollo(({ body }) => ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) }));
  t.after(() => apollo.restore());
  const { candidates, failedIds } = await enrichPeople(ids);
  assert.equal(apollo.calls.length, 3);
  assert.deepEqual(apollo.calls.map((call) => call.body.details.length), [10, 10, 3]);
  assert.deepEqual(failedIds, []);
  assert.equal(candidates.length, 23);
  assert.deepEqual(candidates.map((candidate) => candidate.requestedId), ids, 'no candidate lost or duplicated across batches');
});

test('reports partial enrichment when Apollo matches only some IDs', async (t) => {
  const apollo = stubApollo(({ body }) => ok({
    matches: body.details.map(({ id }) => (id === 'person-3' ? null : { id, name: `Candidate ${id}` }))
  }));
  t.after(() => apollo.restore());
  const { candidates, failedIds } = await enrichPeople(['person-1', 'person-2', 'person-3', 'person-4', 'person-5']);
  assert.equal(candidates.length, 4);
  assert.deepEqual(failedIds, ['person-3']);
  assert.ok(!candidates.some((candidate) => candidate.requestedId === 'person-3'));
});

test('keeps successful batches when a later batch fails', async (t) => {
  const ids = Array.from({ length: 15 }, (_, index) => `person-${index}`);
  const apollo = stubApollo(({ body, index }) => (index === 1
    ? fail(429)
    : ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) })));
  t.after(() => apollo.restore());
  const { candidates, failedIds } = await enrichPeople(ids);
  assert.equal(candidates.length, 10, 'the batch that succeeded is not discarded');
  assert.deepEqual(failedIds, ids.slice(10));
});

test('surfaces the Apollo failure when no batch succeeds', async (t) => {
  const apollo = stubApollo(() => fail(429));
  t.after(() => apollo.restore());
  await assert.rejects(() => enrichPeople(['person-1']), /APOLLO_RATE_LIMIT/);
});

test('maps Apollo HTTP failures to internal error codes', async () => {
  for (const [status, code] of [[401, 'APOLLO_AUTH'], [403, 'APOLLO_AUTH'], [429, 'APOLLO_RATE_LIMIT'], [500, 'APOLLO_UNAVAILABLE']]) {
    const apollo = stubApollo(() => fail(status));
    try {
      await assert.rejects(() => searchPeople({}, 1), new RegExp(code), `HTTP ${status}`);
    } finally {
      apollo.restore();
    }
  }
});

test('refuses to call Apollo without a server-side key', async (t) => {
  const originalKey = process.env.APOLLO_API_KEY;
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return ok({}); };
  delete process.env.APOLLO_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.APOLLO_API_KEY;
    else process.env.APOLLO_API_KEY = originalKey;
  });
  await assert.rejects(() => searchPeople({}, 1), /MISSING_APOLLO_API_KEY/);
  assert.equal(called, false, 'no request is attempted without a key');
});

test('the application only ever calls Apollo, never LinkedIn', async (t) => {
  const apollo = stubApollo(({ url, body }) => (url.includes('bulk_match')
    ? ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}`, linkedin_url: 'https://www.linkedin.com/in/example' })) })
    : ok({ people: [{ id: 'person-1', name: 'Candidate', linkedin_url: 'https://www.linkedin.com/in/example' }] })));
  t.after(() => apollo.restore());
  const search = await searchPeople({ jobTitle: 'Java Developer' }, 1);
  await enrichPeople(['person-1']);
  assert.ok(apollo.calls.length >= 2);
  for (const call of apollo.calls) {
    assert.equal(new URL(call.url).host, 'api.apollo.io', `unexpected host in ${call.url}`);
    assert.doesNotMatch(call.url, /linkedin/i);
    assert.doesNotMatch(JSON.stringify(call.body), /linkedin/i, 'a LinkedIn URL is never sent anywhere');
  }
  assert.equal(search.candidates[0].linkedinUrl, 'https://www.linkedin.com/in/example', 'the URL is passed through for manual use only');
});
