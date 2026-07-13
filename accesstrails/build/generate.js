/* Access Trails NOVA static-site generator.
 * Reads accesstrails/data/*.json and emits every /accesstrails page as static
 * HTML (Netlify serves the repo root, no build step at deploy). Re-run after
 * editing data or partials:  node accesstrails/build/generate.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const D = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f)));
const parksData = D('parks.json').parks;
const centersData = D('centers.json').centers;
const site = D('site.json');
const alt = D('alt.json').alt;

const parkBySlug = Object.fromEntries(parksData.map(p => [p.slug, p]));
const centerBySlug = Object.fromEntries(centersData.map(c => [c.slug, c]));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const RATING_LABEL = {
  'mostly-accessible': 'Mostly Accessible',
  'partially-accessible': 'Partially Accessible',
  'mostly-inaccessible': 'Mostly Inaccessible',
};
const RATING_COLOR = { 'mostly-accessible': '#2e7d0e', 'partially-accessible': '#b8860b', 'mostly-inaccessible': '#b23b30' };

/* shape mark conveys rating independent of colour (full / half / empty ring) */
function ratingMark(rating) {
  const c = 'currentColor';
  if (rating === 'mostly-accessible')
    return `<svg class="at-badge-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="${c}"/></svg>`;
  if (rating === 'partially-accessible')
    return `<svg class="at-badge-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="${c}" stroke-width="2"/><path d="M8 1a7 7 0 0 1 0 14z" fill="${c}"/></svg>`;
  return `<svg class="at-badge-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="${c}" stroke-width="2"/></svg>`;
}
function badge(rating) {
  const label = RATING_LABEL[rating];
  return `<span class="at-badge at-badge--${rating}"><span class="at-badge-mark-wrap" aria-hidden="true">${ratingMark(rating)}</span><span class="at-sr">Accessibility rating: </span>${esc(label)}</span>`;
}

/* responsive <picture>: webp 400/800 + original fallback */
function pic(dir, file, altText, { className = '', sizes = '(max-width: 700px) 100vw, 700px', loading = 'lazy', width, height } = {}) {
  const base = file.replace(/\.[^.]+$/, '');
  const webp400 = `${dir}/${base}-400.webp`;
  const webp800 = `${dir}/${base}-800.webp`;
  const full = `${dir}/${file}`;
  const a = altText != null ? altText : (alt[file] || '');
  const dim = (width ? ` width="${width}"` : '') + (height ? ` height="${height}"` : '');
  return `<picture>
      <source type="image/webp" srcset="${webp400} 400w, ${webp800} 800w" sizes="${esc(sizes)}">
      <img src="${full}" alt="${esc(a)}" loading="${loading}" decoding="async"${dim} class="${className}">
    </picture>`;
}

const GTAG = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-PD1XQ0NDCD"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-PD1XQ0NDCD');</script>`;

