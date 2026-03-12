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
// FUNZIONI STREMIO API (CORRETTE)
// ============================================
const STREMIO_API = 'https://api.strem.io';

async function stremioLogin(email, password) {
  // Stremio richiede spesso User-Agent specifici per non rispondere 404
  const commonHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Stremio/4.4.159'
  };

  // Proviamo prima l'endpoint standard senza il path /auth/
  const endpoints = [
    `${STREMIO_API}/api/login`,
    `${STREMIO_API}/api/auth/login`
  ];

  let lastError = '';

  for (const url of endpoints) {
    try {
      console.log(`🔐 Tentativo login Stremio su: ${url}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: commonHeaders,
        body: JSON.stringify({ email, password })
      });

      const text = await response.text();
      if (!response.ok) {
        lastError = `Status ${response.status}: ${text.substring(0, 100)}`;
        continue;
      }

      const data = JSON.parse(text);
      // Il token può essere in data.token o data.result.token
      const token = data.token || (data.result && data.result.token);
      
      if (!token) {
        lastError = "Risposta ricevuta ma token mancante";
        continue;
      }

      console.log(`✅ Login Stremio riuscito`);
      return { token, user: data.user || data.result?.user };
    } catch (e) {
      lastError = e.message;
    }
  }

  throw new Error(`Errore login Stremio: ${lastError || 'Endpoint non raggiungibile'}`);
}

async function getStremioLibrary(authToken) {
  try {
    const response = await fetch(`${STREMIO_API}/api/library`, {
      method: 'POST', // Molti endpoint Stremio preferiscono POST anche per lettura
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey: authToken }) // Stremio usa spesso authKey nel body
    });
    
    // Fallback se il primo metodo fallisce (alcuni account usano il Bearer)
    if (!response.ok) {
        const resAlt = await fetch(`${STREMIO_API}/api/library`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const dataAlt = await resAlt.json();
        return dataAlt.items || dataAlt.result || [];
    }

    const data = await response.json();
    return data.items || data.result || [];
  } catch (error) {
    console.error('❌ Stremio library error:', error.message);
    return [];
  }
}

// ============================================
// LOGICA DI SYNC E PUSH
// ============================================
async function pushLibraryToSupabase(email, password, items) {
  const session = await supabaseLogin(email, password);
  const accessToken = session.access_token;

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
  await supabaseRpc('sync_push_library', { p_items: libraryItems }, accessToken);
  return libraryItems.length;
}

// ============================================
// ENDPOINTS API
// ============================================

app.post('/sync', async (req, res) => {
  const { stremioEmail, stremioPassword, nuvioEmail, nuvioPassword } = req.body;
  if (!stremioEmail || !stremioPassword || !nuvioEmail || !nuvioPassword) {
    return res.status(400).json({ success: false, error: 'Credenziali incomplete' });
  }

  try {
    const stremioAuth = await stremioLogin(stremioEmail, stremioPassword);
    const stremioItems = await getStremioLibrary(stremioAuth.token);
    
    if (!stremioItems || stremioItems.length === 0) {
        throw new Error("La tua libreria Stremio sembra vuota.");
    }

    const pushedCount = await pushLibraryToSupabase(nuvioEmail, nuvioPassword, stremioItems);

    res.json({
      success: true,
      stats: { pushed: pushedCount },
      message: `✅ Sync completato! Importati ${pushedCount} elementi.`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/test-stremio-login', async (req, res) => {
    try {
        await stremioLogin(req.body.email, req.body.password);
        res.json({ success: true, message: '✅ Login Stremio funzionante!' });
    } catch (e) {
        res.json({ success: false, message: `❌ ${e.message}` });
    }
});

app.get('/supabase-status', (req, res) => {
  res.json({
    configured: isSupabaseConfigured(),
    message: isSupabaseConfigured() ? '✅ Supabase pronto' : '⚠️ Mancano SUPABASE_URL o ANON_KEY'
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ============================================
// AVVIO
// ============================================
const PORT = process.env.PORT || 7000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server in esecuzione su porta ${PORT}`);
});
