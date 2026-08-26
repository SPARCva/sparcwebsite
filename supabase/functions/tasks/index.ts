// tasks — the Today list: what Debi has asked Erica for, and what is done.
//
// Debi numbers her asks and expects each one answered separately, so a numbered
// list is one row per number, carrying her number in list_index. She also
// re-asks; a second ask is the same task asked twice, not a new task, so
// repeat detection increments ask_count instead of inserting a duplicate.
//
// EXTRACTION IS A MODEL CALL AND ONLY A MODEL CALL. If the model does not
// return parseable JSON, the message is recorded on the run and skipped. There
// is deliberately no regex fallback: the pre-2026-08-15 pipeline had one, and
// it read email signatures as donor names and the largest number in the body as
// an amount. That is what donations_quarantine holds — 210 rows of it.
//
// RESOURCE BUDGET, learned by daily-sweep the hard way: 53 sequential Anthropic
// calls in one invocation hit WORKER_RESOURCE_LIMIT after staging 15 rows. So
// every extraction is capped per invocation, the dedupe check happens BEFORE
// the model call, and the caller is told how much is left. A month-long
// backfill is therefore many cheap resumable passes, not one that dies at 80%.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-4-6";
const EXTRACTOR = MODEL + "/2026-08-25";
const DEBI = "debi@sparcsolutions.org";
const ERICA = "erica@sparcsolutions.org";
const ZONE = "America/New_York";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const ACTIONS = ["list", "check", "delete", "add", "update", "completed", "export", "scan", "backfill"];

// ---------------------------------------------------------------- auth
// Copied verbatim from constituent-notes so there is exactly one session
// contract across the dashboard.
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
// The tasks jobs authenticate as the system:tasks-cron service account, so a
// scheduled scan is attributed to the job in audit_log and not to Erica.
const audit = (action: string, by: string, changes: unknown) =>
  db.from("audit_log").insert({ action, performed_by: by, changes: changes as any });

// ---------------------------------------------------------------- dates
// Everything the user sees is in Erica's day, not UTC. A task ticked at 20:30
// UTC on the 25th was ticked at 16:30 on the 25th in Tysons; one ticked at
// 02:00 UTC on the 26th was ticked at 22:00 on the 25th. Both are "today".
const dayIn = (d: Date, zone = ZONE) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const today = () => dayIn(new Date());

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

// Debi's signature and the quoted chain below her reply are not her ask.
const FOOTER = /^(purchase tickets|please enjoy|well being notice|1775 tysons|fifth floor|tysons, va|www\.|https?:\/\/|check out our podcast|support sparc|3 ways you can|debi alexander|kat rader|chief executive|program director|sparc$|--\s*$)/i;
function excerpt(body: string, max = 6000) {
  return body.split(/\n/)
    .map((l) => l.replace(/^\s*>+\s*/, "").trimEnd())
    .filter((l) => !FOOTER.test(l.trim()))
    .filter((l) => !/^On .*wrote:$/i.test(l.trim()))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

// ---------------------------------------------------------------- extraction
// Lowercase, strip punctuation, collapse whitespace. Feeds both the dedupe hash
// and the trigram comparison, so both agree on what a title "is".
const normalize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const SYSTEM_PROMPT = [
  "You are reading one email in the mailbox of Erica Gaffney, Director of Development & Communications at SPARC, a Virginia nonprofit.",
  "Debi Alexander is SPARC's Chief Executive Officer and Erica's boss.",
  "",
  "Extract every discrete thing this email asks ERICA to do.",
  "",
  "Rules:",
  "1. A numbered list from Debi is ONE TASK PER NUMBER. Put her number in list_index as a string (\"1\", \"2\", \"11\"). She numbers her asks and expects each one answered separately. Never merge two numbered items into one task, and never split one number into two.",
  "2. title is imperative and under 90 characters.",
  "3. source_quote is her actual words, VERBATIM, maximum 200 characters. It is required. If you cannot quote the words that create the task, it is not a task.",
  "4. due_at is an ISO date (YYYY-MM-DD) ONLY when a date is stated or clearly implied — \"by COB tomorrow\", \"due 8/20\", \"end of next week\". Otherwise null. NEVER estimate or infer a date that is not there.",
  "5. These are NOT tasks: FYI forwards, calendar invitations, out-of-office replies, newsletters, messages where Debi is telling someone else (not Erica) to do something, and pure acknowledgements such as \"Thank you!\" or \"Wise choice\".",
  "6. A question directed at Erica that needs an answer IS a task.",
  "7. If nothing qualifies, return {\"tasks\":[]}.",
  "",
  "detail may carry the surrounding specifics — names, amounts, which folder, who to contact. Leave it empty rather than inventing context.",
  "",
  "Keep the whole response under 1500 tokens. If the email contains more than 20 asks, return the 20 most important and nothing else — a response cut off mid-JSON is unparseable and the whole message is then lost.",
  "",
  "Return ONLY minified JSON. No prose, no explanation, no markdown fence. Exactly this shape:",
  '{"tasks":[{"title":"","detail":"","list_index":"","due_at":null,"source_quote":""}]}',
].join("\n");

async function extract(subject: string, from: string, dateStr: string, text: string) {
  if (!ANTHROPIC_KEY) return { error: "ANTHROPIC_API_KEY is not set; extraction cannot run." };
  const call = async () => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2000, system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Subject: " + subject + "\nFrom: " + from + "\nDate: " + dateStr + "\n\n" + excerpt(text) }],
      }),
    });
    const j = await res.json();
    if (!res.ok) return { error: "Anthropic " + res.status + ": " + JSON.stringify(j).slice(0, 300) };
    const raw = (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
    // Strip a fence if the model added one anyway, then parse. A parse failure
    // is recorded and the message skipped — never guessed at.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try { return { data: JSON.parse(cleaned) }; }
    catch { return { parseFail: cleaned.slice(0, 300), truncated: j.stop_reason === "max_tokens" }; }
  };
  const first = await call();
  if (!(first as any).parseFail) return first;
  // A response cut off at max_tokens will be cut off again on an identical
  // retry, so do not spend a second call proving it.
  if ((first as any).truncated) {
    return { error: "Model response hit max_tokens and was truncated: " + (first as any).parseFail };
  }
  const second = await call();   // one retry; otherwise malformed JSON drops the email silently
  if ((second as any).parseFail) return { error: "Model did not return JSON: " + (second as any).parseFail };
  return second;
}

