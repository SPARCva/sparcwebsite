/**
 * SPARC Summit — email relay + RSVP master sheet (Google Apps Script web app)
 * ---------------------------------------------------------------------------
 * v2. Does two things for each "Join Virtually for Free" registration relayed
 * from the Supabase edge function `virtual-summit-register`:
 *   1. Sends the emails FROM the SPARC work account (no 2SV / App Password —
 *      the SPARC Google org disallows 2SV, so a web app deployed
 *      "Execute as: Me" is the approved sending pattern; see CLAUDE.md).
 *   2. Appends the registrant to the "Summit RSVPs — Master List" Google
 *      Sheet, labeled Attendance = "Virtual", so online and in-person RSVPs
 *      live in one consolidated, always-current list.
 *
 * The sheet is created automatically in the deploying account's My Drive on
 * first use; its ID is remembered in Script Properties (RSVP_SHEET_ID).
 *
 * DEPLOY / UPDATE (signed in as the SPARC work account):
 *   1. Open the existing "SPARC Summit Email Relay" project at
 *      https://script.google.com (or create a new project).
 *   2. Replace the code with this file. Set SHARED_SECRET to the real value
 *      (stored in the summit_email_relay_config table — never commit it).
 *      The private copy may also carry IMPORT_ROWS (attendee data is PII and
 *      is never committed to this public repo).
 *   3. Run setupMasterSheet() once from the editor (Run ▶). Approve the
 *      permissions prompt. The execution log prints the sheet URL.
 *   4. Deploy → Manage deployments → Edit (pencil) → Version: New version →
 *      Deploy. (Editing an existing deployment keeps the same /exec URL, so
 *      nothing needs to change in Supabase. Only a brand-new deployment
 *      would mint a new URL — then update summit_email_relay_config.)
 *
 * Quotas: consumer Gmail 100 recipients/day, Google Workspace 1,500/day —
 * each registration uses 2. Plenty for the summit.
 */

var SHARED_SECRET = "PASTE_SHARED_SECRET_HERE"; // from summit_email_relay_config

// One-time import for setupMasterSheet(): rows of
// [Name, Email, Category / Group, Attendance, Registered, Notes].
// Left EMPTY in the repo copy — attendee lists are PII and stay out of git.
var IMPORT_ROWS = [];

// ---- Summit / Zoom constants --------------------------------------------------
var SUMMIT_NAME = "A Call to Conscience: The SPARC Summit";
var SUMMIT_TAGLINE = "Advancing Dignity for Adults with Severe and Multiple Disabilities";
var SUMMIT_WHEN = "Monday, July 27, 2026 · 10:00 AM ET";
var SUMMIT_HOST = "Co-hosted with the George Washington University. Keynote by Senator Tim Kaine, with a farewell address from Congressman James Walkinshaw.";
var ZOOM_URL = "https://gwu-edu.zoom.us/s/97988820283?pwd=tyf6ZoWlQ5Wp5VA9LSCGvo7l8xNB5F.1";
var ZOOM_PASSCODE = "706309";
var SPARC_SITE = "https://www.sparcsolutions.org";
var FROM_NAME = "SPARC Summit";

var SHEET_TITLE = "Summit RSVPs — Master List";
var SHEET_HEADERS = ["Name", "Primary Email Address", "Category / Group", "Attendance", "Registered", "Notes"];

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
    out.sheet = false;

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
          "Also added to the \"" + SHEET_TITLE + "\" Google Sheet and saved to " +
          "the summit_virtual_registrations table in Supabase.",
      });
      out.notification = true;
    } catch (err) {
      out.error = (out.error ? out.error + "; " : "") + "notification: " + err;
    }

    // (c) Append to the consolidated RSVP sheet
    try {
      getSheet_().appendRow([name, email, "Virtual Attendee", "Virtual", new Date(), "via " + source]);
      out.sheet = true;
    } catch (err) {
      out.error = (out.error ? out.error + "; " : "") + "sheet: " + err;
    }
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return respond_(out);
}

/**
 * Returns the "RSVPs" sheet of the master spreadsheet, creating the
 * spreadsheet (and remembering its ID in Script Properties) if needed.
 */
function getSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("RSVP_SHEET_ID");
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(SHEET_TITLE);
    props.setProperty("RSVP_SHEET_ID", ss.getId());
    var sh = ss.getSheets()[0];
    sh.setName("RSVPs");
    sh.appendRow(SHEET_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, SHEET_HEADERS.length)
      .setFontWeight("bold").setBackground("#002B50").setFontColor("#FFFFFF");
    var widths = [200, 260, 320, 100, 150, 280];
    for (var i = 0; i < widths.length; i++) sh.setColumnWidth(i + 1, widths[i]);
  }
  return ss.getSheets()[0];
}

/**
 * Run ONCE from the editor after pasting this code: creates the master sheet
 * and bulk-imports IMPORT_ROWS (the existing in-person + virtual RSVPs).
 * Safe to re-run — it only imports when the sheet is still empty.
 * The execution log prints the spreadsheet URL.
 */
function setupMasterSheet() {
  var sh = getSheet_();
  if (sh.getLastRow() <= 1 && IMPORT_ROWS.length) {
    sh.getRange(2, 1, IMPORT_ROWS.length, SHEET_HEADERS.length).setValues(IMPORT_ROWS);
  }
  var url = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty("RSVP_SHEET_ID")
  ).getUrl();
  Logger.log("Master RSVP sheet (" + (sh.getLastRow() - 1) + " rows): " + url);
  return url;
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
 * Optional: run from the editor to verify authorization and see the
 * confirmation email land in your own inbox.
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
