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
| Node types | Character, Place, Rule, Thread, Open question. Shapes plus small hue shifts. |
| Sync | Per-node saves with a revision check. A stale save returns a conflict, never a silent overwrite. |
| Images | Inside the node record. Up to 12 per node. Resized in the browser to 900 px on the longest side, JPEG 0.82 (same as Saintalia), plus a 200 px thumbnail and an optional caption. Server accepts only JPEG data URIs with size limits. Saintalia's "paste a URL" mode and its `prompt` field were not carried over. |
| Conflicts | A stale save opens a side-by-side dialog (yours, theirs, and what each person changed). Fields only one person changed merge automatically. Fields both changed need an explicit choice. If both sides only added images, all images are kept. |
| Eras editor | Add, rename and reorder only. No delete. |
| Hidden list | Hide and unhide from the node panel and a Hidden list. |
| Hosting | Railway (Express and Postgres). Deployed from the GitHub repo by Maridizzle. |
| Database guard | `REQUIRE_DATABASE=1` makes the server refuse to start without `DATABASE_URL`, so a missing database cannot silently fall back to a file that Railway wipes on redeploy. |
| Auth | One shared password (`APP_PASSWORD`) on the whole site, for now. Writer logins come next (design to be decided). |
| Seeding | Load THE THROAT's text as nodes using the exact words, no rewriting. Maridizzle reviews the proposed split before anything is saved. Nodes start unplaced in time. |
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
   - **Not built yet:** the History screen (list of backups with a restore button; restore currently works only through the API) and writer presence rings.
3. **Railway deploy.** Next. Checklist below. Maridizzle deploys.
4. **Writer logins.** After the deploy. Design to be decided (separate logins, or a name per browser). Also enables presence rings and "last edited by".
5. **Seeding.** After that. Split THE THROAT text into nodes using the exact words, review with Maridizzle, then save. Split style (by section, paragraph, or character and place) to be decided.
6. **History screen.** Position in the order to be decided.

## Server API (step 1)

- `GET /api/health` (open, no auth)
- `GET /api/state?since_seq=N`
- `PUT /api/nodes/:id` with `{data, base_rev}`; omit `base_rev` to create; 409 on stale
- `POST /api/nodes/:id/hide` and `/unhide` with `{base_rev}`
- `PUT /api/meta/:key` with `{data, base_rev}` (era bands and shared settings)
- `GET /api/backups`, `POST /api/backups`, `GET /api/backups/archive`, `GET /api/backups/:id`, `POST /api/backups/:id/restore`

Env vars: `APP_PASSWORD` (required), `DATABASE_URL` (Railway Postgres; absent means local JSON file), `REQUIRE_DATABASE` (set to 1 on Railway), `BACKUP_KEEP` (optional), `MAX_IMAGES_PER_NODE`, `MAX_IMAGE_BYTES`, `MAX_NODE_BYTES`, `DATA_DIR`, `PORT`.

## Railway deploy checklist

Vendor docs: docs.railway.com (Express guide, GitHub Autodeploys, PostgreSQL, Public Networking, Specs and Limits).

1. New project, Deploy from GitHub repo, `Maridizzle/the-throat`, branch `ccr-8ad10027-b9o6ze` (the repo's only branch). Railway runs `npm start`.
2. Add a PostgreSQL database to the same project.
3. Variables on the web service: `DATABASE_URL` as the reference `${{Postgres.DATABASE_URL}}` (the name before the dot must match the database service's name), `APP_PASSWORD` (chosen by Maridizzle, never pasted into chat or committed), `REQUIRE_DATABASE=1`.
4. Settings, Networking, Generate Domain.
5. Settings, Deploy, Healthcheck Path `/api/health`.
6. Check: logs show `DB ready.` and `THE THROAT running on`; sign in (any username, password is `APP_PASSWORD`); create a node; reload; redeploy and confirm it persists.

Railway redeploys on every push to the connected branch. Autodeploys can be paused in the service settings.

## Still open

- Era names and where each seeded node sits in story time (Maridizzle decides).
- Writer identity design, and where the History screen goes in the order.
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
