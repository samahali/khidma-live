// @ts-check
// Khidma — local HTTP shell over the request lifecycle module.
//
// The server owns no business rules. Every handler passes its input straight
// to src/requests.js and maps the result, or the thrown error, to an HTTP
// status and a JSON body. Handlers are pure functions (request in, status plus
// body out) so the node:http listener below is a thin adapter over them.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  submitRequest,
  withdrawRequest,
  resubmitRequest,
  getRequest,
  getRequestByReference,
  listRequestsByCitizen,
  startReview,
  returnForInfo,
  decide,
} from './requests.js';

/**
 * @typedef {{ method: string, path: string, rawBody?: string }} ShellRequest
 * @typedef {{ status: number, body: unknown, headers?: Record<string, string>, text?: string }} ShellResponse
 *   `text`, when set, is written as the raw response body instead of JSON.
 * @typedef {(params: Record<string, string>, body: any) => ShellResponse} RouteHandler
 * @typedef {{ method: string, pattern: RegExp, handle: RouteHandler }} Route
 * @typedef {import('./requests.js').CodedError} CodedError
 */

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = '127.0.0.1';

// --- Error mapping -----------------------------------------------------------

/**
 * HTTP status per business-rule error code raised by src/requests.js.
 * An unknown future code falls back to 409.
 * @type {Record<string, number>}
 */
const CODE_STATUS = Object.freeze({
  DUPLICATE_REQUEST: 409,
  REVIEWER_AT_CAPACITY: 409,
  NOT_REQUEST_OWNER: 403,
  NOT_ASSIGNED_REVIEWER: 403,
});

/** Code used in the body when the module error carries none. */
const STATUS_CODE = Object.freeze({
  400: 'VALIDATION_ERROR',
  404: 'NOT_FOUND',
  409: 'INVALID_STATE',
  500: 'INTERNAL_ERROR',
});

/**
 * Map one thrown value to an HTTP response.
 *
 * | Thrown value                                   | Status |
 * |------------------------------------------------|--------|
 * | Error with a known `code`                      | table above |
 * | Error with an unknown `code`                   | 409 |
 * | Plain Error whose message ends in `not found`  | 404 |
 * | Plain Error whose message starts with `Cannot` | 409 |
 * | Any other plain Error                          | 400 |
 * | Anything else (TypeError, string, ...)         | 500 |
 *
 * "Plain" means constructed with `Error` itself. A TypeError or RangeError is
 * a bug in the shell, not a module rule, so it reports as 500.
 * @param {unknown} error
 * @returns {ShellResponse}
 */
export function errorResponse(error) {
  if (!(error instanceof Error) || error.constructor !== Error) {
    return { status: 500, body: { code: STATUS_CODE[500], message: 'Internal error' } };
  }
  const coded = /** @type {CodedError} */ (error);
  let status;
  if (typeof coded.code === 'string') {
    status = CODE_STATUS[coded.code] ?? 409;
  } else if (coded.message.endsWith('not found')) {
    status = 404;
  } else if (coded.message.startsWith('Cannot')) {
    status = 409;
  } else {
    status = 400;
  }
  /** @type {{ code: string, message: string, referenceNumber?: string, reviewerId?: string }} */
  const body = {
    code: coded.code ?? STATUS_CODE[/** @type {keyof typeof STATUS_CODE} */ (status)],
    message: coded.message,
  };
  if (coded.referenceNumber !== undefined) body.referenceNumber = coded.referenceNumber;
  if (coded.reviewerId !== undefined) body.reviewerId = coded.reviewerId;
  return { status, body };
}

// --- Static screen files ------------------------------------------------------

/**
 * Headers on every static file. The CSP allows scripts, styles, and fetches
 * from this server only, and forbids framing by another page.
 */
const STATIC_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
});

/**
 * The fixed allow-list of screen files. Each file path is built from this
 * module's URL, never from the request, and the files are read once at load.
 * @type {ReadonlyMap<string, { contentType: string, text: string }>}
 */
