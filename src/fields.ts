// Column layout of the "Krb Transport Faiz Vehicles" Google Sheet (F-FORMAT / FAIZ VEHICLES tabs).
// Keys are internal; labels are the exact sheet headers (spelling tidied).
export const COLUMNS = [
  { key: "date", label: "Date" },
  { key: "group", label: "Group" },
  { key: "department", label: "Department" },
  { key: "route", label: "Route" },
  { key: "driver_name", label: "Driver Name" },
  { key: "vehicle", label: "Vehicle No./Name" },
  { key: "petrol_cash", label: "Petrol Cash", money: true },
  { key: "petrol_card", label: "Petrol Card", money: true },
  { key: "meal", label: "Meal", money: true },
  { key: "wash", label: "Wash", money: true },
  { key: "parking", label: "Parking", money: true },
  { key: "dukhuliya", label: "Dukhuliya", money: true },
  { key: "mabeet", label: "Mabeet", money: true },
  { key: "arabana_puncture", label: "Arabana/Puncture", money: true },
  { key: "nida", label: "NIDA", money: true },
  { key: "raseed_misc", label: "Raseed/Misc", money: true },
  { key: "remarks", label: "Remarks" },
  { key: "taxi", label: "Taxi", money: true },
  { key: "gr_total", label: "Gr.Total", money: true },
  { key: "credit", label: "Credit", money: true },
  { key: "balance", label: "Balance", money: true },
  { key: "tour_id", label: "Tour ID" },
] as const;

export type FieldKey = (typeof COLUMNS)[number]["key"];
export type Fields = Record<FieldKey, string>;

export const MONEY_KEYS = COLUMNS.filter((c) => "money" in c && c.money && c.key !== "gr_total" && c.key !== "credit" && c.key !== "balance").map((c) => c.key);

// Fields that are always printed on the slip, so they count toward the "missing field" rate.
export const CORE_KEYS: FieldKey[] = ["date", "group", "department", "route", "driver_name", "vehicle"];

export function emptyFields(): Fields {
  const f = {} as Fields;
  for (const c of COLUMNS) f[c.key] = "";
  return f;
}

// What the OCR step returns (one reading of the slip).
export interface SlipReading {
  date: string;
  pax: string;
  guest_name_ar: string;
  guest_name_en: string;
  driver_name_ar: string;
  driver_name_en: string;
  car_type_ar: string;
  car_type_en: string;
  department_work_checked: string[];
  department_work_other_ar: string;
  department_work_other_en: string;
  kg_barnamaj_checked: string[];
  kg_barnamaj_other_ar: string;
  kg_barnamaj_other_en: string;
  start_time: string;
  end_time: string;
  office_use: string;
  petrol: string;
  parking: string;
  meal: string;
  other_amount: string;
  other_text_ar: string;
  other_text_en: string;
  kg_signed: boolean;
  driver_signed: boolean;
  supervisor_signed: boolean;
  unclear_fields: string[];
}

export const READING_KEYS: (keyof SlipReading)[] = [
  "date", "pax", "guest_name_ar", "guest_name_en", "driver_name_ar", "driver_name_en", "car_type_ar", "car_type_en",
  "department_work_checked", "department_work_other_ar", "department_work_other_en",
  "kg_barnamaj_checked", "kg_barnamaj_other_ar", "kg_barnamaj_other_en",
  "start_time", "end_time", "office_use", "petrol", "parking", "meal", "other_amount", "other_text_ar", "other_text_en",
  "kg_signed", "driver_signed", "supervisor_signed", "unclear_fields",
];

export const READING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: READING_KEYS,
  properties: {
    date: { type: "string" },
    pax: { type: "string" },
    guest_name_ar: { type: "string" },
    guest_name_en: { type: "string" },
    driver_name_ar: { type: "string" },
    driver_name_en: { type: "string" },
    car_type_ar: { type: "string" },
    car_type_en: { type: "string" },
    department_work_checked: { type: "array", items: { type: "string" } },
    department_work_other_ar: { type: "string" },
    department_work_other_en: { type: "string" },
    kg_barnamaj_checked: { type: "array", items: { type: "string" } },
    kg_barnamaj_other_ar: { type: "string" },
    kg_barnamaj_other_en: { type: "string" },
    start_time: { type: "string" },
    end_time: { type: "string" },
    office_use: { type: "string" },
    petrol: { type: "string" },
    parking: { type: "string" },
    meal: { type: "string" },
    other_amount: { type: "string" },
    other_text_ar: { type: "string" },
    other_text_en: { type: "string" },
    kg_signed: { type: "boolean" },
    driver_signed: { type: "boolean" },
    supervisor_signed: { type: "boolean" },
    unclear_fields: { type: "array", items: { type: "string" } },
  },
} as const;

// "21/11/26", "21-11-2026", "٢١/١١/٢٦" -> "21/11/2026" (day/month/year, same as the FAIZ VEHICLES tab)
export function formatDate(raw: string): string {
  if (!raw) return "";
  const s = toWesternDigits(raw).trim();
  const m = s.match(/(\d{1,2})\s*[\/\-.\\ ]\s*(\d{1,2})\s*[\/\-.\\ ]\s*(\d{2,4})/);
  if (!m) return s;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  let y = m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return s;
  if (y.length === 2) y = "20" + y;
  if (y.length === 3) return s;
  return `${d}/${mo}/${y}`;
}

export function toWesternDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

// "32,000" / "32.000" / "32 الف" -> "32000"
export function parseMoney(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  let s = toWesternDigits(String(raw)).trim();
  if (!s) return "";
  const thousand = /الف|ألف|k\b/i.test(s);
  s = s.replace(/[,\s]/g, "");
  // "32.000" written with a dot as thousands separator
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const m = s.match(/\d+(\.\d+)?/);
  if (!m) return "";
  let n = parseFloat(m[0]);
  if (thousand && n < 1000) n *= 1000;
  // IQD amounts on these slips are in thousands; "32" almost always means 32,000
  if (n > 0 && n < 250) n *= 1000;
  return String(Math.round(n));
}

export function computeTotal(f: Fields): string {
  let sum = 0;
  let any = false;
  for (const k of MONEY_KEYS) {
    const v = parseFloat(String(f[k] || "").replace(/,/g, ""));
    if (!isNaN(v)) {
      sum += v;
      any = true;
    }
  }
  return any ? String(sum) : "";
}

// Slip tick-box -> Route code used in the sheet
export const ROUTE_BY_BOX: Record<string, string> = {
  "baghdad airport": "K-BA-K",
  "najaf airport": "K-NA-K",
  "najaf dept work": "K-N-K",
  "baghdad dept work": "K-B-K",
  "karbala dakhili - dept work": "K",
  "karbala dakhili": "K",
  "najaf ziyarat": "K-N-K",
  "baghdad ziyarat": "K-B-K",
  "atraaf karbala": "ATRAAF",
  "outside karbala": "OUTSIDE KARBALA",
};

// Which section of the slip was used -> Department column
export const DEPARTMENT_FOR_SECTION = {
  department_work: "STAFF",
  kg_barnamaj: "KG",
} as const;

export function routeFromBox(box: string): string {
  const k = box.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  if (ROUTE_BY_BOX[k]) return ROUTE_BY_BOX[k];
  for (const [name, code] of Object.entries(ROUTE_BY_BOX)) if (k.includes(name)) return code;
  return "";
}
