// photo-gallery
// -----------------------------------------------------------------------------
// Backend for /photogallery.
//   * PUBLIC reads  — GET  ?action=list  (only the Supabase gateway apikey)
//   * ADMIN writes  — POST + x-admin-token (SHA-256 checked, constant-time)
//
// This is the v2 backend, targeting the schema in
// migrations/20260729_gallery_people_and_faces_v2.sql plus the helpers in
// migrations/20260729_gallery_resuggest_and_search.sql. Key differences from v1:
//
//   * Two roles, both shared passphrases hashed with SHA-256:
//       - admin        (photo_gallery_config.admin_token_sha256) — everything.
//       - photographer (photo_gallery_config.photographer_token_sha256) —
//         upload only: `categories`, `upload-urls`, `upload-commit`. Its
//         commits are FORCED unpublished so a submission lands in the admin
//         review queue and can never appear on the public site unreviewed.
//         It cannot read, edit or delete anything. This exists so the
//         /photogallery/upload/ link can be handed to a photographer without
//         handing over the ability to delete the gallery.
//       Anything else, or no token, is 401.
//   * gallery_photos.people[] is a TRIGGER-MAINTAINED CACHE derived from
//     gallery_photo_people. The function NEVER writes it directly. To tag a
//     photo, insert into gallery_photo_people; the trigger rebuilds people[].
//   * Face descriptors are vector(128). Matching happens in Postgres RPCs, not
//     in JavaScript. Naming a face no longer auto-writes across the DB — it is
//     a suggest → human-confirm/reject loop.
//   * Uploads are direct-to-storage via signed URLs; the function never touches
//     the image bytes for uploads (only imports still re-host).
//
// Postgres error text is never echoed to the client (it leaks schema); errors
// are logged server-side and a generic message is returned.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
};

const BUCKET = "gallery";
const SOURCES = ["upload", "google_photos", "gdrive", "dropbox", "repo", "youtube", "vimeo"];
const PERSON_KINDS = ["participant", "staff", "board", "family", "guest", "unknown"];
// Hosts the `import` action is allowed to fetch from. Matched as suffixes, so
// e.g. lh3.googleusercontent.com is covered by "googleusercontent.com". Without
// this the function would be an open SSRF proxy for any URL the caller sends.
const IMPORT_HOST_SUFFIXES = [
  "googleusercontent.com", "googleapis.com", "photoslibrary.googleapis.com",
  "drive.google.com", "dropboxusercontent.com", "dropbox.com",
];
// A neutral video poster used when a provider gives us no thumbnail.
const VIDEO_POSTER = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='480'%20height='270'%3E%3Crect%20width='100%25'%20height='100%25'%20fill='%23002b50'/%3E%3Cpolygon%20points='205,108 205,162 260,135'%20fill='white'/%3E%3C/svg%3E";

type Supa = ReturnType<typeof supa>;

