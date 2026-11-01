// node --test app/test : the background check, with fake feeds and the runner's fake device APIs.
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), vm = require("vm"), path = require("path");
const SRC = path.join(__dirname, "../www/runners/aurora.js");
const { forecast, decide } = require(SRC);
const HOUR = 3600000, night = Date.parse("2026-11-03T21:10:00Z"), noon = Date.parse("2026-06-21T05:00:00Z");
const glasgow = { on: true, lat: 55.86, lon: -4.27, place: "Glasgow", threshold: 35, tz: 0 };
const kpRows = (kp) => Array.from({ length: 16 }, (_, i) => ({ time_tag: new Date(night - 12 * HOUR + i * 3 * HOUR).toISOString().slice(0, 19), kp: String(kp) }));
const feeds = (kp, cloud) => (url) => Promise.resolve(
  url.includes("k-index") ? kpRows(kp) : url.includes("mag-field") ? [{ bz_gsm: "-7.5" }] :
  { hourly: { time: Array.from({ length: 48 }, (_, i) => new Date(Date.parse("2026-11-03T00:00Z") + i * HOUR).toISOString().slice(0, 16)), cloud_cover: Array(48).fill(cloud) } });

test("a clear storm night alerts, once", async () => {
  const hours = await forecast(glasgow, night, feeds(6.3, 10));
  const n = decide(glasgow, hours, null, night);
  assert.ok(n, "should alert"); assert.match(n.title, /\d+% near Glasgow/); assert.ok(n.state.p >= 35);
  assert.strictEqual(decide(glasgow, hours, n.state, night + HOUR), null, "no repeat at the same chance");
  assert.ok(decide(glasgow, hours, { ...n.state, p: n.state.p - 25 }, night + HOUR), "repeats after a 20+ point jump");
});
test("quiet or cloudy nights stay silent", async () => {
  assert.strictEqual(decide(glasgow, await forecast(glasgow, night, feeds(2.0, 10)), null, night), null);
  assert.strictEqual(decide(glasgow, await forecast(glasgow, night, feeds(6.3, 100)), null, night), null);
});
test("daylight downloads nothing", async () => {
  let calls = 0;
  assert.strictEqual(await forecast(glasgow, noon, () => { calls++; return Promise.resolve([]); }), null);
  assert.strictEqual(calls, 0);
});
test("the runner's events: configure, then a timed check sends one notification", async () => {
  const kv = {}, sent = [], handlers = {};
  const ctx = vm.createContext({
    addEventListener: (e, f) => { handlers[e] = f; }, console, JSON, Math, Date, Object, Array, String, parseFloat, isFinite,
    CapacitorKV: { get: (k) => ({ value: kv[k] }), set: (k, v) => { kv[k] = v; } },
    CapacitorNotifications: { schedule: (n) => sent.push(...n) },
    fetch: (url) => feeds(6.3, 10)(url).then(j => ({ status: 200, text: () => Promise.resolve(JSON.stringify(j)) })),
  });
  vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx);
  const call = (e, args) => new Promise((res, rej) => handlers[e](res, rej, args));
  await call("configure", glasgow);
  const RealNow = Date.now; ctx.Date.now = () => night;
  try { const r = await call("checkAurora"); assert.ok(r.sent, JSON.stringify(r)); await call("checkAurora"); } finally { ctx.Date.now = RealNow; }
  assert.strictEqual(sent.length, 1, "second check the same night stays quiet");
  assert.strictEqual(sent[0].smallIcon, "ic_stat_aurora");
  await call("configure", { ...glasgow, on: false });
  assert.strictEqual((await call("checkAurora")).skipped, "off");
});
