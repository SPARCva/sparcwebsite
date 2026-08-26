// docs — the documents Debi sends back for editing.
//
// WHY THIS EXISTS SEPARATELY FROM daily-sweep
//
// email_attachments already archives files to Drive with sha256 dedupe, and the
// spec says to use it. But every one of its 19 rows is kind='check_image': the
// sweep only looks at attachments on the money path (from:kat@ with check
// subjects). Debi's document threads were never captured, so the table has no
// .docx or .pptx in it at all. This adds the missing ingest and writes into the
// same table, rather than starting a second archive.
//
// WHAT IT DOES AND DOES NOT DO
//
// Reads: it unzips a .docx, pulls Debi's tracked insertions and deletions and
// her comments, and reconstructs both sides — her original and the text with
// her changes applied — so they can be shown side by side.
//
// Extracts: the instructions in the covering email, which for decks is the more
// common case ("you replaced slide 41 instead of slide 42", "remove slide 36").
// Each becomes a discrete instruction with an honest applicability verdict.
//
// It does NOT rewrite the file and send it back. Producing a revised .docx or
// editing a .pptx in place is a write path, and nothing here pretends to have
// applied a change it has not. Every instruction lands as needs_human until
// that path exists and can be verified against a real document.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { BlobReader, ZipReader, TextWriter } from "jsr:@zip-js/zip-js@2.7.62";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const ARCHIVE_FOLDER = "1hF1oMD40CwM2GFg5Y1QrAx-JErBDdqFf";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-4-6";
const DEBI = "debi@sparcsolutions.org";
const ERICA = "erica@sparcsolutions.org";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const ACTIONS = ["list", "scan", "diff", "instructions_save", "mark"];

const DOC_EXT = /\.(docx|pptx|xlsx)$/i;
const kindOf = (name: string) => {
  const m = name.toLowerCase().match(DOC_EXT);
  return m ? m[1] : "other";
};

// ---------------------------------------------------------------- auth
async function sha256hex(bytes: Uint8Array) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256(s: string) { return sha256hex(new TextEncoder().encode(s)); }
async function requireUser(req: Request) {
  const raw = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (raw === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) return { email: "system:cron" };
  const { data } = await db.from("app_sessions")
    .select("expires_at, app_users!inner(email, enabled)")
    .eq("token_hash", await sha256(raw)).maybeSingle();
  if (!data || new Date(data.expires_at) < new Date()) return null;
  const u = (data as any).app_users;
  return u?.enabled ? u : null;
}
const audit = (action: string, by: string, changes: unknown) =>
  db.from("audit_log").insert({ action, performed_by: by, changes: changes as any });

