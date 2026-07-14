/**
 * SPARC Summit — email relay (Google Apps Script web app)
 * --------------------------------------------------------
 * Sends the "Join Virtually for Free" emails FROM the SPARC work account,
 * with no 2-Step Verification and no App Password (the SPARC Google org
 * disallows 2SV, so Gmail SMTP App Passwords are impossible). A web app
 * deployed "Execute as: Me" sends mail as the deploying account after a
 * single normal sign-in + consent.
 *
 * DEPLOY (one time, ~5 minutes, signed in as erica@sparcsolutions.org):
 *   1. Go to https://script.google.com -> New project.
 *   2. Replace the default code with this file. Name the project
 *      "SPARC Summit Email Relay".
 *   3. Set SHARED_SECRET below to the real value (stored in the
 *      summit_email_relay_config table in Supabase — never commit it).
 *   4. Deploy -> New deployment -> type "Web app":
 *        - Execute as:            Me (erica@sparcsolutions.org)
 *        - Who has access:        Anyone
 *      Click Deploy, click through the authorization prompt ("Advanced ->
 *      Go to ... (unsafe)" is expected for personal scripts), and Allow.
 *   5. Copy the Web app URL (ends in /exec) and store it in
 *      summit_email_relay_config.webhook_url.
 *
 * The Supabase edge function `virtual-summit-register` POSTs
 *   { secret, name, email, source, notify? }
 * for each registration; this script sends:
 *   (a) a confirmation email with the live Zoom details to the registrant
 *   (b) a notification email to the staff inbox (default: the account that
 *       deployed this script).
 *
 * Quotas: consumer Gmail 100 recipients/day, Google Workspace 1,500/day —
 * each registration uses 2. Plenty for the summit.
 */

var SHARED_SECRET = "PASTE_SHARED_SECRET_HERE"; // from summit_email_relay_config

// ---- Summit / Zoom constants --------------------------------------------------
var SUMMIT_NAME = "A Call to Conscience: The SPARC Summit";
var SUMMIT_TAGLINE = "Advancing Dignity for Adults with Severe and Multiple Disabilities";
var SUMMIT_WHEN = "Monday, July 27, 2026 · 10:00 AM ET";
var SUMMIT_HOST = "Co-hosted with the George Washington University. Keynote by Senator Tim Kaine, with a farewell address from Congressman James Walkinshaw.";
var ZOOM_URL = "https://gwu-edu.zoom.us/s/97988820283?pwd=tyf6ZoWlQ5Wp5VA9LSCGvo7l8xNB5F.1";
var ZOOM_PASSCODE = "706309";
var SPARC_SITE = "https://www.sparcsolutions.org";
var FROM_NAME = "SPARC Summit";

