# Phone notifications — one-time setup

This turns on real phone notifications for tags ("Jane tagged you on a next step"), and tells
admins when someone signs up and is waiting for approval. The app
code is already in the repo; what's left has to be done by you, signed in to the Google
account that owns the Firebase project `pb1-ward-council-planning`.

How it works: every save of the ward data runs a small Cloud Function (`functions/`). It
spots tags that weren't there before and sends those people's devices a notification through
Firebase Cloud Messaging. The notification only says who tagged you — never member names or
note text — and tapping it opens the Notifications tab.

## What it costs

On the Blaze plan you pay only past the free allowances
([Firebase pricing](https://firebase.google.com/pricing)):

| Item | Free each month | This app's use |
|---|---|---|
| Cloud Functions invocations | 2 million | one per save — a few hundred to a few thousand |
| Functions compute | 400K GB-s / 200K CPU-s | well under 1% |
| Cloud Messaging | always free | — |
| Container storage (Artifact Registry) | 500 MB | kept small by the cleanup policy in step 5 |

Expect $0. The budget alert in step 1 tells you if that ever changes.

---

## 1. Upgrade the project to Blaze and set a budget alert

1. Go to <https://console.firebase.google.com> and open **pb1-ward-council-planning**.
2. At the bottom of the left sidebar, click the plan name (**Spark**) or **Upgrade**, choose
   **Blaze**, and pick or create a Cloud Billing account (this is where the card goes).
3. When it offers a **budget alert**, set one — **$5** is plenty. If it doesn't offer:
   <https://console.cloud.google.com/billing> → your billing account → **Budgets & alerts** →
   **Create budget** → scope it to project `pb1-ward-council-planning` → amount **$5** →
   keep the 50% / 90% / 100% thresholds → **Finish**.

A budget alert only emails you; it doesn't stop spending. At this app's usage that's the
normal setup.

## 2. Create the Web Push key and put it in the app

1. Firebase console → ⚙️ **Project settings** → **Cloud Messaging** tab.
2. Under **Web configuration** → **Web Push certificates**, click **Generate key pair**.
3. Copy the long key it shows (the *public* key — safe to publish).
4. In `ministering_tool.html`, find `const VAPID_PUBLIC_KEY = '';` and paste it between the
   quotes. (Or send it to Claude to do.) Until this is filled in, the "Turn on" button stays
   hidden.

## 3. Install Node.js and the Firebase CLI (Windows, once)

1. Install **Node.js 22 LTS** from <https://nodejs.org> (default options).
2. Open a **new** PowerShell window and run:
   ```
   node -v
   npm install -g firebase-tools
   firebase --version
   firebase login
   ```
   `firebase --version` should be 14 or newer. `firebase login` opens a browser — sign in with
   the account that owns the project.
   - If PowerShell says *running scripts is disabled on this system*, run
     `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, answer **Y**, and try again.

## 4. Check where the database lives

Firebase console → **Firestore Database**. The location is shown near the top (or under the
database's settings), e.g. **nam5 (us-central)**. The function is set to run in
`us-central1`, which suits `nam5`. If yours is somewhere else, tell Claude the location before
deploying so the region in `functions/index.js` can be changed to match.

## 5. Deploy the function

```
cd "C:\Users\micah\Church Service\Ministering_Tool\functions"
npm install
npm test
cd ..
firebase deploy --only functions
```

- `npm test` should report **6 pass, 0 fail**.
- The first deploy turns on the Google Cloud services the function needs (Cloud Functions,
  Cloud Build, Artifact Registry, Eventarc, Cloud Run) and can take several minutes. If it
  stops with a permissions or "service agent" error, wait 5 minutes and run the same
  `firebase deploy --only functions` again — first-time setup can lag behind.
- If it asks about a **cleanup policy** for container images, answer **yes**. If it didn't ask,
  run `firebase functions:artifacts:setpolicy` once (keeps only the last day's images, so
  storage stays inside the free 500 MB).
- Success ends with `Deploy complete!` and lists `notifyTagged`, `notifyFollowers` and
  `notifyAccessRequest` (all `us-central1`).

## 6. Publish the app changes

```
git add ministering_tool.html
git commit -m "Add Web Push key"
git push
```

## 7. Turn it on and test

1. On your phone, open the installed app (on iPhone it **must** be the Home Screen app) →
   **Notifications** → **Turn on** → allow notifications.
2. Have someone else tag you on any note (tagging yourself never notifies you), or use a second
   test account.
3. Close the app. The notification should arrive within a few seconds; tapping it opens
   **Notifications**. With the app open, a banner appears instead.
4. To see what the function did: Firebase console → **Functions** → `notifyTagged` → **Logs**.
   Each send logs `notifyTagged` with how many devices it reached.

## Later

- Each person turns notifications on **per device** from the Notifications tab, and can turn
  them off there too.
- The functions only need redeploying (`firebase deploy --only functions`) when `functions/`
  changes. App changes still go out with a normal `git push`.
- Admins get "New access request: <name>." on any device where they've turned notifications on;
  tapping it opens the Admin tab. The Admin tab button also shows how many requests are waiting.

## Email verification — publish the rules change (once)

The app asks everyone to confirm their email before showing ward data. The real enforcement is
in `firestore.rules`, which has to be published by hand:

0. Firebase console → **Authentication** → **Settings** → **Authorized domains**: make sure
   `micahj145.github.io` is listed (add it if not). Without it Firebase won't send verification
   emails at all.
1. Push the app first and confirm it works — you'll be asked to verify your own email the first
   time you open it (check spam if the email doesn't arrive).
2. Firebase console → **Firestore Database** → **Rules**.
3. Replace everything there with the contents of `firestore.rules` from the repo and click
   **Publish**.

Anyone who hasn't verified yet just sees the "Check Your Email" screen until they do. If you
publish the rules before pushing the app, people still on the old version get load errors
until they reload.
