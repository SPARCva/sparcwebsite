/*
 * photo-gallery.js
 * ----------------
 * Drives a public gallery page (/photogallery/gala, /summit, /life). One script,
 * configured per page by a global set before this file loads:
 *
 *   <script>window.SPARC_GALLERY = { gallery: "gala" };</script>
 *   <div data-gallery-app></div>
 *   <script src="/js/photo-gallery.js" defer></script>
 *
 * It renders:
 *   - a header "scroll" (auto-advancing strip) of the featured photos, kept in
 *     chronological order (taken_at) so the day reads left-to-right;
 *   - year pills (+ "All years");
 *   - a search box that filters by person name or caption (server-side);
 *   - a responsive, lazy-loaded photo grid;
 *   - an accessible lightbox (keyboard nav, focus trap, escape to close).
 *
 * Reads only published photos from the photo-gallery edge function.
 */
(function () {
  "use strict";

  var ENDPOINT = "https://ldxpockcgcxvsrbyhcnt.supabase.co/functions/v1/photo-gallery";
  // Publishable (anon) key — safe in the browser; only routes the request.
  var ANON_KEY = "sb_publishable_3tn2UadRVekIf5Pw6F5z-A_40ZbdvTm";

  var cfg = window.SPARC_GALLERY || {};
  var GALLERY = cfg.gallery;
  var root = document.querySelector("[data-gallery-app]");
  if (!GALLERY || !root) return;

  var state = { years: [], selectedYear: null, q: "", photos: [], featured: [], loading: false };
  var searchTimer = null;
  var scrollTimer = null;

  // ---- helpers --------------------------------------------------------------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.indexOf("on") === 0 && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2), attrs[k]);
        } else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function fmtDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } catch (e) { return ""; }
  }

  function apiUrl() {
    var u = ENDPOINT + "?action=list&gallery=" + encodeURIComponent(GALLERY);
    if (state.selectedYear === "all") u += "&year=all";
    else if (state.selectedYear != null) u += "&year=" + encodeURIComponent(state.selectedYear);
    if (state.q) u += "&q=" + encodeURIComponent(state.q);
    return u;
  }

  function load(initial) {
    state.loading = true;
    render();
    fetch(apiUrl(), {
      headers: { apikey: ANON_KEY, Authorization: "Bearer " + ANON_KEY },
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.loading = false;
        if (!data || !data.ok) { render(); return; }
        if (initial || state.years.length === 0) state.years = data.years || [];
        if (initial && state.selectedYear == null) state.selectedYear = data.selectedYear;
        state.photos = data.photos || [];
        // Keep the header scroll stable across year/search changes on first load.
        if (initial) state.featured = data.featured || [];
        render();
      })
      .catch(function () { state.loading = false; render(); });
  }

  // ---- header scroll --------------------------------------------------------
  function buildScroll() {
    if (!state.featured.length) return null;
    var track = el("div", { class: "pg-scroll-track", role: "list" });
    // Duplicate the sequence so the marquee loops seamlessly.
    [0, 1].forEach(function (pass) {
      state.featured.forEach(function (p) {
        var img = el("img", {
          src: p.thumb_url || p.image_url,
          alt: p.alt_text || p.caption || "SPARC photo",
          loading: "lazy", decoding: "async",
        });
        var item = el("button", {
          class: "pg-scroll-item", role: "listitem", type: "button",
          "aria-hidden": pass === 1 ? "true" : null,
          tabindex: pass === 1 ? "-1" : null,
          title: p.caption || (p.people || []).join(", "),
          onclick: function () { openLightbox(indexOfPhoto(p)); },
        }, [img]);
        if (p.media_type === "video") { item.style.position = "relative"; item.appendChild(playBadge()); }
        if ((p.people || []).length) {
          item.appendChild(el("span", { class: "pg-scroll-name", text: p.people[0] }));
        }
        track.appendChild(item);
      });
    });
    var strip = el("div", { class: "pg-scroll", "aria-label": "Featured photos" }, [track]);
    // Pause on hover / focus for readability.
    strip.addEventListener("mouseenter", function () { track.style.animationPlayState = "paused"; });
    strip.addEventListener("mouseleave", function () { track.style.animationPlayState = "running"; });
    strip.addEventListener("focusin", function () { track.style.animationPlayState = "paused"; });
    strip.addEventListener("focusout", function () { track.style.animationPlayState = "running"; });
    // Duration scales with count so speed is consistent.
    track.style.animationDuration = Math.max(20, state.featured.length * 4) + "s";
    return strip;
  }

  function indexOfPhoto(p) {
    for (var i = 0; i < state.photos.length; i++) if (state.photos[i].id === p.id) return i;
    // Featured photo not in the current filtered grid — show it standalone.
    state.photos = state.photos.concat([p]);
    return state.photos.length - 1;
  }

  // ---- controls -------------------------------------------------------------
  function buildControls() {
    var pills = el("div", { class: "pg-years", role: "tablist", "aria-label": "Filter by year" });
    var opts = [{ label: "All years", val: "all" }].concat(
      state.years.map(function (y) { return { label: String(y), val: y }; })
    );
    opts.forEach(function (o) {
      var active = String(state.selectedYear) === String(o.val) ||
        (state.selectedYear == null && o.val === state.years[0]);
      pills.appendChild(el("button", {
        class: "pg-year" + (active ? " is-active" : ""),
        type: "button", role: "tab", "aria-selected": active ? "true" : "false",
        text: o.label,
        onclick: function () { state.selectedYear = o.val; load(false); },
      }));
    });

    var input = el("input", {
      class: "pg-search-input", type: "search",
      placeholder: "Search by name or caption…",
      "aria-label": "Search photos by person name or caption",
      value: state.q,
    });
    input.addEventListener("input", function (e) {
      var v = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { state.q = v.trim(); load(false); }, 280);
    });
    var search = el("div", { class: "pg-search" }, [
      el("span", { class: "pg-search-icon", "aria-hidden": "true", html: "&#128269;" }),
      input,
    ]);

    return el("div", { class: "pg-controls" }, [pills, search]);
  }

  // ---- per-photo download ---------------------------------------------------
  function extOf(url) {
    var m = url.split("?")[0].match(/\.([a-z0-9]{3,4})$/i);
    return m ? m[1].toLowerCase() : "jpg";
  }
  function safeName(s, fallback) {
    var t = (s || "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 50);
    return t || fallback;
  }
  // Fetch the image and save it (a plain <a download> is ignored for
  // cross-origin URLs, so we download the blob and save that).
  function downloadOne(p, btn) {
    var label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Downloading…"; }
    fetch(p.image_url).then(function (r) { return r.blob(); }).then(function (blob) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = safeName(p.caption, GALLERY + "-photo") + "." + extOf(p.image_url);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = label; }
      window.open(p.image_url, "_blank", "noopener");
    });
  }

  // A play-button overlay for video items.
  function playBadge() {
    return el("span", {
      "aria-hidden": "true", html: "&#9654;",
      style: "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:56px;height:56px;border-radius:50%;background:rgba(0,20,40,.62);color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;padding-left:4px;box-sizing:border-box;pointer-events:none;",
    });
  }

  // ---- grid -----------------------------------------------------------------
  function buildGrid() {
    if (state.loading) return el("div", { class: "pg-empty", text: "Loading photos…" });
    if (!state.photos.length) {
      var msg = state.q
        ? 'No photos match "' + state.q + '". Try another name.'
        : "No photos here yet — check back soon.";
      return el("div", { class: "pg-empty", text: msg });
    }
    var grid = el("div", { class: "pg-grid" });
    state.photos.forEach(function (p, i) {
      var img = el("img", {
        src: p.thumb_url || p.image_url,
        alt: p.alt_text || p.caption || "SPARC photo",
        loading: "lazy", decoding: "async",
      });
      var fig = el("figure", { class: "pg-card" }, [img]);
      if (p.media_type === "video") { fig.style.position = "relative"; fig.appendChild(playBadge()); }
      if (p.caption || (p.people || []).length) {
        fig.appendChild(el("figcaption", { class: "pg-card-cap" }, [
          p.caption ? el("span", { class: "pg-card-caption", text: p.caption }) : null,
          (p.people || []).length ? el("span", { class: "pg-card-people", text: p.people.join(" · ") }) : null,
        ]));
      }
      var btn = el("button", {
        class: "pg-card-btn", type: "button",
        "aria-label": "View photo" + (p.caption ? ": " + p.caption : ""),
        onclick: (function (idx) { return function () { openLightbox(idx); }; })(i),
      }, [fig]);
      grid.appendChild(btn);
    });
    return grid;
  }

  // ---- lightbox -------------------------------------------------------------
  var lb = null, lbIndex = 0, lastFocus = null;
  function openLightbox(i) {
    lbIndex = i;
    lastFocus = document.activeElement;
    if (!lb) buildLightbox();
    lb.hidden = false;
    document.body.style.overflow = "hidden";
    renderLightbox();
    lb.querySelector(".pg-lb-close").focus();
    document.addEventListener("keydown", lbKeys);
  }
  function closeLightbox() {
    if (!lb) return;
    lb.hidden = true;
    document.body.style.overflow = "";
    var vid = lb.querySelector(".pg-lb-video");
    if (vid) vid.src = "";  // stop playback
    document.removeEventListener("keydown", lbKeys);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function step(d) {
    var vid = lb.querySelector(".pg-lb-video");
    if (vid) vid.src = "";  // stop any playing video before moving on
    lbIndex = (lbIndex + d + state.photos.length) % state.photos.length;
    renderLightbox();
  }
  function lbKeys(e) {
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "Tab") {
      // simple focus trap
      var f = lb.querySelectorAll("button");
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function buildLightbox() {
    lb = el("div", { class: "pg-lb", hidden: "hidden", role: "dialog", "aria-modal": "true", "aria-label": "Photo viewer" }, [
      el("button", { class: "pg-lb-close", type: "button", "aria-label": "Close", html: "&times;", onclick: closeLightbox }),
      el("button", { class: "pg-lb-nav pg-lb-prev", type: "button", "aria-label": "Previous photo", html: "&#8249;", onclick: function () { step(-1); } }),
      el("figure", { class: "pg-lb-figure" }, [
        el("img", { class: "pg-lb-img", alt: "" }),
        el("iframe", {
          class: "pg-lb-video", hidden: "hidden", title: "Video",
          allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
          allowfullscreen: "true",
          style: "width:min(90vw,960px);aspect-ratio:16/9;max-height:80vh;border:0;background:#000;border-radius:8px;",
        }),
        el("figcaption", { class: "pg-lb-cap" }),
      ]),
      el("button", { class: "pg-lb-nav pg-lb-next", type: "button", "aria-label": "Next photo", html: "&#8250;", onclick: function () { step(1); } }),
    ]);
    lb.addEventListener("click", function (e) { if (e.target === lb) closeLightbox(); });
    document.body.appendChild(lb);
  }
  function renderLightbox() {
    var p = state.photos[lbIndex];
    if (!p) return;
    var img = lb.querySelector(".pg-lb-img");
    var vid = lb.querySelector(".pg-lb-video");
    var isVideo = p.media_type === "video" && p.video_url;
    if (isVideo) {
      img.hidden = true; img.src = "";
      vid.hidden = false; vid.src = p.video_url;
    } else {
      vid.hidden = true; vid.src = "";
      img.hidden = false;
      img.src = p.image_url;
      img.alt = p.alt_text || p.caption || "SPARC photo";
    }
    var cap = lb.querySelector(".pg-lb-cap");
    cap.innerHTML = "";
    if (p.caption) cap.appendChild(el("span", { class: "pg-lb-caption", text: p.caption }));
    if ((p.people || []).length) cap.appendChild(el("span", { class: "pg-lb-people", text: p.people.join(" · ") }));
    if (p.taken_at) cap.appendChild(el("span", { class: "pg-lb-date", text: fmtDate(p.taken_at) }));
    if (!isVideo) {
      cap.appendChild(el("button", {
        class: "pg-lb-download", type: "button", html: "&#8681; Download photo",
        onclick: function (e) { downloadOne(p, e.currentTarget); },
      }));
    }
    cap.appendChild(el("span", { class: "pg-lb-count", text: (lbIndex + 1) + " of " + state.photos.length }));
  }

  // ---- render ---------------------------------------------------------------
  function render() {
    root.innerHTML = "";
    // The header scroll is intentionally full-bleed; everything else lives in a
    // single centered column (per the site's layout convention).
    var scroll = buildScroll();
    if (scroll) root.appendChild(scroll);
    var inner = el("div", { class: "pg-container" });
    inner.appendChild(buildControls());
    inner.appendChild(buildGrid());
    root.appendChild(inner);
  }

  load(true);
})();
