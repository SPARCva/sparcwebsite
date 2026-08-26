// asks — answer drafts for Debi's asks, and chase drafts for the people
// behind them.
//
// Both live here rather than in two functions because they share the same
// plumbing: session auth, the Gmail token, the thread fetch, and the Anthropic
// call. The two feature sets are separated by action prefix, not by deployment.
//
// THE VERIFICATION GATE IS THE POINT OF THIS FUNCTION.
//
// Debi's 24 August memo lists five factual errors in a report Erica sent: named
// institutions with no attributable individual, a conversion figure with no
// derivation, an anonymous donor described as if identified. Every one is the
// same failure — prose that reads as sourced but is not.
//
// So the generator is required to grade its own output and hand back what it
// could not stand behind:
//   unsourced_claim        a fact stated that the thread does not support
//   missing_interpretation numbers given with no reading of what they mean
//   filler                 words that add length and no information
//   repeat_ask             Debi has asked this before and is asking again
//
// Where a fact cannot be sourced the draft writes a [bracketed placeholder]
// and flags it. It never invents a name, figure, institution or date. A draft
// that arrives with no flags and no placeholders is not automatically good —
// it is just a draft that believes itself.
//
// Nothing here sends mail to Debi. Answers assemble into a Gmail DRAFT, in her
// original numbering, for Erica to read and send herself. Follow-ups do send,
// one at a time, each on its own approval — there is no bulk send anywhere.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-4-6";
const PROMPT_VERSION = "asks/2026-08-26";
const DEBI = "debi@sparcsolutions.org";
const ERICA = "erica@sparcsolutions.org";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const ACTIONS = [
  "list", "generate", "save", "approve", "unstage", "dismiss", "create_draft",
  "followups", "followup_generate", "followup_save", "followup_send", "followup_dismiss", "followup_answered",
];
const FLAGS = ["unsourced_claim", "missing_interpretation", "filler", "repeat_ask"];

