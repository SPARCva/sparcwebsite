/* ==========================================================================
   photo-gallery admin — Upload tab
   --------------------------------------------------------------------------
   Three ways in, all landing in the album + year from the context bar:

     1. Drag/choose files -> the shared signed-upload pipeline
     2. Google Photos Picker -> the function re-hosts each picked photo
     3. Paste image links -> same import action

   Captions and alt text are editable in the queue *before* upload and sent
   with upload-commit, which is the whole point: it avoids a second pass over
   200 photos, and it keeps needs_alt false from the start rather than adding
   to the accessibility backlog.
   ========================================================================== */

import { api } from "./api.js";
import {
  el, toast, toastError, announce, plural, num, emptyState,
} from "./ui.js";
import { buildQueue, uploadItems, primeDates } from "./uploader.js";
import { context, onContextChange, navigate } from "./admin.js";

/* ---------- Google Photos Picker -------------------------------------- */

// A public OAuth *client id*, not a secret. Authorized origins are
// sparcsolutions.org and www.sparcsolutions.org, so the picker only works on
// production — not on Netlify deploy previews or localhost.
const GOOGLE_CLIENT_ID = "672621166742-d9e8iofm7ri6qop5t78a2hshtfh12bb5.apps.googleusercontent.com";
const GP_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const GP_BATCH = 40;

let gsiLoading = null;

/** Google Identity Services is only needed if the picker is actually used. */
function loadGsi() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gsiLoading) return gsiLoading;
  gsiLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Google sign-in."));
    document.head.append(script);
  });
  return gsiLoading;
}

/* ---------- state ------------------------------------------------------ */

let queue = [];
let rows = new Map();       // item.id -> row element
let uploading = false;
let host = null;

/* ---------- queue rendering ------------------------------------------- */

const STATE_LABEL = {
  queued: "Ready",
  resizing: "Preparing…",
  uploading: "Uploading…",
  committed: "Uploaded",
  failed: "Failed",
};

/**
 * Build a row once and keep it. Re-rendering the whole queue on every state
 * change is what made the old page steal focus while you were typing a
 * caption; here only the status text and the button state change.
 */
function buildRow(item) {
  const preview = el("img", { alt: "", src: URL.createObjectURL(item.file) });
  // Free the blob URL as soon as the browser has the pixels.
  preview.addEventListener("load", () => URL.revokeObjectURL(preview.src), { once: true });

  const captionId = `cap-${item.id}`;
  const altId = `alt-${item.id}`;

  const caption = el("input", {
    id: captionId, type: "text", placeholder: "Caption (shown under the photo)",
    "aria-label": `Caption for ${item.file.name}`,
    oninput: (event) => { item.caption = event.target.value; },
  });
  const alt = el("input", {
    id: altId, type: "text", placeholder: "Alt text (describes the photo for screen readers)",
    "aria-label": `Alt text for ${item.file.name}`,
    oninput: (event) => { item.alt_text = event.target.value; },
  });

  const featured = el("label.pga-check", null,
    el("input", {
      type: "checkbox",
      onchange: (event) => { item.featured = event.target.checked; },
    }),
    "Header scroll",
  );

  const status = el("span.pga-qstatus", { "dataset": { state: item.state }, text: STATE_LABEL[item.state] });
  const error = el("p.pga-error", { style: { margin: "0", fontSize: "0.78rem" } });

  const remove = el("button.pga-btn.pga-btn-ghost.pga-btn-sm", {
    type: "button",
    "aria-label": `Remove ${item.file.name} from the queue`,
    onclick: () => {
      queue = queue.filter((entry) => entry.id !== item.id);
      rows.get(item.id)?.remove();
      rows.delete(item.id);
      refreshQueueChrome();
    },
  }, "Remove");

  const row = el("div.pga-qitem", { "dataset": { id: item.id } },
    preview,
    el("div.pga-qfields", null,
      el("span", { text: item.file.name, style: { fontSize: "0.78rem", color: "var(--pga-muted)" } }),
      caption,
      alt,
      featured,
      error,
    ),
    el("div.pga-qside", null, status, remove),
  );

  row._refresh = () => {
    status.dataset.state = item.state;
    status.textContent = STATE_LABEL[item.state] || item.state;
    error.textContent = item.error || "";
    const locked = item.state === "committed";
    caption.disabled = locked;
    alt.disabled = locked;
    remove.hidden = locked;
    row.style.opacity = locked ? "0.6" : "1";
  };
  return row;
}

