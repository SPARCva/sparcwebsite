# Access Trails migration — WORK IN PROGRESS notes (delete before final PR)

Internal handoff notes for the `/accesstrails` rebuild. **Remove this file before opening the final PR.**

## Where we are
- **Phase 0 DONE + MERGED** (PR #137 → `main`): frozen archive at `accesstrails/archive/accesstrailsnova-weebly/` (16 HTML pages, 66 full-res `_orig` images, `IMAGE-MANIFEST.csv`, `raw-html/`, README).
- **Phase 1 IN PROGRESS**: data model written — `data/parks.json` (9 parks), `data/centers.json` (4 centers), `data/site.json` (Home + About verbatim). All content extracted verbatim from `archive/.../raw-html/`.
- **Phases 2–4 TODO** (user approved proceeding through Phase 4; stop before Phase 5 cutover).

## Confirmed decisions
1. **Build in `sparcwebsite`** as the `accesstrails/` subdirectory (NOT a separate repo). Served by Netlify at `/accesstrails/`. Branch: `claude/accesstrails-nova-migration-6ihcwa`.
2. **Per-page maps** (decision #2) — not one combined home map. Still add a MapLibre map per center + per park, each with a text/table fallback.
3. Proceed through Phase 4, then a **new PR** (PR #137 is merged/closed — do not reuse).

## Hosting / deploy model (verified)
- Static site, **Netlify** (`netlify.toml` at repo root), publish = ".". Pretty URLs via redirects (`/*` → `/:splat.html`). So `/accesstrails/alexandria/` = file `accesstrails/alexandria/index.html`.
- Pages are standalone HTML with header/nav/footer **copied inline** (no server includes). Shared assets: `/css/styles.css`, `/js/main.js`, Google Fonts Montserrat + Open Sans, favicon `/images/favicon.png`.
- CDN scripts already used site-wide (jsdelivr, esm.sh) — so loading MapLibre + Supabase from CDN is consistent.

## Reference patterns to mirror
### Brand tokens (`css/styles.css` `:root`)
- `--sparc-kelly-green:#4CBB17` (+`-dark:#3a9212`), `--sparc-royal-blue:#00539B`, `--sparc-dark-navy:#002B50`, `--sparc-soft-gray:#F5F5F5`, `--sparc-charcoal:#333333`.
- `--primary-blue:#00539B`, `--accent-orange:#4CBB17` (green as accent), `--medium-gray:#666`.
- Fonts: `--font-primary:'Open Sans',...`; `--font-heading:'Montserrat',...`. `--container-max:1200px`. Shadows `--shadow-sm/md/lg`.
### Header/nav markup
`<header class="header"><nav class="nav-container">` with `.logo` (`/images/logo.png`), `<ul class="nav-menu">` items using `.nav-link`, dropdowns `.nav-item-dropdown`>`.dropdown-menu`, mobile `.mobile-toggle` with three `<span>`. JS toggling in `/js/main.js` (`initMobileNav`, `initStickyHeader` adds `.scrolled` past 50px). For accesstrails, build a **local sub-nav** (Home / About / Contribute + centers Alexandria/Arlington/Leesburg/McLean) mirroring the Weebly IA, but keep the SPARC header/footer so it feels native. Consider a top link back to sparcsolutions.org.
### Footer markup
`<footer class="footer">` → `.container`>`.footer-grid` with `.footer-about` (logo `/images/SPARC_logo_white.png`, blurb, `.social-links` SVGs: FB/IG/LinkedIn/YouTube/email), two `.footer-links` (Quick Links, Resources), `.footer-contact` (address 1775 Tysons Blvd Fifth Floor, Tysons VA 22102; phone (571) 407-1807; debi@sparcsolutions.org). Copy verbatim from `about/index.html`.
### Maps — MapLibre GL + OpenFreeMap
- ART bundles MapLibre GL and uses OpenFreeMap style **`https://tiles.openfreemap.org/styles/liberty`**. Match that.
- Load MapLibre from CDN (e.g. `https://cdn.jsdelivr.net/npm/maplibre-gl@4/dist/maplibre-gl.js` + css). Verify CSP/Netlify allows `tiles.openfreemap.org` (site has no strict CSP currently).
- Every map REQUIRES a non-map fallback (text/table list of the same parks w/ address + rating + link). Color-code pins by rating but never rely on color alone (label popups).
### Supabase (from `access/` tool — the `access_public_reports`-style reference)
- No-build: client keys pasted into a JS module. **Real project already in use:** `SUPABASE_URL='https://ldxpockcgcxvsrbyhcnt.supabase.co'`, anon key `'sb_publishable_3tn2UadRVekIf5Pw6F5z-A_40ZbdvTm'` (anon/publishable — safe in browser; RLS protects data). Client via `https://esm.sh/@supabase/supabase-js@2`.
- Pattern: `js/supabaseClient.js` exports configured client; `js/dataLayer.*.js` wraps queries; `supabase/migrations/0001_schema.sql`, `0002_rls.sql`, `0003_storage.sql`; `.env.example`; README.
- **Contribute form differs**: public does anonymous INSERT (not read). Write **PROPOSED** migrations only — DO NOT apply via Supabase MCP. Put DDL in PR, await Erica's approval. Table `access_trails_submissions`; Storage bucket for photos; RLS **anon INSERT only** (no select/update/delete for anon). Spam mitigation: honeypot field + client rate-limit (and note a DB-side rate limit option).

## Contribute form fields (rebuild the Weebly form)
- "I found a(n):" radio — *ADA Accessible Park* / *ADA Accessible Park Feature* / *Park that needs an ADA Feature* (required)
- Park name and city (required)
- Description of feature or suggestion (required, textarea)
- May we contact you for follow-up? Yes/No (required)
- Name — first / last (optional)
- Preferred method of contact (required)
- Photo upload, max 20MB
- honeypot (hidden), real `<label>`s, `aria-describedby` hints, accessible error messaging.

## Images — Phase 2 plan
- Source: `archive/accesstrailsnova-weebly/images-orig/<name>_orig.<ext>`.
- Copy to `accesstrails/img/parks/<slug>/<name>.<ext>` (drop `_orig`), site images to `accesstrails/img/site/`.
- **Special rename:** `12287-6593-tuscarora-creek-e30d4a16-5056-a36a-07023c97e013db66_orig.jpg` → `tuscarora-creek.jpg` (Tuscarora hero+thumb).
- Extensions vary — `.jpeg` for img-2581/2584/2742/2743/2746/2757/2760/2762/2763/2771/2775/2776/2777/2781/2782/2783/2785 and img-0593; `.png` for martin-luther2, screenshot-2025-09-18-183456, -183515; rest `.jpg`. parks.json/centers.json/site.json already reference the correct extensions.
- Generate responsive derivatives (400/800/1600w WebP + JPEG fallback), serve via `srcset`. Originals are ≤~900KB each (already modest), but still derive. Tool: `sharp` (node) or ImageMagick/`cwebp` — check availability.
- **Alt text**: write real descriptive alt for all 66; put drafts in PR. Weebly alt was all "Picture".
- Site/home/about images: home center cards img-0431(Alex)/img-0622(Arl)/img-0662(Lees)/img-2763(McLean); Andrew photo img-0432; about intro img-0597/img-0474/img-0480.

## Content flags for PR (do NOT silently fix)
1. **Bluefield vs Bluemont** — About para 2 says "Bluefield Park in Arlington"; real park is Bluemont.
2. **Programmer vs Program Staff** — Home quote "SPARC Programmer"; About "Program Staff". Render Program Staff.
3. **"Conducting improved my understanding…"** — About para 3 likely dropped a word.

## Methodology facts (for About page)
- 6 categories; scoring 1/0 per amenity; visitors center NOT penalized when absent.
- 31-point total across the five required categories (parking 6 + trails 7 + bathrooms 7 + picnic 5 + signage 6 = 31); visitors center max 5 is a non-penalized bonus. Bathrooms weighted heavier.
- Rating bands: <60% mostly inaccessible; 61–75% partially accessible; 76–100% mostly accessible. No park scored 100%.
- Ratings: 5 mostly accessible, 2 partially, 2 mostly inaccessible (matches inventory).

## Ratings (verbatim from center pages)
belle-haven=mostly-inaccessible, huntley-meadows=mostly-accessible, martin-luther-king-jr=partially-accessible, bluemont=mostly-inaccessible, glencarlyn=mostly-accessible, potomac-crossing=mostly-accessible, tuscarora=partially-accessible, great-falls=mostly-accessible, wolf-trap=mostly-accessible.

## External links
- Fairfax County Park Authority accessible trails (Home): `https://www.fairfaxcounty.gov/parks/accessible/trails`
- Leesburg accessible parks PDF (Leesburg page): `https://www.leesburgva.gov/home/showpublisheddocument/42448/638676949121870000` (unwrapped from urldefense Proofpoint redirect).

## Extraction tooling
- Readable-text extractor lived at `scratchpad/extract_text.py` (ephemeral). Re-derive from `archive/.../raw-html/<page>.html` if needed: strip script/style, emit text + `[IMG src]` + `[MAP lat/long]` in document order, tag headings. lat/long also grep-able: `grep -oiE "(lat|long)=[-0-9.]+"`.

## Accessibility bar (Phase 4 — nothing ships until it passes)
WCAG 2.1 AA, axe/Lighthouse zero violations; keyboard operable + visible focus; fix heading hierarchy (Weebly abused h2 for body); rating badges legible w/o color (4.5:1); map text fallback; form labels + aria-describedby + accessible errors; test VoiceOver/NVDA on Home + one park page.

## Final PR requirements
One PR vs `main`, title "Migrate Access Trails NOVA to sparcsolutions.org/accesstrails". Body must include: archive completeness confirmation, the flagged discrepancies, drafted alt text, proposed Supabase DDL, Lighthouse/axe scores. Credit Andrew O'Dell in PR body + a visible credit line on the About page. Also: add `/accesstrails/` to main site nav + sitemap (Phase 5 item — likely defer to cutover, confirm with Erica).
