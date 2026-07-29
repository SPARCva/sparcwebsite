/* ==========================================================================
   photo-gallery admin — UI primitives
   --------------------------------------------------------------------------
   Replaces every prompt() / confirm() / alert() in the old admin page with
   accessible in-page equivalents.

   Markup contract: nothing. Every host element this module needs is created
   on demand and appended to <body>. Callers only need
   /css/photo-gallery-admin.css loaded.

   Accessibility notes:
     - dialog() is role="dialog" aria-modal="true" with aria-labelledby, a
       real Tab focus trap (ported from js/photo-gallery.js, the lightbox that
       already gets this right), Escape to close, and focus restored to
       whatever opened it.
     - toast() carries role="status" so it is actually announced. The
       equivalent in access/admin.html is missing that; don't inherit the bug.
     - announce() is one throttled polite live region for long-running
       progress, so a 200-photo scan doesn't fire 200 announcements.
   ========================================================================== */

/* ---------- escaping --------------------------------------------------- */

/** Escapes the five XML-significant characters, including both quote forms. */
export function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------- element helper -------------------------------------------- */

/**
 * el("div.pga-panel", {…attrs}, ...children)
 * Keeps view code declarative without pulling in a framework. Children may be
 * nodes, strings (escaped automatically by textContent), or nullish (skipped).
 */
export function el(spec, attrs, ...children) {
  const [tagPart, ...classes] = String(spec).split(".");
  const node = document.createElement(tagPart || "div");
  if (classes.length) node.className = classes.join(" ");
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = [node.className, value].filter(Boolean).join(" ");
      else if (key === "html") node.innerHTML = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ---------- live region ----------------------------------------------- */

let liveRegion = null;
let lastAnnounce = 0;
let pendingAnnounce = null;

function ensureLive() {
  if (liveRegion) return liveRegion;
  liveRegion = el("div.pga-visually-hidden", { "role": "status", "aria-live": "polite", "aria-atomic": "true" });
  document.body.append(liveRegion);
  return liveRegion;
}

/**
 * Announce progress politely. Throttled to one message per `minGap` ms so
 * per-photo progress can call it freely; the final message always lands.
 */
export function announce(message, { minGap = 1500, force = false } = {}) {
  const region = ensureLive();
  const now = Date.now();
  clearTimeout(pendingAnnounce);
  if (force || now - lastAnnounce >= minGap) {
    lastAnnounce = now;
    region.textContent = message;
    return;
  }
  pendingAnnounce = setTimeout(() => {
    lastAnnounce = Date.now();
    region.textContent = message;
  }, minGap - (now - lastAnnounce));
}

/* ---------- toasts ---------------------------------------------------- */

let toastHost = null;

function ensureToastHost() {
  if (toastHost) return toastHost;
  toastHost = el("div.pga-toasts");
  document.body.append(toastHost);
  return toastHost;
}

/**
 * Show a transient message.
 *
 * @param {string} message
 * @param {object} [opts]
 * @param {"info"|"success"|"error"} [opts.kind]
 * @param {number} [opts.duration] ms; errors default to longer
 * @param {{label: string, run: Function}} [opts.action] e.g. an Undo button
 * @returns {{dismiss: Function}}
 */
export function toast(message, opts = {}) {
  const kind = opts.kind || "info";
  const duration = opts.duration ?? (kind === "error" ? 7000 : 4000);
  const host = ensureToastHost();

  // role="status" on the toast itself, so the text is announced on insert.
  const node = el("div.pga-toast", { "role": "status", "dataset": { kind } }, el("span", { text: message }));

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    node.remove();
  };

  if (opts.action) {
    node.append(el("button", {
      type: "button",
      onclick: () => { dismiss(); opts.action.run(); },
    }, opts.action.label));
  }

  host.append(node);
  // A toast offering an action stays until used or replaced — yanking an Undo
  // button away mid-reach is worse than a little clutter.
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return { dismiss, node };
}

