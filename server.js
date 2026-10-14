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
app.use(express.json({ limit: '50kb' }));

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

// Compétitions du fournisseur 2 (API-SPORTS) : Afrique, Amériques, Asie. Identifiants vérifiés avec /api/afr-find.
// Les noms restent en anglais ici : c'est l'app qui les traduit (réglage « Noms en français »).
// « country » sert seulement à ranger la compétition dans Explorer.
const EXTRA_LEAGUES = {
  // Afrique
  AFCON:   { id: '6',   name: 'Africa Cup of Nations',                 country: 'Africa' },
  CAFCL:   { id: '12',  name: 'CAF Champions League',                  country: 'Africa' },
  CAFCONF: { id: '20',  name: 'CAF Confederation Cup',                 country: 'Africa' },
  CAFSC:   { id: '533', name: 'CAF Super Cup',                         country: 'Africa' },
  CHAN:    { id: '19',  name: 'African Nations Championship',          country: 'Africa' },
  AFCONQ:  { id: '36',  name: 'Africa Cup of Nations - Qualification', country: 'Africa' },
  WCQAF:   { id: '29',  name: 'World Cup - Qualification Africa',      country: 'Africa' },
  PSL:     { id: '288', name: 'Premier Soccer League',                 country: 'South-Africa' },
  // Sélections nationales des autres continents
  COPAAM:  { id: '9',   name: 'Copa America',                          country: 'South America' },
  ASIAN:   { id: '7',   name: 'Asian Cup',                             country: 'Asia' },
  GOLD:    { id: '22',  name: 'CONCACAF Gold Cup',                     country: 'North America' },
  CNL:     { id: '536', name: 'CONCACAF Nations League',               country: 'North America' },
  WCQSA:   { id: '34',  name: 'World Cup - Qualification South America', country: 'South America' },
  WCQCC:   { id: '31',  name: 'World Cup - Qualification CONCACAF',    country: 'North America' },
  WCQAS:   { id: '30',  name: 'World Cup - Qualification Asia',        country: 'Asia' },
  CWC:     { id: '15',  name: 'FIFA Club World Cup',                   country: 'World' },
  // Clubs : compétitions continentales
  LIBERT:  { id: '13',  name: 'CONMEBOL Libertadores',                 country: 'South America' },
  SUDAM:   { id: '11',  name: 'CONMEBOL Sudamericana',                 country: 'South America' },
  CCL:     { id: '16',  name: 'CONCACAF Champions League',             country: 'North America' },
  LCUP:    { id: '772', name: 'Leagues Cup',                           country: 'North America' },
  ACLE:    { id: '17',  name: 'AFC Champions League Elite',            country: 'Asia' },
  ACL2:    { id: '18',  name: 'AFC Champions League Two',              country: 'Asia' },
  // Clubs : championnats nationaux
  MLS:     { id: '253', name: 'Major League Soccer',                   country: 'USA' },
  USOC:    { id: '257', name: 'US Open Cup',                           country: 'USA' },
  LIGAMX:  { id: '262', name: 'Liga MX',                               country: 'Mexico' },
  BRA:     { id: '71',  name: 'Brasileirão Série A',                   country: 'Brazil' },
  ARG:     { id: '128', name: 'Liga Profesional Argentina',            country: 'Argentina' },
  ARGCUP:  { id: '130', name: 'Copa Argentina',                        country: 'Argentina' },
  J1:      { id: '98',  name: 'J1 League',                             country: 'Japan' },
  SPL:     { id: '307', name: 'Saudi Pro League',                      country: 'Saudi-Arabia' }
};
const AFR_BY_ID = Object.fromEntries(Object.values(EXTRA_LEAGUES).map(l => [l.id, l]));
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


/* Heure de Paris (date « AAAA-MM-JJ » + heure « HH:MM ») -> instant absolu en millisecondes (UTC).
   L'application convertit ensuite dans le fuseau de l'appareil de la personne. */
const PARIS_FMT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function parisOffsetMs(utcMs) {
  const p = {};
  PARIS_FMT.formatToParts(new Date(utcMs)).forEach(x => { p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000;
}
function parisToUtcMs(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || ''), t = /^(\d{1,2}):(\d{2})/.exec(time || '');
  if (!m || !t) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
  let ms = wall - parisOffsetMs(wall);
  ms = wall - parisOffsetMs(ms);            // 2e passage : fiable aussi autour du changement d'heure
  return ms;
}

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
    const k = parisToUtcMs(item.match_date, item.match_time);
    if (k !== null && now.getTime() > k + 2 * 60 * 60 * 1000) return { status: 'final', minute: null };
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
    ts: parisToUtcMs(item.match_date, item.match_time),
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
    countryLogo: item.country_logo || null,
    rcH: arr(item.cards).filter(c => c.home_fault && /red/i.test(c.card || '')).length,
    rcA: arr(item.cards).filter(c => c.away_fault && /red/i.test(c.card || '')).length
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
    ts: Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : null,
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
const afrBusy = list => {
  const now = Date.now();
  return arr(list).some(f => {
    const st = f.fixture && f.fixture.status && f.fixture.status.short;
    if (st && !AFR_DONE.test(st)) return true;                                         // match en cours (mi-temps comprise)
    const t = Date.parse(f.fixture && f.fixture.date);
    return st === 'NS' && t && t > now - 10 * 60 * 1000 && t < now + 30 * 60 * 1000;   // coup d'envoi imminent
  });
};
const afrLife = busy => {
  const low = afrQuota.remaining != null && afrQuota.remaining < 30;   // il reste peu de requêtes aujourd'hui : on ralentit pour garder de quoi ouvrir des matchs
  return (busy ? (low ? 15 : 5) : (low ? 45 : 20)) * 60 * 1000;
};
function afrDayTtl(date) {
  if (!(date >= dayIso(-1) && date <= dayIso(1))) return fixturesTtl(date, date);   // jours passés : 6 h ; jours à venir : 15 min
  return out => afrLife(afrBusy(out.response));
}
const afrListTtl = out => afrLife(afrBusy(out.response));
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
// Matchs d'une compétition. Méthode 1 : « les 10 derniers » + « les 10 prochains » (2 requêtes, quelle que soit la semaine).
// Si le plan gratuit la refuse, méthode 2 : lecture jour par jour autour d'aujourd'hui (le refus est mémorisé 6 h).
let afrNextLastBlockedAt = 0;
const AFR_PLAN_ERR = /do not have access|plan|subscription|not available/i;
async function afrLeagueGames(leagueNum, from, to) {
  if (Date.now() - afrNextLastBlockedAt > 6 * 60 * 60 * 1000) {
    try {
      const get = q => cachedFetchDirect(`https://${APISPORTS_HOST}/fixtures?league=${encodeURIComponent(leagueNum)}&${q}&timezone=${encodeURIComponent(TZ)}`, afrListTtl);
      const past = await get('last=10');   // l'une après l'autre : le plan gratuit limite à 10 requêtes par minute
      const next = await get('next=10');
      const seen = new Set(), games = [];
      [...arr(past.response), ...arr(next.response)].forEach(f => { if (validFx(f) && !seen.has(f.fixture.id)) { seen.add(f.fixture.id); games.push(mapAfrFixture(f)); } });
      games.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      return { games, count: games.length, searched: null };
    } catch (e) {
      if (AFR_PLAN_ERR.test(e.message || '')) afrNextLastBlockedAt = Date.now();
      console.warn('Méthode « derniers/prochains » indisponible, lecture jour par jour :', e.message);
    }
  }
  const days = afrWindow(from, to);
  const games = [];
  let failed = 0, lastErr = null;
  for (const day of days) {
    try { arr((await afrDay(day)).response).forEach(f => { if (validFx(f) && String(f.league.id) === leagueNum) games.push(mapAfrFixture(f)); }); }
    catch (e) { failed++; lastErr = e; }
  }
  if (days.length && failed === days.length) throw lastErr;
  games.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return {
    games, count: games.length,
    searched: days.length ? { from: days[0], to: days[days.length - 1] } : null,
    note: failed ? "Certains jours n'ont pas pu être chargés (limite du fournisseur). Réessaie dans une minute." : undefined
  };
}
// Comparaison souple de noms (accents, « FC », majuscules...) pour ne pas afficher deux fois le même match ou la même compétition
const nk = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\b(fc|cf|sc|ac|cd|ca|sd|club|de|da|do|the)\b/g, '').replace(/[^a-z0-9]/g, '');
const sameKey = (a, b) => !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a))));
const sameComp = (c, l) => { const a = nk(c.name), b = nk(l.name); return a === b || (nk(c.country) === nk(l.country) && sameKey(a, b)); };
const AFR_STANDINGS_NOTE = "Le classement de cette compétition n'est pas disponible avec l'abonnement gratuit du fournisseur de données.";
/* ============================= Fournisseur 2 : ESPN (gratuit, sans clé) =============================
   Remplace API-SPORTS pour l'Afrique, les Amériques et l'Asie. Les identifiants d'app gardent le préfixe « afr: » :
   - compétition : afr:<numéro historique>  (ex. afr:12)
   - match       : afr:<slug ESPN>~<id du match>   (ex. afr:caf.champions~401906212)
   - équipe      : afr:<id ESPN de l'équipe> */
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const ESPN_STAND = 'https://site.api.espn.com/apis/v2/sports/soccer';
const ESPN_SLUGS = {
  '6': 'caf.nations', '12': 'caf.champions', '20': 'caf.confed', '19': 'caf.championship', '36': 'caf.nations_qual', '29': 'fifa.worldq.caf', '288': 'rsa.1',
  '9': 'conmebol.america', '7': 'afc.asian.cup', '22': 'concacaf.gold', '536': 'concacaf.nations.league',
  '34': 'fifa.worldq.conmebol', '31': 'fifa.worldq.concacaf', '30': 'fifa.worldq.afc', '15': 'fifa.cwc',
  '13': 'conmebol.libertadores', '11': 'conmebol.sudamericana', '16': 'concacaf.champions', '772': 'concacaf.leagues.cup',
  '17': 'afc.champions', '18': 'afc.cup', '253': 'usa.1', '257': 'usa.open', '262': 'mex.1', '71': 'bra.1',
  '128': 'arg.1', '130': 'arg.copa', '98': 'jpn.1', '307': 'ksa.1'
};
const ESPN_NUM_BY_SLUG = Object.fromEntries(Object.entries(ESPN_SLUGS).map(([n, s]) => [s, n]));

async function espnGet(url, ttl) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expiresAt > now) return hit.data;
  if (inflight.has(url)) return inflight.get(url);
  const job = (async () => {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 CoupDEnvoi', 'Accept': 'application/json' } });
      const txt = await res.text();
      if (!res.ok) { const err = new Error(`ESPN a répondu ${res.status}`); err.status = res.status; throw err; }
      const data = JSON.parse(txt);
      rememberAndTrim(url, data, typeof ttl === 'function' ? ttl(data) : ttl);
      return data;
    } catch (err) {
      if (hit) { console.warn('Copie ancienne servie pour', url, '-', err.message); return hit.data; }
      throw err;
    } finally { inflight.delete(url); }
  })();
  inflight.set(url, job);
  return job;
}

