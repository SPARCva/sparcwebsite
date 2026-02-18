# CLAUDE.md — SPARC Website Codebase Guide

This document describes the structure, conventions, and workflows for the SPARC (Specially Adapted Resource Centers) website. It is intended to orient AI assistants working on this repository.

---

## Project Overview

**Organization:** SPARC — Specially Adapted Resource Centers
**Mission:** Community-integrated day programs for adults with severe and multiple disabilities in Northern Virginia.
**Live site:** [sparcsolutions.org](https://sparcsolutions.org) (CNAME)
**Hosting:** Netlify (auto-deploys from `master` branch)
**Analytics:** Google Analytics 4 (tag `G-PD1XQ0NDCD`)

---

## Technology Stack

- **Pure static HTML** — No build system, no npm, no framework
- **Single shared CSS file:** `/css/styles.css`
- **Single shared JS file:** `/js/main.js`
- **Fonts:** Google Fonts — Montserrat (headings) + Open Sans (body)
- **Donation processing:** Bloomerang (embedded form) + Stripe (payment processor)
- **Email/CRM:** Bloomerang (also used for newsletter delivery)
- **Deployment:** Push to `master` → Netlify auto-deploys

There is no package.json, no bundler, no transpiler, and no test suite. Changes go live as soon as they are pushed to `master`.

---

## Repository Structure

```
sparcwebsite/
├── index.html                  # Home page (main landing page)
├── home.html                   # Redirect wrapper → redirects to /
├── css/
│   └── styles.css              # Global stylesheet (all shared styles)
├── js/
│   └── main.js                 # Global JavaScript
├── images/                     # All site images
│   ├── sponsors/               # Sponsor logos (PNG, SVG, JPG, WebP)
│   ├── gala-photos/            # Gala event photos
│   ├── pancake-breakfast/      # Pancake Breakfast event photos
│   ├── board/                  # Board member photos
│   ├── staff/                  # Staff photos
│   └── sponsorship-logos-compiled/
├── documents/                  # PDFs and internal docs
│   ├── Newsletter-Workflow.md  # How to add newsletters to the site
│   ├── SPARC-2022-Annual-Report.pdf
│   ├── SPARC-2023-Annual-Report.pdf
│   ├── SPARC-2024-Annual-Report.pdf
│   └── sponsor-websites.csv
├── annualreport2025/           # 2025 Annual Report (self-contained)
│   ├── index.html              # Web version of annual report
│   ├── print.html              # Print-optimized version
│   └── [images/PDFs used only by the annual report]
├── videos/                     # Local video files (large files in .gitignore)
├── netlify.toml                # Netlify routing/redirect config
├── CNAME                       # Custom domain: sparcsolutions.org
├── .gitignore                  # Excludes large video files
└── [page directories]/         # One directory per page (see below)
```

### Page Directories

Each page lives at `/<slug>/index.html`, making URLs clean (no `.html` extension needed):

| Directory | URL | Description |
|---|---|---|
| `about/` | `/about/` | Mission, history, values |
| `accessibility/` | `/accessibility/` | WCAG accessibility statement |
| `advocate/` | `/advocate/` | Advocacy action page |
| `annualreport2025/` | `/annualreport2025/` | 2025 Annual Report |
| `bingo/` | `/bingo/` | Bingo event page |
| `blog/` | `/blog/` | Blog / social media feed |
| `board/` | `/board/` | Board of Directors |
| `board-portal/` | `/board-portal/` | Internal board resources |
| `compliance/` | `/compliance/` | ADA compliance information |
| `contact/` | `/contact/` | Contact form |
| `donate/` | `/donate/` | Donation information page |
| `donate-checkout/` | `/donate-checkout/` | Bloomerang donation form (live) |
| `donate-form/` | `/donate-form/` | Alternate donation form |
| `downloads/` | `/downloads/` | Downloadable advocacy letter |
| `events/` | `/events/` | Events overview |
| `financials/` | `/financials/` | Financial transparency |
| `gala/` | `/gala/` | "An Evening to SPARCle" gala page |
| `gala-sponsorships/` | `/gala-sponsorships/` | Gala sponsorship tiers |
| `get-involved/` | `/get-involved/` | Volunteer / get involved |
| `locations/` | `/locations/` | Program location details |
| `news/` | `/news/` | SPARC in the news |
| `newsletter/` | `/newsletter/` | Newsletter archive |
| `participants/` | `/participants/` | Participant & family info |
| `podcast/` | `/podcast/` | The Access Point Podcast |
| `programs/` | `/programs/` | Day program descriptions |
| `raffle-form/` | `/raffle-form/` | Raffle entry form |
| `shop/` | `/shop/` | SPARC swag (links to SquadLocker) |
| `stories/` | `/stories/` | Participant stories |
| `strategic-plan/` | `/strategic-plan/` | SPARC strategic plan |
| `summit/` | `/summit/` | "A Call to Conscience" summit |
| `summit-register/` | `/summit-register/` | Summit registration |
| `summit-sponsor/` | `/summit-sponsor/` | Summit sponsorship |
| `team/` | `/team/` | Staff team page |

---

## Netlify Routing

Defined in `netlify.toml`:

- **Publish directory:** root (`.`)
- **Pretty URLs:** `/*` → `/:splat.html` (status 200) — enables accessing pages without `.html`
- **Home redirect:** `/home` → `/` (301)
- **Root:** `/` → `/home.html` (status 200)

---

## Brand Colors & Design System

All colors are defined as CSS variables in `/css/styles.css`:

```css
--sparc-kelly-green: #4CBB17;       /* Primary accent, decorative use */
--sparc-kelly-green-dark: #3a9212;  /* Hover state for green */
--sparc-royal-blue: #00539B;        /* Primary blue — headings, text */
--sparc-dark-navy: #002B50;         /* Dark accents, footer */
--sparc-soft-gray: #F5F5F5;         /* Section backgrounds */
--sparc-charcoal: #333333;          /* Body text */
```

**Aliases also present in styles.css:**

```css
--primary-blue: #00539B;
--accent-orange: #4CBB17;           /* Kelly Green (named accent-orange for historical reasons) */
--accent-gold: #4CBB17;
```

**Typography:**
- Headings: `Montserrat` (700 weight), loaded from Google Fonts
- Body: `Open Sans` (400/500/600), loaded from Google Fonts
- Heading sizes use `clamp()` for fluid typography (e.g., `h1: clamp(2.5rem, 5vw, 3.5rem)`)

**Spacing:**
- `--section-padding: 80px 0`
- `--container-max: 1200px`
- Max container: `.container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }`

---

## Accessibility Standards

The site targets **WCAG 2.1 Level AA** compliance. Key requirements:

- Color contrast ratio: minimum **4.5:1** for normal text
- All pages include a `<a href="#main-content" class="skip-link">Skip to main content</a>` at the top of `<body>`
- Images must have descriptive `alt` attributes
- Navigation uses semantic `<nav>`, `<header>`, `<main>`, `<footer>` elements
- Keyboard navigation must be functional
- The organization serves people with disabilities — accessibility is not optional

---

## Shared Navigation Structure

Every standard page uses the same navigation. Copy from an existing page and update the `active` class on the current page link. Navigation items:

- **Home** → `/`
- **About** (dropdown): About, Our Team, Board of Directors, Financials, Strategic Plan, SPARC in the News, ADA Compliance
- **Programs** → `/programs/`
- **Locations** → `/locations/`
- **Stories** (dropdown): The Access Point Podcast, Blog, Newsletter
- **Events** (dropdown): An Evening to SPARCle, A Call to Conscience, Bingo
- **Get Involved** (dropdown): Advocate for SPARC, Volunteer, Participants & Families, Join Our Mailing List, Purchase SPARC Swag
- **Donate** → `/donate-checkout/` (styled as `.nav-donate` CTA button)

The mobile menu toggle is handled by `initMobileNav()` in `/js/main.js`.

---

## Page Template Pattern

Every standard page follows this structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <!-- Google Analytics tag (copy exactly) -->
    <!-- meta charset, viewport, description, title -->
    <!-- Google Fonts link -->
    <link rel="icon" type="image/png" href="/images/favicon.png">
    <link rel="stylesheet" href="/css/styles.css">
    <!-- Page-specific <style> block if needed -->
</head>
<body>
    <a href="#main-content" class="skip-link">Skip to main content</a>

    <header class="header">
        <nav class="nav-container">
            <!-- Logo -->
            <!-- nav-menu with all nav items -->
            <!-- mobile-toggle hamburger -->
        </nav>
    </header>

    <main id="main-content">
        <!-- Page content sections -->
    </main>

    <footer class="footer">
        <!-- Footer content -->
    </footer>

    <!-- Mailing list modal (if needed) -->
    <script src="/js/main.js"></script>
    <!-- Page-specific scripts if needed -->
</body>
</html>
```

The Google Analytics snippet must appear at the top of every `<head>`:

```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-PD1XQ0NDCD"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-PD1XQ0NDCD');
</script>
```

---

## JavaScript (`/js/main.js`)

The single JS file initializes these components on `DOMContentLoaded`:

| Function | Purpose |
|---|---|
| `initMobileNav()` | Hamburger menu toggle; close on outside click or link click |
| `initStickyHeader()` | Adds `.scrolled` class to `.header` after 50px scroll |
| `initScrollAnimations()` | IntersectionObserver: adds `.visible` to `.fade-in` elements |
| `initSmoothScroll()` | Smooth scroll for `href="#..."` anchor links |
| `initDonationForm()` | Donation form amount selection (if present on page) |
| `initContactForm()` | Contact form handling (if present on page) |

Use the CSS class `fade-in` on any element to animate it in on scroll.

---

## Annual Report (`/annualreport2025/`)

The annual report is **self-contained** — it has its own inline `<style>` blocks and does not rely on `/css/styles.css`. It also does not include Google Analytics. The directory contains:

- `index.html` — Web/screen version with full interactivity
- `print.html` — Print-optimized version using `@page { size: letter; margin: 0; }` and `.page { width: 8.5in; height: 11in; }` blocks
- Local images (photos, sponsor logos) referenced with relative paths

When editing the annual report, use the same CSS variables as the main site for consistency, but know that they are redeclared inline in the `<style>` block at the top of each file.

---

## Donation System

The primary donation flow uses **Bloomerang** + **Stripe**:

- `/donate-checkout/index.html` embeds the live Bloomerang donation form (ID `4947968`)
- Stripe processes the actual payments (live key embedded in the Bloomerang script)
- The Bloomerang public key is: `pub_0671a94c-634e-11f0-9fbb-06179723032d`
- **Do not modify the Bloomerang embed script** — changes must be made in the Bloomerang admin dashboard

---

## Newsletter Workflow

Newsletters are sent via Bloomerang, which hosts a web version of each email. The workflow (documented in `/documents/Newsletter-Workflow.md`):

1. Send newsletter from Bloomerang
2. Open sent email → click "View in Browser" → copy the URL (format: `https://crm.bloomerang.co/HostedEmail/...`)
3. Add a new card **at the top** of the `newsletters-grid` in `/newsletter/index.html`:

```html
<div class="newsletter-card">
    <div class="newsletter-card-header">
        <h3>Month Year</h3>
        <span>Monthly Update</span>
    </div>
    <div class="newsletter-card-body">
        <ul>
            <li>Highlight from newsletter</li>
            <li>Another highlight</li>
        </ul>
        <a href="BLOOMERANG_URL" target="_blank">
            Read Newsletter
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </a>
    </div>
</div>
```

4. Commit and push

---

## Common Content Update Tasks

### Adding a Blog Post
Edit `/blog/index.html` and add a `.blog-post-card` div.

### Adding a Sponsor Logo
1. Add the image to `/images/sponsors/`
2. Reference it in the relevant page (e.g., `index.html` sponsor carousel, `annualreport2025/index.html`)
3. Sponsor logos in carousels use `.sponsor-slide` containers (200×140px cells, `object-fit: contain`)

### Adding a Team Member or Board Member
Edit `/team/index.html` or `/board/index.html` and add a card. Photos go in `/images/staff/` or `/images/board/`.

### Adding a News Item
Edit `/news/index.html`.

### Updating Events
- Annual gala: `/gala/index.html` and `/gala-sponsorships/index.html`
- Summit: `/summit/index.html`, `/summit-register/index.html`, `/summit-sponsor/index.html`
- Bingo: `/bingo/index.html`

---

## Git Workflow

The `master` branch deploys to Netlify automatically. Development branches follow the pattern `claude/<description>-<session-id>`.

```bash
# Standard workflow
git add <specific-files>
git commit -m "Descriptive commit message"
git push -u origin <branch-name>
```

Commit messages in this repo tend to be descriptive and specific, e.g.:
- `Add Pancake Breakfast section to annual report with sponsors and auction donors`
- `Fix HCA logo, advocate cards bigger, URL-encode HCA filename`
- `Make QTS logo twice as big on annual report`

**Do not use `git add -A` or `git add .`** as the `images/` directory contains many binary files.

---

## Key Conventions

1. **No build step.** Edit HTML/CSS/JS directly. What you commit is what goes live.
2. **Each page is self-contained.** Navigation and footer are duplicated across pages (not templated).
3. **Page-specific styles go in `<style>` blocks** in the `<head>` of that page. Shared/reusable styles go in `/css/styles.css`.
4. **Image paths use absolute root-relative URLs** (e.g., `/images/logo.png`, not `../images/logo.png`).
5. **The annual report is self-contained** — do not link it to `/css/styles.css`.
6. **Accessibility is required.** All images need `alt` text; maintain color contrast; include skip links.
7. **Google Analytics must be on every standard page** (not the annual report or print pages).
8. **The `.nav-donate` class** on the Donate nav link gives it the CTA button styling.
9. **`.fade-in` + IntersectionObserver** is the animation pattern — add the class to elements you want to animate on scroll.
10. **SVG logos** for sponsors should include a background `<rect>` and explicit `width`/`height` attributes to render correctly in browsers.

---

## External Integrations

| Service | Purpose | Notes |
|---|---|---|
| Google Analytics | Site analytics | Tag `G-PD1XQ0NDCD` on all pages |
| Google Fonts | Typography | Montserrat + Open Sans |
| Bloomerang | Donations + CRM + newsletters | Embed script in `/donate-checkout/` |
| Stripe | Payment processing | Via Bloomerang integration |
| SquadLocker | SPARC swag store | External link only |
| Netlify | Hosting + CI/CD | Auto-deploys `master` |
