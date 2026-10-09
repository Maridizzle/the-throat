// THE THROAT -- AI gateway (stage 1: server only)
// Signed Maridizzle
//
// The browser never sees an API key. Keys come from Railway variables and are used
// only here. Every call is made on behalf of a signed-in writer, rate limited per
// writer, checked against a monthly spending cap, and logged by counts only
// (prompts and replies are never stored). OpenAI calls also need the writer to
// confirm the estimated cost first. Nothing here writes to the story: it only
// returns text (or parsed JSON) for the client to show as a proposal.

"use strict";
const express = require("express");

// USD per 1M tokens [input, output], read from the vendors' own pricing pages and
// Groq's model table. Any other model needs its prices set in variables.
const DEFAULT_PRICES = {
  "openai/gpt-oss-20b": [0.075, 0.3],
  "openai/gpt-oss-120b": [0.15, 0.6],
  "gpt-6-luna": [0.1, 0.5],
  "gpt-6.1-sol": [2, 10],
  "gpt-6-astra": [10, 50],
};

const optNum = (v) => {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7);

function createAi(env, deps) {
  const fetchImpl = (deps && deps.fetch) || globalThis.fetch;
  const storage = deps && deps.storage;
  const now = (deps && deps.now) || (() => Date.now());

  const MAX_INPUT_CHARS = optNum(env.AI_MAX_INPUT_CHARS) ?? 400000;
  const MAX_OUTPUT_TOKENS = optNum(env.AI_MAX_OUTPUT_TOKENS) ?? 8000;
  const DEFAULT_OUTPUT_TOKENS = 2000;
  const TIMEOUT_MS = optNum(env.AI_TIMEOUT_MS) ?? 120000;
  const RATE_WINDOW_MS = 10 * 60 * 1000;

  function priceOf(model, inVar, outVar) {
    const i = optNum(inVar), o = optNum(outVar);
    if (i !== null && o !== null) return [i, o];
    return DEFAULT_PRICES[model] || null;
  }
  function build(name, cfg) {
    const out = { name, key: cfg.key || "", base: cfg.base, cap: cfg.cap, rate: cfg.rate, models: {}, reason: "" };
    out.models.fast = { id: cfg.model, price: priceOf(cfg.model, cfg.priceIn, cfg.priceOut) };
    out.models.accurate = cfg.accurateModel && cfg.accurateModel !== cfg.model
      ? { id: cfg.accurateModel, price: priceOf(cfg.accurateModel, cfg.accPriceIn, cfg.accPriceOut) }
      : out.models.fast;
    if (!out.key) out.reason = "no API key set";
    else if (!out.models.fast.price) out.reason = "no price known for model " + cfg.model + " (set the price variables)";
    else if (!out.models.accurate.price) out.reason = "no price known for model " + cfg.accurateModel + " (set the accurate price variables)";
    out.configured = !out.reason;
    return out;
  }
  const providers = {
    groq: build("groq", {
      key: env.GROQ_API_KEY, base: (env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, ""),
      model: env.GROQ_MODEL || "openai/gpt-oss-20b", priceIn: env.GROQ_PRICE_IN, priceOut: env.GROQ_PRICE_OUT,
      cap: optNum(env.AI_BUDGET_GROQ) ?? 5, rate: optNum(env.AI_RATE_GROQ) ?? 40,
    }),
    openai: build("openai", {
      key: env.OPENAI_API_KEY, base: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
      model: env.OPENAI_MODEL || "gpt-6-luna", priceIn: env.OPENAI_PRICE_IN, priceOut: env.OPENAI_PRICE_OUT,
      accurateModel: env.OPENAI_MODEL_ACCURATE, accPriceIn: env.OPENAI_ACCURATE_PRICE_IN, accPriceOut: env.OPENAI_ACCURATE_PRICE_OUT,
      cap: optNum(env.AI_BUDGET_OPENAI) ?? 10, rate: optNum(env.AI_RATE_OPENAI) ?? 10,
    }),
  };

  // ---- spending this month, rebuilt from the usage log, plus calls still in flight ----
  let spentMonth = "", spent = { groq: 0, openai: 0 };
  const pending = { groq: 0, openai: 0 };
  async function loadMonth() {
    const mk = monthKey(now());
    if (mk === spentMonth) return;
    spent = { groq: 0, openai: 0 };
    if (storage) for (const ev of await storage.sinceMonth(mk)) if (spent[ev.provider] !== undefined) spent[ev.provider] += Number(ev.cost_usd) || 0;
    spentMonth = mk;
  }
  async function record(ev) {
    await loadMonth();
    if (spent[ev.provider] !== undefined) spent[ev.provider] += ev.cost_usd;
    if (storage) {
      try { await storage.add(ev); } catch (e) { console.error("ai usage log failed:", e.message); }
    }
  }

  // ---- per-writer rate limit ----
  const hits = new Map();
  function rateCheck(who, provider) {
    const k = who + "|" + provider, t = now(), arr = (hits.get(k) || []).filter((x) => t - x < RATE_WINDOW_MS);
    if (arr.length >= providers[provider].rate) {
      hits.set(k, arr);
      return Math.max(1, Math.ceil((RATE_WINDOW_MS - (t - arr[0])) / 1000));
    }
    arr.push(t); hits.set(k, arr);
    return 0;
  }

  // ---- request validation and the cost estimate (a conservative guess: 3 characters per token) ----
  function readBody(b) {
    if (!b || typeof b !== "object") return { error: "bad_request", message: "Send a JSON body." };
    const provider = b.mode === "openai" ? "openai" : b.mode === "groq" ? "groq" : null;
    if (!provider) return { error: "bad_request", message: 'mode must be "groq" or "openai".' };
    if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > 60) return { error: "bad_request", message: "messages must be a list of 1 to 60." };
    let chars = 0;
    const messages = [];
    for (const m of b.messages) {
      if (!m || !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string") return { error: "bad_request", message: "Each message needs a role and text content." };
      chars += m.content.length; messages.push({ role: m.role, content: m.content });
    }
    if (chars > MAX_INPUT_CHARS) return { error: "too_large", message: "That is " + chars + " characters. The limit per request is " + MAX_INPUT_CHARS + ".", limit: MAX_INPUT_CHARS };
    const asked = Number.isInteger(b.max_output_tokens) && b.max_output_tokens > 0 ? b.max_output_tokens : DEFAULT_OUTPUT_TOKENS;
    const maxOut = Math.min(asked, MAX_OUTPUT_TOKENS);
    const purpose = typeof b.purpose === "string" ? b.purpose.replace(/[^\w .,:-]/g, "").slice(0, 60) : "";
    const tier = b.tier === "accurate" ? "accurate" : "fast";
    const p = providers[provider], model = p.models[tier];
    const inTok = Math.ceil(chars / 3);
    const estimate = round6((inTok * model.price[0] + maxOut * model.price[1]) / 1e6);
    return { provider, messages, json: !!b.json, maxOut, purpose, tier, model, inTok, estimate, confirm: optNum(b.confirm_cost) };
  }

  // ---- the two upstream calls ----
  async function upstream(req) {
    const p = providers[req.provider];
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      let url, body;
      if (req.provider === "groq") {
        url = p.base + "/chat/completions";
        body = { model: req.model.id, messages: req.messages, max_completion_tokens: req.maxOut, temperature: 0.3 };
        if (req.json) body.response_format = { type: "json_object" };
      } else {
        url = p.base + "/responses";
        body = { model: req.model.id, input: req.messages, max_output_tokens: req.maxOut, store: false };
        if (req.json) body.text = { format: { type: "json_object" } };
      }
      const r = await fetchImpl(url, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + p.key }, body: JSON.stringify(body) });
      const raw = await r.text();
      let j = null; try { j = JSON.parse(raw); } catch (e) { /* not JSON */ }
      if (!r.ok) {
        const pe = j && j.error && typeof j.error === "object" ? j.error : null;
        return { fail: r.status, detail: raw.slice(0, 300).split(p.key).join("[key]"), code: pe && typeof pe.code === "string" ? pe.code : "",
          pmsg: pe && typeof pe.message === "string" ? pe.message.split(p.key).join("[key]").replace(/\s+/g, " ").slice(0, 200) : "" };
      }
      if (!j) return { fail: 502, detail: "reply was not JSON" };
      if (req.provider === "groq") {
        const m = j.choices && j.choices[0] && j.choices[0].message;
        return { text: m && typeof m.content === "string" ? m.content : "", input: j.usage && j.usage.prompt_tokens, output: j.usage && j.usage.completion_tokens,
          truncated: !!(j.choices && j.choices[0] && j.choices[0].finish_reason === "length") };
      }
      let text = typeof j.output_text === "string" ? j.output_text : "";
      if (!text && Array.isArray(j.output)) {
        for (const item of j.output) for (const c of (item && item.content) || []) if (c && typeof c.text === "string") text += c.text;
      }
      return { text, input: j.usage && j.usage.input_tokens, output: j.usage && j.usage.output_tokens,
        truncated: j.status === "incomplete" && !!(j.incomplete_details && j.incomplete_details.reason === "max_output_tokens") };
    } catch (e) {
      return { fail: e.name === "AbortError" ? 504 : 502, detail: e.name === "AbortError" ? "timed out" : "could not reach the provider" };
    } finally { clearTimeout(timer); }
  }
  const parseJson = (text) => {
    const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return JSON.parse(t); } catch (e) { /* fall through: look for the first complete object inside other words */ }
    const start = t.indexOf("{");
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch (e) { return null; } }
    }
    return null;
  };

  // ---- routes ----
  const router = express.Router();
  const signedIn = (req, res, next) => (req.writer ? next() : res.status(401).json({ error: "unauthorized" }));
  router.use(signedIn);
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error("ai " + req.path + " failed:", e.message); if (!res.headersSent) res.status(500).json({ error: "server_error" }); });

  const providerView = async (p) => ({
    configured: p.configured, reason: p.reason || null,
    model: p.models.fast.id, accurate_model: p.models.accurate.id,
    prices_per_million_usd: { fast: p.models.fast.price, accurate: p.models.accurate.price },
    monthly_cap_usd: p.cap, spent_this_month_usd: round6(spent[p.name]), rate_per_10_minutes: p.rate,
  });
  router.get("/status", wrap(async (req, res) => {
    await loadMonth();
    res.json({ month: spentMonth, max_input_chars: MAX_INPUT_CHARS, max_output_tokens: MAX_OUTPUT_TOKENS,
      groq: await providerView(providers.groq), openai: await providerView(providers.openai) });
  }));
  router.get("/usage", wrap(async (req, res) => {
    res.json({ events: storage ? await storage.recent(50) : [] });
  }));

  async function gate(req, res, body) {
    const r = readBody(body);
    if (r.error) { res.status(r.error === "too_large" ? 413 : 400).json(r); return null; }
    const p = providers[r.provider];
    if (!p.configured) { res.status(503).json({ error: "not_configured", provider: r.provider, message: "The " + r.provider + " key or prices are not set on the server: " + p.reason + "." }); return null; }
    await loadMonth();
    return r;
  }
  router.post("/estimate", wrap(async (req, res) => {
    const r = await gate(req, res, req.body); if (!r) return;
    const p = providers[r.provider];
    res.json({ provider: r.provider, model: r.model.id, input_tokens_est: r.inTok, max_output_tokens: r.maxOut, worst_case_usd: r.estimate,
      note: "Estimate assumes 3 characters per token and the full output allowance, so the real cost is usually lower.",
      spent_this_month_usd: round6(spent[r.provider]), monthly_cap_usd: p.cap });
  }));
  router.post("/chat", wrap(async (req, res) => {
    const r = await gate(req, res, req.body); if (!r) return;
    const p = providers[r.provider], who = req.writer.id;
    if (r.provider === "openai" && (r.confirm === null || r.confirm + 1e-9 < r.estimate)) {
      return res.status(412).json({ error: "confirm_required", message: "OpenAI costs money. Confirm the estimated cost to go ahead.", worst_case_usd: r.estimate, provider: "openai", model: r.model.id });
    }
    if (spent[r.provider] + pending[r.provider] + r.estimate > p.cap) {
      return res.status(402).json({ error: "budget", message: "This would pass the monthly " + r.provider + " cap.", spent_this_month_usd: round6(spent[r.provider]), monthly_cap_usd: p.cap, worst_case_usd: r.estimate });
    }
    const wait = rateCheck(who, r.provider);
    if (wait) return res.status(429).json({ error: "rate_limited", retry_after_seconds: wait });
    pending[r.provider] += r.estimate;
    let out, fellBack = false;
    const ev = { at: new Date(now()).toISOString(), by: who, provider: r.provider, model: r.model.id, input_tokens: 0, output_tokens: 0, cost_usd: 0, purpose: r.purpose, ok: false };
    try {
      out = await upstream(r);
      // Groq can refuse strict JSON mode for a model (code json_validate_failed). Retry once in plain mode: the prompt
      // already asks for JSON only, and the client checks every reply before using it.
      if (r.provider === "groq" && r.json && out.fail === 400 && out.code === "json_validate_failed") {
        console.error("ai groq: strict JSON mode failed, retrying once without it");
        await record({ ...ev, purpose: (r.purpose + " (json mode failed)").slice(0, 80) });
        fellBack = true;
        out = await upstream({ ...r, json: false });
      }
    } finally { pending[r.provider] -= r.estimate; }
    if (out.fail) {
      await record(ev);
      console.error("ai " + r.provider + " upstream " + out.fail + ": " + out.detail);
      const status = out.fail === 429 ? 429 : out.fail === 504 ? 504 : 502;
      const msg = out.fail === 401 || out.fail === 403 ? "The provider rejected the server's key." : out.fail === 429 ? "The provider is rate limiting. Try again shortly." : out.fail === 504 ? "The provider took too long." : "The provider returned an error (" + out.fail + ").";
      const why = out.pmsg && out.fail !== 401 && out.fail !== 403 ? " The provider said: " + out.pmsg : "";
      return res.status(status).json({ error: out.fail === 401 || out.fail === 403 ? "provider_auth" : "provider_error", message: msg + why });
    }
    const known = Number.isFinite(out.input) && Number.isFinite(out.output);
    ev.input_tokens = known ? out.input : r.inTok; ev.output_tokens = known ? out.output : r.maxOut;
    ev.cost_usd = known ? round6((out.input * r.model.price[0] + out.output * r.model.price[1]) / 1e6) : r.estimate; // no usage reported: charge the worst case
    ev.ok = !!out.text;
    await record(ev);
    if (!out.text) return res.status(502).json({ error: "empty_reply", message: "The provider returned no text." });
    const json = r.json ? parseJson(out.text) : null;
    res.json({ ok: true, provider: r.provider, model: r.model.id, text: out.text, json, json_ok: r.json ? json !== null : null, json_fallback: fellBack,
      truncated: !!out.truncated || (known && out.output >= r.maxOut * 0.98),
      usage: { input_tokens: ev.input_tokens, output_tokens: ev.output_tokens, cost_usd: ev.cost_usd },
      spent_this_month_usd: round6(spent[r.provider]), monthly_cap_usd: p.cap });
  }));

  return {
    router,
    summary: () => ["groq", "openai"].map((n) => n + ": " + (providers[n].configured ? "on, model " + providers[n].models.fast.id + (providers[n].models.accurate !== providers[n].models.fast ? " (accurate " + providers[n].models.accurate.id + ")" : "") + ", cap $" + providers[n].cap + "/month" : "off (" + providers[n].reason + ")")).join("; "),
  };
}

module.exports = { createAi, DEFAULT_PRICES };
