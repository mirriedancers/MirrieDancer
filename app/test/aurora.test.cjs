// node --test app/test/aurora.test.cjs : the background check's tiers, with fake feeds and fake device APIs.
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), vm = require("vm"), path = require("path");
const SRC = path.join(__dirname, "../www/runners/aurora.js");
const { forecast, decide } = require(SRC);
const HOUR = 3600000, MIN = 60000;
const at = (iso) => Date.parse(iso);
// Glasgow, with two dark-sky spots from the site's list (one within 50 km, one within 100 km)
const me = { on: true, lat: 55.86, lon: -4.27, place: "Glasgow", tz: 0, spots: [
  { name: "Carron Valley Reservoir", lat: 56.03, lon: -4.07, sky: 0.85, km: 23 },
  { name: "Loch Lomond, Inveruglas", lat: 56.25, lon: -4.71, sky: 0.9, km: 52 },
] };
// fake feeds: Kp all night, the latest Bz, an oval peaking at a given latitude, and cloud per place
function feeds({ kp, bz = null, ovPeak = 0, ovLat = 62, cloud = 15, cloudAt = null }) {
  const calls = [];
  const get = (url) => {
    calls.push(url);
    if (url.includes("k-index")) return Promise.resolve(Array.from({ length: 24 }, (_, i) => ({ time_tag: new Date(at("2026-11-03T00:00:00Z") + i * 3 * HOUR).toISOString().slice(0, 19), kp: String(kp) })));
    if (url.includes("mag-field")) return bz == null ? Promise.reject(new Error("down")) : Promise.resolve([{ bz_gsm: String(bz) }]);
    if (url.includes("ovation")) { const c = []; for (let lo = 0; lo < 360; lo++) for (let la = -90; la <= 90; la++) c.push([lo, la, Math.round(ovPeak * Math.exp(-((la - ovLat) ** 2) / 8))]); return Promise.resolve({ coordinates: c }); }
    const lats = new URL(url).searchParams.get("latitude").split(",");
    const one = (i) => ({ hourly: { time: Array.from({ length: 48 }, (_, h) => new Date(at("2026-11-03T00:00:00Z") + h * HOUR).toISOString().slice(0, 16)), cloud_cover: Array(48).fill(cloudAt ? cloudAt(i) : cloud) } });
    return Promise.resolve(lats.length > 1 ? lats.map((_, i) => one(i)) : one(0));
  };
  return { get, calls };
}
const run = async (when, opts, state = null, hist = []) => { const f = await forecast(me, when, feeds(opts).get, hist); return decide(me, f, state, when); };

test("tier 1: an evening heads-up for a good night within 100 km, with the best time", async () => {
  const n = await run(at("2026-11-03T17:20:00Z"), { kp: 5.3 });
  assert.strictEqual(n && n.tier, 1, JSON.stringify(n)); assert.match(n.body, /\d+% chance .* best around \d\d:\d\d/);
});
test("no heads-up after 23:00 or on a quiet night", async () => {
  assert.strictEqual(await run(at("2026-11-03T23:30:00Z"), { kp: 5.3 }), null);
  assert.strictEqual(await run(at("2026-11-03T17:20:00Z"), { kp: 2 }), null);
});
test("tier 2: the oval arriving and Bz turning south says go, within 50 km", async () => {
  const n = await run(at("2026-11-03T21:30:00Z"), { kp: 6, bz: -8, ovPeak: 45 });
  assert.strictEqual(n && n.tier, 2, JSON.stringify(n)); assert.match(n.body, /next hour or two/);
});
test("tier 3: Bz held south for two checks, dark, clear and the oval in your sky: you're under it", async () => {
  const n = await run(at("2026-11-03T21:30:00Z"), { kp: 6, bz: -8, ovPeak: 45 }, null, [{ t: at("2026-11-03T21:00:00Z"), bz: -6 }]);
  assert.strictEqual(n && n.tier, 3, JSON.stringify(n)); assert.match(n.body, /bucket list/i);
});
test("a cloudy home but a clear spot nearby: go there, by name", async () => {
  const n = await run(at("2026-11-03T21:30:00Z"), { kp: 6, bz: -8, ovPeak: 45, cloudAt: (i) => (i === 0 ? 95 : 10) }, null, [{ t: at("2026-11-03T21:00:00Z"), bz: -6 }]);
  assert.strictEqual(n && n.tier, 2, JSON.stringify(n)); assert.match(n.body, /Carron Valley Reservoir \(23 km\)/);
});
test("one at a time: escalate only, the same tier again only after 3 hours, 3 a night at most", async () => {
  const t = at("2026-11-03T21:30:00Z"), storm = { kp: 6, bz: -8, ovPeak: 45 }, held = [{ t: t - 30 * MIN, bz: -6 }];
  const n3 = await run(t, storm, null, held);
  assert.strictEqual(await run(t + 30 * MIN, storm, n3.state), null, "no tier 2 after tier 3");
  assert.strictEqual(await run(t + HOUR, storm, n3.state, [{ t: t + 30 * MIN, bz: -7 }]), null, "no repeat within 3 hours");
  const again = await run(t + 3.5 * HOUR, storm, n3.state, [{ t: t + 3 * HOUR, bz: -7 }]);
  assert.strictEqual(again && again.tier, 3, "a second burst 3+ hours later");
  assert.strictEqual(await run(t + 7 * HOUR, storm, { ...again.state, count: 3 }, [{ t: t + 6.5 * HOUR, bz: -7 }]), null, "cap of 3");
});
test("daylight downloads nothing; quiet nights skip the 1 MB oval", async () => {
  const day = feeds({ kp: 6 });
  assert.strictEqual(await forecast(me, at("2026-06-21T05:00:00Z"), day.get, []), null);
  assert.strictEqual(day.calls.length, 0);
  const quiet = feeds({ kp: 1.5, bz: 1 });
  await forecast(me, at("2026-11-03T21:30:00Z"), quiet.get, []);
  assert.ok(!quiet.calls.some(u => u.includes("ovation")), quiet.calls.join(" "));
});
test("the runner's events: configure, a timed check, one notification, history kept", async () => {
  const kv = {}, sent = [], handlers = {}, f = feeds({ kp: 6, bz: -8, ovPeak: 45 });
  const ctx = vm.createContext({
    addEventListener: (e, h) => { handlers[e] = h; }, console, JSON, Math, Date, Object, Array, String, Number, parseFloat, isFinite, Float32Array,
    CapacitorKV: { get: (k) => ({ value: kv[k] }), set: (k, v) => { kv[k] = v; } },
    CapacitorNotifications: { schedule: (n) => sent.push(...n) },
    fetch: (url) => f.get(url).then(j => ({ status: 200, text: () => Promise.resolve(JSON.stringify(j)) })),
  });
  vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx);
  const call = (e, args) => new Promise((res, rej) => handlers[e](res, rej, args));
  await call("configure", me);
  const realNow = ctx.Date.now;
  try {
    ctx.Date.now = () => at("2026-11-03T21:00:00Z"); assert.strictEqual((await call("checkAurora")).tier, 2);
    ctx.Date.now = () => at("2026-11-03T21:30:00Z"); assert.strictEqual((await call("checkAurora")).tier, 3, "Bz held south over two checks");
  } finally { ctx.Date.now = realNow; }
  assert.strictEqual(sent.length, 2); assert.ok(sent.every(n => n.id === 1 && n.smallIcon === "ic_stat_aurora"), "one notification, updated in place");
  await call("configure", { ...me, on: false });
  assert.strictEqual((await call("checkAurora")).skipped, "off");
});
