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
// FUNZIONI STREMIO API (DAL REPO STREMTHRU!)
// ============================================
const STREMIO_API = 'https://api.strem.io';

// Login API - /api/login
async function stremioLogin(email, password) {
  console.log(`🔐 Login Stremio per: ${email}`);
  
  const response = await fetch(`${STREMIO_API}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email: email,
      password: password,
      facebook: false,
      type: 'login'
    })
  });

  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }

  const authKey = data?.result?.authKey;
  
  if (!authKey) {
    console.error('❌ Risposta login:', JSON.stringify(data, null, 2));
    throw new Error('Login fallito: authKey non trovato');
  }

  console.log(`✅ Login Stremio OK`);
  return { token: authKey };
}

// Get Library Items - /api/datastoreGet con collection "libraryItem"
async function getStremioLibrary(authKey) {
  console.log(`📚 Richiesta library Stremio...`);
  
  const response = await fetch(`${STREMIO_API}/api/datastoreGet`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      authKey: authKey,
      collection: 'libraryItem',
      all: true
    })
  });

  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }

  // La risposta ha struttura { result: { rows: [{ key, value }] } }
  const rows = data?.result?.rows || [];
  
  // Estrai i valori e filtra quelli validi
  const items = rows
    .map(row => row.value)
    .filter(item => {
      // Filtra elementi rimossi o temporanei
      if (item.removed || item.temp) return false;
      // Deve avere un ID e un tipo valido
      return item._id && (item.type === 'movie' || item.type === 'series');
    });
    
  console.log(`✅ Trovati ${items.length} elementi nella library`);
  return items;
}

// Get Addons - /api/addonCollectionGet
async function getStremioAddons(authKey) {
  try {
    const response = await fetch(`${STREMIO_API}/api/addonCollectionGet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        authKey: authKey,
        type: 'AddonCollectionGet',
        update: true
      })
    });

    const data = await response.json();
    return data?.result?.addons || [];
  } catch (error) {
    console.log('⚠️ Addons non disponibili');
    return [];
  }
}

// Get Continue Watching - Stessa API con collection diversa
async function getStremioContinueWatching(authKey) {
  try {
    const response = await fetch(`${STREMIO_API}/api/datastoreGet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        authKey: authKey,
        collection: 'continueWatching',
        all: true
      })
    });

    const data = await response.json();
    const rows = data?.result?.rows || [];
    return rows.map(row => row.value).filter(Boolean);
  } catch (error) {
    console.log('⚠️ Continue watching non disponibile');
    return [];
  }
}

// Get Watched History
async function getStremioWatchedHistory(authKey) {
  try {
    const response = await fetch(`${STREMIO_API}/api/datastoreGet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        authKey: authKey,
        collection: 'watched',
        all: true
      })
    });

    const data = await response.json();
    const rows = data?.result?.rows || [];
    return rows.map(row => row.value).filter(Boolean);
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

  // DEDUPLICA per content_id
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

