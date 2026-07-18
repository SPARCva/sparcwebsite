/**
 * SPARC Summit — email relay + RSVP master sheet (Google Apps Script web app)
 * ---------------------------------------------------------------------------
 * v3. Keeps the "Summit RSVPs — Master List" Google Sheet consolidated from
 * ALL registration sources, and sends the virtual-registration emails FROM
 * the SPARC work account (no 2SV / App Password — the SPARC Google org
 * disallows 2SV, so a web app deployed "Execute as: Me" is the approved
 * sending pattern; see CLAUDE.md).
 *
 *   1. doPost (called by the Supabase edge function `virtual-summit-register`
 *      for each "Join Virtually for Free" registration): sends the registrant
 *      confirmation + staff notification, and appends the registrant to the
 *      sheet labeled Attendance = "Virtual".
 *   2. syncBloomerang (time-driven trigger): scans the work Gmail inbox for
 *      Bloomerang notifications and adds In-Person attendees to the sheet:
 *        - individual "Constituent Information Received" emails whose
 *          Form name mentions the Summit (friends & family / guest form)
 *        - the weekly "Summit Attendees - ..." report emails (ticket holders,
 *          sponsors, registered guests) — parses the attached .xlsx/.csv
 *      Rows are deduped against the sheet by normalized name + email, and
 *      processed threads get the Gmail label "RSVP-Synced" so nothing is
 *      imported twice. Backfills all matching history on the first run.
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
 *   3. First-time only: run setupMasterSheet() once from the editor (Run ▶).
 *      Approve the permissions prompt. The log prints the sheet URL.
 *   4. Bloomerang sync: run previewBloomerangSync() (dry run — the log shows
 *      exactly what would be added), then syncBloomerang() to import, then
 *      installBloomerangTrigger() once to keep it running every 30 minutes.
 *   5. Deploy → Manage deployments → Edit (pencil) → Version: New version →
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
var SUMMIT_TAGLINE = "Advancing Inclusion for Adults with Disabilities who have Significant Support Needs";
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

// ============================================================================
// Bloomerang -> master sheet sync
// ============================================================================
// Two Bloomerang email shapes feed the sheet (both arrive at the work inbox
// from no-reply@bloomerang-mail.com):
//   A. "Constituent Information Received from <name> #<n>" — one per guest
//      submission. Plaintext body lists "Name:", "Email:", "Form name:".
//      Only imported when the form name mentions the summit.
//   B. "Summit Attendees - <report name>" — weekly scheduled reports with an
//      .xlsx (or .csv) attachment listing ticket holders/sponsors or guests.
//      The attachment is converted to a temporary Google Sheet via the Drive
//      API, parsed header-driven (Name / First+Last / Email columns), then
//      trashed.
// Processed threads are labeled RSVP-Synced; rows are deduped against the
// sheet by normalized name + email, so re-runs and overlapping reports are
// idempotent.

var SYNCED_LABEL = "RSVP-Synced";
var GUEST_QUERY =
  'from:no-reply@bloomerang-mail.com subject:"Constituent Information Received" -label:rsvp-synced';
var REPORT_QUERY =
  'from:no-reply@bloomerang-mail.com subject:"Summit Attendees" -label:rsvp-synced';
var MAX_THREADS_PER_RUN = 100;

/** Dry run: logs exactly what syncBloomerang() would add, changes nothing. */
function previewBloomerangSync() {
  var result = bloomerangSync_(true);
  Logger.log("PREVIEW ONLY — nothing was written.");
  Logger.log(result.rows.length + " row(s) would be added:");
  result.rows.forEach(function (r) { Logger.log("  + " + r.join(" | ")); });
  result.warnings.forEach(function (w) { Logger.log("  ! " + w); });
}

/** Imports new Bloomerang registrations into the master sheet. */
function syncBloomerang() {
  var result = bloomerangSync_(false);
  Logger.log("Added " + result.rows.length + " row(s).");
  result.warnings.forEach(function (w) { Logger.log("  ! " + w); });
}

/** Run once: keeps syncBloomerang() running every 30 minutes. */
function installBloomerangTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "syncBloomerang") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("syncBloomerang").timeBased().everyMinutes(30).create();
  Logger.log("Trigger installed: syncBloomerang every 30 minutes.");
}