// ---------------------------------------------------------------- auth
// Copied verbatim from constituent-notes, as in `tasks`, so there is exactly
// one session contract across the dashboard.
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
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
async function gmail(token: string, path: string, init?: RequestInit) {
  const res = await fetch(GMAIL + path, {
    ...init,
    headers: { Authorization: "Bearer " + token, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error("Gmail " + res.status + ": " + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}

const b64dec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64str = (s: string) => { try { return new TextDecoder().decode(b64dec(s)); } catch { return ""; } };
// Gmail wants base64url, and the subject may carry non-ASCII, so encode UTF-8
// bytes rather than char codes.
function b64url(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
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

const FOOTER = /^(purchase tickets|please enjoy|well being notice|1775 tysons|fifth floor|tysons, va|www\.|https?:\/\/|check out our podcast|support sparc|3 ways you can|debi alexander|kat rader|chief executive|program director|sparc$|--\s*$)/i;
function excerpt(body: string, max = 4000) {
  return body.split(/\n/)
    .map((l) => l.replace(/^\s*>+\s*/, "").trimEnd())
    .filter((l) => !FOOTER.test(l.trim()))
    .filter((l) => !/^On .*wrote:$/i.test(l.trim()))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

// The whole thread, oldest first, so the generator can see what was already
// said rather than answering the last message in isolation.
async function threadText(token: string, threadId: string | null, cap = 9000) {
  if (!threadId) return "";
  try {
    const t = await gmail(token, "/threads/" + threadId + "?format=full");
    const parts = (t.messages ?? []).map((m: any) => {
      const from = header(m, "From");
      const date = header(m, "Date");
      return "--- " + from + " (" + date + ") ---\n" + excerpt(bodyText(m.payload), 3000);
    });
    return parts.join("\n\n").slice(0, cap);
  } catch {
    return "";   // a thread we cannot read is missing context, not a failure
  }
}

// ---------------------------------------------------------------- model
async function claude(system: string, user: string, maxTokens = 1600) {
  if (!ANTHROPIC_KEY) return { error: "ANTHROPIC_API_KEY is not set." };
  const call = async () => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    const j = await res.json();
    if (!res.ok) return { error: "Anthropic " + res.status + ": " + JSON.stringify(j).slice(0, 300) };
    const raw = (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try { return { data: JSON.parse(cleaned) }; }
    catch { return { parseFail: cleaned.slice(0, 300), truncated: j.stop_reason === "max_tokens" }; }
  };
  const first = await call();
  if (!(first as any).parseFail) return first;
  // A response cut off at max_tokens will be cut off again on an identical
  // retry, so do not spend a second call proving it.
  if ((first as any).truncated) return { error: "Model response hit max_tokens and was truncated." };
  const second = await call();
  if ((second as any).parseFail) return { error: "Model did not return JSON." };
  return second;
}

const ANSWER_SYSTEM = [
  "You draft replies for Erica Gaffney, Director of Development & Communications at SPARC, a Virginia nonprofit, answering her CEO Debi Alexander.",
  "",
  "You are given one thing Debi asked for, the email thread it came from, and SPARC's house writing rules.",
  "Draft Erica's answer to that one ask. Nothing else.",
  "",
  "THE ABSOLUTE RULE:",
  "Every fact in the draft must be visible in the thread you were given. If a fact is not there — a name, a number, an institution, a date, a status — you MUST write a bracketed placeholder such as [number of registrants] or [date sent] and add the flag unsourced_claim. NEVER invent, estimate, infer or round a fact to make the sentence read better. An answer with honest gaps is useful; an answer with invented specifics is worse than no answer, because it will be sent to a CEO who will act on it.",
  "",
  "Grade your own draft and return every flag that applies:",
  "  unsourced_claim         you stated something the thread does not support, or had to leave a placeholder",
  "  missing_interpretation  you gave numbers without saying what they mean or what should follow",
  "  filler                  you wrote words that add length but no information",
  "  repeat_ask              the thread shows Debi asking this more than once",
  "",
  "Voice: warm, dignified, professional, restrained. Plain and calm. No exclamation marks. No product-speak. Answer the question first, then give the detail. Do not thank her for asking. Do not pad.",
  "Do not write a salutation or a signature block — the answers are assembled into one email later, under her own numbering.",
  "",
  "Return ONLY minified JSON, no markdown fence:",
  '{"draft":"","flags":[],"placeholders":[],"notes":""}',
  "",
  "placeholders lists each bracketed gap you left, so a human can fill it. notes is one short line to Erica about anything she should check before sending.",
].join("\n");

const FOLLOWUP_SYSTEM = [
  "You draft short chase emails for Erica Gaffney, Director of Development & Communications at SPARC, a Virginia nonprofit.",
  "",
  "You are given a task Debi assigned to Erica and the thread it came from. Decide whether the task asks Erica to follow up with a NAMED person outside this exchange.",
  "",
  "If it does not name a specific person to contact, return {\"is_followup\":false} and nothing else. Do not invent a recipient.",
  "",
  "If it does, draft the chase. Rules:",
  "- Every fact must come from the thread. Anything you cannot source becomes a [bracketed placeholder]. NEVER invent a name, figure, organisation or date.",
  "- Only give target_email if the address appears in the thread. Otherwise leave it null — a wrong address sends SPARC's business to a stranger.",
  "- Short. Three or four sentences. Say what is needed and by when if a date was given.",
  "- Warm and professional, never apologetic and never demanding.",
  "- SPARC house voice: plain and calm. NO exclamation marks anywhere. No effusive thanks, no 'so much', no product-speak.",
  "- Sign off as Erica Gaffney, Director of Development & Communications, SPARC.",
  "",
  "If the tone requested is 'firmer', keep the courtesy but make the ask unmistakable and name the consequence of continued silence where the thread supports one. Do not become rude, and do not invent a deadline that was never set.",
  "",
  "Return ONLY minified JSON, no markdown fence:",
  '{"is_followup":true,"target_name":"","target_email":null,"subject":"","draft":"","placeholders":[],"notes":""}',
].join("\n");

// ---------------------------------------------------------------- helpers
async function getTask(id: number) {
  const { data } = await db.from("tasks").select("*").eq("id", id).maybeSingle();
  return data;
}
async function activeRules() {
  const { data } = await db.from("letter_rules").select("rule, applies_to").eq("active", true).order("id");
  return (data ?? []).map((r: any) => "- (" + r.applies_to + ") " + r.rule).join("\n");
}
// Debi's numbering is the order she expects answers in, and it is numeric:
// "11" sorts after "2", not between "1" and "3".
const byNumber = (a: any, b: any) => {
  const t = new Date(a.requested_at ?? 0).getTime() - new Date(b.requested_at ?? 0).getTime();
  if (t) return t;
  const ai = a.list_index != null ? Number(a.list_index) : NaN;
  const bi = b.list_index != null ? Number(b.list_index) : NaN;
  if (!isNaN(ai) && !isNaN(bi)) return ai - bi;
  if (!isNaN(ai)) return -1;
  if (!isNaN(bi)) return 1;
  return (a.id ?? 0) - (b.id ?? 0);
};

// ---------------------------------------------------------------- asks
async function list() {
  const { data: answers, error } = await db.from("ask_answers")
    .select("*").neq("status", "dismissed").order("created_at", { ascending: false });
  if (error) return json({ error: error.message }, 400);

  const ids = [...new Set((answers ?? []).map((a: any) => a.task_id).filter(Boolean))];
  const { data: tasks } = ids.length
    ? await db.from("tasks").select("*").in("id", ids)
    : { data: [] as any[] };
  const byId = new Map((tasks ?? []).map((t: any) => [t.id, t]));

  const rows = (answers ?? []).map((a: any) => ({ ...a, task: byId.get(a.task_id) ?? null }))
    .sort((x: any, y: any) => byNumber(x.task ?? {}, y.task ?? {}));

  // Open tasks with no answer yet — what Erica can still generate.
  const { data: open } = await db.from("tasks")
    .select("id, title, list_index, requested_at, ask_count, source_quote, due_at")
    .eq("status", "open").order("requested_at", { ascending: true });
  const answered = new Set((answers ?? []).map((a: any) => a.task_id));
  const allPending = (open ?? []).filter((t: any) => !answered.has(t.id)).sort(byNumber);
  // The backfill left several hundred open asks, and every one is a candidate.
  // Send the oldest slice rather than the whole backlog on every panel load;
  // the count tells the UI how much is behind it.
  const pending = allPending.slice(0, 100);

  return json({
    answers: rows,
    pending,
    pending_total: allPending.length,
    counts: {
      draft:   rows.filter((r: any) => r.status === "draft").length,
      staged:  rows.filter((r: any) => r.status === "staged").length,
      flagged: rows.filter((r: any) => (r.flags ?? []).length > 0).length,
      pending: allPending.length,
    },
  });
}

async function generate(body: any, user: { email: string }) {
  const taskId = Number(body.task_id);
  if (!taskId) return json({ error: "Which task? task_id is required." }, 400);
  const task = await getTask(taskId);
  if (!task) return json({ error: "No task with id " + taskId + "." }, 404);

  // A manual task has no email behind it, so there is nothing to source an
  // answer from and nothing for the verification gate to check against.
  if (task.source === "manual" || !task.source_thread_id) {
    return json({
      error: "This task was added by hand, so there is no email thread to draft an answer from. "
           + "Answering it here would mean inventing the facts.",
    }, 422);
  }

  const token = await accessToken();
  const thread = await threadText(token, task.source_thread_id);
  if (!thread) {
    // No thread means no sources. Say so rather than letting the model fill the
    // gap from its own head.
    return json({
      error: "The Gmail thread for this task could not be read, so there is nothing to source an answer from. "
           + "Open the thread in Gmail and answer it there.",
    }, 422);
  }

  const rules = await activeRules();
  const user_msg = [
    "DEBI'S ASK" + (task.list_index ? " (her item " + task.list_index + ")" : "") + ":",
    task.title,
    task.detail ? "Detail: " + task.detail : "",
    task.source_quote ? "Her words: \"" + task.source_quote + "\"" : "",
    task.ask_count > 1 ? "She has asked this " + task.ask_count + " times." : "",
    task.due_at ? "Due: " + task.due_at : "",
    "",
    "THREAD (oldest first):",
    thread,
    "",
    "SPARC HOUSE RULES:",
    rules || "(none on file)",
  ].filter(Boolean).join("\n");

  const out = await claude(ANSWER_SYSTEM, user_msg);
  if ((out as any).error) return json({ error: (out as any).error }, 502);
  const d = (out as any).data ?? {};
  const draft = String(d.draft ?? "").trim();
  if (!draft) return json({ error: "The model returned an empty draft." }, 502);

  const flags = Array.isArray(d.flags) ? d.flags.filter((f: any) => FLAGS.includes(f)) : [];
  // A placeholder left in the text is an unsourced claim whether or not the
  // model remembered to flag it. Trust the text over the self-report.
  const placeholders = Array.isArray(d.placeholders) ? d.placeholders.map(String) : [];
  if ((placeholders.length || /\[[^\]]{3,}\]/.test(draft)) && !flags.includes("unsourced_claim")) {
    flags.push("unsourced_claim");
  }
  if (task.ask_count > 1 && !flags.includes("repeat_ask")) flags.push("repeat_ask");

  // One live answer per task: regenerating replaces rather than stacks.
  await db.from("ask_answers").delete().eq("task_id", taskId).in("status", ["draft", "staged"]);
  const { data: row, error } = await db.from("ask_answers").insert({
    task_id: taskId, ai_draft: draft, flags,
    model: MODEL, prompt_version: PROMPT_VERSION,
  }).select().maybeSingle();
  if (error) return json({ error: error.message }, 400);

  await audit("ask_answer_generated", user.email, { task_id: taskId, answer_id: row?.id, flags });
  return json({ ok: true, answer: { ...row, task }, placeholders, notes: d.notes ?? null });
}

async function save(body: any, user: { email: string }) {
  const id = Number(body.id);
  if (!id) return json({ error: "Which answer? id is required." }, 400);
  const text = String(body.edited_draft ?? "").trim();
  if (!text) return json({ error: "The answer is empty." }, 400);
  const { data, error } = await db.from("ask_answers")
    .update({ edited_draft: text, updated_at: new Date().toISOString() })
    .eq("id", id).select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ error: "No answer with id " + id + "." }, 404);
  await audit("ask_answer_edited", user.email, { id });
  return json({ ok: true, answer: data });
}

async function approve(body: any, user: { email: string }) {
  const id = Number(body.id);
  if (!id) return json({ error: "Which answer? id is required." }, 400);
  const { data, error } = await db.from("ask_answers")
    .update({ status: "staged", staged_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id).eq("status", "draft").select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ error: "That answer is not a draft any more." }, 409);
  await audit("ask_answer_staged", user.email, { id, task_id: data.task_id });
  return json({ ok: true, answer: data });
}

async function unstage(body: any, user: { email: string }) {
  const id = Number(body.id);
  const { data, error } = await db.from("ask_answers")
    .update({ status: "draft", staged_at: null, updated_at: new Date().toISOString() })
    .eq("id", id).eq("status", "staged").select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ error: "That answer is not staged." }, 409);
  await audit("ask_answer_unstaged", user.email, { id });
  return json({ ok: true, answer: data });
}