// ---------------------------------------------------------------- scanning
type Run = { seen: number; created: number; matched: number; skipped: number; errors: string[]; rows: any[] };

async function ingest(msg: any, run: Run, budget: { left: number }) {
  const subject = header(msg, "Subject");
  const fromRaw = header(msg, "From");
  const from = (fromRaw.match(/<(.+?)>/)?.[1] ?? fromRaw).toLowerCase();
  const receivedAt = isoDate(header(msg, "Date")) ?? new Date().toISOString();

  // Both checks happen BEFORE the model call, so re-running a window costs
  // nothing for mail already decided. The verdict table is the load-bearing
  // one: most of Debi's mail contains no task, and without a recorded negative
  // those messages are re-extracted on every pass and the scan never advances.
  const { data: judged } = await db.from("task_scan_messages")
    .select("message_id").eq("message_id", msg.id).maybeSingle();
  if (judged) { run.skipped++; return; }

  if (budget.left <= 0) return;             // resumable: caller re-invokes
  budget.left--;

  const seen = {
    message_id: msg.id, thread_id: msg.threadId ?? null,
    subject: subject.slice(0, 300), received_at: receivedAt, extractor: EXTRACTOR,
  };

  const text = bodyText(msg.payload);
  const out = await extract(subject, from, header(msg, "Date"), text);
  if ((out as any).error) {
    const why = String((out as any).error);
    run.errors.push(msg.id + ": " + why);
    // Record the failure too, or a message the model cannot parse burns two
    // calls out of every future budget forever. Deleting the row requeues it.
    await db.from("task_scan_messages").insert({ ...seen, tasks_found: -1, note: why.slice(0, 500) });
    return;
  }

  const parsed = (out as any).data;
  const list = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  if (!list.length) {
    run.skipped++;
    await db.from("task_scan_messages").insert({ ...seen, tasks_found: 0, note: "no task in this message" });
    return;
  }

  for (const t of list) {
    const title = String(t?.title ?? "").trim();
    const quote = String(t?.source_quote ?? "").trim();
    // Rule 3 is a hard gate, not a preference. No quote, no task.
    if (!title || !quote) continue;

    const norm = normalize(title);
    if (!norm) continue;
    const listIndex = t?.list_index != null && String(t.list_index).trim() !== "" ? String(t.list_index).trim() : null;
    const dedupe = await sha256(msg.id + "|" + (listIndex ?? "") + "|" + norm);

    // dedupe_key is checked FIRST, and that ordering is the whole point of it:
    // this exact ask, from this exact message, is already on file, so a
    // re-scan is a true no-op. Running repeat detection first instead made a
    // re-scan increment ask_count every pass — three backfill passes over the
    // same mail produced "Asked x6" on tasks Debi had asked for once.
    const { data: sameAsk } = await db.from("tasks")
      .select("id").eq("dedupe_key", dedupe).maybeSingle();
    if (sameAsk) { run.skipped++; continue; }

    // Repeat ask: same work, asked again in a DIFFERENT message. Increment
    // rather than insert, keep the earliest timestamp, and remember every
    // message that carried it.
    const { data: hit } = await db.rpc("match_open_task", { p_norm_title: norm });
    const prior = Array.isArray(hit) ? hit[0] : null;
    if (prior) {
      const msgs = [...new Set([...(prior.source_message_ids ?? []), msg.id])];
      // ask_count is derived from the messages, never incremented blind, so
      // the number on the amber tag always equals the messages behind it.
      const earliest = prior.first_asked_at ?? prior.requested_at;
      await db.from("tasks").update({
        ask_count: msgs.length,
        first_asked_at: earliest && new Date(earliest) < new Date(receivedAt) ? earliest : receivedAt,
        source_message_ids: msgs,
        updated_at: new Date().toISOString(),
      }).eq("id", prior.id);
      run.matched++;
      run.rows.push({ matched: prior.id, title, ask_count: msgs.length });
      continue;
    }

    const due = typeof t?.due_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.due_at) ? t.due_at : null;
    const { data: ins, error } = await db.from("tasks").insert({
      title: title.slice(0, 300),
      detail: t?.detail ? String(t.detail).slice(0, 2000) : null,
      source: "email",
      source_message_id: msg.id,
      source_thread_id: msg.threadId ?? null,
      source_message_ids: [msg.id],
      source_quote: quote.slice(0, 200),
      requested_by: from || DEBI,
      requested_at: receivedAt,
      first_asked_at: receivedAt,
      list_index: listIndex,
      due_at: due,
      norm_title: norm,
      dedupe_key: dedupe,
    }).select("id").maybeSingle();

    if (error) {
      if (error.code === "23505") { run.skipped++; continue; }   // re-scan is a no-op
      run.errors.push(msg.id + ": " + error.message);
      continue;
    }
    run.created++;
    run.rows.push({ id: ins?.id, title, list_index: listIndex, due_at: due, requested_at: receivedAt, quote: quote.slice(0, 200) });
  }

  // Judged, whatever came of it. Written after the loop so a crash mid-message
  // leaves the message unjudged and it is retried rather than half-recorded.
  await db.from("task_scan_messages").insert({ ...seen, tasks_found: list.length });
}

