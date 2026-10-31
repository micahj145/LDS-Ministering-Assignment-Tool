# Two-step sign-in, allowed list and roles: rollout

This turns on the security changes in two steps so nobody gets locked out:

- **Step 1** deploys the new app, Cloud Functions and the step-1 rules together. People still get in the old
  way, but the app makes each person set up a sign-in code the next time they open it. Notes move to
  their own collection automatically the first time you open the new version.
- **Step 2**, about a week later once everyone has set up their code, switches `firestore.rules` to the
  final checks: on the allowed list, signed in with a code, within 14 days, and roles enforced.

Nothing here deletes data. Do the steps in order.

---

## Before step 1: console setup (about 20 minutes)

### 1. Upgrade sign-in to Identity Platform
Firebase console → **Authentication** → **Settings** → **Upgrade to Identity Platform** (you may see this as a
banner). It's free for this many users; text messages are billed per message (about 1–2¢ each in the US).
You're already on Blaze, so no new billing setup.

### 2. Turn on texted codes (SMS multi-factor)
Authentication → **Settings** (or **Sign-in method**) → **Advanced** → **SMS Multi-factor Authentication**
→ Enable → Save.

### 3. Only allow US phone numbers
Authentication → **Settings** → **SMS region policy** → **Allow** → select **United States** → Save.
This blocks text-message fraud to expensive foreign numbers.

### 4. Turn on authenticator-app codes (TOTP)
There's no console switch for this. In the Google Cloud console for `pb1-ward-council-planning`, open
**Cloud Shell** (the `>_` icon, top right) and paste:

```bash
curl -s -X PATCH \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/pb1-ward-council-planning/config?updateMask=mfa" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "X-Goog-User-Project: pb1-ward-council-planning" \
  -H "Content-Type: application/json" \
  -d '{"mfa":{"state":"ENABLED","enabledProviders":["PHONE_SMS"],"providerConfigs":[{"state":"ENABLED","totpProviderConfig":{"adjacentIntervals":5}}]}}'
```

The reply should show `"state": "ENABLED"`, `"enabledProviders": ["PHONE_SMS"]` and the TOTP block. (The
`enabledProviders` part keeps texted codes on. Leaving it out would switch them off.) To check later:

```bash
curl -s "https://identitytoolkit.googleapis.com/admin/v2/projects/pb1-ward-council-planning/config" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "X-Goog-User-Project: pb1-ward-council-planning" | grep -A12 '"mfa"'
```

### 5. Check the authorized domain
Authentication → Settings → **Authorized domains**: `micahj145.github.io` must be listed (it already is).

### 6. Put yourself on the allowed list
Firestore Database → **Data** → **+ Start collection** → collection ID `allowedUsers` →
document ID **`micahj145@gmail.com`** (all lowercase), with these fields:

| Field | Type | Value |
|---|---|---|
| `email` | string | `micahj145@gmail.com` |
| `uid` | string | your user UID (Authentication → Users, copy the User UID) |
| `role` | string | `eq` |
| `admin` | boolean | `true` |

Everyone else gets added from the app's Admin tab (step 1, below).

### 7. Backups (point-in-time recovery + daily backups)
In Cloud Shell:

```bash
gcloud config set project pb1-ward-council-planning
gcloud firestore databases update --database='(default)' --enable-pitr
gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14d
```

PITR lets you read the database as it was at any minute in the last 7 days; daily backups are kept 14 days.
Restoring always goes into a **new** database, so it never overwrites the live one:
`gcloud firestore databases restore --source-backup=BACKUP_NAME --destination-database=restore-YYYYMMDD`
(list backups with `gcloud firestore backups list`).

### 8. $5 budget alert
Google Cloud console → **Billing** → **Budgets & alerts** → **Create budget** → scope: this project →
amount **$5** → alerts at 50%, 90%, 100% → email you. (A budget only warns; it doesn't stop charges.)

---

## Step 1: deploy

From the repo folder:

```bash
firebase deploy --only functions,firestore:rules
```

then commit and push the app (GitHub Pages republishes in about a minute).

Right after, **you** open the app first:

1. Sign in. You'll be asked to set up two-step sign-in. Choose **Use an authenticator app**, scan the QR code
   with Duo (or type the key), and enter the 6-digit code.
2. Notes move to their own collection automatically when you open the app. Nothing to click.
3. **Admin tab → All Users**: click **Add all N** in the yellow box. That puts everyone already approved on
   the allowed list with the roles you'd already given them.
4. **Admin tab → Check Roles Against Callings**: import LCR's *Members with Callings* PDF. Anyone whose role
   doesn't match their calling is flagged with a button to fix it. You also get a phone notification.
5. Send the ward council the heads-up text (below).

**Heads-up text for the council:**

> The ministering tool now asks for a 6-digit code when you sign in, to protect members' information. The
> next time you open it, it'll walk you through a one-time setup (about a minute): pick "Text the code to my
> phone" and enter your cell number. After that you'll only be asked for a code about once every two weeks
> on each device. If you get a new phone, let Micah know and he'll reset it.

## Step 2: final rules (after everyone has set up their code)

Check that everyone has signed in since step 1. Admin tab: nobody should show "not on the allowed list". Then
in `firestore.rules` change

```
function finalRules() { return false; }
```

to `return true;` and run:

```bash
firebase deploy --only firestore:rules
```

From then on, only people on the allowed list who signed in with a code in the last 14 days can read or
write anything, and roles are enforced by the database, not just the app.

## If something goes wrong

- **Someone lost or replaced their phone**: Admin tab → their row → **Reset two-step**. They set up a new code
  method at their next sign-in.
- **Someone can't get in after step 2**: check they're on the allowed list (Admin tab), then have them sign out
  and back in (their sign-in may be over 14 days old).
- **Undo step 2**: set `finalRules()` back to `false` and redeploy the rules.
- **Undo everything**: `git revert` the commit, push, and redeploy the old rules and functions
  (`git checkout <previous commit> -- firestore.rules functions/`, then `firebase deploy --only functions,firestore:rules`).
  Notes already moved stay in the notes collection; the old app wouldn't see them until moved back. Ask
  before doing this.

## App Check (later, monitor mode)
See the App Check section in `CLAUDE.md`: register a reCAPTCHA Enterprise key, put it in
`APP_CHECK_SITE_KEY`, and leave enforcement **off** (monitor only) until you decide otherwise.