async function dismiss(body: any, user: { email: string }) {
  const id = Number(body.id);
  const { data, error } = await db.from("ask_answers")
    .update({ status: "dismissed", updated_at: new Date().toISOString() })
    .eq("id", id).select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ error: "No answer with id " + id + "." }, 404);
  await audit("ask_answer_dismissed", user.email, { id });
  return json({ ok: true });
}

// Assemble every staged answer into ONE Gmail draft to Debi, in her original
// numbering. A DRAFT — this never sends. Erica reads it and sends it herself.
async function createDraft(user: { email: string }) {
  const { data: staged } = await db.from("ask_answers").select("*").eq("status", "staged");
  if (!staged?.length) return json({ error: "Nothing is staged yet. Approve an answer first." }, 400);

  const ids = staged.map((a: any) => a.task_id).filter(Boolean);
  const { data: tasks } = await db.from("tasks").select("*").in("id", ids);
  const byId = new Map((tasks ?? []).map((t: any) => [t.id, t]));

  const items = staged
    .map((a: any) => ({ answer: a, task: byId.get(a.task_id) ?? {} }))
    .sort((x: any, y: any) => byNumber(x.task, y.task));

  const blocks = items.map(({ answer, task }: any) => {
    const n = task.list_index ? task.list_index + ". " : "";
    const body = (answer.edited_draft ?? answer.ai_draft ?? "").trim();
    return n + (task.title ?? "(untitled)") + "\n\n" + body;
  });

  const body = ["Hi Debi,", "", "Answers below, in your numbering.", "", blocks.join("\n\n\n"), "",
                "Erica Gaffney", "Director of Development & Communications", "SPARC"].join("\n");

  const subject = "Answers to your asks — " +
    new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });

  const mime = [
    "To: " + DEBI,
    "From: " + ERICA,
    "Subject: " + subject,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "", body,
  ].join("\r\n");

  const token = await accessToken();
  const draft = await gmail(token, "/drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw: b64url(mime) } }),
  });

  const draftId = draft?.id ?? null;
  await db.from("ask_answers")
    .update({ gmail_draft_id: draftId, updated_at: new Date().toISOString() })
    .in("id", staged.map((a: any) => a.id));
  await audit("ask_draft_created", user.email, { gmail_draft_id: draftId, answers: staged.length });

  return json({
    ok: true, gmail_draft_id: draftId, answers: staged.length,
    // Deliberately a draft: it is in Gmail, unsent, for Erica to review.
    gmail_url: "https://mail.google.com/mail/u/0/#drafts",
    note: "Draft created in Gmail. Nothing has been sent.",
  });
}

