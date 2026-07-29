/* ==========================================================================
   photo-gallery admin — People & Faces
   --------------------------------------------------------------------------
   Four panels, switched by chips and deep-linked via #/people?panel=…

     scan    — find faces in photos that haven't been scanned
     triage  — the confirm/reject queue for suggested names  (the flagship)
     unknown — the "who is this?" pile: faces with no suggestion
     roster  — the people list: rename, merge duplicates, hide, delete

   The model is suggest → human confirms. Naming a face does not write that
   name across the database: a confirmed face becomes an *exemplar* for that
   person, recognition improves with use, and every unnamed face gets a
   suggestion that a human accepts or refuses. Rejections are remembered per
   (face, person) so a wrong guess is never offered again.

   One honesty constraint drives the triage UI: the API has no `face-unreject`.
   A confirm can be undone (face-unconfirm); a reject cannot. So Reject is
   labelled for what it is and is deliberately given no Undo, rather than
   offering a button that would silently fail.

   None of this existed in the previous admin page — it called `faces-name`
   and `faces-unnamed`, which v2 removed, so every request 400'd.
   ========================================================================== */

import { api, PGError } from "./api.js";
import {
  el, toast, toastError, announce, dialog, confirmDialog, promptDialog,
  emptyState, loadingState, num, plural, debounce,
} from "./ui.js";
import { context, setRouteParams, setTabCount } from "./admin.js";
import { loadFaceApi, detectFaces, confidenceLabel, toPixelBox } from "./faces.js";
import { faceCropUrl } from "./imaging.js";

const PANELS = [
  { id: "triage", label: "Confirm names" },
  { id: "unknown", label: "Who is this?" },
  { id: "roster", label: "People" },
  { id: "scan", label: "Scan for faces" },
];

let host = null;
let body = null;
let activePanel = "triage";
let status = { unscanned_count: 0, unnamed_count: 0, suggested_count: 0 };
/** Roster cache, for autocomplete. Refreshed after any change. */
let people = [];

/* ---------- shared helpers -------------------------------------------- */

async function refreshStatus() {
  try {
    const res = await api("faces-status");
    status = res;
    setTabCount("people", res.suggested_count, { attention: true, noun: "faces to confirm" });
    for (const panel of PANELS) {
      const chip = host?.querySelector(`[data-panel="${panel.id}"] .pga-chip-count`);
      if (!chip) continue;
      const value = panel.id === "triage" ? res.suggested_count
        : panel.id === "unknown" ? res.unnamed_count - res.suggested_count
        : panel.id === "scan" ? res.unscanned_count
        : null;
      chip.textContent = value == null ? "" : num(Math.max(0, value));
    }
  } catch { /* counts are advisory */ }
}

async function refreshPeople() {
  try {
    const res = await api("people-list", { limit: 500 });
    people = res.people || [];
  } catch { /* autocomplete degrades to free text */ }
  const list = document.getElementById("pga-people-list");
  if (list) {
    list.replaceChildren(...people.map((person) => el("option", { value: person.display_name })));
  }
  return people;
}

/** Resolve typed text to an existing person, case-insensitively. */
function findPerson(name) {
  const needle = String(name || "").trim().toLowerCase();
  return people.find((p) => p.display_name.toLowerCase() === needle) || null;
}

/**
 * A face crop as an <img>. Boxes are fractions, so this is correct against
 * whichever rendition the API handed us.
 */
function faceImage(face, size, altText, { fixedWidth = null } = {}) {
  const img = el("img.pga-facecrop", {
    alt: altText || "",
    // A fixed width keeps a crop from claiming a whole flex row; the roster
    // cards lay the name out beside the cover, so they pass one.
    style: fixedWidth
      ? { width: `${fixedWidth}px`, height: `${fixedWidth}px`, flexShrink: "0" }
      : { width: "100%", height: "auto" },
  });
  faceCropUrl(face.image_url, face.box, size)
    .then((url) => { img.src = url; })
    .catch(() => { img.alt = "Could not load this face"; });
  return img;
}

/* ---------- "tag one → tag the rest" cascade -------------------------- */

// Confirming a face teaches recognition, so the rest of that person's photos
// immediately pick up suggestions. Rather than make someone press "Yes" on all
// hundred of them one at a time, we sweep them up right after the first
// confirmation:
//   distance ≤ AUTO_MAX ("Very likely") → auto-confirmed silently, batch-Undo
//   AUTO_MAX‥suggestion ceiling         → shown pre-checked for a single glance
// The grid keeps the promise that a human confirms every name, while collapsing
// a hundred keystrokes into one or two.
const AUTO_MAX = 0.36;

// One sweep at a time: a fast Y-Y-Y in the triage queue must not stack two
// review grids on top of each other. While a sweep is in flight, later
// confirmations still succeed — they just don't launch their own sweep.
let cascadeBusy = false;

/**
 * Show the borderline matches in a pre-checked grid; resolve to the ids the
 * human kept, or null if they skipped the batch.
 */
