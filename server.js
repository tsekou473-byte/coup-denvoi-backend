// Backend "Coup d'Envoi" — proxy + cache pour deux fournisseurs de données football
// -------------------------------------------------------------------------------
// Fournisseur 1 (ApiFootball3, via RapidAPI) : tous les championnats du quotidien.
// Fournisseur 2 (API-SPORTS, abonnement direct) : compétitions absentes du 1er (Afrique).
// Les identifiants de compétition du fournisseur 2 sont préfixés "afr:" partout dans
// l'app (ex. league_id=afr:12) — c'est ce préfixe qui déclenche le bon fournisseur,
// sans que le reste du code de l'app ait besoin de le savoir.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors()); // autorise l'app hébergée ailleurs à appeler ce backend

const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'apifootball3.p.rapidapi.com';

const APISPORTS_HOST = 'v3.football.api-sports.io';
const APISPORTS_KEY = process.env.APISPORTS_KEY;

if (!RAPIDAPI_KEY) {
  console.warn('⚠️  RAPIDAPI_KEY manquante — ajoute-la dans les variables d\'environnement.');
}
if (!APISPORTS_KEY) {
  console.warn('⚠️  APISPORTS_KEY manquante — les compétitions africaines ne seront pas disponibles.');
}

// Championnats "Coup d'Envoi" (fournisseur 1) — league_id propres à cette API
const LEAGUES = {
  PL:   { id: '152', name: 'Premier League' },
  LIGA: { id: '302', name: 'La Liga' },
  L1:   { id: '168', name: 'Ligue 1' },
  BL:   { id: '175', name: 'Bundesliga' },
  SA:   { id: '207', name: 'Serie A' },
  LDC:  { id: '3',   name: 'UEFA Champions League' }
};

// Compétitions africaines (fournisseur 2) — league_id propres à API-SPORTS.
// Les noms restent en anglais ici : c'est l'app qui les traduit (réglage « Noms en français »).
const AFRICA_LEAGUES = {
  AFCON:   { id: '6',   name: 'Africa Cup of Nations',                 country: 'Africa' },
  CAFCL:   { id: '12',  name: 'CAF Champions League',                  country: 'Africa' },
  CAFCONF: { id: '20',  name: 'CAF Confederation Cup',                 country: 'Africa' },
  CAFSC:   { id: '533', name: 'CAF Super Cup',                         country: 'Africa' },
  CHAN:    { id: '19',  name: 'African Nations Championship',          country: 'Africa' },
  AFCONQ:  { id: '36',  name: 'Africa Cup of Nations - Qualification', country: 'Africa' },
  WCQAF:   { id: '29',  name: 'World Cup - Qualification Africa',      country: 'Africa' },
  PSL:     { id: '288', name: 'Premier Soccer League',                 country: 'South-Africa' }
};
const AFR_BY_ID = Object.fromEntries(Object.values(AFRICA_LEAGUES).map(l => [l.id, l]));
const TZ = 'Europe/Paris';   // même fuseau que le fournisseur 1, pour que les heures soient cohérentes
const AFR_PREFIX = 'afr:';
let afrQuota = { remaining: null, limit: null, at: null };   // quota du jour restant, lu dans les en-têtes d'API-SPORTS
const isAfr = v => typeof v === 'string' && v.startsWith(AFR_PREFIX);
const stripAfr = v => v.slice(AFR_PREFIX.length);

// Cache mémoire partagé par les deux fournisseurs : { url: { data, expiresAt } }
const cache = new Map();
const inflight = new Map();        // demandes identiques en cours : une seule requête vers le fournisseur
const CACHE_TTL_MS = 60 * 1000;    // durée de base : 60 s
const CACHE_MAX = 400;             // nombre maximum d'entrées gardées en mémoire

function rememberAndTrim(url, data, ttl) {
  cache.set(url, { data, expiresAt: Date.now() + ttl });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Fournisseur 1 : ApiFootball3 (RapidAPI)
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
      rememberAndTrim(url, data, ttl);
      return data;
    } catch (err) {
      if (hit) { console.warn('Copie ancienne servie pour', url, '-', err.message); return hit.data; }
      throw err;
    } finally { inflight.delete(url); }
  })();
  inflight.set(url, job);
  return job;
}

