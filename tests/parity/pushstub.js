// Preloaded into the Functions emulator (NODE_OPTIONS=--require). Replaces
// FCM with a recorder: every push is written to __pushLog/{auto} so tests can
// see who would have been notified and with what text. Nothing leaves the box.
const Module = require('module');
const orig = Module._load;
Module._load = function (req, parent, isMain) {
  const real = orig.apply(this, arguments);
  if (req === 'firebase-admin/messaging') {
    return { ...real, getMessaging: () => ({
      sendEachForMulticast: async ({ tokens, data }) => {
        const { getFirestore } = orig.call(Module, 'firebase-admin/firestore', parent, false);
        await getFirestore().collection('__pushLog').add({ tokens, data, at: Date.now() });
        return { successCount: tokens.length, failureCount: 0, responses: tokens.map(() => ({ success: true })) };
      } }) };
  }
  return real;
};
