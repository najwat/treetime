# Proposal: syncing saved trees across devices

Not built. TreeTime has no accounts and no backend; saved trees live in the browser that saved
them. This is what adding sync would take, so the decision can be made with the costs in view.

## What would be synced

Only the saved list: for each tree its id, a small snapshot (name, species, size, location), the
nickname, and when it was saved. A heavy user has perhaps 200 trees, about 60 KB. No tree data
from the city is stored.

Whatever the option, three rules follow from "relationships with trees, not ownership":

- The saved list is private to its owner. No public profiles, no counts of who saved what.
- Sync is optional. The app works exactly as now without signing in.
- Deleting the account deletes the data, and the app says so.

Merging is simple because records are keyed by tree id: take the union, and for a tree on both
sides keep the most recently edited nickname. Removals need a small "removed at" marker so a
deleted tree does not come back from another device.

## Options

| | Supabase | Firebase | Cloudflare Worker + KV |
| --- | --- | --- | --- |
| What it is | Hosted Postgres with sign-in and row-level security | Google's hosted document store with sign-in | A small function you write, with a key-value store |
| Sign-in | Email link, or Google/Apple | Email link, or Google/Apple | None built in. Either a sync code (below) or you build sign-in yourself |
| Cost at TreeTime's size | Free tier (50,000 monthly users, 500 MB). Free projects pause after a week without traffic | Free tier (50,000 reads and 20,000 writes a day) | Free tier (100,000 requests a day, 1,000 KV writes a day) |
| Privacy | Stores an email address per user. Data region is your choice. Open source, can be moved | Stores an email address per user. Google is the processor | With a sync code, **no personal data at all** |
| Client size | About 50 KB library, or plain `fetch` | About 80–100 KB library | None: plain `fetch` |
| Work | Small: one table, one policy, a sign-in screen, merge code | Small: one collection, rules, a sign-in screen, merge code | Small to medium: about 100 lines of Worker, merge code, a "sync code" screen |
| Stays a static site | Yes | Yes | Yes |
| Main risk | Free project pausing; a privacy notice becomes necessary | Lock-in; a privacy notice becomes necessary | A lost code cannot be recovered; you maintain the Worker |

### The sync-code idea (Cloudflare option)

No accounts. "Sync this device" makes a long random code, shown as text and a QR code. The saved
list is encrypted in the browser with a key derived from the code and stored under a hash of it.
A second device enters or scans the code and gets the same list. The server holds only blobs it
cannot read. There is no email, no password and nothing to leak. The cost is that a lost code
means a lost link (the trees are still on each device).

## Recommendation

**Do export and import first** (already on the next-run list). A file the user keeps covers
backup and moving to a new phone with no backend, and the merge code written for it is the same
merge that sync needs.

If sync is still wanted after that, **use the Cloudflare Worker with sync codes.** It is the only
option that keeps TreeTime free of personal data, it fits the product's principle, and it needs no
privacy policy beyond one sentence. Choose **Supabase** instead only if signing in with an email
is itself wanted (for example, to recover a list after losing every device). Firebase does the
same job as Supabase with more lock-in and a heavier client, and has no advantage here.

## What it would take (Cloudflare option)

1. A Worker with two routes, `GET` and `PUT /list/<id>`, a size limit, and a rate limit.
2. In the app: encrypt and decrypt with Web Crypto, merge, and sync on open and after a change.
3. A small "Sync" section in the Saved tab: make a code, enter a code, stop syncing.
4. Tests for the merge (already needed for import).
5. A sentence in About.

Roughly two to three days of work, and a Cloudflare account that Najwat owns.
