import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.APOLLO_API_KEY = 'test-only-key';
delete process.env.ALLOWED_ORIGIN;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realFetch = globalThis.fetch.bind(globalThis);
const { default: app } = await import('./index.js');

const ok = (payload) => new Response(JSON.stringify(payload), { status: 200 });

// Boots the app on an ephemeral port and routes only api.apollo.io calls to
// the stub, so loopback requests to our own server still work.
async function withServer(apolloHandler, run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const apolloCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('api.apollo.io')) return realFetch(url, options);
    const body = options?.body ? JSON.parse(options.body) : null;
    apolloCalls.push({ url: String(url), headers: options?.headers || {}, body });
    return apolloHandler({ url: String(url), body, index: apolloCalls.length - 1 });
  };
  const post = async (endpoint, payload, headers = {}) => {
    const response = await realFetch(base + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload)
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  try {
    return await run({ post, apolloCalls });
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('search returns normalized candidates through our backend', async () => {
  await withServer(() => ok({ people: [{ id: 'person-1', name: 'Test Candidate', title: 'Engineer' }], total_entries: 1 }), async ({ post, apolloCalls }) => {
    const { status, body } = await post('/api/candidates/search', { jobTitle: 'Java Developer', location: 'Delhi', keywords: 'Java', page: 2 });
    assert.equal(status, 200);
    assert.equal(body.candidates.length, 1);
    assert.equal(body.candidates[0].name, 'Test Candidate');
    assert.equal(body.page, 2);
    assert.deepEqual(apolloCalls[0].body.person_titles, ['Java Developer']);
    assert.equal(apolloCalls[0].body.page, 2);
  });
});

test('search requires role, skills and location before calling Apollo', async () => {
  const complete = { jobTitle: 'Java Developer', location: 'Delhi', keywords: 'Java' };
  await withServer(() => ok({ people: [] }), async ({ post, apolloCalls }) => {
    const cases = [
      [{}, ['jobTitle', 'location', 'keywords']],
      [{ page: 1 }, ['jobTitle', 'location', 'keywords']],
      [{ ...complete, jobTitle: '' }, ['jobTitle']],
      [{ ...complete, location: '   ' }, ['location']],
      [{ ...complete, keywords: '' }, ['keywords']],
      [{ seniority: 'senior', company: 'Example Co', industry: 'Software' }, ['jobTitle', 'location', 'keywords']]
    ];
    for (const [payload, expectedMissing] of cases) {
      const { status, body } = await post('/api/candidates/search', payload);
      assert.equal(status, 400, JSON.stringify(payload));
      assert.equal(body.error, 'Role / job title, skills / keywords and location are required.');
      assert.deepEqual(body.missing, expectedMissing);
    }
    assert.equal(apolloCalls.length, 0, 'no credit is spent on a query that cannot be meaningful');
  });
});

test('the three required filters are enough on their own', async () => {
  await withServer(() => ok({ people: [{ id: 'person-1', name: 'Test Candidate' }], total_entries: 1 }), async ({ post, apolloCalls }) => {
    const { status } = await post('/api/candidates/search', { jobTitle: 'Java Developer', location: 'Delhi', keywords: 'Java' });
    assert.equal(status, 200);
    assert.deepEqual(apolloCalls[0].body.person_titles, ['Java Developer']);
    assert.deepEqual(apolloCalls[0].body.person_locations, ['Delhi']);
    assert.equal(apolloCalls[0].body.q_keywords, 'Java');
  });
});

test('enrich forwards only the selected person IDs, deduplicated', async () => {
  await withServer(({ body }) => ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) }), async ({ post, apolloCalls }) => {
    const { status, body } = await post('/api/candidates/enrich', { ids: ['person-1', 'person-2', 'person-1', '', '   ', 42, null] });
    assert.equal(status, 200);
    assert.deepEqual(body.requestedIds, ['person-1', 'person-2']);
    assert.deepEqual(apolloCalls[0].body.details, [{ id: 'person-1' }, { id: 'person-2' }]);
    assert.deepEqual(body.failedIds, []);
    assert.equal(body.candidates.length, 2);
  });
});

test('enrich rejects an empty selection without calling Apollo', async () => {
  await withServer(() => ok({}), async ({ post, apolloCalls }) => {
    for (const payload of [{ ids: [] }, { ids: 'person-1' }, {}]) {
      const { status, body } = await post('/api/candidates/enrich', payload);
      assert.equal(status, 400);
      assert.equal(body.error, 'Select at least one candidate to enrich.');
    }
    assert.equal(apolloCalls.length, 0, 'no Apollo credits are spent on an empty selection');
  });
});

test('enrich splits a large selection into Apollo batches', async () => {
  const ids = Array.from({ length: 23 }, (_, index) => `person-${index}`);
  await withServer(({ body }) => ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) }), async ({ post, apolloCalls }) => {
    const { body } = await post('/api/candidates/enrich', { ids });
    assert.deepEqual(apolloCalls.map((call) => call.body.details.length), [10, 10, 3]);
    assert.equal(body.candidates.length, 23);
    assert.deepEqual(body.candidates.map((candidate) => candidate.requestedId), ids);
    assert.deepEqual(body.skippedIds, []);
  });
});

