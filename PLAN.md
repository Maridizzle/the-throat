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
| Images | Inside the node record. Capped per node (default 12 images, 8 MB), resized to JPEG in the browser. |
| Auth | One shared password (`APP_PASSWORD`) on the whole site. |
| Seeding | Load THE THROAT's text as nodes using the exact words, no rewriting. Maridizzle reviews the proposed split before anything is saved. Nodes start unplaced in time. |
| Removal | Hide and unhide only. Nothing is hard-deleted. |
| Backup pruning | Off by default. Opt in with `BACKUP_KEEP`. |
| Calm mode | Stops drift and pulses. Follows `prefers-reduced-motion`. |
| Quality | Low, Medium, High. |

## Build steps (stop after each for approval)

1. **Server.** Done and committed. Tested in JSON-file mode and against a real Postgres 16 (same checks, all pass).
2. **Client.** Violet look in WebGL, story-time helix, era bands, outer ring, scrub strip, node panel with image upload and gallery, History overlay. Built in small slices with screenshots.
3. **Seeding.** Split THE THROAT text into nodes, review with Maridizzle, then save.
4. **Deploy notes for Railway.** Maridizzle deploys.

## Server API (step 1)

- `GET /api/health` (open, no auth)
- `GET /api/state?since_seq=N`
- `PUT /api/nodes/:id` with `{data, base_rev}`; omit `base_rev` to create; 409 on stale
- `POST /api/nodes/:id/hide` and `/unhide` with `{base_rev}`
- `PUT /api/meta/:key` with `{data, base_rev}` (era bands and shared settings)
- `GET /api/backups`, `POST /api/backups`, `GET /api/backups/archive`, `GET /api/backups/:id`, `POST /api/backups/:id/restore`

Env vars: `APP_PASSWORD` (required), `DATABASE_URL` (Railway Postgres; absent means local JSON file), `BACKUP_KEEP` (optional), `MAX_IMAGES_PER_NODE`, `MAX_NODE_BYTES`, `DATA_DIR`, `PORT`.

## Still open

- Era names and where each seeded node sits in story time (Maridizzle decides).
- What the client shows when a save returns a conflict.
- Browser image resize dimensions (Saintalia uses JPEG quality 0.82; its dimensions were not read).
- Model IDs in the older tools (`claude-sonnet-4-6`, `claude-opus-5`) were not verified. Irrelevant until an AI proxy is added.
- The change counter (`seq`) is assigned when a write starts, not when it commits. Overlapping writes could be missed by a poller, so the client re-requests with a small overlap (rows carry a revision, so repeats are harmless).

## Research notes

Search summaries only, full papers not read. Source types are flagged.

- Collaborative concept mapping: Gnesdilow 2010 (university lab PDF, conference paper); Gao et al. review (Semantic Scholar listing, seen only via search summary); Science.gov topic page (.gov aggregator).
- 3D versus 2D graphs: Frontiers in Virtual Reality (peer reviewed); Alper et al. 2011 (UCSB); ACM VR navigation paper; arXiv 2307.10674 (preprint, results not retrieved). No single definitive desktop study found. Immersive VR shows the gains. Desktop 3D has occlusion and navigation costs, which is why the scrub strip and a 2D overview are planned (inference, not sourced fact).
- Sync: MIT Peritext paper (.edu) and an arXiv CRDT overview. Last-write-wins drops one edit; per-field or per-node merging avoids that.
- Worldbuilding tools: almost entirely vendor pages, blogs, forums and commercial roundups (weak evidence). Only scholarly lead: Hergenrader, *Collaborative Worldbuilding for Writers and Gamers* (WorldCat record; book not read).
