// Mangia Mangia helper — a Cloudflare Worker.
//
// Does four things for the recipe box:
//   1. URL import: fetches a recipe page and pulls the recipe out (most sites embed it in a standard format; otherwise the AI reads the page).
//   2. Text/photo import + substitutes, using Cloudflare's built-in free AI models (no API key, no bill).
//   3. An MCP connector at /mcp/<token> so you and your friends can drive the box from your own AI assistant.
//   4. Reads and writes the same Firebase database the website uses.
//
// Settings (Cloudflare dashboard → your worker → Settings → Variables and Secrets):
//   FIREBASE_PROJECT   e.g. mangia-mangia-29ece
//   FIREBASE_API_KEY   the apiKey from the Firebase config block
//   ALLOWED_ORIGIN     the website's address, e.g. https://acompora19.github.io   (or * while testing)
//   TOKENS             JSON of connector access codes → people, e.g. {"k9x2...": {"id": "u-tony", "name": "Tony", "admin": true}}
// Binding (Settings → Bindings → Add → Workers AI):  variable name  AI

const COURSES = ["Starters", "Pasta & Soups", "Mains", "Sides", "Bread & Pizza", "Desserts", "Sauces & Pantry", "Drinks", "Other"];
const CUISINES = ["Italian", "American", "Mexican", "Chinese", "Japanese", "Korean", "Thai", "Vietnamese", "Indian", "Middle Eastern", "Greek", "Mediterranean", "French", "Spanish", "German", "Caribbean", "Other"];
const TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TEXT_MODEL_FALLBACK = "@cf/meta/llama-3.1-8b-instruct";
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      let res;
      if (url.pathname.startsWith("/mcp/")) res = await handleMcp(req, env, url.pathname.slice(5).split("/")[0]);
      else if (req.method === "POST" && url.pathname === "/import-url") res = json(await importFromUrl((await req.json()).url, env));
      else if (req.method === "POST" && url.pathname === "/import-text") res = json(await structureRecipe(env, (await req.json()).text || ""));
      else if (req.method === "POST" && url.pathname === "/import-photo") { const b = await req.json(); res = json(await importFromPhotos(env, b.images || (b.image ? [b.image] : []), b.notes || "")); }
      else if (req.method === "POST" && url.pathname === "/substitute") res = json(await substitute(env, await req.json()));
      else if (url.pathname === "/" || url.pathname === "/health") res = json({ ok: true, name: "Mangia Mangia helper", mcp: "/mcp/<your-access-code>" });
      else res = json({ error: "Not found" }, 404);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const res = json({ error: e?.message || String(e), code: e?.code || "upstream_error" }, e?.status || 500);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }
  },
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const fail = (message, code, status = 400) => { const e = new Error(message); e.code = code; e.status = status; return e; };
function corsHeaders(req, env) {
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim());
  const origin = req.headers.get("Origin") || "";
  const allow = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization, mcp-session-id, mcp-protocol-version", "Access-Control-Expose-Headers": "mcp-session-id", "Vary": "Origin" };
}

