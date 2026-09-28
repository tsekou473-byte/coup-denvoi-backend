// Backend "Coup d'Envoi" — proxy + cache pour ApiFootball3 (RapidAPI)
// -------------------------------------------------------------------
// 1. Garde ta clé API côté serveur (jamais dans l'app)
// 2. Met les réponses en cache 60 s pour économiser ton quota gratuit
// 3. Simplifie les données pour l'app : /api/fixtures (liste) et /api/match (détail)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors()); // autorise l'app hébergée ailleurs à appeler ce backend

const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'apifootball3.p.rapidapi.com';

if (!RAPIDAPI_KEY) {
  console.warn('⚠️  RAPIDAPI_KEY manquante — ajoute-la dans les variables d\'environnement.');
}

// Championnats "Coup d'Envoi" — league_id propres à cette API
const LEAGUES = {
  PL:   { id: '152', name: 'Premier League' },
  LIGA: { id: '302', name: 'La Liga' },
  L1:   { id: '168', name: 'Ligue 1' },
  BL:   { id: '175', name: 'Bundesliga' },
  SA:   { id: '207', name: 'Serie A' },
  LDC:  { id: '3',   name: 'UEFA Champions League' }
};

// Cache mémoire simple : { url: { data, expiresAt } }
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;

async function cachedFetch(url) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expiresAt > now) return hit.data;

  const res = await fetch(url, {
    headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST }
  });
  const bodyText = await res.text();
  if (!res.ok) {
    const err = new Error(`API-Football a répondu ${res.status}: ${bodyText.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = JSON.parse(bodyText);
  cache.set(url, { data, expiresAt: now + CACHE_TTL_MS });
  return data;
}

const asList = raw => (Array.isArray(raw) ? raw : (raw.result || raw.events || []));
const arr = v => (Array.isArray(v) ? v : []);

// Statut réel fourni par l'API : "Finished", "" (pas commencé), ou la minute ("56") en direct
function statusOf(item, now = new Date()) {
  const st = (item.match_status || '').toString().trim();
  const liveFlag = item.match_live === '1' || item.match_live === 1;
  if (/^(finished|after|ft|aet|pen)/i.test(st)) return { status: 'final', minute: null };
  if (/postponed|cancel|abandon|suspend/i.test(st)) return { status: 'postponed', minute: null };
  if (liveFlag || /^\d+/.test(st) || /half|^ht$|break/i.test(st)) return { status: 'live', minute: st || null };
  if (st === '') return { status: 'scheduled', minute: null };
  // statut inconnu : on compare avec l'heure du match
  if (item.match_date && item.match_time) {
    const kickoff = new Date(`${item.match_date}T${item.match_time}:00Z`);
    if (now > new Date(kickoff.getTime() + 2 * 60 * 60 * 1000)) return { status: 'final', minute: null };
  }
  return { status: 'scheduled', minute: null };
}

function mapGame(item, now) {
  const { status, minute } = statusOf(item, now);
  return {
    id: item.match_id,
    status,
    minute,
    date: item.match_date,
    time: item.match_time,
    home: item.match_hometeam_name,
    away: item.match_awayteam_name,
    homeLogo: item.team_home_badge || item.match_hometeam_badge || null,
    awayLogo: item.team_away_badge || item.match_awayteam_badge || null,
    hs: item.match_hometeam_score ?? null,
    as: item.match_awayteam_score ?? null,
    comp: item.league_name,
    leagueId: item.league_id,
    country: item.country_name,
    countryLogo: item.country_logo || null
  };
}

// Détail complet d'un match : buts, cartons, remplacements, compositions, stats
function mapDetail(item) {
  const goals = arr(item.goalscorer).map(g => ({
    time: g.time,
    team: g.home_scorer ? 'home' : 'away',
    player: g.home_scorer || g.away_scorer || '',
    assist: g.home_assist || g.away_assist || '',
    score: g.score || '',
    info: g.info || ''
  }));

  const cards = arr(item.cards).map(c => ({
    time: c.time,
    team: c.home_fault ? 'home' : 'away',
    player: c.home_fault || c.away_fault || '',
    card: /red/i.test(c.card || '') ? 'red' : 'yellow',
    info: c.info || ''
  }));

  const subs = [];
  const subsRaw = item.substitutions || {};
  ['home', 'away'].forEach(side => {
    arr(subsRaw[side]).forEach(s => {
      const parts = String(s.substitution || '').split('|').map(x => x.trim());
      subs.push({ time: s.time, team: side, out: parts[0] || '', in: parts[1] || '' });
    });
  });

  const lu = item.lineup || {};
  const lineupSide = key => {
    const l = lu[key] || {};
    const p = x => ({ n: x.lineup_number, name: x.lineup_player, pos: x.lineup_position });
    return {
      starters: arr(l.starting_lineups).map(p),
      subs: arr(l.substitutes).map(p),
      coach: arr(l.coach).map(c => c.lineup_player).filter(Boolean).join(', ')
    };
  };

  return {
    ...mapGame(item),
    htHome: item.match_hometeam_halftime_score ?? '',
    htAway: item.match_awayteam_halftime_score ?? '',
    stadium: item.match_stadium || '',
    referee: item.match_referee || '',
    round: item.match_round || '',
    homeSystem: item.match_hometeam_system || '',
    awaySystem: item.match_awayteam_system || '',
    goals, cards, subs,
    lineups: { home: lineupSide('home'), away: lineupSide('away') },
    stats: arr(item.statistics).map(s => ({ type: s.type, home: s.home, away: s.away }))
  };
}

app.get('/', (req, res) => {
  res.send('Backend Coup d\'Envoi actif. Routes : /api/fixtures, /api/match, /api/leagues');
});

app.get('/api/leagues', (req, res) => {
  res.json(Object.entries(LEAGUES).map(([code, l]) => ({ code, ...l })));
});

// Debug : renvoie le 1er match brut (toutes les clés)
app.get('/api/raw', async (req, res) => {
  try {
    const today = new Date();
    const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
    const fmt = d => d.toISOString().slice(0, 10);
    const { comp = 'PL', from = fmt(weekAgo), to = fmt(today) } = req.query;
    const leagueId = LEAGUES[comp.toUpperCase()]?.id;
    const params = new URLSearchParams({ action: 'get_events', from, to });
    if (leagueId) params.set('league_id', leagueId);
    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?${params.toString()}`);
    res.json(asList(raw)[0] || { message: 'aucun match trouvé' });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/fixtures?from=2026-09-28&to=2026-09-28&comp=PL
// Sans comp : toutes les compétitions. Sans dates : 7 jours avant à 7 jours après.
app.get('/api/fixtures', async (req, res) => {
  try {
    const today = new Date();
    const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
    const weekAhead = new Date(today); weekAhead.setDate(today.getDate() + 7);
    const fmt = d => d.toISOString().slice(0, 10);

    const { comp, league_id, from = fmt(weekAgo), to = fmt(weekAhead) } = req.query;
    const resolvedLeagueId = league_id || (comp && LEAGUES[comp.toUpperCase()]?.id);

    const params = new URLSearchParams({ action: 'get_events', from, to });
    if (resolvedLeagueId) params.set('league_id', resolvedLeagueId);

    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?${params.toString()}`);
    const now = new Date();
    const games = asList(raw).map(item => mapGame(item, now));
    res.json({ games, count: games.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des matchs.', detail: err.message || String(err) });
  }
});

// GET /api/match?id=812694&date=2026-09-20  → détail d'un match
app.get('/api/match', async (req, res) => {
  try {
    const { id, date } = req.query;
    if (!id) return res.status(400).json({ error: 'Paramètre id manquant.' });
    const day = date || new Date().toISOString().slice(0, 10);

    const params = new URLSearchParams({ action: 'get_events', from: day, to: day, match_id: id });
    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?${params.toString()}`);
    const item = asList(raw).find(x => String(x.match_id) === String(id));
    if (!item) {
      return res.status(404).json({ error: 'Match introuvable.', detail: 'Aucun match avec cet identifiant à cette date.' });
    }
    res.json(mapDetail(item));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération du match.', detail: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend démarré sur le port ${PORT}`);
});
