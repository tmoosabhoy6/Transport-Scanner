// Known spellings, used to steer the AI towards the same English spelling the sheet already uses.
// Extra Arabic -> English pairs are learned automatically from corrections made in the dashboard.

export const SEED_DRIVERS: [string, string][] = [
  ["ابو ابراهيم", "ABU IBRAHIM"],
  ["مرتضى مصطفى جبل", "MURTAZA MUSTAFA JABAL"],
  ["فراس عباس خعمان", "FARAS ABBAS KHAOMAN"],
  ["فراس عبد الامير", "FARAS ABDULAMIR"],
  ["عباس جلال فيصل", "ABBAS JALAL FAISAL"],
  ["وسام ياسر", "WESAAM YASIR"],
  ["حيدر حسين محمد", "HAIDER HUSSAIN MOHAMMED"],
  ["ابراهيم كاظم هادي", "IBRAHIM KAZIM HADI"],
  ["سمين راضي شعلان", "SAMIN RAZI SHALAAN"],
  ["سيد عماد", "SYED IMAD"],
  ["سيد حيدر", "SYED HAIDER"],
  ["خالد", "KHALID"],
  ["سلام", "SALAAM"],
  ["احمد", "AHMED"],
  ["رأفت", "RAAFAT"],
  ["محمد كريم", "MOHAMMAD KAREEM"],
  ["كاظم", "KAZIM"],
  ["صفاء", "SAFAA"],
  ["اياد", "AYAAD"],
  ["نعيم", "NAEEM"],
  ["يوسف", "YOUSUF"],
  ["حسين", "HUSAIN"],
  ["مرتضى", "MURTAZA"],
];

export const SEED_VEHICLES: [string, string][] = [
  ["بيكب / بيك اب", "PICKUP"],
  ["هايلوكس", "HILUX PICKUP"],
  ["كوستر", "COASTER"],
  ["كرنفال / كيا كرنفال", "CARNIVAL"],
  ["سنتافي / سانتافي", "SANTA FE"],
  ["سنتافي بيضاء", "WHITE SANTA FE"],
  ["برادو", "PRADO"],
  ["لاندكروز / لاندكروزر", "LANDCRUISER"],
  ["كنتر", "CANTER"],
  ["تكسي / تاكسي", "TAXI"],
  ["كاديلاك / كدلك", "CADILLAC"],
  ["لنكن", "LINCOLN"],
  ["باص", "BUS"],
  ["هايس", "HIACE"],
  ["ستاركس", "STAREX"],
];

export const SEED_PLACES: [string, string][] = [
  ["كربلاء", "KARBALA"],
  ["النجف", "NAJAF"],
  ["بغداد", "BAGHDAD"],
  ["الكاظمية", "KADHIMIYA"],
  ["الكوفة", "KUFA"],
  ["المسيب", "MUSAYEEB"],
  ["الحلة", "HILLA"],
  ["المحمودية / محمودية", "MAHMUDIYA"],
  ["الهندية / طويريج", "HINDIYA"],
  ["الاسكندرية", "ISKANDARIYA"],
  ["عين التمر", "AIN AL TAMR"],
  ["سامراء", "SAMARRA"],
  ["بلد", "BALAD"],
  ["الكوت", "KUT"],
  ["البصرة", "BASRA"],
  ["الحر", "AL HURR"],
  ["عون", "AWN"],
  ["اطراف", "ATRAAF"],
  ["مطار", "AIRPORT"],
  ["خان النص", "KHAN AL NUS"],
  ["الرزازة", "RAZZAZA"],
  ["الديوانية", "DIWANIYA"],
  ["المطار / مطار بغداد", "BAGHDAD AIRPORT"],
  ["مطار النجف", "NAJAF AIRPORT"],
];

export const TITLE_RULES = `Name style used in the sheet: ملا = "M" (e.g. ملا قاسم = "M QASIM"), شيخ = "SH", سيد = "SYED", سيدي = "SYEDI", حاج/حجي = "HAJI", ابو = "ABU", عبد ال... = "ABDUL...". Use Dawoodi Bohra style English spellings: حسين = HUSAIN, محمد = MOHAMMED, مصطفى = MUSTAFA, مرتضى = MURTAZA, قاسم = QASIM, طاهر = TAHER, عباس = ABBAS, علي = ALI, جعفر = JAFAR.`;

export interface Alias {
  kind: string;
  arabic: string;
  english: string;
}

export function vocabText(learned: Alias[]): string {
  const by = (kind: string) => learned.filter((a) => a.kind === kind).map((a) => [a.arabic, a.english] as [string, string]);
  const fmt = (pairs: [string, string][]) => pairs.map(([ar, en]) => `${ar} = ${en}`).join("; ");
  return [
    `Known drivers: ${fmt([...by("driver"), ...SEED_DRIVERS])}`,
    `Known guests/groups: ${fmt(by("group")) || "(none yet)"}`,
    `Vehicles: ${fmt([...by("vehicle"), ...SEED_VEHICLES])}`,
    `Places: ${fmt([...by("place"), ...SEED_PLACES])}`,
    TITLE_RULES,
  ].join("\n");
}