function renderQueue() {
  const list = host.querySelector("#pga-queue");
  list.replaceChildren();
  rows = new Map();
  for (const item of queue) {
    const row = buildRow(item);
    rows.set(item.id, row);
    list.append(row);
    row._refresh();
  }
  refreshQueueChrome();
}

function refreshQueueChrome() {
  const pendingCount = queue.filter((item) => item.state !== "committed").length;
  const failedCount = queue.filter((item) => item.state === "failed").length;

  const uploadBtn = host.querySelector("#pga-do-upload");
  const clearBtn = host.querySelector("#pga-clear-queue");
  const retryBtn = host.querySelector("#pga-retry-failed");
  const bar = host.querySelector("#pga-queue-actions");

  bar.hidden = queue.length === 0;
  uploadBtn.disabled = uploading || pendingCount === 0;
  uploadBtn.textContent = pendingCount
    ? `Upload ${plural(pendingCount, "photo")}`
    : "Upload";
  clearBtn.disabled = uploading;
  retryBtn.hidden = failedCount === 0 || uploading;
  retryBtn.textContent = `Retry ${plural(failedCount, "failure")}`;
}

function addFiles(fileList) {
  const { items, rejected } = buildQueue(fileList);
  if (rejected.length) {
    toast(`Skipped ${plural(rejected.length, "file")}: ${rejected[0].reason}${rejected.length > 1 ? ", and others" : ""}.`, { kind: "error" });
  }
  if (!items.length) return;
  queue = queue.concat(items);
  renderQueue();
  announce(`${plural(items.length, "photo")} added to the queue.`, { force: true });
  // EXIF dates in the background — they're only needed at commit time.
  primeDates(items).catch(() => {});
}

/* ---------- upload run ------------------------------------------------- */

