// @ts-check
// Khidma — citizen screen.
//
// The screen owns no business rules (plan constraint C3). It sends what the
// person types to the citizen routes and shows what the server returns. Every
// action button is shown on every request; the module decides whether the
// action is allowed, and a refusal appears in the error region.
//
// The render functions are pure: a record goes in, a plain view tree comes
// out. toDom() turns that tree into DOM nodes with createElement and
// textContent only, so no server value is ever parsed as HTML.

/**
 * @typedef {{
 *   tag: string,
 *   className?: string,
 *   text?: unknown,
 *   attrs?: Record<string, unknown>,
 *   children?: ViewNode[],
 * }} ViewNode
 * @typedef {{ status: string, at: string, note?: string }} HistoryEntry
 * @typedef {{
 *   id: string,
 *   referenceNumber: string,
 *   citizenId: string,
 *   serviceId: string,
 *   status: string,
 *   history: HistoryEntry[],
 *   reviewerId?: string,
 * }} RequestRecord
 * @typedef {{ ok: boolean, status: number, body: any }} ApiResult
 */

/** Display label per status. The keys match the module's Status values. */
export const STATUS_LABELS = Object.freeze({
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  NEEDS_INFO: 'Needs information',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
});

/** Attribute names toDom() may set. Anything else is dropped. */
const SAFE_ATTRIBUTE = /^(type|role|datetime|data-[a-z]+(-[a-z]+)*|aria-[a-z]+)$/;

/**
 * The marker for one status: a label plus a status-specific class. The
 * stylesheet gives each class its own colour, border, and symbol.
 * @param {unknown} status
 * @returns {ViewNode}
 */
export function statusMarker(status) {
  const value = String(status);
  const known = Object.prototype.hasOwnProperty.call(STATUS_LABELS, value);
  const slug = known ? value.toLowerCase().replace(/_/g, '-') : 'unknown';
  return {
    tag: 'span',
    className: `status status--${slug}`,
    text: known ? STATUS_LABELS[/** @type {keyof typeof STATUS_LABELS} */ (value)] : value,
  };
}

/**
 * Show an ISO timestamp as "YYYY-MM-DD HH:MM:SS UTC" so the screen and the
 * tests do not depend on the viewer's locale.
 * @param {unknown} at
 * @returns {string}
 */
export function formatTime(at) {
  return String(at).replace('T', ' ').replace(/(\.\d+)?Z$/, ' UTC');
}

/**
 * @param {HistoryEntry[]} history
 * @returns {ViewNode}
 */
export function renderHistory(history) {
  return {
    tag: 'ol',
    className: 'history',
    attrs: { 'aria-label': 'History' },
    children: (Array.isArray(history) ? history : []).map((entry) => {
      /** @type {ViewNode[]} */
      const children = [
        statusMarker(entry.status),
        { tag: 'time', className: 'history__time', attrs: { datetime: entry.at }, text: formatTime(entry.at) },
      ];
      if (entry.note !== undefined) {
        children.push({ tag: 'p', className: 'history__note', text: `Note: ${String(entry.note)}` });
      }
      return { tag: 'li', className: 'history__entry', children };
    }),
  };
}

/**
 * One request card: reference number, status, service, reviewer, history,
 * and the withdraw and resubmit buttons.
 * @param {RequestRecord} record
 * @returns {ViewNode}
 */
export function renderRequest(record) {
  /** @type {ViewNode[]} */
  const details = [
    { tag: 'dt', text: 'Service' },
    { tag: 'dd', text: record.serviceId },
  ];
  if (record.reviewerId !== undefined) {
    details.push({ tag: 'dt', text: 'Reviewer' }, { tag: 'dd', text: record.reviewerId });
  }
  /** @param {string} action @param {string} label @returns {ViewNode} */
  const button = (action, label) => ({
    tag: 'button',
    className: 'button button--secondary',
    attrs: { type: 'button', 'data-action': action, 'data-id': record.id },
    text: label,
  });
  return {
    tag: 'li',
    className: 'request',
    children: [
      {
        tag: 'div',
        className: 'request__header',
        children: [
          { tag: 'strong', className: 'request__reference', text: record.referenceNumber },
          statusMarker(record.status),
        ],
      },
      { tag: 'dl', className: 'request__details', children: details },
      renderHistory(record.history),
      {
        tag: 'div',
        className: 'request__actions',
        children: [button('withdraw', 'Withdraw'), button('resubmit', 'Resubmit')],
      },
    ],
  };
}

/**
 * The list section for one citizen.
 * @param {unknown} citizenId
 * @param {RequestRecord[]} records
 * @returns {ViewNode[]}
 */
export function renderRequestList(citizenId, records) {
  const heading = { tag: 'h2', text: `Requests for ${String(citizenId)}` };
  if (!Array.isArray(records) || records.length === 0) {
    return [heading, { tag: 'p', className: 'empty', text: 'No requests yet.' }];
  }
  return [heading, { tag: 'ul', className: 'requests', children: records.map(renderRequest) }];
}

/**
 * The text for the error region. Uses the server's message when it sent one.
 * @param {number} status HTTP status, or 0 when the server could not be reached
 * @param {any} body
 * @returns {string}
 */
