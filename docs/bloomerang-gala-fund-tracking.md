# Gala fund tracking in Bloomerang

How gala revenue is split apart for reporting, what the website does
automatically, and the one-time setup that has to happen inside Bloomerang
before it is switched on.

## Why this exists

Every gala payment — tickets, sponsorships, raffle — runs through Bloomerang
EventRegistration widget forms, which settle into Bloomerang's own Stripe
account (`pk_live_iZYX…`, shared with the sitewide donate forms). There are no
per-item Stripe payment links, so Stripe itself cannot tell a $100 gala ticket
from a $10,000 sponsorship.

The only thing that *can* separate them is the Fund, Campaign and Appeal
recorded on each Bloomerang transaction. That is what this setup establishes.

## The structure

| | Name (copy exactly) | Bloomerang ID |
|---|---|---|
| Fund | `Gala 2026` | 18870272 |
| Campaign | `An Evening To SPARCle 2026` | 4915201 |
| Appeal | `Gala - Tickets` | 18871296 |
| Appeal | `Gala - Sponsorship` | 18872320 |
| Appeal | `Gala - Raffle` | 18873344 |

**These already exist in Bloomerang.** Every name and ID above was read from the
live API (`GET /funds`, `/campaigns`, `/appeals`) on 26 Aug 2026, not from a
plan. Note the campaign has a capital **T** in "To", and the appeals are
`Gala - X`, *not* `Gala 2026 - X`. Both were written the other way in an earlier
draft of this document; creating the names as they were written there would have
produced a second, duplicate set alongside the real ones.

One fund and one campaign give a single gala total. The three appeals give the
breakdown by revenue type.

Names use a plain hyphen with a space either side (` - `), **not** an en dash or
em dash. The website sends these strings verbatim, so a dash that looks right
but is a different character will not match. Copy from the table above.

## One-time setup in Bloomerang

This part cannot be done from the repo — it is admin UI work in Bloomerang.

1. **Confirm the fund exists.** Settings → Funds. `Gala 2026` (18870272)
   should already be there. Only create it if it is genuinely missing.
2. **Confirm the campaign exists.** Settings → Campaigns.
   `An Evening To SPARCle 2026` (4915201).
3. **Confirm the three appeals exist** under that campaign, with the exact
   names and IDs in the table above. Do not create new ones to match a
   different spelling — fix the spelling here instead.
4. **Set the defaults on each form.** This is the important step — the form's
   own configuration is authoritative and is what protects you if the website's
   JavaScript is ever blocked, cached stale, or changed. In the Bloomerang form
   builder, open each form and set its default fund, campaign and appeal:

   | Form (widget ID) | Used by | Fund / Campaign | Default appeal |
   |---|---|---|---|
   | `18877440` — ticket registration | `/gala/` registration modal, `/gala-register/` | `Gala 2026` / `An Evening To SPARCle 2026` | `Gala - Tickets` |
   | `4923392` — sponsorship registration | `/gala/` sponsorship modal, `/gala-sponsorships/`, `/gala-sponsorships-form/` | `Gala 2026` / `An Evening To SPARCle 2026` | `Gala - Sponsorship` |
   | `4930560` — raffle | `/gala-raffle-form/` (iframed into `/gala/` and `/gala-sponsorships/`), `/raffle/`, `/raffle-form/` | `Gala 2026` / `An Evening To SPARCle 2026` | `Gala - Raffle` |

   Since 2026-08 each revenue type has its own form, so each one has a single
   correct default appeal — set it on all three and the attribution holds even
   if the website's JavaScript never runs.

5. **Switch on the website side.** In `js/gala-tracking.js`, change:

   ```js
   var ATTRIBUTION_ENABLED = false;
   ```

   to `true`, then commit and deploy.

6. **Test with one real transaction.** Buy a single $5 raffle ticket, confirm
   in Bloomerang that it landed on `Gala 2026` with the `- Raffle` appeal, then
   refund it.

Do step 5 only after steps 1–4. Until the fund and appeals exist in Bloomerang,
sending those names with a live payment risks the transaction being rejected,
and these are real donation forms taking real money.

## What the website does

`js/gala-tracking.js` is loaded by `/gala/`, `/gala-register/`,
`/gala-sponsorships/`, `/gala-sponsorships-form/`, `/gala-raffle-form/`,
`/raffle/` and `/raffle-form/`.

**Bloomerang attribution.** Bloomerang's JS API exposes chainable setters that
write into the payload every form type posts to `v1/OnlineDonation`:

```js
Bloomerang.Donation.fund(FUND).campaign(CAMPAIGN).appeal(appeal)
```

The module maps each radio ID to a revenue type and stamps the matching appeal:

| Radio ID | Form | Item | Appeal |
|---|---|---|---|
| `18879488` | `18877440` | General Admission — $100 | Tickets |
| `4925441`–`4925447` | `4923392` | Friend $500 → Event Sponsor $25,000 | Sponsorship |
| `4932608`–`4932610` | `4930560` | 1 / 5 / 15 raffle tickets | Raffle |

It re-stamps on any manual radio change inside the form, not just on the
website's own buttons. Anything unmapped is left alone, and any error is
swallowed — attribution never blocks a payment.

**Google Analytics.** Each selection fires a GA4 `select_item` event carrying
the item name, category and price, so the web funnel breaks down the same way
the Bloomerang appeals do. This is independent of `ATTRIBUTION_ENABLED` and is
already live.

**Deep links.** Each ask now has its own URL, so an emailed or posted link is
attributable on arrival:

| URL | Opens |
|---|---|
| `/gala/?tier=ticket` | Ticket form |
| `/gala/?raffle=1` · `?raffle=5` · `?raffle=15` | Raffle form, that bundle preselected |
| `/gala/?level=Hero` | Sponsorship form, that level preselected |

Add UTM parameters on top for channel reporting, e.g.
`/gala/?tier=ticket&utm_source=newsletter&utm_medium=email&utm_campaign=gala2026`.

## Next year

Copy the fund, campaign and appeal names with the new year, update `FUND`,
`CAMPAIGN` and `APPEALS` at the top of `js/gala-tracking.js`, and refresh
`RADIO_TYPES` if the Bloomerang forms are rebuilt — the widget AND radio IDs
both change when registration options are recreated, as they did in 2026-08
when tickets, sponsorships and raffle were split into three separate forms.
The widget IDs are embedded per page; grep for `widget-js` to find them all.

## If you later want per-tier Stripe links instead

The alternative considered was giving each tier its own Stripe payment link, the
way `/monthly/` already does for recurring giving. That gives Stripe-side
separation but takes gala transactions out of Bloomerang, so gift records and
donor acknowledgment would need manual entry or a sync. This approach was chosen
instead to keep the donor CRM intact.