function reviewMatchesGrid(faces, name) {
  const selected = new Set(faces.map((f) => f.id));
  const grid = el("div.pga-facegrid");
  grid.replaceChildren(...faces.map((face) => {
    const cell = el("div.pga-facecell", { "dataset": { selected: "true" } });
    const label = `${name} in ${context.name(face.gallery)}${face.year ? ` ${face.year}` : ""}`;
    const pick = el("label.pga-check", null,
      el("input", {
        type: "checkbox", checked: true, "aria-label": `This is ${label}`,
        onchange: (event) => {
          if (event.target.checked) selected.add(face.id);
          else selected.delete(face.id);
          cell.dataset.selected = String(event.target.checked);
        },
      }),
      `Is ${name}`,
    );
    cell.append(faceImage(face, 200, label), pick);
    return cell;
  }));

  const instance = dialog({
    title: `More photos of ${name}?`,
    wide: true,
    body: el("div", null,
      el("p.pga-hint", { text:
        `These look like ${name} but aren't a sure match. Untick anyone who isn't ${name}, then confirm — they're all tagged at once.` }),
      grid,
    ),
    actions: [
      { label: "Skip these", kind: "ghost", value: null },
      { label: "Confirm ticked", kind: "primary", run: () => Array.from(selected) },
    ],
  });
  return instance.result;
}

/**
 * After a face has been confirmed as `personId`/`name`, gather that person's
 * remaining suggestions and confirm the rest — auto for the near-certain,
 * a grid for the borderline. Best-effort: the trigger confirm already
 * succeeded, so any failure here just leaves those faces in the normal queue.
 * Returns the set of face ids it newly confirmed so the caller can drop them
 * from its own view.
 */
async function cascadeConfirm(personId, name, { excludeIds = new Set() } = {}) {
  if (cascadeBusy) return new Set();
  cascadeBusy = true;
  try {
    return await runCascade(personId, name, excludeIds);
  } finally {
    cascadeBusy = false;
  }
}

async function runCascade(personId, name, excludeIds) {
  let candidates;
  try {
    const res = await api("faces-review", { person_id: personId, limit: 300 });
    candidates = (res.faces || []).filter((f) => !excludeIds.has(f.id));
  } catch {
    return new Set();
  }
  if (!candidates.length) return new Set();

  const confirmed = new Set();
  const auto = candidates.filter((f) => f.distance != null && f.distance <= AUTO_MAX);
  const review = candidates.filter((f) => !(f.distance != null && f.distance <= AUTO_MAX));

  if (auto.length) {
    try {
      const res = await api("face-confirm-batch", { person_id: personId, face_ids: auto.map((f) => f.id) });
      const n = res.confirmed ?? auto.length;
      auto.forEach((f) => confirmed.add(f.id));
      announce(`Auto-confirmed ${plural(n, "more photo")} of ${name}.`, { force: true });
      toast(`Also tagged ${plural(n, "very-likely photo")} of ${name}.`, {
        kind: "success",
        duration: 8000,
        action: {
          label: "Undo",
          run: async () => {
            for (const f of auto) { try { await api("face-unconfirm", { face_id: f.id }); } catch { /* ignore */ } }
            toast("Undone.");
            refreshStatus();
          },
        },
      });
    } catch (err) { toastError(err); }
  }

  if (review.length) {
    const kept = await reviewMatchesGrid(review, name);
    if (kept && kept.length) {
      try {
        const res = await api("face-confirm-batch", { person_id: personId, face_ids: kept });
        kept.forEach((id) => confirmed.add(id));
        toast(`Confirmed ${plural(res.confirmed ?? kept.length, "more photo")} of ${name}.`, { kind: "success" });
      } catch (err) { toastError(err); }
    }
  }

  if (confirmed.size) { await refreshPeople(); refreshStatus(); }
  return confirmed;
}

/* ---------- panel: scan ------------------------------------------------ */

let scanAbort = null;

