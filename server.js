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

// Championnats "Coup d'Envoi" — league_id propres à cette API (ApiFootball3)
const LEAGUES = {
  PL:   { id: '152', name: 'Premier League' },
  LIGA: { id: '302', name: 'La Liga' },
  L1:   { id: '168', name: 'Ligue 1' },
  BL:   { id: '175', name: 'Bundesliga' },
  SA:   { id: '207', name: 'Serie A' },
  LDC:  { id: '3',   name: 'UEFA Champions League' }
};

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

app.get('/api/leagues', (req, res) => {
  res.json(Object.entries(LEAGUES).map(([code, l]) => ({ code, ...l })));
});

// GET /api/fixtures?comp=PL&from=2026-09-20&to=2026-09-27
// comp: PL, LIGA, L1, BL, SA, LDC (voir /api/leagues) — sans comp, toutes ligues confondues.
app.get('/api/fixtures', async (req, res) => {
  try {
    const today = new Date();
    const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
    const weekAhead = new Date(today); weekAhead.setDate(today.getDate() + 7);
    const fmt = d => d.toISOString().slice(0, 10);

    const {
      comp,
      league_id,
      from = fmt(weekAgo),
      to = fmt(weekAhead)
    } = req.query;

    const resolvedLeagueId = league_id || (comp && LEAGUES[comp.toUpperCase()]?.id);

    const params = new URLSearchParams({ action: 'get_events', from, to });
    if (resolvedLeagueId) params.set('league_id', resolvedLeagueId);

    const url = `https://${RAPIDAPI_HOST}/?${params.toString()}`;
    const raw = await cachedFetch(url);

    // La forme exacte des champs peut varier légèrement selon l'action —
    // on couvre les variantes de noms les plus courantes pour cette API.
    const list = Array.isArray(raw) ? raw : (raw.result || raw.events || []);
    const now = new Date();
    const games = list.map(item => {
      const hs = item.match_hometeam_score ?? null;
      const as = item.match_awayteam_score ?? null;

      let status = 'scheduled';
      if (item.match_date && item.match_time) {
        const kickoff = new Date(`${item.match_date}T${item.match_time}:00Z`);
        const twoHoursAfter = new Date(kickoff.getTime() + 2 * 60 * 60 * 1000);
        if (now > twoHoursAfter) status = 'final';
        else if (now > kickoff) status = 'live';
        else status = 'scheduled';
      }

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
