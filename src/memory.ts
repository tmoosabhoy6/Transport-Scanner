// The app's memory: every correction made in the dashboard is stored, then used on later slips
// (1) as lessons in the AI instructions and (2) to fix repeated text mistakes automatically.
import { COLUMNS, MONEY_KEYS, computeTotal, type FieldKey, type Fields } from "./fields";
import type { Alias } from "./vocab";

export interface Correction {
  id: number;
  field: string;
  ai_value: string;
  arabic: string;
  corrected: string;
  hits: number;
  updated_at: string;
}

export interface Memory {
  corrections: Correction[];
  aliases: Alias[];
}

// Text fields that may be fixed automatically when the AI repeats a mistake it was corrected on.
const AUTO_FIX: FieldKey[] = ["group", "department", "route", "driver_name", "vehicle", "remarks"];
// Where the Arabic original of a field is kept in a slip's extras.
export const ARABIC_FOR: Partial<Record<FieldKey, string>> = {
  group: "guest_name_ar",
  driver_name: "driver_name_ar",
  vehicle: "car_type_ar",
  route: "route_ar",
  remarks: "other_text_ar",
};

const label = (k: string) => COLUMNS.find((c) => c.key === k)?.label || k;
const norm = (s: string) => String(s || "").trim().toUpperCase();
const normAr = (s: string) => String(s || "").replace(/[ً-ْـ]/g, "").replace(/\s+/g, " ").trim();

export async function loadMemory(db: D1Database): Promise<Memory> {
  const [c, a] = await db.batch([
    db.prepare("SELECT * FROM corrections ORDER BY hits DESC, updated_at DESC LIMIT 400"),
    db.prepare("SELECT kind, arabic, english FROM aliases ORDER BY hits DESC, updated_at DESC LIMIT 300"),
  ]);
  return { corrections: (c.results || []) as unknown as Correction[], aliases: (a.results || []) as unknown as Alias[] };
}

// Lessons written into the AI instructions (most frequent and most recent first).
export function lessonsText(mem: Memory): string {
  const lines: string[] = [];
  for (const c of mem.corrections.slice(0, 60)) {
    const times = c.hits > 1 ? ` (corrected ${c.hits} times)` : "";
    if (c.field.startsWith("move:")) {
      const [from, to] = c.field.slice(5).split(">");
      lines.push(`- An amount you put under ${label(from)} actually belonged under ${label(to)}${times}. Check which label the number is written next to.`);
    } else {
      const ar = c.arabic ? ` (written ${c.arabic})` : "";
      const from = c.ai_value ? `"${c.ai_value}"` : "nothing";
      const to = c.corrected ? `"${c.corrected}"` : "blank (it is not on the slip)";
      lines.push(`- ${label(c.field)}${ar}: you read ${from}, the correct value was ${to}${times}.`);
    }
  }
  if (!lines.length) return "";
  return `Corrections the office made to earlier slips. Learn from them and do not repeat these mistakes:\n${lines.join("\n")}`;
}

// For a field and the AI's value, the remembered right answer if the memory is clear about it.
function remembered(mem: Memory, field: FieldKey, aiValue: string, arabic: string): string | null {
  const v = norm(aiValue);
  const ar = normAr(arabic);
  const matches = mem.corrections.filter(
    (c) => c.field === field && norm(c.ai_value) === v && (!c.arabic || !ar || normAr(c.arabic) === ar),
  );
  if (!matches.length) return null;
  const total = matches.reduce((n, c) => n + c.hits, 0);
  const best = [...matches].sort((a, b) => b.hits - a.hits || b.updated_at.localeCompare(a.updated_at))[0];
  // Use it only when it outweighs every other answer given for the same reading.
  return best.hits * 2 > total ? best.corrected : null;
}

const ALIAS_KIND: Partial<Record<FieldKey, string>> = { group: "group", driver_name: "driver", vehicle: "vehicle", route: "place" };

// Apply the memory to a freshly read slip. Returns the fixed fields and which ones were changed.
export function applyMemory(mem: Memory, fields: Fields, extras: Record<string, any>): { fields: Fields; fixed: Record<string, string> } {
  const out = { ...fields };
  const fixed: Record<string, string> = {};
  for (const k of AUTO_FIX) {
    const arabic = String(extras[ARABIC_FOR[k] || ""] || "");
    let fix = remembered(mem, k, out[k], arabic);
    // A confirmed Arabic -> English spelling for this exact handwriting
    if (fix === null && arabic && ALIAS_KIND[k] && k !== "route") {
      const a = mem.aliases.find((x) => x.kind === ALIAS_KIND[k] && normAr(x.arabic) === normAr(arabic));
      if (a && norm(a.english) !== norm(out[k])) fix = a.english;
    }
    if (fix !== null && norm(fix) !== norm(out[k])) {
      fixed[k] = out[k];
      out[k] = fix;
    }
  }
  // Amounts the AI keeps putting in the wrong column
  for (const c of mem.corrections) {
    if (!c.field.startsWith("move:") || c.hits < 2) continue;
    const [from, to] = c.field.slice(5).split(">") as [FieldKey, FieldKey];
    if (out[from] && !out[to] && out[from] === c.ai_value) {
      out[to] = out[from];
      out[from] = "";
      fixed[to] = `moved from ${label(from)}`;
    }
  }
  if (Object.keys(fixed).length) out.gr_total = computeTotal(out);
  return { fields: out, fixed };
}

// Compare what the user saved against what the AI read and remember the differences.
export async function recordCorrections(
  db: D1Database,
  ai: Fields,
  before: Fields,
  after: Fields,
  extras: Record<string, any>,
): Promise<number> {
  const rows: [string, string, string, string][] = [];
  const changed = (k: FieldKey) => norm(before[k]) !== norm(after[k]);
  const moneyKeys = MONEY_KEYS as FieldKey[];

  // Amounts moved from one column to another
  const moved = new Set<FieldKey>();
  for (const from of moneyKeys) {
    if (!ai[from] || !changed(from) || after[from]) continue;
    const to = moneyKeys.find((k) => k !== from && !ai[k] && after[k] === ai[from] && changed(k));
    if (to) {
      rows.push([`move:${from}>${to}`, ai[from], "", ai[from]]);
      moved.add(from).add(to);
    }
  }

  for (const c of COLUMNS) {
    const k = c.key;
    if (k === "gr_total" || moved.has(k) || !changed(k)) continue;
    if (norm(after[k]) === norm(ai[k])) continue; // changed back to what the AI read
    if (!norm(ai[k])) continue; // filling in something the AI left blank is not a reading mistake
    const arabic = normAr(String(extras[ARABIC_FOR[k] || ""] || ""));
    rows.push([k, norm(ai[k]), arabic, norm(after[k])]);
  }
  if (!rows.length) return 0;
  const t = new Date().toISOString();
  await db.batch(
    rows.map(([field, aiValue, arabic, corrected]) =>
      db.prepare(
        `INSERT INTO corrections (field, ai_value, arabic, corrected, hits, updated_at) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(field, ai_value, arabic, corrected) DO UPDATE SET hits = corrections.hits + 1, updated_at = excluded.updated_at`,
      ).bind(field, aiValue, arabic, corrected, t),
    ),
  );
  return rows.length;
}
