# Phone test script: two-step sign-in and roles

The automated tests run against Firebase's local emulators. These checks cover what they can't: real text
messages, Duo, real phones, and the live project. Do them after **step 1** is deployed (see
`SECURITY_ROLLOUT.md`), with one helper who has a council (non-presidency) account. About 20 minutes.

Tick each box. If anything fails, note what you saw, and don't move on to step 2.

## A. You (admin, authenticator app)
- [x] 1. On your phone, open the app. You're asked to **Set up two-step sign-in** (or you're signed in and then
      asked). Choose **Use an authenticator app**.
- [ ] 2. In Duo: **+** → **Use QR code** → scan. (Or **Enter key** and type the key shown.) The account shows
      as *Ward Ministering Tool*.
- [ ] 3. Enter Duo's 6-digit code → **Finish setup** → you're in the app (or asked to sign in once more with
      the code, which also counts).
- [ ] 4. Your notes are all still there. Spot-check a household, a Move In's next steps and a Covenant Path goal.
- [ ] 5. **Sign Out**, sign in again: after the password, it asks for the code from your authenticator app.
      Enter it → in.
- [ ] 6. Enter a wrong code once → "That code didn't work…" and you stay on the code screen.
- [ ] 7. Close the app completely and reopen → still signed in, no code asked.
- [ ] 8. Admin tab: **Add all** (allowed list) → the yellow box goes away; every approved person shows a role, and
      "two-step: …" shows who has set up a code (you: "app ✓").
- [ ] 9. Import *Members with Callings* → a ✓ line with counts; any mismatch shows a yellow flag with a fix
      button; your phone gets "N people's roles need your review." (if any were flagged).

## B. Helper (council member, texted code)
- [ ] 10. Helper opens the app → **Set up two-step sign-in** → **Text the code to my phone** → their number →
       **Text me a code**. A text arrives within a minute.
- [ ] 11. Enter it → **Finish setup** → in the app.
- [ ] 12. Sign out and in: password, then a texted code → in. **Text me a new code** sends another.
- [ ] 13. Helper **can**: add a note (with a tag) on a household; add a next step on a Move In; add/remove a
       person on Covenant Path Progress; follow a household; send you a message.
- [ ] 14. Helper **can't**: the Members tab has no **+ Add Member**; Households no **+ Add Household**; the
       Import buttons for Move Ins, Identifiers and Unit Statistics are gone; Move In status is read-only.
- [ ] 15. Helper tries to delete **your** note → "You can delete only notes you wrote."
- [ ] 16. You get the tag push from step 13 (if notifications are on).

## C. Presidency changes ask first
- [ ] 17. You (EQ): edit a household's address → a **Save these changes?** box shows the old address crossed
       out and the new one → **Cancel** → the old address is back.
- [ ] 18. Do it again → **Save these changes** → saved; Refresh shows it.
- [ ] 19. Toggling a pool (In Pool / Maybe / Out) or adding a note saves straight away, no box.
- [ ] 20. Draft assignments: reorder or edit → no box. Current assignments: no Add / Promote / Clear All, and tapping a
       card doesn't open an editor (Current changes only by importing from LCR).

## C2. Assignment planning (Nov 2026)
- [ ] C2a. Draft brothers: **Copy to Draft** → every card says *Same as Current*; the line above says "0 changed, 0 new".
- [ ] C2b. Edit one draft card (add a household) → it turns *Changed* with a **+ 🏠** chip; choose *Changes from Current
       first* → it's at the top and the ▲▼ buttons are gone; back to *Saved order* → ▲▼ return.
- [ ] C2c. **+ Add** → pick two brothers → **+ Add another companion** → pick a third → Save → the card shows all three
       and *New*. Edit it → the third picker is filled in. Same in the sisters' window.
- [ ] C2d. Households tab → **Map locations** card is there (and no longer on Draft brothers).
- [ ] C2e. Any import card (e.g. Covenant Path, after an import) → "Last imported <date> by <you>".
- [ ] C2f. Identifiers tab → a Birthdays name → jumps to that member on the Members tab.

## D. Lost phone
- [ ] 21. Admin tab → helper's row → **Reset two-step** → OK → "Done…".
- [ ] 22. Helper signs in with their password → asked to set up two-step sign-in again.

## E. After step 2 (final rules), repeat quickly
- [ ] 23. You and the helper can still open the app and see everything.
- [ ] 24. Helper's restricted controls are still refused (14–15).
- [ ] 25. (Optional) Admin tab → set the helper's role to EQ and back: their Add Member button appears after
       a Refresh, then disappears again.