const ymd = iso => iso.replace(/-/g, '');
function addIsoDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function parisParts(ms) {
  const p = {}; PARIS_FMT.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

function espnStatus(st) {
  const name = (st && st.type && st.type.name) || '', state = (st && st.type && st.type.state) || 'pre';
  if (/POSTPONED|CANCEL|ABANDON|SUSPEND/.test(name)) return { status: 'postponed', minute: null };
  if (state === 'post') return { status: 'final', minute: null };
  if (state === 'in') {
    if (/HALFTIME/.test(name)) return { status: 'live', minute: 'HT' };
    const clock = String((st && st.displayClock) || '').replace(/'/g, '');
    return { status: 'live', minute: clock || null };
  }
  return { status: 'scheduled', minute: null };
}

function mapEspnEvent(ev, slug) {
  const comp = arr(ev.competitions)[0] || {};
  const cs = arr(comp.competitors);
  const home = cs.find(c => c.homeAway === 'home') || cs[0], away = cs.find(c => c.homeAway === 'away') || cs[1];
  if (!home || !away || !home.team || !away.team) return null;
  const { status, minute } = espnStatus(ev.status || comp.status);
  const ms = Date.parse(ev.date);
  const pp = Number.isFinite(ms) ? parisParts(ms) : { date: (ev.date || '').slice(0, 10), time: (ev.date || '').slice(11, 16) };
  const num = ESPN_NUM_BY_SLUG[slug], meta = AFR_BY_ID[num] || {};
  const sc = c => (status === 'scheduled' || status === 'postponed') ? null : numOrNull(c.score);
  return {
    id: AFR_PREFIX + slug + '~' + ev.id,
    status, minute,
    date: pp.date, time: pp.time, ts: Number.isFinite(ms) ? ms : null,
    home: home.team.displayName || home.team.name, away: away.team.displayName || away.team.name,
    homeId: AFR_PREFIX + home.team.id, awayId: AFR_PREFIX + away.team.id,
    homeLogo: home.team.logo || null, awayLogo: away.team.logo || null,
    hs: sc(home), as: sc(away),
    comp: meta.name || slug, leagueId: AFR_PREFIX + (num || ''), country: meta.country || 'Africa', countryLogo: null,
    rcH: arr(comp.details).filter(d => d.redCard && String(d.team?.id) === String(home.team.id)).length,
    rcA: arr(comp.details).filter(d => d.redCard && String(d.team?.id) === String(away.team.id)).length
  };
}

// Matchs d'une compétition entre deux dates « Paris » (on demande un jour de marge de chaque côté, puis on filtre)
async function espnLeagueGames(slug, from, to) {
  const days = [];
  for (let d = addIsoDays(from, -1); d <= addIsoDays(to, 1) && days.length < 45; d = addIsoDays(d, 1)) days.push(d);
  const seen = new Set(), out = [];
  await Promise.all(days.map(async day => {
    const near = day >= dayIso(-1) && day <= dayIso(1);
    try {
      const data = await espnGet(`${ESPN_BASE}/${slug}/scoreboard?dates=${ymd(day)}&limit=300`,
        d => near ? (arr(d.events).some(e => e.status?.type?.state === 'in') ? 60 * 1000 : 5 * 60 * 1000) : (day < dayIso(-1) ? 6 * 60 * 60 * 1000 : 15 * 60 * 1000));
      arr(data.events).forEach(e => {
        if (seen.has(e.id)) return; seen.add(e.id);
        const g = mapEspnEvent(e, slug);
        if (g && g.date >= from && g.date <= to) out.push(g);
      });
    } catch (e) { console.warn('ESPN', slug, day, e.message); }
  }));
  return out.sort((x, y) => (x.ts || 0) - (y.ts || 0));
}
// Tous les matchs d'un jour, toutes compétitions ESPN suivies
async function espnDayGames(day) {
  const slugs = Object.values(ESPN_SLUGS);
  const out = [];
  await Promise.all(slugs.map(async s => {
    try { out.push(...await espnLeagueGames(s, day, day)); } catch (e) { /* une compétition indisponible n'empêche pas les autres */ }
  }));
  return out;
}

const ESPN_POS = { G: 'Goalkeepers', D: 'Defenders', M: 'Midfielders', F: 'Forwards' };
const cleanClock = v => String(v || '').replace(/'/g, '').replace(/\s+/g, '');

async function espnDetail(key) {
  const [slug, id] = String(key).split('~');
  if (!slug || !id) return null;
  const data = await espnGet(`${ESPN_BASE}/${slug}/summary?event=${encodeURIComponent(id)}`, d => {
    const t = d && d.header && d.header.competitions && d.header.competitions[0] && d.header.competitions[0].status;
    return (t && t.type && t.type.state === 'post') ? 60 * 60 * 1000 : 60 * 1000;
  });
  const hc = arr(data.header && data.header.competitions)[0];
  if (!hc) return null;
  const g = mapEspnEvent({ id, date: hc.date, status: hc.status, competitions: [hc] }, slug);
  if (!g) return null;
  const cs = arr(hc.competitors);
  const homeC = cs.find(c => c.homeAway === 'home') || cs[0], awayC = cs.find(c => c.homeAway === 'away') || cs[1];
  const homeId = String(homeC.team?.id ?? homeC.id);
  const sideOf = e => String(e.team?.id) === homeId ? 'home' : 'away';

  const evs = arr(data.keyEvents).length ? arr(data.keyEvents) : arr(hc.details);
  const goals = [], cards = [], subs = [];
  let h = 0, a = 0;
  evs.forEach(e => {
    const text = String((e.type && (e.type.text || e.type.type)) || '').toLowerCase();
    const time = cleanClock(e.clock && e.clock.displayValue);
    const names = arr(e.athletesInvolved).map(x => x.displayName || x.fullName).concat(arr(e.participants).map(x => x.athlete && x.athlete.displayName)).filter(Boolean);
    const side = sideOf(e);
    if (e.scoringPlay || /^goal|own goal|penalty - scored/.test(text)) {
      if (/disallow|no goal|saved|missed/.test(text)) return;
      if (side === 'home') h++; else a++;
      goals.push({ time, team: side, player: names[0] || '', assist: '', score: `${h} - ${a}`, info: e.penaltyKick || /penalty/.test(text) ? 'Penalty' : (e.ownGoal || /own/.test(text) ? 'Own goal' : '') });
    } else if (e.redCard || /red card/.test(text)) {
      cards.push({ time, team: side, player: names[0] || '', card: 'red', info: 'Red Card' });
    } else if (e.yellowCard || /yellow card/.test(text)) {
      cards.push({ time, team: side, player: names[0] || '', card: 'yellow', info: 'Yellow Card' });
    } else if (/substitution/.test(text)) {
      const m = String(e.text || e.shortText || '').match(/\.\s*(.+?)\s+replaces\s+(.+?)(?:\s+because|\s*\(|\.|$)/i);
      subs.push({ time, team: side, out: m ? m[2] : (names[1] || ''), in: m ? m[1] : (names[0] || '') });
    }
  });

  const rosters = arr(data.rosters);
  const lineupSide = c => {
    const r = rosters.find(x => String(x.team?.id) === String(c.team?.id ?? c.id)) || rosters.find(x => x.homeAway === c.homeAway);
    const list = arr(r && r.roster);
    if (!list.length) return { starters: [], subs: [], coach: '' };
    const mk = (p, pos) => ({ n: p.jersey != null ? String(p.jersey) : '', name: (p.athlete && (p.athlete.displayName || p.athlete.fullName)) || '', pos });
    const starters = list.filter(p => p.starter).sort((x, y) => (x.formationPlace || 99) - (y.formationPlace || 99)).map((p, i) => mk(p, String(i + 1)));
    const bench = list.filter(p => !p.starter).map(p => mk(p, '0'));
    return { starters, subs: bench, coach: '' };
  };

  const teamsBox = arr(data.boxscore && data.boxscore.teams);
  const statsOf = c => (teamsBox.find(t => String(t.team?.id) === String(c.team?.id ?? c.id)) || {}).statistics || [];
  const hs = arr(statsOf(homeC)), as = arr(statsOf(awayC));
  const labels = [...new Set([...hs, ...as].map(x => x.label || x.name))].filter(Boolean);
  const stats = labels.map(type => ({
    type,
    home: (hs.find(x => (x.label || x.name) === type) || {}).displayValue ?? '0',
    away: (as.find(x => (x.label || x.name) === type) || {}).displayValue ?? '0'
  }));

  const gi = data.gameInfo || {};
  const ls = c => (arr(c.linescores)[0] || {}).displayValue ?? '';
  return {
    ...g,
    htHome: ls(homeC), htAway: ls(awayC),
    stadium: (gi.venue && gi.venue.fullName) || (hc.venue && hc.venue.fullName) || '',
    referee: (arr(gi.officials)[0] || {}).displayName || (arr(gi.officials)[0] || {}).fullName || '',
    round: (hc.leg && hc.leg.displayValue) || (arr(hc.notes)[0] || {}).headline || '',
    homeSystem: (rosters.find(x => x.homeAway === 'home') || {}).formation || '',
    awaySystem: (rosters.find(x => x.homeAway === 'away') || {}).formation || '',
    goals, cards, subs,
    lineups: { home: lineupSide(homeC), away: lineupSide(awayC) },
    stats
  };
}

async function espnStandings(slug) {
  const data = await espnGet(`${ESPN_STAND}/${slug}/standings`, 10 * 60 * 1000);
  const groups = arr(data.children).length ? arr(data.children) : [data];
  const multi = groups.length > 1;
  const rows = [];
  groups.forEach(gr => {
    arr(gr.standings && gr.standings.entries).forEach((en, i) => {
      const st = {}; arr(en.stats).forEach(s => { st[s.name] = s.value; });
      rows.push({
        pos: numOrNull(st.rank) ?? i + 1, teamId: AFR_PREFIX + en.team.id, team: en.team.displayName || en.team.name,
        badge: (arr(en.team.logos)[0] || {}).href || en.team.logo || null,
        played: numOrNull(st.gamesPlayed), w: numOrNull(st.wins), d: numOrNull(st.ties), l: numOrNull(st.losses),
        gf: numOrNull(st.pointsFor), ga: numOrNull(st.pointsAgainst), pts: numOrNull(st.points),
        zone: (en.note && en.note.description) || '', stage: multi ? (gr.name || '') : ''
      });
    });
  });
  return rows.sort((x, y) => String(x.stage).localeCompare(String(y.stage)) || (x.pos - y.pos));
}

async function espnSquad(slug, teamId) {
  const id = String(teamId).replace(AFR_PREFIX, '');
  const data = await espnGet(`${ESPN_BASE}/${slug}/teams/${encodeURIComponent(id)}/roster`, 6 * 60 * 60 * 1000);
  const list = arr(data.athletes).flatMap(x => Array.isArray(x.items) ? x.items : [x]);
  if (!data.team && !list.length) return null;
  const players = list.map(p => ({
    id: String(p.id), name: p.displayName || p.fullName, fullName: p.fullName || p.displayName, number: numOrNull(p.jersey), age: numOrNull(p.age),
    birthdate: null, country: p.citizenship || null, position: ESPN_POS[(p.position && p.position.abbreviation) || ''] || null,
    photo: (p.headshot && p.headshot.href) || null, captain: false, injured: false,
    stats: { apps: null, goals: null, assists: null, yellow: null, red: null, rating: null }
  })).sort((a, b) => (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9) || (a.number ?? 99) - (b.number ?? 99));
  const t = data.team || {};
  return { id: AFR_PREFIX + id, name: t.displayName || t.name || '', badge: (arr(t.logos)[0] || {}).href || t.logo || null, country: null, players };
}


// Diagnostic temporaire : structure d'une fiche ESPN (à retirer avant le lancement)
app.get('/api/espn-debug', async (req, res) => {
  try {
    const { slug, event } = req.query;
    const d = await espnGet(`${ESPN_BASE}/${slug}/summary?event=${encodeURIComponent(event)}`, 30 * 1000);
    const r = arr(d.rosters);
    res.json({
      keys: Object.keys(d),
      rosters: r.map(x => ({ homeAway: x.homeAway, keys: Object.keys(x), formation: x.formation, n: arr(x.roster).length, sample: arr(x.roster)[0] || null })),
      keyEvents: arr(d.keyEvents).length, details: arr(d.header && d.header.competitions && d.header.competitions[0] && d.header.competitions[0].details).length,
      box: arr(d.boxscore && d.boxscore.teams).map(t => arr(t.statistics).length), commentary: arr(d.commentary).length, plays: arr(d.plays).length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Compositions / événements / statistiques de secours via ESPN pour les matchs du fournisseur 1 */
const ESPN_EURO = ['uefa.champions', 'uefa.europa', 'uefa.europa.conf', 'eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'por.1', 'ned.1', 'bel.1', 'tur.1', 'sco.1', 'eng.2', 'eng.fa', 'eng.league_cup', 'esp.copa_del_rey', 'ger.dfb_pokal', 'ita.coppa_italia', 'fra.coupe_de_france', 'uefa.nations', 'uefa.euro', 'uefa.euroq', 'fifa.world', 'fifa.worldq.uefa', 'fifa.friendly'];
const espnFound = new Map();   // id du match -> { at, key }
async function espnFindKey(g) {
  const hit = espnFound.get(g.id);
  if (hit && Date.now() - hit.at < (hit.key ? 60 : 3) * 60 * 1000) return hit.key;
  const H = nk(g.home), A = nk(g.away);
  const day0 = new Date(g.ts).toISOString().slice(0, 10);
  let key = null;
  for (const day of [day0, addIsoDays(day0, -1)]) {
    await Promise.all(ESPN_EURO.map(async slug => {
      if (key) return;
      try {
        const data = await espnGet(`${ESPN_BASE}/${slug}/scoreboard?dates=${ymd(day)}&limit=300`, 5 * 60 * 1000);
        for (const e of arr(data.events)) {
          const cs = arr(arr(e.competitions)[0] && arr(e.competitions)[0].competitors);
          const h = cs.find(c => c.homeAway === 'home'), a = cs.find(c => c.homeAway === 'away');
          if (!h || !a) continue;
          const hm = sameKey(nk(h.team.displayName), H), am = sameKey(nk(a.team.displayName), A);
          const close = Math.abs(Date.parse(e.date) - g.ts) <= 15 * 60 * 1000;
          const w = x => (String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z]{4,}/) || [''])[0];
          const hw = !!w(g.home) && w(g.home) === w(h.team.displayName), aw = !!w(g.away) && w(g.away) === w(a.team.displayName);
          if ((hm && am) || (close && (hm || am || hw || aw))) { key = slug + '~' + e.id; return; }
        }
      } catch (e) { /* compétition absente ce jour-là */ }
    }));
    if (key) break;
  }
  espnFound.set(g.id, { at: Date.now(), key });
  return key;
}
async function enrichFromEspn(detail) {
  try {
    const noLu = !(detail.lineups.home.starters.length || detail.lineups.away.starters.length);
    const noStats = !(detail.stats && detail.stats.length);
    if (!(noLu || noStats) || typeof detail.ts !== 'number') return detail;
    if (detail.status === 'scheduled' && detail.ts - Date.now() > 3 * 3600 * 1000) return detail;
    const key = await espnFindKey(detail);
    if (!key) return detail;
    const x = await espnDetail(key);
    if (!x) return detail;
    if (noLu && (x.lineups.home.starters.length || x.lineups.away.starters.length)) {
      detail.lineups = x.lineups; detail.homeSystem = detail.homeSystem || x.homeSystem; detail.awaySystem = detail.awaySystem || x.awaySystem;
    }
    if (noStats && x.stats.length) detail.stats = x.stats;
    if (!detail.goals.length && x.goals.length && x.hs === detail.hs && x.as === detail.as) detail.goals = x.goals;
    if (!detail.cards.length && x.cards.length) detail.cards = x.cards;
    if (!detail.subs.length && x.subs.length) detail.subs = x.subs;
    if (!detail.referee && x.referee) detail.referee = x.referee;
    if (!detail.stadium && x.stadium) detail.stadium = x.stadium;
  } catch (e) { console.warn('ESPN secours :', e.message); }
  return detail;
}
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

// Recherche temporaire des identifiants de compétitions par pays (≈ 7 appels une seule fois, mémorisés 6 h)
// Exemple : /api/afr-find   ou   /api/afr-find?countries=World,USA,Colombia
app.get('/api/afr-find', async (req, res) => {
  try {
    if (!APISPORTS_KEY) return res.status(400).type('text/plain').send('APISPORTS_KEY manquante.');
    const countries = String(req.query.countries || 'World,USA,Mexico,Brazil,Argentina,Japan,Saudi-Arabia').split(',').map(x => x.trim()).filter(Boolean).slice(0, 10);
    const skip = /women|femin|féminin|\bu-?\d{2}\b|youth|reserve|amateur|regional|olympic|futsal|beach|friendl/i;
    const worldKeep = /libertadores|sudamericana|recopa|copa america|asian cup|afc|gold cup|concacaf|leagues cup|club world|qualif|conmebol|nations league/i;
    const lines = [];
    for (const c of countries) {
      try {
        const q = c === 'World' ? '' : '&current=true';
        const d = await cachedFetchDirect(`https://${APISPORTS_HOST}/leagues?country=${encodeURIComponent(c)}${q}`, 6 * 60 * 60 * 1000);
        let list = arr(d.response).map(x => x.league).filter(l => l && l.name && !skip.test(l.name));
        list = c === 'World' ? list.filter(l => worldKeep.test(l.name)) : list.slice(0, 14);
        lines.push(`== ${c} (${list.length}) ==`);
        list.forEach(l => lines.push(`${l.id} | ${l.name} | ${l.type}`));
      } catch (e) { lines.push(`== ${c} : erreur ${String(e.message || e).slice(0, 120)} ==`); }
    }
    lines.push('', 'Quota restant : ' + (afrQuota.remaining != null ? afrQuota.remaining + ' / ' + afrQuota.limit : 'inconnu'));
    res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    res.status(500).type('text/plain').send(err.message || String(err));
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

    const africaCode = comp && EXTRA_LEAGUES[comp.toUpperCase()];
    const resolvedLeagueId = league_id || (comp && LEAGUES[comp.toUpperCase()]?.id) || (africaCode && AFR_PREFIX + africaCode.id);

    if (resolvedLeagueId && isAfr(resolvedLeagueId)) {
      {
        const slug = ESPN_SLUGS[stripAfr(resolvedLeagueId)];
        const games = slug ? await espnLeagueGames(slug, from, to) : [];
        return res.json({ games, count: games.length });
      }
    }

    const params = new URLSearchParams({ action: 'get_events', from, to });
    if (resolvedLeagueId) params.set('league_id', resolvedLeagueId);
    if (team_id) params.set('team_id', team_id);
    let raw, p1err = null;
    try { raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?${params.toString()}`, fixturesTtl(from, to)); }
    catch (e) {
      // Liste d'un jour : si le fournisseur 1 est indisponible (quota...), on garde au moins les matchs du fournisseur 2
      if (resolvedLeagueId || team_id || from !== to) throw e;
      p1err = e; raw = [];
    }
    const now = new Date();
    let list = asList(raw);
    if (team_id) list = list.filter(x => String(x.match_hometeam_id) === String(team_id) || String(x.match_awayteam_id) === String(team_id));
    let games = list.map(item => mapGame(item, now));

    // Liste d'un seul jour, toutes compétitions : on y ajoute les matchs africains (fournisseur 2).
    // Un seul appel, filtré ici ; si ce fournisseur est indisponible, la liste principale n'est pas touchée.
    if (!resolvedLeagueId && !team_id && from === to) {
      try {
        const extra = await espnDayGames(from);
        // Déjà fournis par le premier fournisseur : pas de doublon. Même match = les deux équipes se ressemblent,
        // ou même heure de coup d'envoi avec une équipe en commun (une équipe ne joue pas deux matchs à la fois).
        const known = games.map(g => ({ h: nk(g.home), a: nk(g.away), t: g.time }));
        games = games.concat(extra.filter(g => {
          const H = nk(g.home), A = nk(g.away);
          return !known.some(k => (sameKey(k.h, H) && sameKey(k.a, A)) || (k.t === g.time && (sameKey(k.h, H) || sameKey(k.a, A))));
        }));
      } catch (e) { console.warn('Matchs africains indisponibles :', e.message); }
    }
    if (p1err && !games.length) throw p1err;
    res.json({ games, count: games.length, partial: p1err ? true : undefined });
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

    const africa = Object.values(EXTRA_LEAGUES).filter(l => !competitions.some(c => sameComp(c, l))).map(l => ({ id: AFR_PREFIX + l.id, name: l.name, country: l.country, season: '', logo: `https://media.api-sports.io/football/leagues/${l.id}.png`, flag: null }));

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
      const slug = ESPN_SLUGS[stripAfr(league_id)];
      let rows = [], note;
      if (slug) { try { rows = await espnStandings(slug); } catch (err) { if (err.status !== 404) throw err; } }
      if (!rows.length) note = 'Aucun classement renvoyé par le fournisseur pour cette compétition.';
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

/* Nationalité des joueurs du fournisseur 1 (souvent vide) : on la reprend de la fiche d'effectif ESPN du même club */
const ESPN_CLUB_SLUGS = ['eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'por.1', 'ned.1', 'bel.1', 'tur.1', 'sco.1', 'eng.2', 'uefa.champions', 'uefa.europa', 'uefa.europa.conf'];
async function espnClubIndex() {
  const lists = await Promise.all(ESPN_CLUB_SLUGS.map(async slug => {
    try {
      const d = await espnGet(`${ESPN_BASE}/${slug}/teams`, 24 * 60 * 60 * 1000);
      const teams = arr(arr(arr(d.sports)[0] && d.sports[0].leagues)[0] && d.sports[0].leagues[0].teams).map(x => x.team).filter(Boolean);
      return teams.map(t => ({ slug, id: String(t.id), name: t.displayName || t.name || '' }));
    } catch (e) { return []; }
  }));
  return lists.flat();
}
async function espnCountryMap(teamName) {
  const idx = await espnClubIndex();
  const e = idx.find(x => sameTeamName(x.name, teamName) && sameTeamName(teamName, x.name));
  if (!e) return null;
  const d = await espnGet(`${ESPN_BASE}/${e.slug}/teams/${encodeURIComponent(e.id)}/roster`, 6 * 60 * 60 * 1000);
  const list = arr(d.athletes).flatMap(x => Array.isArray(x.items) ? x.items : [x]);
  const full = new Map(), last = new Map();
  list.forEach(p => {
    const c = p.citizenship; if (!c) return;
    full.set(nk(p.fullName || p.displayName), c);
    const w = String(p.lastName || '').trim(); if (w) last.set(nk(w), last.has(nk(w)) ? null : c);
  });
  return { full, last };
}
async function fillCountries(players, teamName) {
  if (!players.some(p => !p.country)) return;
  try {
    const m = await Promise.race([espnCountryMap(teamName), new Promise(r => setTimeout(() => r(null), 5000))]);
    if (!m) return;
    players.forEach(p => {
      if (p.country) return;
      const c = m.full.get(nk(p.fullName)) || m.full.get(nk(p.name));
      if (c) { p.country = c; return; }
      const parts = String(p.fullName || p.name || '').trim().split(/\s+/);
      const l = m.last.get(nk(parts[parts.length - 1]));
      if (l) p.country = l;
    });
  } catch (e) { console.warn('Nationalités ESPN:', e.message); }
}

app.get('/api/team', async (req, res) => {
  try {
    const { league_id, team_id } = req.query;
    if (!league_id || !team_id) return res.status(400).json({ error: 'Paramètres league_id et team_id requis.' });

    if (isAfr(league_id)) {
      const sl = ESPN_SLUGS[stripAfr(league_id)];
      const team = sl ? await espnSquad(sl, team_id) : null;
      if (!team) return res.status(404).json({ error: 'Équipe introuvable.', detail: "Aucune équipe avec cet identifiant." });
      return res.json(team);
    }

    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_teams&league_id=${encodeURIComponent(league_id)}`, 6 * 60 * 60 * 1000);
    const team = asList(raw).find(t => String(t.team_key) === String(team_id));
    if (!team) return res.status(404).json({ error: 'Équipe introuvable.', detail: "Aucune équipe avec cet identifiant dans cette compétition." });
    const players = arr(team.players).map(mapPlayer).sort((a, b) => (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9) || (a.number ?? 99) - (b.number ?? 99));
    await fillCountries(players, team.team_name);
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
      const detail = await espnDetail(stripAfr(id));
      if (!detail) return res.status(404).json({ error: 'Match introuvable.', detail: 'Aucun match avec cet identifiant.' });
      return res.json(detail);
    }

    const day = date || new Date().toISOString().slice(0, 10);
    const params = new URLSearchParams({ action: 'get_events', from: day, to: day, match_id: id });
    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?${params.toString()}`, fixturesTtl(day, day));
    const item = asList(raw).find(x => String(x.match_id) === String(id));
    if (!item) return res.status(404).json({ error: 'Match introuvable.', detail: 'Aucun match avec cet identifiant à cette date.' });
    res.json(await enrichFromEspn(mapDetail(item)));
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

/* ============================= Photos de joueurs (TheSportsDB) ============================= */
// Clé gratuite de test par défaut (« 123 ») ; mets TSDB_KEY dans les variables Render si tu prends l'abonnement.
const TSDB_KEY = process.env.TSDB_KEY || '123';
const TSDB_URL = `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(TSDB_KEY)}/searchplayers.php`;
const PHOTO_TTL = 30 * 24 * 3600 * 1000;      // photo trouvée : 30 jours
const PHOTO_MISS_TTL = 6 * 3600 * 1000;       // joueur introuvable : on réessaie après 6 h (une réponse vide peut aussi venir d'une limite)
const PHOTO_MAX = 4000;
const photoCache = new Map();                  // « équipe|nom » -> { url, exp }
let tsdbBlockedUntil = 0;                      // limite de demandes atteinte : on met en pause
// La clé gratuite autorise environ 30 recherches par minute : on espace les recherches (une toutes les 2,3 s) au lieu de tout lancer d'un coup,
// car une réponse « aucun résultat » peut en réalité venir de la limite.
const TSDB_GAP_MS = Number(process.env.TSDB_GAP_MS) || 2300;
let tsdbNextSlot = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const TEAM_STOP = new Set(['fc', 'afc', 'cf', 'sc', 'ac', 'as', 'city', 'united', 'town', 'club', 'real', 'sporting', 'athletic', 'de', 'la', 'le', 'the', 'of']);
const teamTokens = s => fold(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !TEAM_STOP.has(w));
// Abréviations courantes : le fournisseur de matchs écrit « PSG », TheSportsDB « Paris SG »
const TEAM_ALIAS = [['psg', 'paris'], ['om', 'marseille'], ['ol', 'lyon'], ['barca', 'barcelona'], ['atletico', 'atletico'], ['inter', 'inter'], ['bayern', 'bayern'], ['spurs', 'tottenham'], ['wolves', 'wolverhampton'], ['man city', 'manchester'], ['man utd', 'manchester'], ['man united', 'manchester'], ['newcastle', 'newcastle'], ['real', 'real'], ['leverkusen', 'leverkusen'], ['dortmund', 'dortmund'], ['monchengladbach', 'monchengladbach']];
function sameTeamName(a, b) {
  const fa = fold(a).trim(), fb = fold(b).trim();
  for (const [x, y] of TEAM_ALIAS) {
    if ((fa === x || fa.startsWith(x + ' ')) && fb.includes(y)) return true;
    if ((fb === x || fb.startsWith(x + ' ')) && fa.includes(y)) return true;
  }
  const A = teamTokens(a), B = teamTokens(b);
  if (!A.length || !B.length) return fold(a).trim() === fold(b).trim();
  return A.some(x => B.some(y => x === y || (x.length >= 3 && y.startsWith(x)) || (y.length >= 3 && x.startsWith(y))));
}
// « J. Rudoni » -> { initial: 'j', surname: 'Rudoni' } ; « Jack Rudoni » -> { initial: 'j', first: 'jack', surname: 'Rudoni' }
function splitName(full) {
  const w = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return null;
  if (w.length === 1) return { initial: '', first: '', surname: w[0] };
  const first = w[0].replace(/\.$/, '');
  return { initial: fold(first).charAt(0), first: first.length > 1 ? fold(first) : '', surname: w.slice(1).join(' ') };
}

async function tsdbSearch(term) {
  if (Date.now() < tsdbBlockedUntil) { const e = new Error('pause'); e.paused = true; throw e; }
  const now0 = Date.now();
  const wait = Math.max(0, tsdbNextSlot - now0);
  if (wait > 45000) { const e = new Error('file trop longue'); e.paused = true; throw e; }
  tsdbNextSlot = now0 + wait + TSDB_GAP_MS;     // on réserve notre créneau tout de suite
  if (wait) await sleep(wait);
  if (Date.now() < tsdbBlockedUntil) { const e = new Error('pause'); e.paused = true; throw e; }
  const res = await fetch(`${TSDB_URL}?p=${encodeURIComponent(term.replace(/\s+/g, '_'))}`);
  if (res.status === 429) { tsdbBlockedUntil = Date.now() + 65 * 1000; const e = new Error('limite'); e.paused = true; throw e; }
  if (!res.ok) throw new Error('TheSportsDB ' + res.status);
  const j = await res.json().catch(() => null);
  // Une vraie réponse « aucun résultat » contient bien la clé "player" (valeur null). Sinon : limite atteinte, on met en pause.
  if (!j || typeof j !== 'object' || !('player' in j)) { tsdbBlockedUntil = Date.now() + 65 * 1000; const e = new Error('limite'); e.paused = true; throw e; }
  return arr(j.player);
}

// Le site ne renvoie que le meilleur résultat : avec un nom complet (« Joe Willock ») on tombe sur le bon joueur,
// avec un nom de famille seul (« Willock ») on peut tomber sur un homonyme d'une autre équipe (qu'on écarte ensuite).
async function findPhoto(team, name, fullName) {
  const nm = splitName(fullName && fullName !== name ? fullName : name);
  if (!nm) return null;
  const sur = fold(nm.surname);
  const terms = [];
  const hasFull = !!(fullName && fullName !== name);
  if (hasFull) terms.push(String(fullName).trim());
  if (!hasFull) terms.push(nm.surname);
  const folded = nm.surname.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!hasFull && folded !== nm.surname) terms.push(folded);
  if (fullName && fullName !== name) { const f = String(fullName).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); if (f !== String(fullName).trim()) terms.splice(1, 0, f); }
  const lastWord = nm.surname.split(/\s+/).pop();
  if (!hasFull && lastWord !== nm.surname) terms.push(lastWord);
  for (const term of terms) {
    const list = await tsdbSearch(term);
    const wantFull = hasFull ? fold(fullName).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const isSoccer = p => /soccer|football/i.test(p.strSport || '');
    // Même nom complet (deux mots ou plus) : on accepte même si l'écriture du club diffère (« PSG » / « Paris SG »)
    const sameFull = p => wantFull.includes(' ') && fold(p.strPlayer).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() === wantFull;
    // plusieurs joueurs du même nom (ex. deux « Luis Suárez ») : on n'accepte que celui du bon club, jamais un homonyme
    const dupFull = list.filter(p => isSoccer(p) && sameFull(p)).length > 1;
    const ok = list.filter(p => isSoccer(p) && (sameTeamName(p.strTeam, team) || sameTeamName(p.strTeam2, team) || (!dupFull && sameFull(p))));
    if (!ok.length) continue;
    const score = p => {
      const f = fold(p.strPlayer);
      let n = 0;
      if (f.endsWith(sur) || f.includes(sur)) n += 2;
      if (nm.first && f.startsWith(nm.first)) n += 3;
      else if (nm.initial && f.charAt(0) === nm.initial) n += 1;
      if (p.strCutout) n += 1;
      return n;
    };
    ok.sort((a, b) => score(b) - score(a));
    const best = ok[0];
    const url = best.strCutout || best.strThumb || null;
    if (url) return url;
  }
  return null;
}


/* ============================= Histoire des clubs et carrière des joueurs (TheSportsDB) ============================= */
const HIST_TTL = 14 * 24 * 3600 * 1000, HIST_MISS_TTL = 3 * 3600 * 1000;
const histCache = new Map();   // clé -> { v, exp }
const histGet = k => { const h = histCache.get(k); return h && h.exp > Date.now() ? h : null; };
const histSet = (k, v, ttl) => { histCache.set(k, { v, exp: Date.now() + ttl }); if (histCache.size > 3000) histCache.delete(histCache.keys().next().value); };
// même limiteur que les photos (la clé gratuite limite le nombre de demandes par minute)
let histNextSlot = 0, histBlockedUntil = 0;
async function tsdbJson(endpoint, query) {
  // file d'attente propre à l'histoire (les photos de joueurs ont la leur et peuvent être longues)
  if (Date.now() < histBlockedUntil) { const e = new Error('pause'); e.paused = true; throw e; }
  const now0 = Date.now(), wait = Math.max(0, histNextSlot - now0);
  if (wait > 40000) { const e = new Error('file trop longue'); e.paused = true; throw e; }
  histNextSlot = now0 + wait + 1200;
  if (wait) await sleep(wait);
  const res = await fetch(`https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(TSDB_KEY)}/${endpoint}?${query}`);
  if (res.status === 429) { histBlockedUntil = Date.now() + 30 * 1000; const e = new Error('limite'); e.paused = true; throw e; }
  if (!res.ok) throw new Error('TheSportsDB ' + res.status);
  return res.json().catch(() => null);
}
const LANG_FIELD = { fr: 'FR', en: 'EN', es: 'ES', pt: 'PT', de: 'DE', it: 'IT' };
function pickText(o, lang, prefix) {
  const order = [LANG_FIELD[lang], 'EN', 'FR', 'ES', 'PT', 'DE', 'IT'].filter(Boolean);
  for (const l of order) { const t = o[prefix + l]; if (t && String(t).trim().length > 40) return String(t).trim(); }
  return '';
}
function shortText(t, max) {
  t = String(t || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max), i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return (i > max * 0.5 ? cut.slice(0, i + 1) : cut.replace(/\s+\S*$/, '') + '…');
}


// ---- Wikipédia : texte d'histoire des clubs et biographies des joueurs (dans la langue de l'app) ----
// Pas de clé, pas de quota serré : sert de source principale pour le texte, et de secours quand TheSportsDB est saturé.
const WIKI_LANGS = ['fr', 'en', 'es', 'pt', 'ar', 'de', 'it', 'tr'];
const FOOT_RE = /football|soccer|fútbol|futebol|calcio|fußball|fussball|futbol|كرة القدم|كرة قدم/i;
async function wikiSearch(lang, query, limit) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=${limit || 4}` +
    `&prop=extracts|description&exintro=1&explaintext=1&exchars=2600&redirects=1&format=json&formatversion=2`;
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'CoupDEnvoi/1.0 (contact: tsekou473@gmail.com)', 'Accept': 'application/json' }, signal: ctl.signal });
    if (!r.ok) return [];
    const j = await r.json();
    return arr(j && j.query && j.query.pages).sort((a, b) => (a.index || 0) - (b.index || 0));
  } catch (e) { return []; } finally { clearTimeout(to); }
}
// terms : écritures possibles du nom ; ok(page) : la page est-elle bien la bonne ?
async function wikiText(lang, terms, suffixes, ok) {
  const langs = [...new Set([WIKI_LANGS.includes(lang) ? lang : 'en', 'en'])];
  for (const l of langs) {
    for (const term of terms) {
      for (const suf of suffixes) {
        const pages = await wikiSearch(l, `${term} ${suf}`.trim(), 4);
        const p = pages.find(x => x.extract && x.extract.length > 80 && ok(x));
        if (p) return { text: shortText(p.extract, 1800), title: p.title, desc: p.description || '', lang: l };
      }
    }
  }
  return null;
}


const WIKI_BAD = new Set(['campus','stade','stadium','academy','academie','women','feminin','femeni','femenino','femminile','feminino','frauen','kadin','feminine','ultras','supporters','derby','histoire','history','saison','season','centre','center','formation','youth','reserves','reserve','ii','iii','u19','u21','u23','b','ladies','basketball','handball','rugby','volleyball','hockey','futsal','esports']);
const WIKI_STOP = new Set(['football','club','fc','cf','afc','sc','ac','as','de','du','la','le','the','of','and','et','y','e','sporting']);
function wikiToks(x, drop) { return fold(String(x || '').replace(/\(.*?\)/g, ' ')).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !(drop && drop.has(w))); }
// la page est-elle bien celle du club « term » ? (et pas son centre de formation, son stade, sa section féminine…)
function wikiTitleIsClub(title, terms) {
  const A = wikiToks(title, WIKI_STOP);
  if (!A.length || A.some(w => WIKI_BAD.has(w))) return false;
  return terms.some(t => {
    const B = wikiToks(t, WIKI_STOP); if (!B.length) return false;
    if (!B.every(w => A.includes(w))) return false;
    return A.filter(w => !B.includes(w)).length <= 2;
  });
}

// GET /api/club?name=Arsenal&lang=fr
app.get('/api/club', async (req, res) => {
  try {
    const name = String(req.query.name || '').slice(0, 80).trim();
    const lang = String(req.query.lang || 'fr').slice(0, 2);
    if (!name) return res.json({ club: null });
    const key = 'club|' + fold(name) + '|' + lang;
    const hit = req.query.debug ? null : histGet(key);
    if (hit) return res.json({ club: hit.v });
    // noms écrits à la façon du fournisseur de matchs (« PSG », « Man Utd »…) : on essaie plusieurs écritures
    const ALIAS = { psg: ['Paris Saint Germain', 'Paris SG', 'Paris'], 'paris sg': ['Paris Saint-Germain'], om: ['Marseille'], ol: ['Lyon'], inter: ['Inter Milan', 'Internazionale', 'Inter'], 'atl madrid': ['Atletico Madrid'], 'atletico madrid': ['Atletico Madrid'], barca: ['Barcelona'], spurs: ['Tottenham Hotspur'], wolves: ['Wolverhampton Wanderers'], leipzig: ['RB Leipzig'], dortmund: ['Borussia Dortmund'], leverkusen: ['Bayer Leverkusen'], gladbach: ['Borussia Monchengladbach'], betis: ['Real Betis'], sociedad: ['Real Sociedad'], 'club brugge kv': ['Club Brugge'], 'bayern munich': ['Bayern Munich', 'Bayern Munchen'], 'sporting cp': ['Sporting CP'] };
    const base = name.replace(/\bUtd\b/gi, 'United').replace(/\bAtl\.?\b/gi, 'Atletico').replace(/\bSt\.?\s/gi, 'Saint ').replace(/^Man\s+/i, 'Manchester ').replace(/\s+(FC|AFC|CF|SC|KV|SK|FK|BK|AS|AC)$/i, '').replace(/^(FC|AFC|CF|SC|AS|AC|SK|FK)\s+/i, '').trim();
    const terms = [...new Set([name, ...(ALIAS[fold(name).replace(/[^a-z ]/g, '').trim()] || []), ...(ALIAS[fold(base).replace(/[^a-z ]/g, '').trim()] || []), base].filter(Boolean))].slice(0, 5);
    let t = null, tsdbDown = false;
    for (const term of terms) {
      let j = null;
      try { j = await tsdbJson('searchteams.php', 't=' + encodeURIComponent(term.replace(/\s+/g, '_'))); } catch (e) { if (!e.paused) throw e; }
      if (!j || !('teams' in j)) { tsdbDown = true; break; }
      const nz = v => fold(v).replace(/[^a-z0-9]/g, '').replace(/^(fc|cf|afc|sc|ac|as)/, '').replace(/(fc|cf|afc|sc)$/, '');
      const wanted = new Set(terms.map(nz).concat([nz(name), nz(base)]));
      const names = x => [x.strTeam, x.strTeamShort, ...String(x.strTeamAlternate || '').split(',')].map(nz).filter(Boolean);
      const cands = arr(j.teams).filter(x => /soccer|football/i.test(x.strSport || ''));
      t = cands.find(x => names(x).some(n => wanted.has(n)));
      if (req.query.debug) (req._dbg = req._dbg || []).push({ term, got: cands.map(x => x.strTeam + ' | ' + (x.strTeamAlternate || '') + ' | ' + (x.strTeamShort || '')).slice(0, 8), raw: j.teams ? j.teams.length : 0 });
      if (t) break;
    }
    let club = null;
    if (t) club = {
      name: t.strTeam, formed: t.intFormedYear || null, stadium: t.strStadium || '', location: t.strLocation || '', country: t.strCountry || '',
      league: t.strLeague || '', colours: [t.strColour1, t.strColour2].filter(Boolean), website: t.strWebsite || '',
      keywords: t.strKeywords || '', badge: t.strBadge || null, fanart: t.strFanart1 || null,
      text: shortText(pickText(t, lang, 'strDescription'), 1800)
    };
    // texte d'histoire : Wikipédia (dans la langue de l'app), sinon celui de TheSportsDB
    const wterms = [...new Set([t ? t.strTeam : null, name, ...terms, base].filter(Boolean))];
    const wk = await wikiText(lang, wterms.slice(0, 3), ['football club', 'club de football'],
      pg => FOOT_RE.test((pg.extract || '').slice(0, 600) + ' ' + (pg.description || '')) && wikiTitleIsClub(pg.title, wterms));
    if (wk) { club = club || { name: wk.title, formed: null, stadium: '', location: '', country: '', league: '' }; club.text = wk.text; club.source = 'wikipedia'; }
    if (tsdbDown && !club) { const e = new Error('limite'); e.paused = true; histBlockedUntil = Date.now() + 20 * 1000; throw e; }
    if (!req.query.debug) histSet(key, club, club ? HIST_TTL : HIST_MISS_TTL);
    res.json(req.query.debug ? { club, terms, dbg: req._dbg } : { club });
  } catch (err) {
    if (err.paused) return res.json({ club: null, paused: true, why: err.message });
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/player-history?name=Senne%20Lammens&full=&team=Manchester%20United&lang=fr
app.get('/api/player-history', async (req, res) => {
  try {
    const name = String(req.query.name || '').slice(0, 80).trim(), full = String(req.query.full || '').slice(0, 80).trim();
    const team = String(req.query.team || '').slice(0, 80).trim(), lang = String(req.query.lang || 'fr').slice(0, 2);
    if (!name) return res.json({ player: null });
    const key = 'pl|' + fold(team) + '|' + fold(full || name) + '|' + lang;
    const hit = histGet(key);
    if (hit) return res.json({ player: hit.v });
    const nm = splitName(full || name);
    const hasFull = !!(full && full !== name);
    const wantFull = fold(full || name).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const terms = [full || name];
    if (nm && !hasFull && nm.surname !== name) terms.push(nm.surname);
    let found = null, tsdbMiss = false;
    for (const term of terms) {
      let j = null;
      try { j = await tsdbJson('searchplayers.php', 'p=' + encodeURIComponent(term.replace(/\s+/g, '_'))); } catch (e) { if (!e.paused) throw e; }
      if (!j || !('player' in j)) { tsdbMiss = true; break; }
      const list = arr(j.player).filter(p => /soccer|football/i.test(p.strSport || ''));
      const sameFull = p => wantFull.includes(' ') && fold(p.strPlayer).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() === wantFull;
      const dup = list.filter(sameFull).length > 1;
      const ok = list.filter(p => sameTeamName(p.strTeam, team) || sameTeamName(p.strTeam2, team) || (!dup && hasFull && sameFull(p)));
      if (ok.length) { found = ok[0]; break; }
    }
    let player = null;
    if (found) {
      let career = [];
      try {
        const f = await tsdbJson('lookupformerteams.php', 'id=' + encodeURIComponent(found.idPlayer));
        career = arr(f && f.formerteams).map(x => ({ team: x.strFormerTeam, type: x.strMoveType || '', from: x.strJoined || '', to: x.strDeparted || '' }))
          .filter(x => x.team);
      } catch (e) { /* carrière indisponible : on garde le reste */ }
      player = {
        name: found.strPlayer, born: found.dateBorn || '', birthplace: found.strBirthLocation || '', nationality: found.strNationality || '',
        height: found.strHeight || '', position: found.strPosition || '', number: found.strNumber || '', signed: found.dateSigned || '',
        team: found.strTeam || '', career,
        text: shortText(pickText(found, lang, 'strDescription'), 1500)
      };
    }
    // biographie : Wikipédia (langue de l'app) ; sert aussi quand TheSportsDB ne connaît pas le joueur
    const pname = full || name;
    const pw = fold(pname).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const wk = pw.length ? await wikiText(lang, [pname, ...(full && full !== name ? [name] : [])].slice(0, 2), ['footballer', 'joueur de football'],
      pg => FOOT_RE.test((pg.extract || '').slice(0, 500) + ' ' + (pg.description || '')) && pw.filter(w => fold(pg.title).includes(w)).length >= Math.min(2, pw.length) && !/\b(season|saison|temporada|stagione|sezon)\b/i.test(pg.title)) : null;
    if (wk) { player = player || { name: pname, born: '', birthplace: '', nationality: '', height: '', position: '', number: '', signed: '', team, career: [] }; if (wk.text) player.text = wk.text; player.source = 'wikipedia'; }
    if (!player && tsdbMiss) { const e = new Error('limite'); e.paused = true; throw e; }
    histSet(key, player, player ? HIST_TTL : HIST_MISS_TTL);
    res.json({ player });
  } catch (err) {
    if (err.paused) return res.json({ player: null, paused: true });
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/photos?team=Coventry&names=J. Rudoni|E. Mason-Clark   -> { photos: { "J. Rudoni": "https://…" }, pending: 3 }
// Les photos déjà connues sont renvoyées tout de suite ; les autres sont cherchées (max 10 par appel) et « pending » dit combien restent.
app.get('/api/photos', async (req, res) => {
  try {
    const team = String(req.query.team || '').slice(0, 80);
    const pairs = [], seenN = new Set();
    String(req.query.names || '').split('|').forEach(x => {
      const [short, full] = x.split('~').map(t => (t || '').trim());
      if (short && !seenN.has(short)) { seenN.add(short); pairs.push([short, full || '']); }
    });
    const names = pairs.map(p => p[0]).slice(0, 40);
    const fullOf = Object.fromEntries(pairs);
    if (!team || !names.length) return res.json({ photos: {}, pending: 0 });
    const now = Date.now();
    const photos = {};
    const todo = [];
    for (const n of names) {
      const key = fold(team) + '|' + fold(n) + (fullOf[n] ? '|' + fold(fullOf[n]) : '');
      const hit = photoCache.get(key);
      if (hit && hit.exp > now) { if (hit.url) photos[n] = hit.url; }
      else todo.push([n, key]);
    }
    const batch = todo.slice(0, 6);
    const doneKeys = new Set();
    let paused = false;
    for (let i = 0; i < batch.length && !paused; i += 6) {
      await Promise.all(batch.slice(i, i + 6).map(async ([n, key]) => {
        try {
          const url = await findPhoto(team, n, fullOf[n]);
          photoCache.set(key, { url, exp: Date.now() + (url ? PHOTO_TTL : PHOTO_MISS_TTL) });
          doneKeys.add(key);
          if (photoCache.size > PHOTO_MAX) photoCache.delete(photoCache.keys().next().value);
          if (url) photos[n] = url;
        } catch (e) { if (e.paused) paused = true; else console.warn('Photo', n, '-', e.message); }
      }));
    }
    const left = todo.length - batch.length + batch.filter(([, key]) => !doneKeys.has(key)).length;
    res.json({ photos, pending: left, paused: paused || Date.now() < tsdbBlockedUntil });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});


/* ---------- ACTUS (flux RSS) ---------- */
const NEWS_SOURCES = [
  { name: 'Foot Mercato', url: 'https://www.footmercato.net/flux-rss' }
];
const NEWS_TTL = 10 * 60 * 1000;
let newsCache = { ts: 0, items: [] };
const decodeEnt = s => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, '').trim();
function parseRss(xml, source){
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)){
    const b = m[1];
    const tag = t => { const r = b.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')); return r ? decodeEnt(r[1]) : ''; };
    const img = (b.match(/<enclosure[^>]+url="([^"]+)"/) || b.match(/<media:content[^>]+url="([^"]+)"/) || [])[1] || '';
    const link = tag('link');
    const ts = Date.parse(tag('pubDate')) || 0;
    if (!tag('title') || !/^https?:\/\//.test(link)) continue;
    out.push({ title: tag('title'), link, image: /^https?:\/\//.test(img) ? img : '', ts, source });
  }
  return out;
}
async function loadNews(){
  if (Date.now() - newsCache.ts < NEWS_TTL && newsCache.items.length) return newsCache.items;
  let items = [];
  for (const s of NEWS_SOURCES){
    try {
      const r = await fetch(s.url, { headers: { 'User-Agent': 'Mozilla/5.0 CoupDEnvoi' } });
      if (r.ok) items = items.concat(parseRss(await r.text(), s.name));
    } catch (e) { console.log('news', s.name, e.message); }
  }
  items.sort((a, b) => b.ts - a.ts);
  if (items.length){ newsCache = { ts: Date.now(), items }; return items; }
  return newsCache.items; // en cas d'échec : dernière copie
}
const TRANSFER_RE = /transfert|mercato|recrue|recrut|signe|signature|prêt|prete|libre|offre|rumeur|piste|contrat|prolong|accord|officiel|quitte|départ|arriv|clause|indemnit/i;
// GET /api/news?type=infos|transferts
app.get('/api/news', async (req, res) => {
  try {
    let items = await loadNews();
    if (req.query.type === 'transferts') items = items.filter(i => TRANSFER_RE.test(i.title));
    res.json({ items: items.slice(0, 40) });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});


/* ---------- RECHERCHE (clubs + joueurs) ---------- */
// Index construit en arrière-plan : une requête « équipes » par championnat important, espacées, gardées en mémoire.
const IDX = { teams: [], players: [], leagues: 0, done: 0, building: false, builtAt: 0, blockedUntil: 0 };
const IDX_COUNTRIES = /^(England|Spain|Italy|Germany|France|Portugal|Netherlands|Belgium|Turkey|Scotland|Brazil|Argentina|USA|Saudi|Eurocups|Europe|World)/i;
const IDX_SKIP = /women|femin|u19|u21|u23|u20|youth|reserve|ii\b|cup|coupe|copa|pokal|supercup|super cup|trophy|play-?off|qualif|friendl|league two|national league/i;
const IDX_MAX_LEAGUES = 45;
const IDX_ALIAS = { 'psg': 'paris saint germain paris sg', 'man city': 'manchester city', 'man utd': 'manchester united', 'manchester utd': 'manchester united', 'atletico madrid': 'atletico de madrid', 'inter': 'internazionale inter milan', 'ac milan': 'milan' };
const IDX_GAP_MS = 3000;
const nrm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
async function buildIndex(){
  if (IDX.building) return;
  IDX.building = true;
  try {
    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_leagues`, 6 * 60 * 60 * 1000);
    const all = asList(raw).filter(x => x && x.league_id);
    const mains = new Set(Object.values(LEAGUES).map(l => l.id));
    const picked = [];
    const seen = new Set();
    for (const x of all){
      const id = String(x.league_id);
      if (seen.has(id)) continue;
      const ok = mains.has(id) || (IDX_COUNTRIES.test(x.country_name || '') && !IDX_SKIP.test(x.league_name || ''));
      if (ok){ seen.add(id); picked.push({ id, name: x.league_name, country: x.country_name }); }
    }
    // championnats principaux d'abord
    picked.sort((a, b) => (mains.has(b.id) ? 1 : 0) - (mains.has(a.id) ? 1 : 0));
    const list = picked.slice(0, IDX_MAX_LEAGUES);
    IDX.leagues = list.length; IDX.done = 0;
    const teams = [], players = [], seenTeam = new Set();
    for (const lg of list){
      try {
        const t = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_teams&league_id=${encodeURIComponent(lg.id)}`, 6 * 60 * 60 * 1000);
        for (const team of asList(t)){
          if (!team || !team.team_key) continue;
          const key = String(team.team_key);   // un club joue plusieurs compétitions : on le garde une fois (championnat principal d'abord)
          if (seenTeam.has(key)) continue;
          seenTeam.add(key);
          const tm = { id: String(team.team_key), leagueId: lg.id, leagueName: lg.name, name: team.team_name, badge: team.team_badge || null, country: team.team_country || lg.country || null };
          tm.n = nrm(tm.name + ' ' + (tm.country || '') + ' ' + (IDX_ALIAS[nrm(tm.name)] || ''));
          teams.push(tm);
          for (const p of arr(team.players)){
            const mp = mapPlayer(p);
            if (!mp.name) continue;
            players.push({ n: nrm(mp.fullName + ' ' + mp.name), team: tm, player: mp });
          }
        }
        IDX.teams = teams; IDX.players = players;   // résultats disponibles au fur et à mesure
      } catch (e) {
        console.log('index', lg.name, e.message);
        if (e.status === 429) { IDX.blockedUntil = Date.now() + 65 * 60 * 1000; break; }   // limite horaire atteinte : on arrête, on réessaiera plus tard
      }
      IDX.done++;
      await new Promise(r => setTimeout(r, IDX_GAP_MS));
    }
    if (!IDX.blockedUntil || Date.now() > IDX.blockedUntil) IDX.builtAt = Date.now();
  } catch (e) { console.log('index erreur', e.message); }
  IDX.building = false;
}
// L'index ne se construit plus au démarrage : seulement à la première recherche (économise le quota horaire du fournisseur).
// GET /api/search?q=mbappe -> { teams:[…], players:[…], indexed, total, building }
app.get('/api/search', (req, res) => {
  const q = nrm(req.query.q);
  if (q.length < 2) return res.json({ teams: [], players: [], indexed: IDX.done, total: IDX.leagues, building: IDX.building });
  if (!IDX.building && (!IDX.builtAt || Date.now() - IDX.builtAt > 24 * 3600 * 1000) && !(IDX.blockedUntil && Date.now() < IDX.blockedUntil)) buildIndex();
  const words = q.split(/\s+/);
  const match = n => words.every(w => n.includes(w));
  const startsFirst = (a, b) => (b.n.startsWith(q) ? 1 : 0) - (a.n.startsWith(q) ? 1 : 0);
  const teams = IDX.teams.filter(t => match(t.n)).sort(startsFirst).slice(0, 12)
    .map(t => ({ id: t.id, leagueId: t.leagueId, leagueName: t.leagueName, name: t.name, badge: t.badge, country: t.country }));
  const players = IDX.players.filter(p => match(p.n)).sort(startsFirst).slice(0, 20)
    .map(p => ({ player: p.player, team: { id: p.team.id, leagueId: p.team.leagueId, name: p.team.name, badge: p.team.badge } }));
  res.json({ teams, players, indexed: IDX.done, total: IDX.leagues, building: IDX.building });
});


/* ---------- CONFRONTATIONS DIRECTES ---------- */
// Le fournisseur 1 donne un historique court ; si on trouve peu de matchs, on complète avec API-SPORTS (historique long).
const H2H_ALIAS = { 'psg': 'Paris Saint Germain', 'man city': 'Manchester City', 'man utd': 'Manchester United', 'manchester utd': 'Manchester United', 'atl. madrid': 'Atletico Madrid', 'inter': 'Inter', 'bayern munich': 'Bayern Munich', 'borussia dortmund': 'Borussia Dortmund' };
const sportsIdCache = new Map();
async function sportsTeamId(name) {
  const key = nrm(name);
  if (sportsIdCache.has(key)) return sportsIdCache.get(key);
  const q = (H2H_ALIAS[key] || name).replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
  const data = await cachedFetchDirect(`https://${APISPORTS_HOST}/teams?search=${encodeURIComponent(q)}`, 30 * 24 * 3600 * 1000);
  const list = arr(data.response).map(x => x.team).filter(Boolean);
  const exact = list.find(t => nrm(t.name) === nrm(q)) || list.find(t => !t.national && nrm(t.name).startsWith(nrm(q))) || list[0];
  const id = exact ? String(exact.id) : null;
  if (id) sportsIdCache.set(key, id);
  return id;
}
function summarizeH2H(games, aId) {
  games.sort((x, y) => String(y.date).localeCompare(String(x.date)));
  const s = { aWins: 0, draws: 0, bWins: 0, aGoals: 0, bGoals: 0, total: games.length };
  for (const g of games) {
    const aHome = String(g.homeId) === String(aId);
    const ag = aHome ? g.hs : g.as, bg = aHome ? g.as : g.hs;
    s.aGoals += ag; s.bGoals += bg;
    if (ag > bg) s.aWins++; else if (ag < bg) s.bWins++; else s.draws++;
  }
  return { summary: s, matches: games.slice(0, 10) };
}
async function sportsH2H(aName, bName) {
  const [ia, ib] = await Promise.all([sportsTeamId(aName), sportsTeamId(bName)]);
  if (!ia || !ib) return null;
  const data = await cachedFetchDirect(`https://${APISPORTS_HOST}/fixtures/headtohead?h2h=${ia}-${ib}`, 7 * 24 * 3600 * 1000);
  const games = arr(data.response).filter(f => f && f.fixture && f.goals && f.goals.home != null && f.goals.away != null && /^(FT|AET|PEN)$/.test((f.fixture.status || {}).short || 'FT')).map(f => ({
    date: String(f.fixture.date || '').slice(0, 10), homeId: String(f.teams.home.id), awayId: String(f.teams.away.id),
    home: f.teams.home.name, away: f.teams.away.name, hs: f.goals.home, as: f.goals.away, league: f.league && f.league.name || ''
  }));
  return summarizeH2H(games, ia);
}
// GET /api/h2h?a=<id>&b=<id>&an=<nom>&bn=<nom>  (ids afr:… pour le fournisseur 2)
app.get('/api/h2h', async (req, res) => {
  try {
    const { a, b, an, bn } = req.query;
    if (!a || !b) return res.status(400).json({ error: 'Paramètres a et b requis.' });
    const toNum = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
    let out = { summary: null, matches: [] }, source = ''; const dbg = [];
    if (isAfr(a) || isAfr(b)) {
      out = { summary: null, matches: [] }; source = 'none';   // pas de face-à-face pour les compétitions africaines / américaines / asiatiques
    } else if (!isAfr(a) && !isAfr(b)) {
      try {
        const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_H2H&firstTeamId=${encodeURIComponent(a)}&secondTeamId=${encodeURIComponent(b)}`, 24 * 3600 * 1000);
        const list = arr(raw.firstTeam_VS_secondTeam || (raw.result && raw.result.firstTeam_VS_secondTeam));
        const games = list.map(x => ({
          id: x.match_id ? String(x.match_id) : '', time: x.match_time || '', leagueId: x.league_id ? String(x.league_id) : '', date: x.match_date, homeId: String(x.match_hometeam_id || ''), awayId: String(x.match_awayteam_id || ''),
          home: x.match_hometeam_name, away: x.match_awayteam_name, hs: toNum(x.match_hometeam_score), as: toNum(x.match_awayteam_score), league: x.league_name || ''
        })).filter(g => g.hs != null && g.as != null);
        out = summarizeH2H(games, a); source = 'p1';
      } catch (e) { console.log('h2h p1', e.message); dbg.push('p1: ' + e.message); }
      // historique plus ancien : tous les matchs de l'équipe A depuis 2005 chez le fournisseur 1, filtrés sur l'équipe B
      {
        try {
          const today = new Date().toISOString().slice(0, 10);
          const rawA = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_events&from=2005-01-01&to=${today}&team_id=${encodeURIComponent(a)}`, 7 * 24 * 3600 * 1000);
          const listA = asList(rawA).filter(x => [String(x.match_hometeam_id), String(x.match_awayteam_id)].includes(String(b)));
          const g2 = listA.map(x => ({ id: x.match_id ? String(x.match_id) : '', time: x.match_time || '', leagueId: x.league_id ? String(x.league_id) : '', date: x.match_date, homeId: String(x.match_hometeam_id || ''), awayId: String(x.match_awayteam_id || ''),
            home: x.match_hometeam_name, away: x.match_awayteam_name, hs: toNum(x.match_hometeam_score), as: toNum(x.match_awayteam_score), league: x.league_name || '' }))
            .filter(g => g.hs != null && g.as != null);
          dbg.push('hist: total ' + asList(rawA).length + ', contre B ' + listA.length);
          const seen = new Set(out.matches.map(m => m.date + '|' + m.homeId));
          const all = out.matches.concat(g2.filter(g => !seen.has(g.date + '|' + g.homeId)));
          if (all.length > out.matches.length) { out = summarizeH2H(all, a); source = 'p1-hist'; }
        } catch (e) { console.log('h2h hist', e.message); dbg.push('hist: ' + e.message); }
      }
      if (out.matches.length < 6 && an && bn && APISPORTS_KEY) {
        try {
          const o2 = await sportsH2H(an, bn);
          if (!o2) dbg.push('sports: équipe introuvable');
          if (o2 && o2.summary.total > (out.summary ? out.summary.total : 0)) { out = o2; source = 'api-sports'; }
        } catch (e) { console.log('h2h sports', e.message); dbg.push('sports: ' + e.message); }
      }
    }
    res.json(req.query.debug ? { ...out, source, dbg } : { ...out, source });
  } catch (err) {
    console.error(err);
    res.status(req.query.debug ? 200 : 500).json({ error: 'Erreur confrontations.', detail: err.message || String(err) });
  }
});

/* ---------- PRONOSTICS (probabilités de victoire) ---------- */
// GET /api/predictions?date=2026-10-13  (jour « Paris », comme /api/fixtures) -> { predictions: { matchId: { h, d, a } } }
app.get('/api/predictions', async (req, res) => {
  try {
    const day = req.query.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return res.status(400).json({ error: 'Paramètre date (AAAA-MM-JJ) requis.' });
    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_predictions&from=${day}&to=${day}`, 60 * 60 * 1000);
    const list = asList(raw);
    if (req.query.debug) return res.json({ n: list.length, sample: list.slice(0, 2), type: typeof raw, keys: raw && !Array.isArray(raw) ? Object.keys(raw) : null });
    const out = {};
    for (const x of list) {
      const h = parseFloat(x.prob_HW), d = parseFloat(x.prob_D), a = parseFloat(x.prob_AW);
      if (x.match_id && [h, d, a].every(v => isFinite(v))) out[String(x.match_id)] = { h, d, a };
    }
    res.json({ predictions: out });
  } catch (err) {
    console.error(err);
    res.status(req.query.debug ? 200 : 500).json({ error: 'Erreur pronostics.', detail: err.message || String(err) });
  }
});

/* ---------- PROBABILITÉS DE VICTOIRE POUR TOUS LES MATCHS ---------- */
// 1) pronostic du fournisseur  2) cotes du marché (moyenne des bookmakers)  3) modèle maison (classement + buts marqués/encaissés)
async function dayPredictions(day) {
  const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_predictions&from=${day}&to=${day}`, 60 * 60 * 1000);
  const out = {};
  for (const x of asList(raw)) {
    const h = parseFloat(x.prob_HW), d = parseFloat(x.prob_D), a = parseFloat(x.prob_AW);
    if (x.match_id && [h, d, a].every(v => isFinite(v))) out[String(x.match_id)] = { h, d, a };
  }
  return out;
}
async function dayOdds(day) {
  const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_odds&from=${day}&to=${day}`, 30 * 60 * 1000);
  const acc = {};
  for (const x of asList(raw)) {
    const o1 = parseFloat(x.odd_1), ox = parseFloat(x.odd_x), o2 = parseFloat(x.odd_2);
    if (!x.match_id || ![o1, ox, o2].every(v => isFinite(v) && v > 1)) continue;
    const i1 = 1 / o1, ix = 1 / ox, i2 = 1 / o2, t = i1 + ix + i2;
    const a = acc[String(x.match_id)] || (acc[String(x.match_id)] = { h: 0, d: 0, a: 0, n: 0 });
    a.h += i1 / t; a.d += ix / t; a.a += i2 / t; a.n++;
  }
  const out = {};
  for (const [id, a] of Object.entries(acc)) out[id] = { h: 100 * a.h / a.n, d: 100 * a.d / a.n, a: 100 * a.a / a.n };
  return out;
}
const modelStand = new Map();   // league_id -> { rows, at }
async function standingsForModel(leagueId) {
  const hit = modelStand.get(leagueId);
  if (hit && Date.now() - hit.at < 12 * 3600 * 1000) return hit.rows;
  let rows = [];
  try {
    const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_standings&league_id=${encodeURIComponent(leagueId)}`, 10 * 60 * 1000);
    rows = asList(raw).filter(x => x && x.team_name).map(mapStanding);
  } catch (e) { if (hit) return hit.rows; throw e; }
  modelStand.set(leagueId, { rows, at: Date.now() });
  return rows;
}
function poissonModel(rows, homeId, awayId) {
  const tm = id => rows.filter(r => String(r.teamId) === String(id) && r.played > 0).sort((a, b) => b.played - a.played)[0];
  const H = tm(homeId), A = tm(awayId);
  if (!H || !A) return null;
  const valid = rows.filter(r => r.played > 0 && r.gf != null && r.ga != null);
  const P = valid.reduce((s, r) => s + r.played, 0), G = valid.reduce((s, r) => s + r.gf, 0);
  if (!P || !G) return null;
  const avg = G / P, K = 5;
  const att = r => ((r.gf + K * avg) / (r.played + K)) / avg;
  const def = r => ((r.ga + K * avg) / (r.played + K)) / avg;
  const lh = avg * 1.12 * att(H) * def(A), la = avg * 0.9 * att(A) * def(H);
  const pois = (l, k) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
  let ph = 0, pd = 0, pa = 0;
  for (let i = 0; i <= 9; i++) for (let j = 0; j <= 9; j++) {
    const p = pois(lh, i) * pois(la, j);
    if (i > j) ph += p; else if (i === j) pd += p; else pa += p;
  }
  const t = ph + pd + pa;
  return { h: 100 * ph / t, d: 100 * pd / t, a: 100 * pa / t };
}
// GET /api/winprob?match=ID&date=AAAA-MM-JJ&league=ID&home=ID&away=ID -> { h, d, a, source } ou { source:null }
app.get('/api/winprob', async (req, res) => {
  const { match, date, league, home, away } = req.query;
  if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || isAfr(String(match))) return res.json({ source: null });
  const done = (p, source) => res.json({ h: Math.round(p.h * 10) / 10, d: Math.round(p.d * 10) / 10, a: Math.round(p.a * 10) / 10, source });
  const errs = [];
  try { const p = (await dayPredictions(date))[String(match)]; if (p) return done(p, 'provider'); } catch (e) { errs.push('pred: ' + e.message); }
  try { const p = (await dayOdds(date))[String(match)]; if (p) return done(p, 'odds'); } catch (e) { errs.push('odds: ' + e.message); }
  try {
    if (league && home && away && !isAfr(String(league))) {
      const p = poissonModel(await standingsForModel(String(league)), home, away);
      if (p) return done(p, 'model');
    }
  } catch (e) { errs.push('model: ' + e.message); }
  res.json(req.query.debug ? { source: null, errs } : { source: null });
});

/* ---------- NOTIFICATIONS PUSH (buts, coup d'envoi, fin de match des favoris) ---------- */
// Variables à définir sur Render : VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY (sans elles, les notifications sont désactivées).
let webpush = null;
try { webpush = require('web-push'); } catch (e) { console.warn('web-push non installé : notifications désactivées.'); }
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY, VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const PUSH_ON = !!(webpush && VAPID_PUBLIC && VAPID_PRIVATE);
if (PUSH_ON) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://tsekou473-byte.github.io/coup-denvoi-app/', VAPID_PUBLIC, VAPID_PRIVATE);
else console.warn('Notifications push désactivées (clés VAPID manquantes).');

const fs = require('fs'), os = require('os'), path = require('path');
const SUBS_FILE = path.join(os.tmpdir(), 'coup-denvoi-push-subs.json');
const subs = new Map();   // endpoint -> { sub, teams:[], matches:[], lang }
try { for (const x of JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'))) subs.set(x.sub.endpoint, x); } catch (e) {}
let saveTimer = null;
const saveSubs = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(SUBS_FILE, JSON.stringify([...subs.values()])); } catch (e) {} }, 2000); };

const PUSH_TXT = {
  kickoff:{ fr:"Coup d'envoi", en:'Kick-off', es:'Comienza el partido', pt:'Começou o jogo', ar:'انطلقت المباراة', de:'Anpfiff', it:"Calcio d'inizio", tr:'Maç başladı' },
  goal:   { fr:'But !', en:'Goal!', es:'¡Gol!', pt:'Gol!', ar:'هدف!', de:'Tor!', it:'Gol!', tr:'Gol!' },
  final:  { fr:'Match terminé', en:'Full time', es:'Final del partido', pt:'Fim de jogo', ar:'نهاية المباراة', de:'Abpfiff', it:'Fine partita', tr:'Maç bitti' },
  test:   { fr:'Notifications activées ✅', en:'Notifications on ✅', es:'Notificaciones activadas ✅', pt:'Notificações ativadas ✅', ar:'تم تفعيل الإشعارات ✅', de:'Benachrichtigungen aktiv ✅', it:'Notifiche attive ✅', tr:'Bildirimler açık ✅' },
  testBody:{ fr:"Tu recevras les buts, coups d'envoi et fins de match de tes favoris.", en:"You'll get goals, kick-offs and final whistles for your favorites.", es:'Recibirás goles, inicios y finales de tus favoritos.', pt:'Você receberá gols, inícios e finais dos seus favoritos.', ar:'ستصلك أهداف ومواعيد انطلاق ونهايات مباريات مفضلتك.', de:'Du erhältst Tore, Anpfiffe und Abpfiffe deiner Favoriten.', it:'Riceverai gol, calci d\'inizio e fischi finali dei tuoi preferiti.', tr:'Favorilerinin golleri, başlangıç ve bitiş bildirimlerini alacaksın.' }
};
const ptxt = (k, lang) => (PUSH_TXT[k] && (PUSH_TXT[k][lang] || PUSH_TXT[k].fr)) || '';

async function pushTo(entry, payload) {
  try {
    await webpush.sendNotification(entry.sub, JSON.stringify(payload), { TTL: 3600 });
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) { subs.delete(entry.sub.endpoint); saveSubs(); }
    else console.warn('push', e.statusCode || e.message);
    return false;
  }
}
const watched = entry => g => entry.matches.includes(String(g.id)) || entry.teams.includes(String(g.homeId)) || entry.teams.includes(String(g.awayId));

// état connu de chaque match : détecte coup d'envoi, buts, fin
const seen = new Map();   // id -> { status, hs, as }
function detectEvents(games) {
  const events = [];
  for (const g of games) {
    const id = String(g.id), prev = seen.get(id);
    const hs = Number(g.hs) || 0, as = Number(g.as) || 0;
    if (prev) {
      if (prev.status !== 'live' && g.status === 'live') events.push({ type: 'kickoff', g });
      if (g.status === 'live' && (hs > prev.hs || as > prev.as)) events.push({ type: 'goal', g });
      if (prev.status === 'live' && g.status === 'final') events.push({ type: 'final', g });
    }
    seen.set(id, { status: g.status, hs, as });
  }
  return events;
}
async function notifyEvents(events) {
  for (const ev of events) {
    const g = ev.g, hs = Number(g.hs) || 0, as = Number(g.as) || 0;
    for (const entry of [...subs.values()]) {
      if (!watched(entry)(g)) continue;
      const lang = entry.lang;
      const body = ev.type === 'kickoff' ? `${g.home} – ${g.away}` : `${g.home} ${hs}-${as} ${g.away}${ev.type === 'goal' && g.minute ? ` (${String(g.minute).replace(/^(\d+)$/, "$1'")})` : ''}`;
      await pushTo(entry, { title: (ev.type === 'goal' ? '⚽ ' : '') + ptxt(ev.type, lang), body, tag: `${ev.type}-${g.id}-${hs}-${as}`, url: './' });
    }
  }
}
// relève les matchs ; rythme adapté : vite quand un match suivi est en cours, lent sinon (économise le quota du fournisseur)
let pollTimer = null;
let lastKick = 0;
async function pollOnce() {
  let wait = 10 * 60 * 1000;
  try {
    if (subs.size) {
      const raw = await cachedFetch(`https://${RAPIDAPI_HOST}/?action=get_events&from=${dayIso(-1)}&to=${dayIso(1)}`, 60 * 1000);
      const now = new Date();
      const games = asList(raw).map(item => mapGame(item, now));
      await notifyEvents(detectEvents(games));
      const mine = games.filter(g => [...subs.values()].some(e => watched(e)(g)));
      if (mine.some(g => g.status === 'live')) wait = 75 * 1000;
      else {
        const next = Math.min(...mine.filter(g => g.status === 'scheduled' && typeof g.ts === 'number' && g.ts > Date.now()).map(g => g.ts), Infinity);
        if (next !== Infinity) wait = Math.max(60 * 1000, Math.min(wait, next - Date.now() - 2 * 60 * 1000));
      }
    }
  } catch (e) { console.warn('push poll', e.message); wait = 3 * 60 * 1000; }
  pollTimer = setTimeout(pollOnce, wait);
}
if (PUSH_ON) pollTimer = setTimeout(pollOnce, 20 * 1000);

app.get('/api/push/key', (req, res) => res.json({ enabled: PUSH_ON, key: PUSH_ON ? VAPID_PUBLIC : null }));
// POST /api/push/sync { subscription, teams:[id], matches:[id], lang }
app.post('/api/push/sync', (req, res) => {
  if (!PUSH_ON) return res.status(503).json({ error: 'Notifications indisponibles sur ce serveur.' });
  const b = req.body || {};
  const sub = b.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) return res.status(400).json({ error: 'Abonnement invalide.' });
  const ids = v => (Array.isArray(v) ? v : []).slice(0, 100).map(String);
  const lang = Object.keys(PUSH_TXT.goal).includes(b.lang) ? b.lang : 'fr';
  const first = !subs.has(sub.endpoint);
  subs.set(sub.endpoint, { sub, teams: ids(b.teams), matches: ids(b.matches), lang });
  saveSubs();
  // un abonné nouveau ou qui revient (ex. après un redémarrage du serveur) : on relève les matchs tout de suite
  if (Date.now() - lastKick > 20 * 1000) { lastKick = Date.now(); clearTimeout(pollTimer); pollTimer = setTimeout(pollOnce, 3000); }
  res.json({ ok: true, known: subs.size });
});
app.post('/api/push/unsubscribe', (req, res) => {
  const ep = req.body && req.body.endpoint;
  if (ep) { subs.delete(ep); saveSubs(); }
  res.json({ ok: true });
});
app.post('/api/push/test', async (req, res) => {
  if (!PUSH_ON) return res.status(503).json({ error: 'Notifications indisponibles sur ce serveur.' });
  const entry = subs.get(req.body && req.body.endpoint);
  if (!entry) return res.status(404).json({ error: 'Abonnement inconnu.' });
  const ok = await pushTo(entry, { title: ptxt('test', entry.lang), body: ptxt('testBody', entry.lang), tag: 'test', url: './' });
  res.json({ ok });
});

app.listen(PORT, () => {
  console.log(`✅ Backend démarré sur le port ${PORT}`);
});
