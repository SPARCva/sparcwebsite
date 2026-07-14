// virtual-summit-register
// ------------------------
// Public edge function that powers the "Join Virtually for Free" flow for the
// SPARC "A Call to Conscience" summit (the /virtualsummit page and the modal on
// /summit).
//
// Actions (POST JSON):
//
//   { action: "register" (default), name, email, source?, company? (honeypot) }
//     1. Validates the submitted name + email (drops spam via honeypot).
//     2. Stores the registration in public.summit_virtual_registrations
//        (service-role key -> bypasses RLS; the table is otherwise locked down).
//     3. Relays the registration to a Google Apps Script web app, which sends
//        (a) a confirmation email with the live Zoom details to the registrant
//        and (b) a notification email to SPARC staff — both FROM the SPARC
//        work account that deployed the script.
//
//   { action: "lookup", email }
//     Returns { ok, registered, name? } so returning attendees can reveal the
//     "Join the Livestream" button without registering twice.
//
// WHY APPS SCRIPT (and not Gmail SMTP): SPARC's Google org disallows 2-Step
// Verification, so Gmail App Passwords cannot be created. A Google Apps
// Script web app deployed by the work account ("Execute as me") sends mail as
// that account with only a normal sign-in — no 2SV, no app password.
// See supabase/functions/virtual-summit-register/apps-script.gs in the repo.
//
// The relay endpoint + shared secret live in public.summit_email_relay_config
// (single row, RLS enabled with no policies -> service-role only). The DB
// insert always happens even if the relay is not yet configured or fails, so
// no registration is ever lost — emails simply start flowing once the Apps
// Script URL is set in that table.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const action = String(payload.action ?? "register");
  const email = String(payload.email ?? "").trim();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---- action: lookup ---------------------------------------------------------
  // Returning attendee: confirm their email is registered so the frontend can
  // reveal the livestream join button. Only discloses whether a free-event
  // registration exists + the first name it was made under.
  if (action === "lookup") {
    if (!email || !EMAIL_RE.test(email) || email.length > 200) {
      return json({ error: "Please enter a valid email address." }, 400);
    }
    const { data, error } = await supabase
      .from("summit_virtual_registrations")
      .select("name")
      .ilike("email", email)
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) {
      console.error("lookup failed:", error.message);
      return json({ error: "Lookup failed. Please try again." }, 500);
    }
    const row = data && data[0];
    return json({
      ok: true,
      registered: !!row,
      name: row ? String(row.name).trim().split(/\s+/)[0] : undefined,
    });
  }

  // ---- action: register (default) ----------------------------------------------
  const name = String(payload.name ?? "").trim();
  const source = String(payload.source ?? "virtualsummit").slice(0, 60);
  const honeypot = String(payload.company ?? "").trim(); // hidden field

  // Silently accept bot submissions (honeypot filled) without storing/sending.
  if (honeypot) return json({ ok: true });

  if (!name || name.length > 120) {
    return json({ error: "Please enter your name." }, 400);
  }
  if (!email || !EMAIL_RE.test(email) || email.length > 200) {
    return json({ error: "Please enter a valid email address." }, 400);
  }

  const userAgent = req.headers.get("user-agent")?.slice(0, 300) ?? null;

  // 1) Persist the registration (service role -> bypasses RLS).
  const { data: row, error: insertError } = await supabase
    .from("summit_virtual_registrations")
    .insert({ name, email, source, user_agent: userAgent })
    .select("id")
    .single();

  if (insertError) {
    console.error("insert failed:", insertError.message);
    return json({ error: "Could not save your registration. Please try again." }, 500);
  }

  // 2) Send emails via the Apps Script relay (best effort — never blocks a
  //    successful registration).
  let confirmationSent = false;
  let notificationSent = false;
  let sendError: string | null = null;

  const { data: cfg } = await supabase
    .from("summit_email_relay_config")
    .select("webhook_url, shared_secret, notify_email")
    .eq("id", true)
    .maybeSingle();

  if (cfg?.webhook_url && cfg?.shared_secret) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(cfg.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: cfg.shared_secret,
          name,
          email,
          source,
          notify: cfg.notify_email ?? undefined,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        confirmationSent = body.confirmation !== false;
        notificationSent = body.notification !== false;
      } else {
        sendError = `relay responded ${res.status}: ${
          body?.error ?? "unknown error"
        }`;
        console.error("relay send failed:", sendError);
      }
    } catch (e) {
      sendError = e instanceof Error ? e.message : String(e);
      console.error("relay send failed:", sendError);
    }
  } else {
    sendError = "email relay not configured (Apps Script URL missing)";
    console.warn(sendError);
  }

  // 3) Record send status on the row (best effort).
  await supabase
    .from("summit_virtual_registrations")
    .update({
      confirmation_sent: confirmationSent,
      notification_sent: notificationSent,
      send_error: sendError,
    })
    .eq("id", row.id);

  return json({ ok: true, emailed: confirmationSent });
});
