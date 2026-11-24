(() => {
  "use strict";

  // ------------------------------------------------------------------ helpers
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtMoney = (v) => {
    if (v === "" || v == null) return "";
    const n = Number(String(v).replace(/,/g, ""));
    return isNaN(n) ? String(v) : n.toLocaleString("en-US");
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("json") ? await res.json() : await res.text();
    if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
    return body;
  }

  let toastTimer;
  function toast(msg, bad = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (bad ? " bad" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3200);
  }

  // Column definitions (same order as the Google Sheet)
  const COLUMNS = [
    ["date", "Date"], ["group", "Group"], ["department", "Department"], ["route", "Route"], ["driver_name", "Driver Name"],
    ["vehicle", "Vehicle No./Name"], ["petrol_cash", "Petrol Cash", 1], ["petrol_card", "Petrol Card", 1], ["meal", "Meal", 1],
    ["wash", "Wash", 1], ["parking", "Parking", 1], ["dukhuliya", "Dukhuliya", 1], ["mabeet", "Mabeet", 1],
    ["arabana_puncture", "Arabana/Puncture", 1], ["nida", "NIDA", 1], ["raseed_misc", "Raseed/Misc", 1], ["remarks", "Remarks"],
    ["taxi", "Taxi", 1], ["gr_total", "Gr.Total", 1], ["credit", "Credit", 1], ["balance", "Balance", 1], ["tour_id", "Tour ID"],
  ].map(([key, label, money]) => ({ key, label, money: !!money }));
  const CORE = ["date", "group", "department", "route", "driver_name", "vehicle"];
  const SUM_KEYS = ["petrol_cash", "petrol_card", "meal", "wash", "parking", "dukhuliya", "mabeet", "arabana_puncture", "nida", "raseed_misc", "taxi"];
  // Columns shown in the dashboard table
  const TABLE_COLS = ["date", "group", "department", "route", "driver_name", "vehicle", "petrol_cash", "meal", "parking", "raseed_misc", "remarks", "gr_total"];
  const ARABIC_FOR = { group: "guest_name_ar", driver_name: "driver_name_ar", vehicle: "car_type_ar", route: "route_ar", remarks: "other_text_ar" };

  // ------------------------------------------------------------------ routing
  function route() {
    let h = location.hash.replace("#", "");
    if (h !== "scan" && h !== "review") {
      h = matchMedia("(max-width: 700px)").matches ? "scan" : "review";
      history.replaceState(null, "", "#" + h);
    }
    $("#view-scan").hidden = h !== "scan";
    $("#view-review").hidden = h !== "review";
    $("#tab-scan").setAttribute("aria-selected", h === "scan");
    $("#tab-review").setAttribute("aria-selected", h === "review");
    if (h === "review") Dashboard.refresh(true);
    if (h === "scan") Scanner.resume();
  }
  window.addEventListener("hashchange", route);

  // ================================================================== SCANNER
  const Scanner = (() => {
    const CONCURRENCY = 3;
    const MAX_SIDE = 2200;
    let batch = null; // { id, total, uploaded, failed }
    let queue = [];
    let active = 0;
    let pollTimer = null;
    const thumbs = $("#thumbs");

    function newBatchId() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    async function compress(file) {
      let bmp;
      try {
        bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
        bmp = await new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = () => rej(new Error("This file is not a photo the browser can open"));
          img.src = URL.createObjectURL(file);
        });
      }
      const w = bmp.width, h = bmp.height;
      const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      const cw = Math.round(w * scale), ch = Math.round(h * scale);
      const canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      canvas.getContext("2d").drawImage(bmp, 0, 0, cw, ch);
      if (bmp.close) bmp.close();
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.86));
      // tiny preview for the progress grid
      const t = document.createElement("canvas");
      const ts = 120 / Math.max(cw, ch);
      t.width = Math.round(cw * ts); t.height = Math.round(ch * ts);
      t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
      return { blob, thumb: t.toDataURL("image/jpeg", 0.6) };
    }

    function addFiles(files) {
      files = [...files].filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
      if (!files.length) return;
      if (!batch) startBatch();
      for (const f of files) {
        const li = document.createElement("li");
        li.dataset.s = "waiting";
        thumbs.prepend(li);
        queue.push({ file: f, li });
      }
      batch.total += files.length;
      save();
      render();
      pump();
    }

    function startBatch() {
      batch = { id: newBatchId(), total: 0, uploaded: 0, failed: 0 };
      thumbs.innerHTML = "";
      save();
    }

    function save() { store.set("scan-batch", batch); }

    async function uploadOne(item) {
      item.li.dataset.s = "uploading";
      let prepared;
      try {
        prepared = await compress(item.file);
        const img = document.createElement("img");
        img.src = prepared.thumb; img.alt = "";
        item.li.appendChild(img);
      } catch (e) {
        item.li.dataset.s = "failed";
        batch.failed++;
        toast(`${item.file.name}: ${e.message}`, true);
        return;
      }
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const r = await api("/api/upload", {
            method: "POST",
            headers: { "content-type": "image/jpeg", "x-batch-id": batch.id, "x-file-name": encodeURIComponent(item.file.name || "") },
            body: prepared.blob,
          });
          item.li.dataset.s = "uploaded";
          item.li.dataset.id = r.id;
          batch.uploaded++;
          return;
        } catch (e) {
          if (attempt === 4) {
            item.li.dataset.s = "failed";
            batch.failed++;
            toast(`Could not upload ${item.file.name || "a photo"}. Check the connection and add it again.`, true);
          } else await sleep(1500 * attempt);
        }
      }
    }

    function pump() {
      while (active < CONCURRENCY && queue.length) {
        const item = queue.shift();
        active++;
        uploadOne(item).finally(() => {
          active--;
          save();
          render();
          pump();
        });
      }
      startPolling();
    }

    function startPolling() {
      if (pollTimer) return;
      const tick = async () => {
        if (!batch) return;
        try {
          const { counts } = await api(`/api/stats?batch=${encodeURIComponent(batch.id)}`);
          render(counts);
          const pending = counts.queued + counts.processing;
          if (!pending && !queue.length && !active) { clearInterval(pollTimer); pollTimer = null; }
        } catch { /* offline: try again next tick */ }
      };
      tick();
      pollTimer = setInterval(tick, 4000);
    }

    let lastCounts = { queued: 0, processing: 0, done: 0, error: 0 };
    function render(counts) {
      if (counts) lastCounts = counts;
      const box = $("#batch");
      if (!batch || !batch.total) { box.hidden = true; return; }
      box.hidden = false;
      const uploading = queue.length + active;
      const c = lastCounts;
      $("#b-up").textContent = uploading ? batch.uploaded : c.done;
      $("#b-total").textContent = batch.total;
      $("#b-sub").textContent = uploading ? "uploaded" : c.done >= batch.uploaded ? "read and ready on the dashboard" : "read so far";
      $("#m-up").style.width = (100 * batch.uploaded) / batch.total + "%";
      $("#m-done").style.width = (100 * c.done) / batch.total + "%";
      $("#b-legend-up").textContent = uploading ? `${uploading} uploading` : "All uploaded";
      $("#b-reading").textContent = c.queued + c.processing;
      $("#b-done").textContent = c.done;
      $("#b-err").textContent = c.error + batch.failed;
      $(".err-li").hidden = !(c.error + batch.failed);
      $("#b-note").textContent = uploading
        ? "Keep this page open until every photo is uploaded. Reading continues on the server after that, so you can close it."
        : c.queued + c.processing
          ? "Everything is uploaded. Slips are being read on the server, so you can close this page or keep scanning."
          : "This batch is finished. Check the results on the dashboard, or take more photos to add to it.";
    }

    function resume() {
      if (!batch) {
        const saved = store.get("scan-batch");
        if (saved && saved.total) batch = saved;
      }
      render();
      if (batch && batch.total) startPolling();
    }

    $("#cam-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
    $("#pick-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
    $("#b-new").addEventListener("click", () => {
      if (queue.length || active) { toast("Wait until this batch has finished uploading."); return; }
      startBatch();
      batch.total = 0;
      save();
      render();
    });
    window.addEventListener("beforeunload", (e) => { if (queue.length || active) { e.preventDefault(); e.returnValue = ""; } });

    return { resume };
  })();

  // ================================================================== DASHBOARD
  const Dashboard = (() => {
    let slips = [];
    let filter = "all";
    let search = "";
    let batchFilter = "";
    const selected = new Set();
    let timer = null;
    let loading = false;

    const head = $("#ledger-head");
    head.innerHTML =
      `<th class="chk"><input type="checkbox" id="chk-all" aria-label="Select all shown"></th>` +
      TABLE_COLS.map((k) => {
        const c = COLUMNS.find((x) => x.key === k);
        return `<th class="${c.money ? "num" : ""}">${esc(c.label)}</th>`;
      }).join("") +
      `<th>Status</th>`;

    function isFlag(s) { return s.status === "done" && !s.reviewed && s.review.length > 0; }
    function isReading(s) { return s.status === "queued" || s.status === "processing"; }

    function visible() {
      const q = search.trim().toLowerCase();
      return slips.filter((s) => {
        if (batchFilter && s.batch_id !== batchFilter) return false;
        if (filter === "flag" && !isFlag(s)) return false;
        if (filter === "reading" && !isReading(s)) return false;
        if (filter === "error" && s.status !== "error") return false;
        if (filter === "unsent" && (s.exported || s.status !== "done")) return false;
        if (q) {
          const hay = Object.values(s.fields).join(" ").toLowerCase() + " " + Object.values(s.extras || {}).join(" ");
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    }

    function stats() {
      const done = slips.filter((s) => s.status === "done");
      let filled = 0, total = 0;
      for (const s of done) {
        for (const k of [...CORE, "gr_total"]) { total++; if (String(s.fields[k] || "").trim()) filled++; }
      }
      const pct = total ? (100 * filled) / total : 0;
      $("#s-total").textContent = slips.length;
      $("#s-reading").textContent = slips.filter(isReading).length;
      $("#s-flag").textContent = slips.filter(isFlag).length;
      $("#s-fill").textContent = total ? (pct >= 99.95 ? "100" : pct.toFixed(1)) + "%" : "–";
      $("#s-fill-note").textContent = total ? `(${total - filled} blank of ${total})` : "";
      $(".stat.fill").classList.toggle("good", total > 0 && pct >= 95);
      $("#f-flag").textContent = slips.filter(isFlag).length || "";
      $("#f-reading").textContent = slips.filter(isReading).length || "";
      $("#f-error").textContent = slips.filter((s) => s.status === "error").length || "";
      $("#f-unsent").textContent = slips.filter((s) => s.status === "done" && !s.exported).length || "";
      const batches = [...new Set(slips.map((s) => s.batch_id))];
      const sel = $("#batch-filter");
      const cur = sel.value;
      sel.innerHTML = `<option value="">All batches</option>` + batches.map((b) => `<option ${b === cur ? "selected" : ""}>${esc(b)}</option>`).join("");
    }

    function statusCell(s) {
      if (s.status === "queued") return `<span class="state reading"><i class="dot"></i>Waiting to be read</span>`;
      if (s.status === "processing") return `<span class="state reading"><i class="dot"></i>Reading</span>`;
      if (s.status === "error") return `<span class="state error" title="${esc(s.error)}"><i class="dot"></i>Failed</span>`;
      if (s.exported) return `<span class="state sent"><i class="dot"></i>In sheet</span>`;
      if (isFlag(s)) return `<span class="state flag"><i class="dot"></i>${s.review.length} to check</span>`;
      return `<span class="state ok"><i class="dot"></i>${s.reviewed ? "Checked" : "Ready"}</span>`;
    }

    function render() {
      stats();
      const rows = visible();
      const body = $("#ledger-body");
      $("#empty").hidden = rows.length > 0;
      if (!rows.length) {
        $("#empty .empty-title").textContent = slips.length ? "Nothing matches this filter" : "No slips here yet";
      }
      body.innerHTML = rows.map((s) => {
        const cells = TABLE_COLS.map((k) => {
          const c = COLUMNS.find((x) => x.key === k);
          const v = s.fields[k];
          const flagged = s.status === "done" && !s.reviewed && s.review.includes(k);
          let txt = c.money ? fmtMoney(v) : esc(v);
          if (!v && s.status === "done" && CORE.includes(k)) txt = `<span class="missing">missing</span>`;
          if (isReading(s) && !v) txt = k === "group" ? `<span class="pending">Being read</span>` : "";
          if (s.status === "error" && !v && k === "group") txt = `<span class="missing">Couldn't read, open to fill in</span>`;
          const cls = [c.money ? "num" : "", k === "gr_total" ? "total" : "", flagged ? "pen" : ""].join(" ").trim();
          return `<td class="${cls}" title="${esc(v)}">${txt}</td>`;
        }).join("");
        return `<tr data-id="${s.id}" class="${selected.has(s.id) ? "sel" : ""}"><td class="chk"><input type="checkbox" ${selected.has(s.id) ? "checked" : ""} aria-label="Select slip"></td>${cells}<td>${statusCell(s)}</td></tr>`;
      }).join("");
      const all = $("#chk-all");
      all.checked = rows.length > 0 && rows.every((s) => selected.has(s.id));
      all.indeterminate = !all.checked && rows.some((s) => selected.has(s.id));
      renderBulk();
    }

    function renderBulk() {
      for (const id of [...selected]) if (!slips.some((s) => s.id === id)) selected.delete(id);
      $("#bulk").hidden = selected.size === 0;
      $("#bulk-count").textContent = `${selected.size} selected`;
    }

    async function refresh(force) {
      if (loading && !force) return;
      loading = true;
      try {
        const { slips: list } = await api("/api/slips");
        slips = list;
        render();
        Panel.sync();
      } catch (e) {
        toast("Could not load slips: " + e.message, true);
      } finally {
        loading = false;
      }
      clearTimeout(timer);
      const busy = slips.some(isReading);
      if (!$("#view-review").hidden) timer = setTimeout(() => { if (!document.hidden) refresh(); else refresh(); }, busy ? 4000 : 20000);
    }

    // events
    $("#ledger-body").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      const id = tr.dataset.id;
      if (e.target.closest("td.chk")) {
        if (e.target.type !== "checkbox") { const cb = tr.querySelector("input"); cb.checked = !cb.checked; }
        tr.querySelector("input").checked ? selected.add(id) : selected.delete(id);
        tr.classList.toggle("sel", selected.has(id));
        renderBulk();
        return;
      }
      Panel.open(id);
    });
    $("#chk-all").addEventListener("change", (e) => {
      for (const s of visible()) e.target.checked ? selected.add(s.id) : selected.delete(s.id);
      render();
    });
    $$(".seg button").forEach((b) => b.addEventListener("click", () => {
      filter = b.dataset.filter;
      $$(".seg button").forEach((x) => x.setAttribute("aria-pressed", x === b));
      render();
    }));
    $("#search").addEventListener("input", (e) => { search = e.target.value; render(); });
    $("#batch-filter").addEventListener("change", (e) => { batchFilter = e.target.value; render(); });

    function selectedSlips() {
      return slips.filter((s) => selected.has(s.id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    $("#bulk").addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-bulk]");
      if (!b) return;
      const action = b.dataset.bulk;
      const list = selectedSlips();
      const ids = list.map((s) => s.id);
      const ready = list.filter((s) => s.status === "done");
      try {
        if (action === "clear") { selected.clear(); render(); return; }
        if (action === "copy") {
          const tsv = ready.map((s) => COLUMNS.map((c) => String(s.fields[c.key] ?? "").replace(/[\t\n]/g, " ")).join("\t")).join("\n");
          await navigator.clipboard.writeText(tsv);
          toast(`Copied ${ready.length} rows. Click the first empty Date cell in the sheet and paste.`);
          return;
        }
        if (action === "csv") {
          location.href = "/api/export.csv?ids=" + encodeURIComponent(ready.map((s) => s.id).join(","));
          return;
        }
        if (action === "push") {
          if (!ready.length) { toast("Select slips that have finished reading."); return; }
          const flagged = ready.filter(isFlag).length;
          if (flagged && !confirm(`${flagged} of these slips still have fields marked in red pen. Send them anyway?`)) return;
          b.disabled = true;
          const r = await api("/api/push-sheet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ready.map((s) => s.id) }) });
          toast(`Sent ${r.appended} rows to “${r.sheet}”.`);
          selected.clear();
        } else if (action === "delete") {
          if (!confirm(`Delete ${ids.length} slips and their photos? This can't be undone.`)) return;
          await api("/api/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, action }) });
          toast(`Deleted ${ids.length} slips.`);
          selected.clear();
        } else {
          await api("/api/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, action }) });
          toast(action === "retry" ? `Reading ${ids.length} slips again.` : `Marked ${ids.length} slips as checked.`);
        }
        await refresh(true);
      } catch (err) {
        toast(err.message, true);
        if (/Connect the Google Sheet/.test(err.message)) Settings.open();
      } finally {
        b.disabled = false;
      }
    });

    return {
      refresh,
      get: (id) => slips.find((s) => s.id === id),
      list: () => visible(),
      replace(slip) { const i = slips.findIndex((s) => s.id === slip.id); if (i >= 0) slips[i] = slip; render(); },
      remove(id) { slips = slips.filter((s) => s.id !== id); selected.delete(id); render(); },
      isFlag,
    };
  })();

  // ================================================================== REVIEW PANEL
  const Panel = (() => {
    let current = null;
    let rotation = 0;
    const form = $("#p-form");

    function open(id) {
      const s = Dashboard.get(id);
      if (!s) return;
      current = id;
      rotation = 0;
      $("#scrim").hidden = false;
      $("#panel").hidden = false;
      document.body.style.overflow = "hidden";
      const img = $("#p-img");
      img.style.transform = "";
      $("#p-scroll").classList.remove("zoomed");
      img.src = `/api/slips/${id}/image`;
      fill(s);
      setTimeout(() => { const f = form.querySelector(".flagged input") || form.querySelector("input"); f && f.focus(); }, 60);
    }

    function close() {
      current = null;
      $("#scrim").hidden = true;
      $("#panel").hidden = true;
      document.body.style.overflow = "";
    }

    function fill(s) {
      form.dataset.status = s.status;
      const pos = Dashboard.list().findIndex((x) => x.id === s.id);
      $("#p-title").textContent = s.fields.group || s.fields.driver_name || "Slip";
      $("#p-sub").textContent = [s.fields.date, s.batch_id ? `batch ${s.batch_id}` : "", pos >= 0 ? `${pos + 1} of ${Dashboard.list().length}` : ""].filter(Boolean).join(", ");
      const msg = $("#p-msg");
      msg.hidden = true;
      if (s.status === "error") { msg.hidden = false; msg.className = "panel-msg"; msg.textContent = "Reading failed: " + (s.error || "unknown error") + ". Fill it in by hand or press Read again."; }
      else if (s.status !== "done") { msg.hidden = false; msg.className = "panel-msg info"; msg.textContent = "This slip is still being read. The fields fill in when it finishes."; }
      else if (Dashboard.isFlag(s)) { msg.hidden = false; msg.className = "panel-msg"; msg.textContent = `Fields underlined in red pen were hard to read. Compare them with the photo.`; }

      const flagged = s.status === "done" && !s.reviewed ? s.review : [];
      const html = [];
      COLUMNS.forEach((c, i) => {
        if (c.key === "petrol_cash") html.push(`<p class="form-sep">Amounts (IQD)</p>`);
        if (c.key === "credit") html.push(`<p class="form-sep">Usually not on the slip</p>`);
        const ar = s.extras && s.extras[ARABIC_FOR[c.key]];
        const wide = ["group", "route", "remarks"].includes(c.key);
        html.push(
          `<label class="field ${wide ? "wide" : ""} ${flagged.includes(c.key) ? "flagged" : ""}">` +
            `<span>${esc(c.label)}${ar ? `<i class="ar" lang="ar" dir="rtl" title="Written on slip">${esc(ar)}</i>` : ""}</span>` +
            `<input name="${c.key}" value="${esc(s.fields[c.key] || "")}" ${c.money ? 'inputmode="numeric"' : ""} ${c.key === "gr_total" ? 'placeholder="Adds up automatically"' : ""}>` +
          `</label>`,
        );
      });
      form.innerHTML = html.join("");

      const x = s.extras || {};
      const rows = [
        ["Pax", x.pax], ["Start time", x.start_time], ["End time", x.end_time], ["Office use", x.office_use],
        ["Ticked boxes", (x.boxes || []).join(", ")], ["Read by", s.engine],
      ].filter(([, v]) => v);
      $("#p-extras").innerHTML = rows.length ? `<dl style="display:contents">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : "";
      $("#p-extras").hidden = !rows.length;
      $("#p-check").disabled = s.status !== "done" && s.status !== "error";
    }

    // live total
    form.addEventListener("input", (e) => {
      if (!SUM_KEYS.includes(e.target.name)) return;
      let sum = 0, any = false;
      for (const k of SUM_KEYS) {
        const v = parseFloat(String(form.elements[k].value).replace(/,/g, ""));
        if (!isNaN(v)) { sum += v; any = true; }
      }
      form.elements.gr_total.value = any ? String(sum) : "";
    });
    form.addEventListener("input", (e) => e.target.closest(".field")?.classList.remove("flagged"));

    function values() {
      const out = {};
      for (const c of COLUMNS) out[c.key] = form.elements[c.key].value.trim();
      return out;
    }

    async function save(markChecked) {
      if (!current) return;
      const id = current;
      try {
        const body = { fields: values() };
        if (markChecked) body.reviewed = true;
        const { slip } = await api(`/api/slips/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        Dashboard.replace(slip);
        toast(markChecked ? "Saved and marked as checked." : "Saved.");
        return true;
      } catch (e) {
        toast(e.message, true);
        return false;
      }
    }

    function step(dir, onlyFlagged) {
      const list = Dashboard.list();
      let i = list.findIndex((s) => s.id === current);
      for (let n = 0; n < list.length; n++) {
        i += dir;
        if (i < 0 || i >= list.length) break;
        if (!onlyFlagged || Dashboard.isFlag(list[i])) return open(list[i].id);
      }
      if (onlyFlagged) { toast("No more slips need a look."); close(); }
    }

    $("#p-check").addEventListener("click", async () => { if (await save(true)) step(1, true); });
    $("#p-save").addEventListener("click", () => save(false));
    $("#p-retry").addEventListener("click", async () => {
      try {
        await api(`/api/slips/${current}/retry`, { method: "POST" });
        toast("Reading this slip again. It updates in about a minute.");
        Dashboard.refresh(true);
      } catch (e) { toast(e.message, true); }
    });
    $("#p-delete").addEventListener("click", async () => {
      if (!confirm("Delete this slip and its photo?")) return;
      const id = current;
      try {
        await api(`/api/slips/${id}`, { method: "DELETE" });
        step(1, false);
        if (current === id) close();
        Dashboard.remove(id);
        toast("Slip deleted.");
      } catch (e) { toast(e.message, true); }
    });
    $("#p-close").addEventListener("click", close);
    $("#scrim").addEventListener("click", close);
    $("#p-prev").addEventListener("click", () => step(-1, false));
    $("#p-next").addEventListener("click", () => step(1, false));
    $("#p-rotate").addEventListener("click", () => { rotation = (rotation + 90) % 360; $("#p-img").style.transform = `rotate(${rotation}deg)`; });
    const toggleZoom = () => $("#p-scroll").classList.toggle("zoomed");
    $("#p-zoom").addEventListener("click", toggleZoom);
    $("#p-img").addEventListener("click", (e) => {
      const sc = $("#p-scroll");
      const rect = e.target.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
      toggleZoom();
      if (sc.classList.contains("zoomed")) requestAnimationFrame(() => {
        sc.scrollLeft = fx * sc.scrollWidth - sc.clientWidth / 2;
        sc.scrollTop = fy * sc.scrollHeight - sc.clientHeight / 2;
      });
    });
    document.addEventListener("keydown", async (e) => {
      if (!current) return;
      if (e.key === "Escape") close();
      else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (await save(true)) step(1, true); }
      else if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); step(1, false); }
      else if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); step(-1, false); }
    });

    // When the list refreshes, update the open slip only if it was still being read.
    function sync() {
      if (!current) return;
      const s = Dashboard.get(current);
      if (!s) return close();
      const active = document.activeElement && form.contains(document.activeElement);
      if (!active && form.dataset.status !== s.status) fill(s);
      form.dataset.status = s.status;
    }

    return { open, sync };
  })();

  // ================================================================== SETTINGS
  const Settings = (() => {
    const dlg = $("#settings");
    const SCRIPT = `// Faiz transport slip scanner: adds rows sent from the scanner app.
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(data.sheet);
    if (!sh) return reply({ ok: false, error: 'No tab named ' + data.sheet });
    var norm = function (s) { return String(s).toUpperCase().replace(/[^A-Z]/g, ''); };
    var lastCol = sh.getLastColumn();
    var top = sh.getRange(1, 1, Math.min(6, sh.getLastRow()), lastCol).getValues();
    var hr = -1;
    for (var r = 0; r < top.length; r++) { if (top[r].map(norm).indexOf('DRIVERNAME') >= 0) { hr = r; break; } }
    if (hr < 0) return reply({ ok: false, error: 'Could not find the header row (Driver Name) in ' + data.sheet });
    var hdr = top[hr].map(norm);
    var cols = data.headers.map(function (h, i) { var j = hdr.indexOf(norm(h)); return (j < 0 && i === 0) ? 0 : j; });
    // first empty row after the last row that has a group, driver or vehicle
    var used = sh.getRange(1, 2, Math.max(sh.getLastRow(), 1), 5).getValues();
    var last = used.length;
    while (last > hr + 1 && used[last - 1].join('') === '') last--;
    var start = last + 1, n = data.rows.length;
    var range = sh.getRange(start, 1, n, lastCol);
    var vals = range.getValues(), forms = range.getFormulas();
    for (var i = 0; i < n; i++) {
      for (var k = 0; k < cols.length; k++) {
        var c = cols[k]; if (c < 0 || forms[i][c]) continue;
        var v = data.rows[i][k];
        if (k === 0 && /^\\d{1,2}\\/\\d{1,2}\\/\\d{4}$/.test(v)) { var p = v.split('/'); v = new Date(+p[2], +p[1] - 1, +p[0]); }
        vals[i][c] = v;
      }
      for (var c2 = 0; c2 < lastCol; c2++) if (forms[i][c2]) vals[i][c2] = forms[i][c2];
    }
    range.setValues(vals);
    return reply({ ok: true, appended: n, firstRow: start });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}
function reply(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
`;
    $("#script-code").textContent = SCRIPT;

    async function open() {
      $("#set-msg").hidden = true;
      try {
        const s = await api("/api/settings");
        $("#set-hook").value = s.sheet_webhook || "";
        $("#set-tab").value = s.sheet_tab || "FAIZ VEHICLES";
        $("#engine-note").textContent = s.engine === "claude"
          ? "Slips are read by Claude."
          : "Slips are read by Cloudflare AI (three models cross-check each slip). Adding an Anthropic API key makes Arabic handwriting more accurate.";
      } catch (e) { toast(e.message, true); }
      dlg.showModal();
    }
    $("#open-settings").addEventListener("click", open);
    $("#set-cancel").addEventListener("click", () => dlg.close());
    $("#copy-script").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(SCRIPT); toast("Code copied."); } catch { toast("Select the code and copy it by hand.", true); }
    });
    $("#set-save").addEventListener("click", async () => {
      const msg = $("#set-msg");
      try {
        await api("/api/settings", {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sheet_webhook: $("#set-hook").value, sheet_tab: $("#set-tab").value || "FAIZ VEHICLES" }),
        });
        dlg.close();
        toast("Google Sheet connected.");
      } catch (e) {
        msg.hidden = false;
        msg.textContent = e.message;
      }
    });
    return { open };
  })();

  route();
})();
