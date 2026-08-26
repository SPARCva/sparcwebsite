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

| | Name (copy exactly) |
|---|---|
| Fund | `Gala 2026` |
| Campaign | `An Evening to SPARCle 2026` |
| Appeal | `Gala 2026 - Tickets` |
| Appeal | `Gala 2026 - Sponsorship` |
| Appeal | `Gala 2026 - Raffle` |

One fund and one campaign give a single gala total. The three appeals give the
breakdown by revenue type.

Names use a plain hyphen with a space either side (` - `), **not** an en dash or
em dash. The website sends these strings verbatim, so a dash that looks right
but is a different character will not match. Copy from the table above.

## One-time setup in Bloomerang

This part cannot be done from the repo — it is admin UI work in Bloomerang.

1. **Create the fund.** Settings → Funds → New Fund. Name it `Gala 2026`.
2. **Create the campaign.** Settings → Campaigns → New Campaign. Name it
   `An Evening to SPARCle 2026`.
3. **Create the three appeals** under that campaign, named exactly as above.
4. **Set the defaults on each form.** This is the important step — the form's
   own configuration is authoritative and is what protects you if the website's
   JavaScript is ever blocked, cached stale, or changed. In the Bloomerang form
   builder, open each form and set its default fund, campaign and appeal:

   | Form (widget ID) | Used by | Fund / Campaign | Default appeal |
   |---|---|---|---|
   | `4923392` — event registration | `/gala/` ticket + sponsorship modal, `/gala-register/`, `/gala-sponsorships/`, `/gala-sponsorships-form/` | `Gala 2026` / `An Evening to SPARCle 2026` | `Gala 2026 - Tickets` |
   | `4934656` — raffle | `/gala-raffle-form/` (iframed into `/gala/` and `/gala-sponsorships/`) | `Gala 2026` / `An Evening to SPARCle 2026` | `Gala 2026 - Raffle` |

   Form `4923392` carries both the $100 ticket radio and all seven sponsorship
   level radios, so it cannot have one correct default for every purchase. Set
   its default to Tickets; the website overrides it to Sponsorship when a level
   is selected (see below).

5. **Switch on the website side.** In `js/gala-tracking.js`, change:

   ```js
   var ATTRIBUTION_ENABLED = false;
   ```

   to `true`, then commit and deploy.

6. **Test with one real transaction.** Buy a single $5 raffle ticket and one
   $100 gala ticket, confirm in Bloomerang that each landed on `Gala 2026` with
   the right appeal, then refund both.

Do step 5 only after steps 1–4. Until the fund and appeals exist in Bloomerang,
sending those names with a live payment risks the transaction being rejected,
and these are real donation forms taking real money.

## What the website does

`js/gala-tracking.js` is loaded by `/gala/`, `/gala-register/`,
`/gala-sponsorships/`, `/gala-sponsorships-form/` and `/gala-raffle-form/`.

**Bloomerang attribution.** Bloomerang's JS API exposes chainable setters that
write into the payload every form type posts to `v1/OnlineDonation`:

```js
Bloomerang.Donation.fund(FUND).campaign(CAMPAIGN).appeal(appeal)
```

The module maps each radio ID to a revenue type and stamps the matching appeal:

| Radio ID | Item | Appeal |
|---|---|---|
| `4925440` | 1 Gala Ticket — $100 | Tickets |
| `4925441`–`4925447` | Friend $500 → Event Sponsor $25,000 | Sponsorship |
| `4936704`–`4936706` | 1 / 5 / 15 raffle tickets | Raffle |

It re-stamps on any manual radio change inside the form, not just on the
website's own buttons, so someone who opens the ticket modal and then picks a
sponsorship level is still attributed correctly. Anything unmapped is left
alone, and any error is swallowed — attribution never blocks a payment.

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
`RADIO_TYPES` if the Bloomerang forms are rebuilt (the radio IDs change when
registration options are recreated).

## If you later want per-tier Stripe links instead

The alternative considered was giving each tier its own Stripe payment link, the
way `/monthly/` already does for recurring giving. That gives Stripe-side
separation but takes gala transactions out of Bloomerang, so gift records and
donor acknowledgment would need manual entry or a sync. This approach was chosen
instead to keep the donor CRM intact.
