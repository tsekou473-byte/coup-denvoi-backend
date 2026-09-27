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
const RAPIDAPI_HOST = 'api-football-v1.p.rapidapi.com';

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
  if (!res.ok) {
    throw new Error(`API-Football a répondu ${res.status}`);
  }
  const data = await res.json();
  cache.set(url, { data, expiresAt: now + CACHE_TTL_MS });
  return data;
}

// GET /api/fixtures?league=39&season=2026&date=2026-09-27
// league=39 correspond à la Premier League sur API-Football (à vérifier/adapter)
app.get('/api/fixtures', async (req, res) => {
  try {
    const { league = '39', season = '2026', date } = req.query;
    const params = new URLSearchParams({ league, season });
    if (date) params.set('date', date);

    const url = `https://${RAPIDAPI_HOST}/v3/fixtures?${params.toString()}`;
    const raw = await cachedFetch(url);

    // On simplifie la réponse pour coller au format attendu par l'app
    const games = (raw.response || []).map(item => ({
      id: item.fixture.id,
      status: item.fixture.status.short === 'FT' ? 'final'
             : item.fixture.status.short === 'NS' ? 'scheduled'
             : 'live',
      date: item.fixture.date,
      home: item.teams.home.name,
      homeLogo: item.teams.home.logo, // fourni par l'API — vérifie les CGU avant affichage public
      away: item.teams.away.name,
      awayLogo: item.teams.away.logo,
      hs: item.goals.home,
      as: item.goals.away,
      comp: item.league.name
    }));

    res.json({ games, cached: true, count: games.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des matchs.' });
  }
});

app.get('/', (req, res) => {
  res.send('Backend Coup d\'Envoi actif. Essaie /api/fixtures?league=39&season=2026');
});

app.listen(PORT, () => {
  console.log(`✅ Backend démarré sur le port ${PORT}`);
});
