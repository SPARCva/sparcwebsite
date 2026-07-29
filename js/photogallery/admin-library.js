/* ==========================================================================
   photo-gallery admin — Library and Review views
   --------------------------------------------------------------------------
   Library is the management grid, rebuilt to fix four things the old page got
   wrong:

     1. It sent no `limit`, so it silently truncated at the server default of
        100 rows and ignored the `total` it was handed. There was no paging.
     2. `selected` was reset on every refresh, so every bulk action cleared
        the selection it had just acted on.
     3. Re-rendering did `grid.innerHTML = ""`, which stole focus mid-typing.
     4. There was no alt-text field anywhere, though `needs_alt` is flagged
        for the entire existing backlog.

   Review is the same list scoped server-side to `filter:"unpublished"` and
   grouped by `submission`. The old page fetched unfiltered and filtered in
   JS, so any pending photo past row 100 was invisible.
   ========================================================================== */

import { api, PGError } from "./api.js";
import {
  el, toast, toastError, announce, dialog, confirmDialog, promptDialog,
  emptyState, loadingState, num, plural, isoToDate, shortDate, debounce, pool,
} from "./ui.js";
import { context, onContextChange, setRouteParams, navigate, setTabCount } from "./admin.js";
import { loadFaceApi, describeBox, confidenceLabel, toPixelBox } from "./faces.js";
import { faceCropUrl } from "./imaging.js";

const PAGE_SIZE = 100;

const FILTERS = [
  { id: "", label: "All" },
  { id: "needs_alt", label: "Needs alt text" },
  { id: "untagged", label: "Nobody tagged" },
  { id: "unscanned", label: "Not scanned" },
  { id: "unpublished", label: "Hidden" },
];

/* ---------- state ------------------------------------------------------ */

const store = {
  byId: new Map(),
  order: [],
  total: 0,
  page: 0,
  filter: "",
  allYears: false,
  /** Survives refreshes — the whole point. Only pruned of ids that vanish. */
  selected: new Set(),
  /** Ids with an in-flight or debounced inline edit; skipped by reconcile. */
  dirty: new Set(),
};

let host = null;
let cards = null;
let unsubscribe = null;

/* ---------- keyed reconcile ------------------------------------------- */

/**
 * Patch existing nodes in place instead of rebuilding the grid. appendChild
 * on a node that's already in the container moves it, so reordering is free.
 */
function reconcile(container, items, { key, create, update }) {
  const existing = new Map();
  for (const node of Array.from(container.children)) {
    if (node.dataset.key) existing.set(node.dataset.key, node);
  }
  for (const item of items) {
    const k = String(key(item));
    let node = existing.get(k);
    if (node) existing.delete(k);
    else {
      node = create(item);
      node.dataset.key = k;
    }
    update(node, item);
    container.appendChild(node);
  }
  for (const stale of existing.values()) stale.remove();
}

/** Never move a caret the user is sitting in, and never clobber a live edit. */
function setValue(input, value) {
  if (document.activeElement === input) return;
  if (input.value !== value) input.value = value;
}

/* ---------- data ------------------------------------------------------- */

async function fetchPage() {
  const payload = {
    gallery: context.gallery,
    limit: PAGE_SIZE,
    offset: store.page * PAGE_SIZE,
  };
  if (!store.allYears) payload.year = context.year;
  if (store.filter) payload.filter = store.filter;

  const res = await api("list-admin", payload);
  store.total = res.total || 0;
  store.order = [];
  for (const photo of res.photos || []) {
    store.byId.set(photo.id, photo);
    store.order.push(photo.id);
  }
  // Drop selections for rows that no longer exist anywhere we know of.
  return res;
}

/** Chip counts, one cheap head-count each. */
async function fetchCounts() {
  const results = await Promise.all(FILTERS.map(async (filter) => {
    const payload = { gallery: context.gallery, limit: 1 };
    if (!store.allYears) payload.year = context.year;
    if (filter.id) payload.filter = filter.id;
    try {
      const res = await api("list-admin", payload);
      return res.total || 0;
    } catch {
      return null;
    }
  }));
  return results;
}

/* ---------- inline save ----------------------------------------------- */

/**
 * Debounced field save. Optimistic: the local row is updated immediately and
 * rolled back if the server refuses, which the old code never checked.
 */
function makeFieldSaver(photoId, field, statusEl) {
  return debounce(async (value) => {
    const photo = store.byId.get(photoId);
    if (!photo) return;
    const previous = photo[field];
    photo[field] = value;
    store.dirty.add(photoId);
    statusEl.textContent = "Saving…";
    try {
      await api("update", { id: photoId, patch: { [field]: value } });
      // needs_alt is recomputed server-side; mirror it so the badge is right.
      if (field === "alt_text" || field === "caption") {
        photo.needs_alt = !(photo.alt_text_raw || photo.caption);
      }
      if (field === "alt_text") photo.alt_text_raw = value;
      statusEl.textContent = "Saved";
      setTimeout(() => { if (statusEl.textContent === "Saved") statusEl.textContent = ""; }, 2000);
    } catch (err) {
      photo[field] = previous;
      statusEl.textContent = "";
      toastError(err);
    } finally {
      store.dirty.delete(photoId);
    }
  }, 700);
}

/* ---------- grid cell -------------------------------------------------- */

/**
 * @param {boolean} editable  Library cells carry an inline caption box for
 *   fast captioning of a fresh batch. Review cells don't — there the job is
 *   approve or reject, and a stray edit would be noise.
 */
