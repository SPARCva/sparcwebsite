// virtual-summit-register
// ------------------------
// Public edge function that powers the "Join Virtually for Free" flow for the
// SPARC "A Call to Conscience" summit (the /virtualsummit page and the modal on
// /summit).
//
// On each POST it:
//   1. Validates the submitted name + email (and drops obvious spam via honeypot).
//   2. Stores the registration in public.summit_virtual_registrations
//      (service-role key -> bypasses RLS; the table is otherwise locked down).
//   3. Emails a notification to the SPARC inbox so staff can record the attendee.
//   4. Emails the registrant a confirmation with the live Zoom join details.
//
// Email is sent from a Gmail account over SMTP using a Gmail App Password.
// Configure these Edge Function secrets in the Supabase dashboard
// (Project Settings -> Edge Functions -> Secrets):
//
//   GMAIL_USER          e.g. erica@sparcsolutions.org  (the sending mailbox)
//   GMAIL_APP_PASSWORD  the 16-char Google App Password (NOT the normal password)
//   NOTIFY_EMAIL        (optional) where staff notifications go; defaults to GMAIL_USER
//   FROM_NAME           (optional) display name on outgoing mail; defaults to "SPARC Summit"
//
// The DB insert always happens even if email is not yet configured or SMTP
// fails, so no registration is ever lost — emails simply start flowing once the
// GMAIL_* secrets are set.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

// ---- Summit / Zoom constants -------------------------------------------------
const SUMMIT_NAME = "A Call to Conscience: The SPARC Summit";
const SUMMIT_TAGLINE =
  "Advancing Dignity for Adults with Severe and Multiple Disabilities";
const SUMMIT_WHEN = "Monday, July 27, 2026 · 10:00 AM ET";
const SUMMIT_HOST =
  "Co-hosted with the George Washington University. Keynote by Senator Tim Kaine, with a farewell address from Congressman James Walkinshaw.";
const ZOOM_URL =
  "https://gwu-edu.zoom.us/s/97988820283?pwd=tyf6ZoWlQ5Wp5VA9LSCGvo7l8xNB5F.1";
