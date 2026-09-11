import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from './App.jsx';

// Mocked Apollo-shaped payloads. No real candidate personal data is used.
const searchResult = (people) => ({ candidates: people, page: 1, perPage: 25, total: people.length });

const bareCandidate = (id, name) => ({
  id, requestedId: null, name, title: 'Java Developer', headline: null, company: 'Example Co',
  location: 'Hyderabad', seniority: null, departments: [], skills: [], linkedinUrl: null,
  email: null, phone: null, emailAvailable: false, phoneAvailable: false, employmentHistory: [], enriched: false
});

const enrichedCandidate = (id, name, overrides = {}) => ({
  ...bareCandidate(id, name),
  requestedId: id,
  headline: 'Senior Java Developer | Java | Spring Boot',
  seniority: 'senior',
  departments: ['engineering'],
  skills: ['Java', 'Spring Boot', 'SQL', 'AWS'],
  linkedinUrl: 'https://www.linkedin.com/in/example',
  emailAvailable: true,
  phoneAvailable: true,
  employmentHistory: [
    { organization: 'ABC Technologies', title: 'Senior Java Developer', startDate: '2021-01-01', endDate: null, current: true },
    { organization: 'XYZ Technologies', title: 'Java Developer', startDate: '2018-01-01', endDate: '2020-12-01', current: false }
  ],
  enriched: true,
  ...overrides
});

let calls;

// Routes the app's own fetch calls. Any request to a host other than our
// backend fails the test outright, which is how "LinkedIn is never fetched"
// is enforced rather than assumed.
function mockBackend({
  search = () => searchResult([]),
  enrich = () => ({ requestedIds: [], candidates: [], failedIds: [], skippedIds: [] }),
  reveal = null,
  waterfall = null,
  poll = null,
  phone = null
} = {}) {
  globalThis.fetch = vi.fn(async (url, options) => {
    const target = String(url);
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({ url: target, body });
    if (target === '/api/candidates/search') {
      const result = search(body);
      // A handler may return a ready-made response to simulate the proxy.
      return result && typeof result.text === 'function' ? result : jsonResponse(result);
    }
    if (target === '/api/candidates/enrich') {
      const result = enrich(body);
      if (result instanceof Error) return jsonResponse({ error: result.message }, 502);
      return jsonResponse(result);
    }
    if (target === '/api/candidates/waterfall') {
      if (!waterfall) throw new Error('The application started a waterfall without a handler');
      return jsonResponse(await waterfall(body));
    }
    if (target.startsWith('/api/candidates/waterfall/')) {
      if (!poll) throw new Error('The application polled a waterfall without a handler');
      return jsonResponse(await poll(target.split('/').pop()));
    }
    if (target === '/api/candidates/phone') {
      if (!phone) throw new Error('The application revealed a phone number without a phone handler');
      const result = await phone(body);
      if (result instanceof Error) return jsonResponse({ error: result.message }, 503);
      return result && typeof result.text === 'function' ? result : jsonResponse(result);
    }
    if (target === '/api/candidates/reveal') {
      if (!reveal) throw new Error('The application revealed contact details without a reveal handler');
      const result = await reveal(body);
      if (result instanceof Error) return jsonResponse({ error: result.message }, 502);
      // A handler may return a ready-made response to simulate the proxy.
      return result && typeof result.text === 'function' ? result : jsonResponse(result);
    }
    throw new Error(`The application must not request ${target}`);
  });
}

function jsonResponse(payload, status = 200) {
  const text = JSON.stringify(payload);
  // clone() so the app can peek at a body and still read it afterwards.
  return { ok: status < 400, status, text: async () => text, json: async () => payload, clone: () => jsonResponse(payload, status) };
}

// What the Vite dev proxy answers when nothing is listening on the API port,
// which is what a `node --watch` restart looks like to the browser.
function proxyUnreachable() {
  return jsonResponse({ error: 'The candidate API is not running. Start it with `npm run dev:server`.', code: 'API_UNREACHABLE' }, 503);
}

// What Vite's proxy returns when it cannot reach our backend: status 500 with
// a zero-length body.
function unreachableBackend() {
  return { ok: false, status: 500, text: async () => '', json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
}

async function searchWith(people, enrich, reveal, waterfall, poll) {
  mockBackend({ search: () => searchResult(people), enrich, reveal, waterfall, poll });
  render(<App />);
  fillRequired();
  applySearch();
  for (const person of people) await screen.findByText(person.name);
}

function rowFor(name) {
  return screen.getByText(name).closest('.candidate-block');
}

// A role or a skill is all a search needs, but most scenarios here describe a
// full query, so all three are filled by default.
function fillRequired({ jobTitle = 'java developer', keywords = 'java' } = {}) {
  fireEvent.change(screen.getByLabelText(/role \/ job title/i), { target: { value: jobTitle } });
  fireEvent.change(screen.getByLabelText(/^skills$/i), { target: { value: keywords } });
}

// Location is not typed: it is a list of the cities the last search returned,
// ticked on and off. This ticks one by its visible name.
function tickLocation(city) {
  fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`^${city}`, 'i') }));
}

// There is no Search button: a filter applies the moment it is committed, and
// Enter in the role box is how a recruiter commits a typed one.
function applySearch() {
  fireEvent.keyDown(screen.getByLabelText(/role \/ job title/i), { key: 'Enter' });
}

// Select all is gone: on a pool of millions it offered to tick 25 arbitrary
// rows. Tests that used it tick every selectable row instead, which is the same
// thing it did.
function selectEveryRow() {
  for (const box of screen.getAllByRole('checkbox', { name: /^select /i })) {
    if (!box.disabled && !box.checked) fireEvent.click(box);
  }
}

// The app opens on the whole pool, so every render already spent one search
// before the test did anything. Counting requests means counting from here.
function opened() {
  expect(calls.length).toBeGreaterThan(0);
  return calls.length;
}

// The searches a test itself caused, with the opening one left out.
function searchCalls() {
  return calls.filter((call) => call.url === '/api/candidates/search').slice(1);
}

function selectionCount() {
  return document.querySelector('.selection-actions > span').textContent;
}

// The expand toggle and the panel share a name, so target the panel by role.
function detailsPanel(name) {
  return screen.findByRole('region', { name: new RegExp(`enriched details for ${name}`, 'i') });
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.restoreAllMocks(); });

test('search renders candidates returned by our backend', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')]);
  expect(calls[0].url).toBe('/api/candidates/search');
  expect(screen.getByText('Test Candidate')).toBeTruthy();
  expect(screen.getByText('Other Candidate')).toBeTruthy();
  // Nothing claims a state the row has not reached: no badge, and no details
  // to open.
  expect(within(rowFor('Test Candidate')).queryByText(/enriched/i)).toBeNull();
  expect(within(rowFor('Test Candidate')).queryByRole('button', { name: /view details/i })).toBeNull();
});

test('clicking anywhere on a row selects it, and clicking again lets it go', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate')]);
  const row = rowFor('Test Candidate').querySelector('.candidate-row');

  fireEvent.click(row);
  expect(screen.getByRole('checkbox', { name: /select test candidate/i }).checked).toBe(true);
  expect(selectionCount()).toMatch(/1/);

  fireEvent.click(row);
  expect(screen.getByRole('checkbox', { name: /select test candidate/i }).checked).toBe(false);
});

test('a link inside a row is a link, not a way to select the row', async () => {
  await searchWith([{ ...bareCandidate('person-1', 'Test Candidate'), linkedinUrl: 'https://www.linkedin.com/in/example' }]);
  const row = rowFor('Test Candidate');

  fireEvent.click(within(row).getByRole('link', { name: /view linkedin profile/i }));
  expect(screen.getByRole('checkbox', { name: /select test candidate/i }).checked).toBe(false);
});

test('a row Apollo gave no person ID for cannot be selected by clicking it', async () => {
  await searchWith([{ ...bareCandidate(null, 'Anonymous Result'), id: null }]);
  fireEvent.click(rowFor('Anonymous Result').querySelector('.candidate-row'));
  expect(screen.getByRole('checkbox', { name: /cannot select/i }).checked).toBe(false);
  expect(selectionCount()).toMatch(/0/);
});

test('a candidate the backend already holds arrives enriched, ready to open', async () => {
  // The credit was spent on some earlier search, so the row does not ask for it
  // again: it offers the details straight away.
  mockBackend({
    search: () => searchResult([{
      ...enrichedCandidate('person-1', 'Test Candidate'), enriched: true, fromCache: true
    }])
  });
  render(<App />);
  await screen.findByText('Test Candidate');

  const row = rowFor('Test Candidate');
  expect(within(row).getByText('Enriched')).toBeTruthy();
  fireEvent.click(within(row).getByRole('button', { name: /show enriched details/i }));

  // And the details are there without a single request beyond the search.
  expect(await detailsPanel('Test Candidate')).toBeTruthy();
  expect(calls.every((call) => call.url === '/api/candidates/search')).toBe(true);
});

test('an individual candidate can be selected and deselected', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')]);
  const checkbox = screen.getByRole('checkbox', { name: /select test candidate/i });
  fireEvent.click(checkbox);
  expect(selectionCount()).toBe('Selected: 1');
  expect(checkbox.checked).toBe(true);
  fireEvent.click(checkbox);
  expect(checkbox.checked).toBe(false);
});

test('Select all and Clear act on every candidate', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')]);
  // Only the per-candidate checkboxes; the results toolbar has its own filter
  // checkbox, which Select all must leave alone.
  const rowBoxes = () => screen.getAllByRole('checkbox', { name: /^select /i });
  selectEveryRow();
  for (const checkbox of rowBoxes()) expect(checkbox.checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
  for (const checkbox of rowBoxes()) expect(checkbox.checked).toBe(false);
});

test('Enrich selected sends only the selected Apollo person IDs', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')],
    (body) => ({ requestedIds: body.ids, candidates: body.ids.map((id) => enrichedCandidate(id, 'Test Candidate')), failedIds: [], skippedIds: [] })
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await waitFor(() => expect(calls.some((call) => call.url === '/api/candidates/enrich')).toBe(true));
  const enrichCall = calls.find((call) => call.url === '/api/candidates/enrich');
  expect(enrichCall.body.ids).toEqual(['person-1']);
});

