import React, { useEffect, useRef, useState } from 'react';
import {
  ENRICHED, ENRICHING, FAILED, NOT_ENRICHED, REVEALING, REVEALING_PHONE,
  applyEnriched, applyStates, applyWaterfall, enrichmentLabel, enrichmentSummary, idsToEnrich, idsToReveal,
  idsToRevealPhone, markState, reconcile, revealSummary, stateOf
} from './enrichment.js';

// personName is not one of the form fields: it is driven by the results search
// box, because that is where a recruiter is when they realise the person they
// want is on one of the other pages.
const initialFilters = { jobTitle: '', location: '', seniority: '', keywords: '', personName: '' };
// Role, skills and location are required; the rest narrow an already
// meaningful search. Apollo bills for every search, so a query without these
// three is not worth sending.
// Location, plus a role or at least one skill. Skills were compulsory, which
// forced the most destructive filter onto every search.
const REQUIRED_FILTERS = ['location'];
const REQUIRED_EITHER = ['jobTitle', 'keywords'];
// Fields holding a comma-separated list, shown as removable chips so the search
// reads as a list rather than as punctuation.
const MULTI_VALUE_FIELDS = ['keywords', 'location'];

// Commas, not spaces: "Machine Learning" is one skill. De-duplicated to match
// what the server sends Apollo, so a value typed twice is one filter and not
// two identical chips fighting over the same React key.
function splitList(value) {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}
const fields = [
  ['jobTitle', 'Role / Job Title', 'e.g. Data Scientist', false],
  ['location', 'Location', 'e.g. Hyderabad, Bangalore, Pune', true],
  ['keywords', 'Skills', 'e.g. Python, LLM, Machine Learning', false],
];

// Company and Industry were here and are gone, both measured against the live
// API rather than judged by eye:
//
//   organization_names is ignored outright - "Infosys", "Tata Consultancy
//   Services" and "zzz-does-not-exist" all returned the same 21,081 as no
//   filter at all, so the field could never do anything.
//
//   organization_industries works only for Apollo's own taxonomy names:
//   "computer software" 10,086 and "banking" 569, but "information technology"
//   and "staffing and recruiting" both 0. As free text it was a way to empty a
//   search with no explanation, the same trap the junior seniority was. It
//   could come back as a validated dropdown; as a text box it could not.

const FIELD_LABELS = Object.fromEntries(fields.map(([name, label]) => [name, label.toLowerCase()]));

// How many past queries to keep in the refine trail. Enough to see which skill
// narrowed the pool, short enough not to become a wall of numbers.
const REFINE_TRAIL_LENGTH = 6;

// The seniority levels a technical hire actually sits at, measured against the
// live API for python developer, java developer and data scientist in one city:
//
//   entry 209/514/917 · senior 15/72/438 · manager 7/16/146 · intern 2/1/2
//   head, director, partner 0/0/0 · vp, c_suite, owner, founder 0-6
//
// Apollo's remaining levels are its sales-prospecting tiers and return nothing
// for engineering titles, so offering them is a way to get an empty result.
// "junior" and "mid_level" were offered here and are not Apollo values at all -
// picking either took any search to zero with no explanation.
const SENIORITIES = [
  ['intern', 'Intern'],
  ['entry', 'Entry'],
  ['senior', 'Senior'],
  ['manager', 'Manager']
];

// Suggested job titles, each verified against the live API to return a real
// pool rather than nothing. Offered as suggestions, not as the only choices:
// Apollo knows thousands of titles, and the field still takes anything typed
// into it - including several separated by commas, which Apollo ORs.
const ROLE_SUGGESTIONS = [
  'Software Engineer', 'Full Stack Developer', 'Backend Developer', 'Frontend Developer',
  'Python Developer', 'Java Developer', 'Android Developer', 'iOS Developer',
  'Data Scientist', 'Data Engineer', 'AI/ML Engineer', 'Machine Learning Engineer',
  'DevOps Engineer', 'Cloud Engineer', 'QA Engineer', 'Test Engineer',
  'UI/UX Designer', 'Business Analyst', 'Project Manager', 'Product Manager',
  'HR Executive', 'Sales Executive'
];

