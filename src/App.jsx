import React, { useState } from 'react';
import {
  ENRICHED, ENRICHING, FAILED, NOT_ENRICHED,
  applyEnriched, applyStates, enrichmentLabel, enrichmentSummary, idsToEnrich, markState, reconcile, stateOf
} from './enrichment.js';

const initialFilters = { jobTitle: '', location: '', seniority: '', keywords: '', company: '', industry: '' };
// Role, skills and location are required; the rest narrow an already
// meaningful search. Apollo bills for every search, so a query without these
// three is not worth sending.
const REQUIRED_FILTERS = ['jobTitle', 'location', 'keywords'];
const fields = [
  ['jobTitle', 'Role / Job Title', 'e.g. Senior Java Developer', true],
  ['location', 'Location', 'e.g. Hyderabad, India', true],
  ['keywords', 'Skills / Keywords', 'e.g. Java, Spring Boot', true],
  ['company', 'Company', 'Optional', false],
  ['industry', 'Industry', 'Optional', false]
];
const FIELD_LABELS = Object.fromEntries(fields.map(([name, label]) => [name, label.toLowerCase()]));

const NOT_AVAILABLE = 'Not available';
const DEFAULT_PER_PAGE = 25;

function valueOrUnavailable(value) { return value || NOT_AVAILABLE; }

function Unavailable() { return <span className="muted">{NOT_AVAILABLE}</span>; }

// Our backend always answers with JSON, but a proxy or gateway in front of it
// may not: an unreachable backend (a dev-server restart, for instance) yields
// an empty 500. Read the body as text first so that case becomes a message the
// recruiter can act on instead of a raw JSON parse failure.
async function readJson(response) {
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!response.ok) {
    if (data?.error) throw new Error(data.error);
    throw new Error(response.status >= 500
      ? 'The candidate API is not reachable right now. If the dev server is restarting, try again in a moment.'
      : `The candidate API rejected the request (${response.status}).`);
  }
  if (!data) throw new Error('The candidate API returned an empty response.');
  return data;
}

function DetailField({ label, children }) {
  return <div className="detail-field"><span className="detail-label">{label}</span><div className="detail-value">{children}</div></div>;
}

// Apollo is the only source for anything rendered here. A field Apollo did
// not return stays "Not available"; nothing is inferred from the LinkedIn URL,
// which is a manual link for the recruiter and never fetched by this app.
function EmploymentList({ roles }) {
  if (!roles.length) return <Unavailable />;
  return <ul className="plain">
    {roles.map((role, index) => <li key={`${role.organization || 'org'}-${role.title || 'title'}-${index}`}>
      <strong>{valueOrUnavailable(role.organization)}</strong>
      {role.title ? ` — ${role.title}` : ''}
      {(role.startDate || role.endDate) && <span className="dates"> ({role.startDate || NOT_AVAILABLE} to {role.endDate || 'present'})</span>}
    </li>)}
  </ul>;
}

function ContactValue({ value, available, href }) {
  if (value) return <a href={href}>{value}</a>;
  return <span className={available ? 'available' : 'muted'}>{available ? 'Available' : NOT_AVAILABLE}</span>;
}

// One contact line. A real value wins; otherwise the recruiter sees whether
// Apollo says it exists at all, never a fabricated address.
function ContactLine({ label, children }) {
  return <div className="contact-line"><span className="contact-label">{label}</span>{children}</div>;
}

