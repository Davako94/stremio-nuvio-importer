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

  const res = await fetch(`${SUPABASE_URL}${path}`, {
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
// FUNZIONI STREMIO API (CORRETTE! TUTTO POST)
// ============================================
const STREMIO_API = 'https://api.strem.io';
const STREMIO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Stremio/4.4.159';

async function stremioLogin(email, password) {
  console.log(`🔐 Tentativo login Stremio per: ${email}`);
  
  const response = await fetch(`${STREMIO_API}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': STREMIO_UA,
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      email,
      password,
      facebook: false,
      type: 'login'
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Stremio login fallito (${response.status}): ${text.substring(0, 300)}`);
  }

  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Risposta login non JSON: ${text.substring(0, 200)}`);
  }

  const result = data.result || data;
  const authKey = result.authKey || result.token;

  if (!authKey) throw new Error("Login OK ma authKey mancante");

  console.log(`✅ Login Stremio OK (authKey ottenuto)`);
  return { token: authKey };
}

// ============================================
// ENDPOINT LIBRARY - CON POST (COME DAL PCAP!)
// ============================================
async function getStremioLibrary(authKey) {
  console.log(`📚 Richiesta library Stremio con POST...`);
  
  const response = await fetch(`${STREMIO_API}/api/library`, {
    method: 'POST',  // <-- IMPORTANTE: POST, non GET!
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authKey}`,
      'User-Agent': STREMIO_UA,
      'Accept': 'application/json'
    },
    body: JSON.stringify({}) // Body vuoto ma necessario per POST
  });

  const text = await response.text();
  console.log(`📥 Risposta library: ${response.status}`);
  
  if (!response.ok) {
    console.error('❌ Testo errore:', text.substring(0, 500));
    throw new Error(`Stremio API errore ${response.status}: ${text.substring(0, 500)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error('❌ Errore parsing JSON. Primi 200 caratteri:', text.substring(0, 200));
    throw new Error(`Risposta Stremio non è JSON`);
  }

  // Stremio restituisce { result: [...] } o direttamente l'array
  const items = data.result || data.items || data || [];
  console.log(`✅ Libreria Stremio caricata: ${items.length} elementi`);
  
  return items;
}

// ============================================
// ENDPOINT CONTINUE WATCHING - CON POST
// ============================================
async function getStremioContinueWatching(authKey) {
  try {
    const response = await fetch(`${STREMIO_API}/api/continueWatching`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authKey}`,
        'User-Agent': STREMIO_UA,
        'Accept': 'application/json'
      },
      body: JSON.stringify({})
    });
    
    if (!response.ok) return [];
    const data = await response.json();
    return data.result || data.items || [];
  } catch (error) {
    console.log('⚠️ Continue watching non disponibile');
    return [];
  }
}

