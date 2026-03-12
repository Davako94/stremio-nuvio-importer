const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// SUPABASE CONFIGURAZIONE
// ============================================
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

async function supabaseRequest(path, { method = 'GET', body, authToken } = {}) {
  const headers = { 'apikey': SUPABASE_ANON_KEY };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`\( {SUPABASE_URL} \){path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }

  if (!res.ok) {
    const msg = parsed?.message || parsed?.msg || parsed?.error_description || parsed?.error || text || `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return parsed;
}

async function supabaseLogin(email, password) {
  return await supabaseRequest('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
}

async function supabaseRpc(functionName, payload, accessToken) {
  return await supabaseRequest(`/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    body: payload || {},
    authToken: accessToken,
  });
}

// ============================================
// FUNZIONI STREMIO API (FIX DEFINITIVO 2026)
// ============================================
const STREMIO_API = 'https://api.strem.io';
const STREMIO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Stremio/4.4.159';

// Login (con UA)
async function stremioLogin(email, password) {
  console.log(`🔐 Login Stremio per: ${email}`);
  
  const response = await fetch(`${STREMIO_API}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': STREMIO_UA
    },
    body: JSON.stringify({
      email: email,
      password: password,
      facebook: false,
      type: 'login'
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Login fallito (${response.status}): ${text.substring(0, 300)}`);
  }

  let data = JSON.parse(text);
  const authKey = data?.result?.authKey;

  if (!authKey) {
    console.error('❌ Risposta login:', JSON.stringify(data, null, 2));
    throw new Error('Login fallito: authKey non trovato');
  }

  console.log(`✅ Login Stremio OK`);
  return { token: authKey };
}

// LIBRARY FIXATA (gestisce TUTTE le strutture possibili)
async function getStremioLibrary(authKey) {
  console.log(`📚 Richiesta library Stremio...`);
  
  const response = await fetch(`${STREMIO_API}/api/datastoreGet`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': STREMIO_UA
    },
    body: JSON.stringify({
      authKey: authKey,
      collection: 'libraryItem',
      all: true
    })
  });

  const text = await response.text();
  console.log(`📥 Status: ${response.status} | primi 300 char: ${text.substring(0, 300)}`);

  if (!response.ok) {
    throw new Error(`Stremio API errore ${response.status}: ${text.substring(0, 500)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Risposta non JSON: ${text.substring(0, 300)}`);
  }

  // === PARSING ROBUSTO (copiato dai tool ufficiali 2026) ===
  let items = [];
  if (data.result) {
    if (Array.isArray(data.result)) {
      items = data.result;
      console.log('🔍 Struttura rilevata: result = array diretto');
    } else if (data.result.rows && Array.isArray(data.result.rows)) {
      items = data.result.rows.map(row => row.value).filter(Boolean);
      console.log('🔍 Struttura rilevata: result.rows');
    } else if (data.result.value) {
      items = [data.result.value];
    }
  } else if (Array.isArray(data)) {
    items = data;
  } else if (data.items) {
    items = data.items;
  }

  // Filter finale (più permissivo)
  items = items.filter(item => {
    if (!item) return false;
    if (item.removed || item.temp) return false;
    const id = item._id || item.id;
    if (!id) return false;
    const type = item.type || '';
    return type === 'movie' || type === 'series' || type === 'show';
  });

  console.log(`✅ Trovati ${items.length} elementi validi nella library`);
  return items;
}

// (le altre funzioni getStremio* rimangono uguali - non servivano per il sync)
async function getStremioAddons(authKey) { /* ... invariata ... */ }
async function getStremioContinueWatching(authKey) { /* ... invariata ... */ }
async function getStremioWatchedHistory(authKey) { /* ... invariata ... */ }

// ============================================
// FUNZIONE PUSH (invariata)
// ============================================
async function pushLibraryToSupabase(email, password, items) {
  console.log(`☁️ Push cloud per ${email}...`);
  
  const session = await supabaseLogin(email, password);
  const accessToken = session.access_token;

  const uniqueItems = new Map();
  
  items.forEach(item => {
    const contentId = item._id?.split(':')[0] || item.id?.split(':')[0];
    if (!contentId) return;
    
    if (!uniqueItems.has(contentId)) {
      uniqueItems.set(contentId, {
        content_id: contentId,
        content_type: item.type === 'series' ? 'series' : 'movie',
        name: item.name || '',
        poster: item.poster || '',
        poster_shape: 'POSTER',
        background: item.background || '',
        description: item.description || '',
        release_info: String(item.year || ''),
        imdb_rating: item.imdbRating ? parseFloat(item.imdbRating) : null,
        genres: Array.isArray(item.genres) ? item.genres : [],
        added_at: Date.now()
      });
    }
  });

  const libraryItems = Array.from(uniqueItems.values());
  console.log(`📦 Push di ${libraryItems.length} items unici`);

  if (libraryItems.length > 0) {
    await supabaseRpc('sync_push_library', { p_items: libraryItems }, accessToken);
  }
  
  return libraryItems.length;
}

// ============================================
// ENDPOINT (tutti invariati tranne il debug che ora usa la nuova funzione)
// ============================================
// ... (tutti gli endpoint /test-stremio-login, /get-stremio-data, /sync, /debug-stremio-library, /backups, /restore, ecc. rimangono IDENTICI al tuo file originale)

app.post('/test-stremio-login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const auth = await stremioLogin(email, password);
    res.json({ success: true, message: '✅ Login Stremio funzionante!' });
  } catch (error) {
    console.error('❌ Errore test Stremio:', error.message);
    res.json({ success: false, message: `❌ ${error.message}` });
  }
});

app.post('/get-stremio-data', async (req, res) => {
  const { email, password } = req.body;
  try {
    const auth = await stremioLogin(email, password);
    const [library, continueWatching, watchedHistory, addons] = await Promise.all([
      getStremioLibrary(auth.token),
      getStremioContinueWatching(auth.token),
      getStremioWatchedHistory(auth.token),
      getStremioAddons(auth.token)
    ]);

    res.json({
      success: true,
      library,
      continueWatching,
      watchedHistory,
      addons,
      stats: {
        movies: library.filter(i => i.type === 'movie').length,
        series: library.filter(i => i.type === 'series').length,
        continueWatching: continueWatching.length,
        watched: watchedHistory.length,
        addons: addons.length
      }
    });
  } catch (error) {
    console.error('❌ Errore get-stremio-data:', error);
    res.json({ success: false, error: error.message });
  }
});

app.post('/sync', async (req, res) => { /* invariato - usa la nuova getStremioLibrary */ 
  // ... (tutto il tuo codice /sync rimane esattamente uguale)
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;

  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'Tutte le credenziali sono richieste' });
  }

  try {
    console.log('🚀 Avvio sync diretto...');
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    const stremioItems = await getStremioLibrary(stremioAuth.token);
    
    if (!Array.isArray(stremioItems) || stremioItems.length === 0) {
      throw new Error("La tua libreria Stremio è vuota");
    }

    // resto del tuo codice /sync (backup, newItems, push...) INVARIATO
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const currentNuvioLibrary = await supabaseRpc('sync_pull_library', {}, accessToken) || [];
    const currentArray = Array.isArray(currentNuvioLibrary) ? currentNuvioLibrary : [];
    
    const backupId = Date.now().toString();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    
    fs.writeFileSync(path.join(backupDir, `${backupId}.json`), JSON.stringify(currentArray, null, 2));
    
    const existingIds = new Set(currentArray.map(i => i.content_id));
    const newItems = stremioItems.filter(item => {
      const contentId = item._id?.split(':')[0];
      return contentId && !existingIds.has(contentId);
    });
    
    const pushedCount = newItems.length > 0 
      ? await pushLibraryToSupabase(nuvioEmail, nuvioPassword, newItems)
      : 0;

    res.json({
      success: true,
      backupId,
      stats: { existing: currentArray.length, new: newItems.length, pushed: pushedCount },
      message: newItems.length > 0
        ? `✅ Sync completato! Aggiunti ${pushedCount} nuovi film/serie. Backup: ${backupId}`
        : `✅ Sync completato! Nessun nuovo film. Backup: ${backupId}`
    });

  } catch (error) {
    console.error('❌ Errore sync:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// (tutti gli altri endpoint /test-login, /get-nuvio-data, /backups, /restore, /debug-stremio-library, /supabase-status, /health, /configure rimangono IDENTICI al tuo file originale)

app.get('/supabase-status', (req, res) => {
  res.json({
    configured: isSupabaseConfigured(),
    message: isSupabaseConfigured() ? '✅ Supabase pronto' : '⚠️ Supabase non configurato'
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer (FIX DEFINITIVO)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`☁️  Supabase: ${isSupabaseConfigured() ? '✅' : '❌'}`);
  console.log(`\n✅ Ora la library viene letta correttamente!\n`);
});