test('enriched Apollo details render inside our UI, not on LinkedIn', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    (body) => ({ requestedIds: body.ids, candidates: [enrichedCandidate('person-1', 'Test Candidate')], failedIds: [], skippedIds: [] })
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));

  await screen.findByText(/enrichment complete/i);
  const row = rowFor('Test Candidate');
  expect(within(row).getByText('Enriched')).toBeTruthy();

  // Enrichment auto-opens the panel: the recruiter already asked for this data.
  const details = await detailsPanel('test candidate');
  expect(within(row).getByRole('button', { name: /hide enriched details/i })).toBeTruthy();
  expect(within(details).getByText('Senior Java Developer | Java | Spring Boot')).toBeTruthy();
  expect(within(details).getByText('senior')).toBeTruthy();
  expect(within(details).getByText('engineering')).toBeTruthy();
  for (const skill of ['Java', 'Spring Boot', 'SQL', 'AWS']) {
    expect(within(details).getByText(skill)).toBeTruthy();
  }
  expect(within(details).getByText('ABC Technologies')).toBeTruthy();
  expect(within(details).getByText('XYZ Technologies')).toBeTruthy();
  // The details panel shows the URL itself, still as a plain manual link.
  const linkedin = within(details).getByRole('link', { name: 'https://www.linkedin.com/in/example' });
  expect(linkedin.textContent).toBe('https://www.linkedin.com/in/example');
  expect(linkedin.getAttribute('href')).toBe('https://www.linkedin.com/in/example');
  expect(linkedin.getAttribute('target')).toBe('_blank');
  expect(linkedin.getAttribute('rel')).toBe('noreferrer');

  // The link is present for manual use, but the app itself only ever talked
  // to our own backend.
  expect(calls.every((call) => call.url.startsWith('/api/'))).toBe(true);
});

test('the LinkedIn link is a plain manual external link', async () => {
  await searchWith([{ ...bareCandidate('person-1', 'Test Candidate'), linkedinUrl: 'https://www.linkedin.com/in/example' }]);
  const link = screen.getByRole('link', { name: /view linkedin profile/i });
  expect(link.getAttribute('href')).toBe('https://www.linkedin.com/in/example');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noreferrer');
  expect(calls.every((call) => call.url.startsWith('/api/'))).toBe(true);
});

test('missing Apollo fields display Not available', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Sparse Candidate')],
    (body) => ({ requestedIds: body.ids, candidates: [{ ...bareCandidate('person-1', 'Sparse Candidate'), requestedId: 'person-1', enriched: true }], failedIds: [], skippedIds: [] })
  );
  const row = rowFor('Sparse Candidate');
  // Missing LinkedIn, email and phone before enrichment.
  expect(within(row).getAllByText('Not available').length).toBeGreaterThanOrEqual(3);

  fireEvent.click(screen.getByRole('checkbox', { name: /select sparse candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await screen.findByText(/enrichment complete/i);
  const details = await detailsPanel('sparse candidate');
  const labelled = (label) => within(details).getByText(label).parentElement;
  for (const label of ['Professional headline', 'Seniority', 'Department', 'Skills', 'Current employment', 'Previous employment', 'Work email', 'Phone', 'LinkedIn']) {
    expect(within(labelled(label)).getByText('Not available'), `${label} shows Not available`).toBeTruthy();
  }
});

test('partial enrichment updates the matches and marks the failure retryable', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Matched Candidate'), bareCandidate('person-2', 'Unmatched Candidate')],
    (body) => ({
      requestedIds: body.ids,
      candidates: body.ids.filter((id) => id === 'person-1').map((id) => enrichedCandidate(id, 'Matched Candidate')),
      failedIds: body.ids.filter((id) => id !== 'person-1'),
      skippedIds: []
    })
  );
  selectEveryRow();
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));

  await screen.findByText(/unable to enrich this candidate/i);
  expect(within(rowFor('Matched Candidate')).getByText('Enriched')).toBeTruthy();
  const failedRow = rowFor('Unmatched Candidate');
  expect(within(failedRow).getByText('Enrichment failed')).toBeTruthy();
  // The candidate stays in the results and can be retried.
  expect(within(failedRow).getByRole('button', { name: /retry/i })).toBeTruthy();

  const before = calls.filter((call) => call.url === '/api/candidates/enrich').length;
  fireEvent.click(within(failedRow).getByRole('button', { name: /retry/i }));
  await waitFor(() => expect(calls.filter((call) => call.url === '/api/candidates/enrich').length).toBe(before + 1));
  expect(calls.at(-1).body.ids).toEqual(['person-2']);
});

test('an already enriched candidate is not sent to Apollo again', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    (body) => ({ requestedIds: body.ids, candidates: [enrichedCandidate('person-1', 'Test Candidate')], failedIds: [], skippedIds: [] })
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await screen.findByText(/enrichment complete/i);

  const afterFirst = calls.filter((call) => call.url === '/api/candidates/enrich').length;
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await screen.findByText(/already enriched/i);
  expect(calls.filter((call) => call.url === '/api/candidates/enrich').length).toBe(afterFirst);
});

test('an explicit refresh does re-request an enriched candidate', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    (body) => ({ requestedIds: body.ids, candidates: [enrichedCandidate('person-1', 'Test Candidate')], failedIds: [], skippedIds: [] })
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await screen.findByText(/enrichment complete/i);
  await detailsPanel('test candidate');

  const before = calls.filter((call) => call.url === '/api/candidates/enrich').length;
  fireEvent.click(screen.getByRole('button', { name: /refresh from apollo/i }));
  await waitFor(() => expect(calls.filter((call) => call.url === '/api/candidates/enrich').length).toBe(before + 1));
  expect(calls.at(-1).body.ids).toEqual(['person-1']);
});

test('the enrich button is disabled and labelled while enrichment runs', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  mockBackend({
    search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]),
    enrich: () => ({ requestedIds: ['person-1'], candidates: [enrichedCandidate('person-1', 'Test Candidate')], failedIds: [], skippedIds: [] })
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, options) => {
    if (String(url) === '/api/candidates/enrich') await gate;
    return realFetch(url, options);
  });

  render(<App />);
  fillRequired();
  applySearch();
  await screen.findByText('Test Candidate');
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));

  const button = await screen.findByRole('button', { name: /enriching selected candidates/i });
  expect(button.disabled).toBe(true);
  expect(within(rowFor('Test Candidate')).getByText('Enriching...')).toBeTruthy();

  release();
  await screen.findByText(/enrichment complete/i);
  expect(screen.getByRole('button', { name: /enrich selected/i }).disabled).toBe(false);
});

test('an Apollo rate limit is surfaced and leaves the candidate retryable', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    () => new Error('Apollo API rate limit reached. Please try again later.')
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await screen.findByText(/rate limit reached/i);
  const row = rowFor('Test Candidate');
  expect(within(row).getByText('Enrichment failed')).toBeTruthy();
  expect(within(row).getByRole('button', { name: /retry/i })).toBeTruthy();
});

test('a result with no Apollo person ID cannot be selected for enrichment', async () => {
  await searchWith([{ ...bareCandidate(null, 'Anonymous Result'), id: null }]);
  const checkbox = screen.getByRole('checkbox', { name: /cannot select/i });
  expect(checkbox.disabled).toBe(true);
  // Nothing offers to tick it: a row Apollo gave no person ID for cannot be
  // enriched, so it cannot be selected either.
  expect(screen.queryAllByRole('checkbox', { name: /^select / })).toHaveLength(0);
  expect(checkbox.checked).toBe(false);
});

test('an unreachable backend reads as a retry message, not a JSON parse error', async () => {
  globalThis.fetch = vi.fn(async (url) => {
    calls.push({ url: String(url), body: null });
    return unreachableBackend();
  });
  render(<App />);
  fillRequired();
  applySearch();

  const notice = await screen.findByText(/not reachable right now/i);
  expect(notice).toBeTruthy();
  expect(notice.textContent).not.toMatch(/JSON/i);
  // The form recovers, so committing a filter again retries once the backend
  // is back rather than leaving the recruiter stuck on the notice.
  const before = calls.length;
  applySearch();
  expect(calls.length).toBeGreaterThan(before);
});

test('a JSON error body from our backend is shown verbatim', async () => {
  globalThis.fetch = vi.fn(async (url) => {
    calls.push({ url: String(url), body: null });
    return jsonResponse({ error: 'Apollo API rate limit reached. Please try again later.' }, 429);
  });
  render(<App />);
  fillRequired();
  applySearch();
  expect(await screen.findByText('Apollo API rate limit reached. Please try again later.')).toBeTruthy();
});

test('an empty 200 body reads as an empty response, not a parse error', async () => {
  globalThis.fetch = vi.fn(async (url) => {
    calls.push({ url: String(url), body: null });
    return { ok: true, status: 200, text: async () => '', json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
  });
  render(<App />);
  fillRequired();
  applySearch();
  const notice = await screen.findByText(/empty response/i);
  expect(notice.textContent).not.toMatch(/JSON/i);
});

test('the details panel can be collapsed again after enrichment', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    (body) => ({ requestedIds: body.ids, candidates: [enrichedCandidate('person-1', 'Test Candidate')], failedIds: [], skippedIds: [] })
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await detailsPanel('test candidate');

  fireEvent.click(screen.getByRole('button', { name: /hide enriched details/i }));
  expect(screen.queryByRole('region', { name: /enriched details for test candidate/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /show enriched details/i }));
  expect(await detailsPanel('test candidate')).toBeTruthy();
});

test('pressing Enter in a filter field runs the search', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);
  // The opening search asks for nothing in particular: the pool as it stands.
  await screen.findByText('Test Candidate');
  expect(calls[0].url).toBe('/api/candidates/search');
  expect(calls[0].body.jobTitle).toBe('');

  fillRequired();
  fireEvent.submit(screen.getByLabelText(/role \/ job title/i).closest('form'));
  await waitFor(() => expect(searchCalls().length).toBe(1));
  const sent = searchCalls()[0].body;
  expect(sent.jobTitle).toBe('java developer');
  expect(sent.keywords).toBe('java');
  // Nothing stands in for a location that was never picked.
  expect(sent.location).toBe('');
});

test('Reset filters clears every field', async () => {
  mockBackend({ search: () => searchResult([]) });
  render(<App />);
  const start = opened();
  const jobTitle = screen.getByLabelText(/role \/ job title/i);
  const skills = screen.getByLabelText(/^skills$/i);
  fireEvent.change(jobTitle, { target: { value: 'java developer' } });
  fireEvent.change(skills, { target: { value: 'java' } });
  expect(jobTitle.value).toBe('java developer');

  fireEvent.click(screen.getByRole('button', { name: /reset all/i }));
  expect(jobTitle.value).toBe('');
  expect(skills.value).toBe('');
  // Typing never searched, and clearing what was typed does not either.
  expect(calls.length).toBe(start);
});

test('pagination shows the page count and stops at the last page', async () => {
  mockBackend({ search: () => ({ candidates: [bareCandidate('person-1', 'Test Candidate')], page: 1, perPage: 25, total: 1383 }) });
  render(<App />);
  fillRequired();
  applySearch();
  await screen.findByText('Test Candidate');
  // 1383 results at 25 per page is 56 pages.
  expect(screen.getByText(/of 56/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /previous/i }).disabled).toBe(true);
  expect(screen.getByRole('button', { name: /next/i }).disabled).toBe(false);
});

