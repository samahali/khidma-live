import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Status, resetStore, submitRequest, startReview, returnForInfo, withdrawRequest, listRequestsByCitizen } from '../src/requests.js';
import { handleRequest, errorResponse, startServer, checkSameMachine } from '../src/server.js';

beforeEach(() => resetStore());

const c1 = { citizenId: 'c1', serviceId: 'birth-certificate' };
const json = (value) => JSON.stringify(value);
const post = (path, body) => handleRequest({ method: 'POST', path, rawBody: json(body) });
const get = (path) => handleRequest({ method: 'GET', path });

// --- One test per route ------------------------------------------------------

test('POST /requests submits a request and returns 201', () => {
  const res = post('/requests', c1);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, Status.SUBMITTED);
  assert.match(res.body.referenceNumber, /^KH-\d{4}-\d{6}$/);
});

test('POST /requests/:id/withdraw withdraws the citizen\'s own request', () => {
  const r = submitRequest(c1);
  const res = post(`/requests/${r.id}/withdraw`, { citizenId: 'c1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, Status.WITHDRAWN);
});

test('POST /requests/:id/resubmit puts a NEEDS_INFO request back in SUBMITTED', () => {
  const r = submitRequest(c1);
  startReview(r.id, 'reviewer-1');
  returnForInfo(r.id, 'reviewer-1', 'Attach a copy of your ID');
  const res = post(`/requests/${r.id}/resubmit`, { citizenId: 'c1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, Status.SUBMITTED);
});

test('list, withdraw, list, submit again over HTTP shows WITHDRAWN and allows the new request (#1)', () => {
  const created = post('/requests', c1);
  assert.equal(get('/citizens/c1/requests').body[0].status, Status.SUBMITTED);
  assert.equal(post(`/requests/${created.body.id}/withdraw`, { citizenId: 'c1' }).status, 200);
  assert.equal(get('/citizens/c1/requests').body[0].status, Status.WITHDRAWN);
  assert.equal(post('/requests', c1).status, 201);
});

test('GET /requests/:id returns the request', () => {
  const r = submitRequest(c1);
  const res = get(`/requests/${r.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, r.id);
});

test('GET /requests/by-reference/:ref returns the request', () => {
  const r = submitRequest(c1);
  const res = get(`/requests/by-reference/${r.referenceNumber}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, r.id);
});

test('GET /citizens/:citizenId/requests lists that citizen\'s requests', () => {
  submitRequest(c1);
  submitRequest({ citizenId: 'c1', serviceId: 'passport' });
  submitRequest({ citizenId: 'c2', serviceId: 'passport' });
  const res = get('/citizens/c1/requests');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.ok(res.body.every((r) => r.citizenId === 'c1'));
});

// --- One test per error family -----------------------------------------------

test('DUPLICATE_REQUEST returns 409 with code, message, and referenceNumber', () => {
  const first = submitRequest(c1);
  const res = post('/requests', c1);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'DUPLICATE_REQUEST');
  assert.equal(res.body.referenceNumber, first.referenceNumber);
  assert.match(res.body.message, /already has an open request/);
});

test('NOT_REQUEST_OWNER returns 403 with code, message, and referenceNumber', () => {
  const r = submitRequest(c1);
  const res = post(`/requests/${r.id}/withdraw`, { citizenId: 'someone-else' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NOT_REQUEST_OWNER');
  assert.equal(res.body.referenceNumber, r.referenceNumber);
});

test('REVIEWER_AT_CAPACITY and NOT_ASSIGNED_REVIEWER map to 409 and 403 with reviewerId', () => {
  const capacity = Object.assign(new Error('Reviewer r1 already has 5 requests under review'), {
    code: 'REVIEWER_AT_CAPACITY',
    reviewerId: 'r1',
  });
  const notAssigned = Object.assign(new Error('Reviewer r2 is not assigned to request KH-2026-000001'), {
    code: 'NOT_ASSIGNED_REVIEWER',
    reviewerId: 'r2',
  });
  assert.deepEqual(errorResponse(capacity), {
    status: 409,
    body: { code: 'REVIEWER_AT_CAPACITY', message: capacity.message, reviewerId: 'r1' },
  });
  assert.deepEqual(errorResponse(notAssigned), {
    status: 403,
    body: { code: 'NOT_ASSIGNED_REVIEWER', message: notAssigned.message, reviewerId: 'r2' },
  });
});

test('an unknown future error code returns 409 and keeps the code', () => {
  const res = errorResponse(Object.assign(new Error('Some new rule'), { code: 'FUTURE_RULE' }));
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'FUTURE_RULE');
});

test('a validation error from the module returns 400', () => {
  const res = post('/requests', {});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.equal(res.body.message, 'citizenId is required');
});

test('a state error from the module returns 409', () => {
  const r = submitRequest(c1);
  withdrawRequest(r.id, 'c1');
  const res = post(`/requests/${r.id}/withdraw`, { citizenId: 'c1' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'INVALID_STATE');
  assert.equal(res.body.message, 'Cannot withdraw a request in WITHDRAWN');
});

test('a not-found error from the module returns 404', () => {
  const res = get('/requests/no-such-id');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
  assert.equal(res.body.message, 'Request no-such-id not found');
});

test('anything that is not a plain Error returns 500 without leaking the message', () => {
  assert.equal(errorResponse(new TypeError('cannot read properties of undefined')).status, 500);
  assert.equal(errorResponse('a string').status, 500);
  assert.deepEqual(errorResponse(new TypeError('secret')).body, {
    code: 'INTERNAL_ERROR',
    message: 'Internal error',
  });
});

test('malformed JSON returns 400 before the module is called', () => {
  const res = handleRequest({ method: 'POST', path: '/requests', rawBody: '{not json' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MALFORMED_JSON');
});

test('a path segment that is not valid URL encoding returns 400', () => {
  const res = get('/requests/%E0%A4%A');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'MALFORMED_PATH');
});

test('an unknown route returns 404', () => {
  const res = get('/nothing/here');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
});

test('a wrong method returns 405 with an Allow header', () => {
  const res = handleRequest({ method: 'DELETE', path: '/requests' });
  assert.equal(res.status, 405);
  assert.equal(res.body.code, 'METHOD_NOT_ALLOWED');
  assert.equal(res.headers.Allow, 'POST');
});

// --- One socket round trip ---------------------------------------------------

test('startServer binds to 127.0.0.1 and serves one round trip', async () => {
  const server = await startServer({ port: 0 });
  after(() => server.close());
  const { address, port } = server.address();
  assert.equal(address, '127.0.0.1');
  const res = await fetch(`http://127.0.0.1:${port}/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: json(c1),
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = await res.json();
  assert.equal(body.status, Status.SUBMITTED);
  await new Promise((resolve) => server.close(resolve));
});

// --- Same-machine guard (#2) -------------------------------------------------

const local = { host: '127.0.0.1:3000' };
const jsonType = { 'content-type': 'application/json' };
/** @param {{ body: unknown } | null} res */
const codeOf = (res) => (res ? /** @type {{ code?: string }} */ (res.body).code : undefined);

test('same-machine guard allows 127.0.0.1 and localhost with the server port', () => {
  assert.equal(checkSameMachine({ method: 'GET', port: 3000, headers: local }), null);
  assert.equal(checkSameMachine({ method: 'GET', port: 3000, headers: { host: 'LOCALHOST:3000' } }), null);
  assert.equal(
    checkSameMachine({ method: 'POST', port: 3000, headers: { ...local, ...jsonType, origin: 'http://localhost:3000' } }),
    null,
  );
});

test('same-machine guard rejects a foreign, missing, or wrong-port Host with 421', () => {
  for (const headers of [{ host: 'attacker.example' }, {}, { host: '127.0.0.1:4000' }, { host: '127.0.0.1' }]) {
    const res = checkSameMachine({ method: 'GET', port: 3000, headers });
    assert.equal(res?.status, 421);
    assert.equal(codeOf(res), 'MISDIRECTED_REQUEST');
  }
});

test('same-machine guard rejects a foreign Origin with 403', () => {
  for (const origin of ['http://attacker.example', 'null', 'https://127.0.0.1:3000', 'http://127.0.0.1:4000']) {
    const res = checkSameMachine({ method: 'POST', port: 3000, headers: { ...local, ...jsonType, origin } });
    assert.equal(res?.status, 403);
    assert.equal(codeOf(res), 'FORBIDDEN_ORIGIN');
  }
});

test('same-machine guard rejects a POST that is not application/json with 415', () => {
  for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const headers = type === undefined ? local : { ...local, 'content-type': type };
    const res = checkSameMachine({ method: 'POST', port: 3000, headers });
    assert.equal(res?.status, 415);
    assert.equal(codeOf(res), 'UNSUPPORTED_MEDIA_TYPE');
  }
  assert.equal(
    checkSameMachine({ method: 'POST', port: 3000, headers: { ...local, 'content-type': 'application/json; charset=utf-8' } }),
    null,
  );
});

/**
 * Send one raw request so the test can set a Host header (fetch cannot).
 * @param {number} port
 * @param {{ method: string, path: string, headers: Record<string, string>, body?: string }} options
 * @returns {Promise<{ status: number, body: any }>}
 */
function rawRequest(port, { method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('the server rejects the cross-site requests from #2 before they reach a route', async () => {
  const server = await startServer({ port: 0 });
  after(() => server.close());
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const created = submitRequest(c1);

  const crossSitePost = await rawRequest(port, {
    method: 'POST',
    path: '/requests',
    headers: { Host: 'attacker.example', Origin: 'http://attacker.example', 'Content-Type': 'text/plain' },
    body: json({ citizenId: 'c2', serviceId: 's1' }),
  });
  assert.equal(crossSitePost.status, 421);

  const reboundRead = await rawRequest(port, {
    method: 'GET',
    path: `/requests/by-reference/${created.referenceNumber}`,
    headers: { Host: 'attacker.example' },
  });
  assert.equal(reboundRead.status, 421);
  assert.equal(reboundRead.body.code, 'MISDIRECTED_REQUEST');

  const foreignOrigin = await rawRequest(port, {
    method: 'POST',
    path: '/requests',
    headers: { Host: `127.0.0.1:${port}`, Origin: 'http://attacker.example', 'Content-Type': 'application/json' },
    body: json({ citizenId: 'c2', serviceId: 's1' }),
  });
  assert.equal(foreignOrigin.status, 403);

  const textPlain = await rawRequest(port, {
    method: 'POST',
    path: '/requests',
    headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'text/plain' },
    body: json({ citizenId: 'c2', serviceId: 's1' }),
  });
  assert.equal(textPlain.status, 415);

  assert.deepEqual(listRequestsByCitizen('c2'), [], 'no rejected request reached the module');
  await new Promise((resolve) => server.close(resolve));
});