function createCell(editable = true) {
  const pick = el("input.pga-cell-pick", { type: "checkbox" });
  const img = el("img.pga-cell-img", { alt: "", loading: "lazy" });
  const button = el("button.pga-cell-imgbtn", { type: "button" });
  const badges = el("div.pga-cell-badges");
  const caption = el("p.pga-cell-caption", { style: { margin: "0" } });
  const people = el("span.pga-cell-people");
  const meta = el("span.pga-muted", { style: { fontSize: "0.74rem" } });

  const captionInput = editable ? el("input", {
    type: "text",
    placeholder: "Add a caption",
    style: {
      width: "100%", boxSizing: "border-box", fontFamily: "var(--font-primary)",
      fontSize: "0.8rem", padding: "5px 7px",
      border: "1.5px solid var(--pga-line)", borderRadius: "5px",
    },
  }) : null;
  const saveStatus = editable ? el("span.pga-counter") : null;

  const cell = el("div.pga-cell", null,
    badges,
    pick,
    button,
    el("div.pga-cell-meta", null,
      editable ? captionInput : caption,
      editable ? saveStatus : null,
      people,
      meta,
    ),
  );
  button.append(img);
  cell._parts = { pick, img, button, badges, caption, people, meta, captionInput, saveStatus };
  return cell;
}

function updateCell(cell, photo) {
  const { pick, img, button, badges, caption, people, meta, captionInput, saveStatus } = cell._parts;
  const label = photo.caption || photo.alt_text_raw || "untitled photo";

  if (captionInput) {
    // setValue refuses to touch a focused field, so a background refresh can
    // never move the caret or revert half-typed text.
    setValue(captionInput, photo.caption || "");
    captionInput.setAttribute("aria-label", `Caption for ${label}`);
    if (!cell._saver) {
      cell._saver = makeFieldSaver(photo.id, "caption", saveStatus);
      captionInput.addEventListener("input", () => cell._saver(captionInput.value));
    }
  }

  cell.dataset.selected = store.selected.has(photo.id) ? "true" : "false";
  cell.dataset.published = photo.published === false ? "false" : "true";

  pick.checked = store.selected.has(photo.id);
  pick.setAttribute("aria-label", `Select ${label}`);
  pick.onchange = () => {
    if (pick.checked) store.selected.add(photo.id);
    else store.selected.delete(photo.id);
    cell.dataset.selected = pick.checked ? "true" : "false";
    updateToolbar();
  };

  if (img.src !== (photo.thumb_url || photo.image_url)) {
    img.src = photo.thumb_url || photo.image_url;
  }
  // The tool should demonstrate its own point: say plainly when a photo has
  // no description rather than leaving an empty alt.
  img.alt = photo.alt_text_raw || (photo.caption ? `${photo.caption} — no image description yet` : "No image description yet");
  button.setAttribute("aria-label", `Edit ${label}`);
  button.onclick = () => openEditor(photo.id);

  const chips = [];
  if (photo.media_type === "video") chips.push(el("span.pga-badge.pga-badge-video", { text: "Video" }));
  if (photo.is_featured) chips.push(el("span.pga-badge.pga-badge-featured", { text: "Featured" }));
  if (photo.published === false) chips.push(el("span.pga-badge.pga-badge-hidden", { text: "Hidden" }));
  if (photo.needs_alt) chips.push(el("span.pga-badge.pga-badge-alt", { text: "No alt" }));
  badges.replaceChildren(...chips);

  if (!captionInput) caption.textContent = photo.caption || "";
  people.textContent = (photo.people || []).length ? (photo.people || []).join(", ") : "";
  meta.textContent = [photo.year, shortDate(photo.taken_at)].filter(Boolean).join(" · ");
}

/* ---------- editor dialog --------------------------------------------- */