// Debi's mail to Erica, in Erica's mailbox. Anything Debi sent that landed here
// reached Erica as a recipient, a cc, or a forward, so from: alone covers all
// three; adding to:/cc: filters would drop the forwards.
function gmailQuery(fromDay: string, toDay: string) {
  const g = (d: string) => d.replace(/-/g, "/");
  // Gmail's before: is exclusive, so push it a day out to include toDay itself.
  const end = new Date(toDay + "T00:00:00Z"); end.setUTCDate(end.getUTCDate() + 1);
  return "from:" + DEBI + " after:" + g(fromDay) + " before:" + g(dayIn(end, "UTC"));
}

async function runScan(fromDay: string, toDay: string, maxExtractions: number, user: { email: string }) {
  const run: Run = { seen: 0, created: 0, matched: 0, skipped: 0, errors: [], rows: [] };
  const budget = { left: maxExtractions };
  const startedAt = new Date().toISOString();
  let fatal: string | null = null;

  try {
    const token = await accessToken();
    const q = gmailQuery(fromDay, toDay);
    let pageToken = "";
    do {
      const list = await gmail(token, "/messages?q=" + encodeURIComponent(q) + "&maxResults=100" + (pageToken ? "&pageToken=" + pageToken : ""));
      for (const ref of list.messages ?? []) {
        run.seen++;
        if (budget.left <= 0) continue;      // counted, not lost: a later pass picks it up
        const msg = await gmail(token, "/messages/" + ref.id + "?format=full");
        await ingest(msg, run, budget);
      }
      pageToken = list.nextPageToken ?? "";
    } while (pageToken && budget.left > 0);
  } catch (e) {
    fatal = (e as Error).message;
  }

  // Every run writes a row, success or failure, and a failure records why.
  // sync_accounts logged success while calling an action that did not exist and
  // did nothing for weeks; nothing here gets to fail quietly.
  const errText = fatal ?? (run.errors.length ? run.errors.slice(0, 20).join(" | ") : null);
  await db.from("task_scan_runs").insert({
    window_start: fromDay + "T00:00:00Z", window_end: toDay + "T23:59:59Z",
    messages_seen: run.seen, tasks_created: run.created, tasks_matched: run.matched, error: errText,
  });
  await audit("task_scan", user.email, { from: fromDay, to: toDay, created: run.created, matched: run.matched, failed: !!fatal });

  return json({
    ok: !fatal,
    window: { from: fromDay, to: toDay },
    started_at: startedAt,
    messages_seen: run.seen,
    tasks_created: run.created,
    duplicates_matched: run.matched,
    messages_skipped: run.skipped,
    extractions_left: budget.left,
    complete: budget.left > 0 && !fatal,
    error: fatal,
    extraction_errors: run.errors.slice(0, 20),
    tasks: run.rows,
  }, fatal ? 500 : 200);
}

