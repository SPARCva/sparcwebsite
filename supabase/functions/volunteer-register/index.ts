// volunteer-register
// -------------------
// Public edge function that powers the volunteer application form at /volunteer.
//
// Action (POST JSON):
//
//   { name, email, phone?, interests?: string[], availability?, message?,
//     source?, company? (honeypot) }
//     1. Validates the submitted name + email (drops spam via the honeypot).
//     2. Stores the application in public.volunteer_applications
//        (service-role key -> bypasses RLS; the table is otherwise locked down).
//     3. Relays the application to a Google Apps Script web app, which sends
//        (a) a confirmation email to the applicant and (b) a notification email
//        to SPARC staff with the full application — both FROM the SPARC work
//        account that deployed the script.
//
// WHY APPS SCRIPT (and not Gmail SMTP): SPARC's Google org disallows 2-Step
// Verification, so Gmail App Passwords cannot be created. A Google Apps
// Script web app deployed by the work account ("Execute as: Me") sends mail as
// that account with only a normal sign-in — no 2SV, no app password.
// See supabase/functions/volunteer-register/apps-script.gs in the repo.
//
// The relay endpoint + shared secret live in public.volunteer_email_relay_config
// (single row, RLS enabled with no policies -> service-role only). The DB
// insert always happens even if the relay is not yet configured or fails, so
// no application is ever lost — emails simply start flowing once the Apps
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

// Normalize the interests field to a clean, bounded array of short strings.
function cleanInterests(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const s = String(item ?? "").trim().slice(0, 80);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
    if (out.length >= 12) break;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const honeypot = String(payload.company ?? "").trim(); // hidden field
  // Silently accept bot submissions (honeypot filled) without storing/sending.
  if (honeypot) return json({ ok: true });

  const name = String(payload.name ?? "").trim();
  const email = String(payload.email ?? "").trim();
  const phone = String(payload.phone ?? "").trim().slice(0, 40) || null;
  const availability =
    String(payload.availability ?? "").trim().slice(0, 300) || null;
  const message = String(payload.message ?? "").trim().slice(0, 4000) || null;
  const interests = cleanInterests(payload.interests);
  const source = String(payload.source ?? "volunteer").slice(0, 60);

  if (!name || name.length > 120) {
    return json({ error: "Please enter your name." }, 400);
  }
  if (!email || !EMAIL_RE.test(email) || email.length > 200) {
    return json({ error: "Please enter a valid email address." }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const userAgent = req.headers.get("user-agent")?.slice(0, 300) ?? null;

  // 1) Persist the application (service role -> bypasses RLS).
  const { data: row, error: insertError } = await supabase
    .from("volunteer_applications")
    .insert({
      name,
      email,
      phone,
      interests,
      availability,
      message,
      source,
      user_agent: userAgent,
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("insert failed:", insertError.message);
    return json(
      { error: "Could not save your application. Please try again." },
      500,
    );
  }

  // 2) Send emails via the Apps Script relay (best effort — never blocks a
  //    successful application).
  let confirmationSent = false;
  let notificationSent = false;
  let sendError: string | null = null;

  const { data: cfg } = await supabase
    .from("volunteer_email_relay_config")
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
          phone: phone ?? undefined,
          interests,
          availability: availability ?? undefined,
          message: message ?? undefined,
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
    .from("volunteer_applications")
    .update({
      confirmation_sent: confirmationSent,
      notification_sent: notificationSent,
      send_error: sendError,
    })
    .eq("id", row.id);

  return json({ ok: true, emailed: confirmationSent });
});
