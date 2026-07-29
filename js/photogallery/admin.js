/* ==========================================================================
   photo-gallery admin — app shell
   --------------------------------------------------------------------------
   Owns sign-in, the tab bar, hash routing, the album/year context bar, and
   the Dashboard + Settings views. The heavier views live in sibling modules
   and are imported lazily on first visit, so opening the page doesn't pull
   in the face-recognition code.

   Markup contract (photogallery/admin/index.html):
     #pga-login / #pga-login-form / #pga-pw / #pga-login-err / #pga-login-btn
     #pga-app / #pga-tabs / #pga-view
     #pga-ctx-gallery / #pga-ctx-year / #pga-new-category
     #pga-signout / #pga-view-public

   Routing: #/<tab>?<params>. State that belongs to a view (filter, page,
   search) lives in the query part so a reload keeps your place and the Back
   button works — e.g. #/library?filter=needs_alt&page=2.
   ========================================================================== */

import { api, signIn, signOut, hasToken, onAuthLost, PGError } from "./api.js";
import {
  el, toast, toastError, announce, confirmDialog, promptDialog, emptyState,
  loadingState, num, plural,
} from "./ui.js";

/* ---------- shared context -------------------------------------------- */

const CTX_KEY = "pg_admin_context";

/**
 * The one place views read the selected album + year from. Persisted so a
 * reload doesn't dump you back on a different album (the old page hardcoded
 * the year to 2025 and reset the album on every load).
 */
export const context = {
  categories: [],
  gallery: "",
  year: new Date().getFullYear(),

  name(slug) {
    const found = this.categories.find((c) => c.slug === (slug ?? this.gallery));
    return found ? found.name : (slug ?? this.gallery);
  },
  isPublic(slug) {
    const found = this.categories.find((c) => c.slug === (slug ?? this.gallery));
    return !!(found && found.is_public);
  },
  save() {
    try {
      localStorage.setItem(CTX_KEY, JSON.stringify({ gallery: this.gallery, year: this.year }));
    } catch { /* private mode */ }
  },
  restore() {
    try {
      const raw = JSON.parse(localStorage.getItem(CTX_KEY) || "{}");
      if (raw.gallery) this.gallery = raw.gallery;
      if (raw.year) this.year = Number(raw.year) || this.year;
    } catch { /* ignore malformed */ }
  },
};

/** Views subscribe to album/year changes rather than polling the selects. */
const contextListeners = new Set();
export function onContextChange(fn) {
  contextListeners.add(fn);
  return () => contextListeners.delete(fn);
}
function emitContextChange() {
  context.save();
  for (const fn of contextListeners) {
    try { fn(context); } catch (err) { console.error(err); }
  }
}

/* ---------- routing ---------------------------------------------------- */

const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "upload", label: "Upload" },
  { id: "library", label: "Library" },
  { id: "people", label: "People & Faces" },
  { id: "review", label: "Review" },
  { id: "settings", label: "Settings" },
];

/** Views that don't act on a single album hide the context bar. */
const CONTEXT_TABS = new Set(["upload", "library"]);

const loaders = {
  dashboard: () => Promise.resolve({ mount: mountDashboard }),
  settings: () => Promise.resolve({ mount: mountSettings }),
  upload: () => import("./admin-upload.js"),
  library: () => import("./admin-library.js").then((m) => ({ mount: m.mountLibrary })),
  review: () => import("./admin-library.js").then((m) => ({ mount: m.mountReview })),
  people: () => import("./admin-people.js"),
};

/** Parsed from the hash: {tab, params: URLSearchParams}. */
export function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [tabPart, queryPart] = raw.split("?");
  const tab = TABS.some((t) => t.id === tabPart) ? tabPart : "dashboard";
  return { tab, params: new URLSearchParams(queryPart || "") };
}

/**
 * Update the query part of the current route without adding history noise.
 * `replace` is right for incidental state (a page change); a real navigation
 * pushes, so Back returns where the user expects.
 */
export function setRouteParams(updates, { replace = true } = {}) {
  const { tab, params } = currentRoute();
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === "") params.delete(key);
    else params.set(key, String(value));
  }
  const query = params.toString();
  const hash = `#/${tab}${query ? `?${query}` : ""}`;
  if (replace) history.replaceState(null, "", hash);
  else location.hash = hash;
}

export function navigate(tab, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  location.hash = `#/${tab}${query ? `?${query}` : ""}`;
}

