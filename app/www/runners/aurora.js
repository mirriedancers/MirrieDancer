// Mirrie Dancers background check. Android runs this about every 30 minutes, even with the app
// closed, in a small JavaScript engine with no page: only fetch, CapacitorKV and CapacitorNotifications.
// The page sends settings with the "configure" event; "checkAurora" is the timed check.
// The chance uses the site's own model for one place: Kp needed at your magnetic latitude, the
// solar wind's Bz for the next 2 hours, darkness and cloud. (No OVATION grid: ~1 MB a check is too much data.)

const HOUR = 3600000;
const KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json";
const MAG_URL = "https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rad = (d) => d * Math.PI / 180;
const sig = (x) => 1 / (1 + Math.exp(-x));

function sunAlt(t, lat, lon) {
  const d = t / 86400000 - 10957.5;
  const g = rad(357.529 + 0.98560028 * d), q = 280.459 + 0.98564736 * d;
  const L = rad(q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
  const e = rad(23.439 - 0.00000036 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const H = rad(gmst * 15 + lon) - ra;
  return Math.asin(Math.sin(rad(lat)) * Math.sin(dec) + Math.cos(rad(lat)) * Math.cos(dec) * Math.cos(H)) * 180 / Math.PI;
}
function magLat(lat, lon) {
  const pl = rad(80.8), pn = rad(-72.6), f = rad(lat), l = rad(lon);
  return Math.asin(Math.sin(f) * Math.sin(pl) + Math.cos(f) * Math.cos(pl) * Math.cos(l - pn)) * 180 / Math.PI;
}
const kpNeedAt = (lat, lon) => clamp((69.8 - Math.abs(magLat(lat, lon)) - (lat < 0 ? 4 : 0)) / 2.04, 1, 9);
const darkness = (t, lat, lon) => { const a = sunAlt(t, lat, lon); return a <= -12 ? 1 : a >= -6 ? 0 : (-6 - a) / 6; };

function parseKp(j) {
  let rows = j;
  if (Array.isArray(j) && Array.isArray(j[0])) { const h = j[0]; rows = j.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]))); }
  return rows.map(r => ({ t: Date.parse(String(r.time_tag).replace(" ", "T") + (/Z$/.test(r.time_tag) ? "" : "Z")), kp: parseFloat(r.kp) }))
    .filter(r => isFinite(r.t) && isFinite(r.kp)).sort((a, b) => a.t - b.t);
}
function kpAt(rows, t) {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].t <= t) return t - rows[i].t < 3 * HOUR ? rows[i].kp : null;
  return null;
}
async function getJSON(url) {
  const r = await fetch(url);
  if (r.status && r.status >= 400) throw new Error("HTTP " + r.status);
  return JSON.parse(await r.text());
}
const kvGet = (k) => { try { const v = CapacitorKV.get(k); const s = v && typeof v === "object" ? v.value : v; return s ? JSON.parse(s) : null; } catch (e) { return null; } };
const kvSet = (k, v) => CapacitorKV.set(k, JSON.stringify(v));
// "HH:MM" in the phone's own time (the engine has no Intl, so the page sends its UTC offset)
const hhmm = (t, offMin) => { const d = new Date(t + (offMin || 0) * 60000); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); };

