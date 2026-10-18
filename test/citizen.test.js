import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STATUS_LABELS,
  statusMarker,
  formatTime,
  renderHistory,
  renderRequest,
  renderRequestList,
  errorText,
  toDom,
  callApi,
  boot,
} from '../src/public/citizen.js';
import { Status, resetStore, submitRequest, startReview, returnForInfo } from '../src/requests.js';
import { handleRequest } from '../src/server.js';

const AT = '2026-10-18T09:30:00.000Z';

/** A record in the given status, with a return note in its history. */
const recordIn = (status) => ({
  id: `id-${status}`,
  referenceNumber: 'KH-2026-000001',
  citizenId: 'c1',
  serviceId: 'birth-certificate',
  status,
  reviewerId: 'reviewer-1',
  history: [
    { status: 'SUBMITTED', at: AT },
    { status: 'UNDER_REVIEW', at: AT },
    { status: 'NEEDS_INFO', at: AT, note: 'Photo is blurry' },
    { status, at: AT },
  ],
});

/** Collect every node of a view tree. */
const flatten = (node) => [node, ...(node.children ?? []).flatMap(flatten)];

// --- A minimal document, so toDom can run without a browser ---------------------

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.className = '';
    this.attributes = {};
    this.children = [];
    this.textContent = '';
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
}
const fakeDocument = /** @type {any} */ ({ createElement: (tag) => new FakeElement(tag) });

// --- Status markers (ac2-3) --------------------------------------------------------

test('the label table covers exactly the six module statuses', () => {
  assert.deepEqual(Object.keys(STATUS_LABELS).sort(), Object.values(Status).sort());
});

test('each of the six statuses gets its own marker class and label', () => {
  const markers = Object.values(Status).map(statusMarker);
  assert.equal(new Set(markers.map((m) => m.className)).size, 6);
  assert.equal(new Set(markers.map((m) => m.text)).size, 6);
  assert.deepEqual(statusMarker('NEEDS_INFO'), {
    tag: 'span',
    className: 'status status--needs-info',
    text: 'Needs information',
  });
});

test('an unknown status gets the unknown marker and shows its raw value', () => {
  assert.deepEqual(statusMarker('ARCHIVED'), { tag: 'span', className: 'status status--unknown', text: 'ARCHIVED' });
  assert.equal(statusMarker('__proto__').className, 'status status--unknown');
});

test('every status class has a rule in the stylesheet', () => {
  const css = readFileSync(new URL('../src/public/styles.css', import.meta.url), 'utf8');
  for (const status of Object.values(Status)) {
    const selector = `.${statusMarker(status).className.split(' ')[1]}`;
    assert.ok(css.includes(`${selector} {`), `missing ${selector}`);
    assert.ok(css.includes(`${selector}::before`), `missing ${selector}::before symbol`);
  }
});

// --- Request cards and history ---------------------------------------------------

test('a request card renders in each of the six statuses with its marker', () => {
  for (const status of Object.values(Status)) {
    const card = renderRequest(recordIn(status));
    const header = card.children[0];
    assert.equal(header.children[0].text, 'KH-2026-000001');
    assert.deepEqual(header.children[1], statusMarker(status));
  }
});

test('the history shows every entry in order, with the return note', () => {
  const history = renderHistory(recordIn(Status.SUBMITTED).history);
  assert.equal(history.tag, 'ol');
  assert.equal(history.children.length, 4);
  const noteEntry = history.children[2];
  assert.deepEqual(noteEntry.children[0], statusMarker('NEEDS_INFO'));
  assert.equal(noteEntry.children[1].text, '2026-10-18 09:30:00 UTC');
  assert.equal(noteEntry.children[2].text, 'Note: Photo is blurry');
  assert.equal(history.children[0].children.length, 2, 'an entry without a note has no note line');
});

test('a card shows the service, the reviewer, and both actions for its request id', () => {
  const nodes = flatten(renderRequest(recordIn(Status.UNDER_REVIEW)));
  const texts = nodes.map((n) => n.text);
  assert.ok(texts.includes('birth-certificate'));
  assert.ok(texts.includes('reviewer-1'));
  const buttons = nodes.filter((n) => n.tag === 'button');
  assert.deepEqual(
    buttons.map((b) => [b.attrs['data-action'], b.attrs['data-id'], b.text]),
    [
      ['withdraw', 'id-UNDER_REVIEW', 'Withdraw'],
      ['resubmit', 'id-UNDER_REVIEW', 'Resubmit'],
    ],
  );
});

test('a card without a reviewer leaves the reviewer row out', () => {
  const record = recordIn(Status.SUBMITTED);
  delete record.reviewerId;
  const texts = flatten(renderRequest(record)).map((n) => n.text);
  assert.ok(!texts.includes('Reviewer'));
});

test('the list shows a heading and one card per request, or an empty message', () => {
  const list = renderRequestList('c1', [recordIn(Status.SUBMITTED), recordIn(Status.APPROVED)]);
  assert.equal(list[0].text, 'Requests for c1');
  assert.equal(list[1].children.length, 2);
  const empty = renderRequestList('c9', []);
  assert.deepEqual(empty[1], { tag: 'p', className: 'empty', text: 'No requests yet.' });
});