const mounted = new Map();   // tab -> module
let activeTab = null;

async function renderRoute() {
  const { tab, params } = currentRoute();
  const view = document.getElementById("pga-view");

  for (const btn of document.querySelectorAll(".pga-tab")) {
    const isCurrent = btn.dataset.tab === tab;
    if (isCurrent) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }

  document.getElementById("pga-context").hidden = !CONTEXT_TABS.has(tab);

  // Route in the title so browser history is readable; some screen readers
  // announce a title change on navigation.
  document.title = `${TABS.find((t) => t.id === tab)?.label || "Admin"} | Photo Gallery Admin | SPARC`;

  if (tab !== activeTab) {
    activeTab = tab;
    view.replaceChildren(loadingState());
    let module = mounted.get(tab);
    if (!module) {
      try {
        module = await loaders[tab]();
        mounted.set(tab, module);
      } catch (err) {
        console.error(err);
        view.replaceChildren(emptyState({
          title: "Could not load this section",
          body: "Reload the page and try again. If it keeps happening, the browser may have blocked a script.",
        }));
        return;
      }
    }
    // A slow import can be overtaken by another tab click.
    if (currentRoute().tab !== tab) return;
    view.replaceChildren();
    await module.mount(view, params);
  } else {
    const module = mounted.get(tab);
    if (module && module.onParams) module.onParams(params);
  }
}

/* ---------- tab bar --------------------------------------------------- */

/**
 * Counts on the tab labels. The visible pill is aria-hidden and the count is
 * folded into the button's accessible name instead, so a screen reader hears
 * "Review, 8 waiting" rather than "Review 8".
 */
export function setTabCount(tab, count, { attention = false, noun = "waiting" } = {}) {
  const btn = document.querySelector(`.pga-tab[data-tab="${tab}"]`);
  if (!btn) return;
  const pill = btn.querySelector(".pga-tab-count");
  const label = TABS.find((t) => t.id === tab)?.label || tab;
  if (!count) {
    if (pill) pill.remove();
    btn.setAttribute("aria-label", label);
    return;
  }
  const node = pill || el("span.pga-tab-count", { "aria-hidden": "true" });
  node.textContent = num(count);
  node.classList.toggle("attn", attention);
  if (!pill) btn.append(node);
  btn.setAttribute("aria-label", `${label}, ${num(count)} ${noun}`);
}

/**
 * Real anchors, not buttons: these are routed views, so middle-click,
 * copy-link and "open in new tab" should all work. Deliberately NOT
 * role="tablist" — ARIA tabs would impose arrow-key semantics and break the
 * deep-link story. aria-current="page" marks the active view instead.
 */
function buildTabs() {
  const nav = document.getElementById("pga-tabs");
  nav.replaceChildren(...TABS.map((tab) => el("a.pga-tab", {
    href: `#/${tab.id}`,
    "dataset": { tab: tab.id },
    "aria-label": tab.label,
  }, el("span", { text: tab.label }))));
}

/* ---------- context bar ----------------------------------------------- */

function fillCategorySelect() {
  const select = document.getElementById("pga-ctx-gallery");
  select.replaceChildren(...context.categories.map((cat) => el("option", {
    value: cat.slug,
    // "· private" marks albums the public site never serves, so it's clear
    // why an upload isn't showing up on the website.
    text: cat.is_public ? cat.name : `${cat.name} · private`,
  })));
  if (!context.categories.some((c) => c.slug === context.gallery)) {
    context.gallery = context.categories[0]?.slug || "";
  }
  select.value = context.gallery;
  updatePublicLink();
}

