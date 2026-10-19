/* Upload page: commits dropped files into uploads/ in one GitHub commit, then follows the processing run. */
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} } };
  // default repository from the GitHub Pages address: <owner>.github.io/<repo>/
  const guess = location.hostname.endsWith('.github.io') ? `${location.hostname.split('.')[0]}/${location.pathname.split('/').filter(Boolean)[0] || ''}` : '';
  $('#repo').value = store.get('zappy_repo') || guess;
  $('#tok').value = store.get('zappy_token');
  const ready = () => !!($('#repo').value.includes('/') && store.get('zappy_token'));
  const showSetup = () => { $('#setupState').textContent = ready() ? '· set up ✓' : '· needed before uploading'; if (!ready()) $('#setup').open = true; };
  showSetup();
  $('#save').onclick = () => { store.set('zappy_repo', $('#repo').value.trim()); store.set('zappy_token', $('#tok').value.trim()); showSetup(); check(); };
  $('#forget').onclick = () => { store.set('zappy_token', ''); $('#tok').value = ''; showSetup(); };

  const api = async (path, opts = {}) => {
    const r = await fetch(`https://api.github.com/repos/${store.get('zappy_repo') || $('#repo').value.trim()}${path}`, { ...opts,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${store.get('zappy_token')}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (!r.ok) { const t = await r.text(); throw new Error(`GitHub said ${r.status}: ${t.slice(0, 200)}`); }
    return r.status === 204 ? null : r.json();
  };
  async function check() {
    if (!ready()) return;
    try { await api(''); $('#setupState').textContent = '· set up ✓'; } catch (e) { $('#setupState').innerHTML = `<span class="err">· token problem: ${esc(e.message)}</span>`; }
  }
  check();

  // ---------------- file picking
  let files = [];
  const ok = f => /\.(gpx|jpe?g|png|heic|heif|webp)$/i.test(f.name);
  const mb = n => (n / 1048576).toFixed(n > 1048576 * 10 ? 0 : 1) + ' MB';
  function add(list) {
    for (const f of list) if (ok(f) && !files.some(g => g.name === f.name && g.size === f.size)) files.push(f);
    $('#files').innerHTML = files.map(f => `<div><span>${esc(f.name)}</span><span class="muted">${mb(f.size)}</span></div>`).join('') +
      (files.length ? `<div><b>${files.length} files</b><b>${mb(files.reduce((a, f) => a + f.size, 0))}</b></div>` : '');
    $('#go').disabled = !files.length; $('#clear').hidden = !files.length;
    const skipped = [...list].filter(f => !ok(f)).map(f => f.name);
    $('#status').innerHTML = skipped.length ? `<span class="muted">Ignored (not GPX or a photo): ${esc(skipped.join(', '))}</span>` : '';
  }
  const drop = $('#drop');
  drop.onclick = () => $('#pick').click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') $('#pick').click(); };
  $('#pick').onchange = e => add(e.target.files);
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => add(e.dataTransfer.files));
  $('#clear').onclick = () => { files = []; add([]); };

  const b64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
  const say = (msg, cls = '') => { $('#status').innerHTML = `<span class="${cls}">${msg}</span>`; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------------- upload: blobs -> tree -> commit -> move main
  $('#go').onclick = async () => {
    if (!ready()) { $('#setup').open = true; say('Finish the one-time setup below first.', 'err'); return; }
    $('#go').disabled = true; $('#clear').hidden = true;
    try {
      const ref = await api('/git/ref/heads/main');
      const base = await api(`/git/commits/${ref.object.sha}`);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
      const tree = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        say(`Uploading ${i + 1} of ${files.length}: ${esc(f.name)}…`);
        const blob = await api('/git/blobs', { method: 'POST', body: JSON.stringify({ content: await b64(f), encoding: 'base64' }) });
        tree.push({ path: `uploads/${stamp}/${f.name.replace(/[^\w.\- ]+/g, '_')}`, mode: '100644', type: 'blob', sha: blob.sha });
      }
      say('Saving…');
      const t = await api('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
      const c = await api('/git/commits', { method: 'POST', body: JSON.stringify({ message: `Upload ${files.length} file(s) from the website`, tree: t.sha, parents: [base.sha] }) });
      await api('/git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
      files = []; add([]);
      await follow(c.sha);
    } catch (e) {
      say(`Upload failed. ${esc(e.message)}`, 'err'); $('#go').disabled = !files.length; $('#clear').hidden = !files.length;
    }
  };

  // ---------------- follow the processing run, then show what it found
  async function follow(sha) {
    say('Uploaded ✓ Processing on GitHub (usually 1–3 minutes)…', 'ok');
    const t0 = Date.now();
    while (Date.now() - t0 < 15 * 60 * 1000) {
      await sleep(8000);
      let run = null;
      try { run = (await api(`/actions/runs?head_sha=${sha}&per_page=1`)).workflow_runs[0]; } catch (e) { say('Uploaded ✓ (could not check processing status: the token needs Actions read access). Check the map in a few minutes.', 'ok'); return; }
      const mins = Math.round((Date.now() - t0) / 60000);
      if (!run) { say(`Uploaded ✓ Waiting for processing to start… (${mins} min)`, 'ok'); continue; }
      if (run.status !== 'completed') { say(`Uploaded ✓ Processing: ${esc(run.status.replace('_', ' '))}… (${mins} min)`, 'ok'); continue; }
      if (run.conclusion !== 'success') { say(`Processing failed. <a href="${run.html_url}" target="_blank" rel="noopener">See what went wrong on GitHub</a>.`, 'err'); return; }
      say('Done ✓ The map is updated. (If it still looks old, refresh the page.)', 'ok');
      await showLast(); return;
    }
    say('Still processing after 15 minutes. Check the Actions tab on GitHub.', 'err');
  }
  async function showLast() {
    let log;
    try { const f = await api('/contents/data/last_run.json?ref=main'); log = JSON.parse(decodeURIComponent(escape(atob(f.content.replace(/\n/g, ''))))); } catch { return; }
    const tr = log.tracks.map(t => `<li><b>${esc(t.file)}</b>: ${esc(t.date)}, ${t.km} km, ${t.hikes.length ? 'hike ' + t.hikes.map(n => `<a href="./#hike=${n}">${n}</a>`).join(', ') : 'no planned hike matched'}${t.side_trail_km_new ? `, ${t.side_trail_km_new} km of new side trail` : ''}</li>`).join('');
    const ph = log.photos.length ? `<li>${log.photos.length} photo(s), ${log.photos.filter(p => p.gps).length} with GPS location</li>` : '';
    const pr = log.problems.map(p => `<li>${esc(p)}</li>`).join('');
    $('#last').hidden = false;
    $('#last').innerHTML = `<h2>Last upload</h2><ul>${tr}${ph}</ul>${pr ? `<div class="muted"><b>Notes</b><ul>${pr}</ul></div>` : ''}<a class="btn primary" href="./">See it on the map</a>`;
  }
  if (ready()) showLast();
})();
