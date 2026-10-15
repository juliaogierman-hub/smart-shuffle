const CLIENT_ID = '34030cec6f234fc0a57139780e43ba3d';   // z panelu Spotify for Developers
const COUNT = 100;                            // ile wylosowanych utworów zagrać (Spotify: maks. 100 naraz)
const SCOPES = 'playlist-read-private playlist-read-collaborative user-read-playback-state user-modify-playback-state';
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, '');
const API = 'https://api.spotify.com/v1';
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

const $ = id => document.getElementById(id);
const say = t => { $('msg').textContent = t; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  const playerCommand = /^\/me\/player\/(?:shuffle|play)(?:\?|$)/.test(path);
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    ...opt, headers: { Authorization: 'Bearer ' + await accessToken(), ...(opt.body ? { 'Content-Type': 'application/json' } : {}) }
  });
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
  if (r.status === 204 || r.status === 205 || (r.ok && playerCommand)) return null;
  const txt = await r.text();
  if (!txt.trim()) return null;
  let data = null;
  try { data = JSON.parse(txt.replace(/^\uFEFF/, '').trim()); }
  catch {
    if (!r.ok) { const e = new Error('Spotify API zwróciło błąd (' + r.status + ').'); e.status = r.status; throw e; }
    const endpoint = new URL(r.url).pathname;
    const type = r.headers.get('Content-Type') || 'brak Content-Type';
    throw new Error('Spotify API zwróciło nie-JSON dla ' + endpoint + ' (' + type + ').');
  }
  const apiError = data?.error;
  if (!r.ok || apiError) {
    const e = new Error(typeof apiError === 'string' ? apiError : apiError?.message || 'Błąd Spotify API (' + r.status + ').');
    e.status = Number(apiError?.status) || r.status;
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
      if (t?.type === 'track' && !t.is_local && t.is_playable !== false && TRACK_URI.test(t.uri || '')) uris.add(t.uri);
    }
    say('Pobieram utwory: ' + uris.size + '…');
    url = typeof j.next === 'string' ? j.next : null;
  }
  return [...uris];
}

async function play() {
  $('go').disabled = true;
  try {
    say('Pobieram playlistę…');
    const all = await loadTracks($('pl').value);
    if (!all.length) throw new Error('Playlista jest pusta albo Spotify nie udostępnił jej utworów.');
    const pick = shuffle(all).slice(0, Math.min(COUNT, 100));
    if (!pick.length || pick.some(uri => !TRACK_URI.test(uri))) throw new Error('Nie znaleziono poprawnych URI utworów Spotify do odtworzenia.');
    const { devices } = await api('/me/player/devices');
    const dev = devices.find(d => d.is_active) || devices[0];
    if (!dev) throw new Error('Nie widzę żadnego urządzenia. Otwórz Spotify na telefonie, zagraj coś na chwilę i spróbuj ponownie.');
    const d = '&device_id=' + encodeURIComponent(dev.id);
    const body = JSON.stringify({ uris: pick });
    await api('/me/player/play?' + d.slice(1), { method: 'PUT', body });
    say('Gra ' + pick.length + ' wylosowanych utworów z ' + all.length + ' (urządzenie: ' + dev.name + ').');
  } catch (e) { say(errText(e)); }
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
    const last = localStorage.getItem('last');
    if (last) $('pl').value = last;
    $('app').hidden = false;
  } catch (e) { localStorage.removeItem('tok'); $('login').hidden = false; say(errText(e)); }
}

$('loginBtn').onclick = login;
$('go').onclick = play;
$('pl').onchange = () => localStorage.setItem('last', $('pl').value);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
init();
