/**
 * SPARC Volunteer — email relay + applications sheet (Google Apps Script web app)
 * ------------------------------------------------------------------------------
 * Sends the volunteer-application emails FROM the SPARC work account (no 2SV /
 * App Password — the SPARC Google org disallows 2SV, so a web app deployed
 * "Execute as: Me" is the approved sending pattern; see CLAUDE.md).
 *
 *   doPost (called by the Supabase edge function `volunteer-register` for each
 *   submission on /volunteer): sends the applicant a confirmation email and
 *   SPARC staff a notification email with the full application, and appends the
 *   application to a "SPARC Volunteer Applications" Google Sheet.
 *
 * The sheet is created automatically in the deploying account's My Drive on
 * first use; its ID is remembered in Script Properties (VOLUNTEER_SHEET_ID).
 *
 * DEPLOY (signed in as the SPARC work account, e.g. debi@sparcsolutions.org):
 *   1. Go to https://script.google.com -> New project.
 *   2. Paste this file. Set SHARED_SECRET to the real value (the same value
 *      stored in volunteer_email_relay_config.shared_secret — never commit it).
 *   3. Optional first run: run sendTestEmail() from the editor (Run ▶) and
 *      approve the permissions prompt, to confirm mail sends from this account.
 *   4. Deploy -> New deployment -> type "Web app".
 *        Execute as: Me
 *        Who has access: Anyone
 *      Deploy, then copy the Web app URL (ends in /exec).
 *   5. Store that URL in volunteer_email_relay_config.webhook_url (Supabase).
 *      Emails start flowing immediately; applications were already being saved.
 *
 * To change the code later: Deploy -> Manage deployments -> Edit (pencil) ->
 * Version: New version -> Deploy. Editing keeps the same /exec URL, so nothing
 * changes in Supabase. Only a brand-new deployment mints a new URL.
 *
 * Quotas: consumer Gmail 100 recipients/day, Google Workspace 1,500/day —
 * each application uses 2. Plenty for volunteer intake.
 */

var SHARED_SECRET = "PASTE_SHARED_SECRET_HERE"; // from volunteer_email_relay_config

var SPARC_SITE = "https://www.sparcsolutions.org";
var FROM_NAME = "SPARC Volunteer Team";

var SHEET_TITLE = "SPARC Volunteer Applications";
var SHEET_HEADERS = [
  "Received", "Name", "Email", "Phone", "Interests", "Availability", "Message", "Source",
];