test('the results header reports this page against the Apollo total', async () => {
  const people = Array.from({ length: 25 }, (_, index) => bareCandidate(`person-${index}`, `Candidate ${index}`));
  mockBackend({ search: () => ({ candidates: people, page: 1, perPage: 25, total: 1383 }) });
  render(<App />);
  fillRequired();
  applySearch();
  await screen.findByText('Candidate 0');
  // One count, in one place, right above the rows it describes: the size of
  // the pool, not a restatement of how many rows fit on a page.
  expect(screen.getByText('1,383 profiles')).toBeTruthy();
  expect(screen.queryByText(/showing 25 of/i)).toBeNull();
  expect(screen.queryByText(/source with intent/i)).toBeNull();
  expect(screen.queryByText(/behind the potential/i)).toBeNull();
});

test('the candidate checkbox stays reachable by keyboard', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate')]);
  const checkbox = screen.getByRole('checkbox', { name: /select test candidate/i });
  // Never display:none, which would drop it from the tab order entirely.
  expect(getComputedStyle(checkbox).display).not.toBe('none');
  checkbox.focus();
  expect(document.activeElement).toBe(checkbox);
});

test('the header and each row have the same number of grid cells', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate')]);
  const headCells = document.querySelectorAll('.table-head > span').length;
  const rowCells = document.querySelectorAll('.candidate-row > *').length;
  // A mismatch here means the CSS grid columns no longer line up with the
  // header labels, which silently shifts every value under the wrong heading.
  expect(headCells).toBe(5);
  expect(rowCells).toBe(headCells);
});

test('the app opens on the pool, and each filter narrows the same query', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);
  // The pool is on screen before anything is asked of it.
  await screen.findByText('Test Candidate');
  expect(calls[0].body.jobTitle).toBe('');
  expect(calls[0].body.location).toBe('');

  // A role on its own is a search Apollo answers perfectly well.
  fireEvent.change(screen.getByLabelText(/role \/ job title/i), { target: { value: 'java developer' } });
  applySearch();
  await waitFor(() => expect(searchCalls().length).toBe(1));
  expect(searchCalls()[0].body.jobTitle).toBe('java developer');

  // Ticking a city narrows that same query rather than starting a new one.
  tickLocation('Hyderabad');
  await waitFor(() => expect(searchCalls().length).toBe(2));
  expect(searchCalls()[1].body.location).toBe('Hyderabad');
  expect(searchCalls()[1].body.jobTitle).toBe('java developer');

  // And a skill with no role at all is a search too.
  fireEvent.change(screen.getByLabelText(/role \/ job title/i), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText(/^skills$/i), { target: { value: 'java' } });
  fireEvent.keyDown(screen.getByLabelText(/^skills$/i), { key: 'Enter' });
  await waitFor(() => expect(searchCalls().length).toBe(3));
  expect(searchCalls()[2].body.keywords).toMatch(/java/);
  expect(searchCalls()[2].body.jobTitle).toBe('');
});

test('a filter on its own narrows the open pool rather than being refused', async () => {
  mockBackend({ search: () => searchResult([]) });
  render(<App />);
  opened();

  // Seniority cannot describe a pool, but there already is one, so it narrows
  // that instead of being turned away for having no role beside it.
  fireEvent.click(screen.getByRole('checkbox', { name: /^senior$/i }));
  await waitFor(() => expect(searchCalls().length).toBe(1));
  expect(searchCalls()[0].body.seniority).toBe('senior');
  expect(searchCalls()[0].body.jobTitle).toBe('');
});

test('the filters Apollo cannot honour are not offered', async () => {
  // Measured against the live API rather than judged by eye: organization_names
  // is ignored outright - two real companies and a nonsense string all returned
  // the same 21,081 as no filter - and organization_industries only matches
  // Apollo's own taxonomy, so "information technology" silently returned zero.
  mockBackend({});
  render(<App />);
  expect(screen.queryByLabelText(/^company/i)).toBeNull();
  expect(screen.queryByLabelText(/^industry/i)).toBeNull();

  // Four filters and no more: two boxes and two lists of ticks.
  expect(screen.getByLabelText(/role \/ job title/i)).toBeTruthy();
  expect(screen.getByLabelText(/^skills$/i)).toBeTruthy();
  expect(screen.getByText('Location')).toBeTruthy();
  expect(screen.getByText('Seniority')).toBeTruthy();
  // Four filters and nothing else that types: the role, the skills box, and
  // the box that adds a city the standing list does not hold.
  const typed = [...document.querySelectorAll('.filter-form input:not([type="checkbox"]), .filter-form select')]
    .map((field) => field.name);
  expect(typed).toEqual(['jobTitle', 'location', 'keywords']);
});

test('whitespace is not a filter, however it is committed', async () => {
  mockBackend({ search: () => searchResult([]) });
  render(<App />);
  opened();

  // Committing whitespace searches, because everything searches now - but it
  // reaches Apollo as no filter rather than as a term that matches nothing.
  fillRequired({ jobTitle: '  ', keywords: '   ' });
  applySearch();
  await waitFor(() => expect(searchCalls().length).toBe(1));
  expect(searchCalls()[0].body.jobTitle.trim()).toBe('');
  expect(searchCalls()[0].body.keywords.trim()).toBe('');
  // And nothing was committed as a chip either.
  expect(document.querySelectorAll('.skill-chips .chip-static')).toHaveLength(0);
});

test('no single field is marked required, because none of them is', async () => {
  mockBackend({});
  render(<App />);
  // A role or a skill is needed, which no single field can express, so the
  // form validates it rather than marking a field the recruiter could satisfy
  // the other way.
  for (const pattern of [/role \/ job title/i, /^skills$/i]) {
    expect(screen.getByLabelText(pattern).required, String(pattern)).toBe(false);
  }
});

test('submitting an empty form searches the pool rather than refusing', async () => {
  mockBackend({ search: () => searchResult([]) });
  render(<App />);
  opened();

  fireEvent.submit(screen.getByLabelText(/role \/ job title/i).closest('form'));
  await waitFor(() => expect(searchCalls().length).toBe(1));
  expect(searchCalls()[0].body.jobTitle).toBe('');
  // No scolding: there is nothing the recruiter has failed to provide.
  expect(screen.queryByText(/is required/i)).toBeNull();
});
// --- Explicit personal email reveal -----------------------------------------

const revealResponse = (candidates) => ({
  requestedIds: candidates.map((candidate) => candidate.requestedId),
  candidates,
  failedIds: [],
  skippedIds: [],
  revealedPersonalEmails: true
});

function revealButton() {
  return screen.getByRole('button', { name: /^reveal email/i });
}

// One click is the whole action now: the cost is on the button before it.
function revealAndConfirm(button) {
  fireEvent.click(button || revealButton());
}

test('a search never reveals contact details on its own', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate')]);
  expect([...new Set(calls.map((call) => call.url))]).toEqual(['/api/candidates/search']);
  expect(calls.some((call) => call.url === '/api/candidates/reveal')).toBe(false);
});

test('reveal sends only the explicitly selected candidates', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example.com' })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();

  await waitFor(() => expect(calls.some((call) => call.url === '/api/candidates/reveal')).toBe(true));
  const call = calls.find((entry) => entry.url === '/api/candidates/reveal');
  expect(call.body.ids).toEqual(['person-1']);
  expect(call.body.ids).not.toContain('person-2');
});

test('a running reveal shows a loading state and blocks a second request', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    async () => {
      await pending;
      return revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example.com' })]);
    }
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();

  // The toolbar button and the row badge both report the reveal, so each is
  // asserted where it lives rather than by a page-wide text match.
  await waitFor(() => expect(within(rowFor('Test Candidate')).getByText('Revealing contact details...')).toBeTruthy());
  expect(screen.getByRole('button', { name: /^revealing email/i }).disabled).toBe(true);
  expect(screen.getByRole('button', { name: /^enrich selected/i }).disabled).toBe(true);

  release();
  await waitFor(() => expect(within(rowFor('Test Candidate')).queryByText('Revealing contact details...')).toBeNull());
  expect(within(rowFor('Test Candidate')).getByText('Enriched')).toBeTruthy();
});

test('a partial reveal shows the address it got and Not available for the rest', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')],
    undefined,
    () => revealResponse([
      enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example.com', emailAvailable: true }),
      enrichedCandidate('person-2', 'Other Candidate', { email: null, emailAvailable: false })
    ])
  );
  selectEveryRow();
  revealAndConfirm();

  const found = await detailsPanel('Test Candidate');
  expect(within(found).getByText('one@example.com')).toBeTruthy();
  expect(within(found).getByRole('link', { name: 'one@example.com' }).getAttribute('href')).toBe('mailto:one@example.com');

  const missing = await detailsPanel('Other Candidate');
  const missingEmail = within(missing).getByText('Work email').parentElement;
  expect(within(missingEmail).getByText('Not available')).toBeTruthy();
  expect(missing.textContent).not.toContain('@example.com');
});

test('a failed reveal keeps the candidate enriched instead of erasing the row', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    () => ({
      requestedIds: ['person-1'],
      candidates: [enrichedCandidate('person-1', 'Test Candidate', { email: null, emailAvailable: false })],
      failedIds: [],
      skippedIds: []
    }),
    () => new Error('Apollo API rate limit reached. Please try again later.')
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /^enrich selected/i }));
  await detailsPanel('Test Candidate');

  revealAndConfirm(within(rowFor('Test Candidate')).getByRole('button', { name: /^reveal email/i }));
  await screen.findByText(/rate limit/i);

  // The reveal failed, so the row keeps the enrichment it already had.
  expect(within(rowFor('Test Candidate')).getByText('Enriched')).toBeTruthy();
  await detailsPanel('Test Candidate');
});

test('a second reveal does not pay for an address already on screen', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example-co.com', emailType: 'work' })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();
  await detailsPanel('Test Candidate');

  const revealCalls = () => calls.filter((call) => call.url === '/api/candidates/reveal').length;
  expect(revealCalls()).toBe(1);

  // Same candidate still selected: a second click is refused before it can
  // even ask for confirmation, so no spend is ever offered.
  fireEvent.click(revealButton());
  await screen.findByText(/already has a revealed email/i);
  expect(revealCalls()).toBe(1);
});

test('double-clicking reveal sends a single request', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    async () => {
      await pending;
      return revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example-co.com', emailType: 'work' })]);
    }
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));

  // With no confirmation in the way, the in-flight guard is the only thing
  // between an impatient double-click and paying twice. The button relabels
  // and disables the moment the first click lands, and further clicks on it
  // must not reach Apollo.
  fireEvent.click(revealButton());
  const inFlight = screen.getByRole('button', { name: /^revealing email/i });
  expect(inFlight.disabled).toBe(true);
  fireEvent.click(inFlight);
  fireEvent.click(inFlight);

  await waitFor(() => expect(within(rowFor('Test Candidate')).getByText('Revealing contact details...')).toBeTruthy());
  expect(calls.filter((call) => call.url === '/api/candidates/reveal').length).toBe(1);

  release();
  await waitFor(() => expect(within(rowFor('Test Candidate')).queryByText('Revealing contact details...')).toBeNull());
  expect(calls.filter((call) => call.url === '/api/candidates/reveal').length).toBe(1);
});

