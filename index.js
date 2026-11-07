// Run scripts: an Aurral plugin that runs executables from a scripts folder on
// notification events. It hands a script the same AURRAL_* variables and stdin
// JSON as the fork's old built-in custom scripts, so those scripts run as-is.

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 3600;
const KILL_GRACE_SEC = 5;
// An event call has 10 seconds. Wait this long for scripts to finish so a
// quick failure shows on the plugin's page; slower scripts carry on alone.
const EVENT_WAIT_MS = 7000;
const LOG_TAIL_CHARS = 2000;
const LOGS_KEPT = 50;
const MAX_SCRIPTS_PER_EVENT = 10;
// Only these variables reach a script from the plugin's environment.
const PASSTHROUGH_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"];
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const SCRIPT_VARS = [
  "flowPath",
  "flowName",
  "albumName",
  "artistName",
  "albumPath",
  "trackName",
  "path",
  "username",
  "userId",
  "event",
  "message",
];

const str = (value) => (value == null ? "" : String(value).trim());

// Every variable, empty where the event has none.
const scriptVars = (vars) => Object.fromEntries(SCRIPT_VARS.map((key) => [key, str(vars[key])]));

const envName = (key) => `AURRAL_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;

function scriptEnv(vars) {
  const env = {};
  for (const key of PASSTHROUGH_ENV) if (process.env[key]) env[key] = process.env[key];
  env.PATH ||= DEFAULT_PATH;
  for (const [key, value] of Object.entries(vars)) env[envName(key)] = value;
  return env;
}

const scriptList = (value) =>
  str(value)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, MAX_SCRIPTS_PER_EVENT);

function timeoutSec(settings) {
  const seconds = Math.floor(Number(settings.timeoutSec));
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(seconds, MAX_TIMEOUT_SEC);
}

async function scriptsFolder(settings) {
  const configured = str(settings.folder);
  if (!configured) throw new Error("Set the scripts folder");
  let real;
  try {
    real = await fs.realpath(path.resolve(configured));
  } catch {
    throw new Error(`Scripts folder not found: ${configured}`);
  }
  if (!(await fs.stat(real)).isDirectory()) {
    throw new Error(`Scripts folder is not a folder: ${configured}`);
  }
  return real;
}

// The script's real location, which must stay inside the scripts folder after
// every symlink is followed.
async function resolveScript(folder, name) {
  if (name.includes("\0")) throw new Error(`Bad script name: ${name}`);
  let real;
  try {
    real = await fs.realpath(path.resolve(folder, name));
  } catch {
    throw new Error(`Script not found: ${name}`);
  }
  const relative = path.relative(folder, real);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Script must be inside the scripts folder: ${name}`);
  }
  if (!(await fs.stat(real)).isFile()) throw new Error(`Script is not a file: ${name}`);
  try {
    await fs.access(real, fsConstants.X_OK);
  } catch {
    throw new Error(`Script is not executable: ${name}`);
  }
  return real;
}

// coreutils `timeout` stops the script's whole process group, and keeps doing
// so after Aurral stops this plugin's idle process.
let timeoutBinary;
async function findTimeoutBinary() {
  if (timeoutBinary !== undefined) return timeoutBinary;
  timeoutBinary = null;
  for (const dir of (process.env.PATH || DEFAULT_PATH).split(path.delimiter)) {
    const candidate = path.join(dir, "timeout");
    try {
      await fs.access(candidate, fsConstants.X_OK);
      timeoutBinary = candidate;
      break;
    } catch {}
  }
  return timeoutBinary;
}

async function pruneLogs(logDir) {
  try {
    const names = (await fs.readdir(logDir)).filter((name) => name.endsWith(".log")).sort();
    await Promise.all(
      names.slice(0, -LOGS_KEPT).map((name) => fs.rm(path.join(logDir, name), { force: true })),
    );
  } catch {}
}

