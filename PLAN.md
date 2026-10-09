# THE THROAT mindmap: plan

Owner: Maridizzle. Pushes and Railway deploys are done by Maridizzle or only with explicit typed approval.
Nothing in this file invents story content. Empty slots use TBD tokens.

## Decisions made

| Topic | Decision |
|---|---|
| Aesthetic | Deep violet light field: blackened plum, bruised violet, deep amethyst, indigo-violet. Low directional light, narrow subdued highlights, cool violet-black shadows. Warmth only as faint lift inside the violet range. Textures, glow, shadow, grain. |
| Look reference | `throat-mindmap-mockup.html` (approved: "Love it. Perfect."). Kept in the session scratchpad, not in this repo yet. |
| Structure | Hybrid of the Saintalia mindmap (`Saintalia/public`) and the memoir mindmap (`Saintalia/memoir`). |
| From memoir | Backups and History. |
| From Saintalia | Images stored in each node. |
| AI chat proxy | Not included to start. |
| 3D | Fly-through, WebGL (three.js, pinned version; memoir uses r128 from cdnjs). |
| Time axis | Story time, on a helix. |
| Time scale | Ordered beats with labeled era bands. Era names are `ERA_TBD_01` style tokens until named. |
| Timeless nodes | Outer drifting ring, linked by threads to the events they affect. |
| Scrub strip | A flat straightened timeline along the bottom to jump around the helix. |
| Node types | Character, Place, Rule, Thread, Open question, plus Faction, Lore and Chapter (added for seeding). Each has its own shape and a tint inside the violet range. Anything else shows as Untyped. |
| Sync | Per-node saves with a revision check. A stale save returns a conflict, never a silent overwrite. |
| Images | Inside the node record. Up to 12 per node. Resized in the browser to 900 px on the longest side, JPEG 0.82 (same as Saintalia), plus a 200 px thumbnail and an optional caption. Server accepts only JPEG data URIs with size limits. Saintalia's "paste a URL" mode and its `prompt` field were not carried over. |
| Conflicts | A stale save opens a side-by-side dialog (yours, theirs, and what each person changed). Fields only one person changed merge automatically. Fields both changed need an explicit choice. If both sides only added images, all images are kept. |
| Eras editor | Add, rename and reorder only. No delete. |
| Hidden list | Hide and unhide from the node panel and a Hidden list. |
| Hosting | Railway (Express and Postgres). Deployed from the GitHub repo by Maridizzle. |
| Database guard | `REQUIRE_DATABASE=1` makes the server refuse to start without `DATABASE_URL`, so a missing database cannot silently fall back to a file that Railway wipes on redeploy. |
| Auth | Two modes. With no `WRITER_*` variables the site uses the shared password (`APP_PASSWORD`, browser prompt). With them it uses a sign-in page, a signed cookie (30 days) and per-writer names and passwords from Railway variables, up to four writers, plus `SESSION_SECRET`. `APP_PASSWORD` stays as an emergency way in: the name `shared` on the sign-in page, or Basic Auth from tools. Failed sign-ins are rate limited (10 per 10 minutes per address and per name). |
| Writer identity | The server stamps who saved each node, setting, hide and restore (`updated_by`) and who made each backup (`created_by`). The browser cannot fake it. Names are whatever Maridizzle sets, never invented. |
| Presence | Other writers show as a ring and name tag in their own color on the node they are viewing, with "is editing", plus an online list and a ring on the timeline strip. Refreshes every 5 seconds and drops about 25 seconds after a tab closes. Hidden in shared-password mode. |
| Seeding | Done as an import, not a script. THE THROAT's text was split by section into 34 nodes using the exact words (checked word for word against the source). Only formatting was cleaned: invisible characters removed, hard line wraps re-joined, bullet glyphs turned into dashes. The seven character sheets were folded into the cast nodes (blank fields left out). Nodes start untimed and unlinked. The seed file is kept out of GitHub and loaded with the Import button (preview first, skips anything already there). |
| Removal | Hide and unhide only. Nothing is hard-deleted. |
| Backup pruning | Off by default. Opt in with `BACKUP_KEEP`. |
| Calm mode | Stops drift and pulses. Follows `prefers-reduced-motion`. |
| Quality | Low, Medium, High. |

## Build steps (stop after each for approval)

Order set by Maridizzle: put it on Railway first, then writer logins, then seed the data.

1. **Server.** Done. Tested in JSON-file mode and against a real Postgres 16, including an image-heavy node of about 8 MB.
2. **Client.** Done in slices:
   - 2a: violet WebGL scene, orbit and fly camera, layers, minimap, detail panel, quality and calm settings, polling sync.
   - 2b: story-time helix, era bands, outer ring, timeline strip.
   - 2c: node editor, side-by-side conflicts, hide and Hidden list, eras editor.
   - 2d: per-node images, lightbox, server image validation.
   - Import: the three new types and the Import button with a preview.
3. **Railway deploy.** Done by Maridizzle. Checklist below.
4. **Writer logins.** Built and tested (server L1, client L2), including two real browser sessions at once. Turning it on is a Railway variable change by Maridizzle (see the checklist, step 7).
5. **Seeding.** The seed file is built and the Import button is built and tested. Maridizzle imports it on the live site after this update is deployed, then places nodes in story time and adds links (story decisions for Maridizzle).
6. **History screen.** Not built yet: a list of backups with who made each one and a restore button. Backups, attribution and undoable restore already work through the API. Position in the order to be decided.

