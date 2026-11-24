import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { COLUMNS, CORE_KEYS, computeTotal, emptyFields, type FieldKey, type Fields } from "./fields";
import { ocrSlip, type OcrEnv } from "./ocr";
import type { Alias } from "./vocab";
import { loadMemory, recordCorrections } from "./memory";
// @ts-ignore text module
import INDEX_HTML from "../public/index.html";
// @ts-ignore text module
import APP_CSS from "../public/app.css";
// @ts-ignore text module
import APP_JS from "../public/app.js";

const STATIC: Record<string, [string, string]> = {
  "/": [INDEX_HTML as string, "text/html; charset=utf-8"],
  "/index.html": [INDEX_HTML as string, "text/html; charset=utf-8"],
  "/app.css": [APP_CSS as string, "text/css; charset=utf-8"],
  "/app.js": [APP_JS as string, "text/javascript; charset=utf-8"],
};

export interface Env extends OcrEnv {
  DB: D1Database;
  IMAGES: KVNamespace;
  OCR_FLOW: Workflow<{ id: string }>;
}

const MAX_ATTEMPTS = 3;

// Every slip is read by its own Workflow instance, so a batch of 200 is read in parallel.
async function startReading(env: Env, ids: string[]) {
  const stamp = Date.now().toString(36);
  for (let i = 0; i < ids.length; i += 100) {
    await env.OCR_FLOW.createBatch(ids.slice(i, i + 100).map((id) => ({ id: `${id}-${stamp}`, params: { id } })));
  }
}

export class OcrWorkflow extends WorkflowEntrypoint<Env, { id: string }> {
  async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep) {
    return step.do(
      "read slip",
      { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" },
      async () => {
        const outcome = await processSlip(this.env, event.payload.id);
        if (outcome === "retry") throw new Error("Reading failed, trying again");
        return outcome;
      },
    );
  }
}
const now = () => new Date().toISOString();
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

interface SlipRow {
  id: string;
  batch_id: string;
  created_at: string;
  updated_at: string;
  status: string;
  attempts: number;
  file_name: string | null;
  engine: string | null;
  fields: string | null;
  extras: string | null;
  review: string | null;
  reviewed: number;
  exported: number;
  error: string | null;
  raw?: string | null;
  ai_fields?: string | null;
}

function present(r: SlipRow) {
  return {
    id: r.id,
    batch_id: r.batch_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    status: r.status,
    attempts: r.attempts,
    file_name: r.file_name,
    engine: r.engine,
    fields: r.fields ? JSON.parse(r.fields) : emptyFields(),
    extras: r.extras ? JSON.parse(r.extras) : {},
    review: r.review ? JSON.parse(r.review) : [],
    reviewed: !!r.reviewed,
    exported: !!r.exported,
    error: r.error,
  };
}

// Remember Arabic -> English spellings the user confirmed, so future slips come out the same way.
async function learnAliases(env: Env, fields: Fields, extras: Record<string, any>) {
  const pairs: [string, string, string][] = [];
  const add = (kind: string, ar: unknown, en: string) => {
    const a = String(ar || "").trim();
    const e = String(en || "").trim().toUpperCase();
    if (a && e && /[؀-ۿ]/.test(a) && a.length <= 60 && e.length <= 80) pairs.push([kind, a, e]);
  };
  add("group", extras.guest_name_ar, fields.group);
  add("driver", extras.driver_name_ar, fields.driver_name);
  add("vehicle", extras.car_type_ar, fields.vehicle);
  if (extras.route_ar && !String(extras.route_ar).includes("/")) {
    const place = fields.route.split(" / ").filter((p) => !/^(K|K-[A-Z]+-K|ATRAAF)$/.test(p)).join(" / ");
    add("place", extras.route_ar, place);
  }
  if (!pairs.length) return;
  const t = now();
  await env.DB.batch(
    pairs.map(([kind, ar, en]) =>
      env.DB.prepare(
        `INSERT INTO aliases (kind, arabic, english, hits, updated_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(kind, arabic) DO UPDATE SET english = excluded.english, hits = aliases.hits + 1, updated_at = excluded.updated_at`,
      ).bind(kind, ar, en, t),
    ),
  );
}

