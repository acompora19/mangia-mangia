# Mangia Mangia

A shared recipe box for friends. One page, no accounts, free to run.

- `index.html` — the whole app. Recipes live in Firebase (Firestore). The Firebase settings and the helper address are at the top of the script, in `CONFIG`.
- `seed.html` + `seed.json` — one-time page that copies the starting recipes into the database. Open it once after the site is live, click the button, then delete both files.
- `firestore.rules` — the database rules. Paste into Firebase → Firestore Database → Rules → Publish. Do this before the 30-day "test mode" runs out.
- `worker/worker.js` — the Cloudflare Worker: URL import, photo/text import and substitutes (Cloudflare's free AI), and the `/mcp/<access-code>` connector for AI assistants.

## Hosting (GitHub Pages)

Repo → Settings → Pages → Source: "Deploy from a branch", Branch: `main`, folder `/ (root)` → Save. The site appears at `https://<username>.github.io/mangia-mangia/` within a few minutes.

## The helper (Cloudflare Worker)

1. dash.cloudflare.com → Workers & Pages → Create → Create Worker → name it `mangia-mangia` → Deploy.
2. Click "Edit code", delete everything in the editor, paste the contents of `worker/worker.js`, click Deploy.
3. Settings → Variables and Secrets → add:
   - `FIREBASE_PROJECT` = `mangia-mangia-29ece`
   - `FIREBASE_API_KEY` = the `apiKey` from the Firebase config
   - `ALLOWED_ORIGIN` = `https://<username>.github.io`
   - `PAGE_URL` = `https://<username>.github.io/mangia-mangia/`
   - `TOKENS` (as a Secret) = the JSON in `worker/TOKENS.example.json` (one entry per person who gets a connector)
4. Settings → Bindings → Add → Workers AI → Variable name `AI` → Deploy.
5. Copy the worker's address (`https://mangia-mangia.<something>.workers.dev`) into `CONFIG.workerUrl` in `index.html` and push.

## Connecting an AI assistant

Each person gets an access code (an entry in `TOKENS`). Their connector address is
`https://mangia-mangia.<something>.workers.dev/mcp/<their-code>` — add it in Claude (Settings → Connectors → Add custom connector, no authentication) or any other assistant that supports MCP. From then on, "add this recipe to Mangia Mangia" works from their own chat, credited to them.

To add a friend: make up a code (a long random string), add `"<code>": {"id": "u-<name>", "name": "<Name>"}` to `TOKENS`, save, send them the address. To remove a friend, delete their line.