test('enrich caps one request and reports the rest as skipped, never dropped', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => `person-${index}`);
  await withServer(({ body }) => ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) }), async ({ post }) => {
    const { body } = await post('/api/candidates/enrich', { ids });
    assert.equal(body.requestedIds.length, 25);
    assert.deepEqual(body.skippedIds, ids.slice(25));
    assert.equal(body.requestedIds.length + body.skippedIds.length, 30, 'every selected ID is accounted for');
  });
});

test('enrich reports partial results with the failed IDs', async () => {
  await withServer(({ body }) => ok({ matches: body.details.map(({ id }) => (id === 'person-3' ? null : { id, name: `Candidate ${id}` })) }), async ({ post }) => {
    const { status, body } = await post('/api/candidates/enrich', { ids: ['person-1', 'person-2', 'person-3', 'person-4', 'person-5'] });
    assert.equal(status, 200);
    assert.equal(body.candidates.length, 4);
    assert.deepEqual(body.failedIds, ['person-3']);
    assert.equal(body.requestedIds.length, 5);
  });
});

test('Apollo failures become sanitized client errors', async () => {
  const cases = [
    [401, 502, 'Apollo API authentication failed.'],
    [429, 429, 'Apollo API rate limit reached. Please try again later.'],
    [500, 502, 'Unable to connect to Apollo. Please try again.']
  ];
  for (const [upstream, expectedStatus, expectedMessage] of cases) {
    await withServer(() => new Response(JSON.stringify({ error: 'upstream detail', key: 'test-only-key' }), { status: upstream }), async ({ post }) => {
      const { status, body } = await post('/api/candidates/enrich', { ids: ['person-1'] });
      assert.equal(status, expectedStatus, `upstream ${upstream}`);
      assert.equal(body.error, expectedMessage);
      assert.deepEqual(Object.keys(body), ['error'], 'no upstream detail is echoed');
    });
  }
});

test('the Apollo key never appears in any API response', async () => {
  await withServer(({ body }) => ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) }), async ({ post, apolloCalls }) => {
    const search = await post('/api/candidates/search', { jobTitle: 'Java Developer', location: 'Delhi', keywords: 'Java' });
    const enrich = await post('/api/candidates/enrich', { ids: ['person-1'] });
    for (const response of [search, enrich]) {
      assert.doesNotMatch(JSON.stringify(response.body), /test-only-key/);
      assert.doesNotMatch(JSON.stringify(response.body), /APOLLO_API_KEY/);
    }
    assert.equal(apolloCalls.at(-1).headers['x-api-key'], 'test-only-key', 'the key is sent only from the backend to Apollo');
  });
});

test('credit-spending endpoints send no CORS headers by default', async () => {
  await withServer(() => ok({ matches: [] }), async ({ post }) => {
    const { headers } = await post('/api/candidates/enrich', { ids: [] }, { Origin: 'https://not-our-app.example' });
    assert.equal(headers.get('access-control-allow-origin'), null);
  });
});

test('no frontend source file references the Apollo key', async () => {
  const files = await readdir(path.join(projectRoot, 'src'), { recursive: true });
  // Shipped sources only. Test fixtures legitimately contain LinkedIn URLs
  // and are never bundled into the client.
  const sources = files.filter((file) => /\.(jsx?|css|html)$/.test(file) && !/\.test\./.test(file));
  assert.ok(sources.length > 0, 'found frontend sources to check');
  for (const file of sources) {
    const contents = readFileSync(path.join(projectRoot, 'src', file), 'utf8');
    assert.doesNotMatch(contents, /APOLLO_API_KEY/, `${file} must not reference the key`);
    assert.doesNotMatch(contents, /x-api-key/i, `${file} must not send an Apollo key`);
    assert.doesNotMatch(contents, /api\.apollo\.io/, `${file} must call our backend, not Apollo directly`);
    assert.doesNotMatch(contents, /linkedin\.com\/in/i, `${file} must not hardcode LinkedIn endpoints`);
  }
});

test('the frontend never stores candidate data in browser storage', async () => {
  const files = await readdir(path.join(projectRoot, 'src'), { recursive: true });
  for (const file of files.filter((name) => /\.jsx?$/.test(name) && !/\.test\./.test(name))) {
    const contents = readFileSync(path.join(projectRoot, 'src', file), 'utf8');
    assert.doesNotMatch(contents, /localStorage|sessionStorage/, `${file} must not persist Apollo data in the browser`);
    assert.doesNotMatch(contents, /<iframe/i, `${file} must not embed iframes`);
    assert.doesNotMatch(contents, /window\.open/, `${file} must not open profiles automatically`);
  }
});
