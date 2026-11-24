import Anthropic from "@anthropic-ai/sdk";
import {
  CORE_KEYS, DEPARTMENT_FOR_SECTION, READING_JSON_SCHEMA, READING_KEYS, computeTotal, emptyFields, formatDate,
  parseMoney, routeFromBox, toWesternDigits, type FieldKey, type Fields, type SlipReading,
} from "./fields";
import { vocabText, type Alias } from "./vocab";

export interface OcrEnv {
  AI: Ai;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  VISION_MODELS?: string;
  MERGE_MODEL?: string;
}

export interface OcrResult {
  engine: string;
  fields: Fields;
  extras: Record<string, unknown>;
  review: FieldKey[];
  raw: unknown;
}

const SLIP_LAYOUT = `The photo is a "GUEST TRANSPORT SLIP" of Jamiyat Faiz Husaini, Karbala (جمعية فيض حسيني - كربلاء المعلى). Handwriting is mostly Arabic (Iraqi drivers); numbers are usually Western digits.

Printed fields on the slip, top to bottom:
- Date, Pax (number of passengers)
- Guest Name, Driver Name, Car type
- "DEPARTMENT WORK" tick boxes: Baghdad Airport, Najaf dept work, Najaf Airport, Baghdad dept work, Karbala Dakhili - dept work, and "Others:" followed by a handwritten line
- "KG PERSONAL BARNAMAJ" tick boxes: Najaf Ziyarat, Outside Karbala, Atraaf Karbala, Baghdad Ziyarat, Karbala Dakhili, and "Others:" followed by a handwritten line
- Barnaamaj start time, End Time
- FOR OFFICE USE tick boxes: During Dawaam, Overtime
- Kg Signature
- Bottom block, laid out right-to-left in two columns. Each Arabic label ends with a colon and its handwritten value is written to the LEFT of that label, on the same line:
    right column, top:    تحويل بنزين:  (petrol)        left column, top:    كراج:  (garage = parking)
    right column, middle: وجبة طعام:  (meal)           left column, middle: وغير ذلك:  (other / misc)
    right column, bottom: امضاء السائق:  (driver signature)   left column, bottom: امضاء المسؤول:  (supervisor signature)
  A number written just left of "تحويل بنزين:" is the PETROL amount, even if it sits close to the كراج column. Only a number written on the line left of "كراج:" (at the far left of the slip) is parking.

Note: text written on an "Others:" line belongs to the section the line is in, even if no box is ticked.`;

const OUTPUT_RULES = `Rules:
- Copy Arabic exactly as written into the *_ar fields; put the English (CAPITAL letters) into the *_en fields, using the known spellings below when the handwriting matches one.
- Checked lists contain the printed English names of boxes that are ticked/crossed/circled (e.g. "Najaf Airport"). Empty list if none.
- Money fields: digits only, no commas (e.g. "32000"). Times as written (e.g. "9:00").
- office_use: "During Dawaam", "Overtime" or "".
- Use "" for anything left blank. Never invent values that are not written.
- unclear_fields: keys whose handwriting you could not read with confidence.`;

const JSON_SHAPE = `{"date":"","pax":"","guest_name_ar":"","guest_name_en":"","driver_name_ar":"","driver_name_en":"","car_type_ar":"","car_type_en":"","department_work_checked":[],"department_work_other_ar":"","department_work_other_en":"","kg_barnamaj_checked":[],"kg_barnamaj_other_ar":"","kg_barnamaj_other_en":"","start_time":"","end_time":"","office_use":"","petrol":"","parking":"","meal":"","other_amount":"","other_text_ar":"","other_text_en":"","kg_signed":false,"driver_signed":false,"supervisor_signed":false,"unclear_fields":[]}`;

function visionPrompt(vocab: string): string {
  return `${SLIP_LAYOUT}\n\n${OUTPUT_RULES}\n\nKnown spellings:\n${vocab}\n\nReturn ONLY one JSON object with exactly these keys:\n${JSON_SHAPE}`;
}