// ---------------------------------------------------------------- follow ups
async function followups() {
  const { data: rows, error } = await db.from("follow_ups")
    .select("*").neq("status", "dismissed").order("created_at", { ascending: false });
  if (error) return json({ error: error.message }, 400);
  const ids = [...new Set((rows ?? []).map((r: any) => r.task_id).filter(Boolean))];
  const { data: tasks } = ids.length ? await db.from("tasks").select("*").in("id", ids) : { data: [] as any[] };
  const byId = new Map((tasks ?? []).map((t: any) => [t.id, t]));
  const now = Date.now();
  return json({
    rows: (rows ?? []).map((r: any) => {
      const t = byId.get(r.task_id) ?? null;
      return {
        ...r, task: t,
        days_open: t ? Math.floor((now - new Date(t.first_asked_at ?? t.requested_at).getTime()) / 86400000) : null,
      };
    }),
  });
}

async function followupGenerate(body: any, user: { email: string }) {
  const taskId = Number(body.task_id);
  if (!taskId) return json({ error: "Which task? task_id is required." }, 400);
  const task = await getTask(taskId);
  if (!task) return json({ error: "No task with id " + taskId + "." }, 404);
  const tone = body.tone === "firmer" ? "firmer" : "normal";

  const token = await accessToken();
  const thread = await threadText(token, task.source_thread_id);

  const { data: prior } = await db.from("follow_ups")
    .select("attempt_no").eq("task_id", taskId).order("attempt_no", { ascending: false }).limit(1).maybeSingle();
  const attempt = (prior?.attempt_no ?? 0) + 1;

  const user_msg = [
    "TASK: " + task.title,
    task.detail ? "Detail: " + task.detail : "",
    task.source_quote ? "Debi's words: \"" + task.source_quote + "\"" : "",
    "Tone requested: " + tone,
    attempt > 1 ? "This is chase attempt number " + attempt + "." : "",
    "",
    "THREAD (oldest first):",
    thread || "(the thread could not be read)",
  ].filter(Boolean).join("\n");

  const out = await claude(FOLLOWUP_SYSTEM, user_msg, 1200);
  if ((out as any).error) return json({ error: (out as any).error }, 502);
  const d = (out as any).data ?? {};

  if (!d.is_followup) {
    return json({ ok: true, is_followup: false, reason: d.notes ?? "This task does not name someone to follow up with." });
  }
  const draft = String(d.draft ?? "").trim();
  if (!draft) return json({ error: "The model returned an empty draft." }, 502);

  await db.from("follow_ups").delete().eq("task_id", taskId).eq("status", "draft");
  const { data: row, error } = await db.from("follow_ups").insert({
    task_id: taskId,
    target_name: d.target_name ? String(d.target_name).slice(0, 200) : null,
    // Only an address the thread actually contained. A guessed address sends
    // SPARC's business to a stranger.
    target_email: typeof d.target_email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.target_email)
      ? d.target_email.toLowerCase() : null,
    subject: d.subject ? String(d.subject).slice(0, 300) : ("Following up — " + task.title).slice(0, 300),
    ai_draft: draft, attempt_no: attempt, tone,
  }).select().maybeSingle();
  if (error) return json({ error: error.message }, 400);

  await audit("followup_generated", user.email, { task_id: taskId, id: row?.id, attempt, tone });
  return json({ ok: true, is_followup: true, row: { ...row, task }, placeholders: d.placeholders ?? [], notes: d.notes ?? null });
}