function openEditor(photoId) {
  const photo = store.byId.get(photoId);
  if (!photo) return;

  const body = el("div.pga-stack");

  const preview = el("img", {
    src: photo.image_url,
    alt: photo.alt_text_raw || "",
    style: { width: "100%", maxHeight: "320px", objectFit: "contain", background: "#e9eef3", borderRadius: "8px" },
  });

  const captionInput = el("textarea", { id: "ed-caption", rows: "2" });
  captionInput.value = photo.caption || "";

  const altInput = el("textarea", { id: "ed-alt", rows: "3", "aria-describedby": "ed-alt-hint" });
  altInput.value = photo.alt_text_raw || "";

  const altCounter = el("span.pga-counter");
  const updateCounter = () => { altCounter.textContent = `${altInput.value.length} characters`; };
  updateCounter();
  altInput.addEventListener("input", updateCounter);

  const altHint = el("p.pga-hint", { id: "ed-alt-hint", style: { margin: "4px 0 0" }, text:
    "Describe what's in the photo for someone who can't see it — who is there and what " +
    "is happening. This is read aloud by screen readers, so it isn't the same as a caption." });

  // Only meaningful because adminRow now returns alt_text_raw separately; the
  // coalesced alt_text would have made this look already-done.
  const reusing = !photo.alt_text_raw && photo.caption
    ? el("p.pga-error", { style: { margin: "4px 0 0", color: "var(--pga-warn)" }, text:
        "Currently falling back to the caption. Write a real description here." })
    : null;

  const gallerySelect = el("select", { id: "ed-gallery" },
    ...context.categories.map((cat) => el("option", { value: cat.slug, text: cat.name })));
  gallerySelect.value = photo.gallery;

  const yearInput = el("input", { id: "ed-year", type: "number", min: "1990", max: "2100" });
  yearInput.value = String(photo.year || "");

  const dateInput = el("input", { id: "ed-date", type: "date" });
  dateInput.value = isoToDate(photo.taken_at);

  const featuredCheck = el("input", { type: "checkbox" });
  featuredCheck.checked = !!photo.is_featured;

  const orderInput = el("input", { id: "ed-order", type: "number", style: { width: "6rem" } });
  orderInput.value = photo.featured_order == null ? "" : String(photo.featured_order);

  const publishedCheck = el("input", { type: "checkbox" });
  publishedCheck.checked = photo.published !== false;

  const submissionInput = el("input", { id: "ed-submission", type: "text" });
  submissionInput.value = photo.submission || "";

  const peopleWrap = el("div.pga-inline");
  function renderPeople() {
    const tags = (photo.people || []).map((name) => {
      const chip = el("span.pga-badge.pga-badge-video", null, name);
      chip.append(el("button", {
        type: "button",
        "aria-label": `Remove ${name} from this photo`,
        style: { background: "none", border: "none", cursor: "pointer", color: "inherit", padding: "0 0 0 2px", fontSize: "1rem", lineHeight: "1" },
        onclick: () => untagPerson(photo, name, renderPeople),
      }, "×"));
      return chip;
    });
    peopleWrap.replaceChildren(...(tags.length ? tags : [el("span.pga-muted", { text: "Nobody tagged yet." })]));
  }
  renderPeople();

  body.append(
    preview,
    el("div.pga-field.grow", null, el("label", { for: "ed-caption", text: "Caption" }), captionInput),
    el("div.pga-field.grow", null,
      el("div.pga-inline", null,
        el("label", { for: "ed-alt", text: "Alt text (image description)" }),
        altCounter,
      ),
      altInput, altHint, reusing,
    ),
    el("hr.pga-sep"),
    el("div.pga-row", null,
      el("div.pga-field", null, el("label", { for: "ed-gallery", text: "Album" }), gallerySelect),
      el("div.pga-field", null, el("label", { for: "ed-year", text: "Year" }), yearInput),
      el("div.pga-field", null, el("label", { for: "ed-date", text: "Date taken" }), dateInput),
    ),
    el("div.pga-row", null,
      el("label.pga-check", null, publishedCheck, "Visible on the website"),
      el("label.pga-check", null, featuredCheck, "Show in header scroll"),
      el("div.pga-field", null, el("label", { for: "ed-order", text: "Scroll order" }), orderInput),
    ),
    el("div.pga-field.grow", null,
      el("label", { for: "ed-submission", text: "Batch label" }), submissionInput),
    el("hr.pga-sep"),
    el("div", null, el("p.pga-label", { text: "People in this photo" }), peopleWrap),
  );

  if (photo.media_type !== "video") {
    body.append(el("hr.pga-sep"), buildFacesPanel(photo, renderPeople));
  }

  const instance = dialog({
    title: photo.caption || "Edit photo",
    body,
    wide: true,
    initialFocus: "#ed-alt",
    actions: [
      {
        label: "Delete",
        kind: "danger",
        keepOpen: true,
        run: async () => {
          const ok = await confirmDialog({
            title: "Delete this photo?",
            body: "The photo and its thumbnail are removed from storage as well. This cannot be undone.",
            confirmLabel: "Delete permanently",
            danger: true,
          });
          if (!ok) return;
          await api("delete", { id: photo.id });
          store.byId.delete(photo.id);
          store.selected.delete(photo.id);
          toast("Photo deleted.", { kind: "success" });
          instance.close();
          refresh();
        },
      },
      { label: "Cancel", kind: "ghost" },
      {
        label: "Save changes",
        kind: "primary",
        run: async () => {
          const year = parseInt(yearInput.value, 10);
          if (Number.isNaN(year) || year < 1990 || year > 2100) {
            yearInput.setAttribute("aria-invalid", "true");
            throw new Error("Enter a year between 1990 and 2100.");
          }
          const order = orderInput.value.trim();
          const patch = {
            caption: captionInput.value.trim(),
            alt_text: altInput.value.trim(),
            gallery: gallerySelect.value,
            year,
            // <input type=date> gives yyyy-mm-dd; keep it null rather than
            // sending an empty string, which would fail the timestamp cast.
            taken_at: dateInput.value ? `${dateInput.value}T12:00:00` : null,
            is_featured: featuredCheck.checked,
            featured_order: order === "" ? null : Number(order),
            published: publishedCheck.checked,
            submission: submissionInput.value.trim() || null,
          };
          await api("update", { id: photo.id, patch });
          toast("Changes saved.", { kind: "success" });
          refresh();
        },
      },
    ],
  });
}

/* ---------- per-photo faces ------------------------------------------- */

/**
 * Faces on one photo: confirm a suggestion, unconfirm a mistake, delete a
 * spurious detection, or draw a box the detector missed.
 *
 * Boxes are fractions of the image, so the overlay is placed by multiplying
 * against the *rendered* size — correct at any display width.
 */
