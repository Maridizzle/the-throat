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
| Time axis | Story time runs left to right along the X axis (changed from a vertical helix). Each node type has its own glowing leyline, a gently weaving stream, and timed nodes sit on their type's stream in story order. Links between timed nodes arch over the flow. |
| Time scale | Ordered beats with labeled eras, drawn as soft glowing pools along the flow with faint boundaries and the era name floating above. Era names are `ERA_TBD_01` style tokens until named. |
| Timeless nodes | A drifting cloud that orbits the whole flow, linked by threads to the events they affect. |
| Scrub strip | A flat straightened timeline along the bottom to jump along the flow. |
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
| Layers lists | Each layer row has an arrow that lists every node in that layer, alphabetically. Clicking a name selects it and flies to it; the selected one is highlighted. Lists stay open across refreshes and update by themselves. A node in a layer that is switched off is selected without turning the layer on. On phones the arrow opens a pop-up. |
| Export | A read-only Export menu with two downloads, both made from what is already loaded, with nothing written to the server. Readable copy (`.md`): one file, a section per layer, every node's text word for word, story time, links both ways, who changed it last, hidden nodes in their own marked section, images listed by count and caption but not included. It is not a restore point. Full backup (`.json`): the server's archive, with images and every automatic backup; this is the one to restore from. |
| Live data care | The site now holds the real story. Backups live in the same database as the story, so a copy saved on the writer's own computer (Export) is the only protection that does not depend on Railway. All testing uses throwaway local data, never the live database. Nothing is pushed without Maridizzle's typed yes. |
| Removal | Hide and unhide only. Nothing is hard-deleted. |
| Backup pruning | Off by default. Opt in with `BACKUP_KEEP`. |
| Hover names | Desktop mouse only. A node's name fades in as the pointer comes within 80 px of its edge and fades out as it leaves. Several can show at once, each fading by its own distance. Touch is unchanged. |
| Camera | Starts looking at the flow from the front. A soft sway of about 7 degrees each way replaces the old full spin, and manual orbiting is kept. Calm mode stops it. |
| Overview map | A wide 200 by 100 strip sized for the long flow, hidden on phones. Time runs left to right, with a faint leyline per type, era ticks, the untimed cloud, and the camera marker. A Top / Side button switches between looking down (width of the cloud) and looking from the front (weave of the streams). The choice is not remembered after a reload. Tested on throwaway data at 1280 px wide; not tested between about 1000 and 1200 px or with hundreds of nodes. |
| AI (in progress) | A chat that parses incoming text, proposes new nodes, patches existing nodes without overwriting them, and runs four analyses (story synthesis, character synthesis and analysis, conflict analysis between selected nodes, arc analysis). Two modes: Groq (default, cheapest) and OpenAI (costs money, manual only, with a cost estimate the writer must confirm). The AI never writes by itself: every change is a proposal with a before and after view, applied through the normal conflict-safe save with a safety backup first, so History can undo it. Only selected nodes are sent, or the whole map after a prompt. A warn-only check flags likely explicit passages before sending, and the writer chooses to send, mask or skip. |
| AI keys and caps | Keys live only in Railway variables, never in the browser or the repo. Server-side monthly caps: Groq $5, OpenAI $10 (both set by Maridizzle). Per-writer rate limits. A usage log stores counts and cost only, never prompts or replies. |
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
   - Layers lists: the node list under each layer.
   - Export: the readable copy (`.md`) and the full backup (`.json`) buttons.
   - Hover names and the left-to-right flow with type leylines (display only, no data or server changes). Tested on throwaway data: strictly left to right order, six streams, strip seek, Reset view, node select, phone width. Not tested: a real GPU, hundreds of nodes, many timed nodes of one type (names about 52 units apart).
3. **Railway deploy.** Done by Maridizzle. Checklist below.
4. **Writer logins.** Built and tested (server L1, client L2), including two real browser sessions at once. Turning it on is a Railway variable change by Maridizzle (see the checklist, step 7).
5. **Seeding.** Done. The 34 sections were imported on the live site (Maridizzle confirmed it worked). What remains is Maridizzle's: placing nodes in story time, adding links, and retyping any seeded node whose type was a best guess.
6. **History screen.** Built and tested on throwaway local data. A History button opens a list of every backup, newest first (when, why, who, node count), with Back up now. Preview compares a backup with the site right now (identical, changed, created since, eras) with a per-node differences view. Restore this version restores one node: a safety backup first, then the normal conflict-safe save. Restore the whole map needs the typed word RESTORE, first saves a "Before a restore" backup (the undo point), and hides nodes made since, never erasing them. Both restores refuse while a node editor is open, and the whole-map restore refuses if the map changed while the preview was open. Tested: list, Back up now, preview counts, markup shown as text, wrong and right typed word, node restore, whole-map restore, undo through the "Before a restore" backup, phone width, no page errors. Not tested: the changed-while-reading guard, the open-editor guard, the signed-out (401) message, writers mode with real sign-ins, Postgres.

