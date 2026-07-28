// photo-gallery
// -----------------------------------------------------------------------------
// Backend for the public /photogallery pages (galleries: gala, summit, life).
//
// PUBLIC reads (GET, no auth beyond the Supabase gateway apikey):
//   GET ?action=list&gallery=gala[&year=2025|all][&q=jane]
//       -> { ok, years:[...], featured:[...], photos:[...] }
//   Returns the distinct years for a gallery, the header-scroll "featured"
//   photos (ordered through the day), and the photos for the requested year,
//   optionally filtered by a person-name / caption query. Only published rows
//   are ever returned.
//
// ADMIN writes (POST, require the x-admin-token header — its SHA-256 must match
// photo_gallery_config.admin_token_sha256):
//   action=list-admin   { gallery }                         -> all rows incl. unpublished
//   action=upload        multipart: file + gallery,year,...  -> stores in bucket, inserts row
//   action=import        { gallery, year, items:[{image_url, source, external_id, ...}] }
//                                                            -> re-hosts each image, inserts rows
//   action=update        { id, patch:{...} }                 -> edits one row
//   action=bulk-update   { ids:[...], patch:{...} }          -> edits many rows (bulk tagging)
//   action=delete        { id }                              -> deletes row + storage object
//
// The gallery_photos + photo_gallery_config tables are RLS-locked with no
// policies; this function uses the service-role key. Person tags in `people`
// are manually assigned in the admin UI — no biometric/face data is stored.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-token",
};

const BUCKET = "gallery";
const GALLERIES = ["gala", "summit", "life"];
const SOURCES = ["upload", "photographer", "google_photos", "gdrive", "onedrive", "facebook", "repo"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function supa() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
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

// Resolve the caller's access level from the x-admin-token header:
//   "admin"        -> full access (matches admin_token_sha256)
//   "photographer" -> upload only; photos land unpublished for review
//   null           -> unauthorized
async function authLevel(
  req: Request,
  sb: ReturnType<typeof supa>,
): Promise<"admin" | "photographer" | null> {
  const token = req.headers.get("x-admin-token") ?? "";
  if (!token) return null;
  const { data } = await sb
    .from("photo_gallery_config")
    .select("admin_token_sha256, photographer_token_sha256")
    .eq("id", true)
    .maybeSingle();
  const provided = await sha256Hex(token);
  if (tokenMatches(provided, data?.admin_token_sha256)) return "admin";
  if (tokenMatches(provided, data?.photographer_token_sha256)) return "photographer";
  return null;
}

// Public shape returned to the browser (never leaks internal columns).
function publicRow(r: Record<string, unknown>) {
  return {
    id: r.id,
    gallery: r.gallery,
    year: r.year,
    image_url: r.image_url,
    thumb_url: r.thumb_url ?? r.image_url,
    caption: r.caption ?? "",
    alt_text: (r.alt_text as string) || (r.caption as string) || "",
    people: r.people ?? [],
    taken_at: r.taken_at,
    is_featured: r.is_featured,
    featured_order: r.featured_order,
    sort_order: r.sort_order,
    width: r.width,
    height: r.height,
  };
}

// Case-insensitive substring match against caption + any person tag.
function matchesQuery(r: Record<string, unknown>, q: string): boolean {
  const needle = q.toLowerCase();
  if (String(r.caption ?? "").toLowerCase().includes(needle)) return true;
  const people = (r.people as string[]) ?? [];
  return people.some((p) => String(p).toLowerCase().includes(needle));
}

function normPeople(input: unknown): string[] {
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean).slice(0, 60);
  if (typeof input === "string") {
    return input.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 60);
  }
  return [];
}

function extFromType(type: string, url: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
    "image/webp": "webp", "image/gif": "gif", "image/heic": "heic",
  };
  if (map[type]) return map[type];
  const m = url.split("?")[0].match(/\.([a-z0-9]{3,4})$/i);
  return m ? m[1].toLowerCase() : "jpg";
}

