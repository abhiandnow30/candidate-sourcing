import React, { useState } from 'react';
import {
  ENRICHED, ENRICHING, FAILED, NOT_ENRICHED, REVEALING, REVEALING_PHONE, SEARCHING_SOURCES,
  applyEnriched, applyStates, applyWaterfall, enrichmentLabel, enrichmentSummary, idsToEnrich, idsToReveal,
  idsToRevealPhone, markState, reconcile, revealSummary, stateOf
} from './enrichment.js';

// personName is not one of the form fields: it is driven by the results search
// box, because that is where a recruiter is when they realise the person they
// want is on one of the other pages.
const initialFilters = { jobTitle: '', location: '', seniority: '', keywords: '', company: '', industry: '', personName: '' };
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

// The other way in: a recruiter who already knows who they want does not need
// to filter a pool to find them. Apollo matches one person from any of these,
// so none is required on its own - but a company alone identifies an employer
// rather than a person, so it cannot be the only thing given.
const initialLookup = { name: '', company: '', email: '', linkedinUrl: '' };
const lookupFields = [
  ['name', 'Name', 'e.g. Jane Doe'],
  ['company', 'Company', 'Optional, narrows a common name'],
  ['email', 'Email address', 'e.g. jane@example.com'],
  // The placeholder deliberately spells out no LinkedIn path: shipped frontend
  // source hardcodes no LinkedIn endpoint, and a guard test enforces that.
  ['linkedinUrl', 'LinkedIn URL', 'Paste the full profile URL']
];
// A company is deliberately not here: on its own it is not a person.
const LOOKUP_IDENTIFIERS = ['name', 'email', 'linkedinUrl'];

// How many past queries to keep in the refine trail. Enough to see which skill
// narrowed the pool, short enough not to become a wall of numbers.
const REFINE_TRAIL_LENGTH = 6;

const NOT_AVAILABLE = 'Not available';
const DEFAULT_PER_PAGE = 25;
// Mirrors MAX_REVEAL_PER_REQUEST on the backend, so the confirmation can state
// the real cost instead of a number the server will then cut down.
const REVEAL_LIMIT = 10;
// Mirrors MAX_PHONE_PER_REQUEST on the backend. Mobile credits are the dearest
// thing this app spends, so the confirmation can state the real cost rather
// than a number the server will then cut down.
const PHONE_LIMIT = 5;
// Backoff for the retries below. A `node --watch` restart can take a second or
// more to rebind, and a single short retry lands inside the same gap, so this
// spans about three seconds in total. Safe only because search is free and
// repeatable; nothing that spends credits retries at all.
const RESTART_RETRY_DELAYS_MS = [400, 900, 1600];
// A waterfall runs for minutes. Poll no faster than Apollo asks, and give up
// rather than polling forever if it never finishes.
const WATERFALL_MAX_WAIT_MS = 5 * 60 * 1000;

function valueOrUnavailable(value) { return value || NOT_AVAILABLE; }

function Unavailable() { return <span className="muted">{NOT_AVAILABLE}</span>; }

// Apollo says which kind of address it gave us. A waterfall answer can carry an
// address Apollo stated no kind for, and calling that one a work address would
// be our claim rather than Apollo's, so it is labelled plainly. Anything else
// reads as a work address, which is what an unrevealed or missing one is
// expected to be.
function emailLabel(candidate) {
  if (candidate.emailType === 'personal') return 'Personal email';
  if (candidate.emailType === 'unknown') return 'Email';
  return 'Work email';
}

// A candidate's personal address, whichever slot Apollo's answer put it in: its
// own field when there is also a work address, or the primary one when the only
// address Apollo held was personal.
function personalEmailOf(candidate) {
  return candidate.personalEmail || (candidate.emailType === 'personal' ? candidate.email : null);
}

// What Apollo has said about a personal address is four different things, and a
// blank row cannot tell them apart. A found address wins; a waterfall still
// running says so; a finished one that found nothing says that, because a
// successful search with no result is a real answer and not a failure; and a
// candidate nobody has asked about stays "Not available".
function PersonalEmailStatus({ candidate, state }) {
  const personal = personalEmailOf(candidate);
  if (personal) return <a href={`mailto:${personal}`}>{personal}</a>;
  if (state === SEARCHING_SOURCES) return <span className="muted">Checking for personal email...</span>;
  if (candidate.waterfallChecked) return <span className="muted">No personal email found</span>;
  return <Unavailable />;
}

// The same four states as the personal address, for the number. A phone job
// answers nothing about an email and vice versa, so this reads phoneChecked and
// never contactRevealed.
function PhoneStatus({ candidate, state }) {
  if (candidate.phone) return <a href={`tel:${candidate.phone}`}>{candidate.phone}</a>;
  if (state === REVEALING_PHONE) return <span className="muted">Checking for phone number...</span>;
  if (candidate.phoneChecked) return <span className="muted">No phone number found</span>;
  return <ContactValue value={null} available={candidate.phoneAvailable} />;
}

// Whether the dedicated personal line belongs on this row at all. It is
// suppressed when the primary line is already showing the personal address, so
// the same value is never displayed twice under two labels, and it stays hidden
// for a candidate no search of other sources has touched.
function showPersonalLine(candidate, state) {
  if (candidate.emailType === 'personal') return false;
  return Boolean(candidate.personalEmail) || Boolean(candidate.waterfallChecked) || state === SEARCHING_SOURCES;
}

// Matches a row against what the recruiter typed into the results search box.
//
// Only the fields a pool row actually carries are searched. Apollo returns no
// skills, headline or location on a search result - measured: empty on all 25
// rows - so offering to search those would find nothing every time and read as
// a broken box rather than an empty pool. Addresses are included because after
// a reveal they are the thing worth finding a person by.
function matchesRowQuery(candidate, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [candidate.name, candidate.title, candidate.company, candidate.email, candidate.personalEmail]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
}

// A candidate Apollo was actually asked about, where the answer was "no personal
// address". Only these are hidden by the filter.
//
// It turns on contactRevealed, not enriched. Plain enrichment sends
// reveal_personal_emails: false, so an enriched candidate has never been asked
// and its blank personal field means "unknown", not "none". Treating those two
// as the same thing told recruiters Apollo had returned no personal address for
// people Apollo was never asked about.
function knownWithoutPersonalEmail(candidate) {
  return Boolean(candidate.contactRevealed) && !personalEmailOf(candidate);
}

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
    if (data?.error) {
      const error = new Error(data.error);
      // Carried so a caller can tell a permanent failure from a retryable one.
      error.code = data.code;
      throw error;
    }
    throw new Error(response.status >= 500
      ? 'The candidate API is not reachable right now. If the dev server is restarting, try again in a moment.'
      : `The candidate API rejected the request (${response.status}).`);
  }
  if (!data) throw new Error('The candidate API returned an empty response.');
  return data;
}