function renderScan() {
  const galleryOnly = el("input", { type: "checkbox" });
  const progressWrap = el("div", { hidden: true },
    el("div.pga-progress", null, el("div.pga-progress-fill")),
    el("p.pga-muted", { "role": "status", style: { fontSize: "0.88rem", margin: "0" } }),
  );
  const problems = el("div");
  const startBtn = el("button.pga-btn.pga-btn-primary", { type: "button" }, "Start scanning");
  const stopBtn = el("button.pga-btn.pga-btn-outline", { type: "button", hidden: true }, "Stop");
  const libStatus = el("p.pga-hint", { "role": "status", style: { margin: "0" } });

  const fill = progressWrap.querySelector(".pga-progress-fill");
  const text = progressWrap.querySelector("p");

  async function start() {
    startBtn.hidden = true;
    stopBtn.hidden = false;
    problems.replaceChildren();
    progressWrap.hidden = false;
    scanAbort = new AbortController();
    const signal = scanAbort.signal;

    try {
      await loadFaceApi((message) => { libStatus.textContent = message; });
    } catch (err) {
      libStatus.textContent = "";
      toastError(err);
      startBtn.hidden = false;
      stopBtn.hidden = true;
      progressWrap.hidden = true;
      return;
    }

    const scope = galleryOnly.checked ? { gallery: context.gallery } : {};
    let done = 0;
    let facesFound = 0;
    const failures = [];
    let total = 0;

    try {
      // Work queue comes from the server-side "unscanned" filter, so it has a
      // real total. The old code pulled every photo and diffed client-side.
      const first = await api("list-admin", { ...scope, filter: "unscanned", limit: 1 });
      total = first.total || 0;

      if (!total) {
        text.textContent = "Every photo has already been scanned.";
        progressWrap.hidden = false;
        startBtn.hidden = false;
        stopBtn.hidden = true;
        return;
      }

      // Re-query each page rather than paging by offset: every scanned photo
      // leaves the "unscanned" set, so offset would skip work.
      for (;;) {
        if (signal.aborted) break;
        const page = await api("list-admin", { ...scope, filter: "unscanned", limit: 25 });
        const photos = page.photos || [];
        if (!photos.length) break;

        for (const photo of photos) {
          if (signal.aborted) break;
          text.textContent = `Scanning ${num(done + 1)} of ${num(total)} — ${plural(facesFound, "face")} found`;
          fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
          announce(`Scanning ${done + 1} of ${total}.`);

          if (photo.media_type === "video") { done++; continue; }

          try {
            const faces = await detectFaces(photo.image_url);
            facesFound += faces.length;
            await api("faces-save", { photo_id: photo.id, faces });
          } catch (err) {
            // Critically: do NOT save an empty face list here. That would set
            // face_scanned = true and hide the problem forever, which is what
            // the old code did on every failure.
            failures.push({ photo, reason: err.message || "could not be read" });
          }
          done++;
        }

        if (failures.length >= photos.length) break;   // nothing is succeeding
      }
    } catch (err) {
      toastError(err);
    }

    fill.style.width = "100%";
    text.textContent = signal.aborted
      ? `Stopped after ${num(done)} of ${num(total)} — ${plural(facesFound, "face")} found.`
      : `Finished — scanned ${num(done)}, found ${plural(facesFound, "face")}.`;
    announce(text.textContent, { force: true });

    if (failures.length) {
      problems.replaceChildren(
        el("p.pga-error", { text: `${plural(failures.length, "photo")} could not be scanned and will be offered again next time:` }),
        el("ul", { style: { fontSize: "0.85rem", color: "var(--pga-muted)" } },
          ...failures.slice(0, 10).map((f) => el("li", { text: `${f.photo.caption || f.photo.id} — ${f.reason}` }))),
        failures.length > 10 ? el("p.pga-muted", { text: `…and ${num(failures.length - 10)} more.` }) : null,
      );
    }

    startBtn.hidden = false;
    stopBtn.hidden = true;
    scanAbort = null;
    await refreshStatus();
    if (facesFound) {
      toast(`Found ${plural(facesFound, "face")}. Confirm names next.`, {
        kind: "success",
        action: { label: "Confirm names", run: () => switchPanel("triage") },
      });
    }
  }

  startBtn.addEventListener("click", () => start().catch(toastError));
  stopBtn.addEventListener("click", () => { scanAbort?.abort(); });

  return el("div.pga-panel", null,
    el("h2", { text: "Scan photos for faces" }),
    el("p.pga-hint", { text:
      "Face recognition runs entirely in this browser — no photos and no face data are " +
      "ever sent to another company. Scanning reads each photo at full size, so it takes " +
      "a second or two per photo. You can stop at any point and pick up where you left " +
      "off later; nothing is lost." }),
    el("p.pga-hint", { text: `${plural(status.unscanned_count, "photo")} not scanned yet.` }),
    el("div.pga-row", null,
      startBtn,
      stopBtn,
      el("label.pga-check", null, galleryOnly, `Only ${context.name()}`),
    ),
    libStatus,
    progressWrap,
    problems,
  );
}

/* ---------- panel: triage --------------------------------------------- */

/**
 * The confirm/reject queue. Designed as triage: one large face, one decision,
 * keyboard-first, next crops prefetched so it never stalls.
 */