// ---------------------------------------------------------------- actions
async function list() {
  // Open tasks, plus tasks ticked today that the 17:00 sweep has not archived
  // yet. Once the sweep sets completed_on the row drops off Today by itself.
  const { data: open, error } = await db.from("tasks")
    .select("*").eq("status", "open").order("requested_at", { ascending: true });
  if (error) return json({ error: error.message }, 400);
  const { data: done } = await db.from("tasks")
    .select("*").eq("status", "done").is("completed_on", null).order("checked_at", { ascending: true });

  const now = Date.now();
  const days = (t: any) => Math.floor((now - new Date(t.first_asked_at ?? t.requested_at).getTime()) / 86400000);

  // Every item of one numbered list shares the message's timestamp, so
  // requested_at alone leaves items 1..14 in arbitrary order. Debi's numbering
  // is the order she expects them answered in, and it is numeric: "11" sorts
  // after "2", not between "1" and "3".
  const byAsk = (a: any, b: any) => {
    const t = new Date(a.requested_at).getTime() - new Date(b.requested_at).getTime();
    if (t) return t;
    const ai = a.list_index != null ? Number(a.list_index) : NaN;
    const bi = b.list_index != null ? Number(b.list_index) : NaN;
    if (!isNaN(ai) && !isNaN(bi)) return ai - bi;
    if (!isNaN(ai)) return -1;
    if (!isNaN(bi)) return 1;
    return a.id - b.id;
  };
  const rows = [...(open ?? []).sort(byAsk), ...(done ?? []).sort(byAsk)]
    .map((t) => ({ ...t, days_open: days(t) }));

  const { data: lastRun } = await db.from("task_scan_runs")
    .select("ran_at, error").order("ran_at", { ascending: false }).limit(1).maybeSingle();

  return json({
    today: today(),
    last_scan_at: lastRun?.ran_at ?? null,
    last_scan_error: lastRun?.error ?? null,
    counts: {
      open: (open ?? []).length,
      done_today: (done ?? []).length,
      over_7_days: (open ?? []).filter((t: any) => days(t) > 7).length,
      asked_twice: (open ?? []).filter((t: any) => (t.ask_count ?? 1) > 1).length,
    },
    tasks: rows,
  });
}

async function check(body: any, user: { email: string }) {
  const id = Number(body.id);
  if (!id) return json({ error: "Which task? id is required." }, 400);
  const checked = body.checked !== false;
  const patch = checked
    ? { status: "done", checked_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    : { status: "open", checked_at: null, completed_on: null, updated_at: new Date().toISOString() };
  const { data, error } = await db.from("tasks").update(patch).eq("id", id).neq("status", "deleted").select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ error: "No open task with id " + id + "." }, 404);
  // Unchecking before 17:00 must also undo an archive, or the task shows as
  // both open and completed.
  if (!checked) await db.from("tasks_completed").delete().eq("task_id", id);
  await audit(checked ? "task_checked" : "task_unchecked", user.email, { id, title: data.title });
  return json({ ok: true, task: data });
}

async function softDelete(body: any, user: { email: string }) {
  const id = Number(body.id);
  if (!id) return json({ error: "Which task? id is required." }, 400);
  const { data, error } = await db.from("tasks")
    .update({ status: "deleted", deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id).select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ error: "No task with id " + id + "." }, 404);
  await audit("task_deleted", user.email, { id, title: data.title });
  return json({ ok: true });
}

async function add(body: any, user: { email: string }) {
  const title = String(body.title ?? "").trim();
  if (!title) return json({ error: "A task needs a title." }, 400);
  const now = new Date().toISOString();
  const norm = normalize(title);
  const { data, error } = await db.from("tasks").insert({
    title: title.slice(0, 300),
    detail: body.detail ? String(body.detail).slice(0, 2000) : null,
    due_at: /^\d{4}-\d{2}-\d{2}$/.test(String(body.due_at ?? "")) ? body.due_at : null,
    source: "manual", requested_by: user.email, requested_at: now, first_asked_at: now,
    norm_title: norm, dedupe_key: await sha256("manual|" + user.email + "|" + now + "|" + norm),
  }).select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  await audit("task_added", user.email, { id: data?.id, title });
  return json({ ok: true, task: data });
}

