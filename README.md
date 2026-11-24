# Transport Slip Scanner

Photograph Faiz Husaini guest transport slips on a phone, let AI read them (Arabic handwriting is converted to English), check them on a dashboard, then send the rows to the **Krb Transport Faiz Vehicles** Google Sheet.

**Live app:** https://transport-scanner.tmoosabhoy6.workers.dev

- `#scan`: Scanner tab (opens by default on phones)
- `#review`: Dashboard tab (opens by default on computers)

There's no login. Anyone who has the link can use the app.

## How it works

1. **Scanner**: take photos one after another, or choose up to 200 from the gallery. Photos are shrunk on the phone and uploaded three at a time. Keep the page open until the upload count finishes. Reading happens on the server, so you can close the page after that.
2. **Reading**: every slip gets its own Cloudflare Workflow, so a batch is read in parallel. Three Cloudflare AI vision models read it independently, and a fourth model merges their readings. The merge step uses a list of known driver names, vehicles and places, plus spellings learned from your past corrections. Tick boxes and amounts need at least 2 of the 3 models to agree. Any field where the models disagree, or that is blank, is **underlined in red pen** on the dashboard.
3. **Dashboard**: click a row to see the photo next to the fields. Fix anything underlined, then press **Save and mark as checked** (or Ctrl+Enter), which opens the next slip that needs a look. When you mark a slip as checked, the app remembers its Arabic to English spellings for future slips.
4. **To the sheet**: select rows and use **Send to Google Sheet** (one-time setup under the sheet icon, top right). You can also use **Copy rows** and paste into the sheet, or **Download CSV**.

The "fields filled" figure on the dashboard is the missing-field rate. It counts Date, Group, Department, Route, Driver Name, Vehicle and Gr.Total across all slips that have been read.

## How slip fields map to sheet columns

| Slip | Sheet column |
|---|---|
| Date | Date (d/m/yyyy) |
| Guest Name | Group (ملا → M, شيخ → SH, سيد → SYED) |
| Section used: Department Work / KG Personal Barnamaj | Department: `STAFF` / `KG` |
| Ticked box or "Others" text | Route: Baghdad Airport `K-BA-K`, Najaf Airport `K-NA-K`, Najaf dept work / ziyarat `K-N-K`, Baghdad dept work / ziyarat `K-B-K`, Karbala Dakhili `K`, Atraaf `ATRAAF`, Others → English place name |
| Driver Name | Driver Name |
| Car type | Vehicle No./Name |
| تحويل بنزين | Petrol Cash |
| كراج | Parking |
| وجبة طعام | Meal |
| وغير ذلك | Raseed/Misc (any text goes in Remarks) |
| Overtime box | Remarks: OVERTIME |
| — | Gr.Total = sum of the amounts |

Pax, start/end time and "During Dawaam" aren't sheet columns. They're shown in the review panel. To change a mapping, edit `src/fields.ts`.

## Which AI reads the slips

With an `ANTHROPIC_API_KEY` secret on the Worker (set up), each slip is read in one pass by Claude Haiku 5.5, which takes about 10–15 seconds and costs roughly a tenth of a US cent per slip. If Claude is unavailable (for example, no credit on the Anthropic account), the app falls back to three Cloudflare AI models plus a merge step, so slips still get read.

To set or replace the key:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Add it in the Cloudflare dashboard as type **Secret** (not Text), or with the command above. The model is set by `CLAUDE_MODEL` in `wrangler.jsonc` (`claude-haiku-5-5`; `claude-opus-5-5` is more capable and about 40× the cost).

## Deploying

```bash
npm install
npx wrangler d1 execute transport-scanner --remote --file=schema.sql   # first time only
npx wrangler deploy
```

Cloudflare resources: Worker `transport-scanner`, D1 `transport-scanner` (slip data), KV `transport-scanner-images` (photos), Workflow `transport-scanner-ocr` (one instance per slip, so a batch of 200 is read in parallel), plus a 10-minute cron that restarts anything stuck.
