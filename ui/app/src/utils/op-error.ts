// Copyright OBSESC Authors
//
// describeOpError — the last stop between a thrown JavaScript value and a
// human.
//
// `useAsyncOp` settles a failed run with `String(e)`, which is the right thing
// for the hook to capture: it is the verbatim truth and it is the same string
// whatever the runner threw. It is NOT the right thing to RENDER. On the 9 TB
// drive the needle box answered a failed search with, in full:
//
//     ✗ failed after 0.1s
//     TypeError: Failed to fetch
//
// which names a JavaScript class, not a fault, and tells the operator nothing
// they can act on — "Failed to fetch" is what the browser says for a node that
// is down, a proxy that is not routing, a CORS refusal, a TLS failure and a
// connection dropped mid-flight, all four indistinguishable from inside the
// page. So this module maps what we captured onto what we can honestly SAY:
//
//   headline — what failed, in the operator's terms, never a class name.
//   advice   — what to try next. Absent rather than invented: a wrong next
//              step costs more than no next step.
//   detail   — the verbatim underlying text, kept and rendered small, because
//              it is what gets pasted into an ops channel. It is never the
//              whole message and never the headline.
//
// Server-composed text passes through VERBATIM. The node writes honest,
// specific microcopy on its 4xx/5xx bodies ("range exceeds the retention
// horizon (90 days)"), and re-wording it here would be this UI inventing a
// diagnosis on top of one it was given.

export interface OpError {
  /** One line: what failed. Never a JavaScript class name. */
  headline: string;
  /** What to try next, or `null` when we genuinely do not know. */
  advice: string | null;
  /** Verbatim underlying text for the ops channel; `null` when it would
   *  merely repeat the headline. */
  detail: string | null;
}

/**
 * Every way a browser says "the request never completed". They are not
 * distinguishable from script, which is exactly why the copy for them names
 * the possibilities instead of picking one.
 */
const UNREACHABLE_RE = /failed to fetch|networkerror|network error|load failed|err_connection|fetch failed/i;

/** `<status>: <server body>` — how every runner in Explore throws an HTTP failure. */
const HTTP_RE = /^(\d{3}):\s*([\s\S]*)$/;

/** Our own loud schema-drift throws already read as prose; they start this way. */
const OUR_PROSE_RE = /^(GET|POST|PUT|DELETE|\d{3} from) /;

function statusCopy(status: number, body: string, what: string): OpError {
  const server = body.trim();
  const detail = server === '' ? null : server;
  switch (status) {
    case 400:
      return {
        headline: `The node would not accept this ${what} request.`,
        advice: 'Its reason is below verbatim — it is usually the token or the time range.',
        detail,
      };
    case 401:
    case 403:
      return {
        headline: `Not authorised to run this ${what}.`,
        advice: 'Sign in again, or ask an operator for a role that permits reads on this node.',
        detail,
      };
    case 404:
      return {
        headline: `This node has no endpoint for ${what}.`,
        advice: 'It predates this feature, or something between the browser and it is rewriting the path.',
        detail,
      };
    case 429:
      return {
        headline: `The node is shedding load and refused this ${what}.`,
        advice: 'Wait for the current work to drain and try again — nothing was lost.',
        detail,
      };
    case 503:
      return {
        headline: `The node is up but cannot answer a ${what} yet.`,
        advice: 'The raw tier or the catalog is not configured on it, or it is still starting.',
        detail,
      };
    default:
      if (status >= 500) {
        return {
          headline: `The node failed while answering this ${what}.`,
          advice: 'Its own error is below; the node log will carry the matching span.',
          detail,
        };
      }
      return { headline: `The ${what} was refused (HTTP ${status}).`, advice: null, detail };
  }
}

/**
 * `raw` is whatever `AsyncOpState.error` holds — always a string, because the
 * hook stringifies. `what` names the operation in the surrounding copy's voice
 * ("needle search", "grep", "query"), and is used inside the sentence, so it
 * is lower case and singular.
 */
export function describeOpError(raw: string, what: string): OpError {
  const text = raw.trim();
  if (text === '') {
    return { headline: `The ${what} failed, and nothing said why.`, advice: null, detail: null };
  }

  // `String(e)` on an Error gives "TypeError: Failed to fetch"; the class
  // prefix is noise, so it never survives into the headline.
  const message = text.replace(/^[A-Za-z]*Error:\s*/, '');

  if (UNREACHABLE_RE.test(message)) {
    return {
      headline: `Could not reach the node, so the ${what} never ran.`,
      advice:
        'The request left the browser and nothing came back. Check the node is up and that /obsesc-api is reachable ' +
        'from this page — a stopped node, a proxy or load balancer with no healthy target, and a TLS or CORS refusal ' +
        'all look identical from here.',
      detail: null,
    };
  }

  const http = HTTP_RE.exec(message);
  if (http !== null) {
    return statusCopy(Number(http[1]), http[2] ?? '', what);
  }

  if (OUR_PROSE_RE.test(message)) {
    // A schema-drift throw. It already says what is wrong and which endpoint,
    // in this codebase's voice — re-wording it would only blur it.
    return { headline: message, advice: null, detail: null };
  }

  return {
    headline: `The ${what} failed before it could return a result.`,
    advice: null,
    detail: message,
  };
}