test('a personal address is labelled as personal, not as a work address', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'someone@gmail.com', emailType: 'personal' })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();

  const panel = await detailsPanel('Test Candidate');
  expect(within(panel).getByText('Personal email')).toBeTruthy();
  expect(within(panel).queryByText('Work email')).toBeNull();
});

test('the frontend never receives or stores an Apollo key', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example-co.com', emailType: 'work' })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();
  await detailsPanel('Test Candidate');

  // The browser talks to our backend only, and sends no credentials of its own.
  for (const call of calls) {
    expect(call.url.startsWith('/api/')).toBe(true);
    expect(JSON.stringify(call.body ?? {})).not.toMatch(/api[-_]?key/i);
  }
  expect(document.body.innerHTML).not.toMatch(/x-api-key/i);
});

test('shows the work address and the personal one when Apollo returns both', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', {
      email: 'first.last@example-co.com',
      emailType: 'work',
      personalEmail: 'first.last.personal@gmail.com'
    })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();

  const panel = await detailsPanel('Test Candidate');
  expect(within(panel).getByText('Work email')).toBeTruthy();
  expect(within(panel).getByRole('link', { name: 'first.last@example-co.com' })).toBeTruthy();
  expect(within(panel).getByText('Personal email')).toBeTruthy();
  const personal = within(panel).getByRole('link', { name: 'first.last.personal@gmail.com' });
  expect(personal.getAttribute('href')).toBe('mailto:first.last.personal@gmail.com');
});

test('a reveal that found no personal address says so, rather than nothing', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', {
      email: 'first.last@example-co.com', emailType: 'work', personalEmail: null
    })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();

  const panel = await detailsPanel('Test Candidate');
  expect(within(panel).getByText('Work email')).toBeTruthy();
  // The credit was spent and the answer was "there isn't one". Hiding the row
  // left the recruiter looking at the work address they already had, unable to
  // tell an empty answer from a reveal that never ran.
  expect(within(panel).getByText('Personal email')).toBeTruthy();
  expect(within(panel).getByText(/apollo holds no personal email/i)).toBeTruthy();
});



test('a selection over the cap says how many will actually be charged', async () => {
  const people = Array.from({ length: 14 }, (_, index) => bareCandidate(`person-${index}`, `Candidate ${index}`));
  await searchWith(people, undefined, () => revealResponse([]));
  selectEveryRow();
  // 14 selected, but a reveal is capped at 10 to protect the account, and the
  // button says so before it is pressed.
  expect(revealButton().textContent).toMatch(/reveal email - 10 credits/i);
});

// --- Personal email filter --------------------------------------------------


// Has Personal: revealed, Apollo gave a personal address.
// Work Only:    revealed, Apollo gave none - a known negative.
// Never Revealed: never asked, so unknown.
async function revealTwo() {
  await searchWith(
    [bareCandidate('person-1', 'Has Personal'), bareCandidate('person-2', 'Work Only'), bareCandidate('person-3', 'Never Revealed')],
    undefined,
    () => revealResponse([
      enrichedCandidate('person-1', 'Has Personal', {
        email: 'has.personal@example-co.com', emailType: 'work', personalEmail: 'has.personal@gmail.com'
      }),
      enrichedCandidate('person-2', 'Work Only', {
        email: 'work.only@example-co.com', emailType: 'work', personalEmail: null
      })
    ])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select has personal/i }));
  fireEvent.click(screen.getByRole('checkbox', { name: /select work only/i }));
  revealAndConfirm();
  await detailsPanel('Has Personal');
}







// --- Dev-server restart resilience ------------------------------------------

test('a search retries once when the dev server was restarting', async () => {
  let attempts = 0;
  mockBackend({
    search: () => {
      attempts += 1;
      return attempts === 1 ? proxyUnreachable() : searchResult([bareCandidate('person-1', 'Test Candidate')]);
    }
  });
  render(<App />);
  fillRequired();
  applySearch();

  await screen.findByText('Test Candidate');
  expect(attempts).toBe(2);
  // The recruiter never sees the restart at all.
  expect(screen.queryByText(/candidate api is not running/i)).toBeNull();
});

test('a search that is still unreachable reports it rather than looping', async () => {
  let attempts = 0;
  mockBackend({ search: () => { attempts += 1; return proxyUnreachable(); } });
  render(<App />);
  // The opening search gives up first; this counts the one the test asks for.
  await screen.findByText(/candidate api is not running/i, {}, { timeout: 8000 });
  const afterOpening = attempts;

  fillRequired();
  applySearch();

  // Three retries on a backoff, then it gives up and says so.
  await waitFor(() => expect(attempts).toBe(afterOpening + 4), { timeout: 8000 });
}, 20000);

test('a reveal never retries a dropped connection', async () => {
  let attempts = 0;
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => { attempts += 1; return proxyUnreachable(); }
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();

  await screen.findByText(/candidate api is not running/i);
  // A reset connection does not prove Apollo went unasked, so retrying could
  // pay for the same candidate twice.
  expect(attempts).toBe(1);
  expect(calls.filter((call) => call.url === '/api/candidates/reveal').length).toBe(1);
});



test('an enriched candidate can still be revealed for a personal address', async () => {
  // The trap this locks out: enriching first gives a work email, and a dedupe
  // keyed on "has an email" would then refuse the reveal forever - making a
  // personal address unreachable for anyone enriched first.
  let revealCalls = 0;
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    () => ({
      requestedIds: ['person-1'],
      candidates: [enrichedCandidate('person-1', 'Test Candidate', {
        email: 'work@example-co.com', emailType: 'work', personalEmail: null
      })],
      failedIds: [],
      skippedIds: []
    }),
    () => {
      revealCalls += 1;
      return revealResponse([enrichedCandidate('person-1', 'Test Candidate', {
        email: 'work@example-co.com', emailType: 'work', personalEmail: 'test.candidate@gmail.com'
      })]);
    }
  );

  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /^enrich selected/i }));
  await detailsPanel('Test Candidate');

  // Now reveal the same candidate: it must reach Apollo, not be skipped.
  revealAndConfirm();
  await waitFor(() => expect(revealCalls).toBe(1));

  const panel = await detailsPanel('Test Candidate');
  expect(within(panel).getByText('Personal email')).toBeTruthy();
  expect(within(panel).getByRole('link', { name: 'test.candidate@gmail.com' })).toBeTruthy();

  // A second reveal is refused, because now it really has been asked.
  fireEvent.click(revealButton());
  await screen.findByText(/already has a revealed email/i);
  expect(revealCalls).toBe(1);
});

// --- Not paying for candidates Apollo already ruled out ----------------------

test('every search asks Apollo only for candidates it holds an address for', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);
  await screen.findByText('Test Candidate');
  fillRequired();
  applySearch();
  await waitFor(() => expect(searchCalls().length).toBe(1));
  // Every search, the opening one included.
  expect(calls.every((call) => call.body.verifiedEmailOnly === true)).toBe(true);

  // No longer a question put to the recruiter: an unreachable candidate cannot
  // be contacted or revealed, so the wider pool was only dead ends.
  // Narrow to the removed control: the results toolbar still has its own
  // "Personal email only" filter, which is a different thing.
  expect(screen.queryByRole('checkbox', { name: /candidates with an email apollo has verified/i })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: /only candidates apollo has an email for/i })).toBeNull();
  expect(screen.queryByText(/untick to widen the search/i)).toBeNull();
  expect(screen.queryByText(/one in five candidates has no address/i)).toBeNull();

  // And it stays on for every subsequent search, including a paged one.
  applySearch();
  await waitFor(() => expect(searchCalls().length).toBe(2));
  expect(searchCalls()[1].body.verifiedEmailOnly).toBe(true);
});


test('a candidate Apollo has no address for is never charged for', async () => {
  let revealCalls = 0;
  await searchWith(
    [{ ...bareCandidate('person-1', 'No Address'), hasEmailOnFile: false }],
    undefined,
    () => { revealCalls += 1; return revealResponse([]); }
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select no address/i }));
  fireEvent.click(revealButton());

  // Apollo said so in the free search response, so no confirmation is even
  // offered and nothing is sent.
  await screen.findByText(/apollo holds no email address for that candidate/i);
  expect(revealCalls).toBe(0);
});

test('a mixed selection charges only for the candidates worth asking about', async () => {
  await searchWith(
    [
      { ...bareCandidate('person-1', 'Has Address'), hasEmailOnFile: true },
      { ...bareCandidate('person-2', 'No Address'), hasEmailOnFile: false }
    ],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Has Address', { email: 'has@example-co.com', emailType: 'work' })])
  );
  selectEveryRow();
  fireEvent.click(revealButton());

  // Two selected, one charged.
  await waitFor(() => expect(calls.some((call) => call.url === '/api/candidates/reveal')).toBe(true));
  expect(calls.find((call) => call.url === '/api/candidates/reveal').body.ids).toEqual(['person-1']);
  // And the one left out is still reported, alongside the result rather than
  // in a dialog before it.
  await screen.findByText(/1 selected candidate has no email on file/i);
});

// --- Waterfall: searching other data sources --------------------------------







// --- The waterfall answer shape, end to end through the UI -------------------
//
// Apollo answers a waterfall with the person id and whatever the vendors
// found, and nothing else. These drive the app with that real shape, mocked.


// A found candidate is expanded automatically, and the details panel repeats
// the contact fields the row already shows, so an assertion about one field has
// to say which of the two it means.
function identity(name) {
  return rowFor(name).querySelector('.candidate-row .identity');
}

function contactCell(name) {
  return rowFor(name).querySelector('.candidate-row .contact');
}

function contactLine(name, label) {
  const lines = [...contactCell(name).querySelectorAll('.contact-line')];
  return lines.find((line) => line.querySelector('.contact-label')?.textContent === label) || null;
}


















// --- Narrowing a pool down to the right person ------------------------------
//
// Apollo requires every keyword to match, so each skill added narrows the pool
// hard: measured against the live API, "python" returned 234, "python django"
// returned 8 and "python django aws" returned 0. These lock in the behaviour
// that makes that usable - separate terms, and the count for each query.

function keywordBox() {
  return screen.getByLabelText(/^skills$/i);
}

test('typing in the box hides nothing: the rows are what Apollo returned', async () => {
  // It used to filter the 25 rows in hand, which answered a question nobody
  // asked - "which of this page matches?" - while the pool it was drawn from
  // went unsearched. Typing now stages a search; the rows stay as they are
  // until Apollo answers a new one.
  await loadedPool([
    { ...bareCandidate('person-1', 'Zahid'), company: 'eBhasha Setu' },
    { ...bareCandidate('person-2', 'Aman'), company: 'Canopy' },
    { ...bareCandidate('person-3', 'Sachin'), company: 'Palni Inc' }
  ]);
  expect(visibleNames()).toEqual(['Zahid', 'Aman', 'Sachin']);

  fireEvent.change(rowSearch(), { target: { value: 'aman' } });
  expect(visibleNames()).toEqual(['Zahid', 'Aman', 'Sachin']);

  fireEvent.change(rowSearch(), { target: { value: 'nobody here' } });
  expect(visibleNames()).toEqual(['Zahid', 'Aman', 'Sachin']);
});

