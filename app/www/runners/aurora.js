// Mirrie Dancers background check. Android runs this about every 30 minutes, even with the app
// closed, in a small JavaScript engine with no page: only fetch, CapacitorKV and CapacitorNotifications.
// The page sends settings (your place and the dark-sky spots within 100 km) with the "configure" event;
// "checkAurora" is the timed check. Chances use the site's own model: Kp needed at each place's
// magnetic latitude, the live OVATION oval for the next ~90 minutes, the solar wind's Bz, darkness and cloud.
//
// Three tiers, each at most once a night (a tier may repeat after 3 hours), escalating only, 3 a night at most,
// all on one notification that updates in place:
//   1 Heads-up  tonight's best chance is 25%+ here or within 100 km (evenings, not after 23:00)
//   2 Go        50%+ here or within 50 km in the next ~2 hours
//   3 Under it  here, now: properly dark, mostly clear, the oval in your sky and the solar wind's Bz
//               held south (two checks in a row at -5 nT or lower, or one at -10), with a 50%+ chance

const HOUR = 3600000, MIN = 60000;
const KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json";
const MAG_URL = "https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json";
const OV_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";
const TIER1 = { p: 25, km: 100 }, TIER2 = { p: 50, km: 50 }, TIER3 = { p: 50, cloud: 40, ov: 15 };

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
const moonLight = (t) => { const P = 29.530588853, age = (((t - 947182440000) / 86400000) % P + P) % P; return (1 - Math.cos(2 * Math.PI * age / P)) / 2; };

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
// the OVATION grid as [lon 0..359][lat -90..90], and what's visible from a place: overhead or up to ~1000 km poleward
function parseOv(j) {
  const g = new Float32Array(360 * 181);
  for (const c of j.coordinates || []) { const lo = ((Math.round(c[0]) % 360) + 360) % 360, la = Math.round(c[1]) + 90; if (la >= 0 && la <= 180) g[lo * 181 + la] = c[2]; }
  return g;
}
function ovView(g, lat, lon) {
  let best = 0;
  const pole = lat < 0 ? -1 : 1;
  for (let dl = 0; dl <= 10; dl++) for (let dx = -1; dx <= 1; dx++) {
    const lo = ((Math.round(lon + dx) % 360) + 360) % 360, la = clamp(Math.round(lat + pole * dl) + 90, 0, 180);
    best = Math.max(best, g[lo * 181 + la] * (1 - dl / 13));
  }
  return best;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (r.status && r.status >= 400) throw new Error("HTTP " + r.status);
  return JSON.parse(await r.text());
}
const kvGet = (k) => { try { const v = CapacitorKV.get(k); const s = v && typeof v === "object" ? v.value : v; return s ? JSON.parse(s) : null; } catch (e) { return null; } };
const kvSet = (k, v) => CapacitorKV.set(k, JSON.stringify(v));
// the engine has no Intl, so the page sends the phone's UTC offset (minutes)
const local = (t, tz) => new Date(t + (tz || 0) * MIN);
const hhmm = (t, tz) => { const d = local(t, tz); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); };

