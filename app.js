const CLIENT_ID = '34030cec6f234fc0a57139780e43ba3d';   // z panelu Spotify for Developers
const COUNT = 100;                            // ile wylosowanych utworów zagrać (Spotify: maks. 100 naraz)
const SCOPES = 'playlist-read-private playlist-read-collaborative user-read-playback-state user-modify-playback-state';
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, '');
const API = 'https://api.spotify.com/v1';
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

const $ = id => document.getElementById(id);
const say = t => { $('msg').textContent = t; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOG = [], NAMES = {};
const log = m => { LOG.push(new Date().toISOString().slice(11, 23) + ' ' + m); if (LOG.length > 400) LOG.shift(); };
window.addEventListener('error', e => log('BŁĄD STRONY: ' + e.message));
window.addEventListener('unhandledrejection', e => log('ODRZUCONA OBIETNICA: ' + (e.reason?.message || e.reason)));
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const normalizeToken = value => typeof value === 'string' ? value.trim().replace(/^Bearer\s+/i, '') : '';
const validToken = value => value.length >= 20 && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
const store = {
  get() {
    const raw = localStorage.getItem('tok');
    if (!raw) return null;
    let saved;
    try {
      saved = JSON.parse(raw);
    } catch { saved = raw; }
    if (typeof saved === 'string') {
      const access = normalizeToken(saved);
      return validToken(access) ? { access, refresh: null, exp: Date.now() + 3600000 } : null;
    }
    if (!saved || typeof saved !== 'object') return null;
    const access = normalizeToken(saved.access);
    return validToken(access) ? { ...saved, access } : null;
  },
  set(v) { localStorage.setItem('tok', JSON.stringify(v)); }
};
const errText = e =>
  e.status === 403 && e.reason ? 'Spotify odrzucił polecenie (403, ' + e.reason + ').' :
  e.status === 403 ? 'Spotify odmówił dostępu (403). Sprawdź, czy to Twoja playlista i czy masz Premium.' :
  e.status === 404 ? 'Brak aktywnego urządzenia. Otwórz Spotify, zagraj coś na chwilę i spróbuj ponownie.' :
  (e.message || 'Nieznany błąd');

// ---------- Logowanie (OAuth PKCE, bez żadnych sekretów) ----------
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function login() {
  if (CLIENT_ID.startsWith('WKLEJ')) return say('Wklej swój Client ID na górze pliku app.js.');
  const verifier = b64(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  localStorage.setItem('ver', verifier);
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT,
    scope: SCOPES, code_challenge_method: 'S256', code_challenge: challenge
  });
}

async function token(body) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body })
  });
  if (!r.ok) throw new Error('Logowanie nie powiodło się (' + r.status + ').');
  const text = (await r.text()).trim();
  let response;
  try { response = JSON.parse(text); } catch { response = text; }
  const old = store.get();
  const access = normalizeToken(typeof response === 'string' ? response : response?.access_token);
  if (!validToken(access)) throw new Error('Spotify nie zwrócił poprawnego access tokenu.');
  const expiresIn = Number(response?.expires_in) || 3600;
  store.set({ access, refresh: response?.refresh_token || old?.refresh, exp: Date.now() + expiresIn * 1000 - 60000 });
}

async function accessToken() {
  let t = store.get();
  if (!t?.access) throw new Error('Brak tokenu Spotify. Zaloguj się ponownie.');
  if (Date.now() > t.exp) {
    if (!t.refresh) throw new Error('Token Spotify wygasł. Zaloguj się ponownie.');
    await token({ grant_type: 'refresh_token', refresh_token: t.refresh });
    t = store.get();
  }
  return t.access;
}

