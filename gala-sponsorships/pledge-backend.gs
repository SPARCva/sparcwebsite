/**
 * ============================================================================
 * An Evening to SPARCle — Sponsorship backend (Google Apps Script)
 * ============================================================================
 *
 * Powers the Sponsorship page at /gala-sponsorships/. It handles BOTH ways a
 * sponsor can act on that page:
 *
 *   • "Pledge"  — the sponsor fills in the pledge form and submits.
 *   • "Pay Now" — the sponsor uploads their logo, then pays via Bloomerang.
 *
 * Either way, every submission:
 *   1. Emails erica@sparcsolutions.org and debi@sparcsolutions.org with the
 *      details AND the uploaded logo attached.
 *   2. Saves the logo file to a Google Drive folder.
 *   3. Appends a row to a Google Sheet (your running sponsor log).
 *   4. Serves the sponsor list back to the website so each uploaded logo shows
 *      up in the sponsor carousel on /gala-sponsorships/ and /gala/ automatically.
 *
 * NO DNS / domain email setup is required — Google sends the notification from
 * the Google account you deploy this with, straight to Erica and Debi.
 *
 * ----------------------------------------------------------------------------
 * ONE-TIME SETUP
 * ----------------------------------------------------------------------------
 *   1. Go to https://script.google.com and create a New project.
 *   2. Delete the sample code and paste this entire file into Code.gs.
 *   3. Run the function `setup` once from the editor toolbar and click through
 *      the Google authorization prompt (it needs Gmail + Drive + Sheets).
 *      This creates the Drive folder and the tracking Sheet and logs their IDs.
 *   4. Click Deploy > New deployment > type "Web app".
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Click Deploy and COPY the resulting /exec web-app URL.
 *   5. Paste that URL into ONE place on the website:
 *        - /js/gala-sponsors.js  ->  GALA_SPONSORS_API
 *      (The sponsorship form and both carousels read the URL from there.)
 *   6. Done. Test by submitting the sponsorship form once.
 *
 * If you ever change this code, use Deploy > Manage deployments > Edit (pencil)
 * > Version: New version, so the same URL keeps working.
 * ----------------------------------------------------------------------------
 */

/* ==== CONFIG =============================================================== */

var NOTIFY_EMAILS = ['erica@sparcsolutions.org', 'debi@sparcsolutions.org'];
var FROM_NAME     = 'SPARC Gala Sponsorships';
var DRIVE_FOLDER_NAME = 'Gala Sponsor Logos';
var SHEET_NAME        = 'Gala Sponsor Pledges';

/* If true, a newly submitted logo appears in the public website carousel right
 * away. Set to false to hold new logos until you mark them Approved = TRUE in
 * the tracking Sheet (recommended if you ever get spam submissions). */
var AUTO_APPROVE = true;

/* Stored IDs (filled in by setup(); also discoverable via Script Properties). */
var PROP = PropertiesService.getScriptProperties();

/* ==== SETUP (run once) ==================================================== */

function setup() {
  var folder = getOrCreateFolder_();
  var sheet = getOrCreateSheet_();
  Logger.log('Drive folder "%s" id: %s', DRIVE_FOLDER_NAME, folder.getId());
  Logger.log('Sheet "%s" id: %s', SHEET_NAME, sheet.getParent().getId());
  Logger.log('Setup complete. Now Deploy > New deployment > Web app.');
}