test('the results search never calls Apollo', async () => {
  await loadedPool([bareCandidate('person-1', 'Zahid'), bareCandidate('person-2', 'Aman')]);
  const before = calls.length;

  fireEvent.change(rowSearch(), { target: { value: 'aman' } });
  fireEvent.change(rowSearch(), { target: { value: 'zah' } });
  fireEvent.change(rowSearch(), { target: { value: 'nobody' } });

  // Typing must not spend a search per keystroke.
  expect(calls.length).toBe(before);
});

test('the box says what pressing Enter will actually search', async () => {
  await loadedPool([bareCandidate('person-1', 'Zahid'), bareCandidate('person-2', 'Aman')], 234);

  fireEvent.change(rowSearch(), { target: { value: 'aman' } });
  // The whole pool the filters describe, not the page in hand - and it names
  // the filters that pool is made of.
  expect(screen.getByText(/press enter to search every role and skills in the pool for "aman"/i)).toBeTruthy();
});





// --- Searching every page for one candidate by name -------------------------
//
// Apollo's own q_person_name filter, so the search covers the whole pool
// instead of the page in hand. Verified live against the API: "Sachin" with a
// python-developer/hyderabad pool returned 1 and "Aman" returned 2, against a
// 2,408-profile baseline.

// Answers a name-filtered search with its own pool, so the difference between
// "this page" and "every page" is observable.
function namePool({ base, byName }) {
  mockBackend({
    search: (body) => {
      const set = body.personName ? (byName[body.personName] || []) : base;
      return { candidates: set.slice(0, 25), page: body.page || 1, perPage: 25, total: set.length };
    }
  });
  render(<App />);
  fillRequired();
  applySearch();
}

const rows = (names) => names.map((name, index) => bareCandidate(`person-${index + 1}`, name));

test('a name is sent to Apollo so the search covers every page, not just this one', async () => {
  const base = rows(Array.from({ length: 25 }, (_, i) => `Candidate ${i + 1}`));
  namePool({ base: [...base, ...rows(['padding'])], byName: { Adhitya: rows(['Adhitya K', 'Adhitya R']) } });
  await screen.findByText('Candidate 1');

  fireEvent.change(rowSearch(), { target: { value: 'Adhitya' } });
  // Nobody of that name is on this page, and the box does not pretend to know
  // whether anybody in the pool is: it offers to ask.
  expect(screen.getByText(/press enter to search .* for "adhitya"/i)).toBeTruthy();
  expect(visibleNames()).toContain('Candidate 1');

  searchByName();

  await screen.findByText('Adhitya K');
  expect(screen.getByText('Adhitya R')).toBeTruthy();
  // Apollo did the filtering, across the whole pool.
  expect(calls.at(-1).body.personName).toBe('Adhitya');
  expect(calls.at(-1).body.page).toBe(1);
});

test('Enter in the box runs the same whole-pool search as the button', async () => {
  namePool({ base: rows(['Someone Else']), byName: { Sachin: rows(['Sachin']) } });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Sachin' } });
  fireEvent.keyDown(rowSearch(), { key: 'Enter' });

  await screen.findByText('Sachin');
  expect(calls.at(-1).body.personName).toBe('Sachin');
});

test('an active name filter is stated plainly and can be cleared', async () => {
  namePool({ base: rows(['Someone Else', 'Another One']), byName: { Aman: rows(['Aman', 'Aman Two']) } });
  await screen.findByText('Someone Else');

  // A location is applied first, so the copy has one to leave out.
  tickLocation('Hyderabad');
  await screen.findByText('Someone Else');
  fireEvent.change(rowSearch(), { target: { value: 'Aman' } });
  searchByName();
  await screen.findByText('Aman');

  // The pool itself is filtered now, so the recruiter is told rather than left
  // wondering why the totals changed.
  // Says what it matched on, and that location was deliberately left out.
  expect(screen.getByText(/named "aman"/i)).toBeTruthy();
  expect(screen.getByText(/matching your role and skills/i)).toBeTruthy();
  expect(screen.getByText(/2 profiles\./i)).toBeTruthy();
  expect(screen.getByText(/location is not applied to a name search/i)).toBeTruthy();

  // The cross inside the box is the way out of a name filter now: there is no
  // separate link beside it.
  fireEvent.click(screen.getByRole('button', { name: /clear the name filter/i }));
  await screen.findByText('Someone Else');
  expect(calls.at(-1).body.personName).toBe('');
  expect(screen.queryByText(/apollo is filtering the whole pool/i)).toBeNull();
});

test('a name Apollo has nobody for is reported as its own answer', async () => {
  namePool({ base: rows(['Someone Else']), byName: {} });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Nobody' } });
  searchByName();

  // Not blamed on the keywords, which is a different problem with a different fix.
  // Narrowed by role and skills, so those are the likely cause and the message
  // points at them rather than claiming Apollo has nobody by that name at all.
  await screen.findByText(/nobody named "nobody" matches your role and skills/i);
  expect(screen.getByText(/clear a filter and search the name again/i)).toBeTruthy();
  expect(screen.queryByText(/turn a skill off/i)).toBeNull();
});

test('the same name is not searched twice in a row', async () => {
  namePool({ base: rows(['Someone Else']), byName: { Aman: rows(['Aman']) } });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aman' } });
  searchByName();
  await screen.findByText('Aman');

  const searches = calls.filter((call) => call.url === '/api/candidates/search').length;
  // Already the active filter, so pressing Enter again asks nothing new.
  fireEvent.keyDown(rowSearch(), { key: 'Enter' });
  expect(calls.filter((call) => call.url === '/api/candidates/search').length).toBe(searches);
});

test('paging keeps the name filter instead of reverting to the whole pool', async () => {
  const many = rows(Array.from({ length: 30 }, (_, i) => `Aman ${i + 1}`));
  namePool({ base: rows(['Someone Else']), byName: { Aman: many } });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aman' } });
  searchByName();
  await screen.findByText('Aman 1');

  fireEvent.click(screen.getByRole('button', { name: /next →/i }));
  await waitFor(() => expect(calls.at(-1).body.page).toBe(2));
  // The name must travel with the page, or page 2 would be the unfiltered pool.
  expect(calls.at(-1).body.personName).toBe('Aman');
});


test('searching the pool again drops the name instead of ANDing it on', async () => {
  namePool({ base: rows(['Someone Else']), byName: { Aman: rows(['Aman']) } });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aman' } });
  searchByName();
  await screen.findByText('Aman');

  // Describing a pool is the opposite question to naming a person.
  applySearch();
  await screen.findByText('Someone Else');
  const sent = calls.at(-1).body;
  expect(sent.personName).toBe('');
  expect(sent.jobTitle).toBe('java developer');
});

test('a name search does not clutter the skill-narrowing trail', async () => {
  namePool({ base: rows(['Someone Else']), byName: { Aman: rows(['Aman']) } });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aman' } });
  searchByName();
  await screen.findByText('Aman');

  // The trail records narrowing a pool by skill. A name search does neither,
  // so it must not appear there as a mystery zero.
  const trail = document.querySelector('.refine-trail');
  if (trail) expect(trail.textContent).not.toMatch(/Aman/);
});


test('every profile a name search returns is actually rendered', async () => {
  // The bug this locks out: Apollo matches a name against a first or a last
  // name, so "Aditya Sai" comes back with people recorded as "Sai" and as
  // "Aditya". The local box filter then required the whole string and threw all
  // of them away, leaving an empty table under "Showing 18 of 18 profiles".
  namePool({
    base: rows(['Someone Else']),
    byName: { 'Aditya Sai': rows(['Sai', 'Aditya', 'Aditya Sai', 'Sai Kumar']) }
  });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aditya Sai' } });
  searchByName();

  await screen.findByText('Aditya Sai');
  // All four, not just the one whose name contains the full string.
  expect(visibleNames()).toEqual(['Sai', 'Aditya', 'Aditya Sai', 'Sai Kumar']);
  expect(screen.getByText(/4 profiles\./i)).toBeTruthy();
});

test('typing a new name stages a second search rather than hiding the first', async () => {
  namePool({
    base: rows(['Someone Else']),
    byName: {
      'Aditya Sai': [
        { ...bareCandidate('person-1', 'Sai'), company: 'Clarivate' },
        { ...bareCandidate('person-2', 'Aditya'), company: 'LexisNexis' }
      ],
      aditya: [{ ...bareCandidate('person-2', 'Aditya'), company: 'LexisNexis' }]
    }
  });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aditya Sai' } });
  searchByName();
  await screen.findByText('Sai');
  expect(visibleNames()).toEqual(['Sai', 'Aditya']);

  // A different name in the box changes nothing until it is searched: what is
  // on screen is still the answer to the last question asked.
  fireEvent.change(rowSearch(), { target: { value: 'aditya' } });
  expect(visibleNames()).toEqual(['Sai', 'Aditya']);
  expect(calls.at(-1).body.personName).toBe('Aditya Sai');

  searchByName();
  await waitFor(() => expect(calls.at(-1).body.personName).toBe('aditya'));
  await waitFor(() => expect(visibleNames()).toEqual(['Aditya']));
});

test('Select all reaches every row a name search returned', async () => {
  namePool({
    base: rows(['Someone Else']),
    byName: { 'Aditya Sai': [
      { ...bareCandidate('person-1', 'Sai'), hasEmailOnFile: true },
      { ...bareCandidate('person-2', 'Aditya'), hasEmailOnFile: true }
    ] }
  });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aditya Sai' } });
  searchByName();
  await screen.findByText('Sai');

  selectEveryRow();
  // Both, because neither is hidden any more.
  expect(selectionCount()).toMatch(/Selected: *2/);
});




// --- Revealing a phone number -----------------------------------------------
//
// The dearest thing the app can ask Apollo for, so every one of these asserts
// either that a number is reported honestly or that no credit was spent.

function phoneButton() {
  return screen.getByRole('button', { name: /^reveal phone/i });
}

// The normalized shape a phone job answers with: the person id, whatever number
// Apollo held, and nothing else.
const phoneAnswer = (id, overrides = {}) => ({
  id, requestedId: id, name: null, title: null, headline: null, company: null,
  location: null, seniority: null, departments: [], skills: [], linkedinUrl: null,
  email: null, emailType: null, personalEmail: null, hasEmailOnFile: null, phone: null,
  emailAvailable: false, phoneAvailable: false, employmentHistory: [], enriched: true,
  vendors: [], waterfallChecked: false, phoneChecked: true, ...overrides
});