async function runUpload() {
  if (!context.gallery) {
    toast("Choose an album first.", { kind: "error" });
    return;
  }
  const year = context.year;
  if (!year || year < 1990 || year > 2100) {
    toast("Set a valid year in the bar above first.", { kind: "error" });
    return;
  }

  uploading = true;
  refreshQueueChrome();

  const progressWrap = host.querySelector("#pga-progress");
  const fill = host.querySelector("#pga-progress-fill");
  const progressText = host.querySelector("#pga-progress-text");
  progressWrap.hidden = false;

  const result = await uploadItems(queue, {
    gallery: context.gallery,
    year,
    onItem: (item) => rows.get(item.id)?._refresh(),
    onProgress: (done, total) => {
      const pct = total ? Math.round((done / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      progressText.textContent = `${num(done)} of ${num(total)} processed`;
      announce(`Uploading: ${done} of ${total}.`);
    },
  });

  uploading = false;
  refreshQueueChrome();
  progressWrap.hidden = true;
  fill.style.width = "0%";

  const target = `${context.name()} ${year}`;
  if (result.committed && !result.failed) {
    toast(`Uploaded ${plural(result.committed, "photo")} to ${target}.`, { kind: "success" });
    announce(`Uploaded ${plural(result.committed, "photo")}.`, { force: true });
    // Drop the finished rows so the queue shows only what still needs doing.
    queue = queue.filter((item) => item.state !== "committed");
    renderQueue();
  } else if (result.committed) {
    toast(`Uploaded ${plural(result.committed, "photo")}; ${plural(result.failed, "failure")} left in the queue to retry.`, { kind: "error" });
    queue = queue.filter((item) => item.state !== "committed");
    renderQueue();
  } else {
    toast(`Nothing uploaded — ${plural(result.failed, "failure")}. Check the messages in the queue.`, { kind: "error" });
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
  refreshQueueChrome();
  await runUpload();
}

/* ---------- Google Photos --------------------------------------------- */

async function pickFromGooglePhotos(button, statusEl) {
  if (!context.gallery) { toast("Choose an album first.", { kind: "error" }); return; }
  const year = context.year;
  if (!year || year < 1990) { toast("Set a valid year first.", { kind: "error" }); return; }

  const setStatus = (message) => {
    statusEl.textContent = message || "";
    if (message) announce(message);
  };

  button.disabled = true;
  try {
    await loadGsi();
  } catch (err) {
    button.disabled = false;
    setStatus(err.message);
    return;
  }

  const token = await new Promise((resolve) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GP_SCOPE,
      callback: (response) => resolve(response?.access_token || null),
    });
    client.requestAccessToken();
  });

  if (!token) {
    button.disabled = false;
    setStatus("Google sign-in was cancelled.");
    return;
  }

  const gfetch = (url, options = {}) => fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });

  try {
    setStatus("Opening Google Photos…");
    const sessionRes = await gfetch("https://photospicker.googleapis.com/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const session = await sessionRes.json();
    if (!session?.id) throw new Error("Could not start the Google Photos picker.");

    window.open(session.pickerUri, "_blank", "noopener");

    const interval = Math.max(parseInt(String(session.pollingConfig?.pollInterval ?? "3"), 10) || 3, 2);
    setStatus("Waiting for you to choose photos in the Google Photos tab…");

    // Poll until the user finishes in the other tab. ~15 min ceiling.
    const deadline = Date.now() + 15 * 60 * 1000;
    let ready = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      const pollRes = await gfetch(`https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(session.id)}`);
      const poll = await pollRes.json().catch(() => ({}));
      if (poll?.mediaItemsSet) { ready = true; break; }
    }
    if (!ready) throw new Error("Timed out waiting for Google Photos.");

    setStatus("Loading your selection…");
    const picked = [];
    let pageToken = null;
    do {
      const url = new URL("https://photospicker.googleapis.com/v1/mediaItems");
      url.searchParams.set("sessionId", session.id);
      url.searchParams.set("pageSize", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const itemsRes = await gfetch(url.toString());
      const data = await itemsRes.json();
      for (const media of data.mediaItems || []) {
        const file = media.mediaFile || {};
        if (file.mimeType && !file.mimeType.startsWith("image/")) continue;   // skip video
        if (!file.baseUrl) continue;
        picked.push({
          image_url: `${file.baseUrl}=w2000`,
          external_id: media.id,
          taken_at: media.createTime || null,
        });
      }
      pageToken = data.nextPageToken || null;
    } while (pageToken);

    if (!picked.length) { setStatus("No photos were selected."); button.disabled = false; return; }

    let imported = 0;
    let failed = 0;
    for (let i = 0; i < picked.length; i += GP_BATCH) {
      const slice = picked.slice(i, i + GP_BATCH);
      try {
        const res = await api("import", {
          gallery: context.gallery,
          year,
          source: "google_photos",
          auth: token,      // used server-side for the fetch; never stored
          items: slice,
        });
        imported += res.imported || 0;
        failed += res.failed || 0;
      } catch {
        failed += slice.length;
      }
      setStatus(`Imported ${num(imported)} of ${num(picked.length)}…`);
    }
    setStatus(`Imported ${plural(imported, "photo")} from Google Photos${failed ? `, ${num(failed)} failed` : ""}.`);
    toast(`Imported ${plural(imported, "photo")} into ${context.name()} ${year}.`, { kind: imported ? "success" : "error" });
  } catch (err) {
    setStatus(err.message || "Google Photos import failed.");
  }
  button.disabled = false;
}

/* ---------- link import ----------------------------------------------- */

