// Firebase for the ministering tool: the modular SDK (v12.18.0), bundled into
// one classic script by vendor/build.sh → vendor/firebase-12.18.0.js.
//
// The app was written against the old "compat" SDK (firebase.auth(),
// db.collection('x').doc('y').get(), …). Rather than rewrite ~80 call sites,
// this file sets window.firebase to a small object with exactly the compat
// calls the app uses, each one passed straight to the modular SDK. The
// modular SDK is what makes TOTP (authenticator app) two-step sign-in
// possible; it is also under firebase.modular for code that needs more.
//
// Only what the app uses is here. If you add a Firebase call to the app that
// isn't below, add it here and rebuild.
import { initializeApp as _initializeApp } from 'firebase/app';
import * as A from 'firebase/auth';
import * as F from 'firebase/firestore';
import * as M from 'firebase/messaging';

let app = null, auth = null, db = null, messaging = null;

// Test hook: the parity suite (tests/parity) sets this before the page loads
// to point the app at the local emulators. Nothing sets it in normal use.
const EMU = typeof window !== 'undefined' ? window.__FIREBASE_EMULATORS__ : null;

// ── Auth ──────────────────────────────────────────────────────
// Compat's user object had methods (user.reload()); modular has functions
// (reload(user)). The wrapper reads through to the live modular user, so
// emailVerified etc. are current after reload(), as they were in compat.
function wrapUser(u) {
  if (!u) return null;
  return {
    get uid() { return u.uid; },
    get email() { return u.email; },
    get emailVerified() { return u.emailVerified; },
    get displayName() { return u.displayName; },
    reload: () => A.reload(u),
    getIdToken: force => A.getIdToken(u, force),
    getIdTokenResult: force => A.getIdTokenResult(u, force),
    sendEmailVerification: settings => A.sendEmailVerification(u, settings || null),
    _delegate: u,
  };
}
const wrapCred = c => ({ ...c, user: wrapUser(c.user) });

const authApi = {
  get currentUser() { return wrapUser(auth.currentUser); },
  onAuthStateChanged: (next, error) => A.onAuthStateChanged(auth, u => next(wrapUser(u)), error),
  signInWithEmailAndPassword: (e, p) => A.signInWithEmailAndPassword(auth, e, p).then(wrapCred),
  createUserWithEmailAndPassword: (e, p) => A.createUserWithEmailAndPassword(auth, e, p).then(wrapCred),
  sendPasswordResetEmail: (e, s) => A.sendPasswordResetEmail(auth, e, s),
  signOut: () => A.signOut(auth),
};

// ── Firestore ─────────────────────────────────────────────────
function wrapDocSnap(s) {
  return { id: s.id, ref: wrapDoc(s.ref), get exists() { return s.exists(); }, data: () => s.data(), _delegate: s };
}
function wrapQuerySnap(s) {
  const docs = s.docs.map(wrapDocSnap);
  return { docs, size: s.size, empty: s.empty, forEach: fn => docs.forEach(fn), _delegate: s };
}
function wrapDoc(ref) {
  return {
    id: ref.id, path: ref.path,
    collection: p => wrapQuery(F.collection(ref, p)),
    get: () => F.getDoc(ref).then(wrapDocSnap),
    set: (data, opts) => F.setDoc(ref, data, opts || {}),
    update: data => F.updateDoc(ref, data),
    delete: () => F.deleteDoc(ref),
    onSnapshot: (next, error) => F.onSnapshot(ref, s => next(wrapDocSnap(s)), error),
    _delegate: ref,
  };
}
// One wrapper for collections and queries; doc()/add() only make sense on a
// collection, which is all the app calls them on.
function wrapQuery(q) {
  return {
    get id() { return q.id; }, get path() { return q.path; },
    doc: id => wrapDoc(id === undefined ? F.doc(q) : F.doc(q, id)),
    add: data => F.addDoc(q, data).then(wrapDoc),
    where: (f, op, v) => wrapQuery(F.query(q, F.where(f, op, v))),
    orderBy: (f, dir) => wrapQuery(F.query(q, F.orderBy(f, dir))),
    limit: n => wrapQuery(F.query(q, F.limit(n))),
    get: () => F.getDocs(q).then(wrapQuerySnap),
    onSnapshot: (next, error) => F.onSnapshot(q, s => next(wrapQuerySnap(s)), error),
    _delegate: q,
  };
}
const ref = r => r._delegate;
const firestoreApi = {
  collection: p => wrapQuery(F.collection(db, p)),
  doc: p => wrapDoc(F.doc(db, p)),
  batch: () => {
    const b = F.writeBatch(db);
    const w = {
      set: (r, d, o) => (b.set(ref(r), d, o || {}), w),
      update: (r, d) => (b.update(ref(r), d), w),
      delete: r => (b.delete(ref(r)), w),
      commit: () => b.commit(),
    };
    return w;
  },
};
const FieldValue = {
  serverTimestamp: F.serverTimestamp,
  arrayUnion: F.arrayUnion,
  arrayRemove: F.arrayRemove,
  delete: F.deleteField,
  increment: F.increment,
};