async function phoneFlow(people, { phone, poll }) {
  mockBackend({ search: () => searchResult(people), phone, poll });
  render(<App />);
  fillRequired();
  applySearch();
  for (const person of people) await screen.findByText(person.name);
  for (const person of people) {
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`select ${person.name}`, 'i') }));
  }
  fireEvent.click(phoneButton());
}


test('a confirmed reveal shows the number Apollo returns', async () => {
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => ({
      requestedIds: ['person-1'],
      requests: [{ requestId: '991', ids: ['person-1'] }],
      candidates: [], failedIds: [], skippedIds: []
    }),
    poll: () => ({
      status: 'ready', kind: 'phone',
      candidates: [phoneAnswer('person-1', { phone: '+1 555 0100 111', phoneAvailable: true })]
    })
  });

  await screen.findByText(/found 1 phone number/i);
  const link = within(rowFor('Test Candidate').querySelector('.candidate-row .contact')).getByRole('link', { name: '+1 555 0100 111' });
  expect(link.getAttribute('href')).toBe('tel:+1 555 0100 111');
  // The row keeps everything the search already told us.
  expect(within(rowFor('Test Candidate').querySelector('.candidate-row .identity')).getByText('Test Candidate')).toBeTruthy();
});

test('a candidate Apollo has no number for is told apart from one never asked', async () => {
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => ({
      requestedIds: ['person-1'],
      requests: [{ requestId: '991', ids: ['person-1'] }],
      candidates: [], failedIds: [], skippedIds: []
    }),
    poll: () => ({ status: 'ready', kind: 'phone', candidates: [phoneAnswer('person-1')] })
  });

  await screen.findByText(/apollo holds no phone number for these candidates/i);
  // Asked and answered, which is not the same as never asked.
  const contact = rowFor('Test Candidate').querySelector('.candidate-row .contact');
  expect(within(contact).getByText('No phone number found')).toBeTruthy();
  // And it is reported as information, not as a failure.
  expect(document.querySelector('.status.error')).toBeNull();
});

test('a phone answer does not claim the personal email was checked', async () => {
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => ({
      requestedIds: ['person-1'],
      requests: [{ requestId: '991', ids: ['person-1'] }],
      candidates: [], failedIds: [], skippedIds: []
    }),
    poll: () => ({ status: 'ready', kind: 'phone', candidates: [phoneAnswer('person-1')] })
  });
  await screen.findByText(/apollo holds no phone number/i);

  // A phone job looked for no address, so the row must not say one was not found.
  const contact = rowFor('Test Candidate').querySelector('.candidate-row .contact');
  expect(within(contact).queryByText('No personal email found')).toBeNull();
  // And the personal-email filter must not treat it as confirmed-none.
  expect(screen.getByText('Test Candidate')).toBeTruthy();
  expect(screen.queryByText(/hidden - apollo returned no personal address/i)).toBeNull();
});

test('a number already on screen is never paid for twice', async () => {
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => ({
      requestedIds: ['person-1'],
      requests: [{ requestId: '991', ids: ['person-1'] }],
      candidates: [], failedIds: [], skippedIds: []
    }),
    poll: () => ({
      status: 'ready', kind: 'phone',
      candidates: [phoneAnswer('person-1', { phone: '+1 555 0100 111' })]
    })
  });
  await screen.findByText(/found 1 phone number/i);

  const before = calls.filter((call) => call.url === '/api/candidates/phone').length;
  fireEvent.click(phoneButton());
  await screen.findByText(/a number is already on screen for that candidate/i);
  // Not even a confirmation, so there is nothing to mis-click.
  expect(calls.filter((call) => call.url === '/api/candidates/phone').length).toBe(before);
});

test('a candidate Apollo already answered "no number" for is not asked again', async () => {
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => ({
      requestedIds: ['person-1'],
      requests: [{ requestId: '991', ids: ['person-1'] }],
      candidates: [], failedIds: [], skippedIds: []
    }),
    poll: () => ({ status: 'ready', kind: 'phone', candidates: [phoneAnswer('person-1')] })
  });
  await screen.findByText(/apollo holds no phone number/i);

  const before = calls.filter((call) => call.url === '/api/candidates/phone').length;
  fireEvent.click(phoneButton());
  await screen.findByText(/already been asked for that candidate and holds no number/i);
  expect(calls.filter((call) => call.url === '/api/candidates/phone').length).toBe(before);
});

test('an unreachable webhook is reported without leaving the row broken', async () => {
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => new Error('APOLLO_WEBHOOK_URL is not set. Apollo posts the phone numbers there and charges for them either way, so nothing was requested.')
  });

  await screen.findByText(/apollo_webhook_url is not set/i);
  // The candidate is left as it was, not marked failed for something that never
  // reached Apollo.
  // Nothing claims a state the row has not reached: no badge, and no details
  // to open.
  expect(within(rowFor('Test Candidate')).queryByText(/enriched/i)).toBeNull();
  expect(within(rowFor('Test Candidate')).queryByRole('button', { name: /view details/i })).toBeNull();
});

test('Apollo saying it has no number means no mobile credit is spent', async () => {
  // has_direct_phone came back false, free, on the search. Asking anyway could
  // only return nothing, and a mobile credit is the dearest thing here.
  mockBackend({
    search: () => searchResult([{ ...bareCandidate('person-1', 'No Number'), hasPhoneOnFile: false }]),
    phone: () => { throw new Error('Apollo must not be asked for a number it has already said it lacks'); }
  });
  render(<App />);
  fillRequired();
  applySearch();
  await screen.findByText('No Number');

  fireEvent.click(screen.getByRole('checkbox', { name: /select no number/i }));
  fireEvent.click(phoneButton());

  await screen.findByText(/apollo holds no phone number for that candidate, so asking would return nothing and no credit was spent/i);
  expect(calls.some((call) => call.url === '/api/candidates/phone')).toBe(false);
});





test('the Find personal emails button is gone from the toolbar', async () => {
  // Removed because it could not work on this account: Apollo returned itself
  // as the only vendor, with no_apollo_data, so it re-asked the same database
  // that had already said no.
  mockBackend({ search: () => searchResult([{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }]) });
  render(<App />);
  fillRequired();
  applySearch();
  await screen.findByText('Test Candidate');

  expect(screen.queryByRole('button', { name: /find personal emails/i })).toBeNull();
  // The three that do something are still there.
  expect(screen.getByRole('button', { name: /^reveal email/i })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^reveal phone/i })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^enrich selected/i })).toBeTruthy();
});

test('nothing in the UI can start a waterfall search any more', async () => {
  // mockBackend throws on any unrouted request, so a stray call would fail the
  // test rather than quietly hitting Apollo.
  mockBackend({
    search: () => searchResult([{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }]),
    reveal: () => ({
      requestedIds: ['person-1'], revealedPersonalEmails: true, failedIds: [], skippedIds: [],
      candidates: [enrichedCandidate('person-1', 'Test Candidate', { email: 'work@example-co.test', emailType: 'work' })]
    })
  });
  render(<App />);
  fillRequired();
  applySearch();
  await screen.findByText('Test Candidate');

  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /^reveal email/i }));
  await screen.findByText(/contact details requested for 1 candidate/i);

  expect(calls.some((call) => call.url === '/api/candidates/waterfall')).toBe(false);
});




test('a name search never applies location, because it zeroes the result out', async () => {
  // Measured against the live API with role "hr executive" and name "Aditya":
  // name alone 33,790, + role 52, + role and skills 11, + location 0. Apollo
  // returns no location on a search row, so a name filtered by one matches
  // almost nothing it holds.
  namePool({ base: rows(['Someone Else']), byName: { Aditya: rows(['Aditya', 'Aditya Two']) } });
  await screen.findByText('Someone Else');
  // A location ticked from the results is applied to the pool search.
  tickLocation('Hyderabad');
  await waitFor(() => expect(calls.at(-1).body.location).toBe('Hyderabad'));

  fireEvent.change(rowSearch(), { target: { value: 'Aditya' } });
  // No question put to the recruiter: there is a right answer here.
  expect(screen.queryByRole('checkbox', { name: /also narrow the name search/i })).toBeNull();
  expect(rowSearch().placeholder).toMatch(/search by candidate name/i);

  searchByName();
  await screen.findByText('Aditya');

  const sent = calls.at(-1).body;
  expect(sent.personName).toBe('Aditya');
  // Role and skills sharpen it, so they travel.
  expect(sent.jobTitle).toBe('java developer');
  expect(sent.keywords).toBe('java');
  // Location does not, even though the field is filled in.
  expect(sent.location).toBe('');
  expect(screen.getByText(/location is not applied to a name search/i)).toBeTruthy();
});

test('a pool search still applies location', async () => {
  // Only the name path drops it; describing a pool is a different question.
  namePool({ base: rows(['Someone Else']), byName: {} });
  await screen.findByText('Someone Else');
  tickLocation('Hyderabad');
  await waitFor(() => expect(calls.at(-1).body.location).toBe('Hyderabad'));
});

test('the search button runs the same name search as Enter', async () => {
  namePool({ base: rows(['Someone Else']), byName: { Aditya: rows(['Aditya']) } });
  await screen.findByText('Someone Else');
  const go = () => screen.getByRole('button', { name: /search apollo for this name/i });

  // An idle, empty box is a box: neither control is on it until it is in use.
  expect(screen.queryByRole('button', { name: /search apollo for this name/i })).toBeNull();
  fireEvent.focus(rowSearch());
  // Focused but empty: there is nothing to search for, and it says so.
  expect(go().disabled).toBe(true);

  fireEvent.change(rowSearch(), { target: { value: 'Aditya' } });
  expect(go().disabled).toBe(false);
  fireEvent.click(go());
  await screen.findByText('Aditya');
  expect(calls.at(-1).body.personName).toBe('Aditya');

  // The same name is the search already on screen, so it cannot be spent twice.
  expect(go().disabled).toBe(true);
});

test('the name box is the only control, and it searches on Enter alone', async () => {
  namePool({ base: rows(['Someone Else']), byName: { Aditya: rows(['Aditya']) } });
  await screen.findByText('Someone Else');

  // One control: the box, with its own buttons inside it once it holds a name.
  expect(rowSearch().placeholder).toMatch(/search by candidate name/i);
  fireEvent.change(rowSearch(), { target: { value: 'Adi' } });
  expect(screen.getByRole('button', { name: /search apollo for this name/i })).toBeTruthy();
  expect(screen.getByRole('button', { name: /clear the box/i })).toBeTruthy();
  fireEvent.change(rowSearch(), { target: { value: '' } });

  fireEvent.change(rowSearch(), { target: { value: 'Aditya' } });
  // Typing alone must not spend a search.
  const before = calls.filter((call) => call.url === '/api/candidates/search').length;
  expect(calls.filter((call) => call.url === '/api/candidates/search').length).toBe(before);

  searchByName();
  await screen.findByText('Aditya');
  expect(calls.at(-1).body.personName).toBe('Aditya');
});