## Server API (step 1)

- `GET /api/health` (open, no auth)
- `GET /api/state?since_seq=N`
- `PUT /api/nodes/:id` with `{data, base_rev}`; omit `base_rev` to create; 409 on stale
- `POST /api/nodes/:id/hide` and `/unhide` with `{base_rev}`
- `PUT /api/meta/:key` with `{data, base_rev}` (era bands and shared settings)
- `GET /api/backups`, `POST /api/backups`, `GET /api/backups/archive`, `GET /api/backups/:id`, `POST /api/backups/:id/restore`
- `POST /api/login`, `POST /api/logout`, `GET /api/me` (writers mode)
- `GET /api/presence`, `POST /api/presence` with `{focus, editing}`

Env vars: `APP_PASSWORD` (required in shared-password mode, emergency way in otherwise), `WRITER_1_NAME` and `WRITER_1_PASSWORD` up to `WRITER_4_*` (passwords at least 10 characters, names unique, the name `shared` is reserved), `SESSION_SECRET` (at least 24 characters, required when writers are set; changing it signs everyone out), `DATABASE_URL` (Railway Postgres; absent means local JSON file), `REQUIRE_DATABASE` (set to 1 on Railway), `BACKUP_KEEP` (optional), `MAX_IMAGES_PER_NODE`, `MAX_IMAGE_BYTES`, `MAX_NODE_BYTES`, `DATA_DIR`, `PORT`.

The server refuses to start, with a clear message, on incomplete or weak writer settings.

## Railway deploy checklist

Vendor docs: docs.railway.com (Express guide, GitHub Autodeploys, PostgreSQL, Public Networking, Specs and Limits).

1. New project, Deploy from GitHub repo, `Maridizzle/the-throat`, branch `ccr-8ad10027-b9o6ze` (the repo's only branch). Railway runs `npm start`.
2. Add a PostgreSQL database to the same project.
3. Variables on the web service: `DATABASE_URL` as the reference `${{Postgres.DATABASE_URL}}` (the name before the dot must match the database service's name), `APP_PASSWORD` (chosen by Maridizzle, never pasted into chat or committed), `REQUIRE_DATABASE=1`.
4. Settings, Networking, Generate Domain.
5. Settings, Deploy, Healthcheck Path `/api/health`.
6. Check: logs show `DB ready.` and `THE THROAT running on`; sign in (any username, password is `APP_PASSWORD`); create a node; reload; redeploy and confirm it persists.

7. Turn on writer logins: add `WRITER_1_NAME`, `WRITER_1_PASSWORD`, `WRITER_2_NAME`, `WRITER_2_PASSWORD` and `SESSION_SECRET` (a long random string) as variables, keep `APP_PASSWORD`. Never paste these into chat or commit them. The logs should then say `Sign-in mode: writers (2 writer(s))`, and the site shows the sign-in page.

Railway redeploys on every push to the connected branch. Autodeploys can be paused in the service settings.

## Still open

- Era names and where each seeded node sits in story time (Maridizzle decides).
- Where the History screen goes in the order.
- Presence with three or four writers was not tested (two were). Sessions cannot be revoked one by one before they expire, only all at once by changing `SESSION_SECRET`.
- Types for a few seeded sections were best guesses and are easy to retype: How This Works, Where the Heat Lives, and both Propositions nodes.
- Railway request-size limits are not documented in the pages checked. About 8 MB was tested locally only, not through Railway.
- The first page load carries every node's images. Fine for dozens of images; with hundreds it would need lazy loading.
- Not tested: touch input and pinch zoom, a real GPU, phone-width editing with images, two real browsers editing at once, three.js loading from cdnjs on a real device.
- Model IDs in the older tools (`claude-sonnet-4-6`, `claude-opus-5`) were not verified. Irrelevant until an AI proxy is added.
- The change counter (`seq`) is assigned when a write starts, not when it commits. Overlapping writes could be missed by a poller, so the client re-requests with a small overlap (rows carry a revision, so repeats are harmless).

## Research notes

Search summaries only, full papers not read. Source types are flagged.

- Collaborative concept mapping: Gnesdilow 2010 (university lab PDF, conference paper); Gao et al. review (Semantic Scholar listing, seen only via search summary); Science.gov topic page (.gov aggregator).
- 3D versus 2D graphs: Frontiers in Virtual Reality (peer reviewed); Alper et al. 2011 (UCSB); ACM VR navigation paper; arXiv 2307.10674 (preprint, results not retrieved). No single definitive desktop study found. Immersive VR shows the gains. Desktop 3D has occlusion and navigation costs, which is why the scrub strip and a 2D overview are planned (inference, not sourced fact).
- Sync: MIT Peritext paper (.edu) and an arXiv CRDT overview. Last-write-wins drops one edit; per-field or per-node merging avoids that.
- Worldbuilding tools: almost entirely vendor pages, blogs, forums and commercial roundups (weak evidence). Only scholarly lead: Hergenrader, *Collaborative Worldbuilding for Writers and Gamers* (WorldCat record; book not read).