// Everything a decision needs, for your place and up to 8 dark-sky spots within 100 km. Exported for the tests.
async function forecast(s, now, get, bzHist) {
  const cur = Math.floor(now / HOUR) * HOUR, hours = Array.from({ length: 12 }, (_, k) => cur + k * HOUR);
  const pts = [{ name: null, lat: s.lat, lon: s.lon, sky: 0.8, km: 0 }].concat((s.spots || []).filter(p => p.km <= TIER1.km).slice(0, 8));
  if (!hours.some(t => pts.some(p => darkness(t, p.lat, p.lon) > 0))) return null; // daylight all the way: nothing to fetch
  const kp = parseKp(await get(KP_URL));
  let bz = null;
  try {
    const m = await get(MAG_URL), r = Array.isArray(m) ? m[0] : m, at = Date.parse(String(r.time_tag || "").replace(" ", "T") + (/Z$/.test(r.time_tag || "") ? "" : "Z"));
    if (!(now - at > 30 * MIN)) bz = parseFloat(r.bz_gsm ?? r.Bz); // stale readings don't count
    if (!isFinite(bz)) bz = null;
  } catch (e) { /* Bz is a nudge and a gate only */ }
  const sustained = bz != null && (bz <= -10 || (bz <= -5 && (bzHist || []).some(h => now - h.t <= 75 * MIN && now - h.t >= 10 * MIN && h.bz <= -5)));
  // the 1 MB oval only on nights that are dark and stirring
  const kpNow = kpAt(kp, now);
  const stirring = (kpNow != null && kpNow >= kpNeedAt(s.lat, s.lon) - 1.5) || (bz != null && bz <= -3);
  let ov = null;
  if (stirring && pts.some(p => darkness(now, p.lat, p.lon) > 0)) { try { ov = parseOv(await get(OV_URL)); } catch (e) { /* Kp model alone */ } }
  let clouds = [];
  try {
    const w = await get("https://api.open-meteo.com/v1/forecast?latitude=" + pts.map(p => p.lat.toFixed(2)).join(",") + "&longitude=" + pts.map(p => p.lon.toFixed(2)).join(",") + "&hourly=cloud_cover&forecast_days=2&timezone=GMT");
    clouds = (Array.isArray(w) ? w : [w]).map(x => ({ t0: Date.parse(x.hourly.time[0] + "Z"), cc: x.hourly.cloud_cover }));
  } catch (e) { /* unknown cloud counts as patchy, as on the site */ }
  for (const [i, p] of pts.entries()) {
    const need = kpNeedAt(p.lat, p.lon), view = ov ? ovView(ov, p.lat, p.lon) : null, c = clouds[i];
    p.ov = view;
    p.series = hours.map(t => {
      const k = kpAt(kp, t), ahead = (t - now) / HOUR;
      let act = k == null ? 0 : sig(1.5 * (k - need));
      if (view != null && ahead > -1 && ahead < 1.5) act = 0.45 * act + 0.55 * clamp(view / 22, 0, 1);
      if (bz != null && ahead > -1 && ahead < 2) act = clamp(act + (bz <= -10 ? 0.22 : bz <= -5 ? 0.12 : bz <= -2 ? 0.05 : bz >= 5 ? -0.08 : 0), 0, 1);
      const cc = c ? c.cc[Math.round((t - c.t0) / HOUR)] : null, dark = darkness(t, p.lat, p.lon);
      return { t, p: Math.round(100 * act * dark * (cc == null ? 0.6 : Math.pow(1 - cc / 100, 1.3)) * (p.sky || 0.8)), cc: cc == null ? null : cc, kp: k, dark };
    });
  }
  return { pts, bz, sustained, now, moon: moonLight(now) };
}

// the best (place, hour) among places within km, for hours in [from, to)
function bestWithin(f, km, from, to) {
  let best = null;
  for (const p of f.pts) if (p.km <= km) for (const h of p.series) if (h.t >= from && h.t < to && (!best || h.p > best.h.p)) best = { pt: p, h };
  return best;
}
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

