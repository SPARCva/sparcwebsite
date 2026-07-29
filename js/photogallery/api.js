/* ==========================================================================
   photo-gallery admin — API layer
   --------------------------------------------------------------------------
   One wrapper over the `photo-gallery` Supabase edge function, replacing the
   ~30 hand-rolled fetch chains the old admin page carried.

   The full action contract lives in
   supabase/functions/photo-gallery/README.md — treat that as authoritative.

   Auth is a single shared passphrase sent as `x-admin-token`. The function
   SHA-256s it and compares, in constant time, against
   photo_gallery_config.admin_token_sha256 (or photographer_token_sha256 for
   the upload-only role). The publishable Supabase key is also required — it
   only gets you past the gateway, it grants nothing: every gallery table is
   RLS-locked with no policies, so all real access is service-role, inside
   the function.
   ========================================================================== */

const ENDPOINT = "https://ldxpockcgcxvsrbyhcnt.supabase.co/functions/v1/photo-gallery";
const ANON_KEY = "sb_publishable_3tn2UadRVekIf5Pw6F5z-A_40ZbdvTm";

/** Session storage key. The two pages hold different roles, so different keys. */
let storageKey = "pg_admin_token";

/**
 * Errors carry the HTTP status and the parsed body so callers can branch on
 * the cases the function documents — e.g. 409 from `person-create`
 * (duplicate name, with `existing_id`) or from `photo-untag` (a confirmed
 * face still links that person).
 */
export class PGError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "PGError";
    this.status = status;
    this.body = body || {};
  }
}

/** Fired when the server rejects our token mid-session. */
const AUTH_LOST = "pg:auth-lost";

export function configure(opts = {}) {
  if (opts.storageKey) storageKey = opts.storageKey;
}

export function getToken() {
  try { return sessionStorage.getItem(storageKey) || ""; } catch { return ""; }
}

export function setToken(token) {
  try { sessionStorage.setItem(storageKey, token); } catch { /* private mode */ }
}

export function clearToken() {
  try { sessionStorage.removeItem(storageKey); } catch { /* private mode */ }
}

export function onAuthLost(handler) {
  window.addEventListener(AUTH_LOST, handler);
}

/** The token is held in memory for the request only — never sent anywhere else. */
function headers(token) {
  return {
    "apikey": ANON_KEY,
    "Authorization": `Bearer ${ANON_KEY}`,
    "x-admin-token": token,
    "Content-Type": "application/json",
  };
}

/**
 * Call an admin action.
 *
 * Resolves with the parsed body (which always has `ok: true`) or throws a
 * PGError. That means callers use one try/catch instead of the old
 * `if (!d.ok)` / `.catch()` double-check, which is how several failures used
 * to pass silently.
 *
 * @param {string} action  e.g. "list-admin"
 * @param {object} payload merged into the request body alongside `action`
 * @param {{token?: string, signal?: AbortSignal}} [opts]
 */
export async function api(action, payload = {}, opts = {}) {
  const token = opts.token !== undefined ? opts.token : getToken();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ action, ...payload }),
      signal: opts.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new PGError("Could not reach the server. Check your connection.", 0, {});
  }

  let body = {};
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }

  // A 401 means the passphrase was rotated or was never valid. Drop the stored
  // token and let the shell show the sign-in screen rather than leaving every
  // subsequent call failing invisibly.
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent(AUTH_LOST));
    throw new PGError(body.error || "Your session has expired. Please sign in again.", 401, body);
  }

  if (!res.ok || body.ok !== true) {
    throw new PGError(body.error || "Something went wrong. Please try again.", res.status, body);
  }
  return body;
}

/**
 * Validate a passphrase and persist it only if the server accepts it.
 *
 * The old page set the token *before* checking and left the bad value in
 * place on failure, so a typo poisoned every later request. `categories` is
 * the cheapest authenticated action, so it doubles as the probe.
 */
export async function signIn(passphrase) {
  const token = String(passphrase || "").trim();
  if (!token) throw new PGError("Enter the passphrase.", 0, {});
  const res = await api("categories", {}, { token });
  setToken(token);
  return res.categories || [];
}

export function signOut() {
  clearToken();
  location.reload();
}

/** True if a token is already in this tab's session. */
export function hasToken() {
  return getToken() !== "";
}

/**
 * PUT a Blob to a Supabase signed upload URL. Used by the uploader for
 * direct-to-storage writes, so image bytes never pass through the function.
 * Signed URLs carry their own auth, so no admin token here.
 */
export async function putSigned(signedUrl, blob, contentType) {
  const res = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType || blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!res.ok) {
    throw new PGError(`Upload failed (${res.status}).`, res.status, {});
  }
  return true;
}

export { ENDPOINT, ANON_KEY };