async function api(path, opt = {}, tokenRetry = false) {
  const playerCommand = /^\/me\/player\/(?:shuffle|play|queue)(?:\?|$)/.test(path);
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    ...opt, headers: { ...opt.headers, Authorization: 'Bearer ' + await accessToken(), ...(opt.body ? { 'Content-Type': 'application/json' } : {}) }
  });
  log((opt.method || 'GET') + ' ' + path.replace(API, '').slice(0, 140) + ' -> ' + r.status);
  if (r.status === 429) { await sleep((+r.headers.get('Retry-After') || 2) * 1000); return api(path, opt, tokenRetry); }
  if (r.status === 401) {
    const saved = store.get();
    if (!tokenRetry && saved?.refresh) {
      try {
        await token({ grant_type: 'refresh_token', refresh_token: saved.refresh });
        return api(path, opt, true);
      } catch (e) {
        localStorage.removeItem('tok');
        throw e;
      }
    }
    localStorage.removeItem('tok');
    const e = new Error('Spotify odrzucił token (401). Zaloguj się ponownie.');
    e.status = 401;
    throw e;
  }
  if (r.status === 204 || r.status === 205 || (r.ok && playerCommand)) {
    if (r.status !== 204 && !path.includes('/queue')) { try { const t = (await r.text()).trim(); if (t) log('  treść odpowiedzi: ' + t.slice(0, 200)); } catch {} }
    return null;
  }
  const txt = await r.text();
  if (!txt.trim()) return null;
  let data = null;
  try { data = JSON.parse(txt.replace(/^\uFEFF/, '').trim()); }
  catch {
    log('  odpowiedź (nie-JSON): ' + txt.slice(0, 300));
    if (!r.ok) { const e = new Error('Spotify API zwróciło błąd (' + r.status + ').'); e.status = r.status; throw e; }
    const endpoint = new URL(r.url).pathname;
    const type = r.headers.get('Content-Type') || 'brak Content-Type';
    throw new Error('Spotify API zwróciło nie-JSON dla ' + endpoint + ' (' + type + ').');
  }
  const apiError = data?.error;
  if (!r.ok || apiError) {
    log('  odpowiedź: ' + txt.slice(0, 300));
    const e = new Error(typeof apiError === 'string' ? apiError : apiError?.message || 'Błąd Spotify API (' + r.status + ').');
    e.status = Number(apiError?.status) || r.status;
    e.reason = apiError?.reason;
    throw e;
  }
  if (data !== null && (typeof data !== 'object' || Array.isArray(data))) {
    throw new Error('Spotify API zwróciło nieobsługiwany typ danych dla ' + new URL(r.url).pathname + '.');
  }
  return data;
}

// ---------- Losowanie: Fisher-Yates + crypto (bez błędu modulo) ----------
function rnd(n) {
  const lim = Math.floor(2 ** 32 / n) * n;
  let x;
  do { x = crypto.getRandomValues(new Uint32Array(1))[0]; } while (x >= lim);
  return x % n;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- Dane ze Spotify ----------
async function loadPlaylists() {
  let url = '/me/playlists?limit=50', all = [];
  while (url) {
    const j = await api(url);
    if (!Array.isArray(j?.items)) throw new Error('Spotify nie zwrócił listy playlist w polu "items".');
    all.push(...j.items.filter(Boolean));
    url = typeof j.next === 'string' ? j.next : null;
  }
  return all;
}

async function loadTracks(id) {
  let url = `/playlists/${id}/items?limit=50`;
  const uris = new Set();                     // Set usuwa duplikaty
  while (url) {                               // paginacja: idziemy po "next" aż do końca
    const j = await api(url);
    if (!Array.isArray(j?.items)) throw new Error('Spotify nie zwrócił utworów playlisty w polu "items".');
    for (const it of j.items) {
      const t = it?.item || it?.track;        // po zmianach z 2026 pole nazywa się "item"
      if (t?.type === 'track' && !t.is_local && t.is_playable !== false && TRACK_URI.test(t.uri || '')) { uris.add(t.uri); NAMES[t.uri] = t.name; }
    }
    say('Pobieram utwory: ' + uris.size + '…');
    url = typeof j.next === 'string' ? j.next : null;
  }
  return [...uris];
}

async function refreshDevices() {
  const selectedId = $('device').value;
  const response = await api('/me/player/devices');
  const devices = Array.isArray(response?.devices) ? response.devices : [];
  const available = devices.filter(d => d?.id && !d.is_restricted);
  const select = $('device');
  select.innerHTML = available.length
    ? available.map(d => `<option value="${esc(d.id)}">${esc(d.name || d.type || 'Spotify')} ${d.is_active ? '(aktywne)' : ''}</option>`).join('')
    : '<option value="">Brak dostępnych urządzeń</option>';
  if (available.length) {
    const preferred = available.find(d => d.id === selectedId) || available.find(d => d.is_active) || available[0];
    select.value = preferred.id;
  }
  return available;
}

async function waitForDevice(id, ms) {
  for (let t = 0; t < ms; t += 500) {
    const r = await api('/me/player/devices');
    if ((r?.devices || []).find(d => d.id === id)?.is_active) return true;
    await sleep(500);
  }
  return false;
}

async function startPlayback(devId, uris) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await api('/me/player/play?device_id=' + encodeURIComponent(devId), { method: 'PUT', body: JSON.stringify({ uris }) });
      return;
    } catch (e) {
      log('  próba ' + attempt + ' nieudana (' + (e.status || '?') + ' ' + (e.reason || '') + ')');
      if (attempt === 3 || ![404, 502, 503].includes(e.status)) throw e;
      await sleep(1000);
    }
  }
}