function mergePrompt(vocab: string, readings: unknown[]): string {
  return `Several OCR engines read the same handwritten Arabic transport slip and their readings differ. Work out the most likely true value of every field.
- Handwriting OCR often confuses similar letter shapes: م/ق/ف/ح/ج, ب/ي/ت/ن/ث, س/ش, د/ر/ز/و, ه/ة, ا/ل. Look for the word that best explains all readings.
- Prefer a known name/place from the list below when the readings plausibly match it.
- A value supported by most engines usually wins; ignore an engine that is clearly off.
- Text written on an "Others" line is kept even if engines disagree on which box is ticked.
- Give English in CAPITAL letters, numbers as digits without commas.

Known spellings:
${vocab}

Readings (JSON, one per engine):
${readings.map((r, i) => `#${i + 1}: ${JSON.stringify(r)}`).join("\n")}

Return ONLY one JSON object with exactly these keys (unclear_fields = keys you are still not sure about):
${JSON_SHAPE}`;
}

export function extractJson(text: string): any {
  if (!text) throw new Error("empty model response");
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no JSON in model response");
  t = t.slice(a, b + 1);
  try {
    return JSON.parse(t);
  } catch {
    return JSON.parse(t.replace(/,\s*([}\]])/g, "$1"));
  }
}

function textOf(res: any): string {
  if (!res) return "";
  if (typeof res === "string") return res;
  if (typeof res.response === "string") return res.response;
  if (res.response && typeof res.response === "object") return JSON.stringify(res.response);
  const c = res.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => p.text || "").join("");
  if (Array.isArray(res.output)) {
    return res.output.flatMap((o: any) => o.content || []).map((p: any) => p.text || "").join("");
  }
  return "";
}

function normalizeReading(r: any): SlipReading {
  const out: any = {};
  for (const k of READING_KEYS) {
    const v = r?.[k];
    if (k.endsWith("_checked") || k === "unclear_fields") out[k] = Array.isArray(v) ? v.map(String) : v ? [String(v)] : [];
    else if (k.endsWith("_signed")) out[k] = v === true || v === "true";
    else out[k] = v === null || v === undefined ? "" : String(v).trim();
  }
  return out as SlipReading;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${label} took longer than ${Math.round(ms / 1000)}s`)), ms); }),
  ]);
}

// Workers AI sometimes answers "busy" (rate limit / capacity) when many slips are read at once.
async function retryBusy<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      const busy = /429|capacity|rate.?limit|too many|3040|overloaded|unavailable/i.test(msg) && !/took longer|timeout|3046/i.test(msg);
      if (!busy || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 4000 * attempt + Math.random() * 3000));
    }
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

async function readWithWorkersAI(env: OcrEnv, model: string, prompt: string, dataUrl: string): Promise<SlipReading> {
  const res = await withTimeout(retryBusy(() => withTimeout(env.AI.run(model as any, {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 6000,
    temperature: 0,
  } as any), 150_000, model)), 180_000, model);
  return normalizeReading(extractJson(textOf(res)));
}

async function mergeWithWorkersAI(env: OcrEnv, model: string, vocab: string, readings: SlipReading[]): Promise<SlipReading> {
  // Keep the merge input small: drop booleans/empty values that every engine agrees on.
  const slim = readings.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === "unclear_fields") continue;
      if (v === "" || (Array.isArray(v) && v.length === 0)) continue;
      o[k] = v;
    }
    return o;
  });
  const res = await withTimeout(retryBusy(() => withTimeout(env.AI.run(model as any, {
    messages: [{ role: "user", content: mergePrompt(vocab, slim) }],
    max_tokens: 8000,
    temperature: 0,
  } as any), 90_000, "merge")), 120_000, "merge");
  return normalizeReading(extractJson(textOf(res)));
}