// ============================================
// ENDPOINT: TEST LOGIN NUVIO
// ============================================
app.post('/test-login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!isSupabaseConfigured()) {
    return res.json({ success: false, message: '❌ Supabase non configurato' });
  }

  try {
    await supabaseLogin(email, password);
    res.json({ success: true, message: '✅ Login Nuvio riuscito!' });
  } catch (error) {
    console.error('❌ Errore test Nuvio:', error.message);
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
    
    const libraryArray = Array.isArray(library) ? library : [];
    
    res.json({
      success: true,
      library: libraryArray,
      stats: {
        total: libraryArray.length,
        movies: libraryArray.filter(i => i.content_type === 'movie').length,
        series: libraryArray.filter(i => i.content_type === 'series').length
      }
    });
  } catch (error) {
    console.error('❌ Errore get-nuvio-data:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: SYNC DIRETTO
// ============================================
app.post('/sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;

  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ 
      success: false, 
      error: 'Tutte le credenziali sono richieste' 
    });
  }

  try {
    console.log('🚀 Avvio sync diretto...');
    
    // 1. Login Stremio
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    
    // 2. Ottieni library Stremio
    const stremioItems = await getStremioLibrary(stremioAuth.token);
    
    if (!Array.isArray(stremioItems) || stremioItems.length === 0) {
      throw new Error("La tua libreria Stremio è vuota");
    }

    // 3. Login Nuvio
    const nuvioSession = await supabaseLogin(nuvioEmail, nuvioPassword);
    const accessToken = nuvioSession.access_token;
    
    // 4. Ottieni library Nuvio attuale
    const currentNuvioLibrary = await supabaseRpc('sync_pull_library', {}, accessToken) || [];
    const currentArray = Array.isArray(currentNuvioLibrary) ? currentNuvioLibrary : [];
    
    // 5. Crea backup automatico
    const backupId = Date.now().toString();
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    fs.writeFileSync(
      path.join(backupDir, `${backupId}.json`),
      JSON.stringify(currentArray, null, 2)
    );
    
    // 6. Trova nuovi items (non presenti in Nuvio)
    const existingIds = new Set(currentArray.map(i => i.content_id));
    const newItems = stremioItems.filter(item => {
      const contentId = item._id?.split(':')[0];
      return contentId && !existingIds.has(contentId);
    });
    
    // 7. Push nuovi items
    const pushedCount = newItems.length > 0 
      ? await pushLibraryToSupabase(nuvioEmail, nuvioPassword, newItems)
      : 0;

    res.json({
      success: true,
      backupId,
      stats: {
        existing: currentArray.length,
        new: newItems.length,
        pushed: pushedCount
      },
      message: newItems.length > 0
        ? `✅ Sync completato! Aggiunti ${pushedCount} nuovi film/serie. Backup: ${backupId}`
        : `✅ Sync completato! Nessun nuovo film. Backup: ${backupId}`
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
    console.error('Errore lettura backup:', error);
    res.json({ backups: [] });
  }
});

// ============================================
// ENDPOINT: RIPRISTINA BACKUP
// ============================================
app.post('/restore', async (req, res) => {
  const { backupId, nuvioEmail, nuvioPassword } = req.body;

  if (!backupId || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ 
      success: false, 
      error: 'backupId, email e password richiesti' 
    });
  }

  try {
    const backupPath = path.join(__dirname, 'backups', `${backupId}.json`);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ success: false, error: 'Backup non trovato' });
    }

    const backupLibrary = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const backupArray = Array.isArray(backupLibrary) ? backupLibrary : [];

    const items = backupArray.map(item => ({
      _id: item.content_id,
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
    console.error('❌ Errore restore:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: DEBUG STREMIO LIBRARY
// ============================================
app.post('/debug-stremio-library', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const auth = await stremioLogin(email, password);
    
    const response = await fetch(`${STREMIO_API}/api/datastoreGet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        authKey: auth.token,
        collection: 'libraryItem',
        all: true
      })
    });

    const data = await response.json();
    
    res.json({
      success: true,
      raw_response: data,
      rows_count: data?.result?.rows?.length || 0,
      first_row: data?.result?.rows?.[0] || null
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============================================
// ENDPOINT: STATO SUPABASE
// ============================================
app.get('/supabase-status', (req, res) => {
  res.json({
    configured: isSupabaseConfigured(),
    message: isSupabaseConfigured() ? '✅ Supabase pronto' : '⚠️ Supabase non configurato'
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
  console.log(`\n🚀 Stremio → NUVIO Importer (BASATO SU STREMTHRU!)`);
  console.log(`📦 Server avviato su porta ${PORT}`);
  console.log(`🌐 URL: https://stremio-nuvio-importer.onrender.com`);
  console.log(`☁️  Supabase: ${isSupabaseConfigured() ? '✅' : '❌'}`);
  
  if (!isSupabaseConfigured()) {
    console.log(`   → Imposta SUPABASE_URL e SUPABASE_ANON_KEY su Render`);
  }
  
  console.log(`\n✅ ENDPOINT ATTIVI:`);
  console.log(`   • POST /test-stremio-login - Test login Stremio`);
  console.log(`   • POST /get-stremio-data - Ottieni library Stremio`);
  console.log(`   • POST /debug-stremio-library - Debug library Stremio`);
  console.log(`   • POST /test-login - Test login Nuvio`);
  console.log(`   • POST /get-nuvio-data - Ottieni library Nuvio`);
  console.log(`   • POST /sync - Sync diretto Stremio → Nuvio`);
  console.log(`   • GET /backups - Lista backup`);
  console.log(`   • POST /restore - Ripristina backup`);
  console.log(`   • GET /supabase-status - Stato Supabase`);
  console.log(`\n✨ Ora con debug endpoint per analizzare la struttura!\n`);
});
