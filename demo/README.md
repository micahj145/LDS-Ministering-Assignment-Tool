# Demo: the tool with an invented ward

`demo.html` (repo root) is the real app, built from `ministering_tool.html`, with two changes:

- **No backend.** The Firebase SDK is replaced by `demo/fake-firebase.js`, which keeps everything in
  the browser tab. There is no Firebase project, sign-in service, push or Cloud Function behind it,
  and the page makes no request to any other site (`demo/check.js` checks this).
- **Invented data only.** `demo/demo-data.js` holds a made-up ward: 18 households and 33 people on
  fictional streets in "Sampleton", ZIP 00000; phone numbers in the 555-01xx range set aside for
  fiction; emails at example.com; notes that are tasks and follow-ups only. Nothing came from LCR.

It was built so the ward can show the Church's Data Privacy Office how the tool works without
showing any member's information.

## Using it

- Open `demo.html` in a browser: from GitHub Pages once it's on `main`, or straight from the file. It is
  self-contained (the demo scripts are inlined), so the one file can be emailed.
- **View as** (purple bar) switches between the demo leaders: EQ president and counselor, RS
  president and counselor, bishop, a ward council member, and an administrator. Each sees what
  that role sees in the real tool.
- Edits work as in the real tool and are kept in that browser tab (sessionStorage) until it closes.
  **Reset demo** puts the invented ward back.
- Not in the demo: phone notifications, real two-step sign-in (everyone is treated as already
  signed in with a second step), and geocoding new addresses (the demo households already have map
  positions). LCR PDF imports still read files in the browser, so don't import real LCR prints
  into the demo.

## Building and checking

```
node demo/build.js        # writes demo.html from ministering_tool.html
node demo/check.js        # headless Chromium; PW_CORE=/path/to/playwright if needed
```

Rebuild after any change to the app. If the app starts using a Firebase call that
`demo/fake-firebase.js` doesn't have, add it there (it mirrors `vendor/firebase-shim.src.js`).