async function readWithClaude(env: OcrEnv, prompt: string, b64: string, mediaType: string): Promise<SlipReading> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const client2 = client.withOptions({ timeout: 90_000, maxRetries: 1 });
  const response = await client2.messages.create({
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium", format: { type: "json_schema", schema: READING_JSON_SCHEMA as any } },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg", data: b64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to read this slip");
  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return normalizeReading(extractJson(text));
}

// ---- reading -> sheet row ---------------------------------------------------------

const READING_TO_FIELD: Partial<Record<keyof SlipReading, FieldKey>> = {
  date: "date",
  guest_name_en: "group",
  guest_name_ar: "group",
  driver_name_en: "driver_name",
  driver_name_ar: "driver_name",
  car_type_en: "vehicle",
  car_type_ar: "vehicle",
  petrol: "petrol_cash",
  parking: "parking",
  meal: "meal",
  other_amount: "raseed_misc",
  department_work_checked: "route",
  department_work_other_ar: "route",
  department_work_other_en: "route",
  kg_barnamaj_checked: "route",
  kg_barnamaj_other_ar: "route",
  kg_barnamaj_other_en: "route",
};

const clean = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();

export function readingToFields(r: SlipReading): { fields: Fields; extras: Record<string, unknown> } {
  const f = emptyFields();
  f.date = formatDate(r.date);
  f.group = clean(r.guest_name_en || r.guest_name_ar);
  f.driver_name = clean(r.driver_name_en || r.driver_name_ar);
  f.vehicle = clean(r.car_type_en || r.car_type_ar);

  const deptUsed = r.department_work_checked.length > 0 || !!(r.department_work_other_ar || r.department_work_other_en);
  const kgUsed = r.kg_barnamaj_checked.length > 0 || !!(r.kg_barnamaj_other_ar || r.kg_barnamaj_other_en);
  if (kgUsed && !deptUsed) f.department = DEPARTMENT_FOR_SECTION.kg_barnamaj;
  else if (deptUsed && !kgUsed) f.department = DEPARTMENT_FOR_SECTION.department_work;
  else if (deptUsed && kgUsed) f.department = DEPARTMENT_FOR_SECTION.kg_barnamaj;

  const routes: string[] = [];
  for (const box of [...r.department_work_checked, ...r.kg_barnamaj_checked]) {
    if (/other/i.test(box)) continue;
    const code = routeFromBox(box);
    if (code && !routes.includes(code)) routes.push(code);
  }
  for (const other of [r.department_work_other_en || r.department_work_other_ar, r.kg_barnamaj_other_en || r.kg_barnamaj_other_ar]) {
    if (other && !routes.includes(clean(other))) routes.push(clean(other));
  }
  f.route = routes.join(" / ");

  f.petrol_cash = parseMoney(r.petrol);
  f.parking = parseMoney(r.parking);
  f.meal = parseMoney(r.meal);
  f.raseed_misc = parseMoney(r.other_amount);

  const remarks: string[] = [];
  const other = r.other_text_en || r.other_text_ar;
  if (other) remarks.push(clean(other));
  if (/overtime/i.test(r.office_use)) remarks.push("OVERTIME");
  f.remarks = remarks.join(" | ");
  f.gr_total = computeTotal(f);

  const extras = {
    pax: toWesternDigits(r.pax),
    start_time: toWesternDigits(r.start_time),
    end_time: toWesternDigits(r.end_time),
    office_use: r.office_use,
    guest_name_ar: r.guest_name_ar,
    driver_name_ar: r.driver_name_ar,
    car_type_ar: r.car_type_ar,
    route_ar: [r.department_work_other_ar, r.kg_barnamaj_other_ar].filter(Boolean).join(" / "),
    other_text_ar: r.other_text_ar,
    boxes: [...r.department_work_checked, ...r.kg_barnamaj_checked],
    kg_signed: r.kg_signed,
    driver_signed: r.driver_signed,
    supervisor_signed: r.supervisor_signed,
  };
  return { fields: f, extras };
}

const MONEY_VOTE: [keyof SlipReading, FieldKey][] = [["petrol", "petrol_cash"], ["parking", "parking"], ["meal", "meal"], ["other_amount", "raseed_misc"]];

// Tick boxes and amounts are decided by majority vote of the engines (the merge model tends to
// accept a tick or an amount that only one engine imagined).
function applyVotes(readings: SlipReading[], merged: SlipReading, review: Set<FieldKey>): SlipReading {
  const n = readings.length;
  const need = n >= 3 ? 2 : n; // 3 engines: 2 must agree; 2 engines: both must agree
  const out: SlipReading = { ...merged };
  for (const key of ["department_work_checked", "kg_barnamaj_checked"] as const) {
    const votes = new Map<string, number>();
    for (const r of readings) for (const b of new Set(r[key].map((x) => x.trim().toLowerCase()))) votes.set(b, (votes.get(b) || 0) + 1);
    out[key] = [...votes.entries()].filter(([, c]) => c >= need).map(([b]) => b);
  }
  // Text the merge model dropped although an engine read something: keep the most common reading and flag it.
  const TEXT_PAIRS: [keyof SlipReading, keyof SlipReading, FieldKey][] = [
    ["guest_name_ar", "guest_name_en", "group"],
    ["driver_name_ar", "driver_name_en", "driver_name"],
    ["car_type_ar", "car_type_en", "vehicle"],
    ["department_work_other_ar", "department_work_other_en", "route"],
    ["kg_barnamaj_other_ar", "kg_barnamaj_other_en", "route"],
    ["other_text_ar", "other_text_en", "remarks"],
  ];
  for (const [ar, en, fk] of TEXT_PAIRS) {
    if ((out[ar] as string) || (out[en] as string)) continue;
    const seen = readings.filter((r) => (r[ar] as string) || (r[en] as string));
    if (!seen.length) continue;
    const pick = seen.find((r) => r[en]) || seen[0];
    (out as any)[ar] = pick[ar];
    (out as any)[en] = pick[en];
    review.add(fk);
  }
  for (const [rk, fk] of MONEY_VOTE) {
    const votes = new Map<string, number>();
    for (const r of readings) {
      const v = parseMoney(r[rk] as string);
      votes.set(v, (votes.get(v) || 0) + 1);
    }
    const [best, count] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (count >= need) (out as any)[rk] = best;
    else {
      (out as any)[rk] = parseMoney(merged[rk] as string);
      review.add(fk);
    }
  }
  return out;
}

// Which sheet fields the engines disagreed on (after converting each reading to a row).
function disagreements(rows: Fields[]): Set<FieldKey> {
  const out = new Set<FieldKey>();
  if (rows.length < 2) return out;
  const keys: FieldKey[] = ["date", "group", "department", "route", "driver_name", "vehicle", "petrol_cash", "parking", "meal", "raseed_misc"];
  for (const k of keys) {
    const vals = rows.map((r) => (r[k] || "").replace(/[^A-Z0-9]/gi, "").toUpperCase());
    const counts = new Map<string, number>();
    for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
    const top = Math.max(...counts.values());
    // Flag unless a clear majority (all agree, or >= 2/3 agree on a non-empty value)
    if (top < Math.ceil((rows.length * 2) / 3)) out.add(k);
  }
  return out;
}

export async function ocrSlip(env: OcrEnv, image: ArrayBuffer, mediaType: string, aliases: Alias[]): Promise<OcrResult> {
  const vocab = vocabText(aliases);
  const prompt = visionPrompt(vocab);
  const b64 = toBase64(new Uint8Array(image));
  const review = new Set<FieldKey>();
  let final: SlipReading;
  let engine: string;
  let raw: unknown;

  let claude: SlipReading | null = null;
  let claudeError = "";
  if (env.ANTHROPIC_API_KEY) {
    try {
      claude = await readWithClaude(env, prompt, b64, mediaType);
    } catch (e) {
      // Bad key, no credit, or Claude unavailable: fall back to Cloudflare AI so slips still get read.
      claudeError = String((e as Error)?.message || e).slice(0, 500);
    }
  }
  if (claude) {
    engine = env.CLAUDE_MODEL || "claude-opus-5-5";
    final = claude;
    raw = { claude };
  } else {
    const models = (env.VISION_MODELS || "@cf/qwen/qwen3.8-27b,@cf/meta/llama-4-scout-17b-16e-instruct,@cf/google/gemma-4-26b-a4b-it")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const dataUrl = `data:${mediaType};base64,${b64}`;
    const settled = await Promise.allSettled(models.map((m) => readWithWorkersAI(env, m, prompt, dataUrl)));
    const readings: SlipReading[] = [];
    const errors: string[] = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") readings.push(s.value);
      else errors.push(`${models[i]}: ${String(s.reason?.message || s.reason)}`);
    });
    if (readings.length === 0) throw new Error("All OCR models failed: " + errors.join(" | "));
    const mergeModel = env.MERGE_MODEL || "@cf/openai/gpt-oss-120b";
    if (readings.length > 1) {
      try {
        final = await mergeWithWorkersAI(env, mergeModel, vocab, readings);
      } catch (e) {
        errors.push(`merge: ${String((e as Error).message)}`);
        final = readings[0];
      }
      final = applyVotes(readings, final, review);
      // With several engines, "unclear" is decided by whether the engines disagree, not by the merge model's own guess.
      final.unclear_fields = [];
      for (const k of disagreements(readings.map((r) => readingToFields(r).fields))) {
        // money fields are settled by the vote above; only names, places and dates go to review here
        if (!MONEY_VOTE.some(([, f]) => f === k)) review.add(k);
      }
    } else {
      final = readings[0];
    }
    engine = `workers-ai x${readings.length}` + (claudeError ? " (Claude failed: " + claudeError.slice(0, 120) + ")" : "");
    raw = { readings, merged: final, errors, claudeError };
  }

  const { fields, extras } = readingToFields(final);
  for (const u of final.unclear_fields) {
    const k = READING_TO_FIELD[u as keyof SlipReading];
    if (k) review.add(k);
  }
  for (const k of CORE_KEYS) if (!fields[k]) review.add(k);
  if (!fields.gr_total) review.add("gr_total");
  return { engine, fields, extras, review: [...review], raw };
}