export function toastError(err, fallback = "Something went wrong.") {
  const message = err && err.message ? err.message : fallback;
  return toast(message, { kind: "error" });
}

/* ---------- focus trap ------------------------------------------------ */

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusable(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE))
    .filter((node) => node.offsetParent !== null || node === document.activeElement);
}

/* ---------- dialog ---------------------------------------------------- */

let dialogSeq = 0;
const openDialogs = [];

/**
 * Open a modal dialog.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {Node|string} opts.body
 * @param {Array<{label, kind?, value?, run?, autofocus?, keepOpen?}>} [opts.actions]
 * @param {boolean} [opts.wide]
 * @param {string} [opts.initialFocus] CSS selector inside the body
 * @param {Function} [opts.onClose]
 * @returns {{close: Function, root: HTMLElement, body: HTMLElement, result: Promise}}
 */
export function dialog(opts = {}) {
  const id = `pga-dlg-${++dialogSeq}`;
  const previousFocus = document.activeElement;

  const titleEl = el("h2", { id: `${id}-title`, text: opts.title || "" });
  const bodyEl = el("div.pga-dialog-body");
  if (opts.body instanceof Node) bodyEl.append(opts.body);
  else if (typeof opts.body === "string") bodyEl.innerHTML = opts.body;

  const closeBtn = el("button.pga-close", {
    type: "button",
    "aria-label": "Close dialog",
    html: "&times;",
  });

  const head = el("div.pga-dialog-head", null, titleEl, closeBtn);
  const foot = el("div.pga-dialog-foot");
  const panel = el(`div.pga-dialog${opts.wide ? ".wide" : ""}`, {
    "role": "dialog",
    "aria-modal": "true",
    "aria-labelledby": `${id}-title`,
  }, head, bodyEl);

  const scrim = el("div.pga-scrim", { id }, panel);

  let settle;
  const result = new Promise((resolve) => { settle = resolve; });
  let settled = false;

  function close(value) {
    if (settled) return;
    settled = true;
    document.removeEventListener("keydown", onKeydown, true);
    const index = openDialogs.indexOf(instance);
    if (index >= 0) openDialogs.splice(index, 1);
    scrim.classList.remove("open");
    // Only the last dialog releases the scroll lock.
    if (!openDialogs.length) document.body.style.overflow = "";
    const done = () => scrim.remove();
    // Respect reduced-motion: no transition means no transitionend.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) done();
    else setTimeout(done, 200);
    if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
    if (opts.onClose) opts.onClose(value);
    settle(value);
  }

  function onKeydown(event) {
    // Only the topmost dialog handles keys.
    if (openDialogs[openDialogs.length - 1] !== instance) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close(undefined);
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = focusable(panel);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  closeBtn.addEventListener("click", () => close(undefined));
  scrim.addEventListener("mousedown", (event) => { if (event.target === scrim) close(undefined); });

  const actions = opts.actions || [];
  let autofocusTarget = null;
  for (const action of actions) {
    const btn = el(`button.pga-btn.pga-btn-${action.kind || "ghost"}`, {
      type: "button",
      onclick: async () => {
        if (action.run) {
          // Guard against double-submit while an async action is in flight.
          btn.disabled = true;
          try {
            const outcome = await action.run({ close, body: bodyEl });
            if (action.keepOpen !== true) close(outcome === undefined ? action.value : outcome);
          } catch (err) {
            toastError(err);
            btn.disabled = false;
            return;
          }
          btn.disabled = false;
        } else {
          close(action.value);
        }
      },
    }, action.label);
    if (action.autofocus) autofocusTarget = btn;
    foot.append(btn);
  }
  if (actions.length) panel.append(foot);

  document.body.append(scrim);
  document.body.style.overflow = "hidden";
  const instance = { close, root: scrim, body: bodyEl, result };
  openDialogs.push(instance);
  document.addEventListener("keydown", onKeydown, true);

  // Force a reflow so the open transition actually runs.
  requestAnimationFrame(() => scrim.classList.add("open"));

  const explicit = opts.initialFocus ? bodyEl.querySelector(opts.initialFocus) : null;
  (explicit || autofocusTarget || focusable(panel)[0] || closeBtn).focus();

  return instance;
}

/**
 * Replacement for confirm(). Resolves true only if the confirm button is used
 * — Escape, the scrim and the close button all resolve false.
 */
export function confirmDialog({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  const content = typeof body === "string" ? el("p", { text: body }) : body;
  const instance = dialog({
    title,
    body: content,
    actions: [
      { label: cancelLabel, kind: "ghost", value: false },
      { label: confirmLabel, kind: danger ? "danger" : "primary", value: true, autofocus: !danger },
    ],
  });
  return instance.result.then((value) => value === true);
}

/**
 * Replacement for prompt(). Resolves the trimmed string, or null if cancelled.
 */
export function promptDialog({ title, label, value = "", placeholder = "", hint, confirmLabel = "Save", multiline = false, type = "text" }) {
  const inputId = `pga-prompt-${++dialogSeq}`;
  const hintId = `${inputId}-hint`;
  const input = multiline
    ? el("textarea", { id: inputId, placeholder, rows: "4", "aria-describedby": hint ? hintId : null })
    : el("input", { id: inputId, type, value, placeholder, "aria-describedby": hint ? hintId : null });
  if (multiline) input.value = value;

  const field = el("div.pga-field.grow", null,
    el("label", { for: inputId, text: label }),
    input,
    hint ? el("p.pga-hint", { id: hintId, text: hint, style: { margin: "4px 0 0" } }) : null,
  );

  const instance = dialog({
    title,
    body: el("div.pga-row", null, field),
    initialFocus: `#${inputId}`,
    actions: [
      { label: "Cancel", kind: "ghost", value: null },
      { label: confirmLabel, kind: "primary", run: () => input.value.trim() },
    ],
  });

  // Enter submits a single-line prompt, the way the native one did.
  if (!multiline) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        instance.close(input.value.trim());
      }
    });
  }

  return instance.result.then((value) => (value == null || value === "" ? null : value));
}