function EnrichedDetails({ candidate, onRefresh, busy }) {
  const history = candidate.employmentHistory || [];
  const current = history.filter((role) => role.current);
  const previous = history.filter((role) => !role.current);
  const skills = candidate.skills || [];
  const departments = candidate.departments || [];
  return <section className="enriched-details" aria-label={`Enriched details for ${valueOrUnavailable(candidate.name)}`}>
    <div className="enriched-head">
      <h4>Enriched Details</h4>
      <button type="button" className="link-button" onClick={onRefresh} disabled={busy}>
        {busy ? 'Refreshing...' : 'Refresh from Apollo'}
      </button>
    </div>
    <div className="detail-grid">
      <DetailField label="Professional headline">{candidate.headline ? candidate.headline : <Unavailable />}</DetailField>
      <DetailField label="Seniority">{candidate.seniority ? candidate.seniority : <Unavailable />}</DetailField>
      <DetailField label="Department">{departments.length ? departments.join(', ') : <Unavailable />}</DetailField>
      <DetailField label="Skills">
        {skills.length ? <ul className="chips">{skills.map((skill) => <li key={skill}>{skill}</li>)}</ul> : <Unavailable />}
      </DetailField>
      <DetailField label="Current employment"><EmploymentList roles={current} /></DetailField>
      <DetailField label="Previous employment"><EmploymentList roles={previous} /></DetailField>
      <DetailField label="Email"><ContactValue value={candidate.email} available={candidate.emailAvailable} href={candidate.email ? `mailto:${candidate.email}` : undefined} /></DetailField>
      <DetailField label="Phone"><ContactValue value={candidate.phone} available={candidate.phoneAvailable} href={candidate.phone ? `tel:${candidate.phone}` : undefined} /></DetailField>
      <DetailField label="LinkedIn">
        {candidate.linkedinUrl
          ? <a className="linkedin-url" href={candidate.linkedinUrl} target="_blank" rel="noreferrer">{candidate.linkedinUrl}</a>
          : <Unavailable />}
      </DetailField>
    </div>
  </section>;
}