// ---------------------------------------------------------------- gmail
async function accessToken() {
  const { data: tok } = await db.from("gmail_tokens").select("*").eq("user_email", ERICA).maybeSingle();
  if (!tok) throw new Error("No Gmail token for " + ERICA + ". Reconnect through gmail-auth.");
  if (tok.access_token && tok.token_expiry && new Date(tok.token_expiry) > new Date(Date.now() + 60000)) {
    return tok.access_token as string;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: tok.refresh_token, grant_type: "refresh_token",
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("Token refresh failed: " + JSON.stringify(j).slice(0, 200));
  await db.from("gmail_tokens")
    .update({ access_token: j.access_token, token_expiry: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString() })
    .eq("user_email", ERICA);
  return j.access_token as string;
}
async function gmail(token: string, path: string) {
  const res = await fetch(GMAIL + path, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) throw new Error("Gmail " + res.status + ": " + (await res.text()).slice(0, 200));
  return res.json();
}

const b64dec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64str = (s: string) => { try { return new TextDecoder().decode(b64dec(s)); } catch { return ""; } };
function findPart(p: any, mime: string): string {
  if (!p) return "";
  if (p.mimeType === mime && p.body?.data) return b64str(p.body.data);
  for (const c of p.parts ?? []) { const t = findPart(c, mime); if (t) return t; }
  return "";
}
function bodyText(p: any): string {
  const plain = findPart(p, "text/plain");
  if (plain.trim()) return plain;
  const html = findPart(p, "text/html");
  return html ? html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&") : "";
}
const header = (m: any, n: string) =>
  m.payload?.headers?.find((h: any) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
const isoDate = (s?: string) => { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString(); };

function allAttachments(payload: any, acc: any[] = []): any[] {
  for (const p of payload?.parts ?? []) {
    if (p.filename && p.body?.attachmentId)
      acc.push({ filename: p.filename, mimeType: p.mimeType, size: p.body.size, attachmentId: p.body.attachmentId });
    if (p.parts) allAttachments(p, acc);
  }
  return acc;
}

// ---------------------------------------------------------------- docx
// A .docx is a zip; the text lives in word/document.xml and the comments in
// word/comments.xml. Debi's tracked changes are <w:ins> and <w:del> runs.
//
// Reconstructing both sides is exactly what those two elements give you:
//   her original  = keep <w:del> text, drop <w:ins> text
//   with changes  = keep <w:ins> text, drop <w:del> text
// so the side-by-side view is a read of the file, not a guess at her intent.
async function readDocx(bytes: Uint8Array) {
  const zip = new ZipReader(new BlobReader(new Blob([bytes])));
  const entries = await zip.getEntries();
  const grab = async (name: string) => {
    const e = entries.find((x: any) => x.filename === name);
    if (!e || !e.getData) return "";
    return await e.getData(new TextWriter());
  };
  const docXml = await grab("word/document.xml");
  const commentsXml = await grab("word/comments.xml");
  await zip.close();
  return { docXml, commentsXml };
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Text inside <w:t>…</w:t>, in document order.
function runText(xml: string) {
  let out = "";
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) out += unescapeXml(m[1]);
  // <w:delText> carries the text of a deletion.
  for (const m of xml.matchAll(/<w:delText(?:\s[^>]*)?>([\s\S]*?)<\/w:delText>/g)) out += unescapeXml(m[1]);
  return out;
}

// Walk paragraphs, splitting each into plain / inserted / deleted segments.
function parseTracked(docXml: string) {
  const paras: any[] = [];
  let insertions = 0, deletions = 0;

  for (const pm of docXml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const inner = pm[1];
    const segs: { kind: "same" | "ins" | "del"; text: string; author?: string }[] = [];

    // Consume the paragraph in order: an <w:ins> or <w:del> block, or a plain run.
    const re = /<w:(ins|del)\s([^>]*)>([\s\S]*?)<\/w:\1>|<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
    for (const m of inner.matchAll(re)) {
      if (m[1]) {
        const kind = m[1] as "ins" | "del";
        const author = /w:author="([^"]*)"/.exec(m[2])?.[1];
        const text = runText(m[3]);
        if (text) {
          segs.push({ kind, text, author });
          if (kind === "ins") insertions++; else deletions++;
        }
      } else if (m[4] != null) {
        const text = runText(m[4]);
        if (text) segs.push({ kind: "same", text });
      }
    }
    if (segs.length) paras.push({ segs });
  }

  const original = paras.map((p: any) =>
    p.segs.filter((s: any) => s.kind !== "ins").map((s: any) => s.text).join("")).join("\n");
  const revised = paras.map((p: any) =>
    p.segs.filter((s: any) => s.kind !== "del").map((s: any) => s.text).join("")).join("\n");

  return { paras, original, revised, insertions, deletions };
}

function parseComments(xml: string) {
  const out: any[] = [];
  for (const m of xml.matchAll(/<w:comment\s([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const author = /w:author="([^"]*)"/.exec(m[1])?.[1] ?? null;
    const date = /w:date="([^"]*)"/.exec(m[1])?.[1] ?? null;
    const text = runText(m[2]).trim();
    if (text) out.push({ author, date, text });
  }
  return out;
}

// ---------------------------------------------------------------- model
const INSTRUCTION_SYSTEM = [
  "You read an email from Debi Alexander, CEO of SPARC, to Erica Gaffney, that came with a document or deck attached.",
  "",
  "Extract every discrete change Debi is asking for, in her order.",
  "",
  "Rules:",
  "- One instruction per distinct change. 'Replace the photo on slide 42, not 41' and 'remove slide 36' are two.",
  "- quote must be her actual words, verbatim, under 200 characters. Required. If you cannot quote it, it is not an instruction.",
  "- target names what it applies to when she says so: a slide number, a page, a section, a heading. Otherwise null. NEVER guess a slide or page number she did not give.",
  "- kind is one of: text (wording), image (a photo or graphic), slide (add/remove/reorder), formatting, data (a figure or table), other.",
  "- Do not include pleasantries, thanks, or scheduling.",
  "- If the email asks for nothing about the document, return {\"instructions\":[]}.",
  "",
  "Return ONLY minified JSON, no fence:",
  '{"instructions":[{"quote":"","what":"","target":null,"kind":"text"}]}',
  "",
  "what is a short imperative restatement, under 100 characters.",
].join("\n");

async function extractInstructions(subject: string, text: string, filenames: string[]) {
  if (!ANTHROPIC_KEY) return { error: "ANTHROPIC_API_KEY is not set." };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1500, system: INSTRUCTION_SYSTEM,
      messages: [{ role: "user", content: "Subject: " + subject + "\nAttached: " + filenames.join(", ") + "\n\n" + text.slice(0, 6000) }],
    }),
  });
  const j = await res.json();
  if (!res.ok) return { error: "Anthropic " + res.status + ": " + JSON.stringify(j).slice(0, 200) };
  const raw = (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return { data: JSON.parse(cleaned) }; } catch { return { error: "Model did not return JSON." }; }
}