async function processSlip(env: Env, id: string): Promise<"done" | "retry" | "error" | "skip"> {
  const row = await env.DB.prepare("SELECT * FROM slips WHERE id = ?").bind(id).first<SlipRow>();
  if (!row || row.status === "done") return "skip";
  const attempts = row.attempts + 1;
  await env.DB.prepare("UPDATE slips SET status = 'processing', attempts = ?, updated_at = ? WHERE id = ?").bind(attempts, now(), id).run();
  try {
    const img = await env.IMAGES.getWithMetadata<{ type?: string }>(`img/${id}`, "arrayBuffer");
    if (!img.value) throw new Error("image not found");
    const result = await ocrSlip(env, img.value, img.metadata?.type || "image/jpeg", await loadMemory(env.DB));
    await env.DB.prepare(
      "UPDATE slips SET status = 'done', engine = ?, fields = ?, ai_fields = ?, extras = ?, review = ?, raw = ?, error = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(result.engine, JSON.stringify(result.fields), JSON.stringify(result.ai_fields), JSON.stringify(result.extras), JSON.stringify(result.review), JSON.stringify(result.raw), now(), id)
      .run();
    return "done";
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 1000);
    const final = attempts >= MAX_ATTEMPTS;
    await env.DB.prepare("UPDATE slips SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .bind(final ? "error" : "queued", msg, now(), id)
      .run();
    return final ? "error" : "retry";
  }
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowValues(f: Fields): string[] {
  return COLUMNS.map((c) => f[c.key] ?? "");
}

async function selectSlips(env: Env, ids: string[] | null): Promise<SlipRow[]> {
  if (ids && ids.length) {
    const out: SlipRow[] = [];
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      const { results } = await env.DB.prepare(
        `SELECT * FROM slips WHERE id IN (${chunk.map(() => "?").join(",")}) ORDER BY created_at`,
      ).bind(...chunk).all<SlipRow>();
      out.push(...(results || []));
    }
    return out;
  }
  const { results } = await env.DB.prepare("SELECT * FROM slips WHERE status = 'done' ORDER BY created_at").all<SlipRow>();
  return results || [];
}

async function getSetting(env: Env, key: string): Promise<string> {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value || "";
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;

  // Upload one slip photo (raw image bytes in the body)
  if (path === "/api/upload" && method === "POST") {
    const type = (req.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!type.startsWith("image/")) return json({ error: "Send an image" }, 400);
    const body = await req.arrayBuffer();
    if (body.byteLength < 1000) return json({ error: "Image is empty" }, 400);
    if (body.byteLength > 20 * 1024 * 1024) return json({ error: "Image is too large (max 20 MB)" }, 413);
    const id = crypto.randomUUID();
    const batch = (req.headers.get("x-batch-id") || id).slice(0, 64);
    const name = decodeURIComponent(req.headers.get("x-file-name") || "").slice(0, 200);
    await env.IMAGES.put(`img/${id}`, body, { metadata: { type } });
    const t = now();
    await env.DB.prepare(
      "INSERT INTO slips (id, batch_id, created_at, updated_at, status, file_name, fields, review) VALUES (?, ?, ?, ?, 'queued', ?, ?, '[]')",
    ).bind(id, batch, t, t, name, JSON.stringify(emptyFields())).run();
    await startReading(env, [id]);
    return json({ id, status: "queued" });
  }

  if (path === "/api/slips" && method === "GET") {
    const status = url.searchParams.get("status");
    const batch = url.searchParams.get("batch");
    const where: string[] = [];
    const args: string[] = [];
    if (status) { where.push("status = ?"); args.push(status); }
    if (batch) { where.push("batch_id = ?"); args.push(batch); }
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "2000", 10) || 2000, 5000);
    const { results } = await env.DB.prepare(
      `SELECT id,batch_id,created_at,updated_at,status,attempts,file_name,engine,fields,extras,review,reviewed,exported,error FROM slips ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ${limit}`,
    ).bind(...args).all<SlipRow>();
    return json({ slips: (results || []).map(present) });
  }

  if (path === "/api/stats" && method === "GET") {
    const batch = url.searchParams.get("batch");
    const r = await env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM slips ${batch ? "WHERE batch_id = ?" : ""} GROUP BY status`,
    ).bind(...(batch ? [batch] : [])).all<{ status: string; n: number }>();
    const counts: Record<string, number> = { queued: 0, processing: 0, done: 0, error: 0 };
    for (const x of r.results || []) counts[x.status] = x.n;
    return json({ counts });
  }

  const m = path.match(/^\/api\/slips\/([0-9a-f-]{36})(\/(image|retry|raw))?$/);
  if (m) {
    const id = m[1];
    const sub = m[3];
    if (sub === "image" && method === "GET") {
      const img = await env.IMAGES.getWithMetadata<{ type?: string }>(`img/${id}`, "stream");
      if (!img.value) return new Response("not found", { status: 404 });
      return new Response(img.value, { headers: { "content-type": img.metadata?.type || "image/jpeg", "cache-control": "private, max-age=86400" } });
    }
    if (sub === "raw" && method === "GET") {
      const r = await env.DB.prepare("SELECT raw FROM slips WHERE id = ?").bind(id).first<{ raw: string }>();
      return json(r?.raw ? JSON.parse(r.raw) : null);
    }
    if (sub === "retry" && method === "POST") {
      await env.DB.prepare("UPDATE slips SET status = 'queued', attempts = 0, error = NULL, updated_at = ? WHERE id = ?").bind(now(), id).run();
      await startReading(env, [id]);
      return json({ ok: true });
    }
    if (!sub && method === "PATCH") {
      const body = (await req.json()) as { fields?: Partial<Fields>; reviewed?: boolean; exported?: boolean };
      const row = await env.DB.prepare("SELECT * FROM slips WHERE id = ?").bind(id).first<SlipRow>();
      if (!row) return json({ error: "not found" }, 404);
      const fields: Fields = { ...emptyFields(), ...(row.fields ? JSON.parse(row.fields) : {}) };
      const extras = row.extras ? JSON.parse(row.extras) : {};
      let review: FieldKey[] = row.review ? JSON.parse(row.review) : [];
      const before: Fields = { ...fields };
      // What the AI first read (older slips without it: the values before the first edit)
      const ai: Fields = row.ai_fields ? { ...emptyFields(), ...JSON.parse(row.ai_fields) } : { ...before };
      if (body.fields) {
        for (const c of COLUMNS) {
          const v = body.fields[c.key];
          if (typeof v === "string" && v !== fields[c.key]) {
            fields[c.key] = v.trim();
            review = review.filter((k) => k !== c.key);
          }
        }
        if (body.fields.gr_total === undefined) fields.gr_total = computeTotal(fields);
      }
      let reviewed = row.reviewed;
      if (typeof body.reviewed === "boolean") {
        reviewed = body.reviewed ? 1 : 0;
        if (body.reviewed) {
          review = [];
          await learnAliases(env, fields, extras);
        }
      }
      // Remember every correction so later slips don't repeat the mistake
      let learned = 0;
      if (body.fields && row.status === "done") {
        learned = await recordCorrections(env.DB, ai, before, fields, extras);
        const nameChanged = (["group", "driver_name", "vehicle", "route"] as FieldKey[]).some((k) => before[k] !== fields[k]);
        if (nameChanged && !body.reviewed) await learnAliases(env, fields, extras);
      }
      const exported = typeof body.exported === "boolean" ? (body.exported ? 1 : 0) : row.exported;
      await env.DB.prepare("UPDATE slips SET fields = ?, ai_fields = ?, review = ?, reviewed = ?, exported = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(fields), JSON.stringify(ai), JSON.stringify(review), reviewed, exported, now(), id)
        .run();
      const updated = await env.DB.prepare("SELECT * FROM slips WHERE id = ?").bind(id).first<SlipRow>();
      return json({ slip: present(updated!), learned });
    }
    if (!sub && method === "DELETE") {
      await env.DB.prepare("DELETE FROM slips WHERE id = ?").bind(id).run();
      await env.IMAGES.delete(`img/${id}`);
      return json({ ok: true });
    }
  }

  if (path === "/api/bulk" && method === "POST") {
    const body = (await req.json()) as { ids: string[]; action: "delete" | "retry" | "reviewed" | "exported" | "unexported" };
    const ids = (body.ids || []).filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 1000);
    for (const id of ids) {
      if (body.action === "delete") {
        await env.DB.prepare("DELETE FROM slips WHERE id = ?").bind(id).run();
        await env.IMAGES.delete(`img/${id}`);
      } else if (body.action === "retry") {
        await env.DB.prepare("UPDATE slips SET status = 'queued', attempts = 0, error = NULL, updated_at = ? WHERE id = ?").bind(now(), id).run();
      } else if (body.action === "reviewed") {
        const row = await env.DB.prepare("SELECT * FROM slips WHERE id = ?").bind(id).first<SlipRow>();
        if (row?.fields) await learnAliases(env, JSON.parse(row.fields), row.extras ? JSON.parse(row.extras) : {});
        await env.DB.prepare("UPDATE slips SET reviewed = 1, review = '[]', updated_at = ? WHERE id = ?").bind(now(), id).run();
      } else if (body.action === "exported" || body.action === "unexported") {
        await env.DB.prepare("UPDATE slips SET exported = ?, updated_at = ? WHERE id = ?").bind(body.action === "exported" ? 1 : 0, now(), id).run();
      }
    }
    if (body.action === "retry") {
      await startReading(env, ids);
    }
    return json({ ok: true, count: ids.length });
  }

  // CSV in the exact column order of the Google Sheet
  if (path === "/api/export.csv" && method === "GET") {
    const ids = url.searchParams.get("ids")?.split(",").filter(Boolean) || null;
    const rows = await selectSlips(env, ids);
    const lines = [COLUMNS.map((c) => csvCell(c.label)).join(",")];
    for (const r of rows) lines.push(rowValues(JSON.parse(r.fields || "{}")).map(csvCell).join(","));
    return new Response("﻿" + lines.join("\r\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="transport-slips-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  if (path === "/api/settings" && method === "GET") {
    return json({ sheet_webhook: await getSetting(env, "sheet_webhook"), sheet_tab: (await getSetting(env, "sheet_tab")) || "FAIZ VEHICLES", engine: env.ANTHROPIC_API_KEY ? "claude" : "workers-ai" });
  }
  if (path === "/api/settings" && method === "PUT") {
    const body = (await req.json()) as Record<string, string>;
    for (const key of ["sheet_webhook", "sheet_tab"]) {
      if (typeof body[key] === "string") {
        const v = body[key].trim();
        if (key === "sheet_webhook" && v && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(v)) {
          return json({ error: "The link should look like https://script.google.com/macros/s/…/exec" }, 400);
        }
        await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, v).run();
      }
    }
    return json({ ok: true });
  }

  // Append rows to the Google Sheet through the user's Apps Script web app
  if (path === "/api/push-sheet" && method === "POST") {
    const hook = await getSetting(env, "sheet_webhook");
    if (!hook) return json({ error: "Connect the Google Sheet first (Settings)." }, 400);
    const tab = (await getSetting(env, "sheet_tab")) || "FAIZ VEHICLES";
    const body = (await req.json()) as { ids: string[] };
    const rows = await selectSlips(env, body.ids || []);
    if (!rows.length) return json({ error: "Nothing selected" }, 400);
    const values = rows.map((r) => {
      const f: Fields = JSON.parse(r.fields || "{}");
      return rowValues(f).map((v, i) => ("money" in COLUMNS[i] && v && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v));
    });
    const res = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ sheet: tab, headers: COLUMNS.map((c) => c.label), rows: values }),
      redirect: "follow",
    });
    const text = await res.text();
    let out: any = null;
    try { out = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || !out?.ok) return json({ error: "Google Sheet did not accept the rows: " + (out?.error || text.slice(0, 300)) }, 502);
    for (const r of rows) await env.DB.prepare("UPDATE slips SET exported = 1, updated_at = ? WHERE id = ?").bind(now(), r.id).run();
    return json({ ok: true, appended: rows.length, sheet: tab });
  }

  // What the app has learned from corrections
  if (path === "/api/memory" && method === "GET") {
    const mem = await loadMemory(env.DB);
    return json(mem);
  }
  if (path === "/api/memory/correction" && method === "DELETE") {
    const cid = parseInt(url.searchParams.get("id") || "", 10);
    if (!cid) return json({ error: "Missing id" }, 400);
    await env.DB.prepare("DELETE FROM corrections WHERE id = ?").bind(cid).run();
    return json({ ok: true });
  }
  if (path === "/api/memory/spelling" && method === "DELETE") {
    const kind = url.searchParams.get("kind") || "";
    const arabic = url.searchParams.get("arabic") || "";
    await env.DB.prepare("DELETE FROM aliases WHERE kind = ? AND arabic = ?").bind(kind, arabic).run();
    return json({ ok: true });
  }

  if (path === "/api/columns" && method === "GET") {
    return json({ columns: COLUMNS, core: CORE_KEYS });
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url);
      } catch (e) {
        return json({ error: String((e as Error)?.message || e) }, 500);
      }
    }
    const file = STATIC[url.pathname];
    if (file && (req.method === "GET" || req.method === "HEAD")) {
      return new Response(file[0], { headers: { "content-type": file[1], "cache-control": "no-cache" } });
    }
    return new Response("Not found", { status: 404 });
  },

  // Safety net: re-queue slips stuck in "queued"/"processing" for more than 15 minutes.
  async scheduled(_ev: ScheduledController, env: Env): Promise<void> {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { results } = await env.DB.prepare(
      "SELECT id, attempts FROM slips WHERE status IN ('queued','processing') AND updated_at < ? LIMIT 500",
    ).bind(cutoff).all<{ id: string; attempts: number }>();
    const ids: string[] = [];
    for (const r of results || []) {
      if (r.attempts >= MAX_ATTEMPTS) {
        await env.DB.prepare("UPDATE slips SET status = 'error', error = COALESCE(error, 'Timed out'), updated_at = ? WHERE id = ?").bind(now(), r.id).run();
      } else {
        await env.DB.prepare("UPDATE slips SET status = 'queued', updated_at = ? WHERE id = ?").bind(now(), r.id).run();
        ids.push(r.id);
      }
    }
    await startReading(env, ids);
  },
};