const ZOOM_PASSCODE = "706309";
const SPARC_SITE = "https://www.sparcsolutions.org";

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---- Email bodies ------------------------------------------------------------
function registrantEmail(name: string): { subject: string; html: string; text: string } {
  const first = escapeHtml(name.trim().split(/\s+/)[0] || "there");
  const subject = "You're registered — SPARC Summit: A Call to Conscience (Virtual)";
  const text = [
    `Hi ${name.trim()},`,
    "",
    `Thank you for registering to join ${SUMMIT_NAME} virtually.`,
    "",
    `When: ${SUMMIT_WHEN}`,
    SUMMIT_HOST,
    "",
    "HOW TO JOIN LIVE",
    "Join from PC, Mac, iPad, or Android:",
    ZOOM_URL,
    `Passcode: ${ZOOM_PASSCODE}`,
    "",
    "We recommend joining a few minutes early. We look forward to seeing you there!",
    "",
    "— SPARC (Specially Adapted Resource Centers)",
    SPARC_SITE,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f6fa;font-family:'Open Sans',Arial,Helvetica,sans-serif;color:#333;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#002B50;border-radius:14px 14px 0 0;padding:28px 32px;text-align:center;">
      <h1 style="color:#fff;font-size:22px;margin:0 0 6px;">You're registered!</h1>
      <p style="color:rgba(255,255,255,0.85);margin:0;font-size:14px;">${escapeHtml(SUMMIT_NAME)}</p>
    </div>
    <div style="background:#fff;border-radius:0 0 14px 14px;padding:28px 32px;box-shadow:0 4px 20px rgba(0,0,0,0.06);">
      <p style="font-size:15px;margin:0 0 16px;">Hi ${first},</p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 20px;">
        Thank you for registering to join <strong>${escapeHtml(SUMMIT_NAME)}</strong> virtually.
        ${escapeHtml(SUMMIT_TAGLINE)}.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 20px;">
        <tr><td style="padding:6px 0;font-size:14px;color:#555;">🗓️ <strong>When</strong></td></tr>
        <tr><td style="padding:0 0 12px;font-size:15px;color:#002B50;font-weight:600;">${escapeHtml(SUMMIT_WHEN)}</td></tr>
      </table>
      <p style="font-size:14px;line-height:1.6;color:#555;margin:0 0 24px;">${escapeHtml(SUMMIT_HOST)}</p>

      <div style="background:#f5f6fa;border-radius:10px;padding:20px;text-align:center;margin:0 0 20px;">
        <p style="margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#00539B;font-weight:700;">How to join live</p>
        <a href="${ZOOM_URL}" style="display:inline-block;background:#4CBB17;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 34px;border-radius:8px;">▶ Join the Summit Live</a>
        <p style="margin:16px 0 0;font-size:14px;color:#555;">Passcode: <strong style="color:#002B50;">${ZOOM_PASSCODE}</strong></p>
        <p style="margin:10px 0 0;font-size:12px;color:#888;word-break:break-all;">${ZOOM_URL}</p>
      </div>

      <p style="font-size:14px;line-height:1.6;color:#555;margin:0 0 8px;">
        We recommend joining a few minutes early. We look forward to seeing you there!
      </p>
      <p style="font-size:14px;margin:20px 0 0;color:#002B50;">— SPARC (Specially Adapted Resource Centers)</p>
      <p style="font-size:12px;margin:4px 0 0;"><a href="${SPARC_SITE}" style="color:#00539B;">www.sparcsolutions.org</a></p>
    </div>
  </div>
</body></html>`;

  return { subject, html, text };
}

function notificationEmail(
  name: string,
  email: string,
  source: string,
): { subject: string; html: string; text: string } {
  const subject = `New virtual summit registration: ${name.trim()}`;
  const text = [
    "A new attendee registered to join the summit virtually.",
    "",
    `Name:   ${name.trim()}`,
    `Email:  ${email.trim()}`,
    `Source: ${source}`,
    "",
    "This registration was also saved to the summit_virtual_registrations table.",
  ].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#333;font-size:15px;line-height:1.6;">
    <p>A new attendee registered to join the summit <strong>virtually</strong>.</p>
    <table style="border-collapse:collapse;">
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Name</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(name.trim())}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Email</td><td style="padding:4px 0;font-weight:600;"><a href="mailto:${escapeHtml(email.trim())}">${escapeHtml(email.trim())}</a></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555;">Source</td><td style="padding:4px 0;">${escapeHtml(source)}</td></tr>
    </table>
    <p style="color:#888;font-size:13px;">Also saved to the <code>summit_virtual_registrations</code> table.</p>
  </div>`;
  return { subject, html, text };
}

// ---- Handler -----------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const name = String(payload.name ?? "").trim();
  const email = String(payload.email ?? "").trim();
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
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: row, error: insertError } = await supabase
    .from("summit_virtual_registrations")
    .insert({ name, email, source, user_agent: userAgent })
    .select("id")
    .single();

  if (insertError) {
    console.error("insert failed:", insertError.message);
    return json({ error: "Could not save your registration. Please try again." }, 500);
  }

  // 2) Send emails (best effort — never blocks a successful registration).
  const gmailUser = Deno.env.get("GMAIL_USER");
  const gmailPass = Deno.env.get("GMAIL_APP_PASSWORD");
  const notifyTo = Deno.env.get("NOTIFY_EMAIL") || gmailUser;
  const fromName = Deno.env.get("FROM_NAME") || "SPARC Summit";

  let confirmationSent = false;
  let notificationSent = false;
  let sendError: string | null = null;

  if (gmailUser && gmailPass) {
    const client = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: gmailUser, password: gmailPass },
      },
    });
    const from = `${fromName} <${gmailUser}>`;
    try {
      // Confirmation to the registrant.
      const conf = registrantEmail(name);
      await client.send({
        from,
        to: email,
        subject: conf.subject,
        content: conf.text,
        html: conf.html,
      });
      confirmationSent = true;

      // Notification to SPARC staff.
      if (notifyTo) {
        const note = notificationEmail(name, email, source);
        await client.send({
          from,
          to: notifyTo,
          replyTo: email,
          subject: note.subject,
          content: note.text,
          html: note.html,
        });
        notificationSent = true;
      }
    } catch (e) {
      sendError = e instanceof Error ? e.message : String(e);
      console.error("SMTP send failed:", sendError);
    } finally {
      try {
        await client.close();
      } catch { /* ignore */ }
    }
  } else {
    sendError = "GMAIL_USER / GMAIL_APP_PASSWORD not configured";
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