function renderTriage() {
  const panel = el("div.pga-panel");
  let buffer = [];
  let cursor = 0;
  const decided = new Set();
  let confirmed = 0;
  let rejected = 0;

  const progress = el("p.pga-hint", { "role": "status", style: { margin: "0 0 14px" } });
  const stage = el("div");
  panel.append(
    el("h2", { text: "Confirm names" }),
    el("p.pga-hint", { text:
      "Each face below has a suggested name based on people you've already confirmed. " +
      "Say yes or no. Confirming one face sweeps up the rest of that person automatically — " +
      "near-certain matches are tagged for you, and any maybes are shown in a grid to confirm " +
      "in one go, so you don't work through a hundred photos of the same person one at a time." }),
    progress,
    stage,
  );

  const prefetched = new Map();
  function prefetch() {
    for (let i = cursor; i < Math.min(cursor + 4, buffer.length); i++) {
      const face = buffer[i];
      if (!face || prefetched.has(face.id)) continue;
      prefetched.set(face.id, faceCropUrl(face.image_url, face.box, 420).catch(() => null));
    }
  }

  async function fill() {
    try {
      const res = await api("faces-review", { limit: 60 });
      const fresh = (res.faces || []).filter((f) => !decided.has(f.id));
      buffer = fresh;
      cursor = 0;
      prefetch();
    } catch (err) {
      stage.replaceChildren(emptyState({ title: "Could not load the queue", body: err.message, icon: null }));
    }
  }

  function updateProgress() {
    const left = Math.max(0, buffer.length - cursor);
    progress.textContent =
      `${plural(left, "face")} in this batch · ${num(confirmed)} confirmed, ${num(rejected)} rejected this session`;
  }

  async function advance() {
    cursor++;
    // A confirmation triggers a targeted re-suggest server-side, so buffered
    // suggestions can be stale. Refill rather than making the user reload.
    if (cursor >= buffer.length - 6) await fill();
    prefetch();
    render();
  }

  async function decide(face, action, personId) {
    decided.add(face.id);
    try {
      if (action === "confirm") {
        const pid = personId || face.person.id;
        const pname = face.person.name;
        await api("face-confirm", { face_id: face.id, person_id: pid });
        confirmed++;
        announce(`Confirmed ${pname}.`);
        toast(`Confirmed ${pname}.`, {
          kind: "success",
          duration: 6000,
          // Confirm is reversible; reject is not, so only this gets an Undo.
          action: {
            label: "Undo",
            run: async () => {
              try {
                await api("face-unconfirm", { face_id: face.id });
                confirmed--;
                decided.delete(face.id);
                toast("Undone.");
                await refreshStatus();
              } catch (err) { toastError(err); }
            },
          },
        });
        // Sweep up the rest of this person so a hundred photos aren't a hundred
        // keystrokes. Ids it confirms are marked decided so they don't come
        // back around the queue one at a time.
        const swept = await cascadeConfirm(pid, pname, { excludeIds: decided });
        swept.forEach((id) => decided.add(id));
        confirmed += swept.size;
      } else if (action === "reject") {
        await api("face-reject", { face_id: face.id, person_id: face.person.id });
        rejected++;
        announce(`Rejected. ${face.person.name} won't be suggested for this face again.`);
        toast(`Rejected — ${face.person.name} won't be suggested for this face again.`, {
          duration: 6000,
          action: {
            label: "Undo",
            run: async () => {
              try {
                const res = await api("face-unreject", { face_id: face.id, person_id: face.person.id });
                rejected--;
                decided.delete(face.id);
                // The rejection is gone either way, but the suggestion only
                // comes back if that person is still the closest match — say
                // which happened rather than implying it returned.
                toast(res.suggestion
                  ? `Undone — ${res.suggestion.name} is suggested again.`
                  : "Undone. That guess no longer matches closely enough to be re-suggested.");
                await refreshStatus();
              } catch (err) { toastError(err); }
            },
          },
        });
      } else if (action === "delete") {
        await api("face-delete", { face_id: face.id });
        announce("Removed — not a face.");
      }
      refreshStatus();
    } catch (err) {
      decided.delete(face.id);
      toastError(err);
    }
    await advance();
  }

  function render() {
    updateProgress();
    const face = buffer[cursor];

    if (!face) {
      stage.replaceChildren(emptyState({
        title: confirmed || rejected ? "Queue is clear" : "Nothing to confirm",
        body: confirmed || rejected
          ? `You confirmed ${num(confirmed)} and rejected ${num(rejected)}. Scan more photos, or name the faces nobody has identified yet.`
          : "There are no suggested names waiting. Scan some photos, or start naming faces in “Who is this?”.",
        action: { label: "Who is this?", run: () => switchPanel("unknown") },
      }));
      return;
    }

    const distance = face.distance;
    const crop = el("img.pga-triage-crop", {
      alt: `Face from a photo in ${face.gallery || "the gallery"}${face.year ? `, ${face.year}` : ""}`,
    });
    (prefetched.get(face.id) || faceCropUrl(face.image_url, face.box, 420))
      .then((url) => { if (url) crop.src = url; })
      .catch(() => {});

    // Show the whole photo with the box outlined, so a human can actually
    // judge rather than guessing from a tight crop.
    const contextWrap = el("div.pga-boxwrap");
    const contextImg = el("img", { src: face.image_url, alt: "", style: { maxHeight: "220px", width: "auto", borderRadius: "6px" } });
    const boxEl = el("div.pga-box");
    contextWrap.append(contextImg, boxEl);
    const placeBox = () => {
      const px = toPixelBox(face.box, contextImg.clientWidth, contextImg.clientHeight);
      Object.assign(boxEl.style, {
        left: `${px.x}px`, top: `${px.y}px`, width: `${px.w}px`, height: `${px.h}px`,
      });
    };
    contextImg.addEventListener("load", placeBox);
    if (contextImg.complete) placeBox();

    const actions = el("div.pga-triage-actions", null,
      el("button.pga-btn.pga-btn-primary.pga-btn-lg", {
        type: "button",
        onclick: () => decide(face, "confirm"),
      }, `Yes, that's ${face.person.name}`, el("span.pga-kbd", { text: "Y" })),
      el("button.pga-btn.pga-btn-outline", {
        type: "button",
        onclick: () => decide(face, "reject"),
      }, "No", el("span.pga-kbd", { text: "N" })),
      el("button.pga-btn.pga-btn-ghost", {
        type: "button",
        onclick: () => { advance(); },
      }, "Skip", el("span.pga-kbd", { text: "S" })),
      el("button.pga-btn.pga-btn-ghost", {
        type: "button",
        "data-else": "",
        onclick: () => nameSomeoneElse(face),
      }, "Someone else…", el("span.pga-kbd", { text: "E" })),
      el("button.pga-btn.pga-btn-danger", {
        type: "button",
        onclick: async () => {
          const ok = await confirmDialog({
            title: "Not a face?",
            body: "Use this for posters, reflections, statues and blurs the detector picked up. The detection is deleted; the photo itself is untouched.",
            confirmLabel: "Remove detection",
            danger: true,
          });
          if (ok) decide(face, "delete");
        },
      }, "Not a face", el("span.pga-kbd", { text: "X" })),
    );

    async function nameSomeoneElse(target) {
      const name = await promptDialog({
        title: "Who is this?",
        label: "Name",
        hint: "If this person isn't in the list yet, they'll be added.",
        confirmLabel: "Confirm name",
      });
      if (!name) return;
      const existing = findPerson(name);
      try {
        // face-confirm accepts either an id or a new name, and reuses an
        // existing person on a case-insensitive match server-side.
        const payload = existing
          ? { face_id: target.id, person_id: existing.id }
          : { face_id: target.id, new_person_name: name };
        const res = await api("face-confirm", payload);
        decided.add(target.id);
        confirmed++;
        toast(`Confirmed ${name}.`, { kind: "success" });
        await refreshPeople();
        const pid = res.person_id || existing?.id;
        if (pid) {
          const swept = await cascadeConfirm(pid, name, { excludeIds: decided });
          swept.forEach((id) => decided.add(id));
          confirmed += swept.size;
        }
        refreshStatus();
        await advance();
      } catch (err) {
        toastError(err);
      }
    }

    const details = el("div", null,
      el("h3.pga-triage-name", { text: `Is this ${face.person.name}?` }),
      el("p.pga-hint", { style: { margin: "0 0 10px" }, text:
        `${confidenceLabel(distance)}${distance != null ? ` — closeness ${distance.toFixed(2)} (lower is a better match)` : ""}` }),
      el("p.pga-muted", { style: { fontSize: "0.85rem" }, text:
        [context.name(face.gallery), face.year].filter(Boolean).join(" · ") }),
      contextWrap,
      actions,
      el("p.pga-hint", { style: { marginTop: "14px" }, text:
        "Saying no means this face won't be suggested as that person again. Both yes and no " +
        "offer an Undo for a few seconds afterwards, so a mis-click is recoverable." }),
    );

    stage.replaceChildren(el("div.pga-triage", null, crop, details));
  }

  // One listener scoped to the panel, and it bows out whenever focus is in a
  // field — otherwise typing a name would fire "N for No".
  panel.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.closest("input, textarea, select")) return;
    const face = buffer[cursor];
    if (!face) return;
    const key = event.key.toLowerCase();
    const map = {
      y: () => decide(face, "confirm"),
      enter: () => decide(face, "confirm"),
      n: () => decide(face, "reject"),
      s: () => advance(),
      arrowright: () => advance(),
      e: () => stage.querySelector('button[data-else]')?.click(),
    };
    if (map[key]) {
      event.preventDefault();
      map[key]();
    }
  });

  progress.textContent = "Loading…";
  fill().then(render);
  return panel;
}