test('formatTime does not depend on the viewer locale', () => {
  assert.equal(formatTime('2026-01-02T03:04:05.678Z'), '2026-01-02 03:04:05 UTC');
  assert.equal(formatTime('2026-01-02T03:04:05Z'), '2026-01-02 03:04:05 UTC');
});

// --- Error region (ac2-4) ---------------------------------------------------------

test('errorText shows the status, the code, and the server message', () => {
  assert.equal(
    errorText(403, { code: 'NOT_REQUEST_OWNER', message: 'Only the citizen who submitted the request can withdraw it' }),
    'Error 403 NOT_REQUEST_OWNER: Only the citizen who submitted the request can withdraw it',
  );
});

test('errorText still says something when the body has no message', () => {
  assert.equal(errorText(500, null), 'Error 500: The server sent no message.');
  assert.equal(errorText(0, { message: 'Could not reach the server.' }), 'Could not reach the server.');
});

test('callApi returns the status and body of a non-2xx response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 409, json: async () => ({ code: 'DUPLICATE_REQUEST' }) });
  const result = await callApi('POST', '/requests', { citizenId: 'c1' }, /** @type {any} */ (fakeFetch));
  assert.deepEqual(result, { ok: false, status: 409, body: { code: 'DUPLICATE_REQUEST' } });
});

test('callApi sends JSON with the content type the server requires', async () => {
  let seen;
  const fakeFetch = async (path, init) => {
    seen = { path, init };
    return { ok: true, status: 201, json: async () => ({}) };
  };
  await callApi('POST', '/requests', { citizenId: 'c1' }, /** @type {any} */ (fakeFetch));
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.equal(seen.init.body, '{"citizenId":"c1"}');
});

test('callApi turns a network failure and a non-JSON body into results, not throws', async () => {
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  const offline = await callApi('GET', '/citizens/c1/requests', undefined, /** @type {any} */ (down));
  assert.equal(offline.status, 0);
  assert.match(offline.body.message, /Could not reach the server/);

  const notJson = async () => ({ ok: false, status: 502, json: async () => JSON.parse('<html>') });
  const bad = await callApi('GET', '/citizens/c1/requests', undefined, /** @type {any} */ (notJson));
  assert.deepEqual(bad, { ok: false, status: 502, body: null });
});

// --- Safe DOM building -----------------------------------------------------------

test('toDom puts markup-looking values in textContent, never as markup', () => {
  const hostile = { ...recordIn(Status.SUBMITTED), serviceId: '<img src=x onerror=alert(1)>' };
  const card = toDom(renderRequest(hostile), fakeDocument);
  const all = (el) => [el, ...el.children.flatMap(all)];
  const service = all(card).find((el) => el.textContent === '<img src=x onerror=alert(1)>');
  assert.ok(service, 'the hostile value is plain text content');
  assert.equal(service.tag, 'dd');
  assert.ok(all(card).every((el) => el.tag !== 'img'));
});

test('toDom sets only allow-listed attributes', () => {
  const el = toDom(
    { tag: 'button', attrs: { type: 'button', 'data-id': 7, onclick: 'alert(1)', style: 'x', href: 'javascript:x' } },
    fakeDocument,
  );
  assert.deepEqual(el.attributes, { type: 'button', 'data-id': '7' });
});

test('the screen script uses no innerHTML, outerHTML, insertAdjacentHTML, or eval', () => {
  const source = readFileSync(new URL('../src/public/citizen.js', import.meta.url), 'utf8');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'document.write']) {
    assert.ok(!source.includes(sink), `found ${sink}`);
  }
});

test('the page has the demo banner, an alert error region, and no inline script or style', () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /class="demo-banner"[^>]*>[\s\S]*Fictional demo\.[\s\S]*No sign-in/);
  assert.match(html, /id="error"[^>]*role="alert"/);
  assert.match(html, /name="viewport"/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'every script has a src');
  assert.ok(!/<style\b/.test(html) && !/\sstyle=/.test(html), 'no inline style');
  assert.ok(!/\son[a-z]+=/.test(html), 'no inline event handler');
});

// --- The page wiring, against the real router ----------------------------------

/**
 * A fake page with the ids index.html declares. fetch goes straight to the
 * server's handleRequest, so the screen drives the real module.
 */
