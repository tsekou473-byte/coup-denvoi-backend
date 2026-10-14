// Chat en direct par match + signalement + page d'administration.
// Stockage : mémoire + fichier JSON (sur l'hébergement gratuit, le fichier peut être effacé à chaque redéploiement :
// avant le lancement public il faudra une vraie base de données).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function mountChat(app) {
  const DIR = process.env.CHAT_DATA_DIR || path.join(__dirname, 'data');
  const FILE = path.join(DIR, 'chat.json');
  const ADMIN_KEY = process.env.ADMIN_KEY || '';
  const MAX_PER_ROOM = 400, KEEP_MS = 4 * 24 * 3600 * 1000, HIDE_AT = 3;

  let db = { nextId: 1, msgs: [], reports: [], banned: [] };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* premier démarrage */ }
  let saveT = null;
  const save = () => {
    if (saveT) return;
    saveT = setTimeout(() => {
      saveT = null;
      try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { /* disque indisponible : on garde la mémoire */ }
    }, 4000);
  };

  const uh = uid => crypto.createHash('sha1').update('ce|' + uid).digest('hex').slice(0, 8);
  const okUid = u => /^[a-zA-Z0-9-]{12,64}$/.test(String(u || ''));
  const okRoom = r => /^[A-Za-z0-9:_~.\-]{1,40}$/.test(String(r || ''));
  const clean = (t, max) => String(t || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const lastBy = new Map();   // uid -> { t, text, hist:[] } pour limiter le rythme
  setInterval(() => {         // ménage : vieux messages
    const lim = Date.now() - KEEP_MS;
    const n = db.msgs.length;
    db.msgs = db.msgs.filter(m => m.ts > lim);
    if (db.msgs.length !== n) save();
    for (const [k, v] of lastBy) if (Date.now() - v.t > 3600 * 1000) lastBy.delete(k);
  }, 3600 * 1000).unref();

  app.get('/api/chat/messages', (req, res) => {
    const room = String(req.query.room || '');
    if (!okRoom(room)) return res.status(400).json({ error: 'room invalide' });
    const since = parseInt(req.query.since, 10) || 0;
    const all = db.msgs.filter(m => m.room === room);
    const live = all.filter(m => !m.hidden && !m.deleted && m.id > since).slice(-60);
    res.json({
      messages: live.map(m => ({ id: m.id, name: m.name, text: m.text, ts: m.ts, uh: m.uh })),
      gone: all.filter(m => (m.hidden || m.deleted) && m.id <= (since || Infinity)).map(m => m.id).slice(-100),
      last: all.length ? all[all.length - 1].id : 0
    });
  });

  app.post('/api/chat/send', (req, res) => {
    const { room, uid } = req.body || {};
    const name = clean(req.body && req.body.name, 20), text = clean(req.body && req.body.text, 280);
    if (!okRoom(room) || !okUid(uid)) return res.status(400).json({ error: 'requête invalide' });
    if (name.length < 2) return res.status(400).json({ error: 'Choisis un pseudo (2 lettres minimum).' });
    if (!text) return res.status(400).json({ error: 'Message vide.' });
    const h = uh(uid);
    if (db.banned.includes(h)) return res.status(403).json({ error: "Tu ne peux plus écrire dans le chat." });
    if (/https?:\/\/|www\.|\.(com|net|org|fr|io|ly)\b/i.test(text)) return res.status(400).json({ error: 'Les liens ne sont pas autorisés.' });
    const now = Date.now(), st = lastBy.get(uid) || { t: 0, text: '', hist: [] };
    if (now - st.t < 1500) return res.status(429).json({ error: 'Doucement, un message à la fois.' });
    st.hist = st.hist.filter(x => now - x < 60000);
    if (st.hist.length >= 15) return res.status(429).json({ error: 'Trop de messages, attends un instant.' });
    if (st.text === text) return res.status(400).json({ error: 'Message déjà envoyé.' });
    st.t = now; st.text = text; st.hist.push(now); lastBy.set(uid, st);
    const m = { id: db.nextId++, room, uh: h, name, text, ts: now, hidden: false, deleted: false };
    db.msgs.push(m);
    const inRoom = db.msgs.filter(x => x.room === room);
    if (inRoom.length > MAX_PER_ROOM) db.msgs = db.msgs.filter(x => x.room !== room || inRoom.indexOf(x) >= inRoom.length - MAX_PER_ROOM);
    save();
    res.json({ message: { id: m.id, name: m.name, text: m.text, ts: m.ts, uh: m.uh } });
  });

  app.post('/api/chat/report', (req, res) => {
    const { room, uid } = req.body || {};
    const id = parseInt(req.body && req.body.id, 10), reason = clean(req.body && req.body.reason, 60);
    if (!okRoom(room) || !okUid(uid) || !id) return res.status(400).json({ error: 'requête invalide' });
    const m = db.msgs.find(x => x.id === id && x.room === room);
    if (!m) return res.status(404).json({ error: 'message introuvable' });
    const h = uh(uid);
    if (m.uh === h) return res.status(400).json({ error: 'Tu ne peux pas signaler ton propre message.' });
    if (!db.reports.some(r => r.msgId === id && r.by === h)) {
      db.reports.push({ msgId: id, by: h, ts: Date.now(), reason });
      const n = db.reports.filter(r => r.msgId === id).length;
      if (n >= HIDE_AT && !m.hidden) m.hidden = true;   // masqué automatiquement en attendant ton avis
      console.log(`🚩 Signalement chat — message ${id} (${m.name}) : « ${m.text.slice(0, 80)} » — ${n} signalement(s)`);
      save();
    }
    res.json({ ok: true });
  });

  // ---- administration : /admin/chat?key=TA_CLE ----
  const guard = (req, res) => {
    if (!ADMIN_KEY) { res.status(503).send("Ajoute la variable ADMIN_KEY dans Render (Environment) pour activer cette page."); return false; }
    if (req.query.key !== ADMIN_KEY) { res.status(403).send('Clé incorrecte.'); return false; }
    return true;
  };
  app.get('/admin/chat/act', (req, res) => {
    if (!guard(req, res)) return;
    const id = parseInt(req.query.id, 10), act = String(req.query.act || '');
    const m = db.msgs.find(x => x.id === id);
    if (act === 'delete' && m) { m.deleted = true; }
    if (act === 'restore' && m) { m.deleted = false; m.hidden = false; db.reports = db.reports.filter(r => r.msgId !== id); }
    if (act === 'clear' && m) { m.hidden = false; db.reports = db.reports.filter(r => r.msgId !== id); }
    if (act === 'ban' && m) { if (!db.banned.includes(m.uh)) db.banned.push(m.uh); db.msgs.filter(x => x.uh === m.uh).forEach(x => { x.deleted = true; }); }
    if (act === 'unban') { db.banned = db.banned.filter(x => x !== String(req.query.uh)); }
    save();
    res.redirect('/admin/chat?key=' + encodeURIComponent(ADMIN_KEY));
  });
  app.get('/admin/chat', (req, res) => {
    if (!guard(req, res)) return;
    const k = encodeURIComponent(ADMIN_KEY);
    const cnt = id => db.reports.filter(r => r.msgId === id).length;
    const reported = db.msgs.filter(m => cnt(m.id) > 0).sort((a, b) => cnt(b.id) - cnt(a.id));
    const row = m => `<tr class="${m.deleted ? 'del' : m.hidden ? 'hid' : ''}"><td>${cnt(m.id) || ''}</td><td><b>${esc(m.name)}</b> <small>(${m.uh} · salle ${esc(m.room)} · ${new Date(m.ts).toLocaleString('fr-FR')})</small><br>${esc(m.text)}${m.deleted ? ' <i>— supprimé</i>' : m.hidden ? ' <i>— masqué</i>' : ''}</td>
      <td><a href="/admin/chat/act?key=${k}&act=delete&id=${m.id}">Supprimer</a> · <a href="/admin/chat/act?key=${k}&act=clear&id=${m.id}">Laisser (ignorer)</a> · <a href="/admin/chat/act?key=${k}&act=ban&id=${m.id}" onclick="return confirm('Bloquer cet utilisateur ?')">Bloquer l'auteur</a></td></tr>`;
    const recent = db.msgs.slice(-40).reverse();
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat — modération</title>
<style>body{font:15px system-ui;margin:16px;max-width:900px}table{border-collapse:collapse;width:100%}td{border-top:1px solid #ddd;padding:8px;vertical-align:top}tr.hid{background:#fff4e0}tr.del{opacity:.5}a{color:#0a58ca}h2{margin-top:28px}</style>
<h1>Chat — modération</h1>
<h2>Messages signalés (${reported.length})</h2><table>${reported.map(row).join('') || '<tr><td>Aucun signalement 🎉</td></tr>'}</table>
<h2>Derniers messages</h2><table>${recent.map(row).join('') || '<tr><td>Aucun message</td></tr>'}</table>
<h2>Utilisateurs bloqués (${db.banned.length})</h2><p>${db.banned.map(h => `${h} <a href="/admin/chat/act?key=${k}&act=unban&uh=${h}">débloquer</a>`).join('<br>') || 'Aucun'}</p>`);
  });

  // ---- signalements d'erreurs envoyés depuis les Réglages de l'app ----
  const FB_FILE = path.join(DIR, 'feedback.json');
  let fb = { nextId: 1, items: [] };
  try { fb = Object.assign(fb, JSON.parse(fs.readFileSync(FB_FILE, 'utf8'))); } catch (e) { /* premier démarrage */ }
  const saveFb = () => { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FB_FILE, JSON.stringify(fb)); } catch (e) { /* mémoire seulement */ } };
  const fbRate = new Map();
  app.post('/api/feedback', (req, res) => {
    const b = req.body || {};
    const text = String(b.text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, ' ').trim().slice(0, 600);
    if (text.length < 5) return res.status(400).json({ error: 'message trop court' });
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const h = (fbRate.get(ip) || []).filter(t => Date.now() - t < 3600 * 1000);
    if (h.length >= 6) return res.status(429).json({ error: 'Trop de messages, réessaie plus tard.' });
    h.push(Date.now()); fbRate.set(ip, h);
    fb.items.push({ id: fb.nextId++, ts: Date.now(), text, version: clean(b.version, 12), lang: clean(b.lang, 8), page: clean(b.page, 20), match: clean(b.match, 40), ua: clean(b.ua, 140), uh: okUid(b.uid) ? uh(b.uid) : '', done: false });
    if (fb.items.length > 500) fb.items = fb.items.slice(-500);
    saveFb();
    console.log('📝 Signalement d\'erreur reçu : ' + text.slice(0, 100));
    res.json({ ok: true });
  });
  app.get('/admin/feedback/act', (req, res) => {
    if (!guard(req, res)) return;
    const id = parseInt(req.query.id, 10), it = fb.items.find(x => x.id === id);
    if (it && req.query.act === 'done') it.done = !it.done;
    if (it && req.query.act === 'delete') fb.items = fb.items.filter(x => x.id !== id);
    saveFb();
    res.redirect('/admin/feedback?key=' + encodeURIComponent(ADMIN_KEY));
  });
  app.get('/admin/feedback', (req, res) => {
    if (!guard(req, res)) return;
    const k = encodeURIComponent(ADMIN_KEY);
    const list = fb.items.slice().sort((a, b) => (a.done - b.done) || (b.ts - a.ts));
    const row = x => `<tr class="${x.done ? 'del' : ''}"><td><b>#${x.id}</b><br><small>${new Date(x.ts).toLocaleString('fr-FR')}</small></td><td>${esc(x.text)}<br><small>${esc(x.version)} · ${esc(x.lang)} · page : ${esc(x.page) || '-'}${x.match ? ' · match : ' + esc(x.match) : ''}<br>${esc(x.ua)}</small></td><td><a href="/admin/feedback/act?key=${k}&act=done&id=${x.id}">${x.done ? 'Rouvrir' : 'Traité'}</a> · <a href="/admin/feedback/act?key=${k}&act=delete&id=${x.id}" onclick="return confirm('Supprimer ?')">Supprimer</a></td></tr>`;
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signalements</title>
<style>body{font:15px system-ui;margin:16px;max-width:900px}table{border-collapse:collapse;width:100%}td{border-top:1px solid #ddd;padding:8px;vertical-align:top}tr.del{opacity:.5}a{color:#0a58c2}small{color:#666}</style>
<h1>Signalements d'erreurs (${fb.items.filter(x => !x.done).length} à traiter)</h1><p><a href="/admin/chat?key=${k}">Modération du chat</a></p><table>${list.map(row).join('') || '<tr><td>Aucun signalement</td></tr>'}</table>`);
  });
};