/* ---------- panel: unknown -------------------------------------------- */

function renderUnknown() {
  const panel = el("div.pga-panel");
  const grid = el("div.pga-facegrid");
  const selected = new Set();
  let faces = [];
  let lastPerson = null;

  const bar = el("div.pga-toolbar", null,
    el("span.pga-toolbar-count", { "role": "status", text: "Nothing selected" }),
    el("button.pga-btn.pga-btn-primary.pga-btn-sm", { type: "button", disabled: true }, "Name selected…"),
    el("button.pga-btn.pga-btn-ghost.pga-btn-sm", { type: "button", disabled: true }, "Repeat last name"),
    el("button.pga-btn.pga-btn-danger.pga-btn-sm", { type: "button", disabled: true }, "Not faces"),
    el("button.pga-btn.pga-btn-ghost.pga-btn-sm", { type: "button" }, "Clear"),
  );
  const [countLabel, nameBtn, repeatBtn, notFaceBtn, clearBtn] = bar.children;

  function updateBar() {
    countLabel.textContent = selected.size ? `${plural(selected.size, "face")} selected` : "Nothing selected";
    nameBtn.disabled = selected.size === 0;
    notFaceBtn.disabled = selected.size === 0;
    // A gala produces bursts of the same person; one click beats retyping.
    repeatBtn.disabled = selected.size === 0 || !lastPerson;
    repeatBtn.textContent = lastPerson ? `Repeat: ${lastPerson.display_name}` : "Repeat last name";
  }

  async function applyPerson(person) {
    const ids = Array.from(selected);
    let failed = 0;
    for (const id of ids) {
      try {
        await api("face-confirm", { face_id: id, person_id: person.id });
      } catch { failed++; }
    }
    lastPerson = person;
    selected.clear();
    if (failed) toast(`Named ${num(ids.length - failed)}; ${num(failed)} failed.`, { kind: "error" });
    else toast(`Named ${plural(ids.length, "face")} as ${person.display_name}.`, { kind: "success" });
    announce(`Named ${plural(ids.length, "face")} as ${person.display_name}.`, { force: true });
    await refreshPeople();
    // Naming these exemplars may have produced suggestions elsewhere — sweep
    // them up too, so the whole person is handled in one action.
    await cascadeConfirm(person.id, person.display_name, { excludeIds: new Set(ids) });
    refreshStatus();
    await load();
  }

  nameBtn.addEventListener("click", async () => {
    const name = await promptDialog({
      title: `Name ${plural(selected.size, "face")}`,
      label: "Who is this?",
      hint: "Pick someone already in the list, or type a new name to add them.",
      confirmLabel: "Confirm",
    });
    if (!name) return;
    let person = findPerson(name);
    if (!person) {
      try {
        const created = await api("person-create", { display_name: name });
        person = created.person;
        await refreshPeople();
      } catch (err) {
        if (err instanceof PGError && err.status === 409 && err.body.existing_id) {
          person = { id: err.body.existing_id, display_name: name };
        } else { toastError(err); return; }
      }
    }
    await applyPerson(person);
  });

  repeatBtn.addEventListener("click", () => { if (lastPerson) applyPerson(lastPerson); });

  notFaceBtn.addEventListener("click", async () => {
    const ids = Array.from(selected);
    const ok = await confirmDialog({
      title: `Remove ${plural(ids.length, "detection")}?`,
      body: "Use this for posters, reflections, statues and blurs. The detections are deleted; the photos are untouched.",
      confirmLabel: `Remove ${num(ids.length)}`,
      danger: true,
    });
    if (!ok) return;
    for (const id of ids) {
      try { await api("face-delete", { face_id: id }); } catch { /* reported by reload */ }
    }
    selected.clear();
    toast(`Removed ${plural(ids.length, "detection")}.`, { kind: "success" });
    refreshStatus();
    await load();
  });

  clearBtn.addEventListener("click", () => { selected.clear(); render(); });

  function render() {
    updateBar();
    if (!faces.length) {
      grid.replaceChildren(emptyState({
        title: "Nobody left to identify",
        body: "Every detected face either has a name or a suggestion waiting in “Confirm names”.",
        action: { label: "Confirm names", run: () => switchPanel("triage") },
      }));
      return;
    }
    grid.replaceChildren(...faces.map((face) => {
      const cell = el("div.pga-facecell", { "dataset": { selected: String(selected.has(face.id)) } });
      const label = `Face from ${context.name(face.gallery)}${face.year ? ` ${face.year}` : ""}`;
      const pick = el("label.pga-check", null,
        el("input", {
          type: "checkbox",
          checked: selected.has(face.id),
          "aria-label": `Select ${label}`,
          onchange: (event) => {
            if (event.target.checked) selected.add(face.id);
            else selected.delete(face.id);
            cell.dataset.selected = String(event.target.checked);
            updateBar();
          },
        }),
        "Select",
      );
      cell.append(faceImage(face, 220, label), pick);
      return cell;
    }));
  }

  async function load() {
    grid.replaceChildren(loadingState());
    try {
      const res = await api("faces-unknown", { limit: 120 });
      faces = res.faces || [];
      render();
    } catch (err) {
      grid.replaceChildren(emptyState({ title: "Could not load faces", body: err.message, icon: null }));
    }
  }

  panel.append(
    el("h2", { text: "Who is this?" }),
    el("p.pga-hint", { text:
      "Faces nobody has identified and that recognition can't guess yet. Name one person " +
      "once and every future photo of them gets suggested automatically. Tick several " +
      "crops of the same person to name them all at once." }),
    bar,
    grid,
  );
  load();
  return panel;
}