function doPost(e) {
  var out = { ok: false };
  try {
    var data = JSON.parse(e.postData.contents);
    if (!data || data.secret !== SHARED_SECRET) {
      return respond_({ ok: false, error: "unauthorized" });
    }
    var name = String(data.name || "").trim().slice(0, 120);
    var email = String(data.email || "").trim();
    var source = String(data.source || "virtualsummit").slice(0, 60);
    var notify = String(data.notify || Session.getEffectiveUser().getEmail());
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return respond_({ ok: false, error: "invalid name/email" });
    }

    out.ok = true;
    out.confirmation = false;
    out.notification = false;

    // (a) Confirmation with Zoom details -> registrant
    try {
      MailApp.sendEmail({
        to: email,
        name: FROM_NAME,
        subject: "You're registered — SPARC Summit: A Call to Conscience (Virtual)",
        body: confirmationText_(name),
        htmlBody: confirmationHtml_(name),
      });
      out.confirmation = true;
    } catch (err) {
      out.error = "confirmation: " + err;
    }

    // (b) Notification -> SPARC staff
    try {
      MailApp.sendEmail({
        to: notify,
        name: FROM_NAME,
        replyTo: email,
        subject: "New virtual summit registration: " + name,
        body:
          "A new attendee registered to join the summit virtually.\n\n" +
          "Name:   " + name + "\n" +
          "Email:  " + email + "\n" +
          "Source: " + source + "\n\n" +
          "This registration was also saved to the summit_virtual_registrations table in Supabase.",
      });
      out.notification = true;
    } catch (err) {
      out.error = (out.error ? out.error + "; " : "") + "notification: " + err;
    }
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return respond_(out);
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function esc_(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function confirmationText_(name) {
  return [
    "Hi " + name + ",",
    "",
    "Thank you for registering to join " + SUMMIT_NAME + " virtually.",
    "",
    "When: " + SUMMIT_WHEN,
    SUMMIT_HOST,
    "",
    "HOW TO JOIN LIVE",
    "Join from PC, Mac, iPad, or Android:",
    ZOOM_URL,
    "Passcode: " + ZOOM_PASSCODE,
    "",
    "We recommend joining a few minutes early. We look forward to seeing you there!",
    "",
    "— SPARC (Specially Adapted Resource Centers)",
    SPARC_SITE,
  ].join("\n");
}

function confirmationHtml_(name) {
  var first = esc_(name.split(/\s+/)[0] || "there");
  return (
    '<div style="max-width:560px;margin:0 auto;padding:24px;background:#f5f6fa;font-family:Arial,Helvetica,sans-serif;color:#333;">' +
    '<div style="background:#002B50;border-radius:14px 14px 0 0;padding:28px 32px;text-align:center;">' +
    '<h1 style="color:#fff;font-size:22px;margin:0 0 6px;">You&#39;re registered!</h1>' +
    '<p style="color:rgba(255,255,255,0.85);margin:0;font-size:14px;">' + esc_(SUMMIT_NAME) + "</p>" +
    "</div>" +
    '<div style="background:#fff;border-radius:0 0 14px 14px;padding:28px 32px;">' +
    '<p style="font-size:15px;margin:0 0 16px;">Hi ' + first + ",</p>" +
    '<p style="font-size:15px;line-height:1.6;margin:0 0 20px;">Thank you for registering to join <strong>' +
    esc_(SUMMIT_NAME) + "</strong> virtually. " + esc_(SUMMIT_TAGLINE) + ".</p>" +
    '<p style="font-size:15px;color:#002B50;font-weight:bold;margin:0 0 6px;">🗓️ ' + esc_(SUMMIT_WHEN) + "</p>" +
    '<p style="font-size:14px;line-height:1.6;color:#555;margin:0 0 24px;">' + esc_(SUMMIT_HOST) + "</p>" +
    '<div style="background:#f5f6fa;border-radius:10px;padding:20px;text-align:center;margin:0 0 20px;">' +
    '<p style="margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#00539B;font-weight:bold;">How to join live</p>' +
    '<a href="' + ZOOM_URL + '" style="display:inline-block;background:#4CBB17;color:#fff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 34px;border-radius:8px;">▶ Join the Summit Live</a>' +
    '<p style="margin:16px 0 0;font-size:14px;color:#555;">Passcode: <strong style="color:#002B50;">' + ZOOM_PASSCODE + "</strong></p>" +
    '<p style="margin:10px 0 0;font-size:12px;color:#888;word-break:break-all;">' + ZOOM_URL + "</p>" +
    "</div>" +
    '<p style="font-size:14px;line-height:1.6;color:#555;margin:0 0 8px;">We recommend joining a few minutes early. We look forward to seeing you there!</p>' +
    '<p style="font-size:14px;margin:20px 0 0;color:#002B50;">— SPARC (Specially Adapted Resource Centers)</p>' +
    '<p style="font-size:12px;margin:4px 0 0;"><a href="' + SPARC_SITE + '" style="color:#00539B;">www.sparcsolutions.org</a></p>' +
    "</div></div>"
  );
}

/**
 * Optional: run this once from the editor (Run -> sendTestEmail) to verify
 * authorization and see both emails land in your own inbox.
 */
function sendTestEmail() {
  var me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({
    to: me,
    name: FROM_NAME,
    subject: "Relay test — SPARC Summit",
    body: confirmationText_("Test Attendee"),
    htmlBody: confirmationHtml_("Test Attendee"),
  });
}