// ---------------------------------------------------------------- drive
async function archive(token: string, msgId: string, att: any) {
  const { data: seen } = await db.from("email_attachments")
    .select("id, drive_file_id").eq("gmail_message_id", msgId)
    .eq("gmail_attachment_id", att.attachmentId).maybeSingle();
  if (seen?.drive_file_id) return { id: seen.id, skipped: "already archived" };

  const a = await gmail(token, "/messages/" + msgId + "/attachments/" + att.attachmentId);
  if (!a?.data) return { error: "no attachment data" };
  const bytes = b64dec(a.data);
  const hash = await sha256hex(bytes);

  const boundary = "sparc" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const pre = enc.encode("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
    + JSON.stringify({ name: att.filename, parents: [ARCHIVE_FOLDER] })
    + "\r\n--" + boundary + "\r\nContent-Type: " + (att.mimeType || "application/octet-stream") + "\r\n\r\n");
  const post = enc.encode("\r\n--" + boundary + "--");
  const payload = new Uint8Array(pre.length + bytes.length + post.length);
  payload.set(pre, 0); payload.set(bytes, pre.length); payload.set(post, pre.length + bytes.length);

  const up = await fetch(DRIVE_UPLOAD + "?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "multipart/related; boundary=" + boundary },
    body: payload,
  });
  const j = await up.json();
  if (!up.ok) return { error: "Drive " + up.status + ": " + JSON.stringify(j).slice(0, 200) };

  const { data: row, error } = await db.from("email_attachments").upsert({
    gmail_message_id: msgId, gmail_attachment_id: att.attachmentId, filename: att.filename,
    mime_type: att.mimeType, size_bytes: att.size, sha256: hash, kind: "document",
    drive_file_id: j.id, drive_url: j.webViewLink, archived_at: new Date().toISOString(),
  }, { onConflict: "gmail_message_id,gmail_attachment_id" }).select("id").maybeSingle();
  if (error) return { error: error.message };
  return { id: row?.id, drive_url: j.webViewLink, bytes };
}

// ---------------------------------------------------------------- actions
async function scan(body: any, user: { email: string }) {
  const days = Number(body.days ?? 30);
  const after = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10).replace(/-/g, "/");
  const cap = Number(body.max_messages ?? 15);
  const token = await accessToken();

  const q = "from:" + DEBI + " has:attachment after:" + after;
  const listed = await gmail(token, "/messages?q=" + encodeURIComponent(q) + "&maxResults=" + cap);

  const results: any[] = [];
  let created = 0;
  for (const ref of listed.messages ?? []) {
    const msg = await gmail(token, "/messages/" + ref.id + "?format=full");
    const subject = header(msg, "Subject");
    const docs = allAttachments(msg.payload).filter((a: any) => DOC_EXT.test(a.filename || ""));
    if (!docs.length) continue;

    // Already queued? Then this message is done; do not spend a model call.
    const { data: existing } = await db.from("doc_revisions")
      .select("id").eq("source_message_id", msg.id).limit(1);
    if (existing?.length) { results.push({ id: ref.id, subject, skipped: "already queued" }); continue; }

    const text = bodyText(msg.payload);
    const ex = await extractInstructions(subject, text, docs.map((d: any) => d.filename));
    const instructions = (ex as any).data?.instructions ?? [];

    for (const att of docs) {
      const arch = await archive(token, msg.id, att);
      if ((arch as any).error) { results.push({ id: ref.id, filename: att.filename, error: (arch as any).error }); continue; }

      let tracked = 0;
      if (kindOf(att.filename) === "docx" && (arch as any).bytes) {
        try {
          const { docXml } = await readDocx((arch as any).bytes);
          const t = parseTracked(docXml);
          tracked = t.insertions + t.deletions;
        } catch { tracked = 0; }   // an unreadable docx is still worth queueing
      }

      const { data: row, error } = await db.from("doc_revisions").insert({
        source_message_id: msg.id,
        attachment_id: (arch as any).id ?? null,
        filename: att.filename,
        file_kind: kindOf(att.filename),
        original_drive_id: null,
        // Every instruction lands needs_human: nothing here has applied one.
        instructions: instructions.map((i: any) => ({
          quote: String(i.quote ?? "").slice(0, 200),
          what: String(i.what ?? "").slice(0, 200),
          target: i.target ?? null,
          kind: i.kind ?? "other",
          state: "needs_human",
        })),
        tracked_change_count: tracked,
      }).select("id").maybeSingle();
      if (error) { results.push({ id: ref.id, filename: att.filename, error: error.message }); continue; }
      created++;
      results.push({ id: row?.id, filename: att.filename, subject, instructions: instructions.length, tracked_changes: tracked });
    }
  }

  await audit("doc_scan", user.email, { days, created });
  return json({ ok: true, window_after: after, queued: created, detail: results });
}