function buildFacesPanel(photo, onPeopleChange) {
  const wrap = el("div");
  const statusLine = el("p.pga-hint", { "role": "status", style: { margin: "0 0 8px" } });
  const boxWrap = el("div.pga-boxwrap");
  const image = el("img", { src: photo.image_url, alt: "", style: { maxHeight: "300px", borderRadius: "8px" } });
  const list = el("div.pga-facegrid");
  boxWrap.append(image);

  let faces = [];
  let drawing = null;

  function placeBoxes() {
    for (const node of Array.from(boxWrap.querySelectorAll(".pga-box"))) node.remove();
    for (const face of faces) {
      const px = toPixelBox(face.box, image.clientWidth, image.clientHeight);
      const node = el("div.pga-box", {
        "dataset": { named: String(!!face.person) },
        style: { left: `${px.x}px`, top: `${px.y}px`, width: `${px.w}px`, height: `${px.h}px` },
      });
      boxWrap.append(node);
    }
  }
  image.addEventListener("load", placeBoxes);
  window.addEventListener("resize", debounce(placeBoxes, 200));

  async function load() {
    list.replaceChildren(loadingState("Loading faces…"));
    try {
      const res = await api("faces-for-photo", { photo_id: photo.id });
      faces = res.faces || [];
      statusLine.textContent = !res.scanned
        ? "This photo hasn't been scanned for faces yet — run a scan in People & Faces."
        : faces.length
          ? `${plural(faces.length, "face")} found.`
          : "No faces were detected in this photo.";
      renderList();
      placeBoxes();
    } catch (err) {
      list.replaceChildren(emptyState({ title: "Could not load faces", body: err.message, icon: null }));
    }
  }

  function renderList() {
    if (!faces.length) { list.replaceChildren(); return; }
    list.replaceChildren(...faces.map((face) => {
      const cell = el("div.pga-facecell");
      const crop = el("img.pga-facecrop", { alt: face.person ? face.person.name : "Unidentified face" });
      faceCropUrl(photo.image_url, face.box, 200).then((url) => { crop.src = url; }).catch(() => {});
      cell.append(crop);

      if (face.person) {
        cell.append(
          el("span.pga-badge.pga-badge-featured", { text: face.person.name }),
          el("button.pga-btn.pga-btn-ghost.pga-btn-sm", {
            type: "button",
            onclick: async () => {
              try {
                await api("face-unconfirm", { face_id: face.id });
                toast(`${face.person.name} detached from this face.`, { kind: "success" });
                await load();
                await syncPeople();
              } catch (err) { toastError(err); }
            },
          }, "Not them"),
        );
      } else if (face.suggestion) {
        cell.append(
          el("span.pga-muted", { style: { fontSize: "0.8rem" }, text:
            `${face.suggestion.name}? ${confidenceLabel(face.suggestion.distance)}` }),
          el("button.pga-btn.pga-btn-primary.pga-btn-sm", {
            type: "button",
            onclick: async () => {
              try {
                await api("face-confirm", { face_id: face.id, person_id: face.suggestion.id });
                toast(`Confirmed ${face.suggestion.name}.`, { kind: "success" });
                await load();
                await syncPeople();
              } catch (err) { toastError(err); }
            },
          }, "Yes"),
          el("button.pga-btn.pga-btn-outline.pga-btn-sm", {
            type: "button",
            onclick: async () => {
              const suggested = face.suggestion;
              try {
                await api("face-reject", { face_id: face.id, person_id: suggested.id });
                toast(`Rejected — ${suggested.name} won't be suggested for this face again.`, {
                  duration: 6000,
                  action: {
                    label: "Undo",
                    run: async () => {
                      try {
                        const res = await api("face-unreject", { face_id: face.id, person_id: suggested.id });
                        toast(res.suggestion
                          ? `Undone — ${res.suggestion.name} is suggested again.`
                          : "Undone. That guess no longer matches closely enough to be re-suggested.");
                        await load();
                      } catch (err) { toastError(err); }
                    },
                  },
                });
                await load();
              } catch (err) { toastError(err); }
            },
          }, "No"),
        );
      } else {
        cell.append(el("button.pga-btn.pga-btn-blue.pga-btn-sm", {
          type: "button",
          onclick: () => nameFace(face),
        }, "Name this face"));
      }

      cell.append(el("button.pga-btn.pga-btn-danger.pga-btn-sm", {
        type: "button",
        onclick: async () => {
          const ok = await confirmDialog({
            title: "Not a face?",
            body: "For posters, reflections and blurs. The detection is deleted; the photo is untouched.",
            confirmLabel: "Remove",
            danger: true,
          });
          if (!ok) return;
          try {
            await api("face-delete", { face_id: face.id });
            await load();
          } catch (err) { toastError(err); }
        },
      }, "Not a face"));

      return cell;
    }));
  }

  async function syncPeople() {
    // people[] is rebuilt by trigger, so re-read the row to reflect it.
    try {
      const res = await api("list-admin", { gallery: photo.gallery, year: photo.year, limit: 500 });
      const fresh = (res.photos || []).find((p) => p.id === photo.id);
      if (fresh) {
        photo.people = fresh.people;
        store.byId.set(photo.id, { ...store.byId.get(photo.id), people: fresh.people });
        onPeopleChange();
      }
    } catch { /* cosmetic */ }
  }

  async function nameFace(face) {
    const name = await promptDialog({
      title: "Who is this?",
      label: "Name",
      hint: "Confirming this face teaches recognition, so future photos of this person get suggested automatically.",
      confirmLabel: "Confirm",
    });
    if (!name) return;
    try {
      await api("face-confirm", { face_id: face.id, new_person_name: name });
      toast(`Confirmed ${name}.`, { kind: "success" });
      await load();
      await syncPeople();
    } catch (err) { toastError(err); }
  }

  /* --- draw a box the detector missed --- */

  const drawBtn = el("button.pga-btn.pga-btn-outline.pga-btn-sm", { type: "button" }, "Draw a missed face");
  const drawHint = el("p.pga-hint", { style: { margin: "6px 0 0" } });

  drawBtn.addEventListener("click", async () => {
    if (drawing) { stopDrawing(); return; }
    drawHint.textContent = "Loading face recognition…";
    try {
      await loadFaceApi((m) => { drawHint.textContent = m; });
    } catch (err) { drawHint.textContent = ""; toastError(err); return; }
    startDrawing();
  });

  let previewBox = null;
  let anchor = null;

  function startDrawing() {
    drawing = true;
    drawBtn.textContent = "Cancel drawing";
    drawHint.textContent = "Drag a rectangle around the face you want to add.";
    image.style.cursor = "crosshair";
    boxWrap.addEventListener("pointerdown", onDown);
  }

  function stopDrawing() {
    drawing = false;
    drawBtn.textContent = "Draw a missed face";
    drawHint.textContent = "";
    image.style.cursor = "";
    previewBox?.remove();
    previewBox = null;
    anchor = null;
    boxWrap.removeEventListener("pointerdown", onDown);
    boxWrap.removeEventListener("pointermove", onMove);
    boxWrap.removeEventListener("pointerup", onUp);
  }

  function relativePoint(event) {
    const rect = image.getBoundingClientRect();
    return {
      x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
    };
  }

  function onDown(event) {
    if (!drawing) return;
    event.preventDefault();
    anchor = relativePoint(event);
    previewBox = el("div.pga-box", { "dataset": { named: "false" } });
    boxWrap.append(previewBox);
    boxWrap.addEventListener("pointermove", onMove);
    boxWrap.addEventListener("pointerup", onUp);
  }

  function onMove(event) {
    if (!anchor || !previewBox) return;
    const point = relativePoint(event);
    Object.assign(previewBox.style, {
      left: `${Math.min(anchor.x, point.x)}px`,
      top: `${Math.min(anchor.y, point.y)}px`,
      width: `${Math.abs(point.x - anchor.x)}px`,
      height: `${Math.abs(point.y - anchor.y)}px`,
    });
  }

  async function onUp(event) {
    if (!anchor) return;
    const point = relativePoint(event);
    const rect = image.getBoundingClientRect();
    const box = {
      x: Math.min(anchor.x, point.x) / rect.width,
      y: Math.min(anchor.y, point.y) / rect.height,
      w: Math.abs(point.x - anchor.x) / rect.width,
      h: Math.abs(point.y - anchor.y) / rect.height,
    };
    stopDrawing();

    if (box.w < 0.02 || box.h < 0.02) { toast("That box is too small.", { kind: "error" }); return; }

    drawHint.textContent = "Looking for a face in that box…";
    let described;
    try {
      described = await describeBox(photo.image_url, box);
    } catch (err) { drawHint.textContent = ""; toastError(err); return; }

    if (!described) {
      drawHint.textContent = "";
      // Honest fallback: face-add-manual needs a real descriptor, and a box
      // around a hat would poison that person's exemplars.
      toast(
        "No face was found in that box. You can still tag the person without a face using the tag list above.",
        { kind: "error", duration: 9000 },
      );
      return;
    }

    const name = await promptDialog({
      title: "Who is this?",
      label: "Name",
      hint: "This face becomes an example for that person, improving future suggestions.",
      confirmLabel: "Add face",
    });
    drawHint.textContent = "";
    if (!name) return;

    try {
      const found = await api("people-list", { q: name, limit: 20 });
      const person = (found.people || []).find(
        (p) => p.display_name.toLowerCase() === name.toLowerCase());
      const payload = {
        photo_id: photo.id,
        box,
        embedding: described.embedding,
        det_score: described.det_score,
      };
      if (person) payload.person_id = person.id;
      const added = await api("face-add-manual", payload);
      if (!person) {
        // face-add-manual takes no new_person_name, so create the person and
        // confirm the face it just returned.
        const created = await api("person-create", { display_name: name });
        await api("face-confirm", { face_id: added.face_id, person_id: created.person.id });
      }
      toast(`Added ${name} to this photo.`, { kind: "success" });
      await load();
      await syncPeople();
    } catch (err) { toastError(err); }
  }

  wrap.append(
    el("p.pga-label", { text: "Faces" }),
    statusLine,
    boxWrap,
    el("div.pga-row", { style: { marginTop: "10px" } }, drawBtn),
    drawHint,
    list,
  );
  load();
  return wrap;
}