async function logTail(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.slice(-LOG_TAIL_CHARS).trim();
  } catch {
    return "";
  }
}

// Starts one script without a shell. Resolves when it exits with
// { name, ok, exitCode, timedOut, durationMs, output }.
async function runScript({ name, folder, vars, seconds, dataFolder }) {
  const file = await resolveScript(folder, name);
  const logDir = path.join(dataFolder, "logs");
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(
    logDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${name.replace(/[^\w.-]/g, "_")}.log`,
  );
  // Output goes to a file, so a script that outlives this process keeps a
  // place to write.
  const log = await fs.open(logFile, "a");
  const wrapper = await findTimeoutBinary();
  const [command, args] = wrapper
    ? [wrapper, [`--kill-after=${KILL_GRACE_SEC}`, String(seconds), file]]
    : [file, []];
  const started = Date.now();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        shell: false,
        detached: true,
        cwd: folder,
        env: scriptEnv(vars),
        stdio: ["pipe", log.fd, log.fd],
      });
    } catch (error) {
      log.close().catch(() => {});
      reject(error);
      return;
    }
    log.close().catch(() => {});
    child.unref();

    let timedOut = false;
    let timer;
    let killTimer;
    if (!wrapper) {
      const killGroup = (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch {}
      };
      timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_SEC * 1000);
        killTimer.unref();
      }, seconds * 1000);
      timer.unref();
    }

    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(vars));
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(new Error(`Script ${name} could not start: ${error.message}`));
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      // timeout exits 124 when it stopped the script, 137 after SIGKILL.
      if (wrapper && (code === 124 || code === 137)) timedOut = true;
      const result = {
        name,
        ok: !timedOut && code === 0,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - started,
        output: await logTail(logFile),
      };
      const summary = JSON.stringify({ ...result, event: vars.event, log: logFile });
      if (result.ok) console.log(`Script finished: ${summary}`);
      else console.warn(`Script failed: ${summary}`);
      void pruneLogs(logDir);
      resolve(result);
    });
  });
}

const failureText = (result) =>
  result.timedOut
    ? `${result.name} timed out`
    : `${result.name} exited with ${result.exitCode ?? result.signal}`;

async function runAll(input, settingKey, rawVars, { wait = EVENT_WAIT_MS } = {}) {
  const names = scriptList(input.settings?.[settingKey]);
  if (!names.length) return;
  const folder = await scriptsFolder(input.settings);
  const vars = scriptVars(rawVars);
  const seconds = timeoutSec(input.settings);
  const runs = names.map((name) =>
    runScript({ name, folder, vars, seconds, dataFolder: input.dataFolder }).catch((error) => {
      console.warn(error.message);
      return { name, ok: false, error: error.message };
    }),
  );
  const all = Promise.all(runs);
  const results = await Promise.race([
    all,
    new Promise((resolve) => setTimeout(() => resolve(null), wait).unref()),
  ]);
  if (!results) return;
  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    throw new Error(failed.map((result) => result.error || failureText(result)).join("; "));
  }
}

const withUser = (message, username, suffix = (name) => ` (${name})`) =>
  username ? `${message}${suffix(username)}` : message;

const nameKey = (value) =>
  str(value)
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^[\s.]+/, "");

async function findChildDir(parent, name) {
  const wanted = nameKey(name).toLowerCase();
  if (!wanted) return null;
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    const match = entries.find(
      (entry) => entry.isDirectory() && entry.name.toLowerCase() === wanted,
    );
    return match ? path.join(parent, match.name) : null;
  } catch {
    return null;
  }
}

// The album's folder in the Library (Artist/Album), or "" when it isn't there.
async function findAlbumDir(libraryFolder, artist, album) {
  if (!libraryFolder || !str(album)) return "";
  const artistDir = await findChildDir(libraryFolder, artist || "Unknown Artist");
  if (!artistDir) return "";
  return (await findChildDir(artistDir, album)) || "";
}

// Turns a plugin notification into the variables the old script hooks sent.
async function notificationVars(input) {
  const album = input.album || {};
  const artist = input.artist || {};
  const flow = input.flow || {};
  const username = str(input.user?.username);
  const message = str(input.message);
  switch (input.kind) {
    case "discovery.updated":
      return [
        "discoveryUpdated",
        {
          event: "notifyDiscoveryUpdated",
          message: message || "Daily Discover recommendations have been updated.",
          flowName: "Aurral – Discover",
        },
      ];
    case "flow.done": {
      const counts =
        flow.completed > 0 || flow.failed > 0
          ? ` Completed: ${flow.completed ?? 0}, Failed: ${flow.failed ?? 0}`
          : "";
      return [
        "flowDone",
        {
          event: "notifyFlowDone",
          message: `${message}${counts}`,
          flowName: flow.name,
          flowPath: flow.path,
        },
      ];
    }
    case "request.made":
      return [
        "requestMade",
        {
          event: "notifyRequestMade",
          message: withUser(message, username),
          albumName: album.title,
          artistName: album.artist,
          username,
        },
      ];
    case "request.available":
      return [
        "requestAvailable",
        {
          event: "notifyRequestAvailable",
          message: withUser(message, username, (name) => ` requested by ${name}`),
          albumName: album.title,
          artistName: album.artist,
          albumPath: await findAlbumDir(input.libraryFolder, album.artist, album.title),
          username,
        },
      ];
    case "artist.added":
      return [
        "artistAdded",
        {
          event: "notifyArtistAdded",
          message: withUser(message, username),
          artistName: artist.name,
          username,
        },
      ];
    default:
      return [null, null];
  }
}

export default {
  async test(input) {
    const folder = await scriptsFolder(input.settings || {});
    const keys = [
      "discoveryUpdated",
      "flowDone",
      "requestMade",
      "requestAvailable",
      "artistAdded",
      "trackAdded",
    ];
    const names = [...new Set(keys.flatMap((key) => scriptList(input.settings[key])))];
    for (const name of names) await resolveScript(folder, name);
    if (!names.length) return { message: `Found ${folder}. No scripts are set for any event yet.` };
    if (input.settings.testRuns !== true) {
      return { message: `Found ${names.length} executable script(s) in ${folder}` };
    }
    const vars = scriptVars({
      event: "scriptTest",
      message: "Aurral script test",
      albumName: "Test album",
      artistName: "Test artist",
      albumPath: "/music/Test artist/Test album",
      trackName: "Test track",
      path: "/music/Test artist/Test album/01 - Test track.flac",
      username: "script-test-user",
      userId: "script-test-user",
    });
    // A test has 30 seconds, so cap each run below that.
    const seconds = Math.min(timeoutSec(input.settings), 25);
    const results = await Promise.all(
      names.map((name) => runScript({ name, folder, vars, seconds, dataFolder: input.dataFolder })),
    );
    const failed = results.filter((result) => !result.ok);
    if (failed.length) {
      throw new Error(
        failed.map((result) => `${failureText(result)}: ${result.output.slice(-300)}`).join("; "),
      );
    }
    return { message: `Ran ${names.length} script(s): all exited 0` };
  },

  events: {
    async notification(input) {
      const [settingKey, vars] = await notificationVars(input);
      if (settingKey) await runAll(input, settingKey, vars);
    },

    async "download.finished"(input) {
      const track = input.track || {};
      if (!track.path) return;
      const trackName = str(track.title) || path.basename(track.path);
      const artistName = str(track.artist);
      await runAll(input, "trackAdded", {
        event: "notifyTrackAdded",
        message: `Track added: ${artistName ? `${trackName} by ${artistName}` : trackName}`,
        trackName,
        artistName,
        albumName: track.album,
        path: track.path,
        albumPath: path.dirname(track.path),
      });
    },
  },
};