async function importLinks(textarea, sourceSelect, statusEl) {
  const urls = textarea.value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!urls.length) { toast("Paste at least one image link.", { kind: "error" }); return; }
  if (!context.gallery) { toast("Choose an album first.", { kind: "error" }); return; }
  const year = context.year;
  if (!year || year < 1990) { toast("Set a valid year first.", { kind: "error" }); return; }

  statusEl.textContent = `Importing ${plural(urls.length, "link")}…`;
  try {
    const res = await api("import", {
      gallery: context.gallery,
      year,
      source: sourceSelect.value,
      items: urls.map((url) => ({ image_url: url })),
    });
    statusEl.textContent = `Imported ${num(res.imported)}${res.failed ? `, ${num(res.failed)} failed` : ""}.`;
    if (res.imported) {
      textarea.value = "";
      toast(`Imported ${plural(res.imported, "photo")}.`, { kind: "success" });
    }
    if (res.failed) {
      toast(`${plural(res.failed, "link")} could not be imported. Only Google and Dropbox hosts are allowed.`, { kind: "error" });
    }
  } catch (err) {
    statusEl.textContent = "";
    toastError(err);
  }
}

/* ---------- video ------------------------------------------------------ */

async function addVideo(urlInput, captionInput, statusEl) {
  const url = urlInput.value.trim();
  if (!url) { toast("Paste a YouTube or Vimeo link first.", { kind: "error" }); return; }
  if (!context.gallery) { toast("Choose an album first.", { kind: "error" }); return; }
  const year = context.year;
  if (!year || year < 1990) { toast("Set a valid year first.", { kind: "error" }); return; }

  statusEl.textContent = "Adding…";
  try {
    await api("video-add", {
      gallery: context.gallery,
      year,
      video_url: url,
      caption: captionInput.value.trim(),
    });
    statusEl.textContent = "";
    urlInput.value = "";
    captionInput.value = "";
    toast(`Video added to ${context.name()} ${year}.`, { kind: "success" });
  } catch (err) {
    statusEl.textContent = "";
    toastError(err);
  }
}

/* ---------- mount ----------------------------------------------------- */