// True when a 503 came from the dev proxy because nothing was listening, as
// opposed to a real answer from our backend. Reads a clone so the original
// response body stays available to readJson.
async function peekUnreachable(response) {
  try {
    const text = await response.clone().text();
    return JSON.parse(text)?.code === 'API_UNREACHABLE';
  } catch {
    return false;
  }
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

function EnrichedDetails({ candidate, onRefresh, onReveal, busy, revealing, state }) {
  const history = candidate.employmentHistory || [];
  const current = history.filter((role) => role.current);
  const previous = history.filter((role) => !role.current);
  const skills = candidate.skills || [];
  const departments = candidate.departments || [];
  return <section className="enriched-details" aria-label={`Enriched details for ${valueOrUnavailable(candidate.name)}`}>
    <div className="enriched-head">
      <h4>Enriched Details</h4>
      <div className="enriched-actions">
        {/* Spends extra Apollo credits, so it is never automatic: the recruiter
            asks for it on the candidate whose email they can see is missing. */}
        {!candidate.email && <button type="button" className="link-button" onClick={onReveal} disabled={busy}>
          {revealing ? 'Revealing email...' : 'Reveal email address'}
        </button>}
        <button type="button" className="link-button" onClick={onRefresh} disabled={busy}>
          {busy && !revealing ? 'Refreshing...' : 'Refresh from Apollo'}
        </button>
      </div>
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
      <DetailField label={emailLabel(candidate)}><ContactValue value={candidate.email} available={candidate.emailAvailable} href={candidate.email ? `mailto:${candidate.email}` : undefined} /></DetailField>
      {showPersonalLine(candidate, state) && <DetailField label="Personal email">
        <PersonalEmailStatus candidate={candidate} state={state} />
      </DetailField>}
      <DetailField label="Phone"><PhoneStatus candidate={candidate} state={state} /></DetailField>
      <DetailField label="LinkedIn">
        {candidate.linkedinUrl
          ? <a className="linkedin-url" href={candidate.linkedinUrl} target="_blank" rel="noreferrer">{candidate.linkedinUrl}</a>
          : <Unavailable />}
      </DetailField>
    </div>
  </section>;
}

function CandidateBlock({ candidate, selected, selectable, state, expanded, busy, onToggle, onExpand, onRetry, onRefresh, onReveal }) {
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
        <ContactLine label={emailLabel(candidate)}><ContactValue value={candidate.email} available={candidate.emailAvailable} href={candidate.email ? `mailto:${candidate.email}` : undefined} /></ContactLine>
        {showPersonalLine(candidate, state) && <ContactLine label="Personal">
          <PersonalEmailStatus candidate={candidate} state={state} />
        </ContactLine>}
        <ContactLine label="Phone"><PhoneStatus candidate={candidate} state={state} /></ContactLine>
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
    {/* Kept open through a reveal so the panel does not vanish under the
        recruiter the moment they click the button inside it. */}
    {expanded && (state === ENRICHED || state === REVEALING || state === SEARCHING_SOURCES || state === REVEALING_PHONE) && candidate.enriched
      && <EnrichedDetails
        candidate={candidate}
        onRefresh={onRefresh}
        onReveal={onReveal}
        busy={busy}
        revealing={state === REVEALING}
        state={state}
      />}
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
  // A reveal spends real money, so it waits here for a deliberate confirmation
  // instead of firing on the first click.
  const [pendingReveal, setPendingReveal] = useState(null);
  // Apollo exposes no personal-email signal before a reveal, so this filters
  // what has already come back rather than narrowing the search.
  const [personalOnly, setPersonalOnly] = useState(false);
  // Apollo returns has_email free on every search result. Narrowing the search
  // to candidates it holds an address for costs nothing and is the difference
  // between a pool where nobody is reachable and one where everybody is.
  const [verifiedEmailOnly, setVerifiedEmailOnly] = useState(true);
  // Waterfall costs more than a reveal, so it waits for its own confirmation.
  const [pendingWaterfall, setPendingWaterfall] = useState(null);
  // Phone reveal is dearer still, so it waits for its own confirmation.
  const [pendingPhone, setPendingPhone] = useState(null);
  // Email and phone are separately priced, so a reveal asks for the number only
  // when the recruiter ticks it - but it can be ticked in the same dialog,
  // because "reveal the contact details" is one action in a recruiter's head.
  const [revealWithPhone, setRevealWithPhone] = useState(false);
  // 'pool' filters candidates; 'person' looks up one the recruiter already
  // knows. They are separate modes rather than one form doing both, because the
  // fields mean different things and only one set applies at a time.
  const [searchMode, setSearchMode] = useState('pool');
  const [lookup, setLookup] = useState(initialLookup);
  // Skills held as separate terms rather than one string, because Apollo ANDs
  // every keyword: three skills routinely narrow a pool to nothing, and the
  // recruiter needs to turn one off without retyping the rest.
  const [skills, setSkills] = useState([]);
  // Narrows the rows already on screen. Purely local: it sends nothing to
  // Apollo, so it costs nothing and cannot reach past the loaded page.
  const [rowQuery, setRowQuery] = useState('');
  // Whether a name search is narrowed by the pool filters as well.
  //
  // Both answers are right at different moments: a name on its own finds
  // everyone who has it - tens of thousands for a common one - while adding the
  // role, location and skills can narrow it to nobody. So it is the recruiter's
  // choice rather than a decision baked into the search, and the counts below
  // say what each one costs.
  const [nameWithFilters, setNameWithFilters] = useState(true);
  // Which scope the results on screen actually came from, so the button knows a
  // re-search is worth offering when only the scope changed.
  const [appliedNameScope, setAppliedNameScope] = useState(null);
  // What each query actually returned, so the effect of adding a skill is
  // visible instead of guessed. This is only ever appended to by a search the
  // recruiter asked for; nothing here triggers a request.
  const [refineTrail, setRefineTrail] = useState([]);

  function updateFilter(event) { setFilters({ ...filters, [event.target.name]: event.target.value }); }
  function updateLookup(event) { setLookup({ ...lookup, [event.target.name]: event.target.value }); }

  // Commits whatever is typed in the keywords box as its own term. Enter and
  // comma both do it, because a recruiter listing skills types either.
  // Promotes what is typed in the results box into Apollo's own name filter, so
  // the search covers every page instead of the one in hand. It is an explicit
  // action rather than something typing triggers: each one is a real request.
  function searchWholePoolByName() {
    const personName = rowQuery.trim();
    if (!personName) return;
    // The same name at the same scope is the search already on screen.
    if (personName === filters.personName && nameWithFilters === appliedNameScope) return;
    setFilters({ ...filters, personName });
    setAppliedNameScope(nameWithFilters);
    search(1, { personName });
  }

  function clearNameFilter() {
    setRowQuery('');
    setFilters({ ...filters, personName: '' });
    setAppliedNameScope(null);
    search(1, { personName: '' });
  }

  function commitSkill(event) {
    if (event.key !== 'Enter' && event.key !== ',') return;
    const term = filters.keywords.trim().replace(/,+$/, '');
    // Enter with an empty box is a submit, so it is left alone.
    if (!term) return;
    event.preventDefault();
    setFilters({ ...filters, keywords: '' });
    if (skills.some((skill) => skill.term.toLowerCase() === term.toLowerCase())) return;
    setSkills([...skills, { term, on: true }]);
  }

  // Turning a term off keeps it to hand: the whole point is to find which skill
  // narrowed the pool to nothing and drop just that one.
  function toggleSkill(term) {
    setSkills(skills.map((skill) => (skill.term === term ? { ...skill, on: !skill.on } : skill)));
  }

  function removeSkill(term) {
    setSkills(skills.filter((skill) => skill.term !== term));
  }
  function resetFilters() {
    if (searchMode === 'person') return setLookup(initialLookup);
    setFilters(initialFilters);
    setSkills([]);
    setRefineTrail([]);
  }

  // Switching mode clears the status, which belonged to the other mode's last
  // request, but leaves any results on screen: they are still Apollo's answer
  // and the recruiter may still be working through them.
  function changeMode(mode) {
    if (mode === searchMode) return;
    setSearchMode(mode);
    setStatus(null);
  }
  function toggle(id) { const next = new Set(selected); next.has(id) ? next.delete(id) : next.add(id); setSelected(next); }
  // Merges in whatever enrichment has come back, then applies the filter.
  // What the box should still narrow locally, which is nothing while it is
  // showing the name Apollo has already filtered on.
  //
  // Apollo matches a name against a first or a last name, where this box
  // matches the whole string: a search for "Aditya Sai" legitimately returns
  // people Apollo records as "Sai" or as "Aditya". Applying both filters threw
  // every one of those away and left the table empty under a count that said
  // 18 profiles matched.
  function localRowQuery() {
    return rowQuery.trim() === filters.personName ? '' : rowQuery;
  }

  function shownList() {
    const merged = candidates.map((candidate) => (candidate.id && enriched.get(candidate.id)) || candidate);
    const filtered = personalOnly ? merged.filter((candidate) => !knownWithoutPersonalEmail(candidate)) : merged;
    // Select all reads this, so a row hidden by the search box is never
    // selected and never quietly paid for.
    return filtered.filter((candidate) => matchesRowQuery(candidate, localRowQuery()));
  }

  // Selects only what is on screen: with the filter on, Select all must not
  // reach hidden candidates and quietly spend credits on them.
  function selectAll() { setSelected(new Set(shownList().map((candidate) => candidate.id).filter(Boolean))); }
  function clearSelection() { setSelected(new Set()); }
  function toggleExpanded(id) {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpanded(next);
  }

  // Search behavior is unchanged: it never enriches, and it never touches
  // anything but our own backend.
  //
  // The one retry here is deliberately limited to search. A dev-server restart
  // drops whatever request is in flight, and search is free and repeatable, so
  // retrying it silently is strictly better than showing an error the recruiter
  // can only answer by clicking the same button again. Enrich and reveal must
  // never do this: a dropped connection does not prove Apollo went unasked, so
  // an automatic retry there could pay for the same candidate twice.
  // What a search actually asks Apollo for.
  //
  // A name search is deliberately not narrowed by the pool filters. Looking
  // someone up by name is a different question from describing a pool, and
  // ANDing a role, a location and a skill onto it is exactly what made a real
  // name return nothing. So a name goes to Apollo on its own, the way a name
  // search anywhere else behaves.
  function queryFor(overrides = {}) {
    const personName = overrides.personName !== undefined ? overrides.personName : filters.personName;
    const withFilters = overrides.nameWithFilters !== undefined ? overrides.nameWithFilters : nameWithFilters;
    // The committed terms plus whatever is still in the box, so a skill the
    // recruiter typed but did not press Enter on is not silently dropped.
    if (personName) {
      return withFilters
        ? { ...filters, keywords: effectiveKeywords, personName }
        : { ...initialFilters, personName };
    }
    return { ...filters, ...overrides, keywords: effectiveKeywords, personName: '' };
  }

  // `overrides` carries a filter the recruiter changed in the same click.
  // React has not re-rendered yet at that point, so reading it from state here
  // would send the previous value.
  async function search(nextPage = 1, overrides = {}) {
    setLoading('search'); setStatus(null); setPage(nextPage);
    const query = queryFor(overrides);
    const keywords = query.keywords;
    const send = () => fetch('/api/candidates/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...query, page: nextPage, verifiedEmailOnly })
    });
    try {
      let response = await send();
      for (const delay of RESTART_RETRY_DELAYS_MS) {
        if (response.status !== 503 || !(await peekUnreachable(response))) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
        response = await send();
      }
      const data = await readJson(response);
      setCandidates(data.candidates); setTotal(data.total); setSelected(new Set());
      setPerPage(data.perPage || DEFAULT_PER_PAGE);
      // Recorded so the recruiter can see which term narrowed the pool and by
      // how much, rather than having to remember the last count.
      const total = typeof data.total === 'number' ? data.total : data.candidates.length;
      // Only pool searches belong here: the trail is a record of narrowing by
      // skill, which a name search does not do. Repeating the same query is not
      // new information either, so an identical entry replaces the last one.
      if (!query.personName) {
        setRefineTrail((previous) => {
          const last = previous[previous.length - 1];
          if (last && last.keywords === keywords && last.total === total) return previous;
          return [...previous, { keywords, total }].slice(-REFINE_TRAIL_LENGTH);
        });
      }

      if (!data.candidates.length) {
        // Apollo requires every keyword to match, so an empty pool after two or
        // more skills is almost always one skill too many rather than a
        // genuinely empty market. Say which, and what to do about it.
        const terms = keywords.split(/\s+/).filter(Boolean);
        const lastHit = [...refineTrail].reverse().find((entry) => entry.total > 0);
        setStatus({
          type: 'info',
          // A name filter that finds nobody is its own answer, and blaming the
          // keywords for it would send the recruiter after the wrong thing.
          // A name search finding nothing has two quite different causes, and
          // pointing at the wrong one sends the recruiter after the wrong fix.
          text: query.personName
            ? (query.jobTitle || query.location || query.keywords || query.company || query.industry || query.seniority)
              ? `Nobody named "${query.personName}" matches your ${narrowedBy}. Untick "Also narrow the name search" and search again to see everyone with that name, or widen the filters first.`
              : `Apollo has nobody by the name "${query.personName}". Nothing else was applied to this search, so try a different spelling, or just the first or last name on its own.`
            : terms.length > 1
              ? `No candidates match all ${terms.length} keywords at once - Apollo requires every one of them. ${lastHit ? `"${lastHit.keywords}" matched ${lastHit.total.toLocaleString()}. ` : ''}Turn a skill off and search again.`
              : 'No matching candidates found.'
        });
      }
    } catch (error) { setStatus({ type: 'error', text: error.message || 'Unable to connect to Apollo. Please try again.' }); }
    finally { setLoading(''); }
  }

  // Looks up one person the recruiter already knows. Apollo's match endpoint is
  // an enrichment call, so unlike search this never retries by itself: a
  // dropped connection does not prove Apollo went unasked, and a silent retry
  // could pay for the same lookup twice.
  async function lookupPerson(event) {
    event.preventDefault();
    if (!canLookup) {
      return setStatus({ type: 'error', text: 'Enter an email address, a LinkedIn URL, or a name to look one person up.' });
    }
    setLoading('lookup'); setStatus(null);
    try {
      const data = await readJson(await fetch('/api/candidates/lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lookup)
      }));
      // Apollo having nobody who matches is an answer, not a failure, and it
      // must not leave the previous person's row on screen as though it were
      // the result of this lookup.
      if (!data.candidate) {
        setCandidates([]); setTotal(0); setSelected(new Set());
        return setStatus({ type: 'info', text: 'Apollo has no person matching those details. Check the spelling, or try the email address or LinkedIn URL instead.' });
      }

      const candidate = data.candidate;
      setCandidates([candidate]); setTotal(1); setPage(1); setPerPage(DEFAULT_PER_PAGE);
      setSelected(new Set());
      if (candidate.id) {
        // A match answers with the full profile, so the row is already enriched
        // and its details are worth opening. contactRevealed is deliberately
        // not set: the lookup did not ask Apollo for contact data, so its
        // silence about a personal address means "never asked", not "none".
        setEnriched((previous) => new Map(previous).set(candidate.id, candidate));
        setStates((previous) => markState(previous, [candidate.id], ENRICHED));
        setExpanded((previous) => new Set([...previous, candidate.id]));
      }
      setStatus({ type: 'success', text: `Apollo matched ${candidate.name || 'one person'}. Reveal email to ask Apollo for an address.` });
    } catch (error) {
      setStatus({ type: 'error', text: error.message || 'Unable to look that person up.' });
    } finally { setLoading(''); }
  }

  function submitSearch(event) {
    event.preventDefault();
    // Apollo bills for every search, so refuse one that cannot be meaningful.
    if (!canSearch) {
      return setStatus({ type: 'error', text: `Role / job title, skills / keywords and location are required. Still needed: ${missingRequired.map((key) => FIELD_LABELS[key]).join(', ')}.` });
    }
    // Describing a pool is the opposite question to naming a person, so a live
    // name filter is dropped rather than silently ANDed onto the new search.
    // The box is cleared with it: a name left sitting there would go on hiding
    // rows locally, and the fresh pool would come back looking empty.
    if (filters.personName) setFilters({ ...filters, personName: '' });
    setRowQuery('');
    search(1, { personName: '' });
  }

  // Enrich and reveal post the same body to backend routes that answer in the
  // same shape. They differ in the state a row shows while in flight and, on
  // the backend, in whether Apollo was asked to spend credits on contact data.
  async function runEnrichment({ path, requested, busyKey, inFlightState, summarize, failureText, restoreOnError = false }) {
    const before = new Map(requested.map((id) => [id, stateOf(states, id)]));
    setStates((previous) => markState(previous, requested, inFlightState));
    setLoading(busyKey); setStatus(null);
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: requested }) });
      const data = await readJson(response);
      // Applied as functional updates so an overlapping retry cannot reconcile
      // against a stale snapshot and discard an earlier result.
      const outcome = reconcile(data.requestedIds || requested, data);
      setStates((previous) => applyStates(previous, outcome));
      // The backend says whether this response came from a request that asked
      // Apollo for contact data, so the filter can trust it later.
      setEnriched((previous) => applyEnriched(previous, outcome, { contactRevealed: data.revealedPersonalEmails === true }));
      // Open what we just enriched: the recruiter asked for this data, so do
      // not make them click again to see it.
      setExpanded((previous) => new Set([...previous, ...outcome.matchedIds]));
      setStatus({ type: outcome.failed ? 'info' : 'success', text: summarize(outcome) });
    } catch (error) {
      // An exhausted credit balance is not the candidate's failure: nothing was
      // asked of Apollo, so the rows must not be left showing Retry for
      // something that cannot succeed until the account is topped up.
      const restore = restoreOnError || error.code === 'APOLLO_CREDITS_EXHAUSTED';
      setStates((previous) => (restore
        // A reveal that never reached Apollo must not erase what the row
        // already showed, so each candidate goes back the way it was.
        ? new Map([...previous, ...before])
        // The request never completed, so these stay retryable rather than
        // being recorded as answered by Apollo.
        : markState(previous, requested, FAILED)));
      setStatus({ type: 'error', text: error.message || failureText });
    } finally { setLoading(''); }
  }

  async function enrich(explicitIds, { refresh = false } = {}) {
    const requested = idsToEnrich(explicitIds || [...selected], states, { refresh });
    if (!requested.length) {
      return setStatus({ type: 'info', text: 'Every selected candidate is already enriched. Use Refresh from Apollo to fetch it again.' });
    }
    return runEnrichment({
      path: '/api/candidates/enrich', requested, busyKey: 'enrich', inFlightState: ENRICHING,
      summarize: enrichmentSummary, failureText: 'Unable to enrich this candidate.'
    });
  }

  // The only path in the app that spends Apollo's contact credits. Reached
  // from an explicit click, never from search and never from plain enrichment.
  // This step only works out what would be sent and asks; nothing reaches
  // Apollo until the recruiter confirms the cost below.
  function reveal(explicitIds, { refresh = false } = {}) {
    const ids = explicitIds || [...selected];
    // Every reveal costs credits, so anyone whose address we already hold is
    // dropped here rather than paid for again.
    const eligible = idsToReveal(ids, states, enriched, { refresh });
    // Apollo told us in the free search response that it holds no address for
    // these. Revealing them can only return nothing, so they are never charged
    // for, and the recruiter is told rather than left guessing.
    const byId = new Map(shownList().map((candidate) => [candidate.requestedId || candidate.id, candidate]));
    const requested = eligible.filter((id) => byId.get(id)?.hasEmailOnFile !== false);
    const noAddressOnFile = eligible.length - requested.length;

    if (!requested.length) {
      return setStatus({
        type: 'info',
        text: noAddressOnFile
          ? `Apollo holds no email address for ${noAddressOnFile === 1 ? 'that candidate' : `those ${noAddressOnFile} candidates`}, so revealing would return nothing and no credit was spent.`
          : ids.length
            ? 'Every selected candidate already has a revealed email. Use Refresh from Apollo to fetch it again.'
            : 'Select at least one candidate to reveal contact details for.'
      });
    }
    setStatus(noAddressOnFile
      ? { type: 'info', text: `${noAddressOnFile} selected candidate${noAddressOnFile === 1 ? ' has' : 's have'} no email on file at Apollo and ${noAddressOnFile === 1 ? 'was' : 'were'} left out, so no credit is wasted on ${noAddressOnFile === 1 ? 'it' : 'them'}.` }
      : null);
    setPendingReveal(requested);
  }

  // Waterfall asks Apollo to look through third-party data sources for an
  // address it does not already hold. It is the only path that can beat Apollo's
  // own coverage, and the only asynchronous one: the addresses arrive minutes
  // later, so the request is started here and polled for below.
  function findPersonalEmails(explicitIds) {
    const ids = explicitIds || [...selected];
    const asked = idsToReveal(ids, states, enriched, { refresh: true });
    const withAddress = asked.filter((id) => enriched.get(id)?.personalEmail);
    // A waterfall that already ran to completion has its answer, and running it
    // again asks Apollo to pay vendors for the same lookup. So a candidate is
    // only sent once; a second pass is a deliberate act, not a second click.
    const eligible = asked
      .filter((id) => !enriched.get(id)?.personalEmail)
      .filter((id) => !enriched.get(id)?.waterfallChecked);
    if (!eligible.length) {
      const alreadyChecked = asked.length - withAddress.length;
      return setStatus({
        type: 'info',
        text: !ids.length
          ? 'Select at least one candidate to search other data sources for.'
          : alreadyChecked
            ? `Other data sources have already been searched for ${alreadyChecked === 1 ? 'that candidate' : `those ${alreadyChecked} candidates`} and found no personal email, so nothing was sent again and no credit was spent.`
            : 'Every selected candidate already has a personal email.'
      });
    }
    setStatus(null);
    setPendingWaterfall(eligible);
  }

  // Asks Apollo for phone numbers. The dearest thing this app can spend, so it
  // works out who would actually be charged for and then asks; nothing reaches
  // Apollo until the recruiter confirms below.
  function revealPhones(explicitIds, { refresh = false } = {}) {
    const ids = explicitIds || [...selected];
    const asked = idsToRevealPhone(ids, states, enriched, { refresh });
    // Apollo told us free, in the search response, that it holds no number for
    // these. Asking would return nothing and a mobile credit is the dearest
    // thing here, so they are dropped and the recruiter is told.
    const byId = new Map(shownList().map((candidate) => [candidate.requestedId || candidate.id, candidate]));
    const eligible = refresh
      ? asked.filter((id) => (enriched.get(id) || byId.get(id))?.hasPhoneOnFile !== false)
      : phoneWorthAsking(ids);
    const noneOnFile = asked.length - eligible.length;
    if (!eligible.length && noneOnFile) {
      return setStatus({
        type: 'info',
        text: `Apollo holds no phone number for ${noneOnFile === 1 ? 'that candidate' : `those ${noneOnFile} candidates`}, so asking would return nothing and no credit was spent.`
      });
    }
    if (!eligible.length) {
      const alreadyHave = ids.filter((id) => enriched.get(id)?.phone).length;
      const alreadyAsked = ids.filter((id) => enriched.get(id)?.phoneChecked && !enriched.get(id)?.phone).length;
      return setStatus({
        type: 'info',
        text: !ids.length
          ? 'Select at least one candidate to reveal a phone number for.'
          : alreadyHave
            ? `A number is already on screen for ${alreadyHave === 1 ? 'that candidate' : `those ${alreadyHave} candidates`}, so nothing was requested and no credit was spent.`
            : alreadyAsked
              ? `Apollo has already been asked for ${alreadyAsked === 1 ? 'that candidate' : `those ${alreadyAsked} candidates`} and holds no number, so nothing was requested again.`
              : 'Nothing to request.'
      });
    }
    setStatus(noneOnFile
      ? { type: 'info', text: `${noneOnFile} selected candidate${noneOnFile === 1 ? ' has' : 's have'} no phone number on file at Apollo and ${noneOnFile === 1 ? 'was' : 'were'} left out, so no credit is wasted on ${noneOnFile === 1 ? 'it' : 'them'}.` }
      : null);
    setPendingPhone(eligible);
  }

  function cancelPhone() {
    setPendingPhone(null);
    setStatus({ type: 'info', text: 'Phone reveal cancelled. No Apollo credits were spent.' });
  }

  async function confirmPhone() {
    const requested = pendingPhone || [];
    setPendingPhone(null);
    if (!requested.length) return;
    return runPhoneReveal(requested);
  }

  // Sends the phone request. Separate from the confirmation above so the email
  // reveal can run it as part of the same confirmed action.
  async function runPhoneReveal(requested) {
    if (!requested.length) return;

    // A phone reveal does not enrich anybody: it asks one question and answers
    // it. So each row goes back to the state it was in, whether the request
    // succeeds, finds nothing, or never reaches Apollo - claiming "enriched"
    // for a candidate nobody enriched would be a plain falsehood.
    const before = new Map(requested.map((id) => [id, stateOf(states, id)]));
    setStates((previous) => markState(previous, requested, REVEALING_PHONE));
    setLoading('phone'); setStatus(null);
    try {
      const data = await readJson(await fetch('/api/candidates/phone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: requested })
      }));

      // Whatever Apollo already held arrives at once; show it rather than
      // making the recruiter wait on the slow half for data already in hand.
      const immediate = reconcile(data.requestedIds || requested, { candidates: data.candidates, skippedIds: data.skippedIds });
      setEnriched((previous) => applyWaterfall(previous, immediate, {
        baseById: baseCandidateMap(), mark: { phoneChecked: true }
      }));
      setExpanded((previous) => new Set([...previous, ...immediate.matchedIds]));

      setStatus({ type: 'info', text: `Asking Apollo for ${requested.length} phone number${requested.length === 1 ? '' : 's'}. Numbers arrive here as Apollo returns them.` });
      await collectPhones(data.requests || [], requested, before);
    } catch (error) {
      setStates((previous) => new Map([...previous, ...before]));
      setStatus({ type: 'error', text: error.message || 'Unable to reveal phone numbers.' });
    } finally { setLoading(''); }
  }

  // Polls each outstanding phone job. Polling costs no credits, so the only
  // cost of waiting is time.
  async function collectPhones(requests, requested, before = new Map()) {
    const deadline = Date.now() + WATERFALL_MAX_WAIT_MS;
    const outstanding = [...requests];
    const baseById = baseCandidateMap();
    let found = 0;
    let expired = 0;

    while (outstanding.length && Date.now() < deadline) {
      const job = outstanding.shift();
      let result;
      try {
        result = await readJson(await fetch(`/api/candidates/waterfall/${encodeURIComponent(job.requestId)}`));
      } catch (error) {
        setStatus({ type: 'error', text: error.message || 'Unable to read the phone result.' });
        break;
      }

      if (result.status === 'pending') {
        outstanding.push(job);
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(result.retryAfterSeconds) || 10) * 1000));
        continue;
      }
      if (result.status === 'ready') {
        const outcome = reconcile(job.ids, { candidates: result.candidates, skippedIds: [] });
        setEnriched((previous) => applyWaterfall(previous, outcome, {
          baseById, checkedIds: job.ids, mark: { phoneChecked: true }
        }));
        setExpanded((previous) => new Set([...previous, ...outcome.matchedIds]));
        found += result.candidates.filter((candidate) => candidate.phone).length;
      }
      if (result.status === 'expired') expired += 1;
    }

    setStates((previous) => new Map([...previous, ...before]));
    if (found) {
      setStatus({ type: 'success', text: `Found ${found} phone number${found === 1 ? '' : 's'}.` });
    } else if (expired) {
      setStatus({ type: 'error', text: `Apollo could not return ${expired === 1 ? 'the result' : `${expired} of the results`} for this request, so it is unknown whether a number was found. Try again before spending more.` });
    } else if (outstanding.length) {
      setStatus({ type: 'info', text: 'Apollo is still working on this. Numbers were not ready in time; try again shortly.' });
    } else {
      setStatus({ type: 'info', text: 'Apollo holds no phone number for these candidates.' });
    }
  }

  function cancelWaterfall() {
    setPendingWaterfall(null);
    setStatus({ type: 'info', text: 'Search cancelled. No Apollo credits were spent.' });
  }

  async function confirmWaterfall() {
    const requested = pendingWaterfall || [];
    setPendingWaterfall(null);
    if (!requested.length) return;

    setStates((previous) => markState(previous, requested, SEARCHING_SOURCES));
    setLoading('waterfall'); setStatus(null);
    try {
      const response = await fetch('/api/candidates/waterfall', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: requested })
      });
      const data = await readJson(response);

      // Whatever Apollo already held comes back at once; show it immediately
      // rather than making the recruiter wait on the slow half.
      const immediate = reconcile(data.requestedIds || requested, { candidates: data.candidates, skippedIds: data.skippedIds });
      setEnriched((previous) => applyEnriched(previous, immediate, { contactRevealed: true }));
      setExpanded((previous) => new Set([...previous, ...immediate.matchedIds]));

      setStatus({ type: 'info', text: `Searching other data sources for ${requested.length} candidate${requested.length === 1 ? '' : 's'}. This takes a few minutes; results appear here as they arrive.` });
      await collectWaterfall(data.requests || [], requested);
    } catch (error) {
      setStates((previous) => markState(previous, requested, ENRICHED));
      setStatus({ type: 'error', text: error.message || 'Unable to search other data sources.' });
    } finally { setLoading(''); }
  }

  // Polls each outstanding request until Apollo answers, it expires, or we give
  // up. Polling costs no credits, so the only cost of waiting is time.
  async function collectWaterfall(requests, requested) {
    const deadline = Date.now() + WATERFALL_MAX_WAIT_MS;
    const outstanding = [...requests];
    // What each row already shows, so a waterfall answer - which carries only
    // the person id and whatever the vendors found - is merged over the record
    // rather than replacing it with a nameless husk.
    const baseById = baseCandidateMap();
    // Only vendors Apollo actually named, so the recruiter can be told which
    // sources were checked instead of a vague "other data sources".
    const vendorNames = new Set();
    let found = 0;
    // An expired or unrecognised job is not the same as a search that finished
    // empty, and saying so would hide a fault behind a plausible result.
    let expired = 0;
    // Addresses Apollo says it found, and how many never reached us.
    let charged = 0;
    let undelivered = 0;

    while (outstanding.length && Date.now() < deadline) {
      const job = outstanding.shift();
      let result;
      try {
        result = await readJson(await fetch(`/api/candidates/waterfall/${encodeURIComponent(job.requestId)}`));
      } catch (error) {
        setStatus({ type: 'error', text: error.message || 'Unable to read the search result.' });
        break;
      }

      if (result.status === 'pending') {
        outstanding.push(job);
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(result.retryAfterSeconds) || 10) * 1000));
        continue;
      }
      if (result.status === 'ready') {
        const outcome = reconcile(job.ids, { candidates: result.candidates, skippedIds: [] });
        // Merged, and every id in this job marked as checked: Apollo answering
        // with no record for an id is still an answer about that id, which is
        // the difference between "none found" and "never asked".
        setEnriched((previous) => applyWaterfall(previous, outcome, { baseById, checkedIds: job.ids }));
        // Open what the search found: the recruiter paid for it and waited.
        setExpanded((previous) => new Set([...previous, ...outcome.matchedIds]));
        found += result.candidates.filter((candidate) => candidate.personalEmail || candidate.emailType === 'personal').length;
        for (const vendor of result.summary?.vendors || []) {
          if (vendor?.name) vendorNames.add(vendor.name);
        }
        // Apollo counts what it found; the addresses themselves only travel in
        // the webhook POST. If that delivery failed we have been charged for
        // addresses we never received, which must not read as "found nothing".
        charged += Number(result.summary?.emailsFound) || 0;
        if (result.delivery?.status === 'failed') undelivered += Number(result.summary?.emailsFound) || 0;
      }
      if (result.status === 'expired') expired += 1;
    }

    setStates((previous) => markState(previous, requested, ENRICHED));
    if (found) {
      setStatus({ type: 'success', text: `Found ${found} personal email${found === 1 ? '' : 's'} in other data sources.` });
    } else if (undelivered) {
      setStatus({
        type: 'error',
        text: `Apollo found ${undelivered} address${undelivered === 1 ? '' : 'es'} and charged for ${undelivered === 1 ? 'it' : 'them'}, but could not deliver ${undelivered === 1 ? 'it' : 'them'} to APOLLO_WEBHOOK_URL. Point that setting at an endpoint Apollo can reach - this app serves one at /api/apollo/waterfall-webhook - and run the search again.`
      });
    } else if (expired) {
      setStatus({ type: 'error', text: `Apollo could not return ${expired === 1 ? 'the result' : `${expired} of the results`} for this search, so it is unknown whether an address was found. Try again before spending more.` });
    } else if (outstanding.length) {
      setStatus({ type: 'info', text: 'The search is still running at Apollo. Results were not ready in time; try again shortly.' });
    } else if (charged) {
      setStatus({ type: 'info', text: `Apollo searched other sources and charged for ${charged} record${charged === 1 ? '' : 's'}, but returned no personal address we could use.` });
    } else {
      // A completed search that found nothing is a valid result, not an error:
      // it is reported as information, and it names only the sources Apollo
      // said it queried.
      const checked = vendorNames.size ? ` Sources checked: ${[...vendorNames].join(', ')}.` : '';
      setStatus({ type: 'info', text: `No personal email found.${checked}` });
    }
  }

  // What each row already shows, so a sparse asynchronous answer is merged over
  // the record rather than replacing it with a husk.
  function baseCandidateMap() {
    return new Map(candidates
      .map((candidate) => [candidate.requestedId || candidate.id, candidate])
      .filter(([key]) => key));
  }

  // The subset of a selection a phone request should actually be spent on:
  // nobody already holding a number, nobody Apollo has already answered for,
  // and nobody Apollo said outright it has no number for.
  function phoneWorthAsking(ids) {
    const known = new Map(shownList().map((candidate) => [candidate.requestedId || candidate.id, candidate]));
    return idsToRevealPhone(ids, states, enriched, { refresh: false })
      .filter((id) => (enriched.get(id) || known.get(id))?.hasPhoneOnFile !== false);
  }

  function cancelReveal() {
    setPendingReveal(null);
    setStatus({ type: 'info', text: 'Reveal cancelled. No Apollo credits were spent.' });
  }

  async function confirmReveal() {
    const requested = pendingReveal || [];
    const alsoPhone = revealWithPhone;
    setPendingReveal(null);
    if (!requested.length) return;
    await runEnrichment({
      path: '/api/candidates/reveal', requested, busyKey: 'reveal', inFlightState: REVEALING,
      summarize: revealSummary, failureText: 'Unable to reveal contact details.', restoreOnError: true
    });
    // The number was asked for in the same confirmed action, so it runs without
    // a second dialog - but still only for the candidates it is worth spending
    // a mobile credit on.
    if (!alsoPhone) return;
    const forPhone = phoneWorthAsking(requested);
    if (forPhone.length) await runPhoneReveal(forPhone);
  }

  const mergedCandidates = candidates.map((candidate) => (candidate.id && enriched.get(candidate.id)) || candidate);
  const withPersonal = mergedCandidates.filter(personalEmailOf);
  const afterPersonalFilter = personalOnly
    ? mergedCandidates.filter((candidate) => !knownWithoutPersonalEmail(candidate))
    : mergedCandidates;
  const visibleCandidates = afterPersonalFilter.filter((candidate) => matchesRowQuery(candidate, localRowQuery()));
  const hiddenByRowQuery = afterPersonalFilter.length - visibleCandidates.length;
  // Apollo only reports a personal address once a reveal has run, so these three
  // counts are genuinely different things: has one, confirmed to have none, and
  // not yet asked.
  const hiddenByFilter = mergedCandidates.filter(knownWithoutPersonalEmail).length;
  // Not yet asked about contact data. Enriched-but-never-revealed counts here:
  // Apollo has told us nothing about a personal address for those.
  const unrevealed = mergedCandidates.filter((candidate) => !candidate.contactRevealed).length;
  const totalPages = total !== null && perPage ? Math.max(1, Math.ceil(total / perPage)) : null;
  const searching = loading === 'search';
  // Every enabled term, plus what is still uncommitted in the box. Joined with
  // spaces because that is how Apollo reads them: one pool that matches all of
  // them, not one per term.
  const activeSkills = skills.filter((skill) => skill.on).map((skill) => skill.term);
  const effectiveKeywords = [...activeSkills, filters.keywords.trim()].filter(Boolean).join(' ');
  const missingRequired = REQUIRED_FILTERS
    .filter((key) => (key === 'keywords' ? effectiveKeywords === '' : filters[key].trim() === ''));
  const canSearch = missingRequired.length === 0;
  const lookingUp = loading === 'lookup';
  // The pool filters that currently hold a value, named for the copy below so
  // it can say what a name search is being narrowed by instead of guessing.
  const activeFilterLabels = [
    ['jobTitle', 'role'], ['location', 'location'], ['company', 'company'],
    ['industry', 'industry'], ['seniority', 'seniority']
  ].filter(([key]) => filters[key].trim() !== '').map(([, label]) => label);
  if (effectiveKeywords) activeFilterLabels.push('skills');
  const narrowedBy = activeFilterLabels.join(', ').replace(/, ([^,]*)$/, ' and $1');
  // One identifier is enough, and a company alone is not one of them.
  const canLookup = LOOKUP_IDENTIFIERS.some((key) => lookup[key].trim() !== '');
  const resultsSummary = searchMode === 'person'
    // One matched person is not a page of a pool, so it is not counted as one.
    ? (candidates.length ? 'The person Apollo matched' : 'No person matched yet')
    : candidates.length
      ? (total !== null
        ? `Showing ${candidates.length} of ${total.toLocaleString()} profiles`
        : `Showing ${candidates.length} profiles`)
      : 'Profiles returned by Apollo';

  return <main>
    <header className="topbar"><div className="mark">A<span>/</span></div><div><p className="eyebrow">Talent intelligence</p><h1>Candidate Search</h1></div><div className="secure"><span className="dot" /> Apollo connected via secure backend</div></header>

    <form className="panel search-panel" onSubmit={searchMode === 'person' ? lookupPerson : submitSearch}>
      {/* No heading or blurb: the field labels already carry Required, so the
          copy was repeating itself. Reset keeps its place. */}
      <div className="panel-heading heading-bare">
        <button type="button" className="link-button" onClick={resetFilters}>
          {searchMode === 'person' ? 'Reset details' : 'Reset filters'}
        </button>
      </div>

      {/* Two ways in, one at a time: filter a pool, or match one person the
          recruiter already knows. */}
      <div className="mode-switch" role="radiogroup" aria-label="Search mode">
        {[['pool', 'Filter a pool'], ['person', 'Find one person']].map(([mode, label]) => <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={searchMode === mode}
          className={searchMode === mode ? 'mode-option is-on' : 'mode-option'}
          onClick={() => changeMode(mode)}
        >{label}</button>)}
      </div>

      {searchMode === 'pool' ? <>
        <div className="form-grid">
          {fields.map(([name, label, placeholder, required]) => <label key={name}>
            {label}{required && <em className="req" aria-hidden="true">Required</em>}
            <input
              name={name}
              value={filters[name]}
              onChange={updateFilter}
              // Enter or comma turns a typed skill into a term of its own. Only
              // the keywords box does this; the others are single values.
              onKeyDown={name === 'keywords' ? commitSkill : undefined}
              placeholder={name === 'keywords' ? 'e.g. Java, then Enter for each skill' : placeholder}
              // The keyword requirement can be met by a committed term instead
              // of by text in the box, so the native attribute is dropped only
              // once a term actually satisfies it. Otherwise the browser would
              // refuse to submit a form that is genuinely complete.
              required={required && (name !== 'keywords' || activeSkills.length === 0)}
              aria-required={required}
            />
          </label>)}
          <label>Seniority<select name="seniority" value={filters.seniority} onChange={updateFilter}><option value="">Any level</option><option value="entry">Entry</option><option value="junior">Junior</option><option value="mid_level">Mid-level</option><option value="senior">Senior</option><option value="manager">Manager</option><option value="director">Director</option></select></label>
        </div>
        {/* Apollo requires every keyword to match, so each term is held
            separately and can be turned off without retyping the others. */}
        <div className="skill-terms">
          <span className="skill-terms-label">Skills Apollo must match</span>
          {/* Present even when empty. Held back until the first term existed,
              the whole feature was invisible and nobody found it. */}
          {skills.length === 0 && <p className="hint">
            None yet. Type a skill in Skills / Keywords and press Enter to add it as its own term - Apollo returns only candidates matching every one, so adding them separately is what lets you drop the one that narrows the pool too far.
          </p>}
          <ul className="chips chips-editable">
            {skills.map((skill) => <li key={skill.term} className={skill.on ? 'chip-on' : 'chip-off'}>
              <button
                type="button"
                className="chip-toggle"
                aria-pressed={skill.on}
                onClick={() => toggleSkill(skill.term)}
              >{skill.term}</button>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${skill.term}`}
                onClick={() => removeSkill(skill.term)}
              >&times;</button>
            </li>)}
          </ul>
          {skills.length > 0 && <p className="hint">
            {activeSkills.length > 1
              ? `Apollo will return only candidates matching all ${activeSkills.length}: ${activeSkills.join(' + ')}.`
              : 'Add another skill to narrow the pool, or turn one off to widen it.'}
          </p>}
        </div>

        {/* What each query actually returned. Nothing here sends a request; it
            is the record of searches already run. */}
        {refineTrail.length > 1 && <div className="refine-trail">
          <span className="skill-terms-label">Pool size as you narrowed</span>
          <ol>
            {refineTrail.map((entry, index) => <li key={`${entry.keywords}-${index}`} className={entry.total ? '' : 'is-empty'}>
              <b>{entry.total.toLocaleString()}</b> <span>{entry.keywords || 'no skills'}</span>
            </li>)}
          </ol>
        </div>}

        <label className="filter-toggle search-scope">
          <input type="checkbox" checked={verifiedEmailOnly} onChange={() => setVerifiedEmailOnly(!verifiedEmailOnly)} />
          Only candidates Apollo has an email for
        </label>
        <button type="submit" className="primary" disabled={searching || !canSearch}>{searching ? 'Searching candidates...' : 'Search Candidates'} <span>→</span></button>
        {!canSearch && <p className="hint">Still needed: {missingRequired.map((key) => FIELD_LABELS[key]).join(', ')}.</p>}
      </> : <>
        <div className="form-grid">
          {lookupFields.map(([name, label, placeholder]) => <label key={name}>
            {label}
            <input
              name={name}
              value={lookup[name]}
              onChange={updateLookup}
              placeholder={placeholder}
              type={name === 'email' ? 'email' : 'text'}
              inputMode={name === 'email' ? 'email' : undefined}
            />
          </label>)}
        </div>
        <button type="submit" className="primary" disabled={lookingUp || !canLookup}>{lookingUp ? 'Looking this person up...' : 'Find this person'} <span>→</span></button>
        {/* The cost is stated where the click happens. A lookup is one person,
            so it is capped by Apollo's endpoint rather than by a confirmation
            step, and it never asks for contact data. */}
        <p className="hint">
          {canLookup
            ? 'Asks Apollo to match one person and may spend one enrichment credit. It does not ask for a personal email or a phone number - reveal those separately once the person is on screen.'
            : 'Give at least one of name, email address or LinkedIn URL. A company on its own is not a person.'}
        </p>
      </>}
    </form>

    {(status || searching || candidates.length > 0) && <section className="results">
      <div className="results-head">
        <div><span className="step">02</span><div><h3>Candidate results</h3><p>{resultsSummary}</p></div></div>
        <div className="selection-actions">
          <label className="filter-toggle">
            <input
              type="checkbox"
              checked={personalOnly}
              onChange={() => setPersonalOnly(!personalOnly)}
              disabled={!candidates.length}
            />
            Personal email only ({withPersonal.length})
          </label>
          <span>Selected: <b>{selected.size}</b></span>
          <button type="button" onClick={selectAll} disabled={!candidates.length}>Select all</button>
          <button type="button" onClick={clearSelection} disabled={!selected.size}>Clear</button>
          <button type="button" className="reveal" onClick={() => findPersonalEmails()} disabled={!selected.size || Boolean(loading)}>
            {loading === 'waterfall' ? 'Searching other sources...' : 'Find personal emails'}
          </button>
          <button type="button" className="reveal" onClick={() => reveal()} disabled={!selected.size || Boolean(loading)}>
            {loading === 'reveal' ? 'Revealing email...' : `Reveal email${selected.size ? ` (${selected.size})` : ''}`}
          </button>
          <button type="button" className="reveal" onClick={() => revealPhones()} disabled={!selected.size || Boolean(loading)}>
            {loading === 'phone' ? 'Revealing phone...' : `Reveal phone${selected.size ? ` (${selected.size})` : ''}`}
          </button>
          <button type="button" className="secondary" onClick={() => enrich()} disabled={!selected.size || Boolean(loading)}>
            {loading === 'enrich' ? 'Enriching selected candidates...' : `Enrich selected${selected.size ? ` (${selected.size})` : ''}`} <span>↗</span>
          </button>
        </div>
      </div>

      {(candidates.length > 0 || filters.personName) && <div className="row-search">
        <label>
          Find a candidate
          <input
            type="search"
            value={rowQuery}
            onChange={(event) => setRowQuery(event.target.value)}
            // Enter runs the same whole-pool search as the button, because that
            // is what pressing Enter in a search box is expected to do.
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); searchWholePoolByName(); } }}
            placeholder="Name, company, job title or address"
          />
        </label>
        {/* Both scopes are legitimate, so the choice is stated before the
            search rather than decided for the recruiter. */}
        {activeFilterLabels.length > 0 && <label className="filter-toggle name-scope">
          <input
            type="checkbox"
            checked={nameWithFilters}
            onChange={() => setNameWithFilters(!nameWithFilters)}
            disabled={searching}
          />
          Also narrow the name search by {narrowedBy}
        </label>}

        <div className="row-search-actions">
          <button
            type="button"
            className="reveal"
            onClick={searchWholePoolByName}
            disabled={searching || rowQuery.trim() === ''
              || (rowQuery.trim() === filters.personName && nameWithFilters === appliedNameScope)}
          >
            {searching && rowQuery.trim() === filters.personName
              ? 'Searching Apollo by name...'
              : nameWithFilters && activeFilterLabels.length
                ? `Search by name within ${narrowedBy}`
                : 'Search all of Apollo by name'}
          </button>
          {filters.personName && <button type="button" className="link-button" onClick={clearNameFilter} disabled={searching}>
            Clear name filter
          </button>}
        </div>

        {filters.personName && <p className="hint">
          <strong>
            {appliedNameScope && narrowedBy
              ? `Showing people named "${filters.personName}" who also match your ${narrowedBy}.`
              : `Showing everyone in Apollo named "${filters.personName}".`}
          </strong>{' '}
          {total !== null ? `${total.toLocaleString()} profile${total === 1 ? '' : 's'} match. ` : ''}
          {appliedNameScope && narrowedBy
            ? 'Untick the box above and search again to see everyone with that name.'
            : narrowedBy
              ? `Your ${narrowedBy} filters are not applied. Tick the box above and search again to narrow it.`
              : ''}
        </p>}

        {rowQuery.trim() !== '' && rowQuery.trim() !== filters.personName && <p className="hint">
          {visibleCandidates.length
            ? `${visibleCandidates.length} of ${afterPersonalFilter.length} loaded row${afterPersonalFilter.length === 1 ? '' : 's'} on this page match.`
            : `Nothing on this page matches "${rowQuery.trim()}".`}
          {' '}{nameWithFilters && narrowedBy
            ? `Searching by name looks through all of Apollo for that name, narrowed by your ${narrowedBy}.`
            : 'Searching by name looks through all of Apollo for that name, ignoring every other filter.'}
          {hiddenByRowQuery > 0 ? ' Hidden rows are never selected by Select all.' : ''}
        </p>}
      </div>}

      {pendingWaterfall && <div className="notice confirm" role="alertdialog" aria-label="Confirm searching other data sources">
        <p>
          <strong>This searches other data sources and spends Apollo credits.</strong>{' '}
          {`Looking for a personal email for ${pendingWaterfall.length} candidate${pendingWaterfall.length === 1 ? '' : 's'}. Apollo charges per address it finds, and results take a few minutes to arrive.`}
        </p>
        <div className="confirm-actions">
          <button type="button" className="reveal" onClick={confirmWaterfall}>
            {`Search other sources for ${pendingWaterfall.length} candidate${pendingWaterfall.length === 1 ? '' : 's'}`}
          </button>
          <button type="button" className="link-button" onClick={cancelWaterfall}>Cancel</button>
        </div>
      </div>}

      {pendingPhone && <div className="notice confirm" role="alertdialog" aria-label="Confirm phone number reveal">
        <p>
          <strong>This spends Apollo mobile credits, which cost more than an email.</strong>{' '}
          {pendingPhone.length > PHONE_LIMIT
            ? `${pendingPhone.length} candidates are selected. Apollo will be asked for the first ${PHONE_LIMIT}; the remaining ${pendingPhone.length - PHONE_LIMIT} are left for a second batch.`
            : `Asking Apollo for a phone number for ${pendingPhone.length} candidate${pendingPhone.length === 1 ? '' : 's'}.`}{' '}
          {(() => {
            // Apollo's free has_direct_phone signal, so the recruiter knows how
            // many of these it has already said yes to before paying.
            const known = new Map(mergedCandidates.map((candidate) => [candidate.requestedId || candidate.id, candidate]));
            const confirmed = pendingPhone.filter((id) => known.get(id)?.hasPhoneOnFile === true).length;
            return confirmed
              ? `Apollo says it holds a direct number for ${confirmed} of them. `
              : 'Apollo has not confirmed in advance that it holds a number for any of them. ';
          })()}
          Apollo returns numbers asynchronously, so they arrive here a little after the request.
        </p>
        <div className="confirm-actions">
          <button type="button" className="reveal" onClick={confirmPhone}>
            {`Reveal ${Math.min(pendingPhone.length, PHONE_LIMIT)} phone number${Math.min(pendingPhone.length, PHONE_LIMIT) === 1 ? '' : 's'}`}
          </button>
          <button type="button" className="link-button" onClick={cancelPhone}>Cancel</button>
        </div>
      </div>}

      {pendingReveal && <div className="notice confirm" role="alertdialog" aria-label="Confirm Apollo credit spend">
        <p>
          <strong>This spends Apollo credits.</strong>{' '}
          {pendingReveal.length > REVEAL_LIMIT
            ? `${pendingReveal.length} candidates are selected. Apollo will be asked for the first ${REVEAL_LIMIT}, costing up to ${REVEAL_LIMIT} credits. The remaining ${pendingReveal.length - REVEAL_LIMIT} are left for a second batch.`
            : `Revealing contact details for ${pendingReveal.length} candidate${pendingReveal.length === 1 ? '' : 's'} costs up to ${pendingReveal.length} credit${pendingReveal.length === 1 ? '' : 's'}.`}
        </p>
        {/* Email and phone are priced separately at Apollo, so the number is
            opt-in - but it is offered here, because "reveal the contact
            details" is one action to a recruiter and hunting for a second
            button is how the phone got missed. */}
        {(() => {
          const forPhone = phoneWorthAsking(pendingReveal);
          const confirmed = forPhone.filter((id) => {
            const known = new Map(mergedCandidates.map((candidate) => [candidate.requestedId || candidate.id, candidate]));
            return known.get(id)?.hasPhoneOnFile === true;
          }).length;
          if (!forPhone.length) {
            return <p className="hint">This asks for email addresses only. Apollo holds no phone number to ask for on {pendingReveal.length === 1 ? 'this candidate' : 'these candidates'}.</p>;
          }
          return <label className="filter-toggle name-scope">
            <input type="checkbox" checked={revealWithPhone} onChange={() => setRevealWithPhone(!revealWithPhone)} />
            Also ask for a phone number for {forPhone.length} of {pendingReveal.length}
            {confirmed ? ` (Apollo confirms a direct number for ${confirmed})` : ''} - extra mobile credits, which cost more than an email
          </label>;
        })()}

        <div className="confirm-actions">
          <button type="button" className="reveal" onClick={confirmReveal}>
            {`Spend up to ${Math.min(pendingReveal.length, REVEAL_LIMIT)} credit${Math.min(pendingReveal.length, REVEAL_LIMIT) === 1 ? '' : 's'}`}
            {revealWithPhone ? ' plus mobile' : ''}
          </button>
          <button type="button" className="link-button" onClick={cancelReveal}>Cancel</button>
        </div>
      </div>}

      {status && <div className={`notice ${status.type}`} role="status" aria-live="polite">{status.text}</div>}

      {searching && !candidates.length && <SkeletonRows />}

      {personalOnly && <p className="hint">
        {`${withPersonal.length} candidate${withPersonal.length === 1 ? ' has' : 's have'} a personal email.`}
        {hiddenByFilter > 0 && ` ${hiddenByFilter} hidden - Apollo returned no personal address for ${hiddenByFilter === 1 ? 'that one' : 'those'}.`}
        {unrevealed > 0 && ` ${unrevealed} not checked yet - revealing asks Apollo whether it holds a personal address, it does not mean one exists.`}
      </p>}

      {candidates.length > 0 && visibleCandidates.length > 0 && <div className="table">
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
            busy={Boolean(loading)}
            onToggle={() => toggle(id)}
            onExpand={() => toggleExpanded(id)}
            onRetry={() => enrich([id], { refresh: true })}
            onRefresh={() => enrich([id], { refresh: true })}
            onReveal={() => reveal([id])}
          />;
        })}
      </div>}

      {searchMode === 'pool' && candidates.length > 0 && <div className="pagination">
        <button type="button" onClick={() => search(page - 1)} disabled={page <= 1 || searching}>← Previous</button>
        <span>Page <b>{page}</b>{totalPages ? ` of ${totalPages.toLocaleString()}` : ''}</span>
        <button type="button" onClick={() => search(page + 1)} disabled={searching || (totalPages ? page >= totalPages : candidates.length === 0)}>Next →</button>
      </div>}
    </section>}

    <footer>Results and profile links are supplied by Apollo. LinkedIn profiles are never visited or scraped by this application.</footer>
  </main>;
}

export { NOT_ENRICHED, ENRICHING, ENRICHED, FAILED };