/* ==== POST: handle a sponsorship submission ============================== */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    var type     = String(data.type || 'pledge').trim().toLowerCase();
    var isPayment = (type === 'payment');

    var org      = String(data.organization || '').trim();
    var contact  = String(data.contact || '').trim();
    var email    = String(data.email || '').trim();
    var phone    = String(data.phone || '').trim();
    var level    = String(data.level || '').trim();
    var amount   = String(data.amount || '').trim();
    var website  = String(data.website || '').trim();
    var message  = String(data.message || '').trim();

    // Pledges must include an amount; for Pay Now the amount is set in
    // Bloomerang, so only org + email are required there.
    if (!org || !email || (!isPayment && !amount)) {
      return json_({ status: 'error', message: 'Missing required fields.' });
    }

    // Decode the uploaded logo (data URL: "data:image/png;base64,....").
    var logoBlob = null;
    var logoUrl = '';
    var logoFileName = '';
    if (data.logoData && data.logoName) {
      logoBlob = dataUrlToBlob_(data.logoData, sanitizeName_(data.logoName));
      logoFileName = logoBlob.getName();

      var folder = getOrCreateFolder_();
      var stamp = Utilities.formatDate(new Date(), 'America/New_York', 'yyyyMMdd-HHmmss');
      var saved = folder.createFile(logoBlob);
      saved.setName(stamp + '__' + sanitizeName_(org) + '__' + logoFileName);
      // Anyone-with-link can view, so the image is servable if you want it.
      try {
        saved.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (shareErr) {
        // Domain policy may block public sharing; the carousel uses the stored
        // data URL instead, so this is non-fatal.
      }
      logoUrl = 'https://drive.google.com/uc?export=view&id=' + saved.getId();
    }

    // Build a data URL for the fast-loading carousel.
    var carouselDataUrl = logoBlob ? toCarouselDataUrl_(logoBlob) : '';

    // Append to the tracking sheet.
    var sheet = getOrCreateSheet_();
    sheet.appendRow([
      new Date(),
      isPayment ? 'Pay Now' : 'Pledge',
      org, contact, email, phone,
      level, amount, website, message,
      logoUrl,
      carouselDataUrl,
      AUTO_APPROVE ? true : false
    ]);

    // Email the team with the logo attached.
    sendNotification_({
      isPayment: isPayment,
      org: org, contact: contact, email: email, phone: phone,
      level: level, amount: amount, website: website, message: message,
      logoBlob: logoBlob, logoUrl: logoUrl
    });

    return json_({
      status: 'success',
      sponsor: (AUTO_APPROVE && carouselDataUrl)
        ? { name: org, logo: carouselDataUrl, website: website }
        : null
    });
  } catch (err) {
    return json_({ status: 'error', message: String(err) });
  }
}

/* ==== GET: serve the sponsor list to the website ========================= */

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'list';
    if (action !== 'list') {
      return json_({ status: 'error', message: 'Unknown action.' });
    }
    var sheet = getOrCreateSheet_();
    var values = sheet.getDataRange().getValues();
    var sponsors = [];
    // Row 0 is the header. Columns (0-based):
    // 0 Timestamp | 1 Type | 2 Org | 3 Contact | 4 Email | 5 Phone |
    // 6 Level | 7 Amount | 8 Website | 9 Message | 10 Logo URL |
    // 11 Carousel Image | 12 Approved
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      var approved = row[12];
      var logo = row[11];
      var org = row[2];
      var website = row[8];
      if ((approved === true || approved === 'TRUE' || approved === 'true') && logo) {
        sponsors.push({ name: org, logo: logo, website: website });
      }
    }
    return json_(sponsors);
  } catch (err) {
    return json_({ status: 'error', message: String(err) });
  }
}

/* ==== HELPERS ============================================================= */