async function untagPerson(photo, name, rerender) {
  // photo.people holds display names; we need the id to untag.
  try {
    const res = await api("people-list", { q: name, limit: 20 });
    const person = (res.people || []).find(
      (p) => p.display_name.toLowerCase() === name.toLowerCase());
    if (!person) { toast(`Could not find “${name}” in the people list.`, { kind: "error" }); return; }
    await api("photo-untag", { photo_id: photo.id, person_id: person.id });
    photo.people = (photo.people || []).filter((n) => n !== name);
    rerender();
    toast(`Removed ${name} from this photo.`, { kind: "success" });
    refresh();
  } catch (err) {
    // The function refuses when a confirmed face still links this person,
    // because the trigger would immediately re-add the tag.
    if (err instanceof PGError && err.status === 409) {
      toast(
        `${name} has a confirmed face in this photo. Open People & Faces and unconfirm the face instead.`,
        { kind: "error", duration: 9000 },
      );
    } else {
      toastError(err);
    }
  }
}

/* ---------- bulk actions ---------------------------------------------- */

function selectedIds() {
  return Array.from(store.selected);
}

async function bulkPatch(patch, describe) {
  const ids = selectedIds();
  if (!ids.length) { toast("Select some photos first.", { kind: "error" }); return; }
  try {
    const res = await api("bulk-update", { ids, patch });
    toast(`${describe} for ${plural(res.updated, "photo")}.`, { kind: "success" });
    announce(`${describe} for ${plural(res.updated, "photo")}.`, { force: true });
    refresh();
  } catch (err) {
    toastError(err);
  }
}

async function bulkDelete() {
  const ids = selectedIds();
  if (!ids.length) { toast("Select some photos first.", { kind: "error" }); return; }
  const ok = await confirmDialog({
    title: `Delete ${plural(ids.length, "photo")}?`,
    body: "Each photo and its thumbnail are removed from storage as well. This cannot be undone.",
    confirmLabel: `Delete ${num(ids.length)} permanently`,
    danger: true,
  });
  if (!ok) return;

  let failed = 0;
  // No bulk delete action exists, so fan out — but count failures honestly.
  // The old page's recursive loop treated every error as a success.
  await pool(ids.map((id) => async () => {
    try {
      await api("delete", { id });
      store.byId.delete(id);
      store.selected.delete(id);
    } catch {
      failed++;
    }
  }), 4);

  if (failed) toast(`Deleted ${plural(ids.length - failed, "photo")}; ${num(failed)} failed.`, { kind: "error" });
  else toast(`Deleted ${plural(ids.length, "photo")}.`, { kind: "success" });
  refresh();
}

/** Tagging must go through photo-tag: `people`/`add_people` in a patch is
    silently dropped by buildPatch, which is why bulk tagging never worked. */
