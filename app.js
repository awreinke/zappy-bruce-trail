/* Zappy's Bruce Trail side-trail tracker: map, hike details, list and photos. Everything is read from data/. */
(async function () {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const getJSON = (u, d) => fetch(u + '?v=' + Date.now()).then(r => r.ok ? r.json() : d).catch(() => d);
  const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const setHdr = () => document.documentElement.style.setProperty('--hdr', $('#hdr').offsetHeight + 'px');
  setHdr(); addEventListener('resize', setHdr);

  const [hikes, segs, routes, mainTrail, prog, manual] = await Promise.all([
    getJSON('data/hikes.json', []), getJSON('data/side_trails.json', []), getJSON('data/routes.geojson', { features: [] }),
    getJSON('data/main_trail.json', []), getJSON('data/progress.json', { trips: [], photos: [], covered: {} }), getJSON('data/manual.json', { hikes: {} })
  ]);
  const byNum = Object.fromEntries(hikes.map(h => [h.hike, h]));
  const routeOf = Object.fromEntries(routes.features.map(f => [f.properties.hike, f.geometry.coordinates]));
  // covered side-trail segments: from uploaded tracks, plus any hikes marked done by hand in data/manual.json
  const covered = { ...(prog.covered || {}) };
  for (const [n, d] of Object.entries(manual.hikes || {})) for (const s of segs) if (s.hike == n && !covered[s.oid]) covered[s.oid] = d;
  const segsOf = {}; for (const s of segs) if (s.hike) (segsOf[s.hike] ||= []).push(s);
  const status = n => {
    const ss = segsOf[n] || []; const tot = ss.reduce((a, s) => a + s.km, 0);
    const got = ss.filter(s => covered[s.oid]); const km = got.reduce((a, s) => a + s.km, 0);
    const frac = tot ? km / tot : 0; const dates = got.map(s => covered[s.oid]).sort();
    return { frac, km, tot, state: frac >= 0.9 ? 'done' : frac > 0 ? 'partial' : 'todo', date: dates[dates.length - 1] || null, first: dates[0] || null };
  };
  const trips = prog.trips || [], photos = (prog.photos || []).filter(p => p.file);
  const tripsOf = n => trips.filter(t => (t.hikes || []).includes(n));
  const photosOf = n => { const ids = new Set(tripsOf(n).map(t => t.id)); return photos.filter(p => ids.has(p.trip)); };

  // ---------------- header progress
  const planned = segs.filter(s => s.status === 'planned');
  const plannedKm = planned.reduce((a, s) => a + s.km, 0);
  const doneKm = planned.filter(s => covered[s.oid]).reduce((a, s) => a + s.km, 0);
  const bonusKm = segs.filter(s => s.status !== 'planned' && covered[s.oid]).reduce((a, s) => a + s.km, 0);
  const nDone = hikes.filter(h => status(h.hike).state === 'done').length;
  const last = trips.length ? trips[trips.length - 1].date : null;
  $('#bar').style.width = (100 * doneKm / plannedKm).toFixed(1) + '%';
  $('#progtext').textContent = `${doneKm.toFixed(1)} of ${plannedKm.toFixed(0)} km of planned side trails (${(100 * doneKm / plannedKm).toFixed(1)}%) · ` +
    `${nDone} of ${hikes.length} hikes done` + (bonusKm > 0.05 ? ` · +${bonusKm.toFixed(1)} km bonus` : '') +
    ` · ${photos.length} photo${photos.length === 1 ? '' : 's'}` + (last ? ` · last hike ${fmtDate(last)}` : '');

  let current = null;
  // ---------------- map
  const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([44.2, -80.4], 7);
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: 'Map data © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' });
  osm.addTo(map);
  const ll = c => c.map(([x, y]) => [y, x]);
  const rend = L.canvas({ padding: 0.3, tolerance: 6 });
  const mainL = L.polyline(ll(mainTrail), { renderer: rend, color: '#8a7b62', weight: 2.5, opacity: 0.8, interactive: false }).addTo(map);
  const segStyle = s => covered[s.oid] ? { color: css('--green'), weight: 5, opacity: 0.95, dashArray: null }
    : s.status === 'planned' ? { color: css('--blue'), weight: 3.5, opacity: 0.9, dashArray: null }
    : s.status === 'nodog' ? { color: css('--red'), weight: 2.5, opacity: 0.9, dashArray: '5 5' }
    : { color: css('--grey'), weight: 2, opacity: 0.8, dashArray: '2 5' };
  const sideL = L.layerGroup(segs.map(s => {
    const why = s.status === 'nodog' ? 'no dogs allowed' : s.status === 'skipped' ? 'not in the plan' : `hike ${s.hike}`;
    return L.polyline(ll(s.coords), { renderer: rend, ...segStyle(s) })
      .bindTooltip(`${esc(s.name)} · ${(s.km * 1000).toFixed(0)} m · ${why}${covered[s.oid] ? ' · walked ' + fmtDate(covered[s.oid]) : ''}`, { sticky: true })
      .on('click', () => s.hike && select(s.hike));
  })).addTo(map);
  const trackL = L.layerGroup().addTo(map);
  const selL = L.layerGroup().addTo(map);
  const hikeIcon = (n, sel) => L.divIcon({ className: '', iconSize: [24, 24], html: `<div class="hkw"><div class="hk ${status(n).state}${sel ? ' sel' : ''}">${n}</div></div>` });
  const markers = {};
  const hikeL = L.layerGroup(hikes.map(h => (markers[h.hike] = L.marker([h.lat, h.lon], { icon: hikeIcon(h.hike), riseOnHover: true, title: `Hike ${h.hike}` })
    .bindTooltip(`<b>Hike ${h.hike}</b> · Day ${h.day}${h.stops > 1 ? ` (stop ${h.stop}/${h.stops})` : ''} · ${h.mi} mi<br>${esc(h.trails)}`, { direction: 'top', offset: [0, -10] })
    .on('click', () => select(h.hike))))).addTo(map);
  const photoL = L.layerGroup();
  const photoIdx = photos.filter(p => p.lat != null);
  photoIdx.forEach(p => L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', iconSize: [36, 36], html: `<div class="ph" style="background-image:url('${p.thumb}')"></div>` }) })
    .on('click', () => openLB(photos, photos.indexOf(p))).addTo(photoL));
  const showPhotos = () => { if (map.getZoom() >= 12 || current) photoL.addTo(map); else photoL.remove(); };
  const zoomStyle = () => { map.getContainer().classList.toggle('small', map.getZoom() < 9); if (map.getZoom() >= 12) mainL.remove(); else if (!map.hasLayer(mainL) && mainOn) mainL.addTo(map); };
  let mainOn = true; map.on('overlayadd overlayremove', e => { if (e.layer === mainL) mainOn = e.type === 'overlayadd'; });
  map.on('zoomend', () => { showPhotos(); zoomStyle(); });
  map.fitBounds(L.latLngBounds(hikes.map(h => [h.lat, h.lon])), { padding: [20, 20] }); zoomStyle();
  L.control.layers({ 'Street map': osm, 'Topographic': topo, 'Satellite': sat },
    { 'Hikes (parking)': hikeL, 'Side trails': sideL, "Zappy's GPS tracks": trackL, 'Photos': photoL, 'Main Bruce Trail': mainL }, { collapsed: true }).addTo(map);
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => { const d = L.DomUtil.create('div', 'legend'); d.innerHTML =
    `<div><i style="border-color:${css('--green')};border-top-width:5px"></i>Walked with Zappy</div>
     <div><i style="border-color:${css('--blue')}"></i>Planned side trail</div>
     <div><i class="dash" style="border-color:${css('--grey')}"></i>Skipped (short or road)</div>
     <div><i class="dash" style="border-color:${css('--red')}"></i>No dogs allowed</div>
     <div><i style="border-color:${css('--orange')}"></i>GPS track</div>
     <div><span class="dot"></span>Hike to do <span class="dot" style="background:${css('--orange')};border-color:#fff"></span>Started <span class="dot" style="background:${css('--green')};border-color:#fff"></span>Done</div>`;
    L.DomEvent.disableClickPropagation(d); return d; };
  legend.addTo(map);
  if (window.innerWidth < 760) legend.remove();
  // walked GPS tracks (loaded after the page is up)
  const trackCache = {};
  Promise.all(trips.map(t => getJSON(t.track, null).then(tr => {
    if (!tr) return; trackCache[t.id] = tr;
    L.polyline(ll(tr.coords), { renderer: rend, color: css('--orange'), weight: 3, opacity: 0.9 })
      .bindTooltip(`${esc(t.name)} · ${fmtDate(t.date)} · ${t.km} km`, { sticky: true }).addTo(trackL);
  })));

  // ---------------- hike panel
  const feeChip = f => !f || !f.fee_label ? '' : `<span class="chip ${f.fee_status === 'paid' ? 'paid' : f.fee_status === 'free' ? 'free' : ''}" title="${esc(f.fee_detail || '')}">${f.fee_status === 'paid' ? '$ ' : ''}${esc(f.fee_label)}</span>`;
  const trl = ts => (ts || []).map(t => t.replace(' Side Trail', '')).join(', ') || 'connecting trail only';
  function select(n, fly = true) {
    const h = byNum[n]; if (!h) return;
    if (current && markers[current]) markers[current].setIcon(hikeIcon(current));
    current = n; markers[n].setIcon(hikeIcon(n, true)); markers[n].setZIndexOffset(1000);
    history.replaceState(null, '', '#hike=' + n);
    closeList();
    const st = status(n), tr = tripsOf(n), ph = photosOf(n);
    selL.clearLayers();
    const r = routeOf[n];
    if (r) { const pl = L.polyline(ll(r), { color: css('--ink'), weight: 2.2, dashArray: '6 6', opacity: 0.85, interactive: false }).addTo(selL);
      if (fly) map.flyToBounds(pl.getBounds().extend([h.lat, h.lon]), { paddingTopLeft: [40, 40], paddingBottomRight: [window.innerWidth > 760 ? 470 : 40, window.innerWidth > 760 ? 40 : window.innerHeight * 0.62], duration: 0.8 }); }
    (h.alt_parking || []).forEach((a, i) => L.marker([a.lat, a.lon], { icon: L.divIcon({ className: '', iconSize: [26, 20], html: `<div class="pk alt">P${i + 2}</div>` }) })
      .bindTooltip(`<b>P${i + 2}</b> ${esc(a.name)}<br>${esc(a.fee_label)} · joins route near km ${a.km_on_route}`, { direction: 'top' }).addTo(selL));
    L.marker([h.lat, h.lon], { icon: L.divIcon({ className: '', iconSize: [20, 20], html: `<div class="pk">P</div>` }), zIndexOffset: -100, interactive: false }).addTo(selL);
    showPhotos();
    const chip = st.state === 'done' ? `<span class="chip done">Done ${fmtDate(st.date)}</span>` : st.state === 'partial' ? `<span class="chip partial">${Math.round(st.frac * 100)}% walked</span>` : '<span class="chip">Not yet</span>';
    const dirs = h.directions.map(([km, t]) => `<tr><td>${km.toFixed(1)}</td><td>${esc(t)}</td></tr>`).join('');
    $('#panelInner').innerHTML = `
      <div class="kicker">Hike ${n} · Day ${h.day}${h.stops > 1 ? ` · stop ${h.stop} of ${h.stops}` : ''} · ${esc(h.section)}</div>
      <h2>${esc(h.trails.replace(/ \([\d.]+ km\)/g, '').replace(/; /g, ', '))}</h2>
      <div class="sub">${esc(h.subtitle)}</div>
      ${chip}
      <div class="stats">
        <div class="stat"><b>${h.km} km</b><span>${h.mi} mi total</span></div>
        <div class="stat"><b>~${h.hours} h</b><span>hiking</span></div>
        <div class="stat"><b>${h.new_km} km</b><span>side trail</span></div>
        <div class="stat"><b>${h.drive_min} min</b><span>drive (Sat 7 am)</span></div>
      </div>
      <div class="actions">
        ${h.files.pdf ? `<a class="btn primary" href="${h.files.pdf}" target="_blank" rel="noopener">Guide (PDF)</a>` : ''}
        ${h.files.gpx ? `<a class="btn" href="${h.files.gpx}" download>GPX for Gaia</a>` : ''}
        <a class="btn" href="${h.gmaps}" target="_blank" rel="noopener">Parking in Google Maps</a>
      </div>
      ${h.flags ? `<div class="flag">${esc(h.flags)}</div>` : ''}
      <div class="muted"><b>Park (P):</b> ${esc(h.parking_details)}</div>
      <div style="margin-top:4px">${feeChip(h.parking_fee)} <span class="muted">${esc(h.parking_fee && h.parking_fee.fee_detail || '')}</span></div>
      <h3>Other places to park</h3>
      ${(h.alt_parking || []).length ? `<div class="alts">${h.alt_parking.map((a, i) => `<div><b class="pk alt">P${i + 2}</b><div><div>${esc(a.name)} · <a href="${a.gmaps}" target="_blank" rel="noopener">map</a></div>
        <div class="muted">Joins the route near km ${a.km_on_route} · ${a.walk_m} m walk to the trail${a.near_trails.length ? ' · near ' + esc(a.near_trails.join(', ')) : ''}</div>${feeChip(a)}</div></div>`).join('')}</div>`
        : '<div class="muted">No other official Bruce Trail parking within about 1 km of this route. To stop early, turn back the way you came; what you walked still counts.</div>'}
      ${h.split ? `<div class="flag split"><b>Can't do it all in one go?</b> Split it into two outings.<br><b>1.</b> From P: ${h.split.part1.km} km / ${h.split.part1.mi} mi, covering ${esc(trl(h.split.part1.trails))}.<br>
        <b>2.</b> From ${h.split.alt_id ? 'P' + (h.alt_parking.findIndex(a => a.id === h.split.alt_id) + 2) : 'P again'}: ${h.split.part2.km} km / ${h.split.part2.mi} mi, covering ${esc(trl(h.split.part2.trails))}.<br>
        <span class="muted">The map turns walked trails green, so you can see what is left.</span></div>` : ''}
      <h3>Zappy's visits</h3>
      ${tr.length ? `<div class="trips">${tr.map(t => `<div><span>${fmtDate(t.date)} · ${esc(t.name)}</span><span>${t.km} km</span></div>`).join('')}</div>` : '<div class="muted">Not walked yet. Upload the GPX from Gaia after the hike and it will show up here.</div>'}
      ${ph.length ? `<h3>Photos (${ph.length})</h3><div class="thumbs">${ph.map((p, i) => `<img loading="lazy" src="${p.thumb}" data-i="${i}" alt="Photo from ${esc(p.date || '')}">`).join('')}</div>` : ''}
      <h3>Route</h3>
      ${h.files.map ? `<img class="guide-map" src="${h.files.map}" alt="Route map for hike ${n}" loading="lazy">` : ''}
      <div class="muted" style="margin-top:6px">${esc(h.route)}</div>
      ${h.expect.length ? `<h3>What to expect</h3><ul>${h.expect.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
      <details><summary>Turn-by-turn directions</summary><table class="dirs">${dirs}</table></details>
      ${h.sources.length ? `<details><summary>Sources</summary><ul>${h.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('')}</ul></details>` : ''}`;
    $('#panelInner').querySelectorAll('.thumbs img').forEach(im => im.onclick = () => openLB(ph, +im.dataset.i));
    const gm = $('#panelInner .guide-map'); if (gm) gm.onclick = () => window.open(gm.src, '_blank');
    $('#panel').classList.add('open'); $('#panel').scrollTop = 0;
  }
  function closePanel() {
    $('#panel').classList.remove('open'); selL.clearLayers();
    if (current && markers[current]) markers[current].setIcon(hikeIcon(current));
    current = null; showPhotos(); history.replaceState(null, '', location.pathname);
  }
  $('#closePanel').onclick = closePanel;
  map.on('click', e => { if (e.originalEvent.target.id === 'map' || e.originalEvent.target.tagName === 'CANVAS') { if (current) closePanel(); } });

  // ---------------- list view
  let filter = 'all', q = '';
  function renderList() {
    const rows = hikes.filter(h => {
      const s = status(h.hike).state;
      return (filter === 'all' || (filter === 'todo' ? s !== 'done' : s === filter)) && (!q || (h.trails + ' ' + h.parking + ' ' + h.section).toLowerCase().includes(q));
    }).sort((a, b) => a.day - b.day || a.stop - b.stop);
    $('#list').innerHTML = `<div class="filters">
      ${['all', 'todo', 'partial', 'done'].map(f => `<button class="${f === filter ? 'primary' : ''}" data-f="${f}">${{ all: 'All', todo: 'To do', partial: 'Started', done: 'Done' }[f]}</button>`).join('')}
      <input type="text" id="q" placeholder="Search trails, parking, section" value="${esc(q)}" style="max-width:280px">
      <span class="muted">${rows.length} hikes</span></div>
      <table><tr><th>Day</th><th>Hike</th><th>Side trails</th><th class="hide-sm">Section</th><th>mi</th><th class="hide-sm">Parking</th><th>Status</th></tr>
      ${rows.map(h => { const s = status(h.hike); return `<tr class="row" data-n="${h.hike}"><td class="num">${h.day}${h.stops > 1 ? 'abc'[h.stop - 1] : ''}</td><td class="num">${h.hike}</td>
        <td>${esc(h.trails.replace(/ \([\d.]+ km\)/g, '').replace(/; /g, ', '))}</td><td class="hide-sm">${esc(h.section)}</td><td class="num">${h.mi}</td><td class="hide-sm">${h.parking_fee && h.parking_fee.fee_status === 'paid' ? '<span class="chip paid">$ paid</span>' : h.parking_fee && h.parking_fee.fee_status === 'free' ? '<span class="muted">free</span>' : ''}${(h.alt_parking || []).length ? ` <span class="muted">+${h.alt_parking.length} alt</span>` : ''}</td>
        <td>${s.state === 'done' ? `<span class="chip done">${fmtDate(s.date)}</span>` : s.state === 'partial' ? `<span class="chip partial">${Math.round(s.frac * 100)}%</span>` : ''}</td></tr>`; }).join('')}</table>`;
    $('#list').querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filter = b.dataset.f; renderList(); });
    $('#list').querySelectorAll('tr.row').forEach(r => r.onclick = () => select(+r.dataset.n));
    const qi = $('#q'); qi.oninput = () => { q = qi.value.toLowerCase(); const pos = qi.selectionStart; renderList(); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); };
  }
  function openList() { renderList(); $('#list').classList.add('open'); $('#tabList').classList.add('on'); $('#tabMap').classList.remove('on'); history.replaceState(null, '', '#list'); }
  function closeList() { $('#list').classList.remove('open'); $('#tabMap').classList.add('on'); $('#tabList').classList.remove('on'); setTimeout(() => map.invalidateSize(), 50); }
  $('#tabList').onclick = e => { e.preventDefault(); openList(); };
  $('#tabMap').onclick = e => { e.preventDefault(); closeList(); if (!current) history.replaceState(null, '', location.pathname); };

  // ---------------- lightbox
  let lbList = [], lbI = 0;
  function openLB(list, i) { lbList = list; lbI = i; showLB(); $('#lb').classList.add('open'); }
  function showLB() {
    const p = lbList[lbI]; if (!p) return;
    const t = trips.find(t => t.id === p.trip);
    $('#lb img').src = p.file;
    const when = p.taken ? new Date(p.taken).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'date unknown';
    $('#lb .cap').innerHTML = `${esc(when)}${t ? ' · ' + esc(t.name) : ''}${t && t.hikes.length ? ` · <a href="#hike=${t.hikes[0]}" style="color:#9cf">hike ${t.hikes.join(', ')}</a>` : ''} · ${lbI + 1}/${lbList.length}`;
  }
  const lbStep = d => { lbI = (lbI + d + lbList.length) % lbList.length; showLB(); };
  $('#lb .x').onclick = () => $('#lb').classList.remove('open');
  $('#lb .prev').onclick = () => lbStep(-1); $('#lb .next').onclick = () => lbStep(1);
  $('#lb').onclick = e => { if (e.target.id === 'lb') $('#lb').classList.remove('open'); };
  addEventListener('keydown', e => { if (!$('#lb').classList.contains('open')) { if (e.key === 'Escape' && current) closePanel(); return; }
    if (e.key === 'Escape') $('#lb').classList.remove('open'); if (e.key === 'ArrowLeft') lbStep(-1); if (e.key === 'ArrowRight') lbStep(1); });
  let tx = null; $('#lb').addEventListener('touchstart', e => tx = e.touches[0].clientX, { passive: true });
  $('#lb').addEventListener('touchend', e => { if (tx == null) return; const dx = e.changedTouches[0].clientX - tx; if (Math.abs(dx) > 50) lbStep(dx < 0 ? 1 : -1); tx = null; });

  // ---------------- routing
  function route() {
    const m = location.hash.match(/hike=(\d+)/);
    if (m) select(+m[1]); else if (location.hash === '#list') openList();
  }
  addEventListener('hashchange', () => { $('#lb').classList.remove('open'); route(); });
  route();
})();