async function followupSave(body: any, user: { email: string }) {
  const id = Number(body.id);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.edited_draft === "string") patch.edited_draft = body.edited_draft.trim();
  if (typeof body.subject === "string" && body.subject.trim()) patch.subject = body.subject.trim().slice(0, 300);
  if (typeof body.target_email === "string") {
    const e = body.target_email.trim().toLowerCase();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return json({ error: "That is not a valid email address." }, 400);
    patch.target_email = e || null;
  }
  const { data, error } = await db.from("follow_ups").update(patch).eq("id", id).select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ error: "No follow up with id " + id + "." }, 404);
  await audit("followup_edited", user.email, { id });
  return json({ ok: true, row: data });
}

// Sends one follow-up, on its own approval. There is no bulk send.
async function followupSend(body: any, user: { email: string }) {
  const id = Number(body.id);
  const { data: row } = await db.from("follow_ups").select("*").eq("id", id).maybeSingle();
  if (!row) return json({ error: "No follow up with id " + id + "." }, 404);
  if (row.status !== "draft") return json({ error: "That follow up has already been sent." }, 409);

  const to = row.target_email;
  if (!to) return json({ error: "No recipient address. Add one before sending — nothing is guessed here." }, 422);

  const text = (row.edited_draft ?? row.ai_draft ?? "").trim();
  if (!text) return json({ error: "The follow up is empty." }, 400);
  // A placeholder left in means a human has not filled a gap the model could
  // not source. Sending it would put "[date]" in front of a donor.
  const gap = text.match(/\[[^\]]{3,}\]/);
  if (gap) return json({ error: "This still has a placeholder in it: " + gap[0] + ". Fill it in before sending." }, 422);

  const mime = [
    "To: " + to,
    "From: " + ERICA,
    "Subject: " + (row.subject ?? "Following up"),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "", text,
  ].join("\r\n");

  const token = await accessToken();
  const sent = await gmail(token, "/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw: b64url(mime) }),
  });

  const { data: updated } = await db.from("follow_ups").update({
    status: "sent", last_attempt_at: new Date().toISOString(),
    thread_id: sent?.threadId ?? null, updated_at: new Date().toISOString(),
  }).eq("id", id).select().maybeSingle();

  await audit("followup_sent", user.email, { id, to, attempt: row.attempt_no, thread_id: sent?.threadId ?? null });
  return json({ ok: true, row: updated, sent_to: to });
}

