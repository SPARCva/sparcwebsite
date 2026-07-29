/* ==========================================================================
   photo-gallery admin — upload pipeline
   --------------------------------------------------------------------------
   Shared by /photogallery/admin/ (staff) and /photogallery/upload/
   (photographers). The only difference between them is that the photographer
   page passes a `submission` label and its token forces published = false.

   Flow, per batch of <= 50 files:

     api("upload-urls")      -> signed PUT URLs for a main + thumb object each
     renderPair()            -> one decode, two canvases (2000px + 400px)
     PUT main, PUT thumb     -> straight to storage, bytes never touch the
                                edge function
     api("upload-commit")    -> insert rows

   Why partial failure is safe: `upload-commit` verifies every storage_path
   really exists in the bucket before inserting, so a file whose PUT failed
   simply gets no row. Nothing to clean up, and the item can be retried.
   ========================================================================== */

import { api, putSigned } from "./api.js";
import { renderPair, takenAt } from "./imaging.js";
import { pool } from "./ui.js";

/**
 * The function caps both upload-urls and upload-commit at 50 per call, but we
 * ask for 25: upload-urls mints *two* signed URLs per file, so 50 files means
 * 100 sequential storage round-trips inside a single edge invocation, which
 * crowds the CPU/wall budget. 25 is comfortably inside both limits.
 */
const BATCH_SIZE = 25;
/** Concurrent PUTs. Sequential is needlessly slow for 200 photos; unbounded
    parallelism plus canvas decoding exhausts memory on a laptop. */
const CONCURRENCY = 4;
/** The bucket rejects anything larger, and so does the import path. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export const ACCEPTED = /^image\/(jpeg|png|webp)$/i;

/**
 * Turn a FileList/array into queue items, rejecting what we can't handle.
 * Returns {items, rejected} so the caller can tell the user *why* something
 * was dropped instead of silently ignoring it.
 */
export function buildQueue(fileList) {
  const items = [];
  const rejected = [];
  for (const file of Array.from(fileList || [])) {
    if (!ACCEPTED.test(file.type)) {
      rejected.push({ file, reason: "not a JPG, PNG or WEBP" });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      rejected.push({ file, reason: `${(file.size / 1048576).toFixed(1)} MB — over the 25 MB limit` });
      continue;
    }
    items.push({
      id: `q${Math.random().toString(36).slice(2, 10)}`,
      file,
      caption: "",
      alt_text: "",
      featured: false,
      taken_at: null,
      state: "queued",     // queued | resizing | uploading | committed | failed
      error: "",
      // Filled in once we hold signed URLs, so a retry can reuse them.
      paths: null,
    });
  }
  return { items, rejected };
}

/** Read EXIF dates in the background so they're ready before upload. */
export async function primeDates(items, onUpdate) {
  for (const item of items) {
    if (item.taken_at) continue;
    item.taken_at = await takenAt(item.file);
    if (onUpdate) onUpdate(item);
  }
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Upload a set of queue items.
 *
 * @param {Array} items         from buildQueue(); mutated in place so the
 *                              caller's rendered rows update as we go
 * @param {object} opts
 * @param {string} opts.gallery album slug
 * @param {number} opts.year
 * @param {string} [opts.submission] batch label — groups the review queue
 * @param {boolean} [opts.published] omit to let the server decide
 * @param {Function} [opts.onItem]  called whenever an item's state changes
 * @param {Function} [opts.onProgress] (done, total)
 * @param {AbortSignal} [opts.signal]
 * @returns {{committed: number, failed: number, skipped: Array}}
 */
export async function uploadItems(items, opts) {
  const { gallery, year, submission, published, onItem, onProgress, signal } = opts;
  const pending = items.filter((item) => item.state !== "committed");
  let committed = 0;
  let failed = 0;
  const skipped = [];
  let settledCount = 0;
  const total = pending.length;

  const touch = (item) => { if (onItem) onItem(item); };
  const tick = () => { if (onProgress) onProgress(settledCount, total); };

  for (const batch of chunk(pending, BATCH_SIZE)) {
    if (signal?.aborted) break;

    // 1. Signed URLs for the whole batch in one call.
    let uploads;
    try {
      const res = await api("upload-urls", {
        gallery,
        year,
        files: batch.map((item) => ({ name: item.file.name, content_type: item.file.type })),
      }, { signal });
      uploads = res.uploads || [];
    } catch (err) {
      for (const item of batch) {
        item.state = "failed";
        item.error = err.message;
        touch(item);
        failed++;
        settledCount++;
      }
      tick();
      continue;
    }

    // 2. Resize + PUT, capped concurrency.
    const readyForCommit = [];
    await pool(batch.map((item, index) => async () => {
      if (signal?.aborted) return;
      const slot = uploads[index];
      if (!slot) {
        item.state = "failed";
        item.error = "The server did not return an upload URL.";
        touch(item);
        failed++;
        return;
      }
      item.paths = { storage_path: slot.main.path, thumb_path: slot.thumb.path };

      try {
        item.state = "resizing";
        touch(item);
        const { main, thumb } = await renderPair(item.file);

        item.state = "uploading";
        touch(item);
        // One retry: a single dropped connection shouldn't cost the photo.
        await withRetry(() => putSigned(slot.main.signedUrl, main.blob, main.contentType));
        await withRetry(() => putSigned(slot.thumb.signedUrl, thumb.blob, thumb.contentType));

        if (!item.taken_at) item.taken_at = await takenAt(item.file);

        readyForCommit.push({
          item,
          row: {
            storage_path: slot.main.path,
            thumb_path: slot.thumb.path,
            caption: item.caption || "",
            alt_text: item.alt_text || "",
            taken_at: item.taken_at || null,
            width: main.width,
            height: main.height,
            is_featured: !!item.featured,
            source: "upload",
          },
        });
      } catch (err) {
        item.state = "failed";
        item.error = err.message || "Upload failed.";
        touch(item);
        failed++;
      }
    }), CONCURRENCY, () => { settledCount++; tick(); });

    if (signal?.aborted) break;
    if (!readyForCommit.length) continue;

    // 3. Commit the objects that actually landed.
    try {
      const payload = {
        gallery,
        year,
        items: readyForCommit.map((entry) => entry.row),
      };
      if (submission) payload.submission = submission;
      if (published !== undefined) payload.published = published;

      const res = await api("upload-commit", payload, { signal });

      // The server reports per-index skips (e.g. object not found). Mark
      // those failed rather than reporting a false success, which is what the
      // old page did for deletes.
      const skippedIndexes = new Set((res.skipped || []).map((s) => s.index));
      for (const entry of res.skipped || []) skipped.push(entry);

      readyForCommit.forEach((entry, index) => {
        if (skippedIndexes.has(index)) {
          entry.item.state = "failed";
          const reason = (res.skipped || []).find((s) => s.index === index);
          entry.item.error = reason ? reason.reason : "The server skipped this photo.";
          failed++;
        } else {
          entry.item.state = "committed";
          entry.item.error = "";
          committed++;
        }
        touch(entry.item);
      });
    } catch (err) {
      for (const entry of readyForCommit) {
        entry.item.state = "failed";
        entry.item.error = err.message;
        touch(entry.item);
        failed++;
      }
    }
  }

  return { committed, failed, skipped };
}

async function withRetry(fn, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Only a transport hiccup is worth retrying; a 4xx will just repeat.
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastError;
}