// Skills worth suggesting for each role, every one measured against the live
// API for a real pool in one city rather than guessed at. The number after each
// is what Apollo held for it alone:
//
//   java 835 · aws 717 · azure 663 · sql 530 · python 297 · react 131 ·
//   angular 92 · machine learning 381 · data science 510 · llm 25 ·
//   devops 3125 · automation 2218 · testing 575 · sales 10678 · agile 359
//
// Skills that returned nothing at all - tensorflow and figma among them - are
// deliberately absent: suggesting one is handing over an empty search. The
// field still takes anything typed into it.
const SKILLS_BY_ROLE = {
  'software engineer': ['java', 'python', 'sql', 'aws', 'javascript', 'agile'],
  'full stack developer': ['javascript', 'react', 'angular', 'java', 'sql', 'aws'],
  'backend developer': ['java', 'python', 'sql', 'spring boot', 'aws'],
  'frontend developer': ['javascript', 'react', 'angular', 'typescript'],
  'python developer': ['python', 'django', 'sql', 'aws', 'machine learning'],
  'java developer': ['java', 'spring boot', 'sql', 'aws'],
  'android developer': ['android', 'java', 'kotlin'],
  'ios developer': ['ios', 'swift'],
  'data scientist': ['python', 'machine learning', 'data science', 'sql', 'deep learning', 'nlp'],
  'data engineer': ['sql', 'python', 'aws', 'azure', 'data science'],
  'ai/ml engineer': ['machine learning', 'python', 'deep learning', 'llm', 'nlp'],
  'machine learning engineer': ['machine learning', 'python', 'deep learning', 'llm', 'nlp'],
  'devops engineer': ['devops', 'aws', 'azure', 'kubernetes', 'jenkins', 'terraform'],
  'cloud engineer': ['aws', 'azure', 'kubernetes', 'devops'],
  'qa engineer': ['testing', 'automation', 'selenium', 'agile'],
  'test engineer': ['testing', 'automation', 'selenium'],
  'ui/ux designer': ['user experience', 'agile'],
  'business analyst': ['business analysis', 'sql', 'data analysis', 'agile', 'excel'],
  'project manager': ['project management', 'agile'],
  'product manager': ['product management', 'agile'],
  'hr executive': ['recruitment', 'communication'],
  'sales executive': ['sales', 'communication', 'salesforce']
};

