// Backend "Coup d'Envoi" — proxy + cache pour API-Football (RapidAPI)
// -------------------------------------------------------------------
// Ce serveur fait 3 choses :
// 1. Cache les Ã©tés API pour éviter de dépasser ton quota gratuit (RapidAPI)
// 2. Cache les réponses en mémoire (60s par défaut) pour économiser tes requêtes
// 3. Simplifie les données renvoyées pour qu'elles collent au format utilisé par l'app

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors()); // autorise ton app/frontend à appeler ce backend

const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY; // ta clé, jamais dans le code ni le frontend
const RAPIDAPI_HOST = 'apifootball3.p.rapidapi.com';

if (!RAPIDAPI_KEY) {
  console.warn('⚠️  RAPIDAPI_KEY manquante — ajoute-la dans les variables d\'environnement.');
}

// Cache mémoire très simple : { clé: { data, expiresAt } }
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 secondes

async function cachedFetch(url) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expiresAt > now) {
    return hit.data;
  }
  const res = await fetch(url, {
    headers: {
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': RAPIDAPI_HOST
    }
  });
  const bodyText = await res.text();
  if (!res.ok) {
    const err = new Error(`API-Football a répondu ${res.status}: ${bodyText.slice(0, 300)}`);
    err.status = res.status;
    err.body = bodyText;
    throw err;
  }
  const data = JSON.parse(bodyText);
  cache.set(url, { data, expiresAt: now + CACHE_TTL_MS });
  return data;
}

// GET /api/fixtures?league_id=633&from=2026-09-20&to=2026-09-27
// Sans dates, on prend par défaut les 7 derniers jours à J+7.
// league_id dépend du référentiel de CETTE api (différent d'API-Football classique) —
// utilise get_leagues (à ajouter plus tard) pour trouver le bon id, ou laisse vide pour tout voir.
app.get('/api/fixtures', async (req, res) => {
  try {
    const today = new Date();
    const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
    const weekAhead = new Date(today); weekAhead.setDate(today.getDate() + 7);
    const fmt = d => d.toISOString().slice(0, 10);

    const {
      league_id,
      from = fmt(weekAgo),
      to = fmt(weekAhead)
    } = req.query;

    const params = new URLSearchParams({ action: 'get_events', from, to });
    if (league_id) params.set('league_id', league_id);

    const url = `https://${RAPIDAPI_HOST}/?${params.toString()}`;
    const raw = await cachedFetch(url);

    // La forme exacte des champs peut varier légèrement selon l'action —
    // on couvre les variantes de noms les plus courantes pour cette API.
    const list = Array.isArray(raw) ? raw : (raw.result || raw.events || []);
    const games = list.map(item => {
      const hs = item.match_hometeam_score ?? item.match_hometeam_score_ft ?? null;
      const as = item.match_awayteam_score ?? item.match_awayteam_score_ft ?? null;
      const statusRaw = (item.match_status || '').toString().trim();
      const status = statusRaw === 'FT' ? 'final'
                    : statusRaw === '' ? 'scheduled'
                    : 'live';
      return {
        id: item.match_id,
        status,
        date: item.match_date,
        time: item.match_time,
        home: item.match_hometeam_name,
        away: item.match_awayteam_name,
        hs, as,
        comp: item.league_name,
        country: item.country_name
      };
    });

    res.json({ games, count: games.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Erreur lors de la récupération des matchs.',
      detail: err.message || String(err)
    });
  }
});

app.get('/', (req, res) => {
  res.send('Backend Coup d\'Envoi actif. Essaie /api/fixtures (7 derniers jours à J+7 par défaut)');
});

app.listen(PORT, () => {
  console.log(`✅ Backend démarré sur le port ${PORT}`);
});
