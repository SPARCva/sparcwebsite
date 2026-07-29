/* ==========================================================================
   photo-gallery — photographer drop-off page (/photogallery/upload/)
   --------------------------------------------------------------------------
   Deliberately much smaller than the admin app. A photographer needs to pick
   an event, drop files, and know the upload finished. No library, no tagging,
   no captions — the SPARC team handles all of that during review.

   Auth: the upload-only photographer passphrase (see the auth table in
   supabase/functions/photo-gallery/README.md). That token can only call
   `categories`, `upload-urls` and `upload-commit`, and its commits are forced
   unpublished server-side — so photos land in the admin review queue and
   nothing on the live site can be reached with this passphrase.

   The previous version of this page posted multipart FormData to an
   `action:"upload"` that v2 removed, so it had been failing outright. It also
   probed the passphrase by distinguishing a 400 from a 401 on that dead
   action, and hardcoded the three album options.

   Markup contract: see photogallery/upload/index.html.
   ========================================================================== */

import { api, signIn, configure, hasToken, PGError } from "./api.js";
import { el, toast, announce, plural, num } from "./ui.js";
import { buildQueue, uploadItems, primeDates } from "./uploader.js";

// A separate session key from the admin page: the two roles are different
// passphrases, and one must never be mistaken for the other.
configure({ storageKey: "pg_upload_token" });

const $ = (id) => document.getElementById(id);

let queue = [];
const rows = new Map();
let categories = [];
let uploading = false;

/* ---------- queue ------------------------------------------------------ */

const STATE_LABEL = {
  queued: "Ready",
  resizing: "Preparing…",
  uploading: "Sending…",
  committed: "Sent",
  failed: "Didn't send",
};

function buildRow(item) {
  const preview = el("img", { alt: "", src: URL.createObjectURL(item.file) });
  preview.addEventListener("load", () => URL.revokeObjectURL(preview.src), { once: true });

  const status = el("span.pga-qstatus", { "dataset": { state: item.state }, text: STATE_LABEL[item.state] });
  const error = el("p.pga-error", { style: { margin: "0", fontSize: "0.78rem" } });

  const remove = el("button.pga-btn.pga-btn-ghost.pga-btn-sm", {
    type: "button",
    "aria-label": `Remove ${item.file.name}`,
    onclick: () => {
      queue = queue.filter((entry) => entry.id !== item.id);
      rows.get(item.id)?.remove();
      rows.delete(item.id);
      refreshChrome();
    },
  }, "Remove");

  const row = el("div.pga-qitem", null,
    preview,
    el("div.pga-qfields", null,
      el("span", { text: item.file.name, style: { fontSize: "0.85rem" } }),
      el("span.pga-muted", { text: `${(item.file.size / 1048576).toFixed(1)} MB`, style: { fontSize: "0.76rem" } }),
      error,
    ),
    el("div.pga-qside", null, status, remove),
  );

  row._refresh = () => {
    status.dataset.state = item.state;
    status.textContent = STATE_LABEL[item.state] || item.state;
    error.textContent = item.error || "";
    remove.hidden = item.state === "committed";
    row.style.opacity = item.state === "committed" ? "0.6" : "1";
  };
  return row;
}

function renderQueue() {
  const list = $("pgu-queue");
  list.replaceChildren();
  rows.clear();
  for (const item of queue) {
    const row = buildRow(item);
    rows.set(item.id, row);
    list.append(row);
    row._refresh();
  }
  refreshChrome();
}

function refreshChrome() {
  const pending = queue.filter((item) => item.state !== "committed").length;
  const failed = queue.filter((item) => item.state === "failed").length;

  $("pgu-actions").hidden = queue.length === 0;
  $("pgu-count").textContent = queue.length
    ? `${plural(queue.length, "photo")} ready to send.`
    : "";
  const send = $("pgu-send");
  send.disabled = uploading || pending === 0;
  send.textContent = pending ? `Upload ${plural(pending, "photo")}` : "Upload";
  $("pgu-clear").disabled = uploading;
  const retry = $("pgu-retry");
  retry.hidden = failed === 0 || uploading;
  retry.textContent = `Retry ${plural(failed, "photo")}`;
}

function addFiles(fileList) {
  const { items, rejected } = buildQueue(fileList);
  if (rejected.length) {
    const first = rejected[0];
    toast(
      `${plural(rejected.length, "file")} skipped — ${first.file.name} is ${first.reason}.`,
      { kind: "error" },
    );
  }
  if (!items.length) return;
  queue = queue.concat(items);
  $("pgu-done").hidden = true;
  renderQueue();
  announce(`${plural(items.length, "photo")} added.`, { force: true });
  primeDates(items).catch(() => {});
}

/* ---------- upload ----------------------------------------------------- */

function beforeUnload(event) {
  event.preventDefault();
  event.returnValue = "";
}