const STATIC_FILES = new Map(
  [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/citizen.js', 'citizen.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ].map(([path, file, contentType]) => [
    path,
    { contentType, text: readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8') },
  ]),
);

/**
 * Serve one allow-listed file. GET and HEAD only; the listener drops the body
 * for HEAD.
 * @param {string} method
 * @param {string} pathname
 * @returns {ShellResponse | null} null when the path is not a static file
 */
function staticResponse(method, pathname) {
  const file = STATIC_FILES.get(pathname);
  if (!file) return null;
  if (method !== 'GET' && method !== 'HEAD') {
    return {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
      body: { code: 'METHOD_NOT_ALLOWED', message: `${method} is not allowed on ${pathname}` },
    };
  }
  return {
    status: 200,
    headers: { ...STATIC_HEADERS, 'Content-Type': file.contentType },
    body: null,
    text: file.text,
  };
}

// --- Routes ------------------------------------------------------------------

/**
 * Citizen-path routes and reviewer action routes. Each handler passes the
 * body straight to the module; the reviewer queue and load routes wait for
 * the ac1-6 exports.
 * @type {Route[]}
 */
const ROUTES = [
  {
    method: 'POST',
    pattern: /^\/requests$/,
    handle: (_params, body) => ({ status: 201, body: submitRequest(body) }),
  },
  {
    method: 'GET',
    pattern: /^\/requests\/by-reference\/(?<referenceNumber>[^/]+)$/,
    handle: (params) => ({ status: 200, body: getRequestByReference(params.referenceNumber) }),
  },
  {
    method: 'GET',
    pattern: /^\/requests\/(?<id>[^/]+)$/,
    handle: (params) => ({ status: 200, body: getRequest(params.id) }),
  },
  {
    method: 'POST',
    pattern: /^\/requests\/(?<id>[^/]+)\/withdraw$/,
    handle: (params, body) => ({ status: 200, body: withdrawRequest(params.id, body.citizenId) }),
  },
  {
    method: 'POST',
    pattern: /^\/requests\/(?<id>[^/]+)\/resubmit$/,
    handle: (params, body) => ({ status: 200, body: resubmitRequest(params.id, body.citizenId) }),
  },
  {
    method: 'GET',
    pattern: /^\/citizens\/(?<citizenId>[^/]+)\/requests$/,
    handle: (params) => ({ status: 200, body: listRequestsByCitizen(params.citizenId) }),
  },
  {
    method: 'POST',
    pattern: /^\/requests\/(?<id>[^/]+)\/start-review$/,
    handle: (params, body) => ({ status: 200, body: startReview(params.id, body.reviewerId) }),
  },
  {
    method: 'POST',
    pattern: /^\/requests\/(?<id>[^/]+)\/return$/,
    handle: (params, body) => ({ status: 200, body: returnForInfo(params.id, body.reviewerId, body.note) }),
  },
  {
    method: 'POST',
    pattern: /^\/requests\/(?<id>[^/]+)\/decide$/,
    // decide() takes no reviewer id yet. Any caller can decide; see the slice exclude list.
    handle: (params, body) => ({ status: 200, body: decide(params.id, body.decision) }),
  },
];

/**
 * Parse the request body. An empty body is an empty object so handlers can
 * destructure it. Malformed JSON is a server-raised 400.
 * @param {string | undefined} rawBody
 * @returns {{ ok: true, body: any } | { ok: false, response: ShellResponse }}
 */
function parseBody(rawBody) {
  if (rawBody === undefined || rawBody.trim() === '') return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(rawBody) ?? {} };
  } catch {
    return {
      ok: false,
      response: { status: 400, body: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON' } },
    };
  }
}

/**
 * Route one request to its handler. Pure: no I/O, no shared state beyond the
 * module store that src/requests.js owns.
 * @param {ShellRequest} request
 * @returns {ShellResponse}
 */
