// Measures the release build on Windows and macOS: start-up, open time,
// external update latency, memory and bundle size. Timing marks come from the
// app's PSYMD_PERF log (wall-clock epoch ms), so they compare across processes.
//
//   node scripts/measure.mjs <psymd executable> <samplesDir> [runs]
//
// Only for measuring: it backs up and restores psy.md's session file so that
// each run starts the same way. Keep the display awake and unlocked while it
// runs (on macOS: `caffeinate -d node scripts/measure.mjs ...`); without
// animation frames large documents are not finished.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const [exe, samples, runsArg] = process.argv.slice(2);
const runs = Number(runsArg ?? 5);
if (!exe || !samples) {
  console.error("usage: measure.mjs <psymd executable> <samplesDir> [runs]");
  process.exit(2);
}
const mac = process.platform === "darwin";
if (process.platform !== "win32" && !mac) {
  console.error("measure.mjs supports Windows and macOS");
  process.exit(2);
}
const sessionFile = mac
  ? join(homedir(), "Library", "Application Support", "app.psymd", "session.json")
  : join(process.env.APPDATA ?? "", "app.psymd", "session.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function marks(log) {
  if (!existsSync(log)) return {};
  const out = {};
  for (const line of readFileSync(log, "utf8").split(/\r?\n/)) {
    const m = /^(\S+) t=([\d.]+) epoch=(\d+)/.exec(line);
    if (m) (out[m[1]] ??= []).push({ t: Number(m[2]), epoch: Number(m[3]), line });
  }
  return out;
}

// WKWebView runs in XPC services whose parent is launchd, not the app, so
// the web processes are the com.apple.WebKit.* processes that appeared after
// the app was started.
function webkitPids() {
  if (!mac) return new Set();
  const text = execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
  return new Set(
    text
      .split("\n")
      .filter((l) => l.includes("com.apple.WebKit."))
      .map((l) => Number(l.trim().split(/\s+/)[0])),
  );
}

function rssOf(pid) {
  try {
    return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024;
  } catch {
    return 0;
  }
}