function sendNotification_(p) {
  var kind = p.isPayment ? 'Sponsorship (Paid via Bloomerang)' : 'Sponsor Pledge';
  var subject = 'New Gala ' + (p.isPayment ? 'Sponsorship' : 'Pledge') + ': ' +
    p.org + (p.amount ? ' ($' + p.amount + ')' : '');

  var intro = p.isPayment
    ? 'A sponsor submitted their logo and is paying through Bloomerang.'
    : 'A new sponsor pledge was submitted through the sponsorship page.';

  var lines = [
    intro,
    '',
    'Type: ' + kind,
    'Organization: ' + p.org,
    'Sponsorship level: ' + (p.level || '(not specified)'),
    'Amount: ' + (p.amount ? '$' + p.amount : '(set in Bloomerang)'),
    'Contact: ' + (p.contact || '(not provided)'),
    'Email: ' + p.email,
    'Phone: ' + (p.phone || '(not provided)'),
    'Website: ' + (p.website || '(not provided)'),
    '',
    'Message:',
    p.message || '(none)',
    '',
    p.logoUrl ? ('Logo (Drive): ' + p.logoUrl) : 'Logo: (not uploaded)',
    '',
    'The logo is attached to this email and, once approved, appears in the',
    'sponsor carousel at sparcsolutions.org/gala.'
  ];

  var options = { name: FROM_NAME, replyTo: p.email };
  if (p.logoBlob) { options.attachments = [p.logoBlob]; }

  var htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#184030;line-height:1.6">' +
    '<h2 style="color:#184030;margin:0 0 12px">New Gala ' +
    (p.isPayment ? 'Sponsorship' : 'Pledge') + '</h2>' +
    '<p style="margin:0 0 12px;color:#587860">' + intro + '</p>' +
    '<table cellpadding="6" style="border-collapse:collapse;font-size:15px">' +
    row_('Type', kind) +
    row_('Organization', p.org) +
    row_('Level', p.level || '&mdash;') +
    row_('Amount', p.amount ? '$' + p.amount : 'Set in Bloomerang') +
    row_('Contact', p.contact || '&mdash;') +
    row_('Email', '<a href="mailto:' + p.email + '">' + p.email + '</a>') +
    row_('Phone', p.phone || '&mdash;') +
    row_('Website', p.website || '&mdash;') +
    row_('Message', (p.message || '&mdash;').replace(/\n/g, '<br>')) +
    '</table>' +
    (p.logoUrl ? '<p style="margin-top:16px"><a href="' + p.logoUrl +
      '" style="color:#B88020">View logo in Google Drive</a></p>' : '') +
    '<p style="margin-top:16px;color:#587860;font-size:13px">' +
    'The logo is attached and, once approved, appears in the sponsor carousel ' +
    'at sparcsolutions.org/gala.</p></div>';
  options.htmlBody = htmlBody;

  MailApp.sendEmail(NOTIFY_EMAILS.join(','), subject,
    lines.join('\n'), options);
}

function row_(label, value) {
  return '<tr>' +
    '<td style="font-weight:bold;vertical-align:top;color:#587860">' + label + '</td>' +
    '<td>' + value + '</td></tr>';
}

function getOrCreateFolder_() {
  var id = PROP.getProperty('FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ }
  }
  var folders = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  var folder = folders.hasNext() ? folders.next()
    : DriveApp.createFolder(DRIVE_FOLDER_NAME);
  PROP.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function getOrCreateSheet_() {
  var id = PROP.getProperty('SHEET_ID');
  var ss;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(SHEET_NAME);
    PROP.setProperty('SHEET_ID', ss.getId());
  }
  var sheet = ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Timestamp', 'Type', 'Organization', 'Contact', 'Email', 'Phone',
      'Sponsorship Level', 'Amount', 'Website', 'Message',
      'Logo (Drive URL)', 'Carousel Image', 'Approved'
    ]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function dataUrlToBlob_(dataUrl, name) {
  var match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!match) { throw new Error('Bad logo data.'); }
  var contentType = match[1];
  var bytes = Utilities.base64Decode(match[2]);
  return Utilities.newBlob(bytes, contentType, name);
}

/* Return a base64 data URL for the carousel. Apps Script has no image-resize
 * API, so we re-encode the original; the client caps upload size, keeping
 * payloads reasonable. */
function toCarouselDataUrl_(blob) {
  var contentType = blob.getContentType() || 'image/png';
  return 'data:' + contentType + ';base64,' +
    Utilities.base64Encode(blob.getBytes());
}

function sanitizeName_(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'logo';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