7. **AI.** Stage 1 (server gateway) and stage 2 (chat panel) built and tested against local mock providers only, no real calls. Stage 2: a Chat button opens a docked panel (full-width sheet on phones). A context tray holds the nodes the AI may see (Add selected node, Add to chat from the node panel, or Add whole map after a size confirm). Mode switch Groq (cheapest, default) or OpenAI (costs money); OpenAI always shows the worst-case cost and month-to-date spend and needs a Confirm; every Groq reply has "Retry with OpenAI". A rough local word check runs in the browser before sending and only warns: Send anyway, Mask those passages, Leave those nodes out, or Cancel. Chats are not saved anywhere and vanish on reload. The chat cannot change the map. Tested: panel, status, tray, size line, reply, request contents, explicit dialog (cancel, mask, leave out), OpenAI cost dialog (cancel, confirm), retry, whole map, markup as text, provider error with no key leak, no-keys message. Not tested: a real provider call, phone layout beyond a screenshot, many nodes at once. While the chat is open on a 1280 px screen it covers the right end of the bottom bar; close it with the X. Stage 3 (proposals) and stage 4 (analyses) are also built, tested against local mock providers only.

   Stage 3: a separate Propose changes button turns pasted text plus the tray into proposals in a review window. Two kinds: new nodes, and add-only patches to nodes in the tray (append to the summary, add links, fill story time only when empty). The AI can never rewrite, remove, rename, retype, hide or delete, and can never create eras. Every proposal quotes the writer's text and the quote is checked; proposals whose quote is not found are flagged red and start unticked. Applying makes a safety backup first (aborts if that fails), creates new nodes, then merges each patch onto the node's current version, retrying on the other writer's newest version after a conflict and never overwriting. History can undo it. Tested: garbage reply, grounded and ungrounded proposals, out-of-tray and duplicate entries rejected, a concurrent edit between propose and apply kept alongside the addition, links to new nodes, safety backup, markup as text, OpenAI retry cost dialog. Not tested: a real AI reply, a failing safety backup, a signed-out apply, a second conflict after the retry, phone layout.

   Stage 4: an Analyze row in the chat with Story, Characters, Conflict and Arc. Reports are structured: each finding is labeled Stated in the text, Inference or Not in the text, names its nodes and quotes the text; quotes are checked and unfound ones flagged red. Suggestions come as questions for the writer. A report can be downloaded as a .md file (made in the browser, nothing goes to the server) and is not saved anywhere else. Conflict needs two or more tray nodes. Story, Arc and Characters offer the whole map or all characters when the tray is empty, after a size confirm. Arc sends nodes in story order with untimed nodes last, and warns when fewer than 3 nodes have story time. Too large for one request is refused with a clear message (no automatic chunking). Tested: all of the above plus the OpenAI retry, a garbage reply, and the .md download. Not tested: a real AI reply, phone layout, very large reports.

## Server API (step 1)

- `GET /api/health` (open, no auth)
- `GET /api/state?since_seq=N`
- `PUT /api/nodes/:id` with `{data, base_rev}`; omit `base_rev` to create; 409 on stale
- `POST /api/nodes/:id/hide` and `/unhide` with `{base_rev}`
- `PUT /api/meta/:key` with `{data, base_rev}` (era bands and shared settings)
- `GET /api/backups`, `POST /api/backups`, `GET /api/backups/archive`, `GET /api/backups/:id`, `POST /api/backups/:id/restore`
- `POST /api/login`, `POST /api/logout`, `GET /api/me` (writers mode)
- `GET /api/presence`, `POST /api/presence` with `{focus, editing}`
- `GET /api/ai/status`, `GET /api/ai/usage`, `POST /api/ai/estimate`, `POST /api/ai/chat` with `{mode: groq|openai, messages, json, tier, max_output_tokens, purpose, confirm_cost}` (OpenAI needs `confirm_cost` at or above the estimate, else 412; past a cap is 402; rate limited is 429)

