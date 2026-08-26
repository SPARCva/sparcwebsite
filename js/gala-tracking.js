/* =============================================================================
   SPARC — Gala revenue attribution (Bloomerang fund / campaign / appeal)
   -----------------------------------------------------------------------------
   All gala money moves through Bloomerang EventRegistration widget forms, which
   settle into Bloomerang's own Stripe account. There are no per-item Stripe
   links, so tickets / sponsorships / raffle can only be told apart by the
   Fund, Campaign and Appeal recorded on each transaction.

   Bloomerang's JS API (crm.bloomerang.co/Content/Scripts/Api/Bloomerang-v2.js)
   exposes chainable setters that write into Bloomerang.Data.Donation:

       Bloomerang.Donation.fund(name).campaign(name).appeal(name)

   EventRegistration forms submit through that same Donation payload (the
   widget's own comment notes "EventRegistration.xml sets Donation.Amount =
   getRegistrationAmount() + true impact"), and every form type posts to
   v1/OnlineDonation — so the setters apply to the gala forms too.

   The tracked structure (chosen 2026-08):

       Fund      Gala 2026
       Campaign  An Evening to SPARCle 2026
       Appeals   Gala 2026 - Tickets
                 Gala 2026 - Sponsorship
                 Gala 2026 - Raffle

   Names are plain ASCII (a simple " - " hyphen, not an en/em dash) so that what
   is typed into the Bloomerang admin can be copy-pasted from here and matched
   exactly. A mismatched name is the main failure mode.

   >>> READ BEFORE ENABLING <<<
   ATTRIBUTION_ENABLED is false until the Fund, Campaign and the three Appeals
   above actually exist in Bloomerang. Sending an unrecognised fund name with a
   live payment risks the transaction being rejected, and these are real donation
   forms. Order of operations:

     1. Create the fund / campaign / appeals in Bloomerang (see the setup guide
        at /docs/bloomerang-gala-fund-tracking.md).
     2. Flip ATTRIBUTION_ENABLED to true and deploy.
     3. Make one small live test purchase and confirm the transaction lands on
        the right fund + appeal in Bloomerang, then refund it.

   Google Analytics events and the deep-link handling below do NOT touch the
   payment payload, so they are always active and safe to ship ahead of step 1.
   ========================================================================== */