export function mount(view) {
  host = view;
  queue = [];
  rows = new Map();

  /* --- files --- */
  const fileInput = el("input", {
    type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true, hidden: true,
    onchange: (event) => { addFiles(event.target.files); event.target.value = ""; },
  });

  const drop = el("button.pga-drop", { type: "button" },
    el("strong", { text: "Drop photos here" }),
    el("br"),
    "or choose files — JPG, PNG or WEBP, up to 25 MB each",
  );
  drop.addEventListener("click", () => fileInput.click());
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

  const queueList = el("div.pga-queue", { id: "pga-queue" });

  const actions = el("div.pga-row", { id: "pga-queue-actions", hidden: true, style: { marginTop: "14px" } },
    el("button.pga-btn.pga-btn-primary", { type: "button", id: "pga-do-upload", onclick: runUpload }, "Upload"),
    el("button.pga-btn.pga-btn-outline", { type: "button", id: "pga-retry-failed", hidden: true, onclick: retryFailed }, "Retry failures"),
    el("button.pga-btn.pga-btn-ghost", {
      type: "button", id: "pga-clear-queue",
      onclick: () => { queue = []; renderQueue(); },
    }, "Clear queue"),
  );

  const progress = el("div", { id: "pga-progress", hidden: true },
    el("div.pga-progress", null, el("div.pga-progress-fill", { id: "pga-progress-fill" })),
    el("p.pga-muted", { id: "pga-progress-text", style: { fontSize: "0.85rem", margin: "0" } }),
  );

  const uploadPanel = el("div.pga-panel", null,
    el("h2", { text: "Upload photos" }),
    el("p.pga-hint", { text:
      "Photos go into the album and year selected above. Capture dates are read from each " +
      "photo automatically, so the header scroll stays in order through an event day. Add a " +
      "caption and alt text here and you won't have to come back to them later." }),
    drop,
    fileInput,
    queueList,
    actions,
    progress,
  );

  /* --- Google Photos + links --- */
  const gpStatus = el("span.pga-muted", { "role": "status", style: { fontSize: "0.88rem" } });
  const gpButton = el("button.pga-btn.pga-btn-blue", { type: "button" }, "Add from Google Photos");
  gpButton.addEventListener("click", () => pickFromGooglePhotos(gpButton, gpStatus));

  const linkArea = el("textarea", {
    id: "pga-import-urls", rows: "4",
    placeholder: "https://…/photo1.jpg\nhttps://…/photo2.jpg",
    "aria-describedby": "pga-import-hint",
  });
  const sourceSelect = el("select", { id: "pga-import-source" },
    el("option", { value: "google_photos", text: "Google Photos" }),
    el("option", { value: "gdrive", text: "Google Drive" }),
    el("option", { value: "dropbox", text: "Dropbox" }),
    el("option", { value: "upload", text: "Other" }),
  );
  const linkStatus = el("span.pga-muted", { "role": "status", style: { fontSize: "0.88rem" } });

  const importPanel = el("div.pga-panel", null,
    el("h2", { text: "Import from Google Photos or Drive" }),
    el("p.pga-hint", { text:
      "Pick photos in Google's own picker — including albums shared with you — and they are " +
      "copied into the album and year above. Capture dates come across automatically. This " +
      "only works on the live sparcsolutions.org site, not on preview links." }),
    el("div.pga-row", null, gpButton, gpStatus),
    el("hr.pga-sep"),
    el("h3", { text: "Import by link" }),
    el("p.pga-hint", { id: "pga-import-hint", text:
      "Paste image links, one per line. For security these must be Google or Dropbox " +
      "addresses — arbitrary hosts are rejected, so a link from somewhere else needs " +
      "downloading and uploading above instead." }),
    el("div.pga-field.grow", null, linkArea),
    el("div.pga-row", { style: { marginTop: "10px" } },
      el("div.pga-field", null, el("label", { for: "pga-import-source", text: "Source label" }), sourceSelect),
      el("button.pga-btn.pga-btn-blue", {
        type: "button",
        onclick: () => importLinks(linkArea, sourceSelect, linkStatus),
      }, "Import links"),
      linkStatus,
    ),
  );

  /* --- video --- */
  const videoUrl = el("input", { id: "pga-vid-url", type: "text", placeholder: "https://www.youtube.com/watch?v=…  or  https://vimeo.com/…" });
  const videoCaption = el("input", { id: "pga-vid-caption", type: "text", placeholder: "e.g. 2026 Gala highlight reel" });
  const videoStatus = el("span.pga-muted", { "role": "status", style: { fontSize: "0.88rem" } });

  const videoPanel = el("div.pga-panel", null,
    el("h2", { text: "Add a video" }),
    el("p.pga-hint", { text:
      "Paste a YouTube or Vimeo link and it appears in the album and year above, with its " +
      "thumbnail pulled in automatically. Videos play in the gallery lightbox — nothing is " +
      "uploaded to us, so there is no file-size limit." }),
    el("div.pga-row", null,
      el("div.pga-field.grow", null, el("label", { for: "pga-vid-url", text: "Video link" }), videoUrl),
      el("div.pga-field.grow", null, el("label", { for: "pga-vid-caption", text: "Caption (optional)" }), videoCaption),
    ),
    el("div.pga-row", { style: { marginTop: "10px" } },
      el("button.pga-btn.pga-btn-primary", {
        type: "button",
        onclick: () => addVideo(videoUrl, videoCaption, videoStatus),
      }, "Add video"),
      videoStatus,
    ),
  );

  const target = el("p.pga-hint", { id: "pga-upload-target" });
  const updateTarget = () => {
    target.textContent = context.gallery
      ? `Uploading to: ${context.name()} · ${context.year}${context.isPublic() ? "" : " (private album — not shown on the website)"}`
      : "No album selected.";
  };
  updateTarget();
  const unsubscribe = onContextChange(updateTarget);
  // The shell replaces the view's children on tab change; drop the listener
  // then so we don't leak one per visit.
  new MutationObserver((_records, observer) => {
    if (!view.contains(uploadPanel)) { unsubscribe(); observer.disconnect(); }
  }).observe(view, { childList: true });

  if (!context.categories.length) {
    view.replaceChildren(emptyState({
      title: "No albums yet",
      body: "Create an album before uploading photos.",
      action: { label: "Go to Settings", run: () => navigate("settings") },
    }));
    return;
  }

  view.replaceChildren(target, uploadPanel, importPanel, videoPanel);
}