// Physical footprint as reported by footprint(1), the closest match to
// Windows' private bytes.
function footprintOf(pid) {
  try {
    const text = execFileSync("footprint", ["-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /Footprint:\s+([\d.]+)\s*(B|KB|MB|GB)/.exec(text);
    return m ? Number(m[1]) * { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2]] : 0;
  } catch {
    return 0;
  }
}

// ws/priv: working set and private bytes on Windows, RSS and physical
// footprint on macOS.
function memoryOf(pid, before) {
  if (mac) {
    const web = [...webkitPids()].filter((p) => !before.has(p));
    const sum = (pids) => pids.reduce((a, p) => ({ ws: a.ws + rssOf(p), priv: a.priv + footprintOf(p) }), { ws: 0, priv: 0 });
    return { app: sum([pid]), webview: sum(web), processes: web.length + 1 };
  }
  const ps = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$tree = @(${pid}); $added = $true
while ($added) { $added = $false; foreach ($p in $all) { if ($tree -contains $p.ParentProcessId -and -not ($tree -contains $p.ProcessId)) { $tree += $p.ProcessId; $added = $true } } }
foreach ($id in $tree) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { "{0};{1};{2}" -f $p.ProcessName, $p.WorkingSet64, $p.PrivateMemorySize64 } }`;
  const text = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  const rows = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split(";"))
    .map(([name, ws, priv]) => ({ name, ws: Number(ws), priv: Number(priv) }));
  const sum = (f) => rows.filter(f).reduce((a, r) => ({ ws: a.ws + r.ws, priv: a.priv + r.priv }), { ws: 0, priv: 0 });
  return {
    app: sum((r) => r.name === "psymd"),
    webview: sum((r) => r.name !== "psymd"),
    processes: rows.length,
  };
}

async function launch(file, { wait = 2500, until = "ui-ready" } = {}) {
  const log = join(tmpdir(), `psymd-perf-${Date.now()}.log`);
  const args = file ? [file] : [];
  const before = webkitPids();
  const t0 = Date.now();
  const child = spawn(exe, args, { env: { ...process.env, PSYMD_PERF: log }, stdio: "ignore" });
  // Wait until the UI reports the given mark (or a timeout).
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !marks(log)[until]) await sleep(25);
  await sleep(wait);
  return { child, log, t0, before };
}

async function stop(child) {
  try {
    if (mac) child.kill("SIGKILL");
    else execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  // The WebKit processes on macOS take a moment to exit after the app.
  await sleep(mac ? 1500 : 800);
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : Number.NaN;
};
const mb = (b) => (b / 1024 / 1024).toFixed(1);

const results = { startup: [], open: {}, update: [], memory: {} };
const backup = `${sessionFile}.measure-backup`;
if (existsSync(sessionFile)) copyFileSync(sessionFile, backup);

try {
  // Start-up without a document: process start to usable window.
  for (let i = 0; i < runs; i++) {
    if (existsSync(sessionFile)) rmSync(sessionFile);
    const { child, log, t0, before } = await launch(null, { wait: 1500 });
    const m = marks(log);
    results.startup.push({
      shown: (m["window-shown"]?.[0]?.epoch ?? Number.NaN) - t0,
      ready: (m["ui-ready"]?.[0]?.epoch ?? Number.NaN) - t0,
    });
    if (i === runs - 1) results.memory.idle = memoryOf(child.pid, before);
    await stop(child);
  }

  // Open time per document: process start to document on screen.
  for (const name of ["doc-100k.md", "doc-1m.md", "doc-10m.md", "tables.md", "code.md", "mermaid.md"]) {
    const file = join(samples, name);
    const times = [];
    for (let i = 0; i < Math.min(runs, 3); i++) {
      if (existsSync(sessionFile)) rmSync(sessionFile);
      const { child, log, t0, before } = await launch(file, { wait: 2000, until: "doc-shown" });
      const m = marks(log);
      times.push({
        opened: (m.opened?.[0]?.epoch ?? Number.NaN) - t0,
        shown: (m["doc-shown"]?.[0]?.epoch ?? Number.NaN) - t0,
        window: (m["window-shown"]?.[0]?.epoch ?? Number.NaN) - t0,
      });
      if (i === 0 && (name === "doc-1m.md" || name === "doc-10m.md" || name === "doc-100k.md")) {
        results.memory[name] = memoryOf(child.pid, before);
      }
      await stop(child);
    }
    results.open[name] = times;
  }

  // External update latency on the 100 KB document: atomic replace to applied.
  {
    const src = join(samples, "doc-100k.md");
    const work = join(tmpdir(), "psymd-measure-update.md");
    copyFileSync(src, work);
    if (existsSync(sessionFile)) rmSync(sessionFile);
    const { child, log } = await launch(work, { wait: 2000 });
    for (let i = 0; i < 15; i++) {
      const before = (marks(log)["external-applied"] ?? []).length;
      const text = `${readFileSync(work, "utf8")}\nAppended line ${i}.\n`;
      const tmp = `${work}.tmp`;
      writeFileSync(tmp, text);
      const t = Date.now();
      renameSync(tmp, work);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (marks(log)["external-applied"] ?? []).length <= before) await sleep(5);
      const applied = (marks(log)["external-applied"] ?? [])[before]?.epoch;
      const event = (marks(log)["doc-event"] ?? []).at(-1)?.epoch;
      results.update.push({ total: (applied ?? Number.NaN) - t, toEvent: (event ?? Number.NaN) - t });
      await sleep(600);
    }
    await stop(child);
    rmSync(work, { force: true });
  }
} finally {
  if (existsSync(backup)) renameSync(backup, sessionFile);
}

const exeSize = statSync(exe).size;
console.log(JSON.stringify(results, null, 1));
console.log("\nSUMMARY");
console.log(`startup window shown: median ${median(results.startup.map((r) => r.shown))} ms; UI ready ${median(results.startup.map((r) => r.ready))} ms (n=${runs})`);
for (const [name, t] of Object.entries(results.open)) {
  console.log(`open ${name}: read ${median(t.map((x) => x.opened))} ms, shown ${median(t.map((x) => x.shown))} ms after process start (n=${t.length})`);
}
console.log(`update latency (atomic replace → applied): median ${median(results.update.map((u) => u.total))} ms, max ${Math.max(...results.update.map((u) => u.total))} ms; → watcher event median ${median(results.update.map((u) => u.toEvent))} ms (n=${results.update.length})`);
for (const [k, m] of Object.entries(results.memory)) {
  const [ws, priv, web] = mac ? ["RSS", "footprint", "WebKit"] : ["working set", "private", "WebView2"];
  console.log(`memory ${k}: app ${mb(m.app.ws)} MB ${ws} / ${mb(m.app.priv)} MB ${priv}; ${web} ${mb(m.webview.ws)} MB / ${mb(m.webview.priv)} MB in ${m.processes - 1} processes`);
}
console.log(`executable size: ${exeSize} bytes (${mb(exeSize)} MB)`);
