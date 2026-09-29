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

// Deuxième fournisseur (API-SPORTS, abonnement direct) — utilisé pour les compétitions absentes du premier (ex. Afrique)
const APISPORTS_HOST = 'v3.football.api-sports.io';
const APISPORTS_KEY = process.env.APISPORTS_KEY;

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

// Cache mémoire : { url: { data, expiresAt } }
const cache = new Map();
const inflight = new Map();        // demandes identiques en cours : une seule requête vers le fournisseur
const CACHE_TTL_MS = 60 * 1000;    // durée de base : 60 s
const CACHE_MAX = 400;             // nombre maximum d'entrées gardées en mémoire

async function cachedFetch(url, ttl = CACHE_TTL_MS) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expiresAt > now) return hit.data;
  if (inflight.has(url)) return inflight.get(url);

  const job = (async () => {
    try {
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
      cache.set(url, { data, expiresAt: Date.now() + ttl });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return data;
    } catch (err) {
      // Fournisseur en panne ou quota dépassé : on sert la dernière copie connue plutôt qu'une erreur
      if (hit) {
        console.warn('Copie ancienne servie pour', url, '-', err.message);
        return hit.data;
      }
      throw err;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, job);
  return job;
}

// Durée de mise en cache selon les dates demandées : moins d'appels = moins de quota consommé
const DAY_MS = 24 * 60 * 60 * 1000;
const dayIso = offset => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
function fixturesTtl(from, to) {
  if (to && to < dayIso(-1)) return 6 * 60 * 60 * 1000;   // jours passés : les scores ne bougent plus
  if (from && from > dayIso(1)) return 15 * 60 * 1000;    // jours à venir : le programme change peu
  return CACHE_TTL_MS;                                     // autour d'aujourd'hui : 60 s
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
    homeId: item.match_hometeam_id ? String(item.match_hometeam_id) : '',
    awayId: item.match_awayteam_id ? String(item.match_awayteam_id) : '',
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

// Route très légère : sert à réveiller le serveur sans appeler le fournisseur
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// Appel au deuxième fournisseur (API-SPORTS, authentification différente : x-apisports-key)
async function cachedFetchDirect(url, ttl = CACHE_TTL_MS) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expiresAt > now) return hit.data;
  if (inflight.has(url)) return inflight.get(url);
  const job = (async () => {
    try {
      const res = await fetch(url, { headers: { 'x-apisports-key': APISPORTS_KEY } });
      const bodyText = await res.text();
      if (!res.ok) { const err = new Error(`API-SPORTS a répondu ${res.status}: ${bodyText.slice(0, 300)}`); err.status = res.status; throw err; }
      const data = JSON.parse(bodyText);
      cache.set(url, { data, expiresAt: Date.now() + ttl });
      return data;
    } catch (err) {
      if (hit) return hit.data;
      throw err;
    } finally { inflight.delete(url); }
  })();
  inflight.set(url, job);
  return job;
}