// Which tier (if any) to send now, and its words. state: { night, top, count, at: { tier: time } }
function decide(s, f, state, now) {
  if (!f) return null;
  const tz = s.tz || 0, nightOf = local(now - 12 * HOUR, tz).toISOString().slice(0, 10), seed = Number(nightOf.replace(/-/g, ""));
  const st = state && state.night === nightOf ? state : { night: nightOf, top: 0, count: 0, at: {} };
  if (st.count >= 3) return null;
  const cur = Math.floor(now / HOUR) * HOUR, me = f.pts[0], meNow = me.series[0];
  const look = s.lat < 0 ? "south" : "north";
  const where = (b) => b.pt.km === 0 ? "where you are" : "at " + b.pt.name + " (" + Math.round(b.pt.km) + " km)";
  let tier = 0, b = null;
  // 3: under it, right here, right now
  if (meNow.dark >= 1 && meNow.cc != null && meNow.cc <= TIER3.cloud && me.ov != null && me.ov >= TIER3.ov && f.sustained && meNow.p >= TIER3.p) { tier = 3; b = { pt: me, h: meNow }; }
  // 2: go, within 50 km in the next couple of hours
  if (!tier) { const g = bestWithin(f, TIER2.km, cur, now + 2 * HOUR); if (g && g.h.p >= TIER2.p) { tier = 2; b = g; } }
  // 1: heads-up for tonight within 100 km, in the evening only
  if (!tier && local(now, tz).getUTCHours() < 23 && local(now, tz).getUTCHours() >= 12) { const g = bestWithin(f, TIER1.km, cur, cur + 12 * HOUR); if (g && g.h.p >= TIER1.p) { tier = 1; b = g; } }
  if (!tier) return null;
  // escalate only; the same tier again only after 3 hours (a second burst of activity later in the night)
  const again = tier === st.top && st.at[tier] && now - st.at[tier] >= 3 * HOUR;
  if (tier < st.top || (tier === st.top && !again)) return null;
  const cloud = b.h.cc != null ? " Cloud " + Math.round(b.h.cc) + "%." : "";
  const moon = f.moon > 0.7 ? " The moon's bright, so a phone camera will help." : "";
  let title, body;
  if (tier === 1) {
    title = pick(["Could be a braw night 🌌", "Keep an eye on the sky tonight", "Tonight's looking promising ✨"], seed);
    body = b.h.p + "% chance " + where(b) + ", best around " + hhmm(b.h.t, tz) + "." + cloud + moon + " We'll shout if it kicks off.";
  } else if (tier === 2) {
    title = pick(["They're oot. Go. ✨", "It's kicking off 🌌", "Right, this is the real thing"], seed);
    body = b.h.p + "% chance " + where(b) + " in the next hour or two." + cloud + " Get somewhere dark, face " + look + " and give your eyes 20 minutes." + moon;
  } else {
    const i = Math.abs(seed) % 3;
    title = ["Look up! You're under it 🌌", "Heads up. Literally. 👀", "This is the one ✨"][i];
    body = ["The Mirrie Dancers are in your sky right now. Get away from lights, look " + look + " and tick it off the bucket list ✅",
      "It's happening above you. Your phone camera sees more than your eyes, so snap one. Bucket list: ticked ✅",
      "Dancing over you right now. Hot chocolate optional, looking up compulsory. Bucket list: ticked ✅"][i];
  }
  return { tier, title, body, state: { night: nightOf, top: tier, count: st.count + 1, at: Object.assign({}, st.at, { [tier]: now }) } };
}

function notify(n) {
  // one notification id: each new tier replaces the last instead of stacking up
  CapacitorNotifications.schedule([{ id: 1, title: n.title, body: n.body, scheduleAt: new Date(Date.now() + 1000), smallIcon: "ic_stat_aurora", autoCancel: true }]);
}

if (typeof addEventListener === "function") {
  addEventListener("configure", (resolve, reject, args) => {
    try { kvSet("settings", args || {}); resolve({ ok: true }); } catch (e) { reject(e); }
  });
  addEventListener("testAlert", (resolve, reject) => {
    try { notify({ title: "Aurora alerts are on ✨", body: "We'll give you a heads-up for a good night within 100 km, a shout when it's kicking off within 50 km, and a big one when it's right above you." }); resolve({ ok: true }); } catch (e) { reject(e); }
  });
  addEventListener("checkAurora", async (resolve, reject) => {
    try {
      const s = kvGet("settings");
      if (!s || !s.on || !isFinite(s.lat) || !isFinite(s.lon)) return resolve({ skipped: "off" });
      const now = Date.now(), hist = (kvGet("bzHist") || []).filter(h => now - h.t < 3 * HOUR);
      const f = await forecast(s, now, getJSON, hist);
      if (f && f.bz != null) kvSet("bzHist", hist.concat({ t: now, bz: f.bz }).slice(-6));
      const n = decide(s, f, kvGet("state"), now);
      if (n) { notify(n); kvSet("state", n.state); }
      resolve({ tier: n ? n.tier : 0 });
    } catch (e) { reject(e); }
  });
}
if (typeof module !== "undefined") module.exports = { forecast, decide, parseKp, kpNeedAt, darkness, hhmm, TIER1, TIER2, TIER3 };
