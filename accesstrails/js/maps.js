/* Access Trails NOVA — per-page MapLibre GL map (OpenFreeMap 'liberty' tiles,
 * matching SPARC's ART app). Progressive enhancement: the map reads the JSON in
 * #at-map-data; the <details> text-list fallback is always present in the DOM,
 * so the page is fully usable without the map or without JS. */
(function () {
  var el = document.getElementById('at-map');
  var dataEl = document.getElementById('at-map-data');
  if (!el || !dataEl || typeof maplibregl === 'undefined') { if (el) el.style.display = 'none'; return; }

  var cfg;
  try { cfg = JSON.parse(dataEl.textContent); } catch (e) { el.style.display = 'none'; return; }

  var RATING = {
    'mostly-accessible': { label: 'Mostly Accessible', color: '#2e7d0e' },
    'partially-accessible': { label: 'Partially Accessible', color: '#b8860b' },
    'mostly-inaccessible': { label: 'Mostly Inaccessible', color: '#b23b30' }
  };

  var map;
  try {
    map = new maplibregl.Map({
      container: 'at-map',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [cfg.center.lng, cfg.center.lat],
      zoom: cfg.center.zoom || 12,
      cooperativeGestures: true
    });
  } catch (e) { el.style.display = 'none'; return; }

  map.on('error', function () { /* keep fallback usable; tile errors are non-fatal */ });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.FullscreenControl(), 'top-right');

  (cfg.points || []).forEach(function (p) {
    var r = RATING[p.rating];
    var color = r ? r.color : '#00539B';

    // marker element: coloured pin + shape ring so rating is not colour-only
    var wrap = document.createElement('div');
    wrap.style.cssText = 'width:22px;height:22px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.4);background:' + color;
    if (p.rating === 'partially-accessible') { wrap.style.background = 'linear-gradient(90deg,' + color + ' 50%,#fff 50%)'; }
    if (p.rating === 'mostly-inaccessible') { wrap.style.background = '#fff'; wrap.style.borderColor = color; wrap.style.boxShadow = '0 0 0 1px ' + color; }

    var ratingText = r ? r.label : (p.kind || '');
    var title = p.href ? '<a href="' + p.href + '" style="font-weight:600;color:#00539B">' + escapeHtml(p.label) + '</a>' : '<strong>' + escapeHtml(p.label) + '</strong>';
    var popupHtml = '<div style="font-family:sans-serif;font-size:14px;line-height:1.4">' + title +
      (ratingText ? '<br><span>' + escapeHtml(ratingText) + '</span>' : '') + '</div>';

    new maplibregl.Marker({ element: wrap })
      .setLngLat([p.lng, p.lat])
      .setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(popupHtml))
      .addTo(map);
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
})();
