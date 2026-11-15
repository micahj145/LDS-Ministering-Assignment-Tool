// Demo only: an in-browser stand-in for the Firebase SDK, used by demo.html in
// place of vendor/firebase-12.18.0.js. It offers exactly the calls the app
// makes (see vendor/firebase-shim.src.js) and keeps everything in this browser
// tab: nothing is sent anywhere, there is no Firebase project behind it, and
// the only data is the invented ward in demo/demo-data.js.
//
// Storage: an in-memory map of document paths, copied to sessionStorage so
// changes survive switching the "View as" person (which reloads the page) and
// vanish when the tab is closed. "Reset demo" puts the invented ward back.
(function () {
  'use strict';
  const STORE_KEY = 'demoStore.v1', USER_KEY = 'demoUid';
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const nowIso = () => new Date().toISOString();

  function ss(fn, fallback) { try { return fn(window.sessionStorage); } catch (e) { return fallback; } }

  // ── The store ───────────────────────────────────────────────
  let docs = new Map();
  function seedDocs() { return new Map(Object.entries(window.DEMO_SEED()).map(([p, d]) => [p, clone(d)])); }
  function load() {
    const saved = ss(s => s.getItem(STORE_KEY), null);
    if (saved) { try { docs = new Map(Object.entries(JSON.parse(saved))); return; } catch (e) {} }
    docs = seedDocs();
  }
  let saveTimer = null;
  const flush = () => { clearTimeout(saveTimer); saveTimer = null; ss(s => s.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(docs)))); };
  function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 50); }
  window.addEventListener('pagehide', () => { if (saveTimer) flush(); });
  load();

  // ── Field values ────────────────────────────────────────────
  const FV = 'demo-field-value';
  const FieldValue = {
    serverTimestamp: () => ({ [FV]: 'ts' }),
    arrayUnion: (...v) => ({ [FV]: 'union', v }),
    arrayRemove: (...v) => ({ [FV]: 'remove', v }),
    delete: () => ({ [FV]: 'delete' }),
    increment: n => ({ [FV]: 'inc', n }),
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function resolve(value, current) {
    if (value && typeof value === 'object' && value[FV]) {
      const kind = value[FV], arr = Array.isArray(current) ? current.slice() : [];
      if (kind === 'ts') return nowIso();
      if (kind === 'union') { value.v.forEach(x => { if (!arr.some(y => same(x, y))) arr.push(clone(x)); }); return arr; }
      if (kind === 'remove') return arr.filter(y => !value.v.some(x => same(x, y)));
      if (kind === 'inc') return (typeof current === 'number' ? current : 0) + value.n;
      if (kind === 'delete') return undefined;
    }
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(v => resolve(v, undefined));
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach(k => { const r = resolve(value[k], undefined); if (r !== undefined) out[k] = r; });
      return out;
    }
    return value;
  }
  function deepMerge(target, src) {
    const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
    Object.keys(src).forEach(k => {
      const v = src[k];
      if (v && typeof v === 'object' && v[FV]) { const r = resolve(v, out[k]); if (r === undefined) delete out[k]; else out[k] = r; }
      else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) out[k] = deepMerge(out[k], v);
      else out[k] = resolve(v, undefined);
    });
    return out;
  }
  function setPath(obj, path, value) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]] || typeof o[parts[i]] !== 'object' || Array.isArray(o[parts[i]])) o[parts[i]] = {};
      o = o[parts[i]];
    }
    const last = parts[parts.length - 1], r = resolve(value, o[last]);
    if (r === undefined) delete o[last]; else o[last] = r;
  }
  const getField = (data, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);

  // ── Writes, listeners ───────────────────────────────────────
  const listeners = new Set();
  let notifyQueued = false;
  function changed() {
    persist();
    if (notifyQueued) return;
    notifyQueued = true;
    setTimeout(() => { notifyQueued = false; listeners.forEach(l => { try { l(); } catch (e) { console.warn(e); } }); }, 0);
  }
  const notFound = path => Object.assign(new Error('No document to update: ' + path), { code: 'not-found' });
  function writeSet(path, data, opts) {
    const cur = docs.get(path);
    docs.set(path, opts && opts.merge ? deepMerge(cur, data) : resolve(data, undefined));
  }
  function writeUpdate(path, data) {
    const cur = docs.get(path);
    if (!cur) throw notFound(path);
    const next = clone(cur);
    Object.keys(data).forEach(k => setPath(next, k, data[k]));
    docs.set(path, next);
  }
  const later = fn => new Promise((res, rej) => setTimeout(() => { try { res(fn()); } catch (e) { rej(e); } }, 0));

  // ── Snapshots, refs, queries ────────────────────────────────
  let idSeq = 0;
  const newId = () => 'demo' + Date.now().toString(36) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
  function docSnap(path) {
    const d = docs.get(path), id = path.split('/').pop();
    return { id, ref: docRef(path), exists: d !== undefined, data: () => clone(d) };
  }
  function docRef(path) {
    return {
      id: path.split('/').pop(), path,
      collection: p => query(path + '/' + p, []),
      get: () => later(() => docSnap(path)),
      set: (data, opts) => later(() => { writeSet(path, data, opts); changed(); }),
      update: data => later(() => { writeUpdate(path, data); changed(); }),
      delete: () => later(() => { docs.delete(path); changed(); }),
      onSnapshot: next => {
        let last;
        const fire = () => { const j = JSON.stringify(docs.get(path) ?? null); if (j !== last) { last = j; next(docSnap(path)); } };
        listeners.add(fire); setTimeout(fire, 0);
        return () => listeners.delete(fire);
      },
      _demoPath: path,
    };
  }
  function matches(data, [field, op, value]) {
    const v = getField(data, field);
    switch (op) {
      case '==': return same(v, value);
      case '!=': return !same(v, value);
      case 'array-contains': return Array.isArray(v) && v.some(x => same(x, value));
      case 'array-contains-any': return Array.isArray(v) && v.some(x => value.some(y => same(x, y)));
      case 'in': return value.some(y => same(v, y));
      case '<': return v < value; case '<=': return v <= value;
      case '>': return v > value; case '>=': return v >= value;
      default: return false;
    }
  }
  function query(coll, steps) {
    const run = () => {
      const depth = coll.split('/').length + 1;
      let list = [...docs.keys()].filter(p => p.startsWith(coll + '/') && p.split('/').length === depth).sort();
      steps.forEach(s => {
        if (s.where) list = list.filter(p => matches(docs.get(p), s.where));
        if (s.orderBy) {
          const [f, dir] = s.orderBy, sign = dir === 'desc' ? -1 : 1;
          list = list.slice().sort((a, b) => {
            const x = getField(docs.get(a), f), y = getField(docs.get(b), f);
            return (x === y ? 0 : x == null ? -1 : y == null ? 1 : x < y ? -1 : 1) * sign;
          });
        }
        if (s.limit) list = list.slice(0, s.limit);
      });
      const snaps = list.map(docSnap);
      return { docs: snaps, size: snaps.length, empty: !snaps.length, forEach: fn => snaps.forEach(fn) };
    };
    const more = s => query(coll, steps.concat([s]));
    return {
      id: coll.split('/').pop(), path: coll,
      doc: id => docRef(coll + '/' + (id === undefined ? newId() : id)),
      add: data => later(() => { const p = coll + '/' + newId(); writeSet(p, data); changed(); return docRef(p); }),
      where: (f, op, v) => more({ where: [f, op, v] }),
      orderBy: (f, dir) => more({ orderBy: [f, dir] }),
      limit: n => more({ limit: n }),
      get: () => later(run),
      onSnapshot: next => {
        let last;
        const fire = () => { const r = run(); const j = JSON.stringify(r.docs.map(d => [d.id, docs.get(d.ref.path)])); if (j !== last) { last = j; next(r); } };
        listeners.add(fire); setTimeout(fire, 0);
        return () => listeners.delete(fire);
      },
    };
  }
  const firestoreApi = {
    collection: p => query(p, []),
    doc: p => docRef(p),
    batch: () => {
      const ops = [];
      const w = {
        set: (r, d, o) => (ops.push(() => writeSet(r._demoPath, d, o)), w),
        update: (r, d) => (ops.push(() => writeUpdate(r._demoPath, d)), w),
        delete: r => (ops.push(() => docs.delete(r._demoPath)), w),
        commit: () => later(() => {
          const before = new Map(docs);
          try { ops.forEach(op => op()); } catch (e) { docs = before; throw e; }
          changed();
        }),
      };
      return w;
    },
  };

  // ── Auth: whoever "View as" picked, already past two-step sign-in ──
  const profileOf = uid => docs.get('profiles/' + uid);
  const demoUsers = () => [...docs.keys()].filter(p => /^profiles\/[^/]+$/.test(p)).map(p => ({ uid: p.split('/')[1], ...docs.get(p) }));
  let currentUid = ss(s => s.getItem(USER_KEY), null);
  if (currentUid === null) currentUid = window.DEMO_DEFAULT_UID || null;
  if (currentUid && !profileOf(currentUid)) currentUid = window.DEMO_DEFAULT_UID || null;
  function makeUser(uid) {
    const p = profileOf(uid);
    if (!p) return null;
    return {
      uid, email: p.email, emailVerified: true, displayName: (p.firstName || '') + ' ' + (p.lastName || ''),
      reload: () => Promise.resolve(),
      getIdToken: () => Promise.resolve('demo-token'),
      getIdTokenResult: () => Promise.resolve({ claims: { firebase: { sign_in_second_factor: 'phone' } }, authTime: new Date().toUTCString() }),
      sendEmailVerification: () => Promise.resolve(),
    };
  }
  const authListeners = new Set();
  function setUser(uid) {
    currentUid = uid;
    ss(s => (uid ? s.setItem(USER_KEY, uid) : s.setItem(USER_KEY, '')));
    setTimeout(() => authListeners.forEach(fn => fn(authApi.currentUser)), 0);
  }
  const demoError = (code, message) => Object.assign(new Error(message), { code });
  const authApi = {
    get currentUser() { return currentUid ? makeUser(currentUid) : null; },
    onAuthStateChanged: next => { authListeners.add(next); setTimeout(() => next(authApi.currentUser), 0); return () => authListeners.delete(next); },
    signInWithEmailAndPassword: email => later(() => {
      const u = demoUsers().find(x => String(x.email).toLowerCase() === String(email).trim().toLowerCase());
      if (!u) throw demoError('auth/invalid-credential', 'Demo: use one of the demo people in the "View as" list at the top.');
      setUser(u.uid);
      return { user: makeUser(u.uid) };
    }),
    createUserWithEmailAndPassword: () => Promise.reject(demoError('auth/operation-not-allowed', 'Sign-up is turned off in the demo. Pick someone in the "View as" list at the top.')),
    sendPasswordResetEmail: () => Promise.resolve(),
    signOut: () => { setUser(null); return Promise.resolve(); },
  };

  // ── Messaging and Cloud Functions: not in the demo ──────────
  const messagingApi = () => ({ getToken: () => Promise.reject(new Error('Not in the demo')), deleteToken: () => Promise.resolve(), onMessage: () => () => {} });
  messagingApi.isSupported = () => false;
  const functionsApi = () => ({
    httpsCallable: name => async () => {
      if (name === 'twoStepStatus') {
        return { data: { users: Object.fromEntries(demoUsers().map(u => [u.uid, { factors: ['phone'], lastSignIn: nowIso() }])) } };
      }
      return { data: { ok: true } };
    },
  });

  const firestoreFn = () => firestoreApi;
  firestoreFn.FieldValue = FieldValue;
  window.firebase = {
    SDK_VERSION: 'demo',
    initializeApp: () => ({ demo: true }),
    auth: () => authApi,
    firestore: firestoreFn,
    messaging: messagingApi,
    functions: functionsApi,
    modular: {
      app: null, db: null,
      get auth() { return { currentUser: authApi.currentUser }; },
      multiFactor: () => ({ enrolledFactors: [{ factorId: 'phone', displayName: 'Phone', uid: 'demo-factor' }], getSession: () => Promise.resolve({}), enroll: () => Promise.resolve() }),
      getMultiFactorResolver: () => null,
      PhoneAuthProvider: function () {}, PhoneMultiFactorGenerator: {}, TotpMultiFactorGenerator: {}, TotpSecret: {}, RecaptchaVerifier: function () {},
    },
  };

  // For the demo bar.
  window.DEMO = {
    users: () => demoUsers().map(u => {
      const a = docs.get('allowedUsers/' + String(u.email).toLowerCase()) || {};
      return { ...u, role: a.role || 'council', admin: !!a.admin };
    }),
    currentUid: () => currentUid,
    viewAs(uid) { if (saveTimer) flush(); ss(s => s.setItem(USER_KEY, uid || '')); location.reload(); },
    reset() { clearTimeout(saveTimer); saveTimer = null; ss(s => { s.removeItem(STORE_KEY); s.removeItem(USER_KEY); }); location.reload(); },
  };
})();