// Shown when no role is chosen, or a role nothing is mapped for.
const COMMON_SKILLS = ['python', 'java', 'sql', 'aws', 'machine learning', 'testing', 'agile'];

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
function PersonalEmailStatus({ candidate }) {
  const personal = personalEmailOf(candidate);
  if (personal) return <a href={`mailto:${personal}`}>{personal}</a>;
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
function showPersonalLine(candidate) {
  if (candidate.emailType === 'personal') return false;
  return Boolean(candidate.personalEmail) || Boolean(candidate.waterfallChecked);
}

// Matches a row against the name the recruiter typed. Name only: the box exists
// to find one candidate, and matching companies or job titles as well meant a
// company name could pull up people the recruiter was not looking for.
function matchesRowQuery(candidate, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return typeof candidate.name === 'string' && candidate.name.toLowerCase().includes(needle);
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
      {showPersonalLine(candidate) && <DetailField label="Personal email">
        <PersonalEmailStatus candidate={candidate} />
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
        {(candidate.matchedSkills || []).length > 0 && <ul className="matched-skills">
          {candidate.matchedSkills.map((skill) => <li key={skill}>{skill}</li>)}
        </ul>}
      </div>
      <div data-label="Company">{valueOrUnavailable(candidate.company)}</div>
      <div data-label="Location">{valueOrUnavailable(candidate.location)}</div>
      <div className="contact" data-label="Contact">
        <ContactLine label={emailLabel(candidate)}><ContactValue value={candidate.email} available={candidate.emailAvailable} href={candidate.email ? `mailto:${candidate.email}` : undefined} /></ContactLine>
        {showPersonalLine(candidate) && <ContactLine label="Personal">
          <PersonalEmailStatus candidate={candidate} />
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
    {expanded && (state === ENRICHED || state === REVEALING || state === REVEALING_PHONE) && candidate.enriched
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
  // Apollo exposes no personal-email signal before a reveal, so this filters
  // what has already come back rather than narrowing the search.
  // Every search asks Apollo for candidates whose address it rates verified or
  // likely to engage. It is not a choice the recruiter has to make: an
  // unreachable candidate cannot be contacted and cannot be revealed, so the
  // wider pool was only ever a way to fill the table with dead ends. The
  // backend still accepts the flag, so widening stays one line away.
  const verifiedEmailOnly = true;
  // Narrows the rows already on screen. Purely local: it sends nothing to
  // Apollo, so it costs nothing and cannot reach past the loaded page.
  const [rowQuery, setRowQuery] = useState('');
  // What each query actually returned, so the effect of adding a skill is
  // visible instead of guessed. This is only ever appended to by a search the
  // recruiter asked for; nothing here triggers a request.
  const [refineTrail, setRefineTrail] = useState([]);
  // What Apollo said for each skill on the last search, so the results can say
  // which skills were asked about and how big each one's pool was.
  const [lastSkillTotals, setLastSkillTotals] = useState([]);
  const [matchedAll, setMatchedAll] = useState(false);
  // Whether the next search asks for every skill or any of them. Off by
  // default: "any" finds people, "all" is Apollo's AND and finds almost nobody.
  const [matchAllSkills, setMatchAllSkills] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const roleFieldRef = useRef(null);
  const skillFieldRef = useRef(null);

  function updateFilter(event) { setFilters({ ...filters, [event.target.name]: event.target.value }); }

  // Promotes what is typed in the results box into Apollo's own name filter, so
  // the search covers every page instead of the one in hand. It is an explicit
  // action rather than something typing triggers: each one is a real request.
  function searchWholePoolByName() {
    const personName = rowQuery.trim();
    // The same name is the search already on screen.
    if (!personName || personName === filters.personName) return;
    setFilters({ ...filters, personName });
    search(1, { personName });
  }

  function clearNameFilter() {
    setRowQuery('');
    setFilters({ ...filters, personName: '' });
    search(1, { personName: '' });
  }

  // One role is the normal case, so a pick replaces the field rather than
  // adding to it. Several titles still work by typing them with commas, which
  // Apollo ORs - the picker just does not build that list for you.
  function chooseRole(role) {
    setFilters({ ...filters, jobTitle: role });
    setRolesOpen(false);
  }

  useEffect(() => {
    if (!rolesOpen && !skillsOpen) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!roleFieldRef.current?.contains(event.target)) setRolesOpen(false);
      if (!skillFieldRef.current?.contains(event.target)) setSkillsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [rolesOpen, skillsOpen]);

  // Skills do accumulate, unlike the role: a search asks about several of them,
  // and each one is its own Apollo request.
  function chooseSkill(skill) {
    const parts = filters.keywords.split(',');
    parts[parts.length - 1] = parts.length > 1 ? ` ${skill}` : skill;
    setFilters({ ...filters, keywords: `${parts.join(',')}, ` });
    setSkillsOpen(false);
  }

  // Drops one location and leaves the others alone. Locations are held as the
  // text the recruiter typed, so this rewrites that text rather than a list.
  // Drops one value from a comma-separated field and leaves the rest alone.
  // Both multi-value fields are held as the text the recruiter typed, so this
  // rewrites that text rather than a list.
  function removeValue(field, value) {
    const kept = splitList(filters[field]).filter((entry) => entry !== value);
    setFilters({ ...filters, [field]: kept.join(', ') });
  }

  function resetFilters() {
    setFilters(initialFilters);
    setRefineTrail([]);
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
    // Select all reads this, so a row hidden by the search box is never
    // selected and never quietly paid for.
    return merged.filter((candidate) => matchesRowQuery(candidate, localRowQuery()));
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
    // The committed terms plus whatever is still in the box, so a skill the
    // recruiter typed but did not press Enter on is not silently dropped.
    if (personName) {
      // Location is dropped, and only location. Measured against the live API:
      // a name alone returns tens of thousands of people in unrelated roles,
      // role and skills narrow that to a handful of real matches, and adding
      // location takes it to nothing - because Apollo returns no location on a
      // search row, so a name filtered by one matches almost no record it has.
      return { ...filters, keywords: filters.keywords, location: '', personName };
    }
    return { ...filters, ...overrides, keywords: filters.keywords, personName: '' };
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
      body: JSON.stringify({ ...query, page: nextPage, verifiedEmailOnly, matchAllSkills })
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
      setLastSkillTotals(data.skillTotals || []);
      setMatchedAll(data.matchedAllSkills === true);
      // Recorded so the recruiter can see which term narrowed the pool and by
      // how much, rather than having to remember the last count.
      const total = typeof data.total === 'number' ? data.total : data.candidates.length;
      // Only pool searches belong here: the trail is a record of narrowing by
      // skill, which a name search does not do. Repeating the same query is not
      // new information either, so an identical entry replaces the last one.
      if (!query.personName) {
        // Recorded with the filters that distinguish it: the same keywords at a
        // different seniority or email scope is a different query, and showing
        // both as bare keywords made the trail read as a contradiction.
        const entry = { keywords, seniority: query.seniority, total };
        setRefineTrail((previous) => {
          const last = previous[previous.length - 1];
          if (last && last.keywords === entry.keywords && last.seniority === entry.seniority
            && last.total === entry.total) return previous;
          return [...previous, entry].slice(-REFINE_TRAIL_LENGTH);
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
            ? nameNarrowedBy
              ? `Nobody named "${query.personName}" matches your ${nameNarrowedBy}. Clear a filter and search the name again, or try a different spelling.`
              : `Apollo has nobody by the name "${query.personName}". Try a different spelling, or just the first or last name on its own.`
            : terms.length > 1
              ? `No candidates match all ${terms.length} keywords at once - Apollo requires every one of them. ${lastHit ? `"${lastHit.keywords}" matched ${lastHit.total.toLocaleString()}. ` : ''}Turn a skill off and search again.`
              : 'No matching candidates found.'
        });
      }
    } catch (error) { setStatus({ type: 'error', text: error.message || 'Unable to connect to Apollo. Please try again.' }); }
    finally { setLoading(''); }
  }

  function submitSearch(event) {
    event.preventDefault();
    // Apollo bills for every search, so refuse one that cannot be meaningful.
    if (!canSearch) {
      return setStatus({ type: 'error', text: 'A location is required, along with a role or at least one skill.' });
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
  async function runEnrichment({ path, requested, busyKey, inFlightState, summarize, failureText, restoreOnError = false, notice = '' }) {
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
      setStatus({ type: outcome.failed ? 'info' : 'success', text: [notice, summarize(outcome)].filter(Boolean).join(' ') });
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
    // Sent on the click that asked for it. The cost is on the button, so a
    // second click would only have repeated what was already on screen.
    return runEnrichment({
      path: '/api/candidates/reveal', requested, busyKey: 'reveal', inFlightState: REVEALING,
      summarize: revealSummary, failureText: 'Unable to reveal contact details.', restoreOnError: true,
      notice: noAddressOnFile
        ? `${noAddressOnFile} selected candidate${noAddressOnFile === 1 ? ' has' : 's have'} no email on file at Apollo and ${noAddressOnFile === 1 ? 'was' : 'were'} left out, so no credit is wasted on ${noAddressOnFile === 1 ? 'it' : 'them'}.`
        : ''
    });
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
    return runPhoneReveal(eligible.slice(0, PHONE_LIMIT), noneOnFile
      ? `${noneOnFile} selected candidate${noneOnFile === 1 ? ' has' : 's have'} no phone number on file at Apollo and ${noneOnFile === 1 ? 'was' : 'were'} left out, so no credit is wasted on ${noneOnFile === 1 ? 'it' : 'them'}.`
      : '');
  }

  // Sends the phone request. Separate from the confirmation above so the email
  // reveal can run it as part of the same confirmed action.
  async function runPhoneReveal(requested, notice = '') {
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

      setStatus({ type: 'info', text: [notice, `Asking Apollo for ${requested.length} phone number${requested.length === 1 ? '' : 's'}. Numbers arrive here as Apollo returns them.`].filter(Boolean).join(' ') });
      await collectPhones(data.requests || [], requested, before, notice);
    } catch (error) {
      setStates((previous) => new Map([...previous, ...before]));
      setStatus({ type: 'error', text: error.message || 'Unable to reveal phone numbers.' });
    } finally { setLoading(''); }
  }

  // Polls each outstanding phone job. Polling costs no credits, so the only
  // cost of waiting is time.
  async function collectPhones(requests, requested, before = new Map(), notice = '') {
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
      setStatus({ type: 'success', text: [notice, `Found ${found} phone number${found === 1 ? '' : 's'}.`].filter(Boolean).join(' ') });
    } else if (expired) {
      setStatus({ type: 'error', text: `Apollo could not return ${expired === 1 ? 'the result' : `${expired} of the results`} for this request, so it is unknown whether a number was found. Try again before spending more.` });
    } else if (outstanding.length) {
      setStatus({ type: 'info', text: 'Apollo is still working on this. Numbers were not ready in time; try again shortly.' });
    } else {
      setStatus({ type: 'info', text: 'Apollo holds no phone number for these candidates.' });
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

  const mergedCandidates = candidates.map((candidate) => (candidate.id && enriched.get(candidate.id)) || candidate);
  const visibleCandidates = mergedCandidates.filter((candidate) => matchesRowQuery(candidate, localRowQuery()));
  const hiddenByRowQuery = mergedCandidates.length - visibleCandidates.length;
  const totalPages = total !== null && perPage ? Math.max(1, Math.ceil(total / perPage)) : null;
  const searching = loading === 'search';
  // Every enabled term, plus what is still uncommitted in the box. Joined with
  // spaces because that is how Apollo reads them: one pool that matches all of
  // them, not one per term.
  const locations = splitList(filters.location);
  const missingRequired = REQUIRED_FILTERS
    .filter((key) => (key === 'location' ? locations.length === 0 : filters[key].trim() === ''));
  if (REQUIRED_EITHER.every((key) => filters[key].trim() === '')) missingRequired.push('jobTitle');
  const canSearch = missingRequired.length === 0;
  // What the two spending buttons would cost right now. Shown on the buttons
  // themselves, so the figure that used to need a confirmation dialog is
  // simply on screen.
  // Only the titles that match what is being typed, and never one already
  // chosen, so the list shortens as the recruiter narrows instead of staying a
  // wall of twenty-two.
  const typedRole = filters.jobTitle.split(',').pop().trim().toLowerCase();
  // A field holding exactly one of the suggestions means a role was picked, not
  // typed, so the whole list comes back: filtering it down to the single title
  // already chosen left no way to browse to a different one.
  const rolePicked = ROLE_SUGGESTIONS.some((role) => role.toLowerCase() === typedRole);
  // Skills suggested for the roles actually chosen, in the order the roles were
  // given, so a search for two roles offers both their skills.
  const roleSkills = [...new Set(splitList(filters.jobTitle)
    .flatMap((role) => SKILLS_BY_ROLE[role.trim().toLowerCase()] || []))];
  const typedSkill = filters.keywords.split(',').pop().trim().toLowerCase();
  const chosenSkills = splitList(filters.keywords).map((skill) => skill.toLowerCase());
  const skillMatches = (roleSkills.length ? roleSkills : COMMON_SKILLS)
    .filter((skill) => !chosenSkills.includes(skill.toLowerCase()))
    .filter((skill) => !typedSkill || skill.toLowerCase().includes(typedSkill));
  const roleMatches = ROLE_SUGGESTIONS
    .filter((role) => !typedRole || rolePicked || role.toLowerCase().includes(typedRole));

  const selectedIds = [...selected];
  const emailCost = Math.min(idsToReveal(selectedIds, states, enriched).length, REVEAL_LIMIT);
  const phoneIds = phoneWorthAsking(selectedIds).slice(0, PHONE_LIMIT);
  const phoneConfirmed = phoneIds.filter((id) => {
    const known = candidates.find((candidate) => (candidate.requestedId || candidate.id) === id);
    return (enriched.get(id) || known)?.hasPhoneOnFile === true;
  }).length;
  // The pool filters that currently hold a value, named for the copy below so
  // it can say what a name search is being narrowed by instead of guessing.
  const activeFilterLabels = [['jobTitle', 'role'], ['location', 'location'], ['seniority', 'seniority']]
    .filter(([key]) => filters[key].trim() !== '').map(([, label]) => label);
  if (filters.keywords.trim()) activeFilterLabels.push('skills');
  const narrowedBy = activeFilterLabels.join(', ').replace(/, ([^,]*)$/, ' and $1');
  // A name search never applies location, so the copy must not claim it does.
  const nameNarrowedBy = activeFilterLabels.filter((label) => label !== 'location')
    .join(', ').replace(/, ([^,]*)$/, ' and $1');
  const skillTotals = lastSkillTotals;
  const resultsSummary = candidates.length
    ? (total !== null
      ? `Showing ${candidates.length} of ${total.toLocaleString()} profiles`
      // A union of several skill searches has no single total Apollo can give,
      // so the per-skill counts are shown instead of an invented number.
      : skillTotals.length > 1
        ? `${candidates.length} candidates matching any of ${skillTotals.length} skills`
        : `Showing ${candidates.length} profiles`)
    : 'Profiles returned by Apollo';

  return <main>
    <header className="topbar">
      {/* Swap the logo by replacing public/neutara-logo.svg — no code change. */}
      <img className="mark" src="/neutara-mark.svg" alt="neutara" width="29" height="40" />
      <div><p className="eyebrow">Talent intelligence</p><h1>Candidate Search</h1></div>
      <p className="secure"><span className="dot" /> Apollo connected</p>
    </header>

    <form className="panel search-panel" onSubmit={submitSearch}>
      {/* No heading or blurb: the field labels already carry Required, so the
          copy was repeating itself. Reset keeps its place. */}
      <div className="panel-heading heading-bare">
        <button type="button" className="link-button" onClick={resetFilters}>
          Reset filters
        </button>
      </div>

      <div className="form-grid">
          {fields.map(([name, label, placeholder, required]) => <div
            className="field"
            key={name}
            ref={name === 'jobTitle' ? roleFieldRef : name === 'keywords' ? skillFieldRef : undefined}
          >
            <label htmlFor={`field-${name}`}>
              {label}{required && <em className="req" aria-hidden="true">Required</em>}
            </label>
            <input
              id={`field-${name}`}
              name={name}
              value={filters[name]}
              onChange={updateFilter}
              placeholder={placeholder}
              required={required}
              aria-required={required}
              autoComplete="off"
              onFocus={name === 'jobTitle' ? () => setRolesOpen(true)
                : name === 'keywords' ? () => setSkillsOpen(true) : undefined}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                if (name === 'jobTitle') setRolesOpen(false);
                if (name === 'keywords') setSkillsOpen(false);
              }}
              role={name === 'jobTitle' || name === 'keywords' ? 'combobox' : undefined}
              aria-expanded={name === 'jobTitle' ? rolesOpen : name === 'keywords' ? skillsOpen : undefined}
              aria-controls={name === 'jobTitle' ? 'role-suggestions' : name === 'keywords' ? 'skill-suggestions' : undefined}
            />
            {MULTI_VALUE_FIELDS.includes(name) && splitList(filters[name]).length > 0
              && <ul className={`chips chips-editable ${name === 'location' ? 'location-chips' : 'skill-chips'}`}>
                {splitList(filters[name]).map((value) => <li key={value} className="chip-on">
                  <span className="chip-static">{value}</span>
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label={`Remove ${value}`}
                    onClick={() => removeValue(name, value)}
                  >&times;</button>
                </li>)}
              </ul>}
            {name === 'keywords' && <>
              <button
                type="button"
                className="role-toggle"
                aria-label={skillsOpen ? 'Hide suggested skills' : 'Show suggested skills'}
                aria-expanded={skillsOpen}
                onClick={() => setSkillsOpen(!skillsOpen)}
              >&#9662;</button>
              {skillsOpen && skillMatches.length > 0 && <ul className="role-list" id="skill-suggestions" role="listbox">
                {roleSkills.length > 0 && <li className="role-list-note">
                  Suggested for {splitList(filters.jobTitle).join(' and ')}
                </li>}
                {skillMatches.map((skill) => <li key={skill}>
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    onMouseDown={(event) => { event.preventDefault(); chooseSkill(skill); }}
                  >{skill}</button>
                </li>)}
              </ul>}
            </>}
            {name === 'jobTitle' && <>
              <button
                type="button"
                className="role-toggle"
                aria-label={rolesOpen ? 'Hide suggested roles' : 'Show suggested roles'}
                aria-expanded={rolesOpen}
                onClick={() => setRolesOpen(!rolesOpen)}
              >&#9662;</button>
              {rolesOpen && roleMatches.length > 0 && <ul className="role-list" id="role-suggestions" role="listbox">
                {roleMatches.map((role) => <li key={role}>
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    // Chosen on mousedown: a click would blur the field and
                    // close the list before the selection landed.
                    onMouseDown={(event) => { event.preventDefault(); chooseRole(role); }}
                  >{role}</button>
                </li>)}
              </ul>}
            </>}
          </div>)}
          <div className="field">
            <label htmlFor="field-seniority">Seniority</label>
            <select id="field-seniority" name="seniority" value={filters.seniority} onChange={updateFilter}>
              <option value="">Any level</option>
              {SENIORITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
        </div>
        {/* Apollo requires every keyword to match, so each term is held
            separately and can be turned off without retyping the others. */}
        {splitList(filters.keywords).length > 1 && <label className="filter-toggle skills-mode">
          <input
            type="checkbox"
            checked={matchAllSkills}
            onChange={() => setMatchAllSkills(!matchAllSkills)}
          />
          Candidate must have every skill, not just one
        </label>}

        {/* What each query actually returned. Nothing here sends a request; it
            is the record of searches already run. */}
        {refineTrail.length > 1 && <div className="refine-trail">
          <span className="trail-label">Pool size as you narrowed</span>
          <ol>
            {refineTrail.map((entry, index) => <li key={`${entry.keywords}-${index}`} className={entry.total ? '' : 'is-empty'}>
              <b>{entry.total.toLocaleString()}</b> <span>{entry.keywords || 'no skills'}</span>{' '}
              {entry.seniority && <em>{entry.seniority}</em>}
            </li>)}
          </ol>
        </div>}

        <div className="search-actions">
          <button type="submit" className="primary" disabled={searching || !canSearch}>
            {searching ? 'Searching...' : 'Search Candidates'} <span>→</span>
          </button>
          {!canSearch && <p className="hint">A location is required, along with a role or at least one skill.</p>}
        </div>
    </form>

    {(status || searching || candidates.length > 0) && <section className="results">
      <div className="results-head">
        <div><span className="step">02</span><div><h3>Candidate results</h3><p>{resultsSummary}</p></div></div>
        <div className="selection-actions">
          <span>Selected: <b>{selected.size}</b></span>
          <button type="button" onClick={selectAll} disabled={!candidates.length}>Select all</button>
          <button type="button" onClick={clearSelection} disabled={!selected.size}>Clear</button>
          <button type="button" className="reveal" onClick={() => reveal()} disabled={!selected.size || Boolean(loading)}>
            {loading === 'reveal'
              ? 'Revealing email...'
              : `Reveal email${emailCost ? ` - ${emailCost} credit${emailCost === 1 ? '' : 's'}` : ''}`}
          </button>
          <button type="button" className="reveal" onClick={() => revealPhones()} disabled={!selected.size || Boolean(loading)}>
            {loading === 'phone'
              ? 'Revealing phone...'
              : `Reveal phone${phoneIds.length ? ` - ${phoneIds.length} mobile credit${phoneIds.length === 1 ? '' : 's'}` : ''}`}
          </button>
          <button type="button" className="secondary" onClick={() => enrich()} disabled={!selected.size || Boolean(loading)}>
            {loading === 'enrich' ? 'Enriching selected candidates...' : `Enrich selected${selected.size ? ` (${selected.size})` : ''}`} <span>↗</span>
          </button>
        </div>
      </div>

      {matchedAll && <p className="hint spend-note">
        Every skill was required at once, so each of these candidates has all of{' '}
        <b>{skillTotals[0]?.skill}</b>. Untick the box above to see candidates who
        have any one of them instead.
      </p>}

      {!matchedAll && skillTotals.length > 1 && <p className="hint spend-note">
        Each skill was searched separately and the answers merged, so a candidate
        needs only one of them. Apollo held{' '}
        {skillTotals.map((entry, index) => <span key={entry.skill}>
          {index > 0 ? ', ' : ''}<b>{(entry.total || 0).toLocaleString()}</b> for {entry.skill}
        </span>)}.
      </p>}

      {/* The one thing a price cannot say: whether Apollo has actually
          committed to holding a number for these people. */}
      {phoneIds.length > 0 && <p className="hint spend-note">
        {phoneConfirmed
          ? `Apollo confirms a direct number for ${phoneConfirmed} of the ${phoneIds.length} selected. Mobile credits cost more than an email.`
          : `Apollo has not confirmed it holds a number for ${phoneIds.length === 1 ? 'the selected candidate' : 'any of the selected candidates'} - revealing may return nothing. Mobile credits cost more than an email.`}
      </p>}

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
            placeholder={searching && rowQuery.trim() === filters.personName
              ? 'Searching Apollo...'
              : 'Candidate name - press Enter to search all of Apollo'}
          />
          {filters.personName && <button type="button" className="link-button" onClick={clearNameFilter} disabled={searching}>
            Clear name
          </button>}
        </label>

        {filters.personName && <p className="hint">
          <strong>Named "{filters.personName}"</strong>
          {nameNarrowedBy ? `, matching your ${nameNarrowedBy}` : ' , anywhere in Apollo'}
          {total !== null ? ` - ${total.toLocaleString()} profile${total === 1 ? '' : 's'}.` : '.'}
          {filters.location.trim() ? ' Location is not applied to a name search.' : ''}
        </p>}

        {rowQuery.trim() !== '' && rowQuery.trim() !== filters.personName && <p className="hint">
          {visibleCandidates.length
            ? `${visibleCandidates.length} of ${mergedCandidates.length} name${mergedCandidates.length === 1 ? '' : 's'} on this page match.`
            : `No name on this page matches "${rowQuery.trim()}".`}
          {' '}{nameNarrowedBy
            ? `Press Enter to search all of Apollo for that name, narrowed by your ${nameNarrowedBy}.`
            : 'Press Enter to search all of Apollo for that name.'}
          {hiddenByRowQuery > 0 ? ' Hidden rows are never selected by Select all.' : ''}
        </p>}
      </div>}

      {status && <div className={`notice ${status.type}`} role="status" aria-live="polite">{status.text}</div>}

      {searching && !candidates.length && <SkeletonRows />}

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