/* ---------- panel: roster --------------------------------------------- */

function renderRoster() {
  const panel = el("div.pga-panel");
  const grid = el("div.pga-cards");
  let roster = [];

  const search = el("input", {
    id: "roster-q", type: "search", placeholder: "Search names",
    "aria-label": "Search people by name",
  });
  search.addEventListener("input", debounce(() => load(search.value.trim()), 300));

  /**
   * Duplicate detection is entirely client-side — no server support needed,
   * and duplicates are where the real cleanup value is. Catches "Jane D." vs
   * "Jane Doe" and near-identical spellings.
   */
  function possibleDuplicates(list) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
    const pairs = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = norm(list[i].display_name);
        const b = norm(list[j].display_name);
        if (!a || !b) continue;
        if (a === b || a.startsWith(b) || b.startsWith(a) || levenshtein(a, b) <= 2) {
          pairs.push([list[i], list[j]]);
        }
      }
    }
    return pairs.slice(0, 8);
  }

  function levenshtein(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const temp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = temp;
      }
    }
    return row[b.length];
  }

  async function mergePeople(keep, drop) {
    const ok = await confirmDialog({
      title: `Merge into ${keep.display_name}?`,
      body: `Every photo and face belonging to “${drop.display_name}” moves to “${keep.display_name}”, and “${drop.display_name}” is removed. This cannot be undone.`,
      confirmLabel: "Merge them",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api("person-merge", { keep_id: keep.id, drop_id: drop.id });
      toast(`Merged — ${keep.display_name} now has ${plural(res.photo_count ?? 0, "photo")}.`, { kind: "success" });
      await refreshPeople();
      load(search.value.trim());
    } catch (err) { toastError(err); }
  }

  function pickMergeTarget(person) {
    const others = roster.filter((p) => p.id !== person.id);
    const select = el("select", { id: "mg-target" },
      ...others.map((p) => el("option", { value: p.id, text: `${p.display_name} (${p.photo_count} photos)` })));
    const keepRadioName = el("input", { type: "radio", name: "mg-keep", value: "this", checked: true });
    const keepRadioOther = el("input", { type: "radio", name: "mg-keep", value: "other" });

    const content = el("div.pga-stack", null,
      el("div.pga-field.grow", null, el("label", { for: "mg-target", text: `Merge ${person.display_name} with` }), select),
      el("div", null,
        el("p.pga-label", { text: "Which name should be kept?" }),
        el("label.pga-check", null, keepRadioName, person.display_name),
        el("label.pga-check", null, keepRadioOther, "The one selected above"),
      ),
    );

    const instance = dialog({
      title: "Merge duplicate people",
      body: content,
      initialFocus: "#mg-target",
      actions: [
        { label: "Cancel", kind: "ghost" },
        {
          label: "Continue",
          kind: "primary",
          run: () => {
            const other = others.find((p) => p.id === select.value);
            if (!other) return null;
            return keepRadioName.checked ? [person, other] : [other, person];
          },
        },
      ],
    });
    instance.result.then((pair) => { if (pair) mergePeople(pair[0], pair[1]); });
  }

  function personCard(person) {
    const card = el("div.pga-panel", { style: { margin: "0", padding: "14px" } });
    const cover = person.cover
      ? faceImage(person.cover, 180, person.display_name, { fixedWidth: 110 })
      : el("div.pga-facecrop", {
          "role": "img",
          "aria-label": `No photo of ${person.display_name} yet`,
          style: { width: "110px", height: "110px", flexShrink: "0" },
        });

    const nameRow = el("div.pga-inline", null,
      el("strong", { text: person.display_name }),
      person.hidden ? el("span.pga-badge.pga-badge-hidden", { text: "Hidden" }) : null,
    );

    card.append(
      el("div.pga-inline", { style: { alignItems: "flex-start" } },
        cover,
        el("div", null,
          nameRow,
          el("p.pga-muted", { style: { fontSize: "0.82rem", margin: "4px 0 0" }, text:
            `${plural(person.photo_count || 0, "photo")} · ${plural(person.face_count || 0, "face")}` }),
        ),
      ),
      el("div.pga-inline", { style: { marginTop: "10px" } },
        el("button.pga-btn.pga-btn-ghost.pga-btn-sm", {
          type: "button",
          onclick: async () => {
            const name = await promptDialog({
              title: "Rename", label: "Name", value: person.display_name, confirmLabel: "Save",
              hint: "The new name replaces the old one everywhere on the site.",
            });
            if (!name || name === person.display_name) return;
            try {
              await api("person-update", { id: person.id, patch: { display_name: name } });
              toast(`Renamed to ${name}.`, { kind: "success" });
              await refreshPeople();
              load(search.value.trim());
            } catch (err) { toastError(err); }
          },
        }, "Rename"),
        el("button.pga-btn.pga-btn-ghost.pga-btn-sm", {
          type: "button",
          onclick: () => pickMergeTarget(person),
        }, "Merge…"),
        el("button.pga-btn.pga-btn-ghost.pga-btn-sm", {
          type: "button",
          onclick: async () => {
            try {
              await api("person-update", { id: person.id, patch: { hidden: !person.hidden } });
              toast(person.hidden ? `${person.display_name} is shown again.` : `${person.display_name} is hidden from the website.`, { kind: "success" });
              load(search.value.trim());
            } catch (err) { toastError(err); }
          },
        }, person.hidden ? "Show" : "Hide"),
        el("button.pga-btn.pga-btn-danger.pga-btn-sm", {
          type: "button",
          onclick: async () => {
            const ok = await confirmDialog({
              title: `Delete ${person.display_name}?`,
              body: `Their ${plural(person.face_count || 0, "face")} go back to the “Who is this?” pile and their photo tags are removed. The photos themselves are kept.`,
              confirmLabel: "Delete person",
              danger: true,
            });
            if (!ok) return;
            try {
              const res = await api("person-delete", { id: person.id });
              toast(`Deleted — ${plural(res.orphaned_faces ?? 0, "face")} need naming again.`, { kind: "success" });
              await refreshPeople();
              refreshStatus();
              load(search.value.trim());
            } catch (err) { toastError(err); }
          },
        }, "Delete"),
      ),
    );

    // Only public albums have a page to link to.
    if (person.photo_count && context.isPublic()) {
      card.append(el("a.pga-btn.pga-btn-outline.pga-btn-sm", {
        href: `/photogallery/${context.gallery}/?q=${encodeURIComponent(person.display_name)}`,
        target: "_blank",
        rel: "noopener",
        style: { marginTop: "8px" },
      }, `See them in ${context.name()}`));
    }

    return card;
  }

  const dupes = el("div");

  async function load(query) {
    grid.replaceChildren(loadingState());
    try {
      const res = await api("people-list", { q: query || undefined, limit: 300 });
      roster = res.people || [];
      if (!roster.length) {
        grid.replaceChildren(emptyState({
          title: query ? "No matches" : "Nobody yet",
          body: query
            ? "Try a different spelling."
            : "People appear here once you name a face. Scan some photos to get started.",
          action: query ? null : { label: "Scan for faces", run: () => switchPanel("scan") },
        }));
        dupes.replaceChildren();
        return;
      }
      grid.replaceChildren(...roster.map(personCard));

      const pairs = query ? [] : possibleDuplicates(roster);
      if (pairs.length) {
        dupes.replaceChildren(el("div.pga-toolbar", { style: { display: "block" } },
          el("p.pga-label", { text: "Possible duplicates — same person entered twice?" }),
          el("div.pga-inline", { style: { marginTop: "8px" } }, ...pairs.map(([a, b]) =>
            el("button.pga-btn.pga-btn-outline.pga-btn-sm", {
              type: "button",
              onclick: () => mergePeople(a.photo_count >= b.photo_count ? a : b, a.photo_count >= b.photo_count ? b : a),
            }, `${a.display_name} + ${b.display_name}`))),
        ));
      } else {
        dupes.replaceChildren();
      }
    } catch (err) {
      grid.replaceChildren(emptyState({ title: "Could not load people", body: err.message, icon: null }));
    }
  }

  panel.append(
    el("h2", { text: "People" }),
    el("p.pga-hint", { text:
      "Everyone who has been named. Renaming updates every photo on the site. Hiding keeps " +
      "the tags but removes the name from the public gallery." }),
    el("div.pga-row", { style: { marginBottom: "14px" } },
      el("div.pga-field.grow", null, el("label", { for: "roster-q", text: "Search" }), search)),
    dupes,
    grid,
  );
  load("");
  return panel;
}

