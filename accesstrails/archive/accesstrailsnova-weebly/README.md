# Access Trails NOVA — Frozen Weebly Archive

**⚠️ This is a frozen archive. Do not edit, "clean up," rewrite, or delete anything in this directory.**

This folder is a complete, verbatim capture of the original Access Trails NOVA
website as it existed on the date below. It is preserved as **primary source
data** for the migration to `sparcsolutions.org/accesstrails`. Every photo,
accessibility score, and paragraph here is original fieldwork that exists
nowhere else — if the Weebly subscription lapses, this archive is the only
surviving copy.

## Provenance

| | |
|---|---|
| **Source site** | https://www.accesstrailsnova.com/ (Weebly) |
| **Author of the research & content** | Andrew O'Dell, SPARC Program Staff |
| **Fieldwork** | Summer 2025, nine parks across four SPARC center areas |
| **Captured on** | 2026-07-13 |
| **Captured by** | Automated mirror for the SPARC `accesstrails` migration |
| **Capture method** | `wget --mirror --page-requisites --adjust-extension --convert-links --no-parent --restrict-file-names=windows` + a full-resolution image sweep |

## What's in here

```
accesstrailsnova-weebly/
├── README.md                 ← this file
├── IMAGE-MANIFEST.csv        ← every archived image: original URL, local file, source page(s), context, sha256
├── www.accesstrailsnova.com/ ← offline-browsable mirror (links rewritten to local paths)
│   ├── index.html … (16 HTML pages)
│   ├── files/                ← Weebly theme CSS/JS
│   └── uploads/…             ← images as referenced by the pages (mix of _orig and resized)
├── raw-html/                 ← the same 16 pages fetched RAW (no link rewriting) —
│                                the unmodified Weebly source, best for verbatim text extraction
└── images-orig/              ← all 66 images at FULL resolution (_orig variant), flat filenames
```

### Pages captured (16 total)

- **Top-level (3):** Home (`index.html`), About the Project (`about-the-project.html`), Contribute a Park Review (`contribute-a-park-review.html`)
- **Centers (4):** `alexandria.html`, `arlington.html`, `leesburg.html`, `mclean.html`
- **Parks (9):** `belle-haven-park`, `huntley-meadows-park`, `martin-luther-king-jr-park` (Alexandria); `bluemont-park`, `glencarlyn-park` (Arlington); `potomac-crossing-park`, `tuscarora-park` (Leesburg); `great-falls-national-park`, `wolf-trap-national-park` (McLean)

This matches the About page's stated scope exactly: nine parks —
**5 Mostly Accessible, 2 Partially Accessible, 2 Mostly Inaccessible.** No tenth
page exists.

### Images

`images-orig/` holds all 66 content images at their full-size `_orig` resolution.
Weebly serves two variants of each upload — a resized `published/` copy and the
full `_orig` original. Where a page only linked the resized copy, the `_orig`
version was fetched anyway so the archive holds the highest resolution available.
Weebly's built-in theme background image is intentionally excluded (it is theme
chrome, not Andrew's content). `IMAGE-MANIFEST.csv` records the original URL,
local filename, which page(s) referenced each image, nearby caption/section
context, and a SHA-256 checksum for integrity verification.

## Notes for the rebuild

- The Weebly pages set every image's `alt` attribute to the placeholder
  `"Picture"`. Real descriptive alt text is written fresh during the rebuild
  (Phase 2), not carried over.
- Per-park lat/lng are embedded in the Weebly `generateMap.php?...&lat=&long=`
  iframe URLs inside the HTML; extract them from `raw-html/` rather than
  re-geocoding.
- Two content discrepancies were found and are being surfaced to Andrew for a
  decision rather than silently "fixed" (see the migration PR): the About
  narrative says "Bluefield Park" where the Arlington page says "Bluemont Park,"
  and the Home page credits "SPARC Programmer" where the About page says
  "Program Staff."

**Do not touch the live Weebly site.** It stays published until an explicit
cutover.