function head(title, desc, { map = false } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    ${GTAG}
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="${esc(desc)}">
    <title>${esc(title)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700&family=Open+Sans:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="icon" type="image/png" href="/images/favicon.png">
    <link rel="stylesheet" href="/css/styles.css">
    <link rel="stylesheet" href="/accesstrails/css/accesstrails.css">${map ? `
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css">` : ''}
</head>
<body class="accesstrails">
<a class="at-skip" href="#at-main">Skip to main content</a>`;
}

const HEADER = `
    <header class="header">
        <nav class="nav-container">
            <a href="/" class="logo">
                <img src="/images/logo.png" alt="SPARC - Specially Adapted Resource Centers" style="height: 50px; width: auto;">
            </a>
            <ul class="nav-menu">
                <li><a href="/" class="nav-link">Home</a></li>
                <li><a href="/about/" class="nav-link">About</a></li>
                <li><a href="/programs/" class="nav-link">Programs</a></li>
                <li><a href="/locations/" class="nav-link">Locations</a></li>
                <li><a href="/accesstrails/" class="nav-link active">Access Trails</a></li>
                <li><a href="/get-involved/" class="nav-link">Get Involved</a></li>
                <li><a href="/donate-checkout/" class="nav-link">Donate</a></li>
            </ul>
            <div class="mobile-toggle"><span></span><span></span><span></span></div>
        </nav>
    </header>`;

const FOOTER = `
    <footer class="footer" style="color: white;">
        <div class="container">
            <div class="footer-grid">
                <div class="footer-about">
                    <img src="/images/SPARC_logo_white.png" alt="SPARC" style="height: 60px; width: auto; margin-bottom: 15px;">
                    <p>Specially Adapted Resource Centers provides community-integrated day programs for adults with severe and multiple disabilities in Northern Virginia. We believe every adult deserves a meaningful life filled with connection, purpose, and belonging.</p>
                </div>
                <div class="footer-links">
                    <h3>Access Trails</h3>
                    <ul>
                        <li><a href="/accesstrails/">Guide Home</a></li>
                        <li><a href="/accesstrails/about/">About the Project</a></li>
                        <li><a href="/accesstrails/contribute/">Contribute a Review</a></li>
                        <li><a href="/accesstrails/submissions/">Community Submissions</a></li>
                        <li><a href="/accesstrails/console/">Team Console</a></li>
                    </ul>
                </div>
                <div class="footer-links">
                    <h3>SPARC</h3>
                    <ul>
                        <li><a href="/about/">About Us</a></li>
                        <li><a href="/locations/">Locations</a></li>
                        <li><a href="/donate-checkout/">Donate</a></li>
                        <li><a href="/contact/">Contact Us</a></li>
                    </ul>
                </div>
                <div class="footer-contact">
                    <h3>Contact</h3>
                    <p><strong>Mailing Address:</strong><br>1775 Tysons Blvd., Fifth Floor<br>Tysons, VA 22102</p>
                    <p><strong>Phone:</strong> <a href="tel:571-407-1807" style="color: white;">(571) 407-1807</a></p>
                    <p><a href="mailto:debi@sparcsolutions.org" style="color: white;">debi@sparcsolutions.org</a></p>
                </div>
            </div>
            <p style="text-align:center; margin-top:24px; opacity:.85; font-size:.9rem;">Access Trails NOVA research and photography by Andrew O'Dell, SPARC Program Staff (Summer 2025).</p>
        </div>
    </footer>`;

function subnav(crumbs) {
  const items = crumbs.map((c, i) => {
    const last = i === crumbs.length - 1;
    return last
      ? `<li><span aria-current="page">${esc(c.label)}</span></li>`
      : `<li><a href="${c.href}">${esc(c.label)}</a></li>`;
  }).join('');
  return `<nav class="at-subnav" aria-label="Breadcrumb"><ol>${items}</ol></nav>`;
}

function foot({ map = false } = {}) {
  return `${FOOTER}
    <script src="/js/main.js"></script>${map ? `
    <script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
    <script src="/accesstrails/js/maps.js"></script>` : ''}
</body>
</html>`;
}

function mapData(obj) {
  return `<script type="application/json" id="at-map-data">${JSON.stringify(obj)}</script>`;
}
function mapFallbackTable(points) {
  const rows = points.map(p => `<tr><th scope="row">${p.href ? `<a href="${p.href}">${esc(p.label)}</a>` : esc(p.label)}</th><td>${esc(p.rating ? RATING_LABEL[p.rating] : p.kind || '')}</td><td>${esc(p.address || `${p.lat}, ${p.lng}`)}</td></tr>`).join('');
  return `<details class="at-map-fallback"><summary>View this map as a text list</summary>
    <table class="at-maptable"><caption class="at-muted">Locations shown on the map above</caption>
      <thead><tr><th scope="col">Location</th><th scope="col">Rating</th><th scope="col">Address / coordinates</th></tr></thead>
      <tbody>${rows}</tbody></table></details>`;
}

function write(rel, html) {
  const out = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
}

/* ---------------- HOME ---------------- */
function buildHome() {
  const h = site.home;
  const cards = centersData.map(c => `
        <div class="at-card">
          ${pic(`/accesstrails/img/${c.card_image.startsWith('img-0662') ? 'parks/potomac-crossing' : 'site'}`, c.card_image, null, { sizes: '(max-width:700px) 100vw, 260px' })}
          <div class="at-card-body">
            <h3>${esc(c.name.replace('SPARC ', ''))}</h3>
            <p>${esc(c.location_name)}</p>
            <a class="at-card-link" href="/accesstrails/${c.slug}/">Explore ${esc(c.name.replace('SPARC ', ''))} parks<span class="at-sr"> </span></a>
          </div>
        </div>`).join('');
  const html = head('Access Trails NOVA | SPARC',
    'A guide to ADA accessible parks in Northern Virginia near SPARC centers, based on Summer 2025 fieldwork by SPARC Program Staff.') +
    HEADER +
    subnav([{ label: 'SPARC', href: '/' }, { label: 'Access Trails NOVA' }]) +
    `<main id="at-main" class="at-main">
      <section class="at-hero">
        <div class="at-container">
          <p class="at-hero-eyebrow">NOVA Parks for SPARC Participants</p>
          <h1>Access Trails NOVA</h1>
          <p class="at-tagline">${esc(h.tagline)}</p>
        </div>
      </section>
      <section class="at-section"><div class="at-container">
        <h2>${esc(h.choose_center_heading)}</h2>
        <p class="at-lead">Choose a SPARC center to see the accessible parks nearby, each rated across parking, trails, bathrooms, visitors centers, picnic areas, and signage.</p>
        <div class="at-card-grid">${cards}</div>
        <p style="margin-top:28px"><a class="at-extlink" href="${h.fairfax_link.url}" target="_blank" rel="noopener noreferrer">${esc(h.fairfax_link.label)} <span aria-hidden="true">↗</span></a></p>
      </div></section>
      <section class="at-section" style="background:var(--sparc-soft-gray)"><div class="at-container">
        <figure class="at-quote-block" style="margin:0">
          <blockquote class="at-quote">${esc(h.pull_quote.text)}</blockquote>
          <figcaption class="at-quote-cite">
            ${pic('/accesstrails/img/site', h.pull_quote.photo, alt[h.pull_quote.photo], { sizes: '64px' })}
            <span><span class="at-credit-name">Andrew O'Dell</span><br>SPARC Program Staff</span>
          </figcaption>
        </figure>
      </div></section>
    </main>` +
    foot();
  write('index.html', html);
}

/* ---------------- ABOUT ---------------- */
function buildAbout() {
  const a = site.about;
  const intro = a.intro.map(p => `<p>${esc(p)}</p>`).join('');
  const figs = a.intro_images.map(f => pic('/accesstrails/img/site', f, alt[f], { sizes: '(max-width:700px) 100vw, 220px' })).join('');
  const narr = a.narrative.map(p => `<p>${esc(p)}</p>`).join('');
  const method = a.methodology.sections.map(s => {
    let body = (s.body || []).map(p => `<p>${esc(p)}</p>`).join('');
    if (s.list) body += `<ul>${s.list.map(li => `<li>${esc(li)}</li>`).join('')}</ul>`;
    if (s.body_after) body += s.body_after.map(p => `<p>${esc(p)}</p>`).join('');
    return `<h3>${esc(s.title)}</h3>${body}`;
  }).join('');
  const html = head('About the Project | Access Trails NOVA',
    'How the Access Trails NOVA accessibility guide was researched: methodology, scoring system, and the SPARC Program Staff member behind it.') +
    HEADER +
    subnav([{ label: 'SPARC', href: '/' }, { label: 'Access Trails', href: '/accesstrails/' }, { label: 'About the Project' }]) +
    `<main id="at-main" class="at-main">
      <section class="at-section"><div class="at-container">
        <h1>About the Project</h1>
        <div class="at-prose">${intro}</div>
        <div class="at-figrow">${figs}</div>
        <div class="at-prose">${narr}
          <p><a href="${a.learn_more.url}" target="_blank" rel="noopener noreferrer">${esc(a.learn_more.text)}</a></p>
        </div>
        <div class="at-byline">
          <p class="at-credit-name">${esc(a.byline.name)} — ${esc(a.byline.role)}</p>
          <p class="at-muted" style="margin:0">${esc(a.byline.credentials)}. ${esc(a.byline.fieldwork)}.</p>
        </div>
        <h2 id="project-methodology">${esc(a.methodology.heading)}</h2>
        <div class="at-prose">${method}</div>
        <p class="at-credit-line">All fieldwork, accessibility scoring, photography, and written descriptions in this guide are the work of Andrew O'Dell, SPARC Program Staff, conducted in Summer 2025.</p>
      </div></section>
    </main>` +
    foot();
  write('about/index.html', html);
}

/* ---------------- CENTER PAGES ---------------- */
function buildCenter(c) {
  const parks = c.parks.map(s => parkBySlug[s]);
  const points = [
    { lat: c.lat, lng: c.lng, label: c.name, kind: 'SPARC center', address: c.address },
    ...parks.map(p => ({ lat: p.lat, lng: p.lng, label: p.name, rating: p.rating, href: `/accesstrails/parks/${p.slug}/` })),
  ];
  const grid = parks.map(p => `
        <article class="at-park-card">
          ${pic(`/accesstrails/img/parks/${p.slug}`, p.thumbnail, null, { sizes: '(max-width:700px) 100vw, 340px' })}
          <div class="at-park-card-body">
            <h3><a href="/accesstrails/parks/${p.slug}/">${esc(p.name)}</a></h3>
            ${badge(p.rating)}
          </div>
        </article>`).join('');
  const linksInner = c.external_links.map(l => `<p><a class="at-extlink" href="${l.url}" target="_blank" rel="noopener noreferrer">${esc(l.label)} <span aria-hidden="true">↗</span></a></p>`).join('');
  const notesInner = c.notes.map(n => `<div class="at-note"><h3>${esc(n.heading)}</h3><p><strong>${esc(n.title)}</strong><br>${esc(n.body)}</p></div>`).join('');
  const resources = (linksInner || notesInner)
    ? `<h2>Local resources</h2>${linksInner}${notesInner}` : '';
  const shortName = c.name.replace('SPARC ', '');
  const html = head(`${shortName} | Access Trails NOVA`,
    `Accessible parks near ${esc(c.name)} (${esc(c.location_name)}), rated for wheelchair accessibility by SPARC Program Staff.`, { map: true }) +
    HEADER +
    subnav([{ label: 'SPARC', href: '/' }, { label: 'Access Trails', href: '/accesstrails/' }, { label: shortName }]) +
    `<main id="at-main" class="at-main">
      <section class="at-section"><div class="at-container">
        <h1>${esc(c.name)}</h1>
        <p class="at-lead">${esc(c.location_name)}</p>
        <address class="at-address">${esc(c.address)}</address>
        <figure class="at-map-figure">
          <div class="at-map" id="at-map" role="img" aria-label="Map showing ${esc(c.name)} and its nearby accessible parks" tabindex="0"></div>
          ${mapData({ center: { lat: c.lat, lng: c.lng, zoom: 11 }, points })}
          ${mapFallbackTable(points)}
        </figure>
        ${resources}
        <h2>Parks</h2>
        <div class="at-park-grid">${grid}</div>
      </div></section>
    </main>` +
    foot({ map: true });
  write(`${c.slug}/index.html`, html);
}

/* ---------------- PARK PAGES ---------------- */
function buildPark(p) {
  const c = centerBySlug[p.center];
  const dir = `/accesstrails/img/parks/${p.slug}`;
  const cats = p.categories.map(cat => {
    const scoreHtml = cat.score === null
      ? `<span class="at-score at-score--na" aria-label="Not applicable — parks are not penalized for missing this amenity">N/A</span>`
      : `<span class="at-score" aria-label="Score ${cat.score} out of ${cat.max}">${cat.score}/${cat.max}<span class="at-score-bar" style="--pct:${Math.round(cat.score / cat.max * 100)}%" aria-hidden="true"></span></span>`;
    const body = cat.body.length === 1
      ? `<p>${esc(cat.body[0])}</p>`
      : `<ul>${cat.body.map(b => `<li>${esc(b)}</li>`).join('')}</ul>`;
    const imgs = cat.images.length
      ? `<div class="at-cat-imgs">${cat.images.map(f => pic(dir, f, null, { sizes: '(max-width:700px) 100vw, 340px' })).join('')}</div>` : '';
    return `<section class="at-cat" aria-labelledby="cat-${cat.key}">
        <div class="at-cat-head"><h3 id="cat-${cat.key}">${esc(cat.label)}</h3>${scoreHtml}</div>
        ${body}${imgs}</section>`;
  }).join('');
  const uf = p.unique_feature ? `
      <div class="at-unique">
        <h2>Unique Feature: ${esc(p.unique_feature.title)}</h2>
        <p>${esc(p.unique_feature.body)}</p>
        ${p.unique_feature.images && p.unique_feature.images.length ? `<div class="at-unique-imgs">${p.unique_feature.images.map(f => pic(dir, f, null, { sizes: '220px' })).join('')}</div>` : ''}
      </div>` : '';
  const point = [{ lat: p.lat, lng: p.lng, label: p.name, rating: p.rating }];
  const shortCenter = c.name.replace('SPARC ', '');
  const html = head(`${p.name} | Access Trails NOVA`,
    `Wheelchair accessibility guide for ${esc(p.name)} (${RATING_LABEL[p.rating]}), near ${esc(c.name)}. Parking, trails, bathrooms, picnic areas, and signage rated by SPARC Program Staff.`, { map: true }) +
    HEADER +
    subnav([{ label: 'SPARC', href: '/' }, { label: 'Access Trails', href: '/accesstrails/' }, { label: shortCenter, href: `/accesstrails/${c.slug}/` }, { label: p.name }]) +
    `<main id="at-main" class="at-main">
      <section class="at-section"><div class="at-container">
        <div class="at-park-hero">${pic(dir, p.hero_image, null, { loading: 'eager', sizes: '(max-width:1100px) 100vw, 1060px' })}</div>
        <div class="at-park-head"><h1>${esc(p.name)}</h1>${badge(p.rating)}</div>
        <p class="at-muted">Near <a href="/accesstrails/${c.slug}/">${esc(c.name)}</a></p>
        <figure class="at-map-figure">
          <div class="at-map" id="at-map" role="img" aria-label="Map showing the location of ${esc(p.name)}" tabindex="0"></div>
          ${mapData({ center: { lat: p.lat, lng: p.lng, zoom: 14 }, points: point })}
          ${mapFallbackTable(point)}
        </figure>
        ${uf}
        <h2>Accessibility Ratings</h2>
        <p class="at-muted">Each amenity was scored against an ADA-based checklist. <strong>N/A</strong> means the amenity is absent; parks are not penalized for it. See <a href="/accesstrails/about/#project-methodology">the methodology</a> for how scores were assigned.</p>
        ${cats}
      </div></section>
    </main>` +
    foot({ map: true });
  write(`parks/${p.slug}/index.html`, html);
}

/* ---------------- CONTRIBUTE ---------------- */
function buildContribute() {
  const finds = ['ADA Accessible Park', 'ADA Accessible Park Feature', 'Park that needs an ADA Feature'];
  const findRadios = finds.map((v, i) => `
            <label class="at-choice"><input type="radio" name="find_type" value="${esc(v)}" required${i === 0 ? ' aria-describedby="find_type-err"' : ''}> ${esc(v)}</label>`).join('');
  const html = head('Contribute a Park Review | Access Trails NOVA',
    'Tell SPARC about an accessible park, an accessible park feature, or a park that needs an ADA feature in Northern Virginia.') +
    HEADER +
    subnav([{ label: 'SPARC', href: '/' }, { label: 'Access Trails', href: '/accesstrails/' }, { label: 'Contribute a Park Review' }]) +
    `<main id="at-main" class="at-main">
      <section class="at-section"><div class="at-container">
        <h1>Contribute a Park Review</h1>
        <p class="at-lead">Know an accessible park, a helpful accessible feature, or a park that still needs one? Share it with SPARC and help grow this guide.</p>
        <h2>Share a park or feature</h2>
        <div id="at-form-status" role="status" aria-live="polite"></div>
        <form class="at-form" id="at-contribute" novalidate>
          <fieldset class="at-fieldset">
            <legend>I found a(n): <span class="at-req" aria-hidden="true">*</span></legend>
            ${findRadios}
            <p class="at-error" id="find_type-err" hidden>Please choose one option.</p>
          </fieldset>

          <div class="at-field">
            <label for="park_name">Park name and city <span class="at-req" aria-hidden="true">*</span></label>
            <span class="at-hint" id="park_name-hint">For example: "Potomac Crossing Park, Leesburg".</span>
            <input class="at-input" type="text" id="park_name" name="park_name" required
                   aria-describedby="park_name-hint park_name-err" autocomplete="off">
            <p class="at-error" id="park_name-err" hidden>Please enter the park name and city.</p>
          </div>

          <div class="at-field">
            <label for="description">Description of feature or suggestion <span class="at-req" aria-hidden="true">*</span></label>
            <textarea class="at-textarea" id="description" name="description" required
                      aria-describedby="description-err"></textarea>
            <p class="at-error" id="description-err" hidden>Please add a short description.</p>
          </div>

          <fieldset class="at-fieldset">
            <legend>May we contact you for follow-up? <span class="at-req" aria-hidden="true">*</span></legend>
            <label class="at-choice"><input type="radio" name="may_contact" value="Yes" required aria-describedby="may_contact-err"> Yes</label>
            <label class="at-choice"><input type="radio" name="may_contact" value="No"> No</label>
            <p class="at-error" id="may_contact-err" hidden>Please choose Yes or No.</p>
          </fieldset>

          <div class="at-field">
            <label for="first_name">Name <span class="at-muted">(optional)</span></label>
            <div style="display:flex; gap:12px; flex-wrap:wrap">
              <input class="at-input" style="flex:1; min-width:140px" type="text" id="first_name" name="first_name" placeholder="First" autocomplete="given-name">
              <input class="at-input" style="flex:1; min-width:140px" type="text" id="last_name" name="last_name" placeholder="Last" autocomplete="family-name">
            </div>
          </div>

          <div class="at-field">
            <label for="contact_method">Preferred method of contact <span class="at-req" aria-hidden="true">*</span></label>
            <span class="at-hint" id="contact_method-hint">How should we reach you, and at what email or phone number?</span>
            <select class="at-select" id="contact_method" name="contact_method" required aria-describedby="contact_method-hint contact_method-err" style="margin-bottom:10px">
              <option value="">Choose one…</option>
              <option value="Email">Email</option>
              <option value="Phone call">Phone call</option>
              <option value="Text message">Text message</option>
            </select>
            <input class="at-input" type="text" id="contact_detail" name="contact_detail" placeholder="Email address or phone number" autocomplete="email" aria-label="Email address or phone number">
            <p class="at-error" id="contact_method-err" hidden>Please choose a preferred method of contact.</p>
          </div>

          <div class="at-field">
            <label for="photo">Photo <span class="at-muted">(optional, max 20 MB)</span></label>
            <span class="at-hint" id="photo-hint">A photo of the feature helps us understand it. JPG or PNG.</span>
            <input class="at-input" type="file" id="photo" name="photo" accept="image/*" aria-describedby="photo-hint photo-err">
            <p class="at-error" id="photo-err" hidden>Please choose an image under 20 MB.</p>
          </div>

          <!-- honeypot: hidden from humans; bots that fill it are rejected -->
          <div class="at-honey" aria-hidden="true">
            <label>Leave this field empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
          </div>

          <button class="at-submit" type="submit">Submit review</button>
        </form>
      </div></section>
    </main>` +
    FOOTER +
    `\n    <script src="/js/main.js"></script>\n    <script type="module" src="/accesstrails/js/contribute.js"></script>\n</body>\n</html>`;
  write('contribute/index.html', html);
}

/* ---------------- COMMUNITY SUBMISSIONS (public) ---------------- */
function buildSubmissions() {
  const html = head('Community Submissions | Access Trails NOVA',
    'Accessible parks and features submitted by the Northern Virginia community and published by SPARC.') +
    HEADER +
    subnav([{ label: 'SPARC', href: '/' }, { label: 'Access Trails', href: '/accesstrails/' }, { label: 'Community Submissions' }]) +
    `<main id="at-main" class="at-main">
      <section class="at-section"><div class="at-container">
        <h1>Community Submissions</h1>
        <p class="at-lead">Accessible parks and features shared by the community and reviewed by SPARC. Spotted something we should add? <a href="/accesstrails/contribute/">Contribute a park review</a>.</p>
        <p id="at-sub-status" role="status" aria-live="polite" class="at-muted">Loading community submissions…</p>
        <div id="at-sub-list" class="at-park-grid"></div>
      </div></section>
    </main>` +
    FOOTER +
    `\n    <script src="/js/main.js"></script>\n    <script type="module" src="/accesstrails/js/submissions.js"></script>\n</body>\n</html>`;
  write('submissions/index.html', html);
}

/* ---------------- TEAM CONSOLE (staff, auth-gated) ---------------- */
function buildConsole() {
  const html = head('Team Console | Access Trails NOVA',
    'SPARC staff console for reviewing Access Trails community submissions.') +
    HEADER +
    subnav([{ label: 'SPARC', href: '/' }, { label: 'Access Trails', href: '/accesstrails/' }, { label: 'Team Console' }]) +
    `<main id="at-main" class="at-main">
      <section class="at-section"><div class="at-container">
        <h1>Team Console</h1>
        <div id="at-console-status" role="status" aria-live="polite"></div>

        <div id="at-console-auth" hidden>
          <p class="at-lead">Sign in with your email and password to review submissions. First time here? Enter your email, choose a password, and select <strong>Create a password</strong>. Your email must already be on the team roster — ask Erica or Andrew to add you.</p>
          <p id="at-signin-note" class="at-muted"></p>
          <form id="at-signin-form" class="at-form">
            <div class="at-field">
              <label for="at-signin-email">Email address</label>
              <input class="at-input" type="email" id="at-signin-email" name="email" autocomplete="email" required>
            </div>
            <div class="at-field">
              <label for="at-signin-password">Password</label>
              <span class="at-hint" id="at-signin-pw-hint">At least 8 characters.</span>
              <input class="at-input" type="password" id="at-signin-password" name="password" autocomplete="current-password" aria-describedby="at-signin-pw-hint" minlength="8" required>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="at-submit" type="submit">Log in</button>
              <button class="at-btnlink" type="button" id="at-create-password">Create a password</button>
            </div>
            <p id="at-signin-msg" class="at-muted" role="status" aria-live="polite" style="margin-top:10px"></p>
          </form>
        </div>

        <div id="at-console-app" hidden>
          <p style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;justify-content:space-between">
            <span id="at-console-who"></span>
            <button type="button" id="at-signout" class="at-btnlink" style="background:var(--medium-gray)">Sign out</button>
          </p>

          <h2>Submissions</h2>
          <div id="at-console-subs" aria-live="polite"></div>

          <div id="at-console-roster" hidden>
            <h2>Team roster</h2>
            <p class="at-muted">Admins can authorize anyone — SPARC staff or community volunteers — to review submissions. Added emails can sign in with a magic link. This is the shared SPARC Access roster.</p>
            <form id="at-roster-form" class="at-form" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
              <div class="at-field" style="flex:2;min-width:200px;margin:0">
                <label for="at-roster-email">Email to authorize</label>
                <input class="at-input" type="email" id="at-roster-email" required autocomplete="off">
              </div>
              <div class="at-field" style="flex:1;min-width:130px;margin:0">
                <label for="at-roster-role">Role</label>
                <select class="at-select" id="at-roster-role">
                  <option value="contributor">contributor</option>
                  <option value="editor">editor</option>
                  <option value="admin">admin</option>
                </select>
              </div>
              <div class="at-field" style="flex:1;min-width:130px;margin:0">
                <label for="at-roster-name">Name (optional)</label>
                <input class="at-input" type="text" id="at-roster-name" autocomplete="off">
              </div>
              <button class="at-submit" type="submit">Add person</button>
            </form>
            <ul id="at-roster-list" style="list-style:none;padding:0;margin-top:16px"></ul>
          </div>
        </div>
      </div></section>
    </main>` +
    FOOTER +
    `\n    <script type="module" src="/accesstrails/js/console.js"></script>\n</body>\n</html>`;
  write('console/index.html', html);
}

buildHome();
buildAbout();
buildContribute();
buildSubmissions();
buildConsole();
centersData.forEach(buildCenter);
parksData.forEach(buildPark);
console.log('generated: home, about, contribute, submissions, console, 4 centers, 9 parks');