const describe = s => !s ? 'brak stanu (204)' : JSON.stringify({
  gra: s.is_playing, typ: s.currently_playing_type,
  utwor: s.item ? (s.item.name + ' | ' + s.item.uri) : null,
  kontekst: s.context?.uri || null, postep_ms: s.progress_ms,
  shuffle: s.shuffle_state, repeat: s.repeat_state,
  urzadzenie: s.device ? (s.device.name + ' vol=' + s.device.volume_percent + (s.device.is_private_session ? ' SESJA-PRYWATNA' : '')) : null,
  zablokowane: s.actions?.disallows ? Object.keys(s.actions.disallows) : null
});

// Czeka, aż Spotify rzeczywiście gra NASZ utwór z podanej listy (a nie stara muzyka).
async function confirmPlayback(devId, uris, tries = 6) {
  const mine = new Set(uris);
  let resumed = false;
  for (let i = 0; i < tries; i++) {
    await sleep(700);
    const s = await api('/me/player');
    const uri = s?.item?.uri, from = s?.item?.linked_from?.uri;
    const ours = !!(uri && (mine.has(uri) || mine.has(from))) && (!s.device?.id || s.device.id === devId);
    log('  stan: ' + describe(s) + ' | nasz=' + ours);
    if (ours && s.is_playing) return true;
    if (ours && !s.is_playing && !resumed && i >= 1) {   // lista załadowana, ale pauza: wznów jeden raz
      resumed = true;
      log('  wznawiam (pauza po załadowaniu listy)');
      try { await api('/me/player/play?device_id=' + encodeURIComponent(devId), { method: 'PUT' }); }
      catch (e) { log('  wznowienie nieudane: ' + e.message); }
    }
  }
  return false;
}