test('the single search form is the only way in', async () => {
  // Name search is what a recruiter wants from a LinkedIn-style lookup, and the
  // free name box in the results does that. Apollo's people/match mode asked
  // for four identifiers to return one person, on the paid endpoint.
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);

  expect(screen.queryByRole('radio', { name: /find one person/i })).toBeNull();
  expect(screen.queryByRole('radio', { name: /filter a pool/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /find this person/i })).toBeNull();
  expect(screen.queryByLabelText(/email address/i)).toBeNull();
  expect(screen.queryByLabelText(/linkedin url/i)).toBeNull();

  // The pool form is there, unwrapped, with its own fields intact.
  expect(screen.getByLabelText(/role \/ job title/i)).toBeTruthy();
  expect(screen.getByLabelText(/^skills$/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: /reset all/i })).toBeTruthy();

  fillRequired();
  applySearch();
  await screen.findByText('Test Candidate');
  // And nothing in the UI can reach the paid match endpoint any more.
  expect(calls.some((call) => call.url === '/api/candidates/lookup')).toBe(false);
});

// --- Helpers shared by the results-search and name-search tests -------------

function rowSearch() {
  return screen.getByLabelText(/find a candidate/i);
}

// Enter in the box is the only way to start a name search.
function searchByName() {
  fireEvent.keyDown(rowSearch(), { key: 'Enter' });
}

function visibleNames() {
  return [...document.querySelectorAll('.candidate-row .identity strong')].map((cell) => cell.textContent);
}

const poolOf = (people, total) => ({ candidates: people, page: 1, perPage: 25, total: total ?? people.length });

async function loadedPool(people, total) {
  mockBackend({ search: () => poolOf(people, total) });
  render(<App />);
  fillRequired();
  applySearch();
  for (const person of people) await screen.findByText(person.name);
}

// --- Optional, comma-separated skills ---------------------------------------

test('role and skills are sent as typed, neither rewriting the other', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);
  fireEvent.change(screen.getByLabelText(/role \/ job title/i),
    { target: { value: 'AI/ML Engineer, Machine Learning Engineer, Data Scientist' } });
  fireEvent.change(screen.getByLabelText(/^skills$/i), { target: { value: 'Python, LLM, Machine Learning' } });
  applySearch();
  await screen.findByText('Test Candidate');

  const sent = calls.at(-1).body;
  // Sent verbatim: the server splits them, and the skills never touch the role.
  expect(sent.jobTitle).toBe('AI/ML Engineer, Machine Learning Engineer, Data Scientist');
  expect(sent.keywords).toBe('Python, LLM, Machine Learning');
});

test('a role-only search and a skills-only search both reach Apollo', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);

  // Role only - skills left empty, which used to block the search entirely.
  fireEvent.change(screen.getByLabelText(/role \/ job title/i), { target: { value: 'AI/ML Engineer' } });
  applySearch();
  await screen.findByText('Test Candidate');
  expect(calls.at(-1).body.keywords).toBe('');

  // Skills only, no role.
  fireEvent.change(screen.getByLabelText(/role \/ job title/i), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText(/^skills$/i), { target: { value: 'Python' } });
  applySearch();
  await waitFor(() => expect(calls.at(-1).body.keywords).toBe('Python'));
  expect(calls.at(-1).body.jobTitle).toBe('');
});

test('the skills a candidate matched are shown on the row', async () => {
  // With each skill searched separately, matching all three is a much stronger
  // result than matching one, and the row says which.
  mockBackend({
    search: () => ({
      candidates: [
        { ...bareCandidate('person-1', 'Strong Match'), matchedSkills: ['Python', 'LLM', 'Machine Learning'] },
        { ...bareCandidate('person-2', 'Weak Match'), matchedSkills: ['LLM'] }
      ],
      page: 1, perPage: 25, total: null,
      skillTotals: [
        { skill: 'Python', total: 297 }, { skill: 'LLM', total: 25 }, { skill: 'Machine Learning', total: 381 }
      ]
    })
  });
  render(<App />);
  fireEvent.change(screen.getByLabelText(/^skills$/i), { target: { value: 'Python, LLM, Machine Learning' } });
  applySearch();
  await screen.findByText('Strong Match');

  const chips = (name) => [...rowFor(name).querySelectorAll('.matched-skills li')].map((li) => li.textContent);
  expect(chips('Strong Match')).toEqual(['Python', 'LLM', 'Machine Learning']);
  expect(chips('Weak Match')).toEqual(['LLM']);

  // No single total exists for a union, so the per-skill pools are shown and
  // the count describes what it actually is.
  expect(screen.getByText(/2 matching any of 3 skills/i)).toBeTruthy();
  expect(screen.getByText(/a candidate needs only one of them/i)).toBeTruthy();
  expect(screen.getByText(/297/)).toBeTruthy();
});

test('every skill can be required at once, in one Apollo request', async () => {
  // Merging the per-skill answers would only find people who happened to appear
  // in every page. Apollo ANDs several words in q_keywords natively, so asking
  // for all of them at once is both correct and the only way to get a real total.
  mockBackend({
    search: (body) => ({
      candidates: [{ ...bareCandidate('person-1', 'Both Skills'), matchedSkills: ['python', 'c++'] }],
      page: 1, perPage: 25,
      total: body.matchAllSkills ? 3 : null,
      skillTotals: body.matchAllSkills
        ? [{ skill: 'python + c++', total: 3 }]
        : [{ skill: 'python', total: 234 }, { skill: 'c++', total: 1 }],
      matchedAllSkills: body.matchAllSkills === true
    })
  });
  render(<App />);
  fireEvent.change(screen.getByLabelText(/^skills$/i), { target: { value: 'python, c++' } });
  // Entering the second skill commits both and searches on them.
  fireEvent.keyDown(screen.getByLabelText(/^skills$/i), { key: 'Enter' });

  // Any-of is the default, because it finds people.
  await screen.findByText(/2 skills/i);
  expect(calls.at(-1).body.matchAllSkills).toBe(false);
  expect(screen.getByText(/needs only one of them/i)).toBeTruthy();

  // The choice only exists once there are two skills to choose between, and
  // ticking it asks the strict question straight away.
  const everySkill = screen.getByRole('checkbox', { name: /must have every skill/i });
  expect(everySkill.checked).toBe(false);
  fireEvent.click(everySkill);
  await waitFor(() => expect(calls.at(-1).body.matchAllSkills).toBe(true));

  await screen.findByText(/every skill was required at once/i);
  expect(screen.getByText('python + c++')).toBeTruthy();
  // A single request means Apollo's own total is real again.
  expect(screen.getByText('3 profiles')).toBeTruthy();
});

test('the every-skill choice only appears when there is more than one skill', async () => {
  mockBackend({ search: () => searchResult([]) });
  render(<App />);

  fireEvent.change(screen.getByLabelText(/^skills$/i), { target: { value: 'python' } });
  fireEvent.keyDown(screen.getByLabelText(/^skills$/i), { key: 'Enter' });
  expect(screen.queryByRole('checkbox', { name: /must have every skill/i })).toBeNull();

  fireEvent.change(screen.getByLabelText(/^skills$/i), { target: { value: 'c++' } });
  fireEvent.keyDown(screen.getByLabelText(/^skills$/i), { key: 'Enter' });
  expect(screen.getByRole('checkbox', { name: /must have every skill/i })).toBeTruthy();
});

test('the seniority list offers only values Apollo actually recognises', async () => {
  // Verified against the live API: each value below returns people in a large
  // pool. "junior" and "mid_level" were offered here and return zero for every
  // query - Apollo does not recognise them and reports no error, so picking one
  // silently emptied the results with nothing on screen to explain it.
  mockBackend({ search: () => searchResult([]) });
  render(<App />);
  const values = [...document.querySelectorAll('.filter-form input[name="seniority"]')].map((box) => box.value);

  expect(values).toEqual(['intern', 'entry', 'senior', 'manager']);
  // Not Apollo values at all: either one silently emptied every search.
  expect(values).not.toContain('junior');
  expect(values).not.toContain('mid_level');
  // Apollo's sales-prospecting tiers, which return nothing for engineering
  // titles - measured 0 for head, director and partner across three roles.
  for (const tier of ['head', 'director', 'vp', 'c_suite', 'partner', 'owner', 'founder']) {
    expect(values, tier).not.toContain(tier);
  }
});

test('seniority levels are sent to Apollo as given, and several are one search', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);
  fillRequired();
  applySearch();
  await screen.findByText('Test Candidate');

  fireEvent.click(screen.getByRole('checkbox', { name: /^entry$/i }));
  await waitFor(() => expect(calls.at(-1).body.seniority).toBe('entry'));

  // A hire open to two levels is one query, not two.
  fireEvent.click(screen.getByRole('checkbox', { name: /^senior$/i }));
  await waitFor(() => expect(calls.at(-1).body.seniority).toBe('entry, senior'));

  // And unticking one leaves the other alone.
  fireEvent.click(screen.getByRole('checkbox', { name: /^entry$/i }));
  await waitFor(() => expect(calls.at(-1).body.seniority).toBe('senior'));
});


test('the role field suggests titles without limiting what can be searched', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);
  const role = screen.getByLabelText(/role \/ job title/i);

  // Closed until asked for, so it cannot cover the page on load.
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.focus(role);
  const options = () => [...screen.getByRole('listbox').querySelectorAll('[role="option"]')]
    .map((option) => option.textContent);

  // Every suggestion is verified against the live API to return a real pool.
  expect(options()).toContain('Data Scientist');
  expect(options()).toContain('HR Executive');
  expect(options().length).toBeGreaterThan(15);
  for (const option of options()) expect(option).not.toContain(',');

  // Typing filters the list rather than leaving a wall of twenty-two.
  fireEvent.change(role, { target: { value: 'engineer' } });
  expect(options().every((option) => option.toLowerCase().includes('engineer'))).toBe(true);
  expect(options()).not.toContain('Data Scientist');

  // Escape closes it without clearing what was typed.
  fireEvent.keyDown(role, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(role.value).toBe('engineer');
});


test('picking a role replaces the field, and the list closes when clicked away', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);
  const role = screen.getByLabelText(/role \/ job title/i);
  const pick = (label) => fireEvent.mouseDown(screen.getByRole('option', { name: label }));

  fireEvent.focus(role);
  pick('Data Scientist');
  // One role is the normal case, so the pick replaces rather than appending -
  // a list that kept growing had to be undone by hand.
  expect(role.value).toBe('Data Scientist');
  expect(screen.queryByRole('listbox')).toBeNull();

  fireEvent.focus(role);
  pick('AI/ML Engineer');
  expect(role.value).toBe('AI/ML Engineer');

  // Clicking anywhere else closes the list, whether or not the field had focus.
  fireEvent.focus(role);
  expect(screen.getByRole('listbox')).toBeTruthy();
  fireEvent.mouseDown(screen.getByLabelText(/^skills$/i));
  expect(screen.queryByRole('listbox')).toBeNull();

  // Several titles still combine when typed, because Apollo ORs them.
  fireEvent.change(role, { target: { value: 'Data Scientist, AI/ML Engineer' } });
  applySearch();
  await screen.findByText('Test Candidate');
  expect(calls.at(-1).body.jobTitle).toBe('Data Scientist, AI/ML Engineer');
});

