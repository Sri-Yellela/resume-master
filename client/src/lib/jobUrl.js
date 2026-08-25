// client/src/lib/jobUrl.js
//
// AH2: the address of a single job detail, in ONE place.
//
// The detail panel used to be React state with no URL at all, so nothing could link to a job and
// two details could not be open at once. Giving it an address means two sides have to agree on that
// address — JobCard writes the href, JobsPanel reads the param back — and two spellings of "job"
// would be a link that opens the board and nothing else. So neither side spells it.
//
// A query param on the existing console route rather than a new path segment: /app/jobs is already
// the board's route, and /app/jobs/<id> did not work (App.jsx redirects any routeKey that is not a
// known panel back to the bare board). ?job= composes with the board's other URL state instead of
// competing with a route table.

export const JOB_URL_PARAM = "job";

const CONSOLE_PATH = "/app/jobs";

/** The shareable address of one job's detail view, or null when there is no id to name. */
export function jobDetailHref(jobId) {
  if (!jobId) return null;
  return `${CONSOLE_PATH}?${JOB_URL_PARAM}=${encodeURIComponent(jobId)}`;
}

/** The job id a location is asking for, or null. Accepts a search string or defaults to this tab's. */
export function jobIdFromSearch(search) {
  const raw = search ?? (typeof window === "undefined" ? "" : window.location.search);
  try { return new URLSearchParams(raw).get(JOB_URL_PARAM) || null; }
  catch { return null; }
}