export function errorText(status, body) {
  const message = body && typeof body.message === 'string' ? body.message : 'The server sent no message.';
  if (status === 0) return message;
  const code = body && typeof body.code === 'string' ? ` ${body.code}` : '';
  return `Error ${status}${code}: ${message}`;
}

/**
 * Build DOM nodes from a view tree. Text goes through textContent and only
 * allow-listed attributes are set, so no value is parsed as markup.
 * @param {ViewNode} node
 * @param {Document} doc
 * @returns {HTMLElement}
 */
export function toDom(node, doc) {
  const element = doc.createElement(node.tag);
  if (node.className) element.className = node.className;
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    if (SAFE_ATTRIBUTE.test(name)) element.setAttribute(name, String(value));
  }
  if (node.text !== undefined) element.textContent = String(node.text);
  for (const child of node.children ?? []) element.appendChild(toDom(child, doc));
  return element;
}

/**
 * Call one JSON route. Never throws: a network failure returns status 0 with
 * a message, so the caller always has something to show.
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<ApiResult>}
 */
export async function callApi(method, path, body, fetchImpl = fetch) {
  /** @type {RequestInit} */
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetchImpl(path, init);
  } catch {
    return { ok: false, status: 0, body: { message: 'Could not reach the server. Is npm start still running?' } };
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

// --- Browser wiring ------------------------------------------------------------

/**
 * Wire the page. Runs on load in a browser. The tests call it with a fake
 * page and a fetch that goes straight to the server's router.
 * @param {Document} doc
 * @param {typeof fetch} [fetchImpl]
 */
export function boot(doc, fetchImpl = fetch) {
  const citizenInput = /** @type {HTMLInputElement} */ (doc.getElementById('citizen-id'));
  const serviceInput = /** @type {HTMLInputElement} */ (doc.getElementById('service-id'));
  const errorRegion = /** @type {HTMLElement} */ (doc.getElementById('error'));
  const notice = /** @type {HTMLElement} */ (doc.getElementById('notice'));
  const list = /** @type {HTMLElement} */ (doc.getElementById('requests'));

  /** @param {ApiResult} result */
  const showError = (result) => {
    errorRegion.textContent = errorText(result.status, result.body);
    errorRegion.hidden = false;
    // The error region sits above the list; bring it into view after a
    // refusal on a card further down the page.
    errorRegion.scrollIntoView?.({ block: 'nearest' });
  };
  const clearMessages = () => {
    errorRegion.textContent = '';
    errorRegion.hidden = true;
    notice.textContent = '';
  };

  const loadList = async () => {
    const citizenId = citizenInput.value;
    const result = await callApi('GET', `/citizens/${encodeURIComponent(citizenId)}/requests`, undefined, fetchImpl);
    if (!result.ok) {
      showError(result);
      return;
    }
    list.replaceChildren(...renderRequestList(citizenId, result.body).map((node) => toDom(node, doc)));
  };

  /** @param {Event} event */
  const onShow = async (event) => {
    event.preventDefault();
    clearMessages();
    await loadList();
  };

  /** @param {Event} event */
  const onSubmit = async (event) => {
    event.preventDefault();
    clearMessages();
    const result = await callApi('POST', '/requests', {
      citizenId: citizenInput.value,
      serviceId: serviceInput.value,
    }, fetchImpl);
    if (!result.ok) {
      showError(result);
      return;
    }
    notice.textContent = `Submitted ${String(result.body.referenceNumber)}.`;
    await loadList();
  };

  /** @param {Event} event */
  const onAction = async (event) => {
    const target = /** @type {HTMLElement | null} */ (event.target);
    const button = target?.closest('button[data-action]');
    if (!button) return;
    const action = button.getAttribute('data-action');
    const id = button.getAttribute('data-id') ?? '';
    if (action !== 'withdraw' && action !== 'resubmit') return;
    clearMessages();
    // The citizen id is read when the button is pressed, so changing the
    // typed-in id and pressing Withdraw shows the module's ownership error.
    const result = await callApi('POST', `/requests/${encodeURIComponent(id)}/${action}`, {
      citizenId: citizenInput.value,
    }, fetchImpl);
    if (!result.ok) {
      showError(result);
      return;
    }
    notice.textContent = `${action === 'withdraw' ? 'Withdrew' : 'Resubmitted'} ${String(result.body.referenceNumber)}.`;
    await loadList();
  };

  /**
   * Show any unexpected failure in the screen itself, so no failure is silent.
   * @param {(event: Event) => Promise<void>} handler
   * @returns {(event: Event) => Promise<void>}
   */
  const guarded = (handler) => (event) =>
    handler(event).catch((/** @type {unknown} */ error) => {
      showError({ ok: false, status: 0, body: { message: `The screen failed: ${String(error)}` } });
    });

  doc.getElementById('citizen-form')?.addEventListener('submit', guarded(onShow));
  doc.getElementById('submit-form')?.addEventListener('submit', guarded(onSubmit));
  list.addEventListener('click', guarded(onAction));
}

if (typeof document !== 'undefined') boot(document);