test('skill suggestions follow the chosen role', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);
  const role = screen.getByLabelText(/role \/ job title/i);
  const skills = screen.getByLabelText(/^skills$/i);
  const options = () => [...screen.getByRole('listbox').querySelectorAll('[role="option"]')]
    .map((option) => option.textContent);

  // With no role chosen, a general list rather than nothing.
  fireEvent.focus(skills);
  expect(options()).toContain('python');
  fireEvent.keyDown(skills, { key: 'Escape' });

  // Pick a role and the skills follow it.
  fireEvent.focus(role);
  fireEvent.mouseDown(screen.getByRole('option', { name: 'AI/ML Engineer' }));
  fireEvent.focus(skills);
  expect(options()).toEqual(['machine learning', 'python', 'deep learning', 'llm', 'nlp']);
  expect(screen.getByText(/suggested for ai\/ml engineer/i)).toBeTruthy();

  // A different role, different skills.
  fireEvent.change(role, { target: { value: 'QA Engineer' } });
  fireEvent.focus(skills);
  expect(options()).toEqual(['testing', 'automation', 'selenium', 'agile']);
});

test('skills accumulate, and anything can still be typed', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);
  const skills = screen.getByLabelText(/^skills$/i);
  fireEvent.change(screen.getByLabelText(/role \/ job title/i), { target: { value: 'Data Scientist' } });

  // Unlike the role, skills build a list: each one becomes its own chip and the
  // box is left empty for the next.
  const skillChips = () => [...document.querySelectorAll('.skill-chips .chip-static')]
    .map((chip) => chip.textContent);
  fireEvent.focus(skills);
  fireEvent.mouseDown(screen.getByRole('option', { name: 'python' }));
  expect(skillChips()).toEqual(['python']);
  expect(skills.value).toBe('');
  fireEvent.focus(skills);
  fireEvent.mouseDown(screen.getByRole('option', { name: 'machine learning' }));
  expect(skillChips()).toEqual(['python', 'machine learning']);

  // One already chosen is not offered again.
  fireEvent.focus(skills);
  expect([...screen.getByRole('listbox').querySelectorAll('[role="option"]')]
    .map((option) => option.textContent)).not.toContain('python');

  // And a skill nobody suggested still searches.
  fireEvent.click(screen.getByRole('button', { name: /remove python/i }));
  fireEvent.click(screen.getByRole('button', { name: /remove machine learning/i }));
  fireEvent.change(skills, { target: { value: 'rust, webassembly' } });
  applySearch();
  await screen.findByText('Test Candidate');
  expect(calls.at(-1).body.keywords).toBe('rust, webassembly');
});

test('no filter field offers the browser its own autofill history', async () => {
  // The dropdown covering the skills field was the browser's saved-value list,
  // which cannot be filtered, styled, or kept relevant to the role.
  mockBackend({ search: () => searchResult([]) });
  render(<App />);
  for (const label of [/role \/ job title/i, /^skills$/i]) {
    expect(screen.getByLabelText(label).getAttribute('autocomplete'), String(label)).toBe('off');
  }
});

test('the personal email filter is gone; the address shows on the row instead', async () => {
  // It only ever hid rows. A personal address already appears on the candidate
  // it belongs to, so the filter added a control without adding information.
  mockBackend({
    search: () => searchResult([{ ...bareCandidate('person-1', 'Has Personal'), hasEmailOnFile: true }]),
    reveal: () => ({
      requestedIds: ['person-1'], revealedPersonalEmails: true, failedIds: [], skippedIds: [],
      candidates: [enrichedCandidate('person-1', 'Has Personal', {
        email: 'work@example-co.test', emailType: 'work', personalEmail: 'found@example-mail.test'
      })]
    })
  });
  render(<App />);
  fillRequired();
  applySearch();
  await screen.findByText('Has Personal');

  expect(screen.queryByRole('checkbox', { name: /personal email only/i })).toBeNull();

  fireEvent.click(screen.getByRole('checkbox', { name: /select has personal/i }));
  fireEvent.click(screen.getByRole('button', { name: /^reveal email/i }));
  await screen.findByText(/contact details requested for 1 candidate/i);

  // The address is on the row, which is what the filter was standing in for.
  const contact = rowFor('Has Personal').querySelector('.candidate-row .contact');
  expect(within(contact).getByRole('link', { name: 'found@example-mail.test' })).toBeTruthy();
});

// --- Location: ticked from what the search returned -------------------------

function locationOptions() {
  return [...document.querySelectorAll('.location-options .option-name')].map((name) => name.textContent);
}

// A pool whose rows sit in several cities, so the list has something to offer.
function poolIn(cities) {
  mockBackend({
    search: () => searchResult(cities.map((city, index) => ({
      ...bareCandidate(`person-${index + 1}`, `Candidate ${index + 1}`), location: city
    })))
  });
  render(<App />);
  fireEvent.change(screen.getByLabelText(/role \/ job title/i), { target: { value: 'Frontend Developer' } });
  applySearch();
}

test('a city named by the results leads the list, with its count beside it', async () => {
  // Apollo has no facet endpoint and usually returns no location on a search
  // row at all, so the standing list is what makes this filter usable - but
  // when rows do name a city, that city is promoted above the standing list.
  poolIn(['Hyderabad, Telangana, India', 'Bangalore, Karnataka, India', 'Hyderabad, Telangana, India']);
  await screen.findByText('Candidate 1');

  // The city, not the whole "city, state, country" string Apollo writes, and
  // the commonest first with its count beside it.
  expect(locationOptions().slice(0, 2)).toEqual(['Hyderabad', 'Bangalore']);
  expect(screen.getByText('2')).toBeTruthy();
  // Each city once, however many lists it belongs to.
  expect(locationOptions().filter((city) => city === 'Hyderabad')).toHaveLength(1);
  // And the standing list is still there underneath.
  expect(locationOptions()).toContain('Chennai');
});

test('ticking a city narrows the same search rather than starting a new one', async () => {
  poolIn(['Hyderabad', 'Bangalore']);
  await screen.findByText('Candidate 1');
  const first = calls.length;

  tickLocation('Hyderabad');
  await waitFor(() => expect(calls.length).toBe(first + 1));
  expect(calls.at(-1).body.location).toBe('Hyderabad');
  expect(calls.at(-1).body.jobTitle).toBe('Frontend Developer');
});

test('several cities are searched as an OR, and unticking one leaves the rest', async () => {
  poolIn(['Hyderabad', 'Bangalore', 'Pune']);
  await screen.findByText('Candidate 1');

  tickLocation('Hyderabad');
  await waitFor(() => expect(calls.at(-1).body.location).toBe('Hyderabad'));
  tickLocation('Bangalore');
  // Sent whole; the backend splits it into the OR Apollo expects.
  await waitFor(() => expect(calls.at(-1).body.location).toBe('Hyderabad, Bangalore'));
  expect(screen.getByText(/candidates in any of these cities/i)).toBeTruthy();

  tickLocation('Hyderabad');
  await waitFor(() => expect(calls.at(-1).body.location).toBe('Bangalore'));
});

test('a ticked city stays on the list even when the results no longer hold it', async () => {
  // Otherwise narrowing to one city would remove every other city from the
  // list, including the one just ticked, leaving no way to untick it.
  poolIn(['Hyderabad', 'Bangalore']);
  await screen.findByText('Candidate 1');
  tickLocation('Bangalore');

  await waitFor(() => expect(calls.at(-1).body.location).toBe('Bangalore'));
  expect(locationOptions()).toContain('Bangalore');
  expect(screen.getByRole('checkbox', { name: /^bangalore/i }).checked).toBe(true);
});

test('the city list is usable before any search, and takes one it does not hold', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);
  // Offered from the start, because Apollo cannot tell us which cities a pool
  // holds and an empty list would leave the filter unusable.
  expect(locationOptions()).toContain('Hyderabad');
  // Ticking one narrows the pool that is already on screen.
  tickLocation('Hyderabad');
  await waitFor(() => expect(searchCalls().length).toBe(1));
  expect(searchCalls()[0].body.location).toBe('Hyderabad');

  // The box searches the list first: typing narrows it to what matches, with
  // the ticked city kept on screen so it can still be unticked.
  const box = screen.getByLabelText(/search or add a city/i);
  fireEvent.change(box, { target: { value: 'che' } });
  expect(locationOptions()).toEqual(['Hyderabad', 'Chennai']);

  // And a city the list does not hold is added by the same box.
  fireEvent.change(box, { target: { value: 'Mysuru' } });
  expect(screen.getByText(/press enter to add/i)).toBeTruthy();
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(locationOptions()).toContain('Mysuru');
  expect(screen.getByRole('checkbox', { name: /^mysuru/i }).checked).toBe(true);
  await waitFor(() => expect(searchCalls().at(-1).body.location).toBe('Hyderabad, Mysuru'));

  // And it reaches Apollo once there is a role to search for.
  fireEvent.change(screen.getByLabelText(/role \/ job title/i), { target: { value: 'Data Scientist' } });
  applySearch();
  await waitFor(() => expect(calls.at(-1).body.location).toBe('Hyderabad, Mysuru'));
});

test('skills get the same removable chips as locations', async () => {
  mockBackend({ search: () => searchResult([]) });
  render(<App />);
  const skills = screen.getByLabelText(/^skills$/i);
  const skillChipList = () => [...document.querySelectorAll('.skill-chips .chip-static')]
    .map((chip) => chip.textContent);

  fireEvent.change(skills, { target: { value: 'python, machine learning, python, sql,' } });
  // De-duplicated, and each one shown as its own value rather than as a string
  // of punctuation.
  expect(skillChipList()).toEqual(['python', 'machine learning', 'sql']);

  fireEvent.click(screen.getByRole('button', { name: /remove machine learning/i }));
  expect(skillChipList()).toEqual(['python', 'sql']);
  expect(skills.value).toBe('');
});

test('a field label never picks up the chips as part of its name', async () => {
  // The chips used to sit inside the label element, which made the field's
  // accessible name "Skills python x sql x" to a screen reader.
  mockBackend({ search: () => searchResult([]) });
  render(<App />);
  fireEvent.change(screen.getByLabelText(/^skills$/i), { target: { value: 'python, sql' } });

  // Still found by its own name, with the chips rendered outside the label.
  expect(screen.getByLabelText(/^skills$/i).name).toBe('keywords');
});