function CandidateBlock({ candidate, selected, selectable, state, expanded, busy, onToggle, onExpand, onRetry, onRefresh }) {
  const name = valueOrUnavailable(candidate.name);
  return <div className="candidate-block">
    <article className="candidate-row">
      <label className="check">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={!selectable}
          aria-label={selectable ? `Select ${name}` : 'Cannot select: Apollo returned no person ID for this result'}
        />
        <span />
      </label>
      <div className="identity">
        <strong>{name}</strong>
        <span>{valueOrUnavailable(candidate.title)}</span>
      </div>
      <div data-label="Company">{valueOrUnavailable(candidate.company)}</div>
      <div data-label="Location">{valueOrUnavailable(candidate.location)}</div>
      <div className="contact" data-label="Contact">
        <ContactLine label="Email"><ContactValue value={candidate.email} available={candidate.emailAvailable} href={candidate.email ? `mailto:${candidate.email}` : undefined} /></ContactLine>
        <ContactLine label="Phone"><ContactValue value={candidate.phone} available={candidate.phoneAvailable} href={candidate.phone ? `tel:${candidate.phone}` : undefined} /></ContactLine>
        <ContactLine label="LinkedIn">
          {candidate.linkedinUrl
            ? <a href={candidate.linkedinUrl} target="_blank" rel="noreferrer">View LinkedIn Profile</a>
            : <Unavailable />}
        </ContactLine>
      </div>
      <div className={`enriched-cell state-${state}`} data-label="Enriched">
        <span className="status-badge">{enrichmentLabel(state)}</span>
        {state === FAILED && <button type="button" className="link-button" onClick={onRetry} disabled={busy}>Retry</button>}
        {state === ENRICHED && <button
          type="button"
          className="link-button"
          onClick={onExpand}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} enriched details for ${name}`}
        >{expanded ? 'Hide details' : 'View details'}</button>}
      </div>
    </article>
    {expanded && state === ENRICHED && <EnrichedDetails candidate={candidate} onRefresh={onRefresh} busy={busy} />}
  </div>;
}

function SkeletonRows({ count = 5 }) {
  return <div className="skeleton" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <div className="skeleton-row" key={index}>
      <span className="bar wide" /><span className="bar" /><span className="bar" /><span className="bar" />
    </div>)}
  </div>;
}

export default function App() {
  const [filters, setFilters] = useState(initialFilters);
  const [candidates, setCandidates] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [enriched, setEnriched] = useState(new Map());
  const [states, setStates] = useState(new Map());
  const [expanded, setExpanded] = useState(new Set());
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(DEFAULT_PER_PAGE);
  const [total, setTotal] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState('');

  function updateFilter(event) { setFilters({ ...filters, [event.target.name]: event.target.value }); }
  function resetFilters() { setFilters(initialFilters); }
  function toggle(id) { const next = new Set(selected); next.has(id) ? next.delete(id) : next.add(id); setSelected(next); }
  function selectAll() { setSelected(new Set(candidates.map((candidate) => candidate.id).filter(Boolean))); }
  function clearSelection() { setSelected(new Set()); }
  function toggleExpanded(id) {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpanded(next);
  }

  // Search behavior is unchanged: it never enriches, and it never touches
  // anything but our own backend.
  async function search(nextPage = 1) {
    setLoading('search'); setStatus(null); setPage(nextPage);
    try {
      const response = await fetch('/api/candidates/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...filters, page: nextPage }) });
      const data = await readJson(response);
      setCandidates(data.candidates); setTotal(data.total); setSelected(new Set());
      setPerPage(data.perPage || DEFAULT_PER_PAGE);
      if (!data.candidates.length) setStatus({ type: 'info', text: 'No matching candidates found.' });
    } catch (error) { setStatus({ type: 'error', text: error.message || 'Unable to connect to Apollo. Please try again.' }); }
    finally { setLoading(''); }
  }

  function submitSearch(event) {
    event.preventDefault();
    // Apollo bills for every search, so refuse one that cannot be meaningful.
    if (!canSearch) {
      return setStatus({ type: 'error', text: `Role / job title, skills / keywords and location are required. Still needed: ${missingRequired.map((key) => FIELD_LABELS[key]).join(', ')}.` });
    }
    search(1);
  }

  async function enrich(explicitIds, { refresh = false } = {}) {
    const requested = idsToEnrich(explicitIds || [...selected], states, { refresh });
    if (!requested.length) {
      return setStatus({ type: 'info', text: 'Every selected candidate is already enriched. Use Refresh from Apollo to fetch it again.' });
    }
    setStates((previous) => markState(previous, requested, ENRICHING));
    setLoading('enrich'); setStatus(null);
    try {
      const response = await fetch('/api/candidates/enrich', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: requested }) });
      const data = await readJson(response);
      // Applied as functional updates so an overlapping retry cannot reconcile
      // against a stale snapshot and discard an earlier result.
      const outcome = reconcile(data.requestedIds || requested, data);
      setStates((previous) => applyStates(previous, outcome));
      setEnriched((previous) => applyEnriched(previous, outcome));
      // Open what we just enriched: the recruiter asked for this data, so make
      // them click again to see it.
      setExpanded((previous) => new Set([...previous, ...outcome.matchedIds]));
      setStatus({ type: outcome.failed ? 'info' : 'success', text: enrichmentSummary(outcome) });
    } catch (error) {
      // The request never completed, so these stay retryable rather than
      // being recorded as answered by Apollo.
      setStates((previous) => markState(previous, requested, FAILED));
      setStatus({ type: 'error', text: error.message || 'Unable to enrich this candidate.' });
    } finally { setLoading(''); }
  }

  const visibleCandidates = candidates.map((candidate) => (candidate.id && enriched.get(candidate.id)) || candidate);
  const totalPages = total !== null && perPage ? Math.max(1, Math.ceil(total / perPage)) : null;
  const searching = loading === 'search';
  const missingRequired = REQUIRED_FILTERS.filter((key) => filters[key].trim() === '');
  const canSearch = missingRequired.length === 0;
  const resultsSummary = candidates.length
    ? (total !== null
      ? `Showing ${candidates.length} of ${total.toLocaleString()} profiles`
      : `Showing ${candidates.length} profiles`)
    : 'Profiles returned by Apollo';

  return <main>
    <header className="topbar"><div className="mark">A<span>/</span></div><div><p className="eyebrow">Talent intelligence</p><h1>Candidate Search</h1></div><div className="secure"><span className="dot" /> Apollo connected via secure backend</div></header>

    <form className="panel search-panel" onSubmit={submitSearch}>
      <div className="panel-heading">
        <div><span className="step">01</span><div><h3>Define your search</h3><p>Role, skills and location are required. Company, industry and seniority narrow it further.</p></div></div>
        <button type="button" className="link-button" onClick={resetFilters}>Reset filters</button>
      </div>
      <div className="form-grid">
        {fields.map(([name, label, placeholder, required]) => <label key={name}>
          {label}{required && <em className="req" aria-hidden="true">Required</em>}
          <input name={name} value={filters[name]} onChange={updateFilter} placeholder={placeholder} required={required} aria-required={required} />
        </label>)}
        <label>Seniority<select name="seniority" value={filters.seniority} onChange={updateFilter}><option value="">Any level</option><option value="entry">Entry</option><option value="junior">Junior</option><option value="mid_level">Mid-level</option><option value="senior">Senior</option><option value="manager">Manager</option><option value="director">Director</option></select></label>
      </div>
      <button type="submit" className="primary" disabled={searching || !canSearch}>{searching ? 'Searching candidates...' : 'Search Candidates'} <span>→</span></button>
      {!canSearch && <p className="hint">Still needed: {missingRequired.map((key) => FIELD_LABELS[key]).join(', ')}.</p>}
    </form>

    {(status || searching || candidates.length > 0) && <section className="results">
      <div className="results-head">
        <div><span className="step">02</span><div><h3>Candidate results</h3><p>{resultsSummary}</p></div></div>
        <div className="selection-actions">
          <span>Selected: <b>{selected.size}</b></span>
          <button type="button" onClick={selectAll} disabled={!candidates.length}>Select all</button>
          <button type="button" onClick={clearSelection} disabled={!selected.size}>Clear</button>
          <button type="button" className="secondary" onClick={() => enrich()} disabled={!selected.size || loading === 'enrich'}>
            {loading === 'enrich' ? 'Enriching selected candidates...' : `Enrich selected${selected.size ? ` (${selected.size})` : ''}`} <span>↗</span>
          </button>
        </div>
      </div>

      {status && <div className={`notice ${status.type}`} role="status" aria-live="polite">{status.text}</div>}

      {searching && !candidates.length && <SkeletonRows />}

      {candidates.length > 0 && <div className="table">
        <div className="table-head"><span /><span>Candidate</span><span>Company</span><span>Location</span><span>Contact</span><span>Enriched</span></div>
        {visibleCandidates.map((candidate, index) => {
          const id = candidate.requestedId || candidate.id;
          return <CandidateBlock
            key={id || `row-${index}`}
            candidate={candidate}
            selected={Boolean(id) && selected.has(id)}
            selectable={Boolean(id)}
            state={stateOf(states, id)}
            expanded={expanded.has(id)}
            busy={loading === 'enrich'}
            onToggle={() => toggle(id)}
            onExpand={() => toggleExpanded(id)}
            onRetry={() => enrich([id], { refresh: true })}
            onRefresh={() => enrich([id], { refresh: true })}
          />;
        })}
      </div>}

      {candidates.length > 0 && <div className="pagination">
        <button type="button" onClick={() => search(page - 1)} disabled={page <= 1 || searching}>← Previous</button>
        <span>Page <b>{page}</b>{totalPages ? ` of ${totalPages.toLocaleString()}` : ''}</span>
        <button type="button" onClick={() => search(page + 1)} disabled={searching || (totalPages ? page >= totalPages : candidates.length === 0)}>Next →</button>
      </div>}
    </section>}

    <footer>Results and profile links are supplied by Apollo. LinkedIn profiles are never visited or scraped by this application.</footer>
  </main>;
}

export { NOT_ENRICHED, ENRICHING, ENRICHED, FAILED };