(function (global) {
  'use strict';

  var ATTRIBUTION_ENABLED = false;

  var FUND = 'Gala 2026';
  var CAMPAIGN = 'An Evening to SPARCle 2026';

  var APPEALS = {
    tickets:     'Gala 2026 - Tickets',
    sponsorship: 'Gala 2026 - Sponsorship',
    raffle:      'Gala 2026 - Raffle'
  };

  /* Radio ID -> revenue type. The appeal is decided per selected radio rather
     than per page, because one form can carry more than one kind of purchase.
     Keep in sync with the LEVELS arrays in /gala-sponsorships/ and
     /gala-sponsorships-form/.

     Tickets, sponsorships and raffle are three SEPARATE Bloomerang forms as of
     2026-08. Verified against the live form definitions on 2026-08-26
     (POST v1/Widget/<id>?ApiKey=<public key>):
       18877440  "…2026 Registration"              — 18879488 (ticket)
       4923392   "…2026 Sponsorship Registration"  — 4925441-4925447
       4930560   "…2026 Registration"              — 4932608-4932610 (raffle) */
  var RADIO_TYPES = {
    '18879488': 'tickets',     // General Admission — $100
    '4925441': 'sponsorship',  // Friend — $500
    '4925442': 'sponsorship',  // Advocate — $1,000
    '4925443': 'sponsorship',  // Partner — $2,500
    '4925444': 'sponsorship',  // Leader — $5,000
    '4925445': 'sponsorship',  // Hero — $7,500
    '4925446': 'sponsorship',  // Champion — $10,000
    '4925447': 'sponsorship',  // Event Sponsor — $25,000
    '4932608': 'raffle',       // 1 raffle ticket — $5
    '4932609': 'raffle',       // 5 raffle tickets — $20
    '4932610': 'raffle'        // 15 raffle tickets — $50
  };

  /* Raffle bundles as sold on /gala/ — used for deep links (?raffle=5) and for
     the GA value on each selection. */
  var RAFFLE_BUNDLES = {
    '1':  { radioId: '4932608', amount: 5,  label: '1 Raffle Ticket' },
    '5':  { radioId: '4932609', amount: 20, label: '5 Raffle Tickets' },
    '15': { radioId: '4932610', amount: 50, label: '15 Raffle Tickets' }
  };

  function typeForRadio(radioId) {
    return RADIO_TYPES[String(radioId || '').trim()] || null;
  }

  /* ---------- Bloomerang readiness ----------
     The widget loader pulls Bloomerang-v2.js asynchronously and only sets
     _isReady once it has initialised, so anything touching Bloomerang.Donation
     has to poll. Same pattern the pages already use to preselect a radio. */
  function whenBloomerangReady(callback, timeoutMs) {
    var step = 250;
    var waited = 0;
    var limit = timeoutMs || 15000;

    (function poll() {
      if (global.Bloomerang && global.Bloomerang._isReady && global.Bloomerang.Donation) {
        callback();
        return;
      }
      waited += step;
      if (waited >= limit) {
        console.warn('[gala-tracking] Bloomerang did not become ready; attribution not applied.');
        return;
      }
      setTimeout(poll, step);
    })();
  }

  /* Stamp fund / campaign / appeal onto the pending Bloomerang donation.
     Safe to call repeatedly — the setters just overwrite Bloomerang.Data. */
  function applyAttribution(type) {
    var appeal = APPEALS[type];
    if (!appeal) {
      console.warn('[gala-tracking] Unknown revenue type "' + type + '"; attribution skipped.');
      return;
    }
    if (!ATTRIBUTION_ENABLED) {
      console.info('[gala-tracking] Attribution is off (ATTRIBUTION_ENABLED=false). Would have set: '
        + FUND + ' / ' + CAMPAIGN + ' / ' + appeal);
      return;
    }
    whenBloomerangReady(function () {
      try {
        global.Bloomerang.Donation.fund(FUND).campaign(CAMPAIGN).appeal(appeal);
      } catch (err) {
        // Never let an attribution problem block someone from paying.
        console.warn('[gala-tracking] Could not set fund/campaign/appeal:', err);
      }
    });
  }

  /* ---------- Google Analytics ---------- */
  function track(type, opts) {
    if (typeof global.gtag !== 'function') { return; }
    var o = opts || {};
    try {
      global.gtag('event', 'select_item', {
        item_list_name: 'Gala 2026 - ' + type,
        items: [{
          item_id: o.radioId || type,
          item_name: o.label || type,
          item_category: type,
          price: o.amount || undefined
        }]
      });
    } catch (err) {
      console.warn('[gala-tracking] gtag event failed:', err);
    }
  }

  /* Single entry point the pages call when a supporter picks something.
     Applies the Bloomerang appeal and records the GA event together, so the two
     can never drift apart. */
  function select(radioId, opts) {
    var type = typeForRadio(radioId);
    if (!type) {
      console.warn('[gala-tracking] No revenue type mapped for radio ' + radioId + '.');
      return null;
    }
    applyAttribution(type);

    var o = opts || {};
    track(type, { radioId: radioId, label: o.label, amount: o.amount });
    return type;
  }

  /* Re-apply attribution whenever the supporter changes the selection inside the
     Bloomerang form by hand, not just via our own buttons. Delegated so it keeps
     working after the widget rebuilds its DOM. */
  function watchForm(root) {
    var scope = root || global.document;
    scope.addEventListener('change', function (e) {
      var el = e.target;
      if (!el || el.type !== 'radio' || !el.id) { return; }
      var type = typeForRadio(el.id);
      if (type) { applyAttribution(type); }
    }, true);
  }

  /* Pages whose form only ever sells one thing (the standalone raffle and
     sponsorship forms) can just declare their type on load. */
  function setPageDefault(type) {
    applyAttribution(type);
    watchForm();
  }

  global.GalaTracking = {
    fund: FUND,
    campaign: CAMPAIGN,
    appeals: APPEALS,
    raffleBundles: RAFFLE_BUNDLES,
    isEnabled: function () { return ATTRIBUTION_ENABLED; },
    typeForRadio: typeForRadio,
    applyAttribution: applyAttribution,
    select: select,
    track: track,
    watchForm: watchForm,
    setPageDefault: setPageDefault
  };
})(window);