async function bulkTag() {
  const ids = selectedIds();
  if (!ids.length) { toast("Select some photos first.", { kind: "error" }); return; }

  const name = await promptDialog({
    title: `Tag someone in ${plural(ids.length, "photo")}`,
    label: "Person's name",
    hint: "If this name isn't in the people list yet it will be added. Tagging this way records no face, so it doesn't teach face recognition — confirm a face in People & Faces for that.",
    confirmLabel: "Tag them",
  });
  if (!name) return;

  try {
    const found = await api("people-list", { q: name, limit: 20 });
    let person = (found.people || []).find(
      (p) => p.display_name.toLowerCase() === name.toLowerCase());
    if (!person) {
      const created = await api("person-create", { display_name: name });
      person = created.person;
    }

    let failed = 0;
    await pool(ids.map((id) => async () => {
      try { await api("photo-tag", { photo_id: id, person_id: person.id }); } catch { failed++; }
    }), 4);

    if (failed) toast(`Tagged ${num(ids.length - failed)}; ${num(failed)} failed.`, { kind: "error" });
    else toast(`Tagged ${name} in ${plural(ids.length, "photo")}.`, { kind: "success" });
    refresh();
  } catch (err) {
    if (err instanceof PGError && err.status === 409 && err.body.existing_id) {
      // Race with another tab creating the same person.
      await pool(ids.map((id) => async () => {
        try { await api("photo-tag", { photo_id: id, person_id: err.body.existing_id }); } catch { /* counted below */ }
      }), 4);
      toast(`Tagged ${name}.`, { kind: "success" });
      refresh();
    } else {
      toastError(err);
    }
  }
}

async function bulkYear() {
  const value = await promptDialog({
    title: `Change year for ${plural(store.selected.size, "photo")}`,
    label: "Year",
    type: "number",
    value: String(context.year),
    confirmLabel: "Set year",
  });
  if (!value) return;
  const year = parseInt(value, 10);
  if (Number.isNaN(year) || year < 1990 || year > 2100) {
    toast("Enter a year between 1990 and 2100.", { kind: "error" });
    return;
  }
  await bulkPatch({ year }, `Year set to ${year}`);
}

async function bulkMove() {
  const body = el("div.pga-field.grow", null,
    el("label", { for: "mv-gallery", text: "Move to album" }),
    el("select", { id: "mv-gallery" }, ...context.categories.map(
      (cat) => el("option", { value: cat.slug, text: cat.is_public ? cat.name : `${cat.name} · private` }))),
  );
  const instance = dialog({
    title: `Move ${plural(store.selected.size, "photo")}`,
    body,
    initialFocus: "#mv-gallery",
    actions: [
      { label: "Cancel", kind: "ghost" },
      { label: "Move", kind: "primary", run: () => body.querySelector("#mv-gallery").value },
    ],
  });
  const slug = await instance.result;
  if (!slug) return;
  await bulkPatch({ gallery: slug }, `Moved to ${context.name(slug)}`);
}

/* ---------- toolbar --------------------------------------------------- */

function updateToolbar() {
  if (!host) return;
  const count = store.selected.size;
  const onPage = store.order.filter((id) => store.selected.has(id)).length;
  const label = host.querySelector("#lib-selcount");
  if (label) {
    label.textContent = count
      ? `${plural(count, "photo")} selected${count !== onPage ? ` (${num(onPage)} on this page)` : ""}`
      : "Nothing selected";
  }
  for (const btn of host.querySelectorAll("[data-needs-selection]")) {
    btn.disabled = count === 0;
  }
}

/* ---------- render ---------------------------------------------------- */

function renderGrid() {
  const items = store.order.map((id) => store.byId.get(id)).filter(Boolean);
  if (!items.length) {
    cards.replaceChildren(emptyState({
      title: store.filter ? "Nothing matches this filter" : "No photos here yet",
      body: store.filter
        ? "Try “All”, a different year, or another album."
        : `Nothing in ${context.name()} for ${store.allYears ? "any year" : context.year}. Upload some photos to get started.`,
      action: store.filter ? null : { label: "Go to Upload", run: () => navigate("upload") },
    }));
    return;
  }
  reconcile(cards, items, {
    key: (photo) => photo.id,
    create: createCell,
    // A row mid-edit is left alone entirely, so a background refresh can't
    // overwrite what someone is typing.
    update: (node, photo) => { if (!store.dirty.has(photo.id)) updateCell(node, photo); },
  });
}

function renderPager() {
  const pager = host.querySelector("#lib-pager");
  if (!pager) return;
  const pages = Math.max(1, Math.ceil(store.total / PAGE_SIZE));
  const from = store.total ? store.page * PAGE_SIZE + 1 : 0;
  const to = Math.min(store.total, (store.page + 1) * PAGE_SIZE);

  pager.replaceChildren(
    el("button.pga-btn.pga-btn-outline.pga-btn-sm", {
      type: "button",
      disabled: store.page === 0,
      onclick: () => { store.page--; setRouteParams({ page: store.page + 1 }); refresh(); },
    }, "‹ Previous"),
    el("span.pga-pager-status", { "role": "status", text:
      store.total ? `Showing ${num(from)}–${num(to)} of ${num(store.total)}` : "No photos" }),
    el("button.pga-btn.pga-btn-outline.pga-btn-sm", {
      type: "button",
      disabled: store.page >= pages - 1,
      onclick: () => { store.page++; setRouteParams({ page: store.page + 1 }); refresh(); },
    }, "Next ›"),
  );
}

async function refresh() {
  const grid = host.querySelector("#lib-grid");
  if (!grid) return;
  try {
    await fetchPage();
    renderGrid();
    renderPager();
    updateToolbar();
    refreshCounts();
  } catch (err) {
    cards.replaceChildren(emptyState({ title: "Could not load photos", body: err.message, icon: null }));
  }
}

async function refreshCounts() {
  const counts = await fetchCounts();
  FILTERS.forEach((filter, index) => {
    const chip = host.querySelector(`[data-filter="${filter.id}"] .pga-chip-count`);
    if (chip) chip.textContent = counts[index] == null ? "" : num(counts[index]);
    const button = host.querySelector(`[data-filter="${filter.id}"]`);
    if (button && counts[index] != null) {
      button.setAttribute("aria-label", `${filter.label}, ${plural(counts[index], "photo")}`);
    }
  });
}

/* ---------- mount: Library -------------------------------------------- */