async function list() {
  const { data, error } = await db.from("doc_revisions")
    .select("*").neq("status", "dismissed").order("created_at", { ascending: false });
  if (error) return json({ error: error.message }, 400);
  const ids = (data ?? []).map((r: any) => r.attachment_id).filter(Boolean);
  const { data: atts } = ids.length
    ? await db.from("email_attachments").select("id, drive_url, size_bytes").in("id", ids)
    : { data: [] as any[] };
  const byId = new Map((atts ?? []).map((a: any) => [a.id, a]));
  const rows = (data ?? []).map((r: any) => ({ ...r, attachment: byId.get(r.attachment_id) ?? null }));
  return json({
    rows,
    counts: {
      pending: rows.filter((r: any) => r.status === "pending").length,
      needs_human: rows.reduce((n: number, r: any) =>
        n + (r.instructions ?? []).filter((i: any) => i.state === "needs_human").length, 0),
      tracked: rows.reduce((n: number, r: any) => n + (r.tracked_change_count ?? 0), 0),
    },
  });
}

// The side-by-side: her original against the text with her changes applied.
async function diff(body: any) {
  const id = Number(body.id);
  const { data: rev } = await db.from("doc_revisions").select("*").eq("id", id).maybeSingle();
  if (!rev) return json({ error: "No document with id " + id + "." }, 404);
  if (rev.file_kind !== "docx") {
    return json({
      error: "Only .docx carries tracked changes that can be read. A " + rev.file_kind
           + " has to be opened in its own application; the instructions from the email are listed instead.",
    }, 422);
  }
  const { data: att } = await db.from("email_attachments").select("*").eq("id", rev.attachment_id).maybeSingle();
  if (!att) return json({ error: "The archived file for this document is missing." }, 404);

  const token = await accessToken();
  const a = await gmail(token, "/messages/" + rev.source_message_id + "/attachments/" + att.gmail_attachment_id);
  if (!a?.data) return json({ error: "The attachment could not be re-read from Gmail." }, 502);

  const { docXml, commentsXml } = await readDocx(b64dec(a.data));
  const t = parseTracked(docXml);
  return json({
    filename: rev.filename,
    insertions: t.insertions,
    deletions: t.deletions,
    comments: parseComments(commentsXml),
    paragraphs: t.paras.slice(0, 400),
    original: t.original.slice(0, 60000),
    revised: t.revised.slice(0, 60000),
  });
}

async function instructionsSave(body: any, user: { email: string }) {
  const id = Number(body.id);
  if (!Array.isArray(body.instructions)) return json({ error: "instructions must be a list." }, 400);
  const clean = body.instructions.map((i: any) => ({
    quote: String(i.quote ?? "").slice(0, 200),
    what: String(i.what ?? "").slice(0, 200),
    target: i.target ?? null,
    kind: i.kind ?? "other",
    state: ["needs_human", "done", "skipped"].includes(i.state) ? i.state : "needs_human",
  }));
  const { data, error } = await db.from("doc_revisions")
    .update({ instructions: clean, updated_at: new Date().toISOString() })
    .eq("id", id).select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ error: "No document with id " + id + "." }, 404);
  await audit("doc_instructions_saved", user.email, { id });
  return json({ ok: true, row: data });
}

async function mark(body: any, user: { email: string }) {
  const id = Number(body.id);
  const status = body.status;
  if (!["pending", "revised", "returned", "dismissed"].includes(status)) {
    return json({ error: "status must be pending, revised, returned or dismissed." }, 400);
  }
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === "returned") patch.returned_at = new Date().toISOString();
  const { data, error } = await db.from("doc_revisions").update(patch).eq("id", id).select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ error: "No document with id " + id + "." }, 404);
  await audit("doc_marked_" + status, user.email, { id });
  return json({ ok: true, row: data });
}

// ---------------------------------------------------------------- entry
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* empty */ }

  const user = await requireUser(req);
  if (!user) return json({ error: "Not signed in." }, 401);

  try {
    switch (body.action) {
      case "list":              return await list();
      case "scan":              return await scan(body, user);
      case "diff":              return await diff(body);
      case "instructions_save": return await instructionsSave(body, user);
      case "mark":              return await mark(body, user);
      default:
        return json({ error: "Unknown action: " + String(body.action ?? "(none)"), valid_actions: ACTIONS }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