function updatePublicLink() {
  const link = document.getElementById("pga-view-public");
  if (context.isPublic()) {
    link.href = `/photogallery/${context.gallery}/`;
    link.textContent = `View ${context.name()} →`;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

function wireContextBar() {
  const gallerySelect = document.getElementById("pga-ctx-gallery");
  const yearInput = document.getElementById("pga-ctx-year");

  yearInput.value = String(context.year);

  gallerySelect.addEventListener("change", () => {
    context.gallery = gallerySelect.value;
    updatePublicLink();
    emitContextChange();
  });

  yearInput.addEventListener("change", () => {
    const value = parseInt(yearInput.value, 10);
    if (Number.isNaN(value) || value < 1990 || value > 2100) {
      yearInput.setAttribute("aria-invalid", "true");
      toast("Enter a year between 1990 and 2100.", { kind: "error" });
      return;
    }
    yearInput.removeAttribute("aria-invalid");
    context.year = value;
    emitContextChange();
  });

  document.getElementById("pga-new-category").addEventListener("click", createCategory);
}

export async function createCategory() {
  const name = await promptDialog({
    title: "New album",
    label: "Album name",
    placeholder: "e.g. Community Events",
    hint: "New albums start private — nothing in them appears on the public site until you make the album public in Settings.",
    confirmLabel: "Create album",
  });
  if (!name) return null;
  try {
    const res = await api("category-create", { name, is_public: false });
    await loadCategories();
    context.gallery = res.category.slug;
    document.getElementById("pga-ctx-gallery").value = context.gallery;
    updatePublicLink();
    emitContextChange();
    toast(`Created “${res.category.name}” as a private album.`, { kind: "success" });
    return res.category;
  } catch (err) {
    if (err instanceof PGError && err.status === 409) {
      toast("An album with that name already exists.", { kind: "error" });
    } else {
      toastError(err);
    }
    return null;
  }
}

export async function loadCategories() {
  const res = await api("categories");
  context.categories = res.categories || [];
  fillCategorySelect();
  return context.categories;
}

/* ---------- dashboard ------------------------------------------------- */

/**
 * Exact row counts, using the head-count `total` that `list-admin` returns.
 * limit:1 keeps the payload tiny — we only want the count.
 */
async function countFor(filter) {
  const res = await api("list-admin", { filter, limit: 1 });
  return res.total || 0;
}

async function mountDashboard(view) {
  const cards = el("div.pga-cards");
  const panel = el("div.pga-panel", null,
    el("h2", { text: "What needs doing" }),
    el("p.pga-hint", { text: "Counts cover every album. Select one to jump straight to that work." }),
    cards,
  );
  view.replaceChildren(panel);
  cards.replaceChildren(loadingState("Counting…"));

  try {
    const [needsAlt, unpublished, untagged, faces] = await Promise.all([
      countFor("needs_alt"),
      countFor("unpublished"),
      countFor("untagged"),
      api("faces-status").then((r) => r, () => null),
    ]);

    const tiles = [
      {
        n: needsAlt,
        label: "need alt text",
        sub: "Screen-reader descriptions missing",
        tab: "library",
        params: { filter: "needs_alt" },
        attention: needsAlt > 0,
      },
      {
        n: faces ? faces.suggested_count : 0,
        label: "faces to confirm",
        sub: "Suggested names waiting on a yes or no",
        tab: "people",
        params: { panel: "triage" },
        attention: !!(faces && faces.suggested_count),
      },
      {
        n: faces ? faces.unnamed_count : 0,
        label: "unnamed faces",
        sub: "Nobody has said who these are yet",
        tab: "people",
        params: { panel: "unknown" },
      },
      {
        n: unpublished,
        label: "awaiting review",
        sub: "Hidden from the site until approved",
        tab: "review",
        params: {},
        attention: unpublished > 0,
      },
      {
        n: faces ? faces.unscanned_count : 0,
        label: "not scanned for faces",
        sub: "Run a scan to find people in these",
        tab: "people",
        params: { panel: "scan" },
      },
      {
        n: untagged,
        label: "have nobody tagged",
        sub: "Not findable by a person's name",
        tab: "library",
        params: { filter: "untagged" },
      },
    ];

    setTabCount("review", unpublished, { attention: true, noun: "awaiting review" });
    setTabCount("people", faces ? faces.suggested_count : 0, { attention: true, noun: "faces to confirm" });

    cards.replaceChildren(...tiles.map((tile) => {
      const link = el(`a.pga-card${tile.attention ? ".attn" : (tile.n === 0 ? ".done" : "")}`, {
        href: "#",
        onclick: (event) => { event.preventDefault(); navigate(tile.tab, tile.params); },
      },
        el("span.pga-card-n", { text: num(tile.n) }),
        el("span.pga-card-label", { text: tile.label }),
        el("span.pga-card-sub", { text: tile.sub }),
      );
      link.setAttribute("aria-label", `${num(tile.n)} ${tile.label}. ${tile.sub}.`);
      return link;
    }));

    if (faces === null) {
      cards.append(el("p.pga-hint", { text: "Face counts could not be loaded." }));
    }
  } catch (err) {
    cards.replaceChildren(emptyState({
      title: "Could not load the summary",
      body: err.message,
      icon: null,
    }));
  }
}

/* ---------- settings -------------------------------------------------- */

/**
 * Tier 3 rollout panel: compute ArcFace embeddings for the existing library and
 * switch matching over — both reversible, both driven from here. Everything the
 * ArcFace model needs (its ~90 MB weights, TensorFlow.js, the landmark net) is
 * imported lazily, only when someone actually runs the pass.
 */
function buildRecognizerPanel() {
  const panel = el("div.pga-panel");
  const statusLine = el("p.pga-hint", { "role": "status", style: { margin: "0 0 12px" } });
  const bar = el("div.pga-progress", { hidden: true }, el("div.pga-progress-fill"));
  const progressText = el("p.pga-muted", { "role": "status", style: { fontSize: "0.88rem", margin: "6px 0 0" } });
  const fill = bar.querySelector(".pga-progress-fill");

  const embedBtn = el("button.pga-btn.pga-btn-blue", { type: "button" }, "Compute ArcFace embeddings");
  const stopBtn = el("button.pga-btn.pga-btn-outline", { type: "button", hidden: true }, "Stop");
  const switchBtn = el("button.pga-btn.pga-btn-primary", { type: "button" }, "Switch matching to ArcFace");

  let st = null;
  let abort = null;

  async function refresh() {
    try {
      st = await api("recognizer-status");
      const active = st.recognizer === "arcface" ? "ArcFace (high-accuracy)" : "face-api (default)";
      statusLine.replaceChildren(
        el("strong", { text: `Active recognizer: ${active}` }),
        el("br"),
        el("span", { text: `${num(st.embedded_v2)} of ${num(st.total_faces)} faces have an ArcFace embedding.` }),
      );
      switchBtn.textContent = st.recognizer === "arcface" ? "Switch back to face-api" : "Switch matching to ArcFace";
      switchBtn.disabled = st.recognizer !== "arcface" && (st.embedded_v2 || 0) === 0;
    } catch (err) { statusLine.textContent = err.message; }
  }

  async function runEmbed() {
    embedBtn.hidden = true; stopBtn.hidden = false; bar.hidden = false;
    abort = new AbortController();
    const signal = abort.signal;
    let done = 0, failed = 0, before = null;
    try {
      const [{ loadFaceApi }, arc] = await Promise.all([
        import("./faces.js"), import("./faces-arcface.js"),
      ]);
      await loadFaceApi((m) => { progressText.textContent = m; });
      await arc.loadArcFace((m) => { progressText.textContent = m; });
      const total = st ? st.total_faces : 0;
      for (;;) {
        if (signal.aborted) break;
        const res = await api("faces-need-embed", before ? { limit: 40, before } : { limit: 40 });
        const faces = res.faces || [];
        if (!faces.length) break;
        before = faces[faces.length - 1].created_at;
        const items = [];
        for (const f of faces) {
          if (signal.aborted) break;
          try {
            const emb = await arc.embedFace(f.image_url, f.box);
            if (emb) items.push({ face_id: f.id, embedding_v2: emb });
            else failed++;
          } catch { failed++; }
          done++;
          progressText.textContent = `Embedded ${num(done)}${total ? ` of ${num(total)}` : ""}${failed ? ` · ${num(failed)} skipped` : ""}`;
          if (total) fill.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
        }
        if (items.length) {
          try { await api("faces-embed-batch", { items }); } catch (err) { toastError(err); }
        }
      }
      fill.style.width = "100%";
      progressText.textContent = signal.aborted
        ? `Stopped — ${num(done - failed)} embedded, ${num(failed)} skipped.`
        : `Done — ${num(done - failed)} embedded${failed ? `, ${num(failed)} had no detectable face and were skipped` : ""}.`;
      toast(signal.aborted ? "Stopped." : "Embedding pass complete.", { kind: "success" });
    } catch (err) {
      toastError(err);
    }
    embedBtn.hidden = false; stopBtn.hidden = true; abort = null;
    await refresh();
  }

  embedBtn.addEventListener("click", () => runEmbed());
  stopBtn.addEventListener("click", () => abort?.abort());

  switchBtn.addEventListener("click", async () => {
    const toArc = !st || st.recognizer !== "arcface";
    const ok = await confirmDialog({
      title: toArc ? "Switch matching to ArcFace?" : "Switch back to face-api?",
      body: toArc
        ? "New confirmations and suggestions will use the high-accuracy ArcFace model. Only faces that already have an ArcFace embedding can be matched, so run the embedding pass first. Suggestions are recomputed now, and you can switch back at any time."
        : "Matching returns to the default face-api model. Nothing is lost — the ArcFace embeddings are kept. Suggestions are recomputed now.",
      confirmLabel: toArc ? "Switch to ArcFace" : "Switch back",
    });
    if (!ok) return;
    switchBtn.disabled = true;
    try {
      await api("recognizer-set", { recognizer: toArc ? "arcface" : "faceapi" });
      progressText.textContent = "Recomputing suggestions in the new model…";
      const rs = await api("resuggest");
      toast(`Switched. Updated ${plural(rs.updated ?? 0, "suggestion")}.`, { kind: "success" });
    } catch (err) { toastError(err); }
    await refresh();
  });

  panel.append(
    el("h2", { text: "High-accuracy recognizer (beta)" }),
    el("p.pga-hint", { html:
      "The default recognizer (face-api) is fast and runs everywhere. <strong>ArcFace</strong> is a stronger model, much better at telling similar-looking people apart. It's opt-in and reversible: compute embeddings for your existing faces, switch matching over, and switch back any time — nothing is deleted either way." }),
    el("p.pga-hint", { html:
      "<strong>Beta:</strong> the ArcFace model must be vendored first (see <code>js/photogallery/faceapi/arcface/README.md</code>) and its thresholds tuned on real photos. Try it on a test album before relying on it." }),
    statusLine,
    el("div.pga-row", null, embedBtn, stopBtn, switchBtn),
    bar, progressText,
  );
  refresh();
  return panel;
}

async function mountSettings(view) {
  const albums = el("div.pga-stack");

  const albumPanel = el("div.pga-panel", null,
    el("h2", { text: "Albums" }),
    el("p.pga-hint", { text: "Public albums appear on the website at /photogallery/. Private albums are only visible here — useful for staging a batch, or for testing." }),
    albums,
    el("div.pga-row", { style: { marginTop: "16px" } },
      el("button.pga-btn.pga-btn-primary", { type: "button", onclick: createCategory }, "+ New album"),
    ),
  );

  async function patchCategory(cat, patch, describe) {
    try {
      await api("category-update", { slug: cat.slug, patch });
      await loadCategories();
      renderAlbums();
      emitContextChange();
      toast(describe, { kind: "success" });
    } catch (err) {
      toastError(err);
    }
  }

  function renderAlbums() {
    albums.replaceChildren(...context.categories.map((cat) => el("div.pga-toolbar", null,
      el("span.pga-toolbar-count", { text: cat.name }),
      cat.is_public
        ? el("span.pga-badge.pga-badge-featured", { text: "Public" })
        : el("span.pga-badge.pga-badge-hidden", { text: "Private" }),
      el("code", { text: `/${cat.slug}/`, style: { fontSize: "0.82rem", color: "var(--pga-muted)" } }),
      el("button.pga-btn.pga-btn-ghost.pga-btn-sm", {
        type: "button",
        onclick: async () => {
          const name = await promptDialog({
            title: "Rename album", label: "Album name", value: cat.name, confirmLabel: "Save",
            hint: "Only the display name changes. The web address stays the same, so existing links keep working.",
          });
          if (!name || name === cat.name) return;
          patchCategory(cat, { name }, `Renamed to “${name}”.`);
        },
      }, "Rename"),
      cat.is_public
        ? el("button.pga-btn.pga-btn-ghost.pga-btn-sm", {
            type: "button",
            onclick: async () => {
              const ok = await confirmDialog({
                title: `Make “${cat.name}” private?`,
                body: "The album disappears from the public website immediately. Nothing is deleted, and you can make it public again at any time.",
                confirmLabel: "Make private",
                danger: true,
              });
              if (ok) patchCategory(cat, { is_public: false }, `“${cat.name}” is now private.`);
            },
          }, "Make private")
        : el("button.pga-btn.pga-btn-primary.pga-btn-sm", {
            type: "button",
            onclick: async () => {
              const ok = await confirmDialog({
                title: `Publish “${cat.name}”?`,
                body: `Every approved photo in this album becomes visible to the public at /photogallery/${cat.slug}/. Hidden photos stay hidden.`,
                confirmLabel: "Publish album",
              });
              if (ok) patchCategory(cat, { is_public: true }, `“${cat.name}” is now on the website.`);
            },
          }, "Publish"),
    )));
  }
  renderAlbums();

  const maintenance = el("div.pga-panel", null,
    el("h2", { text: "Maintenance" }),
    el("p.pga-hint", { text: "Recomputing suggestions re-checks every unnamed face against everyone you've confirmed so far. It runs automatically after each confirmation, so you rarely need this — reach for it after merging people, or after a big import." }),
    el("div.pga-row", null,
      el("button.pga-btn.pga-btn-blue", {
        type: "button",
        onclick: async (event) => {
          const btn = event.currentTarget;
          btn.disabled = true;
          btn.textContent = "Recomputing…";
          try {
            const res = await api("resuggest");
            toast(`Updated ${plural(res.updated, "suggestion")}.`, { kind: "success" });
          } catch (err) {
            toastError(err);
          }
          btn.disabled = false;
          btn.textContent = "Recompute face suggestions";
        },
      }, "Recompute face suggestions"),
    ),
  );

  const thumbs = buildThumbBackfill();

  const access = el("div.pga-panel", null,
    el("h2", { text: "Access" }),
    el("p.pga-hint", { html:
      "There are two passphrases. The <strong>admin passphrase</strong> (this page) can do everything. " +
      "The <strong>photographer passphrase</strong> only works at <code>/photogallery/upload/</code> and can " +
      "only add photos — submissions land in <em>Review</em> unpublished, and it cannot edit or delete anything. " +
      "Share that one with photographers instead of the admin passphrase." }),
    el("p.pga-hint", { html:
      "Both are stored only as SHA-256 hashes. To rotate one, compute the hash and update " +
      "<code>photo_gallery_config</code> — the exact SQL is in " +
      "<code>supabase/functions/photo-gallery/README.md</code>." }),
    el("div.pga-row", null,
      el("button.pga-btn.pga-btn-ghost", {
        type: "button",
        onclick: () => signOut(),
      }, "Sign out of this browser"),
    ),
  );

  view.replaceChildren(albumPanel, thumbs, maintenance, buildRecognizerPanel(), access);
}

/**
 * Generate the missing thumbnails that imports leave behind.
 *
 * The `import` action re-hosts external images but can't render a thumbnail —
 * there's no image library in the edge runtime — so those rows carry
 * thumb_path null and serve their full-size image into every grid. The browser
 * renders them here and PUTs to signed URLs, exactly like a normal upload:
 * thumb-urls → canvas → PUT → thumb-commit.
 */
function buildThumbBackfill() {
  const status = el("p.pga-hint", { "role": "status", style: { margin: "0 0 12px" } });
  const bar = el("div.pga-progress", { hidden: true }, el("div.pga-progress-fill"));
  const fill = bar.querySelector(".pga-progress-fill");
  const runBtn = el("button.pga-btn.pga-btn-blue", { type: "button" }, "Generate missing thumbnails");
  let cancel = false;

  async function count() {
    try {
      const res = await api("list-admin", { filter: "no_thumb", limit: 1 });
      return res.total || 0;
    } catch { return null; }
  }

  async function refreshCount() {
    const n = await count();
    status.textContent = n == null
      ? "Could not check for missing thumbnails."
      : n === 0
        ? "Every photo has a thumbnail. Nothing to do."
        : `${plural(n, "photo")} ${n === 1 ? "has" : "have"} no thumbnail and ${n === 1 ? "is" : "are"} loading at full size in grids.`;
    runBtn.disabled = !n;
  }

  runBtn.addEventListener("click", async () => {
    // Lazily imported so the resize code isn't pulled into the shell bundle.
    const { thumbnail } = await import("./imaging.js");
    const { putSigned } = await import("./api.js");

    cancel = false;
    runBtn.disabled = true;
    runBtn.textContent = "Generating…";
    bar.hidden = false;

    let done = 0;
    let failed = 0;
    const total = (await count()) || 0;

    try {
      // Re-query each round rather than paging by offset: a committed thumbnail
      // leaves the "no_thumb" set, so an offset would skip work.
      for (;;) {
        if (cancel) break;
        const page = await api("list-admin", { filter: "no_thumb", limit: 25 });
        const photos = page.photos || [];
        if (!photos.length) break;

        const urls = await api("thumb-urls", { ids: photos.map((p) => p.id) });
        const commit = [];
        for (const slot of urls.uploads || []) {
          if (cancel) break;
          status.textContent = `Generating ${num(done + 1)} of ${num(total)}…`;
          fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
          try {
            // Fetch the stored original, render a 400px JPEG, PUT it back.
            const response = await fetch(slot.image_url);
            if (!response.ok) throw new Error(`could not read the image (${response.status})`);
            const rendered = await thumbnail(await response.blob());
            await putSigned(slot.thumb.signedUrl, rendered.blob, rendered.contentType);
            commit.push({ id: slot.id, thumb_path: slot.thumb.path });
          } catch {
            failed++;
          }
          done++;
        }

        if (commit.length) {
          const res = await api("thumb-commit", { items: commit });
          failed += (res.skipped || []).length;
        }
        // Nothing succeeded this round — stop rather than looping forever on
        // rows we can never thumbnail.
        if (!commit.length) break;
      }
      fill.style.width = "100%";
      status.textContent = failed
        ? `Done — generated ${num(done - failed)}, ${num(failed)} could not be generated.`
        : `Done — generated ${plural(done, "thumbnail")}.`;
      announce(status.textContent, { force: true });
      if (done - failed > 0) toast(`Generated ${plural(done - failed, "thumbnail")}.`, { kind: "success" });
    } catch (err) {
      toastError(err);
    }

    bar.hidden = true;
    fill.style.width = "0%";
    runBtn.textContent = "Generate missing thumbnails";
    await refreshCount();
  });

  const panel = el("div.pga-panel", null,
    el("h2", { text: "Thumbnails" }),
    el("p.pga-hint", { text:
      "Photos imported from Google Photos or Drive arrive without a thumbnail, because " +
      "thumbnails are made in the browser rather than on the server. Until one exists, " +
      "those photos load at full size in the gallery grid, which is slow on a phone. " +
      "This renders the missing ones. Safe to re-run — it only ever fills in what's absent." }),
    status,
    el("div.pga-row", null, runBtn),
    bar,
  );
  refreshCount();
  return panel;
}

/* ---------- sign-in --------------------------------------------------- */

function showLogin(message) {
  document.getElementById("pga-app").hidden = true;
  document.getElementById("pga-login").hidden = false;
  document.getElementById("pga-signout").hidden = true;
  document.getElementById("pga-view-public").hidden = true;
  if (message) document.getElementById("pga-login-err").textContent = message;
  document.getElementById("pga-pw").focus();
}

async function showApp() {
  document.getElementById("pga-login").hidden = true;
  document.getElementById("pga-app").hidden = false;
  document.getElementById("pga-signout").hidden = false;
  await renderRoute();
}

function wireLogin() {
  const form = document.getElementById("pga-login-form");
  const input = document.getElementById("pga-pw");
  const error = document.getElementById("pga-login-err");
  const button = document.getElementById("pga-login-btn");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    input.removeAttribute("aria-invalid");
    const value = input.value.trim();
    if (!value) {
      input.setAttribute("aria-invalid", "true");
      error.textContent = "Enter the passphrase.";
      return;
    }
    button.disabled = true;
    button.textContent = "Signing in…";
    try {
      context.categories = await signIn(value);
      input.value = "";
      fillCategorySelect();
      document.getElementById("pga-ctx-gallery").value = context.gallery;
      await showApp();
    } catch (err) {
      input.setAttribute("aria-invalid", "true");
      error.textContent = err.status === 401
        ? "That passphrase wasn't recognised."
        : err.message;
      input.focus();
      input.select();
    }
    button.disabled = false;
    button.textContent = "Sign in";
  });

  document.getElementById("pga-signout").addEventListener("click", () => signOut());
}

/* ---------- boot ------------------------------------------------------ */

async function boot() {
  context.restore();
  buildTabs();
  wireContextBar();
  wireLogin();

  // A 401 from any view means the passphrase changed under us.
  onAuthLost(() => showLogin("Your session has expired. Please sign in again."));

  window.addEventListener("hashchange", () => { renderRoute(); });

  if (!location.hash) history.replaceState(null, "", "#/dashboard");

  if (!hasToken()) {
    showLogin();
    return;
  }

  // Re-validate the stored token before showing the app, so a rotated
  // passphrase surfaces as a sign-in prompt rather than as failing views.
  try {
    await loadCategories();
    document.getElementById("pga-ctx-gallery").value = context.gallery;
    await showApp();
  } catch (err) {
    if (err instanceof PGError && err.status === 401) return;   // onAuthLost handled it
    showLogin(err.message);
  }
}

boot();
