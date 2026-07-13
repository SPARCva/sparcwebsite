/* =============================================================================
   SPARC — Gala Sponsor Carousel + Pledge helper
   -----------------------------------------------------------------------------
   Shared by:
     • /gala-sponsor-pledge/  (the pledge submission page)
     • /gala/                 (the main gala page sponsor carousel)

   Sponsors submitted through the pledge page are stored by a Google Apps Script
   web app (see /gala-sponsor-pledge/pledge-backend.gs). This file pulls that
   list and injects each uploaded logo into a running marquee carousel, so a
   newly pledged sponsor's logo appears on the webpage automatically.

   >>> ONE-TIME SETUP <<<
   After deploying pledge-backend.gs as a web app, paste its /exec URL into
   GALA_SPONSORS_API below. Until then the dynamic sponsors simply won't load
   (the static, hand-curated logos keep working).
   ========================================================================== */
(function (global) {
  'use strict';

  var GALA_SPONSORS_API = 'https://script.google.com/macros/s/AKfycbyGrTkUFa-EW77MeiMP_lBRioXyY6o5LTRVVCZ47RzZNXMlREn9KAZb2YcCaqSbwr4qeg/exec';

  function isConfigured() {
    return GALA_SPONSORS_API && GALA_SPONSORS_API.indexOf('http') === 0;
  }

  /* Fetch the approved, publicly-listable sponsors from the backend.
     Resolves to [] on any error so the carousel degrades gracefully. */
  function fetchSponsors() {
    if (!isConfigured()) {
      return Promise.resolve([]);
    }
    return fetch(GALA_SPONSORS_API + '?action=list', { method: 'GET' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var list = Array.isArray(data) ? data : (data && data.sponsors) || [];
        return list.filter(function (s) { return s && s.logo; });
      })
      .catch(function (err) {
        console.warn('[gala-sponsors] Could not load sponsor list:', err);
        return [];
      });
  }

  /* Build a single carousel slide for a sponsor record.
     record = { name, logo (data URL or image URL), website } */
  function buildSlide(record) {
    var slide = document.createElement('div');
    slide.className = 'sponsor-slide';

    var img = document.createElement('img');
    img.src = record.logo;
    img.alt = record.name || 'Gala sponsor';
    img.loading = 'lazy';

    if (record.website) {
      var link = document.createElement('a');
      var href = record.website;
      if (!/^https?:\/\//i.test(href)) { href = 'https://' + href; }
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.appendChild(img);
      slide.appendChild(link);
    } else {
      slide.appendChild(img);
    }
    return slide;
  }

  /* Start (or restart) the continuous marquee scroll on a track element.
     Measures real content width so it works no matter how many logos there
     are or how wide each logo renders. */
  function animateTrack(track) {
    if (track._galaRAF) {
      cancelAnimationFrame(track._galaRAF);
    }
    var halfWidth = track.scrollWidth / 2; // track holds two identical halves
    if (!halfWidth) { return; }

    var position = 0;
    var speed = 0.8; // px per 60fps frame
    var paused = false;
    var lastTime = performance.now();

    track.style.willChange = 'transform';
    track.addEventListener('mouseenter', function () { paused = true; });
    track.addEventListener('mouseleave', function () { paused = false; });

    function step(now) {
      var delta = now - lastTime;
      lastTime = now;
      if (!paused) {
        position -= speed * (delta / 16.67);
        if (Math.abs(position) >= halfWidth) { position = 0; }
        track.style.transform = 'translate3d(' + position + 'px, 0, 0)';
      }
      track._galaRAF = requestAnimationFrame(step);
    }
    track._galaRAF = requestAnimationFrame(step);
  }

  function resolveTrack(t) {
    return typeof t === 'string' ? document.querySelector(t) : t;
  }

  /* Initialise a sponsor carousel.
     opts.track   - CSS selector or element for the .sponsor-track
     opts.section - (optional) selector/element to hide when there's nothing
                    at all to show
     Returns a Promise that resolves once dynamic sponsors are loaded. */
  function initCarousel(opts) {
    opts = opts || {};
    var track = resolveTrack(opts.track);
    if (!track) { return Promise.resolve(); }

    // Capture the slides already in the HTML as the canonical, curated set
    // (only once — a re-init must not treat cloned slides as canonical).
    if (!track._canonical) {
      track._canonical = Array.prototype.slice.call(track.children);
    }
    track._dynamic = track._dynamic || [];

    return fetchSponsors().then(function (sponsors) {
      track._dynamic = sponsors;
      render(track);

      var section = resolveTrack(opts.section);
      if (section && track.children.length === 0) {
        section.style.display = 'none';
      }
    });
  }

  /* Prepend a sponsor record and re-render immediately (optimistic update
     for a just-submitted logo, before the backend list refreshes). */
  function addSponsor(track, record) {
    track = resolveTrack(track);
    if (!track || !record || !record.logo) { return; }
    if (!track._canonical) {
      track._canonical = Array.prototype.slice.call(track.children);
    }
    track._dynamic = [record].concat(track._dynamic || []);
    render(track);
  }

  /* Replace the track contents with one set of slides plus a duplicate set
     for a seamless loop, then (re)start the animation. */
  function render(track) {
    var base = (track._canonical || []).slice();
    (track._dynamic || []).forEach(function (rec) { base.push(buildSlide(rec)); });

    track.innerHTML = '';
    base.forEach(function (node) { track.appendChild(node.cloneNode(true)); });
    // Duplicate for the seamless wrap-around.
    base.forEach(function (node) { track.appendChild(node.cloneNode(true)); });

    // Wait a frame so layout (scrollWidth) is accurate, then animate.
    requestAnimationFrame(function () { animateTrack(track); });
  }

  global.GalaSponsors = {
    apiUrl: GALA_SPONSORS_API,
    isConfigured: isConfigured,
    fetchSponsors: fetchSponsors,
    initCarousel: initCarousel,
    addSponsor: addSponsor
  };
})(window);