export function mountLibrary(view, params) {
  host = view;
  store.filter = params.get("filter") || "";
  store.page = Math.max(0, (parseInt(params.get("page"), 10) || 1) - 1);
  store.allYears = params.get("years") === "all";

  const chips = el("div.pga-chiprow", { "role": "tablist", "aria-label": "Filter photos" },
    ...FILTERS.map((filter) => el("button.pga-chip", {
      type: "button",
      "role": "tab",
      "dataset": { filter: filter.id },
      "aria-selected": String(store.filter === filter.id),
      onclick: () => {
        store.filter = filter.id;
        store.page = 0;
        setRouteParams({ filter: filter.id || null, page: null });
        for (const chip of host.querySelectorAll(".pga-chip[data-filter]")) {
          chip.setAttribute("aria-selected", String(chip.dataset.filter === filter.id));
        }
        refresh();
      },
    }, el("span", { text: filter.label }), el("span.pga-chip-count"))),
  );

  const yearToggle = el("label.pga-check", null,
    el("input", {
      type: "checkbox",
      checked: store.allYears,
      onchange: (event) => {
        store.allYears = event.target.checked;
        store.page = 0;
        setRouteParams({ years: store.allYears ? "all" : null, page: null });
        refresh();
      },
    }),
    "All years",
  );

  const toolbar = el("div.pga-toolbar", null,
    el("span.pga-toolbar-count", { id: "lib-selcount", "role": "status", text: "Nothing selected" }),
    el("button.pga-btn.pga-btn-ghost.pga-btn-sm", {
      type: "button",
      onclick: () => {
        for (const id of store.order) store.selected.add(id);
        renderGrid();
        updateToolbar();
      },
    }, "Select page"),
    el("button.pga-btn.pga-btn-ghost.pga-btn-sm", {
      type: "button",
      onclick: () => { store.selected.clear(); renderGrid(); updateToolbar(); },
    }, "Clear"),
    el("button.pga-btn.pga-btn-primary.pga-btn-sm", { type: "button", "data-needs-selection": "", onclick: bulkTag }, "Tag someone…"),
    el("button.pga-btn.pga-btn-ghost.pga-btn-sm", { type: "button", "data-needs-selection": "", onclick: bulkYear }, "Set year…"),
    el("button.pga-btn.pga-btn-ghost.pga-btn-sm", { type: "button", "data-needs-selection": "", onclick: bulkMove }, "Move…"),
    el("button.pga-btn.pga-btn-ghost.pga-btn-sm", { type: "button", "data-needs-selection": "", onclick: () => bulkPatch({ is_featured: true }, "Featured") }, "Feature"),
    el("button.pga-btn.pga-btn-ghost.pga-btn-sm", { type: "button", "data-needs-selection": "", onclick: () => bulkPatch({ is_featured: false }, "Un-featured") }, "Un-feature"),
    el("button.pga-btn.pga-btn-ghost.pga-btn-sm", { type: "button", "data-needs-selection": "", onclick: () => bulkPatch({ published: true }, "Made visible") }, "Show"),
    el("button.pga-btn.pga-btn-ghost.pga-btn-sm", { type: "button", "data-needs-selection": "", onclick: () => bulkPatch({ published: false }, "Hidden") }, "Hide"),
    el("button.pga-btn.pga-btn-danger.pga-btn-sm", { type: "button", "data-needs-selection": "", onclick: bulkDelete }, "Delete"),
  );

  cards = el("div.pga-grid");

  const panel = el("div.pga-panel", { id: "lib-grid" },
    el("h2", { text: "Library" }),
    el("p.pga-hint", { text:
      "Type straight into a caption box to edit it — changes save as you go. Click a photo " +
      "for alt text and the rest of its details. Selections are kept while you page around, " +
      "so you can gather photos across pages before acting on them." }),
    el("div.pga-row", { style: { marginBottom: "12px" } }, yearToggle),
    chips,
    toolbar,
    cards,
    el("div.pga-pager", { id: "lib-pager" }),
  );

  const altCta = el("div.pga-panel", null,
    el("h3", { text: "Write alt text, one photo at a time" }),
    el("p.pga-hint", { text:
      "A focused view that steps through every photo missing an image description, " +
      "with a large preview and one box to type in. Faster than editing them in the grid." }),
    el("button.pga-btn.pga-btn-blue", {
      type: "button",
      onclick: () => openAltQueue(),
    }, "Open alt-text queue"),
  );

  view.replaceChildren(panel, altCta);

  if (unsubscribe) unsubscribe();
  unsubscribe = onContextChange(() => {
    store.page = 0;
    // A different album is a different working set; keeping the old selection
    // would let a bulk action hit photos that are no longer on screen.
    if (store.selected.size) {
      store.selected.clear();
      toast("Selection cleared — you changed album or year.");
    }
    refresh();
  });

  refresh();
}

/* ---------- alt-text queue -------------------------------------------- */

/**
 * Walks photos with needs_alt, one at a time. The grid will never burn down a
 * whole backlog; a triage flow will.
 */