async function followupMark(body: any, user: { email: string }, status: "answered" | "dismissed") {
  const id = Number(body.id);
  const { data, error } = await db.from("follow_ups")
    .update({ status, updated_at: new Date().toISOString() }).eq("id", id).select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ error: "No follow up with id " + id + "." }, 404);
  await audit("followup_" + status, user.email, { id });
  return json({ ok: true });
}

// ---------------------------------------------------------------- entry
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* empty body */ }

  const user = await requireUser(req);
  if (!user) return json({ error: "Not signed in." }, 401);

  try {
    switch (body.action) {
      case "list":               return await list();
      case "generate":           return await generate(body, user);
      case "save":               return await save(body, user);
      case "approve":            return await approve(body, user);
      case "unstage":            return await unstage(body, user);
      case "dismiss":            return await dismiss(body, user);
      case "create_draft":       return await createDraft(user);

      case "followups":          return await followups();
      case "followup_generate":  return await followupGenerate(body, user);
      case "followup_save":      return await followupSave(body, user);
      case "followup_send":      return await followupSend(body, user);
      case "followup_answered":  return await followupMark(body, user, "answered");
      case "followup_dismiss":   return await followupMark(body, user, "dismissed");

      default:
        return json({ error: "Unknown action: " + String(body.action ?? "(none)"), valid_actions: ACTIONS }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