async function play() {
  $('go').disabled = true;
  log('--- nowa próba ---');
  try {
    say('Pobieram playlistę…');
    const all = await loadTracks($('pl').value);
    log('playlista: ' + all.length + ' poprawnych utworów');
    if (!all.length) throw new Error('Playlista jest pusta albo Spotify nie udostępnił jej utworów.');
    const pick = shuffle(all).slice(0, Math.min(COUNT, 100));
    if (!pick.length || pick.some(uri => !TRACK_URI.test(uri))) throw new Error('Nie znaleziono poprawnych URI utworów Spotify do odtworzenia.');
    const devices = await refreshDevices();
    const dev = devices.find(d => d.id === $('device').value);
    if (!dev) throw new Error('Wybierz dostępne urządzenie Spotify. Otwórz Spotify na komputerze lub telefonie, a następnie odśwież listę urządzeń.');
    log('urządzenie: ' + dev.name + ' (' + dev.type + '), aktywne=' + dev.is_active + ', losowanych utworów: ' + pick.length);
    const enc = encodeURIComponent(dev.id);
    if (!dev.is_active) {
      say('Przełączam Spotify na „' + dev.name + '”…');
      await api('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [dev.id], play: false }) });
      if (!(await waitForDevice(dev.id, 5000))) log('  urządzenie nie zgłosiło się jako aktywne, próbuję mimo to');
    }
    try { await api('/me/player/shuffle?state=false&device_id=' + enc, { method: 'PUT' }); }
    catch (e) { log('  nie udało się wyłączyć shuffle: ' + e.message); }
    const before = await api('/me/player');
    log('stan przed: ' + describe(before));

    log('wylosowane (pierwsze 3): ' + pick.slice(0, 3).map(u => u + ' = ' + NAMES[u]).join(' ; '));
    const playlistUri = 'spotify:playlist:' + $('pl').value;
    const knownGood = before?.item?.uri && before?.currently_playing_type === 'track' ? before.item.uri : null;

    // Metody po kolei; pierwsza, która faktycznie uruchomi muzykę, wygrywa.
    const methods = [
      { name: 'playlista od pierwszego wylosowanego utworu + reszta do kolejki', uris: [pick[0]], tries: 5,
        run: () => api('/me/player/play?device_id=' + enc, { method: 'PUT', body: JSON.stringify({ context_uri: playlistUri, offset: { uri: pick[0] } }) }),
        after: async () => {
          const rest = pick.slice(1);
          let added = 0, errors = 0;
          for (let i = 0; i < rest.length && errors < 4; i++) {
            if (i % 10 === 0) say('Dodaję wylosowane utwory do kolejki: ' + i + '/' + rest.length + '…');
            try { await api('/me/player/queue?uri=' + encodeURIComponent(rest[i]) + '&device_id=' + enc, { method: 'POST' }); added++; }
            catch (e) { errors++; log('  kolejka: błąd przy utworze ' + (i + 1) + ': ' + (e.status || '') + ' ' + e.message); }
            await sleep(120);
          }
          log('  dodano do kolejki: ' + added + ', błędów: ' + errors);
          return added;
        } },
      { name: 'play z listą utworów', uris: pick, tries: 4, run: () => startPlayback(dev.id, pick) }
    ];
    if (knownGood) methods.push({ name: 'DIAGNOSTYKA: utwór, który grał wcześniej', uris: [knownGood], tries: 4, diagnostic: true, run: () => startPlayback(dev.id, [knownGood]) });
    let used = null;
    for (const m of methods) {
      log('metoda: ' + m.name);
      say('Próbuję: ' + m.name + '…');
      try { await m.run(); } catch (e) { log('  błąd metody: ' + (e.status || '') + ' ' + (e.reason || '') + ' ' + e.message); continue; }
      if (await confirmPlayback(dev.id, m.uris, m.tries)) { used = m; break; }
    }
    if (used?.diagnostic) throw new Error('Zadziałało odtworzenie utworu, który grał wcześniej, więc problem leży w utworach z playlisty. Kliknij „Kopiuj raport diagnostyczny” i wklej go Claude.');
    if (!used) throw new Error('Żadna metoda nie uruchomiła muzyki na „' + dev.name + '”. Kliknij „Kopiuj raport diagnostyczny” i wklej go Claude.');
    let queued = null;
    if (used.after) { try { queued = await used.after(); } catch (e) { log('  kolejka nieudana: ' + e.message); } }
    say('Gra wylosowana kolejka' + (queued === null ? '' : ': pierwszy utwór + ' + queued + ' w kolejce Spotify') + ' (z ' + all.length + ' utworów w playliście, urządzenie: ' + dev.name + ').');
  } catch (e) { log('BŁĄD: ' + (e.status || '') + ' ' + (e.reason || '') + ' ' + e.message); say(errText(e)); }
  $('go').disabled = false;
}

// ---------- Start ----------
async function init() {
  try {
    const code = new URLSearchParams(location.search).get('code');
    if (code) {
      await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: localStorage.getItem('ver') });
      history.replaceState({}, '', REDIRECT);
    }
    if (!store.get()) { $('login').hidden = false; return; }
    const pls = await loadPlaylists();
    $('pl').innerHTML = pls.map(p => `<option value="${p.id}">${esc(p.name)} (${p.items?.total ?? p.tracks?.total ?? '?'})</option>`).join('');
    try { await refreshDevices(); } catch (e) { say('Nie udało się pobrać urządzeń Spotify: ' + e.message); }
    const last = localStorage.getItem('last');
    if (last) $('pl').value = last;
    $('app').hidden = false;
  } catch (e) { localStorage.removeItem('tok'); $('login').hidden = false; say(errText(e)); }
}

// ---------- Raport diagnostyczny (bez tokenów i haseł) ----------
const repBtn = document.createElement('button');
repBtn.textContent = 'Kopiuj raport diagnostyczny';
repBtn.style.marginTop = '1rem';
const repBox = document.createElement('textarea');
repBox.readOnly = true; repBox.hidden = true; repBox.rows = 8;
repBox.style.cssText = 'width:100%;margin-top:.75rem;font:12px/1.4 monospace;border-radius:10px;padding:.6rem';
$('msg').after(repBtn, repBox);
repBtn.onclick = async () => {
  const text = 'Raport ' + new Date().toISOString() + '\n' + navigator.userAgent + '\n' + (LOG.join('\n') || '(brak wpisów)');
  repBox.value = text; repBox.hidden = false;
  try { await navigator.clipboard.writeText(text); say('Raport skopiowany. Wklej go w rozmowie z Claude.'); }
  catch { repBox.select(); say('Zaznacz tekst poniżej, skopiuj go i wklej w rozmowie z Claude.'); }
};

$('loginBtn').onclick = login;
$('go').onclick = play;
$('refreshDevices').onclick = async () => {
  try { await refreshDevices(); say('Lista urządzeń została odświeżona.'); }
  catch (e) { say(errText(e)); }
};
$('pl').onchange = () => localStorage.setItem('last', $('pl').value);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
init();