// The chance for each of the next 10 hours at one place. Exported for the self-test.
async function forecast(s, now, get) {
  const cur = Math.floor(now / HOUR) * HOUR, hours = Array.from({ length: 10 }, (_, k) => cur + k * HOUR);
  if (!hours.some(t => darkness(t, s.lat, s.lon) > 0)) return null; // daylight all the way: nothing to fetch
  const kp = parseKp(await get(KP_URL));
  let bz = null;
  try { const m = await get(MAG_URL); const r = Array.isArray(m) ? m[0] : m; bz = parseFloat(r.bz_gsm ?? r.Bz); if (!isFinite(bz)) bz = null; } catch (e) { /* Bz is a nudge only */ }
  let cloud = null;
  try {
    const w = await get("https://api.open-meteo.com/v1/forecast?latitude=" + s.lat.toFixed(2) + "&longitude=" + s.lon.toFixed(2) + "&hourly=cloud_cover&forecast_days=2&timezone=GMT");
    cloud = { t0: Date.parse(w.hourly.time[0] + "Z"), cc: w.hourly.cloud_cover };
  } catch (e) { /* unknown cloud counts as patchy, as on the site */ }
  const need = kpNeedAt(s.lat, s.lon);
  return hours.map(t => {
    const k = kpAt(kp, t), ahead = (t - now) / HOUR;
    let act = k == null ? 0 : sig(1.5 * (k - need));
    if (bz != null && ahead > -1 && ahead < 2) act = clamp(act + (bz <= -10 ? 0.22 : bz <= -5 ? 0.12 : bz <= -2 ? 0.05 : bz >= 5 ? -0.08 : 0), 0, 1);
    const cc = cloud ? cloud.cc[Math.round((t - cloud.t0) / HOUR)] : null;
    const clear = cc == null ? 0.6 : Math.pow(1 - cc / 100, 1.3);
    return { t, p: Math.round(100 * act * darkness(t, s.lat, s.lon) * clear * 0.8), kp: k, cc: cc == null ? null : cc };
  });
}

// One alert per night, plus another if the chance climbs 20 points past the last alert.
function decide(s, hours, last, now) {
  if (!hours) return null;
  const best = hours.reduce((a, b) => (b.p > a.p ? b : a));
  if (best.p < (s.threshold || 35)) return null;
  const night = new Date(now - 12 * HOUR).toISOString().slice(0, 10); // the evening this night began
  if (last && last.night === night && best.p < last.p + 20) return null;
  const soon = best.t <= Math.floor(now / HOUR) * HOUR + HOUR;
  const where = s.place ? " near " + s.place : "";
  return {
    state: { night, p: best.p, at: now },
    title: (soon ? "Aurora chance " : "Aurora tonight: ") + best.p + "%" + where,
    body: (soon ? "It could be happening now. Get somewhere dark and look " + (s.lat < 0 ? "south" : "north") + "."
      : "Best around " + hhmm(best.t, s.tz) + ".") +
      (best.kp != null ? " Kp " + best.kp.toFixed(1) : "") + (best.cc != null ? ", cloud " + Math.round(best.cc) + "%" : "") + ". Tap for the best spots."
  };
}

function notify(n) {
  CapacitorNotifications.schedule([{ id: 1, title: n.title, body: n.body, scheduleAt: new Date(Date.now() + 1000), smallIcon: "ic_stat_aurora", autoCancel: true }]);
}

if (typeof addEventListener === "function") {
  addEventListener("configure", (resolve, reject, args) => {
    try { kvSet("settings", args || {}); resolve({ ok: true }); } catch (e) { reject(e); }
  });
  addEventListener("testAlert", (resolve, reject) => {
    try { notify({ title: "Mirrie Dancers alerts are on", body: "This is how an aurora alert will look. You'll get one when the chance near you passes your threshold." }); resolve({ ok: true }); } catch (e) { reject(e); }
  });
  addEventListener("checkAurora", async (resolve, reject) => {
    try {
      const s = kvGet("settings");
      if (!s || !s.on || !isFinite(s.lat) || !isFinite(s.lon)) return resolve({ skipped: "off" });
      const now = Date.now(), hours = await forecast(s, now, getJSON);
      const n = decide(s, hours, kvGet("lastAlert"), now);
      if (n) { notify(n); kvSet("lastAlert", n.state); }
      resolve({ best: hours ? Math.max(...hours.map(h => h.p)) : null, sent: !!n });
    } catch (e) { reject(e); }
  });
}
if (typeof module !== "undefined") module.exports = { forecast, decide, parseKp, kpNeedAt, darkness, hhmm };