async function send() {
  const gallery = $("pgu-gallery").value;
  const year = parseInt($("pgu-year").value, 10);
  const yearInput = $("pgu-year");

  if (!gallery) { toast("Choose an event first.", { kind: "error" }); return; }
  if (Number.isNaN(year) || year < 1990 || year > 2100) {
    yearInput.setAttribute("aria-invalid", "true");
    toast("Enter a year between 1990 and 2100.", { kind: "error" });
    yearInput.focus();
    return;
  }
  yearInput.removeAttribute("aria-invalid");

  uploading = true;
  refreshChrome();
  window.addEventListener("beforeunload", beforeUnload);

  const progress = $("pgu-progress");
  const fill = $("pgu-progress-fill");
  const text = $("pgu-progress-text");
  progress.hidden = false;

  const result = await uploadItems(queue, {
    gallery,
    year,
    submission: $("pgu-submission").value.trim() || null,
    // Belt and braces: the server forces this for a photographer token
    // anyway, but being explicit means the page still behaves correctly if
    // someone signs in here with the admin passphrase.
    published: false,
    onItem: (item) => rows.get(item.id)?._refresh(),
    onProgress: (done, total) => {
      const pct = total ? Math.round((done / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      text.textContent = `${num(done)} of ${num(total)} processed`;
      announce(`Sending: ${done} of ${total}.`);
    },
  });

  uploading = false;
  window.removeEventListener("beforeunload", beforeUnload);
  progress.hidden = true;
  fill.style.width = "0%";

  queue = queue.filter((item) => item.state !== "committed");
  renderQueue();

  const done = $("pgu-done");
  if (result.committed) {
    done.hidden = false;
    done.replaceChildren(
      el("div.pga-toolbar", { style: { marginTop: "18px" } },
        el("span.pga-toolbar-count", {
          text: `Sent ${plural(result.committed, "photo")} to the SPARC team.`,
        }),
        el("span.pga-badge.pga-badge-hidden", { text: "Awaiting review" }),
      ),
      el("p.pga-hint", { style: { margin: "10px 0 0" }, text:
        "They're safely with SPARC now and will appear on the website once the team " +
        "has reviewed them. You can close this tab, or add more photos above." }),
    );
    announce(`Sent ${plural(result.committed, "photo")}. Awaiting review.`, { force: true });
  }
  if (result.failed) {
    toast(
      `${plural(result.failed, "photo")} didn't send. Use “Retry” — nothing was lost.`,
      { kind: "error" },
    );
  } else if (result.committed) {
    toast(`Sent ${plural(result.committed, "photo")}. Thank you!`, { kind: "success" });
  }
}

async function retryFailed() {
  for (const item of queue) {
    if (item.state === "failed") {
      item.state = "queued";
      item.error = "";
      rows.get(item.id)?._refresh();
    }
  }
  refreshChrome();
  await send();
}

/* ---------- setup ------------------------------------------------------ */

function fillCategories() {
  const select = $("pgu-gallery");
  // Private albums are staging areas for staff; don't offer them here.
  const offered = categories.filter((cat) => cat.is_public);
  const list = offered.length ? offered : categories;
  select.replaceChildren(...list.map((cat) => el("option", { value: cat.slug, text: cat.name })));
}

function showApp() {
  $("pgu-login").hidden = true;
  $("pgu-main").hidden = false;
  fillCategories();
  $("pgu-year").value = String(new Date().getFullYear());
}

function showLogin(message) {
  $("pgu-main").hidden = true;
  $("pgu-login").hidden = false;
  if (message) $("pgu-login-err").textContent = message;
  $("pgu-pw").focus();
}

function wire() {
  const drop = $("pgu-drop");
  const file = $("pgu-file");

  drop.addEventListener("click", () => file.click());
  file.addEventListener("change", () => { addFiles(file.files); file.value = ""; });
  for (const type of ["dragover", "dragenter"]) {
    drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add("drag"); });
  }
  for (const type of ["dragleave", "dragend"]) {
    drop.addEventListener(type, () => drop.classList.remove("drag"));
  }
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("drag");
    if (event.dataTransfer?.files) addFiles(event.dataTransfer.files);
  });

  $("pgu-send").addEventListener("click", send);
  $("pgu-retry").addEventListener("click", retryFailed);
  $("pgu-clear").addEventListener("click", () => { queue = []; renderQueue(); });

  $("pgu-login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("pgu-pw");
    const error = $("pgu-login-err");
    const button = $("pgu-login-btn");
    error.textContent = "";
    input.removeAttribute("aria-invalid");

    const value = input.value.trim();
    if (!value) {
      input.setAttribute("aria-invalid", "true");
      error.textContent = "Enter the passphrase.";
      return;
    }

    button.disabled = true;
    button.textContent = "Checking…";
    try {
      categories = await signIn(value);
      input.value = "";
      showApp();
    } catch (err) {
      input.setAttribute("aria-invalid", "true");
      error.textContent = err instanceof PGError && err.status === 401
        ? "That passphrase wasn't recognised. Check with the SPARC team."
        : err.message;
      input.focus();
      input.select();
    }
    button.disabled = false;
    button.textContent = "Continue";
  });
}

async function boot() {
  wire();
  if (!hasToken()) { showLogin(); return; }
  try {
    const res = await api("categories");
    categories = res.categories || [];
    showApp();
  } catch (err) {
    showLogin(err.status === 401 ? "" : err.message);
  }
}

boot();
