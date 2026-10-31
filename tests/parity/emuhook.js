// Appended to the last compat SDK file served to the test browser (the app
// itself is unchanged). Points auth + firestore at the local emulators and
// swaps in a demo- project id, so nothing can reach the real project.
(function () {
  const f = window.firebase; if (!f || f.__emuHooked) return; f.__emuHooked = true;
  const init = f.initializeApp.bind(f);
  f.initializeApp = (cfg, name) => {
    const app = init({ ...cfg, projectId: 'demo-parity', apiKey: 'demo-key', authDomain: '127.0.0.1' }, name);
    f.auth().useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
    f.firestore().useEmulator('127.0.0.1', 8080);
    return app;
  };
})();