/* ---------- panel switching ------------------------------------------- */

function switchPanel(id) {
  activePanel = id;
  setRouteParams({ panel: id });
  for (const chip of host.querySelectorAll(".pga-chip[data-panel]")) {
    chip.setAttribute("aria-selected", String(chip.dataset.panel === id));
  }
  const builders = { scan: renderScan, triage: renderTriage, unknown: renderUnknown, roster: renderRoster };
  body.replaceChildren(builders[id]());
}

/* ---------- mount ----------------------------------------------------- */

export async function mount(view, params) {
  host = view;
  activePanel = PANELS.some((p) => p.id === params.get("panel")) ? params.get("panel") : "triage";

  const chips = el("div.pga-chiprow", { "role": "tablist", "aria-label": "Face tools" },
    ...PANELS.map((panel) => el("button.pga-chip", {
      type: "button",
      "role": "tab",
      "dataset": { panel: panel.id },
      "aria-selected": String(activePanel === panel.id),
      onclick: () => switchPanel(panel.id),
    }, el("span", { text: panel.label }), el("span.pga-chip-count"))),
  );

  body = el("div");
  const privacy = el("p.pga-hint", { style: { margin: "0 0 16px" }, text:
    "Face recognition runs in this browser and the face data stays on SPARC's own " +
    "infrastructure. Nothing is sent to Google, Facebook or any other company, and no " +
    "name is ever applied without someone confirming it." });

  view.replaceChildren(privacy, chips, body,
    el("datalist", { id: "pga-people-list" }));

  body.replaceChildren(loadingState());
  await Promise.all([refreshStatus(), refreshPeople()]);
  switchPanel(activePanel);
}

export function onParams(params) {
  const panel = params.get("panel");
  if (panel && panel !== activePanel && PANELS.some((p) => p.id === panel)) switchPanel(panel);
}