// ── Messaging ─────────────────────────────────────────────────
// Same synchronous check compat used (modular's isSupported() is async).
function messagingSupported() {
  try {
    return typeof window !== 'undefined' && typeof indexedDB !== 'undefined' && navigator.cookieEnabled &&
      'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && 'fetch' in window &&
      ServiceWorkerRegistration.prototype.hasOwnProperty('showNotification') &&
      PushSubscription.prototype.hasOwnProperty('getKey');
  } catch (e) { return false; }
}
function messagingApi() {
  if (!messaging) messaging = M.getMessaging(app);
  return {
    getToken: opts => M.getToken(messaging, opts),
    deleteToken: () => M.deleteToken(messaging),
    onMessage: next => M.onMessage(messaging, next),
  };
}
messagingApi.isSupported = messagingSupported;

// ── window.firebase ───────────────────────────────────────────
function initializeApp(config) {
  if (app) return app;
  const cfg = EMU ? { ...config, projectId: EMU.projectId, apiKey: 'demo-key', authDomain: '127.0.0.1' } : config;
  app = _initializeApp(cfg);
  // Signed-in sessions are kept on the device (IndexedDB, falling back to
  // localStorage) — the same as the compat SDK did by default, under the same
  // storage key, so people stay signed in across this upgrade.
  auth = A.initializeAuth(app, { persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence] });
  db = F.getFirestore(app);
  if (EMU) {
    A.connectAuthEmulator(auth, EMU.auth, { disableWarnings: true });
    F.connectFirestoreEmulator(db, EMU.firestoreHost, EMU.firestorePort);
  }
  return app;
}
function needApp() { if (!app) throw new Error('firebase.initializeApp() first'); }
const authFn = () => (needApp(), authApi);
const firestoreFn = () => (needApp(), firestoreApi);
firestoreFn.FieldValue = FieldValue;

window.firebase = {
  SDK_VERSION: '12.18.0-modular',
  initializeApp,
  auth: authFn,
  firestore: firestoreFn,
  messaging: messagingApi,
  // Direct modular access for the two-step sign-in code. Listed one by one
  // (not the whole SDK) so the bundle only carries what's used.
  modular: {
    get app() { return app; }, get auth() { return auth; }, get db() { return db; },
    multiFactor: A.multiFactor, getMultiFactorResolver: A.getMultiFactorResolver,
    PhoneAuthProvider: A.PhoneAuthProvider, PhoneMultiFactorGenerator: A.PhoneMultiFactorGenerator,
    TotpMultiFactorGenerator: A.TotpMultiFactorGenerator, TotpSecret: A.TotpSecret, RecaptchaVerifier: A.RecaptchaVerifier,
  },
};