/* ---------- states ---------------------------------------------------- */

const EMPTY_ICON = `<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/>
  <path d="m21 15-5-5L5 19"/></svg>`;

export function emptyState({ title, body, action, icon }) {
  const node = el("div.pga-empty", { html: icon === null ? "" : (icon || EMPTY_ICON) });
  if (title) node.append(el("h3", { text: title }));
  if (body) node.append(el("p", { text: body }));
  if (action) {
    node.append(el("button.pga-btn.pga-btn-primary", { type: "button", onclick: action.run }, action.label));
  }
  return node;
}

export function loadingState(message = "Loading…") {
  return el("p.pga-loading", { "role": "status", text: message });
}

/* ---------- misc helpers --------------------------------------------- */

/** "1,234" — used for counts, so long numbers stay readable. */
export function num(value) {
  return Number(value || 0).toLocaleString();
}

/** Pluralise without the "1 photo(s)" awkwardness the old page had. */
export function plural(count, singular, pluralForm) {
  return `${num(count)} ${count === 1 ? singular : (pluralForm || `${singular}s`)}`;
}

/** yyyy-mm-dd for <input type="date">, from an ISO timestamp. */
export function isoToDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/** Short human date for card meta. */
export function shortDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Run `tasks` (an array of thunks returning promises) with at most `limit`
 * in flight. Resolves with results in the original order. Used for upload
 * PUTs and face scanning, where unbounded parallelism kills the tab and
 * fully sequential is needlessly slow.
 */
export async function pool(tasks, limit, onSettled) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor++;
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        results[index] = err;
      }
      if (onSettled) onSettled(index, results[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** Debounce, for search inputs. */
export function debounce(fn, wait = 280) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