// Debug temporaire : cherche des compétitions par mot-clé chez API-SPORTS (pour trouver les bons league_id une fois)
app.get('/api/africa-search', async (req, res) => {
  try {
    if (!APISPORTS_KEY) return res.status(400).json({ error: 'APISPORTS_KEY manquante sur le serveur.' });
    const { q = 'Africa' } = req.query;
    const data = await cachedFetchDirect(`https://${APISPORTS_HOST}/leagues?search=${encodeURIComponent(q)}`, 60 * 60 * 1000);
    const list = (data.response || []).map(x => ({ id: x.league.id, name: x.league.name, type: x.league.type, country: x.country.name }));
    res.json({ count: list.length, leagues: list });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/', (req, res) => {
  res.send('Backend Coup d\'Envoi actif. Routes : /health, /api/fixtures, /api/team, /api/match, /api/standings, /api/competitions, /api/leagues');
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

// GET /api/fixtures?from=2026-09-28&to=2026-09-28&comp=PL   (option : &team_id=3103 pour les matchs d'une équipe)
// Sans comp : toutes les compétitions. Sans dates : 7 jours avant à 7 jours après.
app.get('/api/fixtures', async (req, res) => {
  try {
    const today = new Date();
    const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
    const weekAhead = new Date(today); weekAhead.setDate(today.getDate() + 7);
    const fmt = d => d.toISOString().slice(0, 10);

    const { comp, league_id, team_id, from = fmt(weekAgo), to = fmt(weekAhead) } = req.query;
    const resolvedLeagueId = league_id || (comp && LEAGUES[comp.toUpperCase()]?.id);

    const params = new URLSearchParams({ action: 'get_events', from, to });
    if (resolvedLeagueId) params.set('league_id', resolvedLeagueId);
    if (team_id) params.set('team_id', team_id);

    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?${params.toString()}`, fixturesTtl(from, to));
    const now = new Date();
    let list = asList(raw);
    // on filtre aussi ici, au cas où le fournisseur ignorerait team_id
    if (team_id) list = list.filter(x => String(x.match_hometeam_id) === String(team_id) || String(x.match_awayteam_id) === String(team_id));
    const games = list.map(item => mapGame(item, now));
    res.json({ games, count: games.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des matchs.', detail: err.message || String(err) });
  }
});

// GET /api/competitions → toutes les compétitions disponibles avec ton abonnement (liste mise en cache 6 h)
app.get('/api/competitions', async (req, res) => {
  try {
    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_leagues`, 6 * 60 * 60 * 1000);
    const competitions = asList(raw)
      .filter(x => x && x.league_id)
      .map(x => ({
        id: String(x.league_id),
        name: x.league_name,
        country: x.country_name,
        season: x.league_season || '',
        logo: x.league_logo || null,
        flag: x.country_logo || null
      }));
    res.json({ competitions, count: competitions.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des compétitions.', detail: err.message || String(err) });
  }
});

// Une ligne de classement, en tolérant quelques variantes de noms de champs
function mapStanding(x) {
  const n = v => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? null : Number(v);
  return {
    pos: n(x.overall_league_position ?? x.position),
    teamId: x.team_id ? String(x.team_id) : '',
    team: x.team_name,
    badge: x.team_badge || null,
    played: n(x.overall_league_payed ?? x.overall_league_played ?? x.played),
    w: n(x.overall_league_W),
    d: n(x.overall_league_D),
    l: n(x.overall_league_L),
    gf: n(x.overall_league_GF),
    ga: n(x.overall_league_GA),
    pts: n(x.overall_league_PTS ?? x.points),
    zone: x.overall_promotion || '',
    stage: x.stage_name || ''
  };
}

// GET /api/standings?league_id=152 → classement d'une compétition (mis en cache 10 min)
app.get('/api/standings', async (req, res) => {
  try {
    const { league_id } = req.query;
    if (!league_id) return res.status(400).json({ error: 'Paramètre league_id manquant.' });
    let list = [];
    try {
      const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_standings&league_id=${encodeURIComponent(league_id)}`, 10 * 60 * 1000);
      list = asList(raw);
    } catch (err) {
      if (err.status !== 404) throw err;   // 404 = pas de classement pour cette compétition
    }
    const rows = list.filter(x => x && x.team_name).map(mapStanding);
    const out = { rows, count: rows.length };
    if (!rows.length) {
      out.note = 'Aucun classement renvoyé par le fournisseur pour cette compétition.';
      out.sampleKeys = list[0] ? Object.keys(list[0]).slice(0, 30) : [];
    }
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération du classement.', detail: err.message || String(err) });
  }
});

const POS_ORDER = { Goalkeepers: 0, Defenders: 1, Midfielders: 2, Forwards: 3 };
function mapPlayer(x) {
  const n = v => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? null : Number(v);
  return {
    id: x.player_id ? String(x.player_id) : '',
    name: x.player_name,
    fullName: x.player_complete_name || x.player_name,
    number: n(x.player_number),
    age: n(x.player_age),
    birthdate: x.player_birthdate || null,
    country: x.player_country || null,
    position: x.player_type || null,
    photo: x.player_image || null,
    captain: x.player_is_captain === '1' || x.player_is_captain === 1,
    injured: /^y/i.test(x.player_injured || ''),
    stats: {
      apps: n(x.player_match_played), goals: n(x.player_goals), assists: n(x.player_assists),
      yellow: n(x.player_yellow_cards), red: n(x.player_red_cards), rating: x.player_rating || null
    }
  };
}

// GET /api/team?league_id=152&team_id=3103 → effectif d'une équipe (mis en cache 6 h : un effectif change peu)
app.get('/api/team', async (req, res) => {
  try {
    const { league_id, team_id } = req.query;
    if (!league_id || !team_id) return res.status(400).json({ error: 'Paramètres league_id et team_id requis.' });
    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_teams&league_id=${encodeURIComponent(league_id)}`, 6 * 60 * 60 * 1000);
    const team = asList(raw).find(t => String(t.team_key) === String(team_id));
    if (!team) return res.status(404).json({ error: 'Équipe introuvable.', detail: "Aucune équipe avec cet identifiant dans cette compétition." });
    const players = arr(team.players)
      .map(mapPlayer)
      .sort((a, b) => (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9) || (a.number ?? 99) - (b.number ?? 99));
    res.json({ id: String(team.team_key), name: team.team_name, badge: team.team_badge || null, country: team.team_country || null, players });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la récupération de l'effectif.", detail: err.message || String(err) });
  }
});

// GET /api/match?id=812694&date=2026-09-20  → détail d'un match
app.get('/api/match', async (req, res) => {
  try {
    const { id, date } = req.query;
    if (!id) return res.status(400).json({ error: 'Paramètre id manquant.' });
    const day = date || new Date().toISOString().slice(0, 10);

    const params = new URLSearchParams({ action: 'get_events', from: day, to: day, match_id: id });
    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?${params.toString()}`, fixturesTtl(day, day));
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