// ============================================
// ENDPOINT WATCHED HISTORY - CON POST
// ============================================
async function getStremioWatchedHistory(authKey) {
  try {
    const response = await fetch(`${STREMIO_API}/api/watched`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authKey}`,
        'User-Agent': STREMIO_UA,
        'Accept': 'application/json'
      },
      body: JSON.stringify({})
    });
    
    if (!response.ok) return [];
    const data = await response.json();
    return data.result || data.items || [];
  } catch (error) {
    console.log('⚠️ Watched history non disponibile');
    return [];
  }
}

// ============================================
// FUNZIONE PER PUSHARE LA LIBRARY SU SUPABASE
// ============================================
async function pushLibraryToSupabase(email, password, items) {
  console.log(`☁️ Push cloud per ${email}...`);
  
  const session = await supabaseLogin(email, password);
  const accessToken = session.access_token;
  console.log(`✅ Login Nuvio riuscito, user ID: ${session.user?.id}`);

  // DEDUPLICA
  const uniqueItems = new Map();
  
  items.forEach(item => {
    const itemId = item.id || item._id;
    if (!itemId) return;
    
    const contentId = itemId.split(':')[0];
    if (!uniqueItems.has(contentId)) {
      uniqueItems.set(contentId, {
        content_id: contentId,
        content_type: (item.type === 'series' || item.type === 'show') ? 'series' : 'movie',
        name: item.name || 'Titolo sconosciuto',
        poster: item.poster || '',
        poster_shape: 'POSTER',
        background: item.background || item.banner || '',
        description: item.description || '',
        release_info: String(item.year || item.release_info || ''),
        imdb_rating: item.imdbRating ? parseFloat(item.imdbRating) : null,
        genres: Array.isArray(item.genres) ? item.genres : [],
        added_at: Date.now()
      });
    }
  });

  const libraryItems = Array.from(uniqueItems.values());
  console.log(`📦 Push di ${libraryItems.length} items unici`);

  await supabaseRpc('sync_push_library', { p_items: libraryItems }, accessToken);
  return libraryItems.length;
}

// ============================================
// ENDPOINT: TEST LOGIN STREMIO
// ============================================
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

// ============================================
// ENDPOINT: OTTIENI DATI STREMIO
// ============================================
app.post('/get-stremio-data', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const auth = await stremioLogin(email, password);
    
    const [library, continueWatching, watchedHistory] = await Promise.all([
      getStremioLibrary(auth.token),
      getStremioContinueWatching(auth.token),
      getStremioWatchedHistory(auth.token)
    ]);

    res.json({
      success: true,
      library,
      continueWatching,
      watchedHistory,
      stats: {
        movies: library.filter(i => i.type === 'movie').length,
        series: library.filter(i => i.type === 'series').length,
        continueWatching: continueWatching.length,
        watched: watchedHistory.length
      }
    });
  } catch (error) {
    console.error('❌ Errore get-stremio-data:', error.message);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: TEST LOGIN NUVIO
// ============================================
app.post('/test-login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.json({ success: false, message: '❌ Inserisci email e password' });
  }

  if (!isSupabaseConfigured()) {
    return res.json({ 
      success: false, 
      message: '❌ Supabase non configurato sul server' 
    });
  }

  try {
    const session = await supabaseLogin(email, password);
    res.json({ success: true, message: `✅ Login Nuvio riuscito!` });
  } catch (error) {
    res.json({ success: false, message: `❌ ${error.message}` });
  }
});

// ============================================
// ENDPOINT: OTTIENI DATI NUVIO
// ============================================
app.post('/get-nuvio-data', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const session = await supabaseLogin(email, password);
    const library = await supabaseRpc('sync_pull_library', {}, session.access_token);
    
    res.json({
      success: true,
      library: library || [],
      stats: {
        total: library?.length || 0,
        movies: library?.filter(i => i.content_type === 'movie').length || 0,
        series: library?.filter(i => i.content_type === 'series').length || 0
      }
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: SYNC DIRETTO
// ============================================
app.post('/sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'Credenziali incomplete' });
  }

  try {
    console.log('🚀 Avvio sync diretto...');
    
    // 1. Login Stremio e ottieni library
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    const stremioItems = await getStremioLibrary(stremioAuth.token);
    
    if (stremioItems.length === 0) {
      throw new Error("La tua libreria Stremio è vuota.");
    }

    // 2. Login Nuvio e ottieni library attuale
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    const currentNuvioLibrary = await supabaseRpc('sync_pull_library', {}, accessToken) || [];
    
    // 3. Crea backup automatico
    const backupId = Date.now().toString();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    fs.writeFileSync(
      path.join(backupDir, `${backupId}.json`),
      JSON.stringify(currentNuvioLibrary, null, 2)
    );
    
    // 4. Trova nuovi items
    const existingIds = new Set(currentNuvioLibrary.map(i => i.content_id));
    const newItems = stremioItems.filter(item => {
      const itemId = item.id || item._id;
      if (!itemId) return false;
      const contentId = itemId.split(':')[0];
      return !existingIds.has(contentId);
    });
    
    // 5. Push nuovi items
    const pushedCount = newItems.length > 0 
      ? await pushLibraryToSupabase(nuvioEmail, nuvioPassword, newItems)
      : 0;

    res.json({
      success: true,
      backupId,
      stats: {
        existing: currentNuvioLibrary.length,
        new: newItems.length,
        pushed: pushedCount
      },
      message: newItems.length > 0
        ? `✅ Sync completato! Aggiunti ${pushedCount} nuovi film/serie. Backup creato con ID: ${backupId}`
        : `✅ Sync completato! Nessun nuovo film da aggiungere. Backup creato con ID: ${backupId}`
    });

  } catch (error) {
    console.error('❌ Errore sync:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: LISTA BACKUP
// ============================================
app.get('/backups', (req, res) => {
  const backupsDir = path.join(__dirname, 'backups');
  
  if (!fs.existsSync(backupsDir)) {
    return res.json({ backups: [] });
  }

  try {
    const files = fs.readdirSync(backupsDir);
    const backups = files
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        id: f.replace('.json', ''),
        date: new Date(parseInt(f.replace('.json', ''))).toLocaleString()
      }))
      .sort((a, b) => b.id - a.id);

    res.json({ backups });
  } catch (error) {
    res.json({ backups: [] });
  }
});

// ============================================
// ENDPOINT: RIPRISTINA BACKUP
// ============================================
app.post('/restore', async (req, res) => {
  const { backupId, nuvioEmail, nuvioPassword } = req.body;

  try {
    const backupPath = path.join(__dirname, 'backups', `${backupId}.json`);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup non trovato' });
    }

    const backupLibrary = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

    const items = backupLibrary.map(item => ({
      id: item.content_id,
      type: item.content_type,
      name: item.name,
      poster: item.poster,
      year: item.release_info,
      description: item.description,
      genres: item.genres,
      imdbRating: item.imdb_rating?.toString()
    }));

    const restored = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, items);

    res.json({
      success: true,
      message: `✅ Backup ripristinato! ${restored} film/serie.`
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENDPOINT: STATO SUPABASE
// ============================================
app.get('/supabase-status', (req, res) => {
  res.json({
    configured: isSupabaseConfigured(),
    message: isSupabaseConfigured() ? '✅ Supabase pronto' : '⚠️ Mancano SUPABASE_URL o ANON_KEY'
  });
});

// ============================================
// ENDPOINT: HEALTH CHECK
// ============================================
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ============================================
// ENDPOINT: CONFIGURE PAGE
// ============================================
app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// AVVIO SERVER
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Stremio → NUVIO Importer (VERSIONE CON POST!)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com`);
  console.log(`☁️  Supabase: ${isSupabaseConfigured() ? '✅' : '❌'}`);
  console.log(`\n✅ ENDPOINT ATTIVI:`);
  console.log(`   • POST /test-stremio-login - Test login Stremio`);
  console.log(`   • POST /get-stremio-data - Ottieni library Stremio (con POST!)`);
  console.log(`   • POST /test-login - Test login Nuvio`);
  console.log(`   • POST /get-nuvio-data - Ottieni library Nuvio`);
  console.log(`   • POST /sync - Sync diretto Stremio → Nuvio`);
  console.log(`   • GET /backups - Lista backup`);
  console.log(`   • POST /restore - Ripristina backup`);
  console.log(`\n✨ Ora TUTTO con POST, come vuole Stremio!\n`);
});