function supa() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
type Category = { slug: string; name: string; is_public: boolean; sort_order: number };
async function loadCats(sb: Supa): Promise<Category[]> {
  const { data } = await sb.from("gallery_categories")
    .select("slug, name, is_public, sort_order")
    .order("sort_order", { ascending: true }).order("name", { ascending: true });
  return (data ?? []) as Category[];
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tokenMatches(provided: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  if (provided.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

function extFromType(type: string, url: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
    "image/webp": "webp", "image/gif": "gif", "image/heic": "heic",
  };
  if (map[type]) return map[type];
  const m = (url ?? "").split("?")[0].match(/\.([a-z0-9]{3,4})$/i);
  return m ? m[1].toLowerCase() : "jpg";
}

function nonEmpty(s: unknown): boolean {
  return typeof s === "string" && s.trim() !== "";
}

// Face descriptors are vector(128); PostgREST needs the pgvector text form,
// not a JS array. Validate length + finiteness, then serialize.
function serializeEmbedding(arr: unknown): string | null {
  if (!Array.isArray(arr) || arr.length !== 128) return null;
  for (const n of arr) if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return "[" + (arr as number[]).join(",") + "]";
}

// Boxes are FRACTIONS of the image (0..1), never pixels. Slight overflow is
// allowed because detectors clip at the edges.
type Box = { x: number; y: number; w: number; h: number };
function parseBox(raw: unknown): Box | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const x = Number(b.x), y = Number(b.y), w = Number(b.w), h = Number(b.h);
  for (const v of [x, y, w, h]) if (!Number.isFinite(v)) return null;
  if (w <= 0 || h <= 0) return null;
  if ([x, y, w, h].some((v) => v < -0.5 || v > 1.5)) return null;
  return { x, y, w, h };
}

function boxOf(r: Record<string, unknown>): Box {
  return { x: r.box_x as number, y: r.box_y as number, w: r.box_w as number, h: r.box_h as number };
}

function importHostAllowed(urlStr: string): boolean {
  let u: URL;
  try { u = new URL(urlStr); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" || host === "::1" || host === "[::1]" ||
    host.startsWith("127.") || host.startsWith("10.") ||
    host.startsWith("192.168.") || host.startsWith("169.254.")
  ) return false;
  return IMPORT_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

// Parse a YouTube/Vimeo URL into an embeddable form + a thumbnail.
async function parseVideo(raw: string): Promise<{ provider: string; embed: string; watch: string; thumb: string } | null> {
  const u = raw.trim();
  let m = u.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (m) {
    const id = m[1];
    return { provider: "youtube", embed: `https://www.youtube.com/embed/${id}`, watch: `https://www.youtube.com/watch?v=${id}`, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
  }
  m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) {
    const id = m[1];
    let thumb = VIDEO_POSTER;
    try {
      const r = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent("https://vimeo.com/" + id)}`);
      if (r.ok) { const j = await r.json(); if (j && j.thumbnail_url) thumb = String(j.thumbnail_url); }
    } catch { /* keep poster */ }
    return { provider: "vimeo", embed: `https://player.vimeo.com/video/${id}`, watch: `https://vimeo.com/${id}`, thumb };
  }
  return null;
}

// Download an external image (import only) and re-host it in the bucket.
async function storeBytes(sb: Supa, gallery: string, year: number, bytes: Uint8Array, contentType: string, ext: string): Promise<{ path: string; url: string }> {
  const path = `${gallery}/${year}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: contentType || "image/jpeg", upsert: false });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
  return { path, url: data.publicUrl };
}

async function objectExists(sb: Supa, path: string): Promise<boolean> {
  // A short-lived signed URL succeeds only if the object is really there, so a
  // failed browser PUT can't leave us inserting an orphan row.
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 60);
  return !error && !!data?.signedUrl;
}

// ---------------------------------------------------------------------------
// Response shapers
// ---------------------------------------------------------------------------
// Public row shape — the public gallery JS depends on this exact contract.
function publicRow(r: Record<string, unknown>) {
  return {
    id: r.id, gallery: r.gallery, year: r.year,
    image_url: r.image_url, thumb_url: r.thumb_url ?? r.image_url,
    caption: r.caption ?? "",
    alt_text: (r.alt_text as string) || (r.caption as string) || "",
    people: r.people ?? [], taken_at: r.taken_at,
    is_featured: r.is_featured, featured_order: r.featured_order,
    sort_order: r.sort_order, width: r.width, height: r.height,
    media_type: r.media_type ?? "photo", video_url: r.video_url ?? null,
  };
}

// Admin grid row — the management UI needs the operational columns too.
//
// publicRow coalesces alt_text to the caption, which is right for the public
// site (better a caption than nothing) but misleading in an editor: it makes a
// photo with only a caption look like it already has an image description.
// alt_text_raw is the column as stored, so the admin UI can tell the two apart
// and prompt for a real description.
function adminRow(r: Record<string, unknown>) {
  return {
    ...publicRow(r),
    alt_text_raw: (r.alt_text as string) ?? "",
    published: r.published, source: r.source,
    storage_path: r.storage_path, thumb_path: r.thumb_path,
    submission: r.submission, video_provider: r.video_provider,
    needs_alt: r.needs_alt, face_scanned: r.face_scanned,
  };
}

// ---------------------------------------------------------------------------
// GET — public list
// ---------------------------------------------------------------------------
async function handleGet(sb: Supa, url: URL): Promise<Response> {
  const action = url.searchParams.get("action") ?? "list";
  if (action !== "list") return json({ error: "Unknown action" }, 400);

  const gallery = String(url.searchParams.get("gallery") ?? "").trim();
  const cats = await loadCats(sb);
  const cat = cats.find((c) => c.slug === gallery);
  if (!cat || !cat.is_public) return json({ error: "Unknown gallery" }, 400);

  const yearParam = url.searchParams.get("year");
  const q = (url.searchParams.get("q") ?? "").trim();

  const { data: yearRows, error: yearErr } = await sb.from("gallery_photos")
    .select("year").eq("gallery", gallery).eq("published", true);
  if (yearErr) { console.error("years:", yearErr.message); return json({ error: "Could not load gallery." }, 500); }
  const years = [...new Set((yearRows ?? []).map((r) => r.year as number))].sort((a, b) => b - a);

  const { data: featRows } = await sb.from("gallery_photos").select("*")
    .eq("gallery", gallery).eq("published", true).eq("is_featured", true)
    .order("featured_order", { ascending: true, nullsFirst: false })
    .order("taken_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true }).limit(60);

  let selectedYear: number | null = null;
  if (yearParam && yearParam !== "all") { const n = parseInt(yearParam, 10); if (!Number.isNaN(n)) selectedYear = n; }
  else if (yearParam !== "all") selectedYear = years[0] ?? null;

  // Search is pushed into SQL (caption ILIKE + people[] unnest ILIKE) via the
  // gallery_list_photos helper, which also enforces published = true and the
  // taken_at → sort_order → created_at ordering and the 2000-row cap.
  const { data: photoRows, error: photoErr } = await sb.rpc("gallery_list_photos", {
    p_gallery: gallery,
    p_year: selectedYear,
    p_q: q || null,
  });
  if (photoErr) { console.error("photos:", photoErr.message); return json({ error: "Could not load gallery." }, 500); }

  const photos = (photoRows ?? []).map(publicRow);
  const featured = (featRows ?? []).map(publicRow);
  return json({ ok: true, gallery, name: cat.name, years, selectedYear, featured, photos, count: photos.length });
}

// ---------------------------------------------------------------------------
// Admin handler context + action map
// ---------------------------------------------------------------------------
type Role = "admin" | "photographer";
type Ctx = { sb: Supa; payload: Record<string, unknown>; cats: Category[]; slugs: Set<string>; role: Role };
type Handler = (c: Ctx) => Promise<Response>;

// The only actions the upload-only photographer token may call. Everything
// else — including every read of the library — is admin-only, so the token can
// be shared with a photographer without exposing the gallery's contents.
const PHOTOGRAPHER_ACTIONS = new Set(["categories", "upload-urls", "upload-commit"]);

const str = (v: unknown, max = 0): string => { const s = String(v ?? ""); return max ? s.slice(0, max) : s; };
const trimmed = (v: unknown, max = 0): string => str(v, max).trim();

// ---- categories -----------------------------------------------------------
const hCategories: Handler = async ({ cats }) => json({ ok: true, categories: cats });

const hCategoryCreate: Handler = async ({ sb, payload, cats, slugs }) => {
  const name = trimmed(payload.name, 80);
  if (!name) return json({ error: "Category name is required." }, 400);
  const slug = slugify(str(payload.slug) || name);
  if (!slug) return json({ error: "Could not derive a valid slug from that name." }, 400);
  if (slugs.has(slug)) return json({ error: "A category with that slug already exists." }, 409);
  const sort = cats.length ? Math.max(...cats.map((c) => c.sort_order)) + 1 : 1;
  const { data, error } = await sb.from("gallery_categories")
    .insert({ slug, name, is_public: payload.is_public === true, sort_order: sort }).select("*").single();
  if (error) { console.error("category-create:", error.message); return json({ error: "Could not create the category." }, 500); }
  return json({ ok: true, category: data });
};

// Rename an album or change whether the public site serves it. Without this,
// `category-create` (which always starts private) is a dead end: an album made
// in the admin UI could only be published by hand-editing the table.
const hCategoryUpdate: Handler = async ({ sb, payload, slugs }) => {
  const slug = trimmed(payload.slug);
  if (!slugs.has(slug)) return json({ error: "Unknown gallery" }, 400);
  const patch = (payload.patch ?? {}) as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  if ("name" in patch) {
    const name = trimmed(patch.name, 80);
    if (!name) return json({ error: "Category name cannot be empty." }, 400);
    clean.name = name;
  }
  if ("is_public" in patch) clean.is_public = patch.is_public === true;
  if ("sort_order" in patch) {
    const n = parseInt(str(patch.sort_order), 10);
    if (!Number.isNaN(n)) clean.sort_order = n;
  }
  // The slug is part of the public URL and of every storage path already
  // written for this album, so it is deliberately not editable.
  if (!Object.keys(clean).length) return json({ error: "Nothing to update." }, 400);

  const { data, error } = await sb.from("gallery_categories")
    .update(clean).eq("slug", slug).select("*").single();
  if (error) { console.error("category-update:", error.message); return json({ error: "Could not update the album." }, 500); }
  return json({ ok: true, category: data });
};

// ---- uploads (signed direct-to-storage) -----------------------------------
const hUploadUrls: Handler = async ({ sb, payload, slugs }) => {
  const gallery = trimmed(payload.gallery);
  const year = parseInt(str(payload.year), 10);
  if (!slugs.has(gallery)) return json({ error: "Unknown gallery" }, 400);
  if (Number.isNaN(year) || year < 1990 || year > 2100) return json({ error: "Invalid year" }, 400);
  const files = Array.isArray(payload.files) ? payload.files as Record<string, unknown>[] : [];
  if (!files.length) return json({ error: "No files." }, 400);
  if (files.length > 50) return json({ error: "Request at most 50 upload URLs at a time." }, 400);

  const uploads: unknown[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const ext = extFromType(str(f.content_type), str(f.name));
    const uuid = crypto.randomUUID();
    const mainPath = `${gallery}/${year}/${uuid}.${ext}`;
    const thumbPath = `${gallery}/${year}/thumbs/${uuid}.jpg`;
    const [main, thumb] = await Promise.all([
      sb.storage.from(BUCKET).createSignedUploadUrl(mainPath),
      sb.storage.from(BUCKET).createSignedUploadUrl(thumbPath),
    ]);
    if (main.error || thumb.error) {
      console.error("upload-urls:", main.error?.message ?? thumb.error?.message);
      return json({ error: "Could not create upload URLs." }, 500);
    }
    uploads.push({
      index: i,
      main: { path: main.data.path, token: main.data.token, signedUrl: main.data.signedUrl },
      thumb: { path: thumb.data.path, token: thumb.data.token, signedUrl: thumb.data.signedUrl },
    });
  }
  return json({ ok: true, uploads });
};

const hUploadCommit: Handler = async ({ sb, payload, slugs, role }) => {
  const gallery = trimmed(payload.gallery);
  const year = parseInt(str(payload.year), 10);
  if (!slugs.has(gallery)) return json({ error: "Unknown gallery" }, 400);
  if (Number.isNaN(year) || year < 1990 || year > 2100) return json({ error: "Invalid year" }, 400);
  const items = Array.isArray(payload.items) ? payload.items as Record<string, unknown>[] : [];
  if (!items.length) return json({ error: "No items to commit." }, 400);
  if (items.length > 50) return json({ error: "Commit at most 50 photos at a time." }, 400);

  // A photographer's upload always lands unpublished, whatever it asks for —
  // the review queue is the point of that role. An admin may publish straight
  // away (the default) or stage a batch with published:false.
  const published = role === "photographer" ? false : payload.published !== false;
  // Batch label used to group the admin review queue.
  const submission = payload.submission ? str(payload.submission, 200) : null;

  const rows: Record<string, unknown>[] = [];
  const skipped: { index: number; reason: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const storagePath = trimmed(it.storage_path);
    const thumbPath = trimmed(it.thumb_path);
    if (!storagePath) { skipped.push({ index: i, reason: "missing storage_path" }); continue; }
    // Guard against orphan rows: the object must really exist in the bucket.
    if (!(await objectExists(sb, storagePath))) { skipped.push({ index: i, reason: "object not found in storage" }); continue; }

    const source = trimmed(it.source) || "upload";
    if (!SOURCES.includes(source)) { skipped.push({ index: i, reason: "invalid source" }); continue; }

    const caption = str(it.caption, 2000);
    const alt = str(it.alt_text, 2000);
    const { data: imgPub } = sb.storage.from(BUCKET).getPublicUrl(storagePath);
    const thumbUrl = thumbPath ? sb.storage.from(BUCKET).getPublicUrl(thumbPath).data.publicUrl : null;

    rows.push({
      gallery, year, source,
      storage_path: storagePath, thumb_path: thumbPath || null,
      image_url: imgPub.publicUrl, thumb_url: thumbUrl,
      caption, alt_text: alt,
      taken_at: it.taken_at ? str(it.taken_at) : null,
      width: it.width != null ? Number(it.width) || null : null,
      height: it.height != null ? Number(it.height) || null : null,
      is_featured: it.is_featured === true,
      needs_alt: !(nonEmpty(alt) || nonEmpty(caption)),
      published,
      submission,
    });
  }

  if (!rows.length) return json({ ok: true, inserted: 0, ids: [], skipped }, 200);
  const { data, error } = await sb.from("gallery_photos").insert(rows).select("id");
  if (error) { console.error("upload-commit:", error.message); return json({ error: "Could not record the uploaded photos." }, 500); }
  return json({ ok: true, inserted: (data ?? []).length, ids: (data ?? []).map((r) => r.id), skipped });
};

// ---- thumbnail backfill (for imports, which arrive with thumb_path null) ---
//
// `import` re-hosts external images but cannot render a thumbnail server-side
// (there is no image library in this runtime), so those rows served their
// full-size image into every grid. These two actions let the browser do the
// rendering: ask for signed URLs, PUT the 400px JPEGs, then commit.
//
// The thumb path is derived from the main object's path so it lands beside
// every other thumbnail: <gallery>/<year>/thumbs/<uuid>.jpg.
function thumbPathFor(storagePath: string): string | null {
  const lastSlash = storagePath.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const dir = storagePath.slice(0, lastSlash);
  const file = storagePath.slice(lastSlash + 1);
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  if (!stem) return null;
  return `${dir}/thumbs/${stem}.jpg`;
}

const hThumbUrls: Handler = async ({ sb, payload }) => {
  const ids = Array.isArray(payload.ids) ? payload.ids.map((v) => str(v)).filter(nonEmpty) : [];
  if (!ids.length) return json({ error: "No photo ids." }, 400);
  if (ids.length > 50) return json({ error: "Request at most 50 thumbnail URLs at a time." }, 400);

  const { data: rows, error } = await sb.from("gallery_photos")
    .select("id, storage_path, image_url, thumb_path").in("id", ids);
  if (error) { console.error("thumb-urls:", error.message); return json({ error: "Could not load those photos." }, 500); }

  const uploads: unknown[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const row of rows ?? []) {
    const id = row.id as string;
    if (row.thumb_path) { skipped.push({ id, reason: "already has a thumbnail" }); continue; }
    const storagePath = str(row.storage_path);
    // Imports are always re-hosted, so a row without a storage_path is a video
    // or a legacy row we cannot generate a thumbnail for.
    if (!storagePath) { skipped.push({ id, reason: "not stored in our bucket" }); continue; }
    const thumbPath = thumbPathFor(storagePath);
    if (!thumbPath) { skipped.push({ id, reason: "could not derive a thumbnail path" }); continue; }

    const signed = await sb.storage.from(BUCKET).createSignedUploadUrl(thumbPath);
    if (signed.error) { skipped.push({ id, reason: "could not create an upload URL" }); continue; }
    uploads.push({
      id,
      image_url: row.image_url,
      thumb: { path: signed.data.path, token: signed.data.token, signedUrl: signed.data.signedUrl },
    });
  }
  return json({ ok: true, uploads, skipped });
};

const hThumbCommit: Handler = async ({ sb, payload }) => {
  const items = Array.isArray(payload.items) ? payload.items as Record<string, unknown>[] : [];
  if (!items.length) return json({ error: "No thumbnails to commit." }, 400);
  if (items.length > 50) return json({ error: "Commit at most 50 thumbnails at a time." }, 400);

  let updated = 0;
  const skipped: { id: string; reason: string }[] = [];
  for (const item of items) {
    const id = str(item.id);
    const thumbPath = trimmed(item.thumb_path);
    if (!id || !thumbPath) { skipped.push({ id, reason: "missing id or thumb_path" }); continue; }
    // Same orphan guard as upload-commit: never record a path that isn't there.
    if (!(await objectExists(sb, thumbPath))) { skipped.push({ id, reason: "object not found in storage" }); continue; }

    const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(thumbPath);
    const { data: ok, error } = await sb.rpc("gallery_set_thumb", {
      p_photo_id: id, p_thumb_path: thumbPath, p_thumb_url: pub.publicUrl,
    });
    if (error) { console.error("thumb-commit:", error.message); skipped.push({ id, reason: "could not record the thumbnail" }); continue; }
    if (ok === true) updated++;
    else skipped.push({ id, reason: "already had a thumbnail" });
  }
  return json({ ok: true, updated, skipped });
};

// ---- import (re-host external images) -------------------------------------
const hImport: Handler = async ({ sb, payload, slugs }) => {
  const gallery = trimmed(payload.gallery);
  const year = parseInt(str(payload.year), 10);
  const source = str(payload.source) || "google_photos";
  const items = Array.isArray(payload.items) ? payload.items as Record<string, unknown>[] : [];
  const auth = payload.auth ? str(payload.auth) : null;
  if (!slugs.has(gallery)) return json({ error: "Unknown gallery" }, 400);
  if (Number.isNaN(year) || year < 1990 || year > 2100) return json({ error: "Invalid year" }, 400);
  if (!SOURCES.includes(source)) return json({ error: "Unknown source" }, 400);
  if (!items.length) return json({ error: "No items to import." }, 400);
  if (items.length > 200) return json({ error: "Import at most 200 photos at a time." }, 400);

  const results: { ok: boolean; error?: string; id?: string }[] = [];
  for (const it of items) {
    const imageUrl = trimmed(it.image_url);
    const externalId = it.external_id ? str(it.external_id) : null;
    const caption = str(it.caption, 2000);
    const alt = str(it.alt_text, 2000);
    if (!imageUrl) { results.push({ ok: false, error: "missing image_url" }); continue; }
    // Allowlist the host so the function can't be used as an SSRF proxy.
    if (!importHostAllowed(imageUrl)) { results.push({ ok: false, error: "host not allowed" }); continue; }
    if (externalId) {
      const { data: dup } = await sb.from("gallery_photos").select("id").eq("source", source).eq("external_id", externalId).maybeSingle();
      if (dup) { results.push({ ok: true, id: dup.id as string }); continue; }
    }
    try {
      const resp = await fetch(imageUrl, auth ? { headers: { Authorization: "Bearer " + auth } } : undefined);
      if (!resp.ok) throw new Error(`fetch ${resp.status}`);
      const ct = resp.headers.get("content-type") ?? "image/jpeg";
      if (!ct.startsWith("image/")) throw new Error("not an image");
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.length > 25 * 1024 * 1024) throw new Error("too large");
      const stored = await storeBytes(sb, gallery, year, bytes, ct, extFromType(ct, imageUrl));
      // thumb_path is left null: there is no image library in this runtime, so
      // the thumbnail is rendered later by the browser via thumb-urls /
      // thumb-commit ("Generate missing thumbnails" in the admin's Settings).
      // Uploads carry their own browser-made thumb and skip that step.
      const { data, error } = await sb.from("gallery_photos").insert({
        gallery, year, storage_path: stored.path, thumb_path: null, image_url: stored.url,
        caption, alt_text: alt, needs_alt: !(nonEmpty(alt) || nonEmpty(caption)),
        taken_at: it.taken_at ? str(it.taken_at) : null,
        source, external_id: externalId,
        width: it.width ? Number(it.width) : null, height: it.height ? Number(it.height) : null,
      }).select("id").single();
      if (error) throw new Error(error.message);
      results.push({ ok: true, id: data.id as string });
    } catch (e) {
      console.error("import item:", e instanceof Error ? e.message : String(e));
      results.push({ ok: false, error: "import failed" });
    }
  }
  const imported = results.filter((r) => r.ok).length;
  return json({ ok: true, imported, failed: results.length - imported, results });
};

// ---- video ----------------------------------------------------------------
const hVideoAdd: Handler = async ({ sb, payload, slugs }) => {
  const gallery = trimmed(payload.gallery);
  const year = parseInt(str(payload.year), 10);
  if (!slugs.has(gallery)) return json({ error: "Unknown gallery" }, 400);
  if (Number.isNaN(year) || year < 1990 || year > 2100) return json({ error: "Invalid year" }, 400);
  const vid = await parseVideo(str(payload.video_url));
  if (!vid) return json({ error: "That doesn't look like a YouTube or Vimeo link." }, 400);
  const caption = str(payload.caption, 2000);
  const alt = str(payload.alt_text, 2000);
  const row = {
    gallery, year, media_type: "video", image_url: vid.thumb,
    video_url: vid.embed, video_provider: vid.provider, source: vid.provider,
    caption, alt_text: alt,
    taken_at: payload.taken_at ? str(payload.taken_at) : null,
    is_featured: payload.is_featured === true,
    submission: payload.submission ? str(payload.submission, 200) : null,
    published: true,
  };
  const { data, error } = await sb.from("gallery_photos").insert(row).select("*").single();
  if (error) { console.error("video-add:", error.message); return json({ error: "Could not save the video." }, 500); }
  return json({ ok: true, photo: publicRow(data) });
};

// ---- admin list (paginated) -----------------------------------------------
const hListAdmin: Handler = async ({ sb, payload, slugs }) => {
  const gallery = trimmed(payload.gallery);
  const year = parseInt(str(payload.year), 10);
  const filter = str(payload.filter);
  const limit = Math.min(500, Math.max(1, parseInt(str(payload.limit), 10) || 100));
  const offset = Math.max(0, parseInt(str(payload.offset), 10) || 0);

  // "untagged" is an anti-join against gallery_photo_people; resolve the tagged
  // id set once and exclude it from both the data query and the count query.
  let taggedIds: string[] = [];
  if (filter === "untagged") {
    const { data: tagged } = await sb.from("gallery_photo_people").select("photo_id");
    taggedIds = [...new Set((tagged ?? []).map((r) => r.photo_id as string))];
  }

  // deno-lint-ignore no-explicit-any
  const applyFilters = (q: any) => {
    if (slugs.has(gallery)) q = q.eq("gallery", gallery);
    if (!Number.isNaN(year)) q = q.eq("year", year);
    if (filter === "needs_alt") q = q.eq("needs_alt", true);
    else if (filter === "unscanned") q = q.eq("face_scanned", false);
    else if (filter === "unpublished") q = q.eq("published", false);
    else if (filter === "untagged" && taggedIds.length) q = q.not("id", "in", "(" + taggedIds.join(",") + ")");
    // Imports arrive with thumb_path null and serve their full-size image into
    // grids until the browser backfills a thumbnail. Videos are excluded —
    // their image_url is a provider poster, not something we can thumbnail.
    else if (filter === "no_thumb") q = q.is("thumb_path", null).eq("media_type", "photo");
    return q;
  };

  const { count, error: cErr } = await applyFilters(
    sb.from("gallery_photos").select("id", { count: "exact", head: true }),
  );
  if (cErr) { console.error("list-admin count:", cErr.message); return json({ error: "Could not load photos." }, 500); }

  const { data, error } = await applyFilters(
    sb.from("gallery_photos").select("*")
      .order("year", { ascending: false })
      .order("taken_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .range(offset, offset + limit - 1),
  );
  if (error) { console.error("list-admin:", error.message); return json({ error: "Could not load photos." }, 500); }
  return json({ ok: true, photos: (data ?? []).map(adminRow), total: count ?? 0 });
};

// ---- patch builder (people[] deliberately excluded — it is a cache) --------
function buildPatch(patch: Record<string, unknown>, validSlugs: Set<string>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  if ("caption" in patch) clean.caption = str(patch.caption, 2000);
  if ("alt_text" in patch) clean.alt_text = str(patch.alt_text, 2000);
  if ("year" in patch) { const y = parseInt(str(patch.year), 10); if (!Number.isNaN(y) && y >= 1990 && y <= 2100) clean.year = y; }
  if ("gallery" in patch && validSlugs.has(str(patch.gallery))) clean.gallery = patch.gallery;
  if ("is_featured" in patch) clean.is_featured = !!patch.is_featured;
  if ("featured_order" in patch) { const n = parseInt(str(patch.featured_order), 10); clean.featured_order = Number.isNaN(n) ? null : n; }
  if ("sort_order" in patch) { const n = parseInt(str(patch.sort_order), 10); if (!Number.isNaN(n)) clean.sort_order = n; }
  if ("taken_at" in patch) clean.taken_at = patch.taken_at ? str(patch.taken_at) : null;
  if ("published" in patch) clean.published = !!patch.published;
  if ("submission" in patch) clean.submission = patch.submission ? str(patch.submission, 200) : null;
  return clean;
}

const hUpdate: Handler = async ({ sb, payload, slugs }) => {
  const id = str(payload.id);
  if (!id) return json({ error: "Missing id" }, 400);
  const patch = (payload.patch ?? {}) as Record<string, unknown>;
  const clean = buildPatch(patch, slugs);
  if (!Object.keys(clean).length) return json({ error: "Nothing to update." }, 400);

  // Recompute needs_alt whenever caption or alt_text changes: it depends on the
  // FINAL value of both fields, so fold in whichever isn't in the patch.
  if ("caption" in clean || "alt_text" in clean) {
    const { data: cur } = await sb.from("gallery_photos").select("caption, alt_text, media_type").eq("id", id).maybeSingle();
    if (cur && cur.media_type === "photo") {
      const finalCaption = "caption" in clean ? clean.caption : cur.caption;
      const finalAlt = "alt_text" in clean ? clean.alt_text : cur.alt_text;
      clean.needs_alt = !(nonEmpty(finalAlt) || nonEmpty(finalCaption));
    }
  }

  const { data, error } = await sb.from("gallery_photos").update(clean).eq("id", id).select("*").single();
  if (error) { console.error("update:", error.message); return json({ error: "Could not update the photo." }, 500); }
  return json({ ok: true, photo: adminRow(data) });
};

const hBulkUpdate: Handler = async ({ sb, payload, slugs }) => {
  const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
  if (!ids.length) return json({ error: "No photos selected." }, 400);
  if (ids.length > 1000) return json({ error: "Too many photos selected." }, 400);
  const patch = (payload.patch ?? {}) as Record<string, unknown>;
  const clean = buildPatch(patch, slugs);
  if (!Object.keys(clean).length) return json({ error: "Nothing to update." }, 400);

  const { error } = await sb.from("gallery_photos").update(clean).in("id", ids);
  if (error) { console.error("bulk-update:", error.message); return json({ error: "Could not update the photos." }, 500); }

  // needs_alt depends per-row on the field NOT in the patch, so recompute from
  // each affected photo's resulting values and write it back in two grouped
  // updates (true / false) rather than one per row.
  if ("caption" in clean || "alt_text" in clean) {
    const { data: rows } = await sb.from("gallery_photos").select("id, caption, alt_text, media_type").in("id", ids);
    const needTrue: string[] = [], needFalse: string[] = [];
    for (const r of rows ?? []) {
      if (r.media_type !== "photo") continue;
      (!(nonEmpty(r.alt_text) || nonEmpty(r.caption)) ? needTrue : needFalse).push(r.id as string);
    }
    if (needTrue.length) await sb.from("gallery_photos").update({ needs_alt: true }).in("id", needTrue);
    if (needFalse.length) await sb.from("gallery_photos").update({ needs_alt: false }).in("id", needFalse);
  }
  return json({ ok: true, updated: ids.length });
};

const hDelete: Handler = async ({ sb, payload }) => {
  const id = str(payload.id);
  if (!id) return json({ error: "Missing id" }, 400);
  const { data: row } = await sb.from("gallery_photos").select("storage_path, thumb_path").eq("id", id).maybeSingle();
  const paths = [row?.storage_path, row?.thumb_path].filter((p): p is string => !!p);
  if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  const { error } = await sb.from("gallery_photos").delete().eq("id", id);
  if (error) { console.error("delete:", error.message); return json({ error: "Could not delete the photo." }, 500); }
  return json({ ok: true });
};

// ---- people roster --------------------------------------------------------
const hPeopleList: Handler = async ({ sb, payload }) => {
  const q = trimmed(payload.q).toLowerCase();
  const limit = Math.min(500, Math.max(1, parseInt(str(payload.limit), 10) || 100));
  const offset = Math.max(0, parseInt(str(payload.offset), 10) || 0);

  // The roster is small and naturally bounded, so fetch it and filter for
  // case-insensitive substring over display_name + aliases in JS (PostgREST
  // cannot substring-match text[] elements), then paginate.
  const { data: allPeople, error } = await sb.from("gallery_people")
    .select("id, display_name, sort_name, aliases, kind, hidden, notes")
    .order("sort_name", { ascending: true, nullsFirst: false })
    .order("display_name", { ascending: true });
  if (error) { console.error("people-list:", error.message); return json({ error: "Could not load people." }, 500); }

  let people = allPeople ?? [];
  if (q) {
    people = people.filter((p) => {
      if (String(p.display_name).toLowerCase().includes(q)) return true;
      return ((p.aliases as string[]) ?? []).some((a) => String(a).toLowerCase().includes(q));
    });
  }
  const total = people.length;
  const page = people.slice(offset, offset + limit);
  const ids = page.map((p) => p.id as string);

  // Aggregate photo_count / face_count / cover for just this page in two queries.
  const photoCount = new Map<string, Set<string>>();
  const faceCount = new Map<string, number>();
  const cover = new Map<string, { photo_id: string; image_url: string | null; box: Box }>();
  if (ids.length) {
    const { data: links } = await sb.from("gallery_photo_people").select("person_id, photo_id").in("person_id", ids);
    for (const l of links ?? []) {
      const set = photoCount.get(l.person_id as string) ?? new Set<string>();
      set.add(l.photo_id as string);
      photoCount.set(l.person_id as string, set);
    }
    const { data: faces } = await sb.from("gallery_faces")
      .select("person_id, photo_id, box_x, box_y, box_w, box_h, photo:photo_id(image_url)")
      .in("person_id", ids).not("person_id", "is", null);
    for (const f of faces ?? []) {
      const pid = f.person_id as string;
      faceCount.set(pid, (faceCount.get(pid) ?? 0) + 1);
      if (!cover.has(pid)) {
        const ph = (f as Record<string, unknown>).photo as Record<string, unknown> | null;
        cover.set(pid, { photo_id: f.photo_id as string, image_url: (ph?.image_url as string) ?? null, box: boxOf(f as Record<string, unknown>) });
      }
    }
  }

  return json({
    ok: true, total,
    people: page.map((p) => ({
      id: p.id, display_name: p.display_name, sort_name: p.sort_name,
      aliases: p.aliases ?? [], kind: p.kind, hidden: p.hidden, notes: p.notes,
      photo_count: photoCount.get(p.id as string)?.size ?? 0,
      face_count: faceCount.get(p.id as string) ?? 0,
      cover: cover.get(p.id as string) ?? null,
    })),
  });
};

const hPersonCreate: Handler = async ({ sb, payload }) => {
  const display_name = trimmed(payload.display_name, 120);
  if (!display_name) return json({ error: "A name is required." }, 400);
  const kind = PERSON_KINDS.includes(str(payload.kind)) ? str(payload.kind) : "unknown";
  const sort_name = payload.sort_name ? trimmed(payload.sort_name, 120) : null;
  const aliases = Array.isArray(payload.aliases)
    ? [...new Set(payload.aliases.map((a) => String(a).trim()).filter(Boolean))].slice(0, 30) : [];
  const { data, error } = await sb.from("gallery_people")
    .insert({ display_name, kind, sort_name, aliases }).select("*").single();
  if (error) {
    if (error.code === "23505") {
      // unique index on lower(display_name) — hand back the existing record.
      const { data: existing } = await sb.from("gallery_people").select("id, display_name")
        .ilike("display_name", display_name).maybeSingle();
      return json({ error: "A person with that name already exists.", existing_id: existing?.id ?? null, existing_name: existing?.display_name ?? null }, 409);
    }
    console.error("person-create:", error.message);
    return json({ error: "Could not create the person." }, 500);
  }
  return json({ ok: true, person: data });
};

const hPersonUpdate: Handler = async ({ sb, payload }) => {
  const id = str(payload.id);
  if (!id) return json({ error: "Missing id" }, 400);
  const patch = (payload.patch ?? {}) as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  if ("display_name" in patch) { const v = trimmed(patch.display_name, 120); if (!v) return json({ error: "Name cannot be empty." }, 400); clean.display_name = v; }
  if ("sort_name" in patch) clean.sort_name = patch.sort_name ? trimmed(patch.sort_name, 120) : null;
  if ("aliases" in patch) clean.aliases = Array.isArray(patch.aliases) ? [...new Set(patch.aliases.map((a) => String(a).trim()).filter(Boolean))].slice(0, 30) : [];
  if ("kind" in patch && PERSON_KINDS.includes(str(patch.kind))) clean.kind = patch.kind;
  if ("hidden" in patch) clean.hidden = !!patch.hidden;
  if ("notes" in patch) clean.notes = patch.notes ? str(patch.notes, 4000) : null;
  if (!Object.keys(clean).length) return json({ error: "Nothing to update." }, 400);
  const { data, error } = await sb.from("gallery_people").update(clean).eq("id", id).select("*").single();
  if (error) {
    if (error.code === "23505") return json({ error: "Another person already has that name." }, 409);
    console.error("person-update:", error.message);
    return json({ error: "Could not update the person." }, 500);
  }
  return json({ ok: true, person: data });
};

const hPersonMerge: Handler = async ({ sb, payload }) => {
  const keep = str(payload.keep_id), drop = str(payload.drop_id);
  if (!keep || !drop) return json({ error: "Both keep_id and drop_id are required." }, 400);
  if (keep === drop) return json({ error: "Cannot merge a person into themselves." }, 400);
  const { error } = await sb.rpc("gallery_merge_people", { p_keep: keep, p_drop: drop });
  if (error) { console.error("person-merge:", error.message); return json({ error: "Could not merge the people." }, 500); }
  const { data: links } = await sb.from("gallery_photo_people").select("photo_id").eq("person_id", keep);
  const photo_count = new Set((links ?? []).map((l) => l.photo_id as string)).size;
  return json({ ok: true, keep_id: keep, photo_count });
};

const hPersonDelete: Handler = async ({ sb, payload }) => {
  const id = str(payload.id);
  if (!id) return json({ error: "Missing id" }, 400);
  const { count } = await sb.from("gallery_faces").select("id", { count: "exact", head: true }).eq("person_id", id);
  const { error } = await sb.from("gallery_people").delete().eq("id", id);
  if (error) { console.error("person-delete:", error.message); return json({ error: "Could not delete the person." }, 500); }
  return json({ ok: true, orphaned_faces: count ?? 0 });
};

// ---- faces ----------------------------------------------------------------
const hFacesSave: Handler = async ({ sb, payload }) => {
  const photoId = str(payload.photo_id);
  if (!photoId) return json({ error: "Missing photo_id" }, 400);
  const faces = Array.isArray(payload.faces) ? payload.faces as Record<string, unknown>[] : [];
  if (faces.length > 100) return json({ error: "Too many faces for one photo." }, 400);

  // Don't re-scan a photo that already has confirmed faces: a re-scan would
  // have to replace detected rows, and we can't safely carry confirmations
  // across, so skip and leave the human's work intact.
  const { count: confirmed } = await sb.from("gallery_faces")
    .select("id", { count: "exact", head: true }).eq("photo_id", photoId).not("person_id", "is", null);
  if ((confirmed ?? 0) > 0) {
    await sb.from("gallery_photos").update({ face_scanned: true }).eq("id", photoId);
    return json({ ok: true, inserted: 0, scanned: true, skipped: "photo has confirmed faces" });
  }

  // Replace only detector output; preserve any hand-drawn (manual) boxes.
  await sb.from("gallery_faces").delete().eq("photo_id", photoId).eq("origin", "detected");

  const rows: Record<string, unknown>[] = [];
  for (const f of faces) {
    const emb = serializeEmbedding(f.embedding);
    const box = parseBox(f.box);
    if (!emb || !box) continue;
    rows.push({
      photo_id: photoId, embedding: emb,
      box_x: box.x, box_y: box.y, box_w: box.w, box_h: box.h,
      origin: "detected",
      detector: str(f.detector) || "face-api/tiny",
      det_score: typeof f.det_score === "number" ? f.det_score : null,
    });
  }
  if (rows.length) {
    const { error } = await sb.from("gallery_faces").insert(rows);
    if (error) { console.error("faces-save:", error.message); return json({ error: "Could not save faces." }, 500); }
  }
  // Mark scanned even when zero faces were found, so it isn't re-queued.
  await sb.from("gallery_photos").update({ face_scanned: true }).eq("id", photoId);
  return json({ ok: true, inserted: rows.length, scanned: true });
};

const hFacesForPhoto: Handler = async ({ sb, payload }) => {
  const photoId = str(payload.photo_id);
  if (!photoId) return json({ error: "Missing photo_id" }, 400);
  const { data: ph } = await sb.from("gallery_photos").select("face_scanned").eq("id", photoId).maybeSingle();
  const { data, error } = await sb.from("gallery_faces")
    .select("id, box_x, box_y, box_w, box_h, origin, suggested_distance, person:person_id(id, display_name), suggestion:suggested_person_id(id, display_name)")
    .eq("photo_id", photoId);
  if (error) { console.error("faces-for-photo:", error.message); return json({ error: "Could not load faces." }, 500); }
  const faces = (data ?? []).map((r) => {
    const rec = r as Record<string, unknown>;
    const person = rec.person as { id: string; display_name: string } | null;
    const sugg = rec.suggestion as { id: string; display_name: string } | null;
    return {
      id: rec.id, box: boxOf(rec), origin: rec.origin,
      person: person ? { id: person.id, name: person.display_name } : null,
      suggestion: (!person && sugg) ? { id: sugg.id, name: sugg.display_name, distance: rec.suggested_distance } : null,
    };
  });
  return json({ ok: true, scanned: !!ph?.face_scanned, faces });
};

const hFaceAddManual: Handler = async ({ sb, payload }) => {
  const photoId = str(payload.photo_id);
  if (!photoId) return json({ error: "Missing photo_id" }, 400);
  const emb = serializeEmbedding(payload.embedding);
  const box = parseBox(payload.box);
  if (!emb) return json({ error: "A valid 128-value face descriptor is required." }, 400);
  if (!box) return json({ error: "A valid face box (fractions of the image) is required." }, 400);
  const { data, error } = await sb.from("gallery_faces").insert({
    photo_id: photoId, embedding: emb,
    box_x: box.x, box_y: box.y, box_w: box.w, box_h: box.h,
    origin: "manual", detector: str(payload.detector) || "manual",
  }).select("id").single();
  if (error) { console.error("face-add-manual:", error.message); return json({ error: "Could not add the face." }, 500); }
  const faceId = data.id as string;

  const personId = payload.person_id ? str(payload.person_id) : null;
  if (personId) {
    const { error: cErr } = await sb.rpc("gallery_confirm_face", { p_face_id: faceId, p_person_id: personId });
    if (cErr) { console.error("face-add-manual confirm:", cErr.message); return json({ error: "Face added but could not tag the person." }, 500); }
    await sb.rpc("gallery_resuggest_for_person", { p_person_id: personId });
    return json({ ok: true, face_id: faceId, person_id: personId });
  }
  return json({ ok: true, face_id: faceId });
};

// Resolve a person id from an explicit id or a (possibly new) name.
async function resolvePerson(sb: Supa, personId: string | null, newName: string | null): Promise<{ id: string } | { error: string; status: number }> {
  if (personId) return { id: personId };
  const name = (newName ?? "").trim().slice(0, 120);
  if (!name) return { error: "A person id or name is required.", status: 400 };
  const { data: existing } = await sb.from("gallery_people").select("id").ilike("display_name", name).maybeSingle();
  if (existing) return { id: existing.id as string };
  const { data: created, error } = await sb.from("gallery_people").insert({ display_name: name }).select("id").single();
  if (error) {
    if (error.code === "23505") {
      const { data: race } = await sb.from("gallery_people").select("id").ilike("display_name", name).maybeSingle();
      if (race) return { id: race.id as string };
    }
    console.error("resolvePerson:", error.message);
    return { error: "Could not create the person.", status: 500 };
  }
  return { id: created.id as string };
}

const hFaceConfirm: Handler = async ({ sb, payload }) => {
  const faceId = str(payload.face_id);
  if (!faceId) return json({ error: "Missing face_id" }, 400);
  const resolved = await resolvePerson(sb, payload.person_id ? str(payload.person_id) : null, payload.new_person_name ? str(payload.new_person_name) : null);
  if ("error" in resolved) return json({ error: resolved.error }, resolved.status);
  const { error } = await sb.rpc("gallery_confirm_face", { p_face_id: faceId, p_person_id: resolved.id });
  if (error) { console.error("face-confirm:", error.message); return json({ error: "Could not confirm the face." }, 500); }
  // Cheap targeted re-suggest: this new exemplar may improve pending guesses.
  await sb.rpc("gallery_resuggest_for_person", { p_person_id: resolved.id });
  return json({ ok: true, person_id: resolved.id });
};

// Confirm many faces as one person in a single call, re-suggesting ONCE at the
// end instead of after every face (face-confirm re-suggests per call, so a
// hundred separate confirms would trigger a hundred re-suggests). This is what
// makes "tag one face → tag the other hundred of the same person" cheap: the
// client gathers a person's pending suggestions, a human keeps/deselects the
// ones that are really them, and the kept set is confirmed together.
const hFaceConfirmBatch: Handler = async ({ sb, payload }) => {
  const ids = Array.isArray(payload.face_ids)
    ? Array.from(new Set(payload.face_ids.map((x) => str(x)).filter(Boolean)))
    : [];
  if (!ids.length) return json({ error: "face_ids is required." }, 400);
  if (ids.length > 500) return json({ error: "Confirm at most 500 faces at once." }, 400);
  const resolved = await resolvePerson(sb, payload.person_id ? str(payload.person_id) : null, payload.new_person_name ? str(payload.new_person_name) : null);
  if ("error" in resolved) return json({ error: resolved.error }, resolved.status);

  let confirmed = 0;
  const failed: string[] = [];
  for (const faceId of ids) {
    const { error } = await sb.rpc("gallery_confirm_face", { p_face_id: faceId, p_person_id: resolved.id });
    if (error) { console.error("face-confirm-batch:", error.message); failed.push(faceId); }
    else confirmed++;
  }
  // One re-suggest for the whole batch, not one per face.
  await sb.rpc("gallery_resuggest_for_person", { p_person_id: resolved.id });
  return json({ ok: true, person_id: resolved.id, confirmed, failed });
};

const hFaceReject: Handler = async ({ sb, payload }) => {
  const faceId = str(payload.face_id), personId = str(payload.person_id);
  if (!faceId || !personId) return json({ error: "face_id and person_id are required." }, 400);
  const { error } = await sb.rpc("gallery_reject_face", { p_face_id: faceId, p_person_id: personId });
  if (error) { console.error("face-reject:", error.message); return json({ error: "Could not reject the suggestion." }, 500); }
  return json({ ok: true });
};

// Undo a rejection. Without this, Reject was the only irreversible action in
// the triage flow: gallery_match_face permanently excludes any (face, person)
// pair in gallery_face_rejections, so one mis-tap stopped that person from ever
// being suggested for that face again.
const hFaceUnreject: Handler = async ({ sb, payload }) => {
  const faceId = str(payload.face_id), personId = str(payload.person_id);
  if (!faceId || !personId) return json({ error: "face_id and person_id are required." }, 400);
  const maxD = typeof payload.max_distance === "number" ? payload.max_distance : 0.55;
  const { data, error } = await sb.rpc("gallery_unreject_face", {
    p_face_id: faceId, p_person_id: personId, p_max_distance: maxD,
  });
  if (error) { console.error("face-unreject:", error.message); return json({ error: "Could not undo the rejection." }, 500); }
  // The RPC returns the restored suggestion, or no rows if nothing matches now
  // — the caller should say which, rather than implying the guess came back.
  const row = Array.isArray(data) ? data[0] : null;
  return json({
    ok: true,
    suggestion: row ? { id: row.person_id, name: row.display_name, distance: row.distance } : null,
  });
};

const hFaceUnconfirm: Handler = async ({ sb, payload }) => {
  const faceId = str(payload.face_id);
  if (!faceId) return json({ error: "Missing face_id" }, 400);
  const { error } = await sb.rpc("gallery_unconfirm_face", { p_face_id: faceId });
  if (error) { console.error("face-unconfirm:", error.message); return json({ error: "Could not unconfirm the face." }, 500); }
  return json({ ok: true });
};

const hFaceDelete: Handler = async ({ sb, payload }) => {
  const faceId = str(payload.face_id);
  if (!faceId) return json({ error: "Missing face_id" }, 400);
  const { error } = await sb.from("gallery_faces").delete().eq("id", faceId);
  if (error) { console.error("face-delete:", error.message); return json({ error: "Could not delete the face." }, 500); }
  return json({ ok: true });
};

// Shared shaper for the review / unknown queues.
function queueRow(r: Record<string, unknown>) {
  const ph = r.photo as Record<string, unknown> | null;
  const sugg = r.suggestion as { id: string; display_name: string } | null;
  return {
    id: r.id, photo_id: r.photo_id, box: boxOf(r),
    image_url: ph?.image_url ?? null, gallery: ph?.gallery ?? null, year: ph?.year ?? null,
    distance: r.suggested_distance ?? null,
    person: sugg ? { id: sugg.id, name: sugg.display_name } : null,
  };
}

const hFacesReview: Handler = async ({ sb, payload }) => {
  const limit = Math.min(300, Math.max(1, parseInt(str(payload.limit), 10) || 60));
  const offset = Math.max(0, parseInt(str(payload.offset), 10) || 0);
  const minD = typeof payload.min_distance === "number" ? payload.min_distance : null;
  const maxD = typeof payload.max_distance === "number" ? payload.max_distance : null;
  // Optional: only faces currently suggested as one person. Powers the "tag
  // one → sweep up the rest" flow, which pulls a single person's whole pending
  // pile so the human confirms it in one pass instead of one crop at a time.
  const personId = payload.person_id ? str(payload.person_id) : null;
  let q = sb.from("gallery_faces")
    .select("id, photo_id, box_x, box_y, box_w, box_h, suggested_distance, suggestion:suggested_person_id(id, display_name), photo:photo_id(image_url, gallery, year)")
    .is("person_id", null).not("suggested_person_id", "is", null);
  if (personId) q = q.eq("suggested_person_id", personId);
  q = q.order("suggested_distance", { ascending: true }).range(offset, offset + limit - 1);
  if (minD !== null) q = q.gte("suggested_distance", minD);
  if (maxD !== null) q = q.lte("suggested_distance", maxD);
  const { data, error } = await q;
  if (error) { console.error("faces-review:", error.message); return json({ error: "Could not load the review queue." }, 500); }
  return json({ ok: true, faces: (data ?? []).map((r) => queueRow(r as Record<string, unknown>)) });
};

const hFacesUnknown: Handler = async ({ sb, payload }) => {
  const limit = Math.min(300, Math.max(1, parseInt(str(payload.limit), 10) || 60));
  const offset = Math.max(0, parseInt(str(payload.offset), 10) || 0);
  const { data, error } = await sb.from("gallery_faces")
    .select("id, photo_id, box_x, box_y, box_w, box_h, suggested_distance, suggestion:suggested_person_id(id, display_name), photo:photo_id(image_url, gallery, year)")
    .is("person_id", null).is("suggested_person_id", null)
    .order("created_at", { ascending: true }).range(offset, offset + limit - 1);
  if (error) { console.error("faces-unknown:", error.message); return json({ error: "Could not load unknown faces." }, 500); }
  return json({ ok: true, faces: (data ?? []).map((r) => queueRow(r as Record<string, unknown>)) });
};

const hFacesStatus: Handler = async ({ sb, payload, slugs }) => {
  const gallery = trimmed(payload.gallery);
  const hasGallery = slugs.has(gallery);

  let scannedQ = sb.from("gallery_photos").select("id").eq("face_scanned", true).limit(20000);
  if (hasGallery) scannedQ = scannedQ.eq("gallery", gallery);
  const { data: scanned, error } = await scannedQ;
  if (error) { console.error("faces-status:", error.message); return json({ error: "Could not load status." }, 500); }

  let unscannedQ = sb.from("gallery_photos").select("id", { count: "exact", head: true }).eq("face_scanned", false);
  if (hasGallery) unscannedQ = unscannedQ.eq("gallery", gallery);
  const { count: unscanned } = await unscannedQ;

  const { count: unnamed } = await sb.from("gallery_faces").select("id", { count: "exact", head: true }).is("person_id", null);
  const { count: suggested } = await sb.from("gallery_faces").select("id", { count: "exact", head: true }).is("person_id", null).not("suggested_person_id", "is", null);

  return json({
    ok: true,
    scanned_ids: (scanned ?? []).map((r) => r.id),
    unscanned_count: unscanned ?? 0,
    unnamed_count: unnamed ?? 0,
    suggested_count: suggested ?? 0,
  });
};

const hResuggest: Handler = async ({ sb, payload }) => {
  const maxD = typeof payload.max_distance === "number" ? payload.max_distance : 0.55;
  const { data, error } = await sb.rpc("gallery_resuggest", { p_max_distance: maxD });
  if (error) { console.error("resuggest:", error.message); return json({ error: "Could not recompute suggestions." }, 500); }
  return json({ ok: true, updated: data ?? 0 });
};

// ---- manual photo tagging (no face) ---------------------------------------
const hPhotoTag: Handler = async ({ sb, payload }) => {
  const photoId = str(payload.photo_id), personId = str(payload.person_id);
  if (!photoId || !personId) return json({ error: "photo_id and person_id are required." }, 400);
  const { error } = await sb.from("gallery_photo_people")
    .insert({ photo_id: photoId, person_id: personId, via: "manual" });
  // 23505 = already tagged; treat as success (idempotent).
  if (error && error.code !== "23505") {
    if (error.code === "23503") return json({ error: "Unknown photo or person." }, 400);
    console.error("photo-tag:", error.message);
    return json({ error: "Could not tag the photo." }, 500);
  }
  return json({ ok: true });
};

const hPhotoUntag: Handler = async ({ sb, payload }) => {
  const photoId = str(payload.photo_id), personId = str(payload.person_id);
  if (!photoId || !personId) return json({ error: "photo_id and person_id are required." }, 400);
  // If a confirmed face for this person is still on the photo, the trigger
  // would immediately re-add the tag — so refuse and point at the real fix.
  const { count } = await sb.from("gallery_faces")
    .select("id", { count: "exact", head: true }).eq("photo_id", photoId).eq("person_id", personId);
  if ((count ?? 0) > 0) return json({ error: "This person has a confirmed face in this photo. Unconfirm the face instead.", faces: count }, 409);
  const { error } = await sb.from("gallery_photo_people").delete().eq("photo_id", photoId).eq("person_id", personId);
  if (error) { console.error("photo-untag:", error.message); return json({ error: "Could not untag the photo." }, 500); }
  return json({ ok: true });
};

// ---------------------------------------------------------------------------
// Action registry
// ---------------------------------------------------------------------------
const HANDLERS: Record<string, Handler> = {
  "categories": hCategories,
  "category-create": hCategoryCreate,
  "category-update": hCategoryUpdate,
  "upload-urls": hUploadUrls,
  "upload-commit": hUploadCommit,
  "thumb-urls": hThumbUrls,
  "thumb-commit": hThumbCommit,
  "import": hImport,
  "video-add": hVideoAdd,
  "list-admin": hListAdmin,
  "update": hUpdate,
  "bulk-update": hBulkUpdate,
  "delete": hDelete,
  "people-list": hPeopleList,
  "person-create": hPersonCreate,
  "person-update": hPersonUpdate,
  "person-merge": hPersonMerge,
  "person-delete": hPersonDelete,
  "faces-save": hFacesSave,
  "faces-for-photo": hFacesForPhoto,
  "face-add-manual": hFaceAddManual,
  "face-confirm": hFaceConfirm,
  "face-confirm-batch": hFaceConfirmBatch,
  "face-reject": hFaceReject,
  "face-unreject": hFaceUnreject,
  "face-unconfirm": hFaceUnconfirm,
  "face-delete": hFaceDelete,
  "faces-review": hFacesReview,
  "faces-unknown": hFacesUnknown,
  "faces-status": hFacesStatus,
  "resuggest": hResuggest,
  "photo-tag": hPhotoTag,
  "photo-untag": hPhotoUntag,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const sb = supa();

  if (req.method === "GET") return handleGet(sb, new URL(req.url));
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Resolve the token to a role: admin, photographer, or nothing. Both are
  // compared constant-time against their stored SHA-256. On failure, wait
  // ~300ms before responding to blunt brute-forcing (no lockout — a shared
  // passphrase with a lockout would be a self-inflicted denial of service).
  const token = req.headers.get("x-admin-token") ?? "";
  const { data: cfg } = await sb.from("photo_gallery_config")
    .select("admin_token_sha256, photographer_token_sha256").eq("id", true).maybeSingle();

  let role: Role | null = null;
  if (token) {
    const hash = await sha256Hex(token);
    // Both comparisons always run, so the response time doesn't reveal which
    // passphrase was closer to correct.
    const isAdmin = tokenMatches(hash, cfg?.admin_token_sha256);
    const isPhotographer = tokenMatches(hash, cfg?.photographer_token_sha256);
    if (isAdmin) role = "admin";
    else if (isPhotographer) role = "photographer";
  }
  if (!role) { await delay(300); return json({ error: "Unauthorized. Check the gallery passphrase." }, 401); }

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
  const action = str(payload.action);
  const handler = HANDLERS[action];
  if (!handler) return json({ error: "Unknown action" }, 400);

  // A photographer token outside its allowlist is a 403, not a 401: the
  // passphrase was valid, the action just isn't permitted. A 401 would send
  // the upload page into a re-authentication loop it can never win.
  if (role === "photographer" && !PHOTOGRAPHER_ACTIONS.has(action)) {
    return json({ error: "That passphrase can only add photos. Ask an administrator for admin access." }, 403);
  }

  const cats = await loadCats(sb);
  const slugs = new Set(cats.map((c) => c.slug));
  try {
    return await handler({ sb, payload, cats, slugs, role });
  } catch (e) {
    console.error(`action ${action}:`, e instanceof Error ? e.message : String(e));
    return json({ error: "Something went wrong." }, 500);
  }
});