export function handleRequest({ method, path, rawBody }) {
  const pathname = path.split('?')[0];
  const screen = staticResponse(method, pathname);
  if (screen) return screen;
  /** @type {string[]} */
  const allowed = [];
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    if (route.method !== method) {
      allowed.push(route.method);
      continue;
    }
    const parsed = parseBody(rawBody);
    if (!parsed.ok) return parsed.response;
    const params = decodeParams(match.groups ?? {});
    if (params === null) {
      return { status: 400, body: { code: 'MALFORMED_PATH', message: 'Path segment is not valid URL encoding' } };
    }
    try {
      return route.handle(params, parsed.body);
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (allowed.length > 0) {
    return {
      status: 405,
      headers: { Allow: allowed.join(', ') },
      body: { code: 'METHOD_NOT_ALLOWED', message: `${method} is not allowed on ${pathname}` },
    };
  }
  return { status: 404, body: { code: 'NOT_FOUND', message: `No route for ${method} ${pathname}` } };
}

/**
 * Decode path parameters. Returns null when a segment is not valid URL
 * encoding, so the caller can answer 400 instead of 500.
 * @param {Record<string, string>} groups
 * @returns {Record<string, string> | null}
 */
function decodeParams(groups) {
  /** @type {Record<string, string>} */
  const out = {};
  try {
    for (const [key, value] of Object.entries(groups)) out[key] = decodeURIComponent(value);
  } catch {
    return null;
  }
  return out;
}

// --- Same-machine guard --------------------------------------------------------

/** Host names that mean "this machine". The server binds to loopback only. */
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost']);

/**
 * Reject a request that did not come from a page or client on this machine.
 * The loopback bind alone does not stop a browser: a page from another site
 * can send a "simple" POST without a CORS preflight, and a DNS-rebound page
 * reaches the server under a foreign Host name. Transport rule only; the
 * module still owns every business rule.
 *
 * | Check                                              | Status |
 * |----------------------------------------------------|--------|
 * | Host is not 127.0.0.1:<port> or localhost:<port>   | 421    |
 * | Origin is present and is not http://<allowed host> | 403    |
 * | POST whose Content-Type is not application/json    | 415    |
 *
 * @param {{ method: string, port: number, headers: Record<string, string | string[] | undefined> }} request
 * @returns {ShellResponse | null} the rejection, or null when the request may continue
 */
export function checkSameMachine({ method, port, headers }) {
  const allowedHosts = LOOPBACK_HOSTS.map((name) => `${name}:${port}`);
  const host = String(headers.host ?? '').toLowerCase();
  if (!allowedHosts.includes(host)) {
    return {
      status: 421,
      body: { code: 'MISDIRECTED_REQUEST', message: 'Host must be 127.0.0.1 or localhost with the server port' },
    };
  }
  const origin = headers.origin;
  if (origin !== undefined && !allowedHosts.some((h) => String(origin).toLowerCase() === `http://${h}`)) {
    return { status: 403, body: { code: 'FORBIDDEN_ORIGIN', message: 'Requests from other sites are not allowed' } };
  }
  if (method === 'POST') {
    const mediaType = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return {
        status: 415,
        body: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'POST requests need Content-Type: application/json' },
      };
    }
  }
  return null;
}

// --- node:http adapter -------------------------------------------------------

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function listener(req, res) {
  /** @type {ShellResponse} */
  let response;
  const method = req.method ?? 'GET';
  const rejection = checkSameMachine({ method, port: req.socket.localPort ?? 0, headers: req.headers });
  if (rejection) {
    // Answer before reading the body, and do not keep the connection.
    req.resume();
    res.writeHead(rejection.status, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify(rejection.body));
    return;
  }
  try {
    const rawBody = await readBody(req);
    response = handleRequest({ method, path: req.url ?? '/', rawBody });
  } catch (error) {
    response = errorResponse(error);
  }
  // JSON.stringify(undefined) is undefined; send an empty body rather than throw.
  const payload = response.text ?? JSON.stringify(response.body) ?? '';
  res.writeHead(response.status, {
    'Content-Type': 'application/json',
    ...(response.headers ?? {}),
    'Content-Length': String(Buffer.byteLength(payload)),
  });
  res.end(method === 'HEAD' ? undefined : payload);
}

/**
 * Start the server. Binds to loopback by default so only this machine can
 * reach the demo. Port 0 asks the OS for a free port.
 * @param {{ port?: number, host?: string }} [options]
 * @returns {Promise<http.Server>}
 */
export function startServer({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  const server = http.createServer(listener);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const rawPort = process.env.PORT;
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT must be a whole number from 0 to 65535, got "${rawPort}"`);
    process.exit(1);
  }
  startServer({ port })
    .then((server) => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      console.log(`Khidma demo server listening on http://${address.address}:${address.port}`);
      console.log('Fictional demo. In-memory store. No sign-in. State resets on restart.');
    })
    .catch((/** @type {NodeJS.ErrnoException} */ error) => {
      const reason = error.code === 'EADDRINUSE' ? `port ${port} is already in use` : error.message;
      console.error(`Khidma demo server could not start: ${reason}`);
      process.exit(1);
    });
}