function bloomerangSync_(dryRun) {
  var sheet = getSheet_();
  var seen = existingKeys_(sheet);
  var rows = [];
  var warnings = [];
  var label = dryRun ? null : GmailApp.createLabel(SYNCED_LABEL);

  function consider(name, email, category, registered, note) {
    name = String(name || "").trim();
    email = String(email || "").trim();
    if (!name && !email) return;
    var key = dedupeKey_(name, email);
    if (seen[key]) return;
    seen[key] = true;
    rows.push([name, email, category, "In-Person", registered || "", note]);
  }

  // --- A. Individual guest-form notifications --------------------------------
  GmailApp.search(GUEST_QUERY, 0, MAX_THREADS_PER_RUN).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      var body = msg.getPlainBody() || "";
      var form = matchField_(body, "Form name");
      if (form && /summit/i.test(form)) {
        consider(
          matchField_(body, "Name"),
          matchField_(body, "Email"),
          "Guest — " + form.replace(/^summit\s*[-—]\s*/i, ""),
          matchField_(body, "Date"),
          "via Bloomerang guest form"
        );
      }
      // Non-summit constituent forms are labeled too so they are not rescanned.
    });
    if (!dryRun) thread.addLabel(label);
  });

  // --- B. Weekly "Summit Attendees" report attachments ------------------------
  GmailApp.search(REPORT_QUERY, 0, MAX_THREADS_PER_RUN).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      var reportName = msg.getSubject().replace(/^Summit Attendees\s*[-—]\s*/i, "").trim();
      var category = /ticket|sponsor/i.test(reportName)
        ? "Ticket Holder / Sponsor"
        : "Guest — Registered";
      msg.getAttachments().forEach(function (att) {
        var fname = att.getName() || "";
        var values = null;
        try {
          if (/\.csv$/i.test(fname)) {
            values = Utilities.parseCsv(att.getDataAsString());
          } else if (/\.xlsx?$/i.test(fname)) {
            values = xlsxToValues_(att.copyBlob());
          }
        } catch (err) {
          warnings.push("Could not parse " + fname + " (" + msg.getSubject() + "): " + err);
        }
        if (!values) return;
        var mapped = mapReportRows_(values, warnings, msg.getSubject());
        mapped.forEach(function (r) {
          consider(r.name, r.email, category, "", "via Bloomerang report: " + reportName);
        });
      });
    });
    if (!dryRun) thread.addLabel(label);
  });

  if (!dryRun && rows.length) {
    sheet
      .getRange(sheet.getLastRow() + 1, 1, rows.length, SHEET_HEADERS.length)
      .setValues(rows);
  }
  return { rows: rows, warnings: warnings };
}

/** " * Name: Keith Chanon" -> "Keith Chanon" (bullet, colon-separated field). */
function matchField_(body, field) {
  var m = body.match(new RegExp("^\\s*\\*?\\s*" + field + ":\\s*(.*)$", "mi"));
  return m ? m[1].trim() : "";
}

/** Existing sheet rows -> lookup of dedupe keys. */
function existingKeys_(sheet) {
  var keys = {};
  var last = sheet.getLastRow();
  if (last < 2) return keys;
  sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
    keys[dedupeKey_(r[0], r[1])] = true;
  });
  return keys;
}

/**
 * Name+email key tolerant of "Last, First" vs "First Last": lowercased name
 * tokens are sorted before joining.
 */
function dedupeKey_(name, email) {
  var tokens = String(name || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter(String).sort().join(" ");
  return tokens + "|" + String(email || "").trim().toLowerCase();
}

/**
 * Header-driven extraction of {name, email} rows from a parsed report table.
 * Finds the header row (first row containing an email-ish header within the
 * first 10 rows), supports either a single Name column or First+Last columns.
 */
function mapReportRows_(values, warnings, context) {
  var headerRow = -1, emailIdx = -1;
  for (var r = 0; r < Math.min(values.length, 10); r++) {
    for (var c = 0; c < values[r].length; c++) {
      if (/e-?mail/i.test(String(values[r][c]))) { headerRow = r; emailIdx = c; break; }
    }
    if (headerRow >= 0) break;
  }
  if (headerRow < 0) {
    warnings.push("No email column found in report (" + context + ") — skipped. " +
      "First row was: " + JSON.stringify(values[0] || []));
    return [];
  }
  var headers = values[headerRow].map(String);
  var nameIdx = -1, firstIdx = -1, lastIdx = -1;
  headers.forEach(function (h, i) {
    if (nameIdx < 0 && /^(full\s*)?name$|attendee|constituent/i.test(h.trim())) nameIdx = i;
    if (/first/i.test(h)) firstIdx = i;
    if (/last/i.test(h)) lastIdx = i;
  });
  var out = [];
  for (var i = headerRow + 1; i < values.length; i++) {
    var row = values[i];
    var name = nameIdx >= 0 ? row[nameIdx]
      : [firstIdx >= 0 ? row[firstIdx] : "", lastIdx >= 0 ? row[lastIdx] : ""].join(" ").trim();
    var email = row[emailIdx];
    if (String(name).trim() || String(email).trim()) out.push({ name: name, email: email });
  }
  return out;
}

/**
 * Converts an .xlsx blob to a 2D values array by uploading it to Drive with
 * conversion to a temporary Google Sheet (then trashing it). Uses the raw
 * Drive REST API so no Advanced Service needs to be enabled.
 */
function xlsxToValues_(blob) {
  var boundary = "-------sparc314159265";
  var metadata = { name: "tmp-bloomerang-import", mimeType: "application/vnd.google-apps.spreadsheet" };
  var head =
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n";
  var tail = "\r\n--" + boundary + "--";
  var payload = Utilities.newBlob(head).getBytes()
    .concat(blob.getBytes())
    .concat(Utilities.newBlob(tail).getBytes());
  var resp = UrlFetchApp.fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "post",
      contentType: "multipart/related; boundary=" + boundary,
      payload: payload,
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    }
  );
  if (resp.getResponseCode() >= 300) {
    throw new Error("Drive conversion failed: " + resp.getContentText().slice(0, 200));
  }
  var id = JSON.parse(resp.getContentText()).id;
  try {
    return SpreadsheetApp.openById(id).getSheets()[0].getDataRange().getValues();
  } finally {
    DriveApp.getFileById(id).setTrashed(true);
  }
}