// Store raw bytes into the bucket and return the public URL + path.
async function storeBytes(
  sb: ReturnType<typeof supa>,
  gallery: string,
  year: number,
  bytes: Uint8Array,
  contentType: string,
  ext: string,
): Promise<{ path: string; url: string }> {
  const rand = crypto.randomUUID();
  const path = `${gallery}/${year}/${rand}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, bytes, {
    contentType: contentType || "image/jpeg",
    upsert: false,
  });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
  return { path, url: data.publicUrl };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const sb = supa();
  const url = new URL(req.url);

  // ==========================================================================
  // PUBLIC READS (GET)
  // ==========================================================================
  if (req.method === "GET") {
    const action = url.searchParams.get("action") ?? "list";
    if (action !== "list") return json({ error: "Unknown action" }, 400);

    const gallery = String(url.searchParams.get("gallery") ?? "").trim();
    if (!GALLERIES.includes(gallery)) {
      return json({ error: "Unknown gallery" }, 400);
    }
    const yearParam = url.searchParams.get("year");
    const q = (url.searchParams.get("q") ?? "").trim();

    // Distinct years for this gallery (desc).
    const { data: yearRows, error: yearErr } = await sb
      .from("gallery_photos")
      .select("year")
      .eq("gallery", gallery)
      .eq("published", true);
    if (yearErr) {
      console.error("years query failed:", yearErr.message);
      return json({ error: "Could not load gallery." }, 500);
    }
    const years = [...new Set((yearRows ?? []).map((r) => r.year as number))].sort((a, b) => b - a);

    // Featured photos for the header scroll (all years for this gallery),
    // ordered by featured_order (nulls last) then taken_at then created_at.
    const { data: featRows } = await sb
      .from("gallery_photos")
      .select("*")
      .eq("gallery", gallery)
      .eq("published", true)
      .eq("is_featured", true)
      .order("featured_order", { ascending: true, nullsFirst: false })
      .order("taken_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .limit(60);

    // Photos for the requested year (default: latest year). year=all -> every year.
    let selectedYear: number | null = null;
    if (yearParam && yearParam !== "all") {
      const n = parseInt(yearParam, 10);
      if (!Number.isNaN(n)) selectedYear = n;
    } else if (yearParam !== "all") {
      selectedYear = years[0] ?? null;
    }

    let photoQ = sb
      .from("gallery_photos")
      .select("*")
      .eq("gallery", gallery)
      .eq("published", true)
      .order("taken_at", { ascending: true, nullsFirst: false })
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(2000);
    if (selectedYear !== null) photoQ = photoQ.eq("year", selectedYear);

    const { data: photoRows, error: photoErr } = await photoQ;
    if (photoErr) {
      console.error("photos query failed:", photoErr.message);
      return json({ error: "Could not load gallery." }, 500);
    }

    let photos = (photoRows ?? []).map(publicRow);
    let featured = (featRows ?? []).map(publicRow);
    if (q) {
      photos = photos.filter((r) => matchesQuery(r, q));
      // When searching, header scroll follows the same query across all years.
      featured = featured.filter((r) => matchesQuery(r, q));
    }

    return json({
      ok: true,
      gallery,
      years,
      selectedYear: selectedYear,
      featured,
      photos,
      count: photos.length,
    }, 200);
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ==========================================================================
  // AUTHENTICATED WRITES (POST)
  //   admin        -> every action
  //   photographer -> multipart upload only; forced to published=false (review)
  // ==========================================================================
  const level = await authLevel(req, sb);
  if (!level) {
    return json({ error: "Unauthorized. Check the gallery passphrase." }, 401);
  }

  const contentType = req.headers.get("content-type") ?? "";

  // ---- action: upload (multipart) -----------------------------------------
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "Invalid upload." }, 400);
    }
    if (String(form.get("action") ?? "upload") !== "upload") {
      return json({ error: "Unknown multipart action" }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "No file provided." }, 400);

    const gallery = String(form.get("gallery") ?? "").trim();
    const year = parseInt(String(form.get("year") ?? ""), 10);
    if (!GALLERIES.includes(gallery)) return json({ error: "Unknown gallery" }, 400);
    if (Number.isNaN(year) || year < 1990 || year > 2100) return json({ error: "Invalid year" }, 400);
    if (file.size > 25 * 1024 * 1024) return json({ error: "Image exceeds 25MB." }, 400);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = extFromType(file.type, file.name);
    let stored;
    try {
      stored = await storeBytes(sb, gallery, year, bytes, file.type, ext);
    } catch (e) {
      console.error(e);
      return json({ error: "Could not store the image." }, 500);
    }

    const takenAtRaw = String(form.get("taken_at") ?? "").trim();
    // Photographer uploads land unpublished and un-featured for admin review;
    // admin uploads publish immediately unless told otherwise.
    const isPhotographer = level === "photographer";
    const row = {
      gallery,
      year,
      storage_path: stored.path,
      image_url: stored.url,
      caption: String(form.get("caption") ?? "").slice(0, 2000),
      alt_text: String(form.get("alt_text") ?? "").slice(0, 2000),
      people: normPeople(form.get("people")),
      taken_at: takenAtRaw || null,
      is_featured: !isPhotographer && String(form.get("is_featured") ?? "") === "true",
      source: isPhotographer ? "photographer" : "upload",
      published: !isPhotographer,
    };
    const { data, error } = await sb.from("gallery_photos").insert(row).select("*").single();
    if (error) {
      console.error("insert failed:", error.message);
      return json({ error: "Saved image but could not record it." }, 500);
    }
    return json({ ok: true, photo: publicRow(data) });
  }

  // ---- JSON actions (admin only) -------------------------------------------
  if (level !== "admin") {
    return json({ error: "This action requires the admin passphrase." }, 403);
  }
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const action = String(payload.action ?? "");

  // list-admin: everything (incl. unpublished) for the management grid.
  if (action === "list-admin") {
    const gallery = String(payload.gallery ?? "").trim();
    let q = sb.from("gallery_photos").select("*").order("year", { ascending: false })
      .order("taken_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true }).limit(5000);
    if (GALLERIES.includes(gallery)) q = q.eq("gallery", gallery);
    const { data, error } = await q;
    if (error) return json({ error: error.message }, 500);
    return json({
      ok: true,
      photos: (data ?? []).map((r) => ({ ...publicRow(r), published: r.published, source: r.source, storage_path: r.storage_path })),
    });
  }

  // import: re-host a batch of external images (Google Photos picker, OneDrive,
  // Facebook) into our bucket so their (often expiring) URLs never rot.
  if (action === "import") {
    const gallery = String(payload.gallery ?? "").trim();
    const year = parseInt(String(payload.year ?? ""), 10);
    const source = String(payload.source ?? "google_photos");
    const items = Array.isArray(payload.items) ? payload.items : [];
    // Optional OAuth bearer token (e.g. Google Photos Picker) used only to
    // fetch the source images server-side. Never stored or logged.
    const auth = payload.auth ? String(payload.auth) : null;
    if (!GALLERIES.includes(gallery)) return json({ error: "Unknown gallery" }, 400);
    if (Number.isNaN(year)) return json({ error: "Invalid year" }, 400);
    if (!SOURCES.includes(source)) return json({ error: "Unknown source" }, 400);
    if (!items.length) return json({ error: "No items to import." }, 400);
    if (items.length > 200) return json({ error: "Import at most 200 photos at a time." }, 400);

    const results: { ok: boolean; error?: string; id?: string }[] = [];
    for (const it of items as Record<string, unknown>[]) {
      const imageUrl = String(it.image_url ?? "").trim();
      const externalId = it.external_id ? String(it.external_id) : null;
      if (!imageUrl) { results.push({ ok: false, error: "missing image_url" }); continue; }

      // Skip if we already imported this external id.
      if (externalId) {
        const { data: dup } = await sb.from("gallery_photos").select("id")
          .eq("source", source).eq("external_id", externalId).maybeSingle();
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
        const { data, error } = await sb.from("gallery_photos").insert({
          gallery, year,
          storage_path: stored.path,
          image_url: stored.url,
          caption: String(it.caption ?? "").slice(0, 2000),
          alt_text: String(it.alt_text ?? "").slice(0, 2000),
          people: normPeople(it.people),
          taken_at: it.taken_at ? String(it.taken_at) : null,
          source, external_id: externalId,
          width: it.width ? Number(it.width) : null,
          height: it.height ? Number(it.height) : null,
        }).select("id").single();
        if (error) throw new Error(error.message);
        results.push({ ok: true, id: data.id as string });
      } catch (e) {
        results.push({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const imported = results.filter((r) => r.ok).length;
    return json({ ok: true, imported, failed: results.length - imported, results });
  }

  // update: edit a single row.
  if (action === "update") {
    const id = String(payload.id ?? "");
    const patch = (payload.patch ?? {}) as Record<string, unknown>;
    if (!id) return json({ error: "Missing id" }, 400);
    const clean = buildPatch(patch);
    if (!Object.keys(clean).length) return json({ error: "Nothing to update." }, 400);
    const { data, error } = await sb.from("gallery_photos").update(clean).eq("id", id).select("*").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, photo: publicRow(data) });
  }

  // bulk-update: apply the same patch to many rows (bulk tagging / re-year).
  if (action === "bulk-update") {
    const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
    const patch = (payload.patch ?? {}) as Record<string, unknown>;
    const addPeople = normPeople(patch.add_people);
    const clean = buildPatch(patch);
    if (!ids.length) return json({ error: "No photos selected." }, 400);
    if (ids.length > 1000) return json({ error: "Too many photos selected." }, 400);

    // "add_people" appends tags without clobbering existing ones (row by row).
    if (addPeople.length) {
      const { data: rows } = await sb.from("gallery_photos").select("id, people").in("id", ids);
      for (const r of rows ?? []) {
        const merged = [...new Set([...((r.people as string[]) ?? []), ...addPeople])];
        await sb.from("gallery_photos").update({ people: merged }).eq("id", r.id);
      }
    }
    if (Object.keys(clean).length) {
      const { error } = await sb.from("gallery_photos").update(clean).in("id", ids);
      if (error) return json({ error: error.message }, 500);
    }
    return json({ ok: true, updated: ids.length });
  }

  // delete: remove the row and its storage object.
  if (action === "delete") {
    const id = String(payload.id ?? "");
    if (!id) return json({ error: "Missing id" }, 400);
    const { data: row } = await sb.from("gallery_photos").select("storage_path").eq("id", id).maybeSingle();
    if (row?.storage_path) {
      await sb.storage.from(BUCKET).remove([row.storage_path as string]);
    }
    const { error } = await sb.from("gallery_photos").delete().eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ==========================================================================
  // FACE RECOGNITION — descriptors are computed in the browser (face-api.js);
  // this side just stores them and propagates a name to every matching face.
  // ==========================================================================

  // faces-status: which photos in a gallery already had faces computed.
  if (action === "faces-status") {
    const gallery = String(payload.gallery ?? "").trim();
    let q = sb.from("gallery_photos").select("id").eq("face_scanned", true).limit(20000);
    if (GALLERIES.includes(gallery)) q = q.eq("gallery", gallery);
    const { data, error } = await q;
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, scanned: (data ?? []).map((r) => r.id) });
  }

  // faces-save: store the descriptors the browser computed for a batch of
  // photos. Replaces any existing faces for those photos and marks them scanned
  // (a photo with zero faces is still marked scanned so it isn't reprocessed).
  if (action === "faces-save") {
    const photos = Array.isArray(payload.photos) ? payload.photos : [];
    if (!photos.length) return json({ error: "No photos." }, 400);
    let inserted = 0;
    for (const p of photos as Record<string, unknown>[]) {
      const photoId = String(p.photo_id ?? "");
      if (!photoId) continue;
      const faces = Array.isArray(p.faces) ? p.faces as Record<string, unknown>[] : [];
      await sb.from("gallery_faces").delete().eq("photo_id", photoId);
      const valid = faces.filter((f) => Array.isArray(f.embedding) && (f.embedding as unknown[]).length === 128);
      if (valid.length) {
        const rows = valid.map((f) => ({ photo_id: photoId, embedding: f.embedding, box: f.box ?? null }));
        const { error } = await sb.from("gallery_faces").insert(rows);
        if (!error) inserted += rows.length;
      }
      await sb.from("gallery_photos").update({ face_scanned: true }).eq("id", photoId);
    }
    return json({ ok: true, inserted });
  }

  // faces-unnamed: faces not yet assigned a name, with their photo's URL + box
  // so the admin can preview and name them. Embeddings are NOT returned.
  if (action === "faces-unnamed") {
    const { data, error } = await sb.from("gallery_faces")
      .select("id, photo_id, box, photo:gallery_photos(image_url, gallery, year)")
      .is("person_name", null).limit(3000);
    if (error) return json({ error: error.message }, 500);
    const faces = (data ?? []).map((r) => {
      const ph = (r as Record<string, unknown>).photo as Record<string, unknown> | null;
      return {
        id: r.id, photo_id: r.photo_id, box: r.box,
        image_url: ph?.image_url, gallery: ph?.gallery, year: ph?.year,
      };
    });
    return json({ ok: true, faces });
  }

  // faces-name: assign a name to one face and propagate it to every face whose
  // descriptor is within `threshold` Euclidean distance, then add the name to
  // each of those photos' people[] (so site search finds them).
  if (action === "faces-name") {
    const name = String(payload.name ?? "").trim().slice(0, 120);
    const faceId = String(payload.face_id ?? "");
    const threshold = typeof payload.threshold === "number" ? payload.threshold : 0.55;
    if (!name) return json({ error: "Missing name." }, 400);
    if (!faceId) return json({ error: "Missing face." }, 400);

    const { data: src } = await sb.from("gallery_faces").select("embedding").eq("id", faceId).maybeSingle();
    const emb = src?.embedding as number[] | undefined;
    if (!Array.isArray(emb) || emb.length !== 128) return json({ error: "Invalid face." }, 400);

    // Match against still-unnamed faces (naming never overwrites an existing name).
    const { data: faces, error } = await sb.from("gallery_faces")
      .select("id, photo_id, embedding").is("person_name", null).limit(20000);
    if (error) return json({ error: error.message }, 500);

    const matchedFaceIds: string[] = [];
    const matchedPhotoIds = new Set<string>();
    for (const f of faces ?? []) {
      const fe = f.embedding as number[];
      if (!Array.isArray(fe) || fe.length !== 128) continue;
      let sum = 0;
      for (let i = 0; i < 128; i++) { const d = fe[i] - emb[i]; sum += d * d; }
      if (Math.sqrt(sum) <= threshold) {
        matchedFaceIds.push(f.id as string);
        matchedPhotoIds.add(f.photo_id as string);
      }
    }
    if (!matchedFaceIds.length) return json({ ok: true, faces: 0, photos: 0 });

    await sb.from("gallery_faces").update({ person_name: name }).in("id", matchedFaceIds);
    const photoIds = [...matchedPhotoIds];
    const { data: prows } = await sb.from("gallery_photos").select("id, people").in("id", photoIds);
    for (const r of prows ?? []) {
      const merged = [...new Set([...((r.people as string[]) ?? []), name])];
      await sb.from("gallery_photos").update({ people: merged }).eq("id", r.id);
    }
    return json({ ok: true, faces: matchedFaceIds.length, photos: photoIds.length });
  }

  return json({ error: "Unknown action" }, 400);
});

// Whitelist + coerce the editable columns for update / bulk-update.
function buildPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  if ("caption" in patch) clean.caption = String(patch.caption ?? "").slice(0, 2000);
  if ("alt_text" in patch) clean.alt_text = String(patch.alt_text ?? "").slice(0, 2000);
  if ("people" in patch) clean.people = normPeople(patch.people);
  if ("year" in patch) {
    const y = parseInt(String(patch.year), 10);
    if (!Number.isNaN(y) && y >= 1990 && y <= 2100) clean.year = y;
  }
  if ("gallery" in patch && GALLERIES.includes(String(patch.gallery))) clean.gallery = patch.gallery;
  if ("is_featured" in patch) clean.is_featured = !!patch.is_featured;
  if ("featured_order" in patch) {
    const n = parseInt(String(patch.featured_order), 10);
    clean.featured_order = Number.isNaN(n) ? null : n;
  }
  if ("sort_order" in patch) {
    const n = parseInt(String(patch.sort_order), 10);
    if (!Number.isNaN(n)) clean.sort_order = n;
  }
  if ("taken_at" in patch) clean.taken_at = patch.taken_at ? String(patch.taken_at) : null;
  if ("published" in patch) clean.published = !!patch.published;
  return clean;
}