async function update(body: any, user: { email: string }) {
  const id = Number(body.id);
  if (!id) return json({ error: "Which task? id is required." }, 400);
  const fields = body.fields ?? {};
  // Whitelist. Nothing may reach status, checked_at, dedupe_key or the source
  // fields through here — the lifecycle owns those.
  const patch: Record<string, unknown> = {};
  if (typeof fields.title === "string" && fields.title.trim()) {
    patch.title = fields.title.trim().slice(0, 300);
    patch.norm_title = normalize(fields.title);
  }
  if ("detail" in fields) patch.detail = fields.detail ? String(fields.detail).slice(0, 2000) : null;
  if ("due_at" in fields) patch.due_at = /^\d{4}-\d{2}-\d{2}$/.test(String(fields.due_at ?? "")) ? fields.due_at : null;
  if (!Object.keys(patch).length) return json({ error: "Nothing to update. Allowed fields: title, detail, due_at." }, 400);
  patch.updated_at = new Date().toISOString();
  const { data, error } = await db.from("tasks").update(patch).eq("id", id).select().maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ error: "No task with id " + id + "." }, 404);
  await audit("task_updated", user.email, { id, fields: Object.keys(patch) });
  return json({ ok: true, task: data });
}

async function completed(body: any) {
  const from = String(body.from ?? "").slice(0, 10);
  const to = String(body.to ?? "").slice(0, 10);
  let q = db.from("tasks_completed").select("*").order("completed_on", { ascending: false }).order("archived_at", { ascending: false });
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) q = q.gte("completed_on", from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) q = q.lte("completed_on", to);
  const { data, error } = await q.limit(2000);
  if (error) return json({ error: error.message }, 400);
  return json({ rows: data ?? [] });
}

// Returns rows; the client builds the CSV, so the shape stays visible in the UI.
async function exportRows(body: any) {
  const scope = body.scope === "week" ? "week" : "day";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? "")) ? String(body.date) : today();
  let from = date;
  if (scope === "week") {
    const d = new Date(date + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - 6);
    from = dayIn(d, "UTC");
  }
  const { data, error } = await db.from("tasks_completed")
    .select("*").gte("completed_on", from).lte("completed_on", date)
    .order("completed_on", { ascending: false });
  if (error) return json({ error: error.message }, 400);
  return json({ scope, from, to: date, rows: data ?? [] });
}

async function sweepArchive(user: { email: string }) {
  const { data, error } = await db.rpc("archive_checked_tasks");
  if (error) return { error: error.message };
  const n = Array.isArray(data) ? (data[0]?.archived ?? 0) : (data ?? 0);
  await audit("task_archive_sweep", user.email, { archived: n });
  return { archived: n };
}

// ---------------------------------------------------------------- entry
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* cron sends no body */ }

  const user = await requireUser(req);
  if (!user) return json({ error: "Not signed in." }, 401);

  try {
    switch (body.action) {
      case "list":      return await list();
      case "check":     return await check(body, user);
      case "delete":    return await softDelete(body, user);
      case "add":       return await add(body, user);
      case "update":    return await update(body, user);
      case "completed": return await completed(body);
      case "export":    return await exportRows(body);

      case "scan": {
        // Default window is the last two days, so a missed run self-heals.
        const to = today();
        const since = /^\d{4}-\d{2}-\d{2}$/.test(String(body.since ?? "")) ? String(body.since)
          : dayIn(new Date(Date.now() - 2 * 86400000));
        const res = await runScan(since, to, Number(body.max_extractions ?? 12), user);
        if (body.archive === true) {
          const swept = await sweepArchive(user);
          const payload = await res.json();
          return json({ ...payload, archive_sweep: swept });
        }
        return res;
      }

      case "backfill": {
        const from = String(body.from ?? "");
        const to = String(body.to ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          return json({ error: "backfill needs from and to as YYYY-MM-DD." }, 400);
        }
        return await runScan(from, to, Number(body.max_extractions ?? 12), user);
      }

      case "archive": {
        // Not in the public action list; the 17:00 cron uses scan with archive.
        return json(await sweepArchive(user));
      }

      default:
        return json({ error: "Unknown action: " + String(body.action ?? "(none)"), valid_actions: ACTIONS }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