Env vars: `APP_PASSWORD` (required in shared-password mode, emergency way in otherwise), `WRITER_1_NAME` and `WRITER_1_PASSWORD` up to `WRITER_4_*` (passwords at least 10 characters, names unique, the name `shared` is reserved), `SESSION_SECRET` (at least 24 characters, required when writers are set; changing it signs everyone out), `DATABASE_URL` (Railway Postgres; absent means local JSON file), `REQUIRE_DATABASE` (set to 1 on Railway), `BACKUP_KEEP` (optional), `MAX_IMAGES_PER_NODE`, `MAX_IMAGE_BYTES`, `MAX_NODE_BYTES`, `DATA_DIR`, `PORT`.

AI variables: `GROQ_API_KEY` and `OPENAI_API_KEY` (never paste into chat or commit). Optional: `GROQ_MODEL` (default `openai/gpt-oss-20b`), `OPENAI_MODEL` (default `gpt-6-luna`), `OPENAI_MODEL_ACCURATE` (unset means the same as `OPENAI_MODEL`), `GROQ_PRICE_IN` and `GROQ_PRICE_OUT`, `OPENAI_PRICE_IN` and `OPENAI_PRICE_OUT`, `OPENAI_ACCURATE_PRICE_IN` and `OPENAI_ACCURATE_PRICE_OUT` (USD per 1M tokens, needed only for a model not in the built-in table), `AI_BUDGET_GROQ` (default 5), `AI_BUDGET_OPENAI` (default 10), `AI_RATE_GROQ` (default 40 per 10 minutes per writer), `AI_RATE_OPENAI` (default 10), `AI_MAX_INPUT_CHARS` (default 400000), `AI_MAX_OUTPUT_TOKENS` (default 8000), `AI_TIMEOUT_MS`, `GROQ_BASE_URL`, `OPENAI_BASE_URL`.

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
- Presence with three or four writers was not tested (two were). Sessions cannot be revoked one by one before they expire, only all at once by changing `SESSION_SECRET`.
- Types for a few seeded sections were best guesses and are easy to retype: How This Works, Where the Heat Lives, and both Propositions nodes.
- Railway request-size limits are not documented in the pages checked. About 8 MB was tested locally only, not through Railway.
- The first page load carries every node's images. Fine for dozens of images; with hundreds it would need lazy loading.
- Not tested: touch input and pinch zoom, a real GPU, phone-width editing with images, two real browsers editing at once, three.js loading from cdnjs on a real device.
- AI, not verified: the real request and reply shapes. Groq's own docs could not be read from the build sandbox, and OpenAI's shape for the GPT-6 models was read through a summarizer. The Groq call uses the common OpenAI-compatible chat format; the OpenAI call uses the Responses API with `store: false`. The first real call should be one small test, approved by Maridizzle, costing a fraction of a cent. Also unverified: whether Groq bills in arrears (check the Billing page in the Groq console), whether `gpt-oss-20b` follows JSON mode well, Groq's data policy, and the 3 characters per token cost estimate against real use.
- AI, first real call finding: Groq answered HTTP 400 `json_validate_failed` ("Failed to validate JSON", empty `failed_generation`) when strict JSON mode was requested on `openai/gpt-oss-20b` (seen in the Railway logs by Maridizzle on 2026-10-09, twice). Fix built and tested against the mock only: on that error the server retries once without strict JSON mode (Groq only, failed attempt logged at $0), extracts the first complete JSON object from a reply that has other words around it, and the error box now shows the provider's short message with the key removed. Not yet verified against the real service: whether `gpt-oss-20b` then returns valid JSON. If it does not, set `GROQ_MODEL=openai/gpt-oss-120b` in Railway (no code change).
- AI, second real finding: a Character analysis on OpenAI (charged about $0.0021) came back but could not be read ("not in the expected format"). Cause not yet confirmed; one possibility is that the reply was cut off at the 4,000 token allowance. Built in response, tested against the mock only: the gateway now reports `truncated` (Groq `finish_reason` length, OpenAI incomplete for max_output_tokens, or a reply that used about 98 percent of its allowance), the chat message says when a reply was cut off, an unreadable reply now shows a collapsed "What the AI actually said" section with the first 1,500 characters as plain text, analyses may use up to 8,000 output tokens (proposals stay at 4,000), and the analysis prompt asks for one or two sentences per finding. To check a past call, a signed-in writer can open `/api/ai/usage` (counts only, no prompts) and read `output_tokens`.
- AI chat redesign (Maridizzle: "the chat cannot see or edit that map, that makes it useless"). Replaced the tray-and-Propose-button chat. Decisions: map awareness by an index of every node plus the full text of the nodes a question needs; edits as proposal cards inside the AI's reply, approved by the writer; edit powers are add (append, links, story time when empty) plus replace exact passages with per-edit approval. How it works: every message sends an index of all nodes (id, type, name, story time, links, a short snippet). If all nodes together are under about 30,000 characters their full text is sent too; otherwise a small pick call first chooses which nodes' full text to read (up to 12), and the node the writer has selected and any pinned nodes are always sent in full. Replies are JSON with a reply and proposals; if the model does not keep to JSON its plain text is shown. A replacement shows the old text struck through, always starts unticked, and applies only if that exact passage is still in the node exactly once. The AI still cannot rename, retype, hide or delete, and every proposal needs a quote that is checked. The explicit-passage check now covers every node, and the writer's choice is remembered for those passages until Clear chat. OpenAI shows one cost confirmation for the whole exchange (pick call plus answer). Tested against the mock only: whole-map index with nothing pinned, pick call only for a big map, selected node always in full, proposal cards and flags, a concurrent edit kept alongside an applied replacement, safety backup, one OpenAI confirmation for two calls, markup as text. Not tested: a real AI reply, a real-size map, phone layout. Retired: the Propose changes and Add whole map buttons and the older chat and proposal test scripts.
- AI, Groq limits finding (Railway logs, 2026-10-10): on `openai/gpt-oss-120b` Groq returned 429 "Rate limit reached ... service tier on_demand on tokens per minute (TPM): Limit 8000, Used 5319, Requested 3478 ... try again in 5.9775s", and strict JSON mode kept failing, so each answer was costing two calls. Built in response, tested against the mock only: strict JSON mode is now off on Groq by default (`GROQ_JSON_MODE=on` turns it back on); a provider rate limit that clears within `AI_RETRY_WAIT_MAX_SECONDS` (default 15) is waited out once, otherwise the message says how long to wait and the provider's own text is shown; new optional `GROQ_TPM_LIMIT` (and `OPENAI_TPM_LIMIT`) makes the server refuse a request that cannot fit before calling the provider, and makes the chat trim what it sends to about half the limit per call (shorter snippets, as many full nodes as fit, a long node cut with a marker and a note, a smaller reply allowance, shorter history, and a note when not every node could be listed). On the 8,000 tokens per minute tier the chat works mostly from snippets and one or two nodes at a time; reading the whole story needs OpenAI mode or a higher Groq tier. Groq's Developer plan table (supplied by Maridizzle) listed 250K tokens per minute for gpt-oss-120b; its billing terms are unverified. Set `GROQ_TPM_LIMIT=8000` in Railway while on this tier.
- AI sources, all vendor `.com`: OpenAI models and pricing pages (developers.openai.com), the OpenAI "your data" guide (API data not used for training by default, abuse-monitoring logs kept up to 30 days), and a screenshot of Groq's production models table supplied by Maridizzle (gpt-oss-20b $0.075 in and $0.30 out per 1M, gpt-oss-120b $0.15 and $0.60, both 131,072 context; the Llama models were marked Enterprise).
- The change counter (`seq`) is assigned when a write starts, not when it commits. Overlapping writes could be missed by a poller, so the client re-requests with a small overlap (rows carry a revision, so repeats are harmless).

## Research notes

Search summaries only, full papers not read. Source types are flagged.

- Collaborative concept mapping: Gnesdilow 2010 (university lab PDF, conference paper); Gao et al. review (Semantic Scholar listing, seen only via search summary); Science.gov topic page (.gov aggregator).
- 3D versus 2D graphs: Frontiers in Virtual Reality (peer reviewed); Alper et al. 2011 (UCSB); ACM VR navigation paper; arXiv 2307.10674 (preprint, results not retrieved). No single definitive desktop study found. Immersive VR shows the gains. Desktop 3D has occlusion and navigation costs, which is why the scrub strip and a 2D overview are planned (inference, not sourced fact).
- Sync: MIT Peritext paper (.edu) and an arXiv CRDT overview. Last-write-wins drops one edit; per-field or per-node merging avoids that.
- Worldbuilding tools: almost entirely vendor pages, blogs, forums and commercial roundups (weak evidence). Only scholarly lead: Hergenrader, *Collaborative Worldbuilding for Writers and Gamers* (WorldCat record; book not read).