function doPost(e) {
  var out = { ok: false };
  try {
    var data = JSON.parse(e.postData.contents);
    if (!data || data.secret !== SHARED_SECRET) {
      return respond_({ ok: false, error: "unauthorized" });
    }
    var name = String(data.name || "").trim().slice(0, 120);
    var email = String(data.email || "").trim();
    var phone = String(data.phone || "").trim();
    var interests = Array.isArray(data.interests)
      ? data.interests.map(function (s) { return String(s).trim(); }).filter(String)
      : [];
    var availability = String(data.availability || "").trim();
    var message = String(data.message || "").trim();
    var source = String(data.source || "volunteer").slice(0, 60);
    var notify = String(data.notify || Session.getEffectiveUser().getEmail());
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return respond_({ ok: false, error: "invalid name/email" });
    }

    out.ok = true;
    out.confirmation = false;
    out.notification = false;
    out.sheet = false;

    // (a) Confirmation -> applicant
    try {
      MailApp.sendEmail({
        to: email,
        name: FROM_NAME,
        subject: "Thanks for your interest in volunteering with SPARC",
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
        subject: "New volunteer application: " + name,
        body:
          "A new volunteer application was submitted on the SPARC website.\n\n" +
          "Name:         " + name + "\n" +
          "Email:        " + email + "\n" +
          "Phone:        " + (phone || "(not provided)") + "\n" +
          "Interests:    " + (interests.length ? interests.join(", ") : "(none selected)") + "\n" +
          "Availability: " + (availability || "(not provided)") + "\n" +
          "Message:      " + (message || "(none)") + "\n" +
          "Source:       " + source + "\n\n" +
          "Also added to the \"" + SHEET_TITLE + "\" Google Sheet and saved to " +
          "the volunteer_applications table in Supabase.",
      });
      out.notification = true;
    } catch (err) {
      out.error = (out.error ? out.error + "; " : "") + "notification: " + err;
    }

    // (c) Append to the applications sheet
    try {
      getSheet_().appendRow([
        new Date(), name, email, phone, interests.join(", "), availability, message, source,
      ]);
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
 * Returns the applications sheet, creating the spreadsheet (and remembering
 * its ID in Script Properties) if needed.
 */
function getSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("VOLUNTEER_SHEET_ID");
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(SHEET_TITLE);
    props.setProperty("VOLUNTEER_SHEET_ID", ss.getId());
    var sh = ss.getSheets()[0];
    sh.setName("Applications");
    sh.appendRow(SHEET_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, SHEET_HEADERS.length)
      .setFontWeight("bold").setBackground("#002B50").setFontColor("#FFFFFF");
    var widths = [150, 190, 240, 130, 260, 200, 360, 110];
    for (var i = 0; i < widths.length; i++) sh.setColumnWidth(i + 1, widths[i]);
  }
  return ss.getSheets()[0];
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
  var first = (name.split(/\s+/)[0] || "there");
  return [
    "Hi " + first + ",",
    "",
    "Thank you for your interest in volunteering with SPARC (Specially Adapted",
    "Resource Centers)! We've received your application and a member of our team",
    "will be in touch soon about current opportunities that match your interests.",
    "",
    "Volunteers are at the heart of what we do — thank you for wanting to help",
    "adults with intellectual and developmental disabilities across Northern",
    "Virginia live meaningful, connected lives.",
    "",
    "If you have any questions in the meantime, just reply to this email.",
    "",
    "— The SPARC Volunteer Team",
    SPARC_SITE,
  ].join("\n");
}

function confirmationHtml_(name) {
  var first = esc_(name.split(/\s+/)[0] || "there");
  return (
    '<div style="max-width:560px;margin:0 auto;padding:24px;background:#f5f6fa;font-family:Arial,Helvetica,sans-serif;color:#333;">' +
    '<div style="background:#002B50;border-radius:14px 14px 0 0;padding:28px 32px;text-align:center;">' +
    '<h1 style="color:#fff;font-size:22px;margin:0 0 6px;">Thank you for volunteering!</h1>' +
    '<p style="color:rgba(255,255,255,0.85);margin:0;font-size:14px;">SPARC — Specially Adapted Resource Centers</p>' +
    "</div>" +
    '<div style="background:#fff;border-radius:0 0 14px 14px;padding:28px 32px;">' +
    '<p style="font-size:15px;margin:0 0 16px;">Hi ' + first + ",</p>" +
    '<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Thank you for your interest in volunteering with SPARC! We&#39;ve received your application, and a member of our team will be in touch soon about current opportunities that match your interests.</p>' +
    '<p style="font-size:15px;line-height:1.6;margin:0 0 20px;">Volunteers are at the heart of what we do — thank you for wanting to help adults with intellectual and developmental disabilities across Northern Virginia live meaningful, connected lives.</p>' +
    '<div style="background:#f5f6fa;border-radius:10px;padding:18px 20px;margin:0 0 20px;">' +
    '<p style="margin:0;font-size:14px;line-height:1.6;color:#555;">Have a question in the meantime? Just reply to this email and we&#39;ll help.</p>' +
    "</div>" +
    '<p style="font-size:14px;margin:20px 0 0;color:#002B50;">— The SPARC Volunteer Team</p>' +
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
    subject: "Relay test — SPARC Volunteer",
    body: confirmationText_("Test Volunteer"),
    htmlBody: confirmationHtml_("Test Volunteer"),
  });
}