// ---------------------------------------------------------------- Firestore (REST)
function fsBase(env) { return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents`; }
function fsEnc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsEnc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fsEnc(x)])) } };
}
function fsDec(v) {
  if (!v) return null;
  if ("nullValue" in v) return null; if ("booleanValue" in v) return v.booleanValue; if ("integerValue" in v) return +v.integerValue; if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue; if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fsDec);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fsDec(x)]));
  return null;
}
const fsDoc = (d) => ({ id: d.name.split("/").pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, fsDec(v)])) });
async function fsList(env, collection) {
  const out = []; let token = "";
  do {
    const r = await fetch(`${fsBase(env)}/${collection}?pageSize=300&key=${env.FIREBASE_API_KEY}${token ? "&pageToken=" + token : ""}`);
    if (!r.ok) throw fail("Database read failed: " + (await r.text()).slice(0, 200), "db", 502);
    const data = await r.json(); out.push(...(data.documents || []).map(fsDoc)); token = data.nextPageToken || "";
  } while (token);
  return out;
}
async function fsGet(env, path) {
  const r = await fetch(`${fsBase(env)}/${path}?key=${env.FIREBASE_API_KEY}`);
  if (r.status === 404) return null;
  if (!r.ok) throw fail("Database read failed", "db", 502);
  return fsDoc(await r.json());
}
async function fsSet(env, path, data, merge) {
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, fsEnc(v)]));
  const mask = merge ? "&" + Object.keys(data).map((k) => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&") : "";
  const r = await fetch(`${fsBase(env)}/${path}?key=${env.FIREBASE_API_KEY}${mask}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!r.ok) throw fail("Database write failed: " + (await r.text()).slice(0, 200), "db", 502);
  return fsDoc(await r.json());
}
async function fsAdd(env, collection, data) {
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, fsEnc(v)]));
  const r = await fetch(`${fsBase(env)}/${collection}?key=${env.FIREBASE_API_KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!r.ok) throw fail("Database write failed", "db", 502);
  return fsDoc(await r.json());
}
async function fsDelete(env, path) { await fetch(`${fsBase(env)}/${path}?key=${env.FIREBASE_API_KEY}`, { method: "DELETE" }); }
const newId = (title) => (String(title || "recipe").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "recipe") + "-" + Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------- AI (Cloudflare Workers AI, free allowance)
const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" }, category: { type: "string", enum: COURSES }, cuisine: { type: "string", enum: CUISINES },
    servings: { type: "string" }, prepMin: { type: ["number", "null"] }, cookMin: { type: ["number", "null"] },
    ingredients: { type: "array", items: { type: "string" } }, steps: { type: "array", items: { type: "string" } },
    notes: { type: "string" }, tags: { type: "array", items: { type: "string" } }, equipment: { type: "array", items: { type: "string" } },
  },
  required: ["title", "category", "cuisine", "servings", "prepMin", "cookMin", "ingredients", "steps", "notes", "tags", "equipment"],
};
const STRUCTURE_RULES = `Turn the recipe text into JSON for a recipe box. Reply with ONLY one JSON object, no commentary, shaped exactly like:
{"title": string, "category": one of ${JSON.stringify(COURSES)}, "cuisine": one of ${JSON.stringify(CUISINES)}, "servings": string (a number as text, or ""), "prepMin": number or null, "cookMin": number or null, "ingredients": [string], "steps": [string], "notes": string, "tags": [string], "equipment": [string]}
Rules: equipment lists only tools someone might not own (an oven-safe skillet, a box grater, a stand mixer, a 9x13 pan), not basics like a knife or a pot, and is [] if nothing special is needed; ingredients are one per line with the amount first and units kept as written (e.g. "2 cups flour", "1/2 tsp salt", "3 cloves garlic, minced"); a sub-section heading inside the ingredients becomes its own entry starting with "# " (e.g. "# For the sauce"); steps are plain sentences, one entry per step, no numbering, keeping any times mentioned; notes hold tips, substitutions or storage advice from the text (or ""); tags are up to 5 short lowercase words; pick the cuisine from the dish itself; do not invent amounts or steps that are not in the text; ignore ads, comments and site navigation.`;

async function askText(env, prompt, wantJson) {
  if (!env.AI) throw fail("The AI binding isn't set up on this worker (Settings → Bindings → Workers AI, name it AI).", "no_ai", 500);
  const inputs = { messages: [{ role: "user", content: prompt }], max_tokens: 2500 };
  if (wantJson) inputs.response_format = { type: "json_schema", json_schema: RECIPE_SCHEMA };
  let out;
  try { out = await env.AI.run(TEXT_MODEL, inputs); }
  catch (e) {
    try { out = await env.AI.run(TEXT_MODEL_FALLBACK, inputs); }
    catch (e2) { throw fail("The AI helper is unavailable right now: " + (e2?.message || e?.message || ""), /rate|quota|limit/i.test(String(e2?.message)) ? "rate_limited" : "upstream_error", 503); }
  }
  const text = typeof out === "string" ? out : (out?.response ?? JSON.stringify(out));
  return typeof text === "string" ? text : JSON.stringify(text);
}
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const i = text.indexOf("{"), j = text.lastIndexOf("}"); if (i >= 0 && j > i) { try { return JSON.parse(text.slice(i, j + 1)); } catch {} }
  return null;
}
function cleanRecipe(d, extra = {}) {
  if (!d || typeof d !== "object" || !d.title) throw fail("Couldn't make sense of that as a recipe.", "no_recipe", 422);
  const arr = (v) => { if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean); if (typeof v !== "string") return []; const t = v.trim(); if (t.startsWith("[")) { try { const j = JSON.parse(t); if (Array.isArray(j)) return j.map((x) => String(x).trim()).filter(Boolean); } catch {} } return t.split("\n").map((x) => x.trim()).filter(Boolean); };
  const num = (v) => { const n = parseFloat(v); return isFinite(n) && n > 0 ? Math.round(n) : null; };
  return {
    title: String(d.title).trim().slice(0, 120), category: COURSES.includes(d.category) ? d.category : guessCourse(d.category || d.title), cuisine: CUISINES.includes(d.cuisine) ? d.cuisine : guessCuisine(d.cuisine || d.title),
    servings: d.servings ? String(d.servings).replace(/[^0-9./ -]/g, "").trim().slice(0, 10) : "", prepMin: num(d.prepMin), cookMin: num(d.cookMin),
    ingredients: arr(d.ingredients), steps: arr(d.steps), notes: d.notes ? String(d.notes).trim().slice(0, 2000) : "", tags: arr(d.tags).slice(0, 6).map((t) => t.toLowerCase()), equipment: arr(d.equipment).slice(0, 12),
    ...extra,
  };
}
async function structureRecipe(env, text, extra) {
  text = String(text || "").trim();
  if (text.length < 20) throw fail("Not enough recipe text to work with.", "no_recipe", 422);
  const raw = await askText(env, STRUCTURE_RULES + "\n\nRECIPE TEXT:\n" + text.slice(0, 24000), true);
  return cleanRecipe(parseJsonLoose(raw), extra);
}
async function transcribePhoto(env, dataUrl, which) {
  if (!dataUrl || !dataUrl.startsWith("data:image/")) throw fail("No image received.", "bad_image", 400);
  const b64 = dataUrl.split(",")[1]; const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const prompt = `This is a photo of a recipe${which}: a recipe card, a cookbook page, handwriting, or a screenshot. Transcribe EVERYTHING on it faithfully and completely, in reading order: the title, every ingredient with its exact amount, every step, and any notes. Keep handwritten amounts exactly as written. Output plain text only.`;
  let out;
  try { out = await env.AI.run(VISION_MODEL, { messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] }], max_tokens: 2000 }); }
  catch (e1) {
    try { out = await env.AI.run(VISION_MODEL, { image: [...bytes], prompt, max_tokens: 2000 }); }
    catch (e2) { throw fail("Couldn't read the photo: " + (e2?.message || e1?.message || ""), "upstream_error", 503); }
  }
  return typeof out === "string" ? out : (out?.response || out?.description || JSON.stringify(out));
}
// Several photos = one recipe that runs across cards or pages; each is transcribed in order, then sorted as one.
async function importFromPhotos(env, dataUrls, notes) {
  if (!env.AI) throw fail("The AI binding isn't set up on this worker.", "no_ai", 500);
  if (!dataUrls.length) throw fail("No image received.", "bad_image", 400);
  if (dataUrls.length > 6) throw fail("Up to 6 photos per recipe, please.", "bad_image", 400);
  const parts = [];
  for (let i = 0; i < dataUrls.length; i++) parts.push(await transcribePhoto(env, dataUrls[i], dataUrls.length > 1 ? ` (part ${i + 1} of ${dataUrls.length}; the recipe continues across several cards)` : ""));
  const transcript = parts.map((t, i) => (dataUrls.length > 1 ? `--- CARD ${i + 1} of ${dataUrls.length} ---\n` : "") + t.trim()).join("\n\n");
  if (transcript.replace(/---.*?---/g, "").trim().length < 20) throw fail("Couldn't read a recipe out of those photos.", "no_recipe", 422);
  return structureRecipe(env, transcript + (notes ? "\n\nNOTES FROM THE PERSON ADDING IT:\n" + notes : ""));
}
async function substitute(env, { title, category, cuisine, ingredient }) {
  const text = await askText(env, `In the recipe "${title || "a recipe"}" (${category || ""}${cuisine ? ", " + cuisine : ""}), what can I use instead of "${ingredient}"? Give 2 or 3 practical substitutes a home cook would actually have, one per line, each with the amount to use and a few words on how it changes the dish. Plain text, no headings, no bullets, at most 3 lines.`, false);
  return { text: text.trim() };
}

// ---------------------------------------------------------------- URL import (schema.org Recipe first, AI fallback)
const guessCourse = (s = "") => { s = String(s).toLowerCase(); return /dessert|cake|cookie|pie|sweet|brownie|pudding|ice cream/.test(s) ? "Desserts" : /soup|stew|pasta|noodle|risotto|ramen|chili/.test(s) ? "Pasta & Soups" : /appetizer|starter|snack|dip|antipast/.test(s) ? "Starters" : /side|salad|vegetable/.test(s) ? "Sides" : /bread|pizza|focaccia|dough|bun|roll/.test(s) ? "Bread & Pizza" : /sauce|condiment|dressing|pickle|preserve|jam|stock|broth|spice|seasoning/.test(s) ? "Sauces & Pantry" : /drink|beverage|cocktail|smoothie|coffee|tea|juice/.test(s) ? "Drinks" : /main|entree|entrée|dinner|lunch|breakfast|brunch|chicken|beef|pork|fish|steak/.test(s) ? "Mains" : "Other"; };
const guessCuisine = (s = "") => { s = String(s).toLowerCase(); for (const c of CUISINES) if (s.includes(c.toLowerCase())) return c; return /mediterranean/.test(s) ? "Mediterranean" : /asian/.test(s) ? "Other" : "Other"; };
const isoMinutes = (d) => { const m = String(d || "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i); if (!m) return null; const n = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0); return n > 0 ? n : null; };
const stripHtml = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
function findRecipeNode(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipeNode(n); if (r) return r; } return null; }
  const t = node["@type"]; const types = Array.isArray(t) ? t : [t];
  if (types.some((x) => String(x).toLowerCase() === "recipe")) return node;
  if (node["@graph"]) return findRecipeNode(node["@graph"]);
  for (const k of ["mainEntity", "mainEntityOfPage", "itemListElement"]) if (node[k]) { const r = findRecipeNode(node[k]); if (r) return r; }
  return null;
}
function fromSchema(rec, url) {
  const steps = [];
  const walk = (ins) => { if (!ins) return; if (typeof ins === "string") { stripHtml(ins).split(/\n+/).forEach((s) => s.trim() && steps.push(s.trim())); return; } if (Array.isArray(ins)) return ins.forEach(walk); if (ins["@type"] === "HowToSection" || ins.itemListElement) return walk(ins.itemListElement); if (ins.text) steps.push(stripHtml(ins.text)); else if (ins.name) steps.push(stripHtml(ins.name)); };
  walk(rec.recipeInstructions);
  const yieldRaw = Array.isArray(rec.recipeYield) ? rec.recipeYield[0] : rec.recipeYield;
  const cat = Array.isArray(rec.recipeCategory) ? rec.recipeCategory.join(" ") : rec.recipeCategory;
  const cui = Array.isArray(rec.recipeCuisine) ? rec.recipeCuisine.join(" ") : rec.recipeCuisine;
  const kw = Array.isArray(rec.keywords) ? rec.keywords : String(rec.keywords || "").split(",");
  return cleanRecipe({
    title: stripHtml(rec.name), category: guessCourse([cat, rec.name].join(" ")), cuisine: guessCuisine([cui, rec.name, kw.join(" ")].join(" ")),
    servings: yieldRaw ? String(yieldRaw).match(/\d+/)?.[0] || "" : "", prepMin: isoMinutes(rec.prepTime), cookMin: isoMinutes(rec.cookTime) || (isoMinutes(rec.totalTime) && isoMinutes(rec.prepTime) ? isoMinutes(rec.totalTime) - isoMinutes(rec.prepTime) : isoMinutes(rec.totalTime)),
    ingredients: (rec.recipeIngredient || rec.ingredients || []).map(stripHtml), steps, notes: stripHtml(rec.description).slice(0, 600), tags: kw.map((k) => stripHtml(k).toLowerCase()).filter((k) => k && k.length < 30).slice(0, 5),
  }, { source: url });
}
async function importFromUrl(url, env) {
  if (!/^https?:\/\//i.test(url || "")) throw fail("That doesn't look like a link.", "bad_url", 400);
  let html;
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "accept": "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" }, redirect: "follow", cf: { cacheTtl: 300 } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    html = await r.text();
  } catch (e) { throw fail("Couldn't open that page (" + (e?.message || "blocked") + ").", "fetch_failed", 502); }
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  for (const b of blocks) {
    let data; try { data = JSON.parse(b.trim()); } catch { try { data = JSON.parse(b.replace(/[\u0000-\u001f]+/g, " ")); } catch { continue; } }
    const rec = findRecipeNode(data);
    if (rec && (rec.recipeIngredient || rec.ingredients)) { try { return fromSchema(rec, url); } catch {} }
  }
  // No structured recipe: strip the page to text and let the AI read it.
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<header[\s\S]*?<\/header>|<footer[\s\S]*?<\/footer>/gi, " ");
  const text = stripHtml(body.replace(/<\/(p|div|li|h\d|tr|br)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n"));
  if (text.length < 200) throw fail("Couldn't find a recipe on that page.", "no_recipe", 422);
  const start = Math.max(0, text.search(/ingredients/i) - 1500);
  return structureRecipe(env, text.slice(start, start + 18000), { source: url });
}

// ---------------------------------------------------------------- MCP connector (Streamable HTTP, JSON responses)
function who(env, token) {
  let map = {}; try { map = JSON.parse(env.TOKENS || "{}"); } catch {}
  return token && map[token] ? map[token] : null;
}
const TOOLS = [
  { name: "list_recipes", description: "List recipes in the Mangia Mangia box. Optional text search and filters. Returns id, title, course, cuisine, who added it, servings, total minutes and rating. Use get_recipe for full details.", inputSchema: { type: "object", properties: { query: { type: "string", description: "words to search in title, ingredients, tags" }, course: { type: "string", enum: COURSES }, cuisine: { type: "string", enum: CUISINES }, cook: { type: "string", description: "only recipes added by this person (name)" } } } },
  { name: "get_recipe", description: "Get one recipe in full by id (from list_recipes): ingredients, steps, notes, tags, ratings, and notes from people who made it.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "add_recipe", description: "Add a new recipe to the box, credited to you. Ingredients are one string each with the amount first ('2 cups flour'); a heading inside the list starts with '# '. Steps are plain sentences, one per entry; name the ingredients and times in each step so cook mode can pick them up.", inputSchema: { type: "object", properties: { title: { type: "string" }, category: { type: "string", enum: COURSES }, cuisine: { type: "string", enum: CUISINES }, servings: { type: "string" }, prepMin: { type: "number" }, cookMin: { type: "number" }, ingredients: { type: "array", items: { type: "string" } }, steps: { type: "array", items: { type: "string" } }, notes: { type: "string" }, tags: { type: "array", items: { type: "string" } }, equipment: { type: "array", items: { type: "string" }, description: "tools someone might not own: oven-safe skillet, box grater, stand mixer" }, source: { type: "string", description: "link it came from, if any" }, variantOf: { type: "string", description: "id of the recipe this is a variation of, if any" } }, required: ["title", "ingredients", "steps"] } },
  { name: "update_recipe", description: "Change fields on an existing recipe (only the fields you pass change). Pass full arrays for ingredients/steps/tags.", inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, category: { type: "string", enum: COURSES }, cuisine: { type: "string", enum: CUISINES }, servings: { type: "string" }, prepMin: { type: "number" }, cookMin: { type: "number" }, ingredients: { type: "array", items: { type: "string" } }, steps: { type: "array", items: { type: "string" } }, notes: { type: "string" }, tags: { type: "array", items: { type: "string" } }, equipment: { type: "array", items: { type: "string" } }, source: { type: "string" } }, required: ["id"] } },
  { name: "delete_recipe", description: "Delete a recipe you added (admins can delete any). Ask the person to confirm before calling this.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "import_recipe_from_url", description: "Fetch a recipe from a web page and add it to the box, credited to you. Returns the saved recipe so you can show it.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "add_note", description: "Leave a 'Made it?' note on a recipe (how it went, what you changed).", inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] } },
  { name: "rate_recipe", description: "Rate a recipe 1 to 5 stars (your one rating; calling again changes it).", inputSchema: { type: "object", properties: { id: { type: "string" }, stars: { type: "integer", minimum: 1, maximum: 5 } }, required: ["id", "stars"] } },
  { name: "list_cooks", description: "Who's in the box: the people who have added recipes or signed in on the website.", inputSchema: { type: "object", properties: {} } },
];
async function handleMcp(req, env, token) {
  const person = who(env, token);
  if (!person) return json({ error: "Unknown access code. Ask Tony for yours." }, 401);
  if (req.method === "GET") return new Response("This is an MCP endpoint; connect with an MCP client.", { status: 405, headers: { "content-type": "text/plain" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body; try { body = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  const msgs = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const m of msgs) {
    if (!m || m.jsonrpc !== "2.0") continue;
    if (m.id === undefined || m.id === null) continue; // notifications need no reply
    try {
      let result;
      if (m.method === "initialize") result = { protocolVersion: m.params?.protocolVersion || "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "Mangia Mangia", version: "1.0.0" }, instructions: `You are connected to Mangia Mangia, a shared family recipe box, as ${person.name}. Recipes you add or rate are credited to ${person.name}. When someone gives you a recipe in any form (text, a photo, a link), add it with add_recipe or import_recipe_from_url, keeping amounts exact and never inventing steps. Confirm before deleting anything.` };
      else if (m.method === "ping") result = {};
      else if (m.method === "tools/list") result = { tools: TOOLS };
      else if (m.method === "tools/call") result = await callTool(env, person, m.params?.name, m.params?.arguments || {});
      else throw { code: -32601, message: "Method not found: " + m.method };
      replies.push({ jsonrpc: "2.0", id: m.id, result });
    } catch (e) {
      if (e && typeof e.code === "number") replies.push({ jsonrpc: "2.0", id: m.id, error: { code: e.code, message: e.message } });
      else replies.push({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "Error: " + (e?.message || String(e)) }], isError: true } });
    }
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? replies : replies[0]);
}
const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });
async function callTool(env, person, name, a) {
  const now = Date.now();
  const names = async () => Object.fromEntries((await fsList(env, "users")).map((u) => [u.id, u.name]));
  const summary = async (r, ratings, nm) => { const rs = ratings.filter((x) => x.recipeId === r.id); return { id: r.id, title: r.title, course: r.category, cuisine: r.cuisine, addedBy: nm[r.authorId] || "", servings: r.servings, totalMin: (r.prepMin || 0) + (r.cookMin || 0) || null, rating: rs.length ? +(rs.reduce((s, x) => s + x.stars, 0) / rs.length).toFixed(1) : null, ratings: rs.length, variantOf: r.variantOf || undefined }; };
  if (name === "list_recipes") {
    const [recipes, ratings, nm] = await Promise.all([fsList(env, "recipes"), fsList(env, "ratings"), names()]);
    const q = (a.query || "").toLowerCase();
    const rows = recipes.filter((r) => (!a.course || r.category === a.course) && (!a.cuisine || r.cuisine === a.cuisine) && (!a.cook || (nm[r.authorId] || "").toLowerCase() === String(a.cook).toLowerCase()) && (!q || [r.title, (r.ingredients || []).join(" "), (r.tags || []).join(" "), r.notes].join(" ").toLowerCase().includes(q)));
    return text({ count: rows.length, recipes: await Promise.all(rows.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)).map((r) => summary(r, ratings, nm))) });
  }
  if (name === "get_recipe") {
    const r = await fsGet(env, "recipes/" + a.id); if (!r) throw new Error("No recipe with id " + a.id);
    const [ratings, comments, nm] = await Promise.all([fsList(env, "ratings"), fsList(env, "recipes/" + a.id + "/comments").catch(() => []), names()]);
    const { thumb, ...rest } = r;
    return text({ ...rest, addedBy: nm[r.authorId] || "", hasPhoto: !!thumb, link: (env.PAGE_URL || "") + "#" + r.id, ratings: ratings.filter((x) => x.recipeId === r.id).map((x) => ({ by: nm[x.userId] || "", stars: x.stars })), notesFromCooks: comments.map((c) => ({ by: nm[c.authorId] || "", text: c.text, when: c.createdAt })) });
  }
  if (name === "add_recipe") {
    const rec = cleanRecipe(a, { source: a.source || "", variantOf: a.variantOf || "" });
    const id = newId(rec.title);
    await fsSet(env, "recipes/" + id, { ...rec, thumb: "", authorId: person.id, createdAt: now, updatedAt: now });
    await ensureUser(env, person);
    return text({ ok: true, id, link: (env.PAGE_URL || "") + "#" + id, recipe: rec });
  }
  if (name === "update_recipe") {
    const r = await fsGet(env, "recipes/" + a.id); if (!r) throw new Error("No recipe with id " + a.id);
    const allowed = ["title", "category", "cuisine", "servings", "prepMin", "cookMin", "ingredients", "steps", "notes", "tags", "source", "equipment"];
    const asList = (v) => { if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean); const t = String(v ?? "").trim(); if (t.startsWith("[")) { try { const j = JSON.parse(t); if (Array.isArray(j)) return j.map((x) => String(x).trim()).filter(Boolean); } catch {} } return t ? t.split(/\n+/).map((x) => x.trim()).filter(Boolean) : []; };
    const patch = {}; for (const k of allowed) if (a[k] !== undefined) patch[k] = ["ingredients", "steps", "tags", "equipment"].includes(k) ? asList(a[k]) : a[k];
    if (patch.category && !COURSES.includes(patch.category)) delete patch.category;
    if (patch.cuisine && !CUISINES.includes(patch.cuisine)) delete patch.cuisine;
    patch.updatedAt = now;
    await fsSet(env, "recipes/" + a.id, patch, true);
    return text({ ok: true, id: a.id, changed: Object.keys(patch).filter((k) => k !== "updatedAt") });
  }
  if (name === "delete_recipe") {
    const r = await fsGet(env, "recipes/" + a.id); if (!r) throw new Error("No recipe with id " + a.id);
    if (r.authorId !== person.id && !person.admin) throw new Error("Only the person who added it (or an admin) can delete this recipe.");
    const comments = await fsList(env, "recipes/" + a.id + "/comments").catch(() => []);
    for (const c of comments) await fsDelete(env, "recipes/" + a.id + "/comments/" + c.id);
    const ratings = (await fsList(env, "ratings")).filter((x) => x.recipeId === a.id);
    for (const x of ratings) await fsDelete(env, "ratings/" + x.id);
    await fsDelete(env, "photos/" + a.id); await fsDelete(env, "recipes/" + a.id);
    return text({ ok: true, deleted: a.id });
  }
  if (name === "import_recipe_from_url") {
    const rec = await importFromUrl(a.url, env);
    const id = newId(rec.title);
    await fsSet(env, "recipes/" + id, { ...rec, thumb: "", variantOf: "", authorId: person.id, createdAt: now, updatedAt: now });
    await ensureUser(env, person);
    return text({ ok: true, id, link: (env.PAGE_URL || "") + "#" + id, recipe: rec });
  }
  if (name === "add_note") {
    if (!(await fsGet(env, "recipes/" + a.id))) throw new Error("No recipe with id " + a.id);
    await fsAdd(env, "recipes/" + a.id + "/comments", { text: String(a.text).slice(0, 500), photo: "", authorId: person.id, createdAt: now });
    await ensureUser(env, person);
    return text({ ok: true });
  }
  if (name === "rate_recipe") {
    if (!(await fsGet(env, "recipes/" + a.id))) throw new Error("No recipe with id " + a.id);
    const stars = Math.max(1, Math.min(5, Math.round(+a.stars)));
    await fsSet(env, "ratings/" + a.id + "_" + person.id, { recipeId: a.id, userId: person.id, stars, updatedAt: now });
    await ensureUser(env, person);
    return text({ ok: true, stars });
  }
  if (name === "list_cooks") return text((await fsList(env, "users")).map((u) => ({ id: u.id, name: u.name })));
  throw { code: -32602, message: "Unknown tool: " + name };
}
async function ensureUser(env, person) {
  const u = await fsGet(env, "users/" + person.id);
  if (!u) await fsSet(env, "users/" + person.id, { name: person.name, color: "#b7322c", createdAt: Date.now() });
}