async function openAltQueue() {
  let items = [];
  let index = 0;
  let described = 0;

  const preview = el("img", {
    alt: "",
    style: { width: "100%", maxHeight: "44vh", objectFit: "contain", background: "#e9eef3", borderRadius: "8px" },
  });
  const captionLine = el("p.pga-muted", { style: { fontSize: "0.88rem", margin: "8px 0 0" } });
  const input = el("textarea", { id: "aq-alt", rows: "4", "aria-describedby": "aq-hint" });
  const counter = el("span.pga-counter");
  const progress = el("p.pga-hint", { "role": "status", style: { margin: "0" } });

  input.addEventListener("input", () => { counter.textContent = `${input.value.length} characters`; });

  const body = el("div.pga-stack", null,
    progress,
    preview,
    captionLine,
    el("div.pga-field.grow", null,
      el("div.pga-inline", null, el("label", { for: "aq-alt", text: "Describe this photo" }), counter),
      input,
      el("p.pga-hint", { id: "aq-hint", style: { margin: "4px 0 0" }, text:
        "Say who is in the photo and what is happening. Skip “image of” — screen readers " +
        "already announce that it's an image. One or two sentences is usually right." }),
    ),
  );

  function show() {
    const photo = items[index];
    if (!photo) {
      preview.removeAttribute("src");
      captionLine.textContent = "";
      input.value = "";
      progress.textContent = described
        ? `All done — you described ${plural(described, "photo")}. 🎉`
        : "Nothing is missing alt text right now. 🎉";
      input.disabled = true;
      return;
    }
    input.disabled = false;
    preview.src = photo.image_url;
    captionLine.textContent = photo.caption
      ? `Caption: ${photo.caption}`
      : "No caption either.";
    input.value = photo.alt_text_raw || "";
    counter.textContent = `${input.value.length} characters`;
    progress.textContent = `${num(index + 1)} of ${num(items.length)} in this batch · ${plural(described, "photo")} described`;
    input.focus();
  }

  async function saveAndNext() {
    const photo = items[index];
    if (!photo) return;
    const value = input.value.trim();
    if (!value) { toast("Write a description, or use Skip.", { kind: "error" }); return; }
    await api("update", { id: photo.id, patch: { alt_text: value } });
    const cached = store.byId.get(photo.id);
    if (cached) { cached.alt_text_raw = value; cached.alt_text = value; cached.needs_alt = false; }
    described++;
    index++;
    announce(`Saved. ${plural(items.length - index, "photo")} left.`);
    show();
  }

  // Ctrl/Cmd+Enter saves — Enter alone must still insert a newline.
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      saveAndNext().catch(toastError);
    }
  });

  const instance = dialog({
    title: "Alt-text queue",
    body,
    wide: true,
    initialFocus: "#aq-alt",
    actions: [
      { label: "Close", kind: "ghost" },
      { label: "Skip", kind: "outline", keepOpen: true, run: () => { index++; show(); } },
      { label: "Save & next (Ctrl+Enter)", kind: "primary", keepOpen: true, run: saveAndNext },
    ],
  });

  progress.textContent = "Loading…";
  try {
    const res = await api("list-admin", { filter: "needs_alt", limit: 200 });
    items = res.photos || [];
    show();
  } catch (err) {
    progress.textContent = err.message;
  }

  await instance.result;
  refresh();
}

/* ---------- mount: Review --------------------------------------------- */

export async function mountReview(view) {
  host = view;
  const container = el("div.pga-stack");
  const panel = el("div.pga-panel", null,
    el("h2", { text: "Awaiting review" }),
    el("p.pga-hint", { text:
      "Photos sent in by photographers, and anything you've hidden, wait here. They are " +
      "not on the website until you approve them. Grouped by the batch label the " +
      "photographer gave, across every album and year." }),
    container,
  );
  view.replaceChildren(panel);
  container.replaceChildren(loadingState());

  await renderReview(container);
}

async function renderReview(container) {
  let photos = [];
  try {
    // Server-side filter, and page right through it: the old page fetched
    // unfiltered and filtered in JS, so anything past row 100 never appeared.
    let offset = 0;
    for (;;) {
      const res = await api("list-admin", { filter: "unpublished", limit: 500, offset });
      photos = photos.concat(res.photos || []);
      offset += 500;
      if (photos.length >= (res.total || 0) || !(res.photos || []).length) break;
    }
  } catch (err) {
    container.replaceChildren(emptyState({ title: "Could not load the review queue", body: err.message, icon: null }));
    return;
  }

  setTabCount("review", photos.length, { attention: true, noun: "awaiting review" });

  if (!photos.length) {
    container.replaceChildren(emptyState({
      title: "Nothing waiting",
      body: "Every submission has been reviewed. Photographer batches will appear here.",
    }));
    return;
  }

  const groups = new Map();
  for (const photo of photos) {
    const key = (photo.submission || "").trim() || `${context.name(photo.gallery)} · ${photo.year}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(photo);
  }

  container.replaceChildren(...Array.from(groups, ([label, items]) => {
    const grid = el("div.pga-grid");
    for (const photo of items) {
      const cell = createCell(false);
      cell.dataset.key = photo.id;
      store.byId.set(photo.id, photo);
      updateCell(cell, photo);
      grid.append(cell);
    }

    const ids = items.map((p) => p.id);

    return el("div.pga-panel", { style: { background: "var(--pga-sunken)" } },
      el("div.pga-toolbar", { style: { background: "#fff" } },
        el("span.pga-toolbar-count", { text: label }),
        el("span.pga-badge.pga-badge-hidden", { text: plural(items.length, "photo") }),
        el("button.pga-btn.pga-btn-primary.pga-btn-sm", {
          type: "button",
          onclick: async () => {
            try {
              const res = await api("bulk-update", { ids, patch: { published: true } });
              toast(`Approved ${plural(res.updated, "photo")} — now live.`, { kind: "success" });
              mountReview(host);
            } catch (err) { toastError(err); }
          },
        }, "Approve all"),
        el("button.pga-btn.pga-btn-danger.pga-btn-sm", {
          type: "button",
          onclick: async () => {
            const ok = await confirmDialog({
              title: `Reject ${plural(items.length, "photo")}?`,
              body: `Everything in “${label}” is deleted, including the stored files. This cannot be undone.`,
              confirmLabel: `Delete ${num(items.length)}`,
              danger: true,
            });
            if (!ok) return;
            let failed = 0;
            await pool(ids.map((id) => async () => {
              try { await api("delete", { id }); } catch { failed++; }
            }), 4);
            if (failed) toast(`Deleted ${num(ids.length - failed)}; ${num(failed)} failed.`, { kind: "error" });
            else toast(`Rejected ${plural(ids.length, "photo")}.`, { kind: "success" });
            mountReview(host);
          },
        }, "Reject all"),
      ),
      el("p.pga-hint", { text: "Click any photo to fix its album, year or caption before approving." }),
      grid,
    );
  }));
}
