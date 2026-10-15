// Pronostics entre amis : groupes (code à 6 caractères), pronostics de score, classement.
// Le serveur ne sert que de point de rencontre : chaque appareil garde ses pronostics et ses groupes et les renvoie
// à chaque synchronisation, donc rien n'est perdu si le fichier est effacé lors d'un redéploiement.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function mountPron(app, D) {
  const DIR = process.env.CHAT_DATA_DIR || path.join(__dirname, 'data');
  const FILE = path.join(DIR, 'pron.json');
  let db = { groups: {}, users: {}, results: {} };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* premier démarrage */ }
  let saveT = null;
  const save = () => {
    if (saveT) return;
    saveT = setTimeout(() => {
      saveT = null;
      try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { /* mémoire seulement */ }
    }, 3000);
  };

  const okUid = u => /^[a-zA-Z0-9-]{12,64}$/.test(String(u || ''));
  const okCode = c => /^[A-Z2-9]{6}$/.test(String(c || ''));
  const okId = i => /^[A-Za-z0-9:_~.\-]{1,40}$/.test(String(i || ''));
  const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const clean = (t, max) => String(t || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const goal = v => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 20 ? n : null; };
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const newCode = () => { for (let k = 0; k < 20; k++) { let c = ''; const b = crypto.randomBytes(6); for (let i = 0; i < 6; i++) c += ALPHA[b[i] % ALPHA.length]; if (!db.groups[c]) return c; } return null; };
  const MAX_MEMBERS = 30, MAX_GROUPS_USER = 8, MAX_PREDS = 400;

  const hits = new Map();   // ip -> [t]
  const limited = (req, res, n = 40) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'x';
    const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
    arr.push(now); hits.set(ip, arr);
    if (arr.length > n) { res.status(429).json({ error: 'Trop de requêtes. Réessaie dans quelques minutes.' }); return true; }
    return false;
  };
  setInterval(() => { const lim = Date.now() - 10 * 60 * 1000; for (const [k, v] of hits) if (!v.some(t => t > lim)) hits.delete(k); }, 10 * 60 * 1000).unref();

  const user = (uid, name) => {
    const u = db.users[uid] || (db.users[uid] = { name: 'Joueur', preds: {}, groups: [] });
    const nm = clean(name, 20); if (nm) u.name = nm;
    u.seen = Date.now();
    return u;
  };
  const joinGroup = (uid, code) => {
    const g = db.groups[code]; if (!g) return false;
    if (!g.members.includes(uid)) { if (g.members.length >= MAX_MEMBERS) return false; g.members.push(uid); }
    const u = db.users[uid]; if (u && !u.groups.includes(code)) u.groups.push(code);
    return true;
  };

  function mergePreds(u, preds) {
    const ids = Object.keys(preds || {}).slice(0, MAX_PREDS);
    for (const id of ids) {
      const p = preds[id]; if (!okId(id) || !p) continue;
      const h = goal(p.h), a = goal(p.a), ts = Number(p.ts), at = Number(p.at);
      if (h === null || a === null || !isFinite(ts) || !isFinite(at)) continue;
      if (at >= ts) continue;                                   // pronostic posé après le coup d'envoi : refusé
      const old = u.preds[id];
      if (old && old.at >= at) continue;                         // on garde le plus récent
      u.preds[id] = { h, a, at, ts, date: okDate(p.date) ? p.date : '', home: clean(p.home, 40), away: clean(p.away, 40), comp: clean(p.comp, 40) };
    }
  }

  app.post('/api/pron/sync', (req, res) => {
    if (limited(req, res)) return;
    const b = req.body || {};
    if (!okUid(b.uid)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const u = user(b.uid, b.name);
    mergePreds(u, b.preds);
    // groupes : la liste envoyée par l'appareil fait foi
    const want = (Array.isArray(b.groups) ? b.groups : []).slice(0, MAX_GROUPS_USER).filter(g => g && okCode(g.code));
    for (const g of want) {
      if (!db.groups[g.code]) db.groups[g.code] = { name: clean(g.name, 24) || 'Groupe', created: Date.now(), members: [] };
      joinGroup(b.uid, g.code);
    }
    const keep = new Set(want.map(g => g.code));
    for (const code of [...u.groups]) if (!keep.has(code)) { u.groups = u.groups.filter(c => c !== code); const g = db.groups[code]; if (g) g.members = g.members.filter(m => m !== b.uid); }
    save();
    res.json({ ok: true });
  });

  app.post('/api/pron/group', (req, res) => {
    if (limited(req, res, 15)) return;
    const b = req.body || {};
    if (!okUid(b.uid)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const name = clean(b.groupName, 24);
    if (name.length < 2) return res.status(400).json({ error: 'Donne un nom au groupe (2 lettres minimum).' });
    const u = user(b.uid, b.name);
    if (u.groups.length >= MAX_GROUPS_USER) return res.status(400).json({ error: 'Tu es déjà dans trop de groupes.' });
    if (Object.keys(db.groups).length > 20000) return res.status(503).json({ error: 'Service saturé.' });
    const code = newCode(); if (!code) return res.status(503).json({ error: 'Réessaie.' });
    db.groups[code] = { name, created: Date.now(), members: [] };
    joinGroup(b.uid, code); save();
    res.json({ code, name });
  });

  app.post('/api/pron/join', (req, res) => {
    if (limited(req, res, 20)) return;
    const b = req.body || {};
    if (!okUid(b.uid)) return res.status(400).json({ error: 'Identifiant invalide.' });
    const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!okCode(code) || !db.groups[code]) return res.status(404).json({ error: "Code inconnu. Vérifie-le avec ton ami." });
    const u = user(b.uid, b.name);
    if (!u.groups.includes(code) && u.groups.length >= MAX_GROUPS_USER) return res.status(400).json({ error: 'Tu es déjà dans trop de groupes.' });
    if (!joinGroup(b.uid, code)) return res.status(400).json({ error: 'Ce groupe est complet.' });
    save();
    res.json({ code, name: db.groups[code].name });
  });

  // résultats : on garde les scores finaux déjà connus, on interroge le fournisseur (par jour, cache partagé avec /api/fixtures) pour le reste
  async function settle(dates) {
    const todo = [...dates].filter(okDate).slice(0, 10);
    await Promise.all(todo.map(async d => {
      try {
        const params = new URLSearchParams({ action: 'get_events', from: d, to: d });
        const raw = await D.cachedFetch(`https://${D.host()}/?${params.toString()}`, D.fixturesTtl(d, d));
        const now = new Date();
        D.asList(raw).forEach(x => {
          const g = D.mapGame(x, now);
          if (g && g.status === 'final' && g.hs != null && g.as != null) db.results[String(g.id)] = { hs: Number(g.hs), as: Number(g.as) };
        });
      } catch (e) { /* jour indisponible : on réessaiera */ }
    }));
  }
  const outcome = (a, b) => a > b ? 1 : a < b ? -1 : 0;
  const points = (p, r) => (p.h === r.hs && p.a === r.as) ? 3 : (outcome(p.h, p.a) === outcome(r.hs, r.as) ? 1 : 0);

  app.get('/api/pron/board', async (req, res) => {
    if (limited(req, res, 120)) return;
    try {
      const code = String(req.query.code || '').toUpperCase();
      const g = okCode(code) && db.groups[code];
      if (!g) return res.status(404).json({ error: 'Groupe introuvable.' });
      const now = Date.now();
      const members = g.members.map(uid => db.users[uid]).filter(Boolean);
      const need = new Set();
      members.forEach(u => Object.entries(u.preds).forEach(([id, p]) => { if (p.ts < now - 105 * 60 * 1000 && !db.results[id] && p.date && now - p.ts < 20 * 24 * 3600 * 1000) need.add(p.date); }));
      if (need.size) { await settle(need); save(); }
      const rows = members.map(u => {
        let pts = 0, exact = 0, ok = 0, n = 0;
        Object.entries(u.preds).forEach(([id, p]) => { const r = db.results[id]; if (!r) return; const x = points(p, r); n++; pts += x; if (x === 3) exact++; if (x >= 1) ok++; });
        return { name: u.name, pts, exact, ok, n };
      }).sort((a, b) => b.pts - a.pts || b.exact - a.exact || a.n - b.n || a.name.localeCompare(b.name));
      // pronostics révélés : seulement les matchs déjà commencés
      const byMatch = new Map();
      members.forEach(u => Object.entries(u.preds).forEach(([id, p]) => {
        if (p.ts > now) return;
        const m = byMatch.get(id) || { id, home: p.home, away: p.away, ts: p.ts, res: db.results[id] || null, picks: [] };
        const r = db.results[id];
        m.picks.push({ name: u.name, h: p.h, a: p.a, pts: r ? points(p, r) : null });
        byMatch.set(id, m);
      }));
      const reveals = [...byMatch.values()].sort((a, b) => b.ts - a.ts).slice(0, 8).map(m => ({ ...m, picks: m.picks.sort((a, b) => (b.pts || 0) - (a.pts || 0) || a.name.localeCompare(b.name)) }));
      res.json({ code, name: g.name, members: members.length, rows, reveals });
    } catch (e) {
      console.error('pron board', e);
      res.status(500).json({ error: 'Erreur du classement.' });
    }
  });
};
module.exports.points = (p, r) => { const o = (a, b) => a > b ? 1 : a < b ? -1 : 0; return (p.h === r.hs && p.a === r.as) ? 3 : (o(p.h, p.a) === o(r.hs, r.as) ? 1 : 0); };