function fakePage() {
  const listeners = {};
  const element = (id) => ({
    id,
    value: '',
    textContent: '',
    hidden: true,
    children: [],
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    addEventListener(type, fn) {
      listeners[`${id}:${type}`] = fn;
    },
  });
  const ids = ['citizen-id', 'service-id', 'error', 'notice', 'requests', 'citizen-form', 'submit-form'];
  const els = Object.fromEntries(ids.map((id) => [id, element(id)]));
  const doc = /** @type {any} */ ({
    getElementById: (id) => els[id] ?? null,
    createElement: (tag) => new FakeElement(tag),
  });
  const routerFetch = async (path, init) => {
    const res = handleRequest({ method: init.method, path, rawBody: init.body });
    return { ok: res.status < 300, status: res.status, json: async () => res.body };
  };
  const event = (target) => ({ preventDefault() {}, target });
  const all = (el) => [el, ...(el.children ?? []).flatMap(all)];
  const page = {
    els,
    doc,
    routerFetch,
    show: () => listeners['citizen-form:submit'](event(null)),
    submit: () => listeners['submit-form:submit'](event(null)),
    click: (action, id) =>
      listeners['requests:click'](
        event({ closest: () => ({ getAttribute: (n) => ({ 'data-action': action, 'data-id': id })[n] }) }),
      ),
    cards: () => els.requests.children.flatMap(all).filter((el) => el.className === 'request'),
    markers: () =>
      els.requests.children
        .flatMap(all)
        .filter((el) => el.className.startsWith('status ') && el.tag === 'span')
        .map((el) => el.textContent),
    buttonId: (action) =>
      els.requests.children.flatMap(all).find((el) => el.attributes['data-action'] === action).attributes['data-id'],
  };
  return page;
}

test('the citizen screen submits, rejects a duplicate, and refuses a wrong-owner withdraw on screen (ac2-1, ac2-4)', async () => {
  resetStore();
  const page = fakePage();
  boot(page.doc, /** @type {any} */ (page.routerFetch));

  page.els['citizen-id'].value = 'c1';
  page.els['service-id'].value = 'birth-certificate';
  await page.submit();
  assert.match(page.els.notice.textContent, /^Submitted KH-\d{4}-\d{6}\.$/);
  assert.equal(page.els.error.hidden, true);
  assert.equal(page.cards().length, 1);
  assert.equal(page.markers()[0], 'Submitted');

  await page.submit();
  assert.equal(page.els.error.hidden, false);
  assert.match(page.els.error.textContent, /^Error 409 DUPLICATE_REQUEST: /);

  const id = page.buttonId('withdraw');
  page.els['citizen-id'].value = 'c2';
  await page.click('withdraw', id);
  assert.match(page.els.error.textContent, /^Error 403 NOT_REQUEST_OWNER: /);
  assert.equal(page.cards().length, 1, 'the c1 list stays on screen after the refusal');

  page.els['citizen-id'].value = 'c1';
  await page.click('withdraw', id);
  assert.equal(page.els.error.hidden, true, 'a new action clears the old error');
  assert.match(page.els.notice.textContent, /^Withdrew KH-/);
  assert.equal(page.markers()[0], 'Withdrawn');
});

test('the citizen screen resubmits after a return and shows the note in the history (ac2-1, ac2-3)', async () => {
  resetStore();
  const page = fakePage();
  boot(page.doc, /** @type {any} */ (page.routerFetch));
  const r = submitRequest({ citizenId: 'c1', serviceId: 'passport-renewal' });
  startReview(r.id, 'reviewer-1');
  returnForInfo(r.id, 'reviewer-1', 'Photo is blurry');

  page.els['citizen-id'].value = 'c1';
  await page.show();
  assert.equal(page.markers()[0], 'Needs information');

  await page.click('resubmit', r.id);
  assert.match(page.els.notice.textContent, /^Resubmitted KH-/);
  const texts = page.els.requests.children.flatMap(function all(el) {
    return [el.textContent, ...(el.children ?? []).flatMap(all)];
  });
  assert.ok(texts.includes('Note: Photo is blurry'));
  assert.equal(page.markers()[0], 'Submitted', 'the card marker shows the new status');
});

test('the citizen screen shows an action that the module refuses, and ignores clicks outside buttons', async () => {
  resetStore();
  const page = fakePage();
  boot(page.doc, /** @type {any} */ (page.routerFetch));
  const r = submitRequest({ citizenId: 'c1', serviceId: 'birth-certificate' });
  page.els['citizen-id'].value = 'c1';
  await page.click('resubmit', r.id);
  assert.match(page.els.error.textContent, /^Error 409 INVALID_STATE: Cannot resubmit/);

  page.els.error.textContent = 'unchanged';
  await page.click('approve', r.id);
  assert.equal(page.els.error.textContent, 'unchanged', 'an unknown action does nothing');
});

test('the citizen screen shows a network failure and a screen failure instead of failing silently', async () => {
  const page = fakePage();
  boot(page.doc, /** @type {any} */ (async () => {
    throw new TypeError('fetch failed');
  }));
  page.els['citizen-id'].value = 'c1';
  await page.show();
  assert.equal(page.els.error.hidden, false);
  assert.match(page.els.error.textContent, /Could not reach the server/);

  const broken = fakePage();
  boot(broken.doc, /** @type {any} */ (async () => ({ ok: true, status: 200, json: async () => [{ history: null }] })));
  broken.els.requests.replaceChildren = () => {
    throw new Error('render broke');
  };
  await broken.show();
  assert.match(broken.els.error.textContent, /^The screen failed: Error: render broke$/);
});