// Fournisseur 2 : API-SPORTS (abonnement direct, authentification différente)
async function cachedFetchDirect(url, ttl = CACHE_TTL_MS, transform) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expiresAt > now) return hit.data;
  if (inflight.has(url)) return inflight.get(url);

  const job = (async () => {
    try {
      if (!APISPORTS_KEY) { const err = new Error('APISPORTS_KEY manquante sur le serveur.'); err.status = 400; throw err; }
      const res = await fetch(url, { headers: { 'x-apisports-key': APISPORTS_KEY } });
      const rem = res.headers && res.headers.get && res.headers.get('x-ratelimit-requests-remaining');
      if (rem != null) afrQuota = { remaining: Number(rem), limit: Number(res.headers.get('x-ratelimit-requests-limit')) || null, at: new Date().toISOString() };
      const bodyText = await res.text();
      if (!res.ok) { const err = new Error(`API-SPORTS a répondu ${res.status}: ${bodyText.slice(0, 300)}`); err.status = res.status; throw err; }
      const data = JSON.parse(bodyText);
      // API-SPORTS répond parfois 200 avec un champ "errors" (quota dépassé, plan gratuit limité...) : on ne le met pas en cache
      const errs = data && data.errors;
      const msgs = Array.isArray(errs) ? errs : Object.values(errs || {});
      if (msgs.length) { const err = new Error(msgs.join(' | ').slice(0, 300)); err.status = 502; throw err; }
      const out = transform ? transform(data) : data;
      rememberAndTrim(url, out, typeof ttl === 'function' ? ttl(out) : ttl);
      return out;
    } catch (err) {
      if (hit) { console.warn('Copie ancienne servie pour', url, '-', err.message); return hit.data; }
      throw err;
    } finally { inflight.delete(url); }
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
const seasonFromDate = d => (d && /^\d{4}/.test(d)) ? Number(d.slice(0, 4)) : new Date().getFullYear();

const asList = raw => (Array.isArray(raw) ? raw : (raw.result || raw.events || []));
const arr = v => (Array.isArray(v) ? v : []);
const numOrNull = v => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? null : Number(v);

/* ============================= Fournisseur 1 ============================= */

// Statut réel fourni par l'API : "Finished", "" (pas commencé), ou la minute ("56") en direct
function statusOf(item, now = new Date()) {
  const st = (item.match_status || '').toString().trim();
  const liveFlag = item.match_live === '1' || item.match_live === 1;
  if (/^(finished|after|ft|aet|pen)/i.test(st)) return { status: 'final', minute: null };
  if (/postponed|cancel|abandon|suspend/i.test(st)) return { status: 'postponed', minute: null };
  if (liveFlag || /^\d+/.test(st) || /half|^ht$|break/i.test(st)) return { status: 'live', minute: st || null };
  if (st === '') return { status: 'scheduled', minute: null };
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
    status, minute,
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

function mapDetail(item) {
  const goals = arr(item.goalscorer).map(g => ({
    time: g.time, team: g.home_scorer ? 'home' : 'away',
    player: g.home_scorer || g.away_scorer || '', assist: g.home_assist || g.away_assist || '',
    score: g.score || '', info: g.info || ''
  }));
  const cards = arr(item.cards).map(c => ({
    time: c.time, team: c.home_fault ? 'home' : 'away',
    player: c.home_fault || c.away_fault || '', card: /red/i.test(c.card || '') ? 'red' : 'yellow', info: c.info || ''
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
    return { starters: arr(l.starting_lineups).map(p), subs: arr(l.substitutes).map(p), coach: arr(l.coach).map(c => c.lineup_player).filter(Boolean).join(', ') };
  };
  return {
    ...mapGame(item),
    htHome: item.match_hometeam_halftime_score ?? '', htAway: item.match_awayteam_halftime_score ?? '',
    stadium: item.match_stadium || '', referee: item.match_referee || '', round: item.match_round || '',
    homeSystem: item.match_hometeam_system || '', awaySystem: item.match_awayteam_system || '',
    goals, cards, subs,
    lineups: { home: lineupSide('home'), away: lineupSide('away') },
    stats: arr(item.statistics).map(s => ({ type: s.type, home: s.home, away: s.away }))
  };
}

function mapStanding(x) {
  const n = numOrNull;
  return {
    pos: n(x.overall_league_position ?? x.position), teamId: x.team_id ? String(x.team_id) : '', team: x.team_name, badge: x.team_badge || null,
    played: n(x.overall_league_payed ?? x.overall_league_played ?? x.played), w: n(x.overall_league_W), d: n(x.overall_league_D), l: n(x.overall_league_L),
    gf: n(x.overall_league_GF), ga: n(x.overall_league_GA), pts: n(x.overall_league_PTS ?? x.points), zone: x.overall_promotion || '', stage: x.stage_name || ''
  };
}

const POS_ORDER = { Goalkeepers: 0, Defenders: 1, Midfielders: 2, Forwards: 3 };
function mapPlayer(x) {
  const n = numOrNull;
  return {
    id: x.player_id ? String(x.player_id) : '', name: x.player_name, fullName: x.player_complete_name || x.player_name,
    number: n(x.player_number), age: n(x.player_age), birthdate: x.player_birthdate || null, country: x.player_country || null,
    position: x.player_type || null, photo: x.player_image || null,
    captain: x.player_is_captain === '1' || x.player_is_captain === 1, injured: /^y/i.test(x.player_injured || ''),
    stats: { apps: n(x.player_match_played), goals: n(x.player_goals), assists: n(x.player_assists), yellow: n(x.player_yellow_cards), red: n(x.player_red_cards), rating: x.player_rating || null }
  };
}

/* ============================= Fournisseur 2 (Afrique) ============================= */

function mapAfrStatus(short, elapsed) {
  if (/^(FT|AET|PEN)$/.test(short)) return { status: 'final', minute: null };
  if (/^(PST|CANC|ABD|AWD|WO|SUSP)$/.test(short)) return { status: 'postponed', minute: null };
  if (/^(NS|TBD)$/.test(short)) return { status: 'scheduled', minute: null };
  if (short === 'HT') return { status: 'live', minute: 'HT' };
  return { status: 'live', minute: elapsed != null ? String(elapsed) : null };
}

// Saison en cours d'une compétition (1 appel, mis en cache 6 h). Repli : année de la date demandée.
async function afrSeason(leagueNum, hintDate) {
  try {
    const data = await cachedFetchDirect(`https://${APISPORTS_HOST}/leagues?id=${encodeURIComponent(leagueNum)}`, 6 * 60 * 60 * 1000);
    const seasons = arr((arr(data.response)[0] || {}).seasons);
    const cur = seasons.find(x => x.current) || seasons[seasons.length - 1];
    if (cur && cur.year) return cur.year;
  } catch (e) { console.warn('Saison non déterminée pour la compétition', leagueNum, '-', e.message); }
  return seasonFromDate(hintDate);
}

function mapAfrFixture(item) {
  const { status, minute } = mapAfrStatus(item.fixture.status?.short, item.fixture.status?.elapsed);
  const iso = item.fixture.date || '';       // avec le paramètre timezone : « 2026-09-29T22:00:00+02:00 » (heure de Paris)
  const meta = AFR_BY_ID[String(item.league.id)] || {};
  return {
    id: AFR_PREFIX + item.fixture.id,
    status, minute,
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    home: item.teams.home.name,
    away: item.teams.away.name,
    homeId: AFR_PREFIX + item.teams.home.id,
    awayId: AFR_PREFIX + item.teams.away.id,
    homeLogo: item.teams.home.logo || null,
    awayLogo: item.teams.away.logo || null,
    hs: item.goals?.home ?? null,
    as: item.goals?.away ?? null,
    comp: meta.name || item.league.name,
    leagueId: AFR_PREFIX + item.league.id,
    country: meta.country || 'Africa',
    countryLogo: null
  };
}

function mapAfrStanding(row, multiGroup) {
  return {
    pos: numOrNull(row.rank), teamId: AFR_PREFIX + row.team.id, team: row.team.name, badge: row.team.logo || null,
    played: numOrNull(row.all?.played), w: numOrNull(row.all?.win), d: numOrNull(row.all?.draw), l: numOrNull(row.all?.lose),
    gf: numOrNull(row.all?.goals?.for), ga: numOrNull(row.all?.goals?.against), pts: numOrNull(row.points),
    zone: row.description || '', stage: multiGroup ? (row.group || '') : ''
  };
}

const validFx = f => !!(f && f.fixture && f.league && f.teams && f.teams.home && f.teams.away);

// Les noms de poste d'API-SPORTS (singulier) sont convertis vers le vocabulaire déjà utilisé par l'app (pluriel)
const AFR_POSITIONS = { Goalkeeper: 'Goalkeepers', Defender: 'Defenders', Midfielder: 'Midfielders', Attacker: 'Forwards' };

async function afrFetchDetail(fixtureId) {
  const base = `https://${APISPORTS_HOST}`;
  const infoData = await cachedFetchDirect(`${base}/fixtures?id=${encodeURIComponent(fixtureId)}&timezone=${encodeURIComponent(TZ)}`, afrDetailTtl);
  const item = (infoData.response || [])[0];
  if (!item) return null;

  // Un seul appel suffit normalement : la fiche d'un match contient déjà événements, compositions et statistiques.
  // On ne demande ces éléments à part que s'ils manquent (le quota gratuit est de 100 appels par jour).
  const part = async (own, path) => own !== undefined ? own : arr((await cachedFetchDirect(`${base}/${path}?fixture=${encodeURIComponent(fixtureId)}`, 60 * 1000)).response);
  const [events, lineups, statistics] = await Promise.all([
    part(item.events, 'fixtures/events'), part(item.lineups, 'fixtures/lineups'), part(item.statistics, 'fixtures/statistics')
  ]);

  const g = mapAfrFixture(item);
  const homeNum = item.teams.home.id, awayNum = item.teams.away.id;
  const lus = arr(lineups);
  const luOf = teamNum => lus.find(x => String(x.team?.id) === String(teamNum));

  // Titulaires connus (pour savoir, dans un remplacement, qui sort et qui entre)
  const starterIds = new Set();
  lus.forEach(l => arr(l.startXI).forEach(x => { if (x.player?.id != null) starterIds.add(String(x.player.id)); }));

  const goals = [], cards = [], subs = [];
  let h = 0, a = 0;
  arr(events).forEach(e => {
    const side = String(e.team?.id) === String(homeNum) ? 'home' : 'away';
    const time = String(e.time?.elapsed ?? '') + (e.time?.extra ? '+' + e.time.extra : '');
    if (e.type === 'Goal') {
      if (/missed/i.test(e.detail || '')) return;
      if (side === 'home') h++; else a++;
      goals.push({ time, team: side, player: e.player?.name || '', assist: e.assist?.name || '', score: `${h} - ${a}`, info: /penalty/i.test(e.detail || '') ? 'Penalty' : (/own/i.test(e.detail || '') ? 'Own goal' : '') });
    } else if (e.type === 'Card') {
      cards.push({ time, team: side, player: e.player?.name || '', card: /red/i.test(e.detail || '') ? 'red' : 'yellow', info: e.detail || '' });
    } else if (/^subst/i.test(e.type || '')) {
      // Convention d'API-SPORTS : « player » sort et « assist » entre. Si les compositions montrent le contraire, on inverse.
      let out = e.player, inn = e.assist;
      if (starterIds.size && inn && out && starterIds.has(String(inn.id)) && !starterIds.has(String(out.id))) { out = e.assist; inn = e.player; }
      subs.push({ time, team: side, out: out?.name || '', in: inn?.name || '' });
    }
  });

  // Compositions : titulaires rangés selon leur position sur le terrain (grille « ligne:colonne »), numérotés 1 à 11
  const lineupSide = teamNum => {
    const l = luOf(teamNum);
    if (!l) return { starters: [], subs: [], coach: '' };
    const gridKey = x => { const m = String(x.player?.grid || '99:99').split(':').map(Number); return (m[0] || 99) * 100 + (m[1] || 99); };
    const starters = arr(l.startXI).slice().sort((x, y) => gridKey(x) - gridKey(y))
      .map((x, i) => ({ n: x.player?.number != null ? String(x.player.number) : '', name: x.player?.name || '', pos: String(i + 1) }));
    const bench = arr(l.substitutes).map(x => ({ n: x.player?.number != null ? String(x.player.number) : '', name: x.player?.name || '', pos: '0' }));
    return { starters, subs: bench, coach: l.coach?.name || '' };
  };

  // Statistiques : une liste par équipe, fusionnées par type
  const statsList = arr(statistics);
  const statsFor = teamNum => (statsList.find(x => String(x.team?.id) === String(teamNum)) || {}).statistics || [];
  const homeStats = statsFor(homeNum), awayStats = statsFor(awayNum);
  const types = [...new Set([...homeStats, ...awayStats].map(x => x.type))];
  const stats = types.map(type => ({
    type,
    home: (homeStats.find(x => x.type === type) || {}).value ?? '0',
    away: (awayStats.find(x => x.type === type) || {}).value ?? '0'
  }));

  return {
    ...g,
    htHome: item.score?.halftime?.home ?? '', htAway: item.score?.halftime?.away ?? '',
    stadium: item.fixture.venue?.name || '', referee: item.fixture.referee || '', round: item.league.round || '',
    homeSystem: luOf(homeNum)?.formation || '', awaySystem: luOf(awayNum)?.formation || '',
    goals, cards, subs,
    lineups: { home: lineupSide(homeNum), away: lineupSide(awayNum) },
    stats
  };
}

// Effectif d'une équipe (l'identifiant peut arriver avec le préfixe « afr: »)
async function afrFetchSquad(teamId) {
  const num = String(teamId).replace(AFR_PREFIX, '');
  const data = await cachedFetchDirect(`https://${APISPORTS_HOST}/players/squads?team=${encodeURIComponent(num)}`, 6 * 60 * 60 * 1000);
  const block = (data.response || [])[0];
  if (!block) return null;
  const players = arr(block.players).map(p => {
    const position = AFR_POSITIONS[p.position] || p.position || null;
    return {
      id: String(p.id), name: p.name, fullName: p.name, number: numOrNull(p.number), age: numOrNull(p.age),
      birthdate: null, country: null, position, photo: p.photo || null, captain: false, injured: false,
      stats: { apps: null, goals: null, assists: null, yellow: null, red: null, rating: null }
    };
  }).sort((a, b) => (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9) || (a.number ?? 99) - (b.number ?? 99));
  return { id: AFR_PREFIX + block.team.id, name: block.team.name, badge: block.team.logo || null, country: null, players };
}

// Le plan gratuit refuse « compétition + saison » pour les saisons récentes, mais accepte « un jour donné ».
// On lit donc jour par jour ; la réponse d'un jour sert à la fois à la liste du jour et aux pages de compétition.
// On ne garde en mémoire que les compétitions africaines : la réponse complète d'un jour est énorme.
const afrOnly = d => ({ errors: d.errors, response: arr(d.response).filter(f => validFx(f) && AFR_BY_ID[String(f.league.id)]) });
// Durée en mémoire d'un jour : court seulement s'il y a un match en cours ou sur le point de commencer, long sinon.
// Ainsi les heures creuses ne coûtent presque rien sur les 100 requêtes du jour.
const AFR_DONE = /^(NS|TBD|FT|AET|PEN|PST|CANC|ABD|AWD|WO)$/;
function afrDayTtl(date) {
  if (!(date >= dayIso(-1) && date <= dayIso(1))) return fixturesTtl(date, date);   // jours passés : 6 h ; jours à venir : 15 min
  return out => {
    const now = Date.now();
    const busy = arr(out.response).some(f => {
      const st = f.fixture && f.fixture.status && f.fixture.status.short;
      if (st && !AFR_DONE.test(st)) return true;                                         // match en cours (mi-temps comprise)
      const t = Date.parse(f.fixture && f.fixture.date);
      return st === 'NS' && t && t > now - 10 * 60 * 1000 && t < now + 30 * 60 * 1000;   // coup d'envoi imminent
    });
    return busy ? 5 * 60 * 1000 : 20 * 60 * 1000;
  };
}
// Fiche d'un match : terminé = ne change plus (6 h) ; sinon 1 minute
const afrDetailTtl = out => {
  const st = out && out.response && out.response[0] && out.response[0].fixture && out.response[0].fixture.status && out.response[0].fixture.status.short;
  return /^(FT|AET|PEN)$/.test(st || '') ? 6 * 60 * 60 * 1000 : 60 * 1000;
};
const afrDay = date => cachedFetchDirect(`https://${APISPORTS_HOST}/fixtures?date=${date}&timezone=${encodeURIComponent(TZ)}`, afrDayTtl(date), afrOnly);
// Fenêtre limitée autour d'aujourd'hui : 7 jours = 7 requêtes au maximum, une seule fois (ensuite en mémoire)
function afrWindow(from, to) {
  const lo = from > dayIso(-3) ? from : dayIso(-3);
  const hi = to < dayIso(3) ? to : dayIso(3);
  const days = [];
  for (let d = lo; d <= hi && days.length < 7; d = new Date(new Date(d + 'T00:00:00Z').getTime() + DAY_MS).toISOString().slice(0, 10)) days.push(d);
  return days;
}
const AFR_STANDINGS_NOTE = "Le classement de cette compétition n'est pas disponible avec l'abonnement gratuit du fournisseur de données.";
const afrStandingsBlocked = new Map();   // compétition -> moment où le blocage a été constaté (évite de gaspiller des appels)

/* ============================= Routes ============================= */

app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

app.get('/', (req, res) => {
  res.send('Backend Coup d\'Envoi actif. Routes : /health, /api/fixtures, /api/team, /api/match, /api/standings, /api/competitions, /api/leagues (compétitions africaines : identifiants « afr:… »)');
});

// Diagnostic temporaire : montre ce que API-SPORTS renvoie vraiment pour un match africain et son classement (≈ 4 appels)
async function rawDirect(path) {
  const r = await fetch(`https://${APISPORTS_HOST}${path}`, { headers: { 'x-apisports-key': APISPORTS_KEY } });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { http: r.status, remaining: r.headers.get('x-ratelimit-requests-remaining'), limit: r.headers.get('x-ratelimit-requests-limit'), json };
}
app.get('/api/afr-debug', async (req, res) => {
  try {
    if (!APISPORTS_KEY) return res.status(400).json({ error: 'APISPORTS_KEY manquante.' });
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const list = await rawDirect(`/fixtures?date=${date}&timezone=${encodeURIComponent(TZ)}`);
    const afr = arr(list.json && list.json.response).filter(f => AFR_BY_ID[String(f.league && f.league.id)]);
    const out = { date, http: list.http, quotaRestant: list.remaining, quotaTotal: list.limit, erreurs: list.json && list.json.errors, matchsAfricains: afr.length };
    const pick = afr.find(f => f.fixture.status.short === 'FT') || afr[0];
    if (pick) {
      const one = await rawDirect(`/fixtures?id=${pick.fixture.id}&timezone=${encodeURIComponent(TZ)}`);
      const it = arr(one.json && one.json.response)[0] || {};
      const count = v => v === undefined ? 'absent' : arr(v).length;
      out.match = {
        id: pick.fixture.id, rencontre: `${pick.teams.home.name} - ${pick.teams.away.name}`, statut: pick.fixture.status.short,
        competition: pick.league.name, competitionId: pick.league.id, erreurs: one.json && one.json.errors,
        evenements: count(it.events), compositions: count(it.lineups), statistiques: count(it.statistics), cles: Object.keys(it)
      };
      const lg = await rawDirect(`/leagues?id=${pick.league.id}`);
      const seasons = arr(arr(lg.json && lg.json.response)[0] && arr(lg.json.response)[0].seasons);
      out.saisons = seasons.slice(-3).map(x => ({ annee: x.year, courante: !!x.current, couverture: {
        classement: x.coverage && x.coverage.standings,
        evenements: x.coverage && x.coverage.fixtures && x.coverage.fixtures.events,
        compositions: x.coverage && x.coverage.fixtures && x.coverage.fixtures.lineups,
        statistiques: x.coverage && x.coverage.fixtures && x.coverage.fixtures.statistics_fixtures } }));
      const cur = seasons.find(x => x.current) || seasons[seasons.length - 1];
      if (cur) {
        const st = await rawDirect(`/standings?league=${pick.league.id}&season=${cur.year}`);
        const groups = arr(arr(st.json && st.json.response)[0] && arr(st.json.response)[0].league && arr(st.json.response)[0].league.standings);
        out.classement = { saisonUtilisee: cur.year, erreurs: st.json && st.json.errors, groupes: groups.length, lignes: groups.flat().length };
      }
      out.quotaRestantFin = lg.remaining;
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/api/leagues', (req, res) => {
  res.json(Object.entries(LEAGUES).map(([code, l]) => ({ code, ...l })));
});

// Debug : renvoie le 1er match brut (fournisseur 1, toutes les clés)
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

// GET /api/fixtures?from=...&to=...&comp=PL (ou comp=AFCON pour l'Afrique)  — &team_id= optionnel
app.get('/api/fixtures', async (req, res) => {
  try {
    const today = new Date();
    const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
    const weekAhead = new Date(today); weekAhead.setDate(today.getDate() + 7);
    const fmt = d => d.toISOString().slice(0, 10);
    const { comp, league_id, team_id, from = fmt(weekAgo), to = fmt(weekAhead) } = req.query;

    const africaCode = comp && AFRICA_LEAGUES[comp.toUpperCase()];
    const resolvedLeagueId = league_id || (comp && LEAGUES[comp.toUpperCase()]?.id) || (africaCode && AFR_PREFIX + africaCode.id);

    if (resolvedLeagueId && isAfr(resolvedLeagueId)) {
      const leagueNum = stripAfr(resolvedLeagueId);
      const days = afrWindow(from, to);
      const games = [];
      let failed = 0, lastErr = null;
      for (const day of days) {   // l'un après l'autre : le plan gratuit limite à 10 requêtes par minute
        try { arr((await afrDay(day)).response).forEach(f => { if (validFx(f) && String(f.league.id) === leagueNum) games.push(mapAfrFixture(f)); }); }
        catch (e) { failed++; lastErr = e; }
      }
      if (days.length && failed === days.length) throw lastErr;
      games.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      return res.json({ games, count: games.length, note: failed ? "Certains jours n'ont pas pu être chargés (limite du fournisseur). Réessaie dans une minute." : undefined });
    }

    const params = new URLSearchParams({ action: 'get_events', from, to });
    if (resolvedLeagueId) params.set('league_id', resolvedLeagueId);
    if (team_id) params.set('team_id', team_id);
    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?${params.toString()}`, fixturesTtl(from, to));
    const now = new Date();
    let list = asList(raw);
    if (team_id) list = list.filter(x => String(x.match_hometeam_id) === String(team_id) || String(x.match_awayteam_id) === String(team_id));
    let games = list.map(item => mapGame(item, now));

    // Liste d'un seul jour, toutes compétitions : on y ajoute les matchs africains (fournisseur 2).
    // Un seul appel, filtré ici ; si ce fournisseur est indisponible, la liste principale n'est pas touchée.
    if (!resolvedLeagueId && !team_id && from === to && APISPORTS_KEY) {
      try {
        const d2 = await afrDay(from);
        games = games.concat(arr(d2.response).filter(f => validFx(f) && AFR_BY_ID[String(f.league.id)]).map(mapAfrFixture));
      } catch (e) { console.warn('Matchs africains indisponibles :', e.message); }
    }
    res.json({ games, count: games.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des matchs.', detail: err.message || String(err) });
  }
});

// GET /api/competitions → toutes les compétitions des deux fournisseurs (liste mise en cache 6 h)
app.get('/api/competitions', async (req, res) => {
  try {
    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_leagues`, 6 * 60 * 60 * 1000);
    const competitions = asList(raw)
      .filter(x => x && x.league_id)
      .map(x => ({ id: String(x.league_id), name: x.league_name, country: x.country_name, season: x.league_season || '', logo: x.league_logo || null, flag: x.country_logo || null }));

    const africa = Object.values(AFRICA_LEAGUES).map(l => ({ id: AFR_PREFIX + l.id, name: l.name, country: l.country, season: '', logo: `https://media.api-sports.io/football/leagues/${l.id}.png`, flag: null }));

    const all = [...competitions, ...africa];
    res.json({ competitions: all, count: all.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération des compétitions.', detail: err.message || String(err) });
  }
});

// GET /api/standings?league_id=152 (ou afr:12) → classement d'une compétition
app.get('/api/standings', async (req, res) => {
  try {
    const { league_id, season } = req.query;
    if (!league_id) return res.status(400).json({ error: 'Paramètre league_id manquant.' });

    if (isAfr(league_id)) {
      const leagueNum = stripAfr(league_id);
      const since = afrStandingsBlocked.get(leagueNum);
      if (since && Date.now() - since < 6 * 60 * 60 * 1000) return res.json({ rows: [], count: 0, note: AFR_STANDINGS_NOTE });
      let rows = [], note;
      try {
        const yr = season || await afrSeason(leagueNum);
        const data = await cachedFetchDirect(`https://${APISPORTS_HOST}/standings?league=${leagueNum}&season=${yr}`, 10 * 60 * 1000);
        const groups = arr((arr(data.response)[0] || {}).league?.standings);
        rows = groups.flat().filter(r => r && r.team).map(r => mapAfrStanding(r, groups.length > 1));
        if (!rows.length) note = 'Aucun classement renvoyé par le fournisseur pour cette compétition.';
      } catch (err) {
        if (/do not have access|plan/i.test(err.message || '')) { afrStandingsBlocked.set(leagueNum, Date.now()); note = AFR_STANDINGS_NOTE; }
        else if (err.status === 404) note = 'Aucun classement renvoyé par le fournisseur pour cette compétition.';
        else throw err;
      }
      return res.json({ rows, count: rows.length, note });
    }

    let list = [];
    try {
      const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_standings&league_id=${encodeURIComponent(league_id)}`, 10 * 60 * 1000);
      list = asList(raw);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const rows = list.filter(x => x && x.team_name).map(mapStanding);
    const out = { rows, count: rows.length };
    if (!rows.length) { out.note = 'Aucun classement renvoyé par le fournisseur pour cette compétition.'; out.sampleKeys = list[0] ? Object.keys(list[0]).slice(0, 30) : []; }
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération du classement.', detail: err.message || String(err) });
  }
});

// GET /api/team?league_id=152&team_id=3103 (league_id peut être afr:12) → effectif d'une équipe
app.get('/api/team', async (req, res) => {
  try {
    const { league_id, team_id } = req.query;
    if (!league_id || !team_id) return res.status(400).json({ error: 'Paramètres league_id et team_id requis.' });

    if (isAfr(league_id)) {
      const team = await afrFetchSquad(team_id);
      if (!team) return res.status(404).json({ error: 'Équipe introuvable.', detail: "Aucune équipe avec cet identifiant." });
      return res.json(team);
    }

    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_teams&league_id=${encodeURIComponent(league_id)}`, 6 * 60 * 60 * 1000);
    const team = asList(raw).find(t => String(t.team_key) === String(team_id));
    if (!team) return res.status(404).json({ error: 'Équipe introuvable.', detail: "Aucune équipe avec cet identifiant dans cette compétition." });
    const players = arr(team.players).map(mapPlayer).sort((a, b) => (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9) || (a.number ?? 99) - (b.number ?? 99));
    res.json({ id: String(team.team_key), name: team.team_name, badge: team.team_badge || null, country: team.team_country || null, players });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la récupération de l'effectif.", detail: err.message || String(err) });
  }
});

// GET /api/match?id=812694&date=2026-09-20 (id peut être afr:12345) → détail d'un match
app.get('/api/match', async (req, res) => {
  try {
    const { id, date } = req.query;
    if (!id) return res.status(400).json({ error: 'Paramètre id manquant.' });

    if (isAfr(id)) {
      const detail = await afrFetchDetail(stripAfr(id));
      if (!detail) return res.status(404).json({ error: 'Match introuvable.', detail: 'Aucun match avec cet identifiant.' });
      return res.json(detail);
    }

    const day = date || new Date().toISOString().slice(0, 10);
    const params = new URLSearchParams({ action: 'get_events', from: day, to: day, match_id: id });
    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?${params.toString()}`, fixturesTtl(day, day));
    const item = asList(raw).find(x => String(x.match_id) === String(id));
    if (!item) return res.status(404).json({ error: 'Match introuvable.', detail: 'Aucun match avec cet identifiant à cette date.' });
    res.json(mapDetail(item));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la récupération du match.', detail: err.message || String(err) });
  }
});

// Contrôle : que renvoie API-SPORTS pour une compétition africaine ? (≈ 5 appels du quota gratuit du jour)
// Exemple : /api/afr-check?league_id=afr:29
app.get('/api/afr-check', async (req, res) => {
  const leagueParam = String(req.query.league_id || (AFR_PREFIX + '29'));
  const num = isAfr(leagueParam) ? stripAfr(leagueParam) : leagueParam;
  const base = `https://${APISPORTS_HOST}`;
  const out = { league: AFR_PREFIX + num, steps: [] };
  const step = async (name, fn) => {
    try { out.steps.push({ name, ok: true, ...(await fn()) }); }
    catch (e) { out.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 300) }); }
  };
  const season = await afrSeason(num);
  let fixtureId = null, teamNum = null;

  await step('Compétition et saisons', async () => {
    const item = arr((await cachedFetchDirect(`${base}/leagues?id=${encodeURIComponent(num)}`, 6 * 60 * 60 * 1000)).response)[0];
    if (!item) return { note: 'Compétition inconnue chez le fournisseur' };
    const seasons = arr(item.seasons).slice(-3).map(x => ({
      year: x.year, current: !!x.current, standings: !!x.coverage?.standings,
      events: !!x.coverage?.fixtures?.events, lineups: !!x.coverage?.fixtures?.lineups, statistics: !!x.coverage?.fixtures?.statistics_fixtures
    }));
    return { name_api: item.league?.name, type: item.league?.type, season_used: season, seasons };
  });

  await step('Classement', async () => {
    const data = await cachedFetchDirect(`${base}/standings?league=${encodeURIComponent(num)}&season=${season}`, 10 * 60 * 1000);
    const groups = arr((arr(data.response)[0] || {}).league?.standings);
    return { groups: groups.length, rows: groups.flat().length };
  });

  await step('Matchs (hier à demain)', async () => {
    const params = new URLSearchParams({ league: num, season: String(season), from: dayIso(-1), to: dayIso(1), timezone: TZ });
    let list = arr((await cachedFetchDirect(`${base}/fixtures?${params.toString()}`, 60 * 1000)).response);
    let via = 'compétition + saison';
    if (!list.length) {
      const d = await afrDay(dayIso(0));
      list = arr(d.response).filter(f => String(f.league?.id) === String(num));
      via = 'date du jour';
    }
    if (list[0]) { fixtureId = list[0].fixture.id; teamNum = list[0].teams.home.id; }
    return { via, count: list.length, first_fixture_id: fixtureId };
  });

  if (fixtureId) await step("Fiche d'un match", async () => {
    const data = await cachedFetchDirect(`${base}/fixtures?id=${fixtureId}&timezone=${encodeURIComponent(TZ)}`, 60 * 1000);
    const it = arr(data.response)[0] || {};
    return { fixture_id: fixtureId, events: arr(it.events).length, lineups: arr(it.lineups).length, statistics: arr(it.statistics).length };
  });

  if (teamNum) await step('Effectif', async () => {
    const block = arr((await cachedFetchDirect(`${base}/players/squads?team=${teamNum}`, 6 * 60 * 60 * 1000)).response)[0];
    return { team: block?.team?.name || null, players: arr(block?.players).length };
  });

  out.quota = afrQuota;
  res.json(out);
});

app.listen(PORT, () => {
  console.log(`✅ Backend démarré sur le port ${PORT}`);
});
