# Galactic Leaderboard \u2014 Cloudflare Worker backend

Backs the Speech Invaders leaderboard with two Cloudflare KV namespaces:

| Binding | Namespace | ID | Used for |
|---|---|---|---|
| `LEADERBOARD` | Galactic Leaderboard | `32466beddfb141b082bd9295f952e2be` | Scores, class/season filtering, question analytics |
| `Game_SI_KV` | Game_SI_KV | `aa5b3c89630447faa41747ed3c73197b` | Reserved for this game \u2014 not yet used by `worker.js` |

Scores are shared publicly across every device \u2014 no login required to read or
submit \u2014 while deleting entries requires an admin secret checked by the
Worker itself.

**Deployed Worker URL:** `https://galactic-leaderboard.tan-jianan-jeremy.workers.dev`
(already wired into `speech-invaders.html`'s `API_BASE` constant \u2014 no edit
needed unless you redeploy the Worker under a different subdomain or name).

## 1. Install Wrangler (if you don't have it already)

```
npm install -g wrangler
wrangler login
```

## 2. Deploy

From this folder:

```
wrangler deploy
```

This reads `wrangler.toml`, which already points at both KV namespace IDs
above. When it finishes, Wrangler prints your Worker's URL \u2014 it should
match the one listed above unless you're deploying to a different account
or renamed the Worker in `wrangler.toml`.

## 3. Set the admin secret

This is the passphrase that lets the "nebula-cipher-9" admin login in
the game actually delete entries. It must be set as a Worker **secret**
(not written into any file, so it's never in source control or visible in
the deployed code):

```
wrangler secret put ADMIN_SECRET
```

When prompted, enter exactly:

```
nebula-cipher-9
```

(This is the same value already hard-coded as `ADMIN_CALLSIGN` in the game's
HTML \u2014 typing it into the "Pilot callsign" field is what routes a player
into the Admin Console. The Worker then double-checks it on every delete
request, so even someone reading the game's source code can't delete scores
without also knowing this secret matches what's configured here.)

**Want a different / stronger passphrase?** Pick your own, then:
1. Run `wrangler secret put ADMIN_SECRET` again with the new value.
2. Update the `ADMIN_CALLSIGN` constant near the top of the game's
   `<script>` block (search for `ADMIN_CALLSIGN`) to match exactly.
Both sides must always match.

## 4. Point the game at your deployed Worker

`speech-invaders.html` already has `API_BASE` set to the URL above. Only
change this if you redeploy the Worker somewhere else \u2014 find this line near
the top of the `<script>` block:

```js
const API_BASE = "https://galactic-leaderboard.tan-jianan-jeremy.workers.dev";
```

and replace it with whatever URL Wrangler prints after `wrangler deploy`.

## 5. Host the HTML anywhere

The game is now a fully static file with no dependency on Claude.ai \u2014 host
it on GitHub Pages, Netlify, Cloudflare Pages, or anywhere else. Every
visitor, on any device, on any network, reads and writes the same public
leaderboard through your Worker.

## What's public vs. protected

| Action | Who can do it | Enforced where |
|---|---|---|
| View leaderboard | Anyone | \u2014 (public endpoint) |
| Submit a score | Anyone | \u2014 (public endpoint) |
| Delete one entry | Only someone who knows the admin secret | **Server-side**, in the Worker |
| Delete all entries | Only someone who knows the admin secret | **Server-side**, in the Worker |
| View question analytics | Anyone | \u2014 (public endpoint) |
| Log a question attempt | Anyone | \u2014 (public endpoint) |
| Reset question analytics | Only someone who knows the admin secret | **Server-side**, in the Worker |

Question analytics (the new "per-question error rate" table in the Admin
Console) only ever stores aggregate counts per question id \u2014 attempts,
misses, and which tense a question belongs to. It never stores player
names or answers, so it's fine for reads to be public the same way the
leaderboard is.

Because the check happens in the Worker rather than only in the page's
JavaScript, someone reading the HTML source can see the trigger phrase that
opens the Admin Console screen, but they still can't actually delete
anything unless they also know the secret configured with `wrangler secret
put` \u2014 which never appears in any file you host or share.

## Class codes and weekly seasons

Tell your class to log in as `Name@ClassCode` \u2014 e.g. `Maya@4E`. The game
splits that on the `@`: `Maya` is the callsign, `4E` is the class code.
Everything after the `@` gets uppercased and validated (letters, digits,
`-`, `_`, up to 20 characters). If a player types something invalid (a
space, a symbol, too long), the login screen blocks with an error and
asks them to fix it \u2014 the Worker also re-validates on its side and
silently drops anything malformed rather than rejecting the whole score,
as a second line of defense against a request sent straight to the API
instead of through the game's own login screen. Anyone who logs in
without an `@` still plays and appears on the Global leaderboard as
normal \u2014 they just won't show up under "My Class" for anyone.

Every score is also stamped with a **season** \u2014 an ISO week key like
`2026-W33` \u2014 computed by the Worker itself from its own clock (never the
player's), so it can't be spoofed and every player's "this week" agrees.
There's nothing to reset by hand: a new week's key is simply empty until
someone scores in it, and old weeks stay in the data for the "All-Time"
view. Class filtering, weekly filtering, and rank-on-game-over are all
computed **client-side** from the entries the Worker already returns \u2014
there's no separate ranking endpoint, so a class or a season is just
another filter over the same array.

## Notes / limits

- KV writes are eventually consistent and this isn't using locking, so two
  people submitting a high score in the exact same instant could very
  rarely clobber each other. Fine for a classroom leaderboard; not built
  for high-concurrency production use. The same applies to question
  analytics, which is also a single read-modify-write KV key \u2014 two students
  answering the exact same question in the same instant could very rarely
  clobber one another's count. Fine for classroom-scale reporting.
- The Worker keeps the top 100 scores only (oldest/lowest drop off).
- Pinned "Friends" callsigns live in each player's own browser
  (`localStorage`), not on the Worker \u2014 there's no server-side concept of
  friendship, just a per-device shortlist used to filter the same public
  leaderboard data. Clearing browser storage clears the pins.
- Cloudflare Workers' free tier includes a generous daily request
  allowance; a classroom leaderboard will stay comfortably inside it.

## Version history

- **v1.2** \u2014 Base game: 8 noir-themed grammar games, KV leaderboard, class
  codes, weekly seasons, admin console.
- **v1.3** \u2014 Added Spot the Error review mode, difficulty-scaled scoring
  (Novice/Veteran/Elite), Web Audio sound effects with a mute toggle,
  screen shake, particle bursts, animated hull damage, and shape/size-based
  (not just color-based) laser differentiation for accessibility.
- **v1.4** \u2014 Added adaptive difficulty (Veteran/Elite auto-drop a tier
  after two consecutive misses on the same grammar category), boss recap
  questions, two new sentence types (Reported Questions, Reported
  Commands), teacher-uploadable custom question sets via CSV, CSV export
  of session results, local (per-device) campaign persistence, per-boss
  Morse-code voice lines, and a streak/combo decay indicator.

Whole-class/projector mode (shared live session, teacher-controlled
pacing, server-side answer validation) is scoped but not yet built \u2014 it
needs a Durable Object-backed redesign of this Worker, which is a
separate project from the static-file updates above.
