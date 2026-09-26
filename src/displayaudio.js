#!/usr/bin/osascript -l JavaScript
// Display & Audio Control for Alfred: audio devices, volume, mic mute, display modes,
// brightness, display arrangements and AirPods listening modes.
//
//   osascript -l JavaScript displayaudio.js <audio|mic|res|bright|layout|anc> [query]   Script Filters
//   osascript -l JavaScript displayaudio.js act '<json>'                                 run an action
//
// No compiled helper: CoreAudio, CoreGraphics and DisplayServices are called through the
// JXA Objective-C bridge (ObjC.bindFunction). C structs are passed as byte buffers
// (NSMutableData), CF objects as `id`, and opaque handles through `void **` Refs.
//
// Environment used by the test suite (never set by Alfred):
//   DA_DRY_RUN=1    print the calls a setter would make instead of making them
//   DA_FIXTURE=f    read fake hardware from a JSON file (implies DA_DRY_RUN)
//   DA_BIN_DIRS=a:b where to look for optional command-line tools
ObjC.import("Foundation");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}

const FIXTURE_PATH = env("DA_FIXTURE", null);
const DRY = env("DA_DRY_RUN", "") === "1" || FIXTURE_PATH !== null; // fake hardware never reaches real setters
const dryCalls = [];
function dry(call) {
  dryCalls.push(call);
}

// ---------- small helpers ----------

function fold(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Every word of the query must appear somewhere in the haystack (accent- and case-insensitive).
function matches(query, ...hay) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const h = fold(hay.join(" "));
  return words.every((w) => h.includes(w));
}

// Display text: no control characters or bidi overrides (they can reorder or hide a title).
// The real value stays in `arg`.
function clean(s) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function icon(name) {
  return { path: `icons/${name}.png` };
}

function info(title, subtitle = "", ico = "info", extra = {}) {
  return Object.assign({ title, subtitle, valid: false, icon: icon(ico) }, extra);
}

function output(items) {
  return JSON.stringify({ skipknowledge: true, items });
}

// arg of an actionable row: a JSON action for `act`
function action(op, fields = {}) {
  return JSON.stringify(Object.assign({ op }, fields));
}

// Append " (2)", " (3)" … to rows whose names collide, so identical devices stay distinguishable.
function disambiguate(list, nameOf, hintOf) {
  const groups = new Map(); // not {}: a device may be called "constructor" or "__proto__"
  for (const x of list) {
    const n = clean(nameOf(x));
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(x);
  }
  const label = new Map();
  for (const [name, xs] of groups) {
    if (xs.length === 1) {
      label.set(xs[0], name);
      continue;
    }
    const hints = xs.map((x) => (hintOf ? hintOf(x) : ""));
    const uniqueHints = new Set(hints).size === xs.length && hints.every(Boolean);
    xs.forEach((x, i) => label.set(x, uniqueHints ? `${name} (${hints[i]})` : `${name} (${i + 1})`));
  }
  return (x) => label.get(x);
}

function pct(v) {
  return `${Math.round(v)}%`;
}

function fmtHz(hz) {
  if (!hz) return "";
  const r = Math.round(hz * 100) / 100;
  return `${Number.isInteger(r) ? r : r.toFixed(2).replace(/0$/, "")} Hz`;
}

// ---------- files ----------

function dataDir() {
  const dir = env("alfred_workflow_data", null) || `${$.NSTemporaryDirectory().js}alfred-display-audio`;
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  return dir;
}

function readJSON(path, fallback) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, $());
  if (s.isNil()) return fallback;
  try {
    return JSON.parse(s.js);
  } catch (e) {
    return fallback;
  }
}

// A state file as a plain object: a corrupt, null or array file counts as empty.
function readObject(path) {
  const v = readJSON(path, null);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function writeJSON(path, value) {
  // atomically, so a crash never leaves half a file; false when it couldn't be written
  return !!$(JSON.stringify(value, null, 2)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, $());
}

// ---------- processes ----------

function isExecutable(path) {
  return $.NSFileManager.defaultManager.isExecutableFileAtPath(path);
}

// Optional CLIs: Alfred's PATH has no Homebrew, so look in the usual places.
function binDirs() {
  const custom = env("DA_BIN_DIRS", null);
  if (custom !== null) return custom.split(":").filter(Boolean);
  const home = $.NSHomeDirectory().js;
  const user = $.NSUserName().js;
  // Homebrew (Apple silicon, Intel), MacPorts, Nix (nix-darwin, per-user, profile), personal bins
  return [
    "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin",
    "/run/current-system/sw/bin", `/etc/profiles/per-user/${user}/bin`, `${home}/.nix-profile/bin`, "/nix/var/nix/profiles/default/bin",
    `${home}/.local/bin`, `${home}/bin`,
  ];
}

function which(name) {
  for (const d of binDirs()) if (isExecutable(`${d}/${name}`)) return `${d}/${name}`;
  return null;
}

// Run a program with argv (never through a shell). Returns {status, out, err}; kills it after `timeout` s.
function spawn(path, args, timeout = 5) {
  const tmp = $.NSTemporaryDirectory().js;
  const outPath = `${tmp}da-${$.NSUUID.UUID.UUIDString.js}.out`;
  const errPath = outPath.replace(/out$/, "err");
  const fm = $.NSFileManager.defaultManager;
  fm.createFileAtPathContentsAttributes(outPath, $(), $());
  fm.createFileAtPathContentsAttributes(errPath, $(), $());
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardOutput = $.NSFileHandle.fileHandleForWritingAtPath(outPath);
  task.standardError = $.NSFileHandle.fileHandleForWritingAtPath(errPath);
  let result = { status: -1, out: "", err: "" };
  if (task.launchAndReturnError($())) {
    const deadline = Date.now() + timeout * 1000;
    while (task.running && Date.now() < deadline) $.NSThread.sleepForTimeInterval(0.01);
    if (task.running) {
      task.terminate;
      result.err = "timed out";
    } else result.status = Number(task.terminationStatus);
    const read = (p) => {
      const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, $());
      return s.isNil() ? "" : s.js;
    };
    result.out = read(outPath);
    result.err = result.err || read(errPath);
  } else result.err = "could not launch";
  fm.removeItemAtPathError(outPath, $());
  fm.removeItemAtPathError(errPath, $());
  return result;
}

function shellQuote(a) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

// ---------- byte buffers for C structs ----------

function u32bin(values) {
  let s = "";
  for (const v of values) for (let i = 0; i < 4; i++) s += String.fromCharCode((v >>> (8 * i)) & 255);
  return s;
}
function mdata(bin) {
  return $.NSMutableData.dataWithData($(bin).dataUsingEncoding($.NSISOLatin1StringEncoding));
}
function binOf(data) {
  return $.NSString.alloc.initWithDataEncoding(data, $.NSISOLatin1StringEncoding).js;
}
function u32list(bin) {
  const r = [];
  for (let i = 0; i + 3 < bin.length; i += 4)
    r.push((bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8) | (bin.charCodeAt(i + 2) << 16) | (bin.charCodeAt(i + 3) << 24)) >>> 0);
  return r;
}
function f32of(bin) {
  const dv = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < 4; i++) dv.setUint8(i, bin.charCodeAt(i));
  return dv.getFloat32(0, true);
}
function fourcc(s) {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
}
function fourccStr(n) {
  return !n ? "" : String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

// ---------- CoreAudio ----------

const CA = { bound: null };
function caBind(out) {
  if (CA.bound === null) {
    ObjC.import("CoreAudio");
    ObjC.bindFunction("AudioObjectGetPropertyDataSize", ["int", ["unsigned int", "void *", "unsigned int", "void *", "void *"]]);
    ObjC.bindFunction("AudioObjectSetPropertyData", ["int", ["unsigned int", "void *", "unsigned int", "void *", "unsigned int", "void *"]]);
    ObjC.bindFunction("AudioObjectHasProperty", ["bool", ["unsigned int", "void *"]]);
    ObjC.bindFunction("AudioObjectIsPropertySettable", ["int", ["unsigned int", "void *", "void *"]]);
  }
  // The last argument is a CFStringRef* for string properties and a plain buffer otherwise.
  if (CA.bound !== out) {
    ObjC.bindFunction("AudioObjectGetPropertyData", ["int", ["unsigned int", "void *", "unsigned int", "void *", "void *", out === "id" ? "id *" : "void *"]]);
    CA.bound = out;
  }
}
const SYSTEM_OBJECT = 1; // kAudioObjectSystemObject
function caAddr(sel, scope = "glob") {
  return mdata(u32bin([fourcc(sel), fourcc(scope), 0])); // AudioObjectPropertyAddress {selector, scope, element main}
}
function caSize(obj, sel, scope) {
  caBind(CA.bound || "ptr");
  const sz = mdata(u32bin([0]));
  const st = $.AudioObjectGetPropertyDataSize(obj, caAddr(sel, scope).mutableBytes, 0, null, sz.mutableBytes);
  return st === 0 ? u32list(binOf(sz))[0] : -1;
}
function caU32s(obj, sel, scope) {
  const n = caSize(obj, sel, scope);
  if (n <= 0) return [];
  caBind("ptr");
  const buf = $.NSMutableData.dataWithLength(n);
  const sz = mdata(u32bin([n]));
  if ($.AudioObjectGetPropertyData(obj, caAddr(sel, scope).mutableBytes, 0, null, sz.mutableBytes, buf.mutableBytes) !== 0) return [];
  return u32list(binOf(buf).slice(0, u32list(binOf(sz))[0]));
}
function caU32(obj, sel, scope) {
  const v = caU32s(obj, sel, scope);
  return v.length ? v[0] : null;
}
function caString(obj, sel, scope) {
  caBind("id");
  const r = Ref();
  const st = $.AudioObjectGetPropertyData(obj, caAddr(sel, scope).mutableBytes, 0, null, mdata(u32bin([8, 0])).mutableBytes, r);
  try {
    return st === 0 && r[0] && !r[0].isNil() ? r[0].js : "";
  } catch (e) {
    return "";
  }
}
// true when the property exists and can be changed (Boolean out-param: one byte)
function caSettable(obj, sel, scope) {
  caBind(CA.bound || "ptr");
  const addr = caAddr(sel, scope);
  if (!$.AudioObjectHasProperty(obj, addr.mutableBytes)) return false;
  const out = $.NSMutableData.dataWithLength(4);
  return $.AudioObjectIsPropertySettable(obj, addr.mutableBytes, out.mutableBytes) === 0 && binOf(out).charCodeAt(0) !== 0;
}
function caSetU32(obj, sel, value, scope) {
  caBind(CA.bound || "ptr");
  return $.AudioObjectSetPropertyData(obj, caAddr(sel, scope).mutableBytes, 0, null, 4, mdata(u32bin([value])).mutableBytes);
}

// kAudioDeviceTransportType* four-char codes (AudioHardwareBase.h), trailing spaces trimmed
const TRANSPORTS = new Map(Object.entries({
  bltn: "Built-in", usb: "USB", blue: "Bluetooth", blea: "Bluetooth LE", hdmi: "HDMI", dprt: "DisplayPort",
  airp: "AirPlay", grup: "Aggregate", virt: "Virtual", thun: "Thunderbolt", 1394: "FireWire", pci: "PCI",
  eavb: "AVB", ccap: "Continuity", ccwd: "Continuity", ccwl: "Continuity",
}));
function transportLabel(t) {
  return TRANSPORTS.get(String(t || "").trim()) || "";
}

// ---------- CoreGraphics ----------

let cgReady = false;
function cg() {
  if (cgReady) return;
  ObjC.import("CoreGraphics");
  ObjC.import("AppKit");
  const u = "unsigned int";
  const fns = {
    CGGetOnlineDisplayList: ["int", [u, "void *", "void *"]],
    CGGetActiveDisplayList: ["int", [u, "void *", "void *"]],
    CGDisplayCopyAllDisplayModes: ["id", [u, "id"]],
    CGDisplayCopyDisplayMode: ["id", [u]],
    CGDisplayModeGetWidth: ["unsigned long", ["id"]],
    CGDisplayModeGetHeight: ["unsigned long", ["id"]],
    CGDisplayModeGetPixelWidth: ["unsigned long", ["id"]],
    CGDisplayModeGetPixelHeight: ["unsigned long", ["id"]],
    CGDisplayModeGetRefreshRate: ["double", ["id"]],
    CGDisplayModeGetIODisplayModeID: ["int", ["id"]],
    CGDisplayModeGetIOFlags: [u, ["id"]],
    CGDisplayModeIsUsableForDesktopGUI: ["bool", ["id"]],
    CGDisplayIsBuiltin: [u, [u]],
    CGDisplayIsAsleep: [u, [u]],
    CGDisplayMirrorsDisplay: [u, [u]],
    CGDisplayCreateUUIDFromDisplayID: ["id", [u]],
    CFUUIDCreateString: ["id", ["void *", "id"]],
    CGBeginDisplayConfiguration: ["int", ["void **"]],
    CGConfigureDisplayWithDisplayMode: ["int", ["void *", u, "id", "id"]],
    CGConfigureDisplayOrigin: ["int", ["void *", u, "int", "int"]],
    CGConfigureDisplayMirrorOfDisplay: ["int", ["void *", u, u]],
    CGCompleteDisplayConfiguration: ["int", ["void *", u]],
    CGCancelDisplayConfiguration: ["int", ["void *"]],
  };
  for (const [name, sig] of Object.entries(fns)) ObjC.bindFunction(name, sig);
  cgReady = true;
}

const kCGConfigurePermanently = 2;
const kDisplayModeNativeFlag = 0x02000000;
const kDisplayModeDefaultFlag = 0x00000004;

function modeOf(ref) {
  return {
    w: Number($.CGDisplayModeGetWidth(ref)),
    h: Number($.CGDisplayModeGetHeight(ref)),
    pw: Number($.CGDisplayModeGetPixelWidth(ref)),
    ph: Number($.CGDisplayModeGetPixelHeight(ref)),
    hz: Number($.CGDisplayModeGetRefreshRate(ref)),
    io: Number($.CGDisplayModeGetIODisplayModeID(ref)),
    flags: Number($.CGDisplayModeGetIOFlags(ref)),
    gui: !!$.CGDisplayModeIsUsableForDesktopGUI(ref),
    ref,
  };
}

function displayIdList(fn) {
  const buf = $.NSMutableData.dataWithLength(4 * 32);
  const cnt = mdata(u32bin([0]));
  if (fn(32, buf.mutableBytes, cnt.mutableBytes) !== 0) return [];
  return u32list(binOf(buf)).slice(0, u32list(binOf(cnt))[0]);
}

function realDisplays() {
  cg();
  // Online, not just active: a sleeping or mirrored display is still configurable.
  const ids = displayIdList($.CGGetOnlineDisplayList);
  const names = {};
  const screens = $.NSScreen.screens;
  for (let i = 0; i < Number(screens.count); i++) {
    const s = screens.objectAtIndex(i);
    const n = s.deviceDescription.objectForKey("NSScreenNumber");
    if (!n.isNil() && s.respondsToSelector("localizedName")) names[Number(n.js)] = s.localizedName.js;
  }
  return ids.map((id) => {
    const b = $.CGDisplayBounds(id);
    const cur = $.CGDisplayCopyDisplayMode(id);
    const u = $.CGDisplayCreateUUIDFromDisplayID(id);
    const builtin = !!$.CGDisplayIsBuiltin(id);
    return {
      id,
      uuid: u && !u.isNil() ? $.CFUUIDCreateString(null, u).js : "",
      name: names[id] || (builtin ? "Built-in Display" : `Display ${id}`),
      builtin,
      mirrorOf: Number($.CGDisplayMirrorsDisplay(id)),
      asleep: !!$.CGDisplayIsAsleep(id),
      x: Math.round(b.origin.x),
      y: Math.round(b.origin.y),
      rotation: Number($.CGDisplayRotation(id)),
      current: cur && !cur.isNil() ? modeOf(cur) : null,
      modes() {
        // "kCGDisplayResolution" is the value of kCGDisplayShowDuplicateLowResolutionModes: include HiDPI modes
        const opts = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $("kCGDisplayResolution"));
        const arr = $.CGDisplayCopyAllDisplayModes(id, opts);
        const out = [];
        if (!arr || arr.isNil()) return out;
        for (let i = 0; i < Number(arr.count); i++) out.push(modeOf(arr.objectAtIndex(i)));
        return out;
      },
    };
  });
}

// ---------- DisplayServices (private framework: built-in and Apple displays) ----------

let dsReady = null;
function ds() {
  if (dsReady !== null) return dsReady;
  const b = $.NSBundle.bundleWithPath("/System/Library/PrivateFrameworks/DisplayServices.framework");
  dsReady = !b.isNil() && b.load;
  if (dsReady) {
    try {
      ObjC.bindFunction("DisplayServicesCanChangeBrightness", ["bool", ["unsigned int"]]);
      ObjC.bindFunction("DisplayServicesGetBrightness", ["int", ["unsigned int", "void *"]]);
      ObjC.bindFunction("DisplayServicesSetBrightness", ["int", ["unsigned int", "float"]]);
    } catch (e) {
      dsReady = false;
    }
  }
  return dsReady;
}

function realBrightness(id) {
  if (!ds() || !$.DisplayServicesCanChangeBrightness(id)) return null;
  const buf = $.NSMutableData.dataWithLength(4);
  if ($.DisplayServicesGetBrightness(id, buf.mutableBytes) !== 0) return null;
  const v = f32of(binOf(buf));
  return isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
}

// ---------- hardware layer (real or fixture) ----------

function standardAdditions() {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  return app;
}

function numOrNull(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

const REAL = {
  audioDevices() {
    return caU32s(SYSTEM_OBJECT, "dev#").map((id) => ({
      id,
      uid: caString(id, "uid "),
      name: caString(id, "lnam") || "Unknown device",
      transport: fourccStr(caU32(id, "tran")).trim(),
      out: Math.max(0, caSize(id, "stm#", "outp") / 4),
      in: Math.max(0, caSize(id, "stm#", "inpt") / 4),
      canOut: caU32(id, "dflt", "outp") === 1,
      canIn: caU32(id, "dflt", "inpt") === 1,
      canSys: caU32(id, "sflt", "outp") === 1,
      hidden: caU32(id, "hidn") === 1,
    }));
  },
  audioDefaults() {
    return { output: caU32(SYSTEM_OBJECT, "dOut"), input: caU32(SYSTEM_OBJECT, "dIn "), system: caU32(SYSTEM_OBJECT, "sOut") };
  },
  volume() {
    try {
      const v = standardAdditions().getVolumeSettings();
      return { output: numOrNull(v.outputVolume), input: numOrNull(v.inputVolume), alert: numOrNull(v.alertVolume), muted: v.outputMuted === true };
    } catch (e) {
      return { output: null, input: null, alert: null, muted: false };
    }
  },
  // the device's own input mute switch (kAudioDevicePropertyMute): true/false, or null without one
  inputMute(id) {
    if (!caSettable(id, "mute", "inpt")) return null;
    const v = caU32(id, "mute", "inpt");
    return v === null ? null : v === 1;
  },
  displays: realDisplays,
  brightness: realBrightness,
};

function fixtureHW(f) {
  const displays = () =>
    (f.displays || []).map((d) => Object.assign({ mirrorOf: 0, asleep: false, rotation: 0, x: 0, y: 0, uuid: "", builtin: false }, d, {
      modes: () => (d.modes || []).map((m) => Object.assign({ flags: 0, gui: true, io: 0 }, m)),
    }));
  return {
    audioDevices: () => (f.audio && f.audio.devices) || [],
    audioDefaults: () => (f.audio && f.audio.defaults) || {},
    volume: () => Object.assign({ output: null, input: null, alert: null, muted: false }, f.audio && f.audio.volume),
    inputMute: (id) => {
      const d = ((f.audio && f.audio.devices) || []).find((x) => x.id === id);
      return d && typeof d.muteIn === "boolean" ? d.muteIn : null;
    },
    displays,
    brightness: (id) => {
      const d = (f.displays || []).find((x) => x.id === id);
      return d && typeof d.brightness === "number" ? d.brightness : null;
    },
  };
}

const HW = FIXTURE_PATH ? fixtureHW(readJSON(FIXTURE_PATH, {})) : REAL;

// ---------- setters (dry-run aware) ----------

function setDefaultDevice(which, dev) {
  const sel = { output: "dOut", input: "dIn ", system: "sOut" }[which];
  if (DRY) return dry(`AudioObjectSetPropertyData(kAudioObjectSystemObject, '${sel}', device=${dev.id} "${dev.name}" uid=${dev.uid})`);
  const st = caSetU32(SYSTEM_OBJECT, sel, dev.id);
  if (st !== 0) throw new Error(`CoreAudio refused the change (error ${st})`);
}

function setInputMute(dev, on) {
  if (DRY) return dry(`AudioObjectSetPropertyData(device=${dev.id}, 'mute' input, ${on ? 1 : 0})`);
  const st = caSetU32(dev.id, "mute", on ? 1 : 0, "inpt");
  if (st !== 0) throw new Error(`CoreAudio refused to ${on ? "mute" : "unmute"} ${clean(dev.name)} (error ${st})`);
}

function setVolume(fields) {
  if (DRY) return dry(`set volume ${Object.entries(fields).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  standardAdditions().setVolume(null, fields);
}

function describeMode(m) {
  return `${m.w}x${m.h}${m.pw > m.w ? " HiDPI" : ""}${m.hz ? ` ${fmtHz(m.hz).replace(" ", "")}` : ""} io=${m.io}`;
}

// ops: [{kind: "mode"|"origin"|"mirror", id, mode?, x?, y?, master?}] applied in one transaction
function configureDisplays(ops) {
  if (!ops.length) return;
  if (DRY) {
    dry("CGBeginDisplayConfiguration");
    for (const o of ops) {
      if (o.kind === "mode") dry(`CGConfigureDisplayWithDisplayMode(display=${o.id}, ${describeMode(o.mode)})`);
      if (o.kind === "origin") dry(`CGConfigureDisplayOrigin(display=${o.id}, x=${o.x}, y=${o.y})`);
      if (o.kind === "mirror") dry(`CGConfigureDisplayMirrorOfDisplay(display=${o.id}, master=${o.master})`);
    }
    return dry("CGCompleteDisplayConfiguration(kCGConfigurePermanently)");
  }
  cg();
  const ref = Ref();
  if ($.CGBeginDisplayConfiguration(ref) !== 0) throw new Error("Could not start a display configuration");
  const config = ref[0];
  if (!config) throw new Error("Could not start a display configuration");
  // Every path ends in exactly one Complete or Cancel (both invalidate the configuration),
  // including a JavaScript exception thrown by the bridge in the middle of the loop.
  let st = 0;
  try {
    for (const o of ops) {
      if (o.kind === "mode") st = $.CGConfigureDisplayWithDisplayMode(config, o.id, o.mode.ref, $.NSDictionary.dictionary);
      else if (o.kind === "origin") st = $.CGConfigureDisplayOrigin(config, o.id, o.x, o.y);
      else if (o.kind === "mirror") st = $.CGConfigureDisplayMirrorOfDisplay(config, o.id, o.master);
      else st = -1;
      if (st !== 0) break;
    }
  } catch (e) {
    $.CGCancelDisplayConfiguration(config);
    throw e;
  }
  if (st !== 0) {
    $.CGCancelDisplayConfiguration(config);
    throw new Error(`CoreGraphics error ${st}`);
  }
  st = $.CGCompleteDisplayConfiguration(config, kCGConfigurePermanently);
  if (st !== 0) throw new Error(`CoreGraphics error ${st}`);
}

// ======================================================================
// Audio
// ======================================================================

function audioIcon(d) {
  const n = fold(d.name);
  if (d.transport === "airp") return "airplay";
  if (/airpods|beats/.test(n)) return "airpods";
  if (d.transport === "blue" || d.transport === "blea" || /headphone|headset|casque|kopfh/.test(n)) return "headphones";
  if (d.transport === "hdmi" || d.transport === "dprt") return "tv";
  if (d.transport === "grup") return "aggregate";
  if (d.transport === "virt") return "virtual";
  if (d.transport === "usb") return "usb";
  if (d.in > 0 && d.out === 0) return "mic";
  return "speaker";
}

function usableDevices(scope) {
  return HW.audioDevices().filter((d) =>
    scope === "output" ? d.out > 0 && d.canOut !== false && !d.hidden : d.in > 0 && d.canIn !== false && !d.hidden
  );
}

// The same headset or AirPods on the other side (output ↔ input): the device itself when it has
// both, else its twin that macOS lists separately (AirPods: "<address>:output" / "<address>:input"),
// else the one other-side device with exactly the same name.
function partnerDevice(dev, scope) {
  const other = usableDevices(scope === "output" ? "input" : "output");
  const same = other.find((d) => d.id === dev.id);
  if (same) return same;
  const m = /^(.*):(output|input)$/i.exec(dev.uid || "");
  if (m) {
    const twin = other.find((d) => d.uid && d.uid.toLowerCase() === `${m[1]}:${scope === "output" ? "input" : "output"}`.toLowerCase());
    if (twin) return twin;
  }
  const named = other.filter((d) => d.name === dev.name);
  return named.length === 1 ? named[0] : null;
}

function deviceRows(scope, query) {
  const all = usableDevices(scope);
  const defs = HW.audioDefaults();
  const current = scope === "output" ? defs.output : defs.input;
  const label = disambiguate(all, (d) => d.name, (d) => transportLabel(d.transport));
  const list = all
    .filter((d) => matches(query, label(d), transportLabel(d.transport), scope === "output" ? "output" : "input"))
    .sort((a, b) => (b.id === current) - (a.id === current) || label(a).localeCompare(label(b)));
  return list.map((d) => {
    const isCur = d.id === current;
    const kind = transportLabel(d.transport);
    const parts = [kind, isCur ? `Current ${scope}` : `↩ Set as ${scope}`];
    if (scope === "output" && d.id === defs.system) parts.push("Alerts play here");
    const arg = action("device", { scope, uid: d.uid, id: d.id, name: d.name });
    const row = {
      title: `${isCur ? "✓ " : ""}${label(d)}`,
      subtitle: parts.filter(Boolean).join(" · "),
      arg,
      icon: icon(audioIcon(d)),
      text: { copy: d.name, largetype: d.name },
    };
    if (scope === "output")
      row.mods = {
        cmd: d.canSys === false
          ? { arg, valid: false, subtitle: "This device can't play alerts and sound effects" }
          : { arg: action("device", { scope, uid: d.uid, id: d.id, name: d.name, system: true }), subtitle: "Set as output and for alerts and sound effects" },
      };
    else row.mods = { cmd: { arg, subtitle: `Set as ${scope}` } };
    // ⌥: headsets and AirPods for both sound and microphone
    row.mods.alt = partnerDevice(d, scope)
      ? { arg: action("device", { scope, uid: d.uid, id: d.id, name: d.name, both: true }), subtitle: scope === "output" ? "Set as output and input (its microphone too)" : "Set as input and output (its speakers too)" }
      : { arg, valid: false, subtitle: scope === "output" ? "This device has no microphone of its own" : "This device has no speakers of its own" };
    return row;
  });
}

function currentDeviceName(scope) {
  const defs = HW.audioDefaults();
  const id = scope === "output" ? defs.output : defs.input;
  const d = HW.audioDevices().find((x) => x.id === id);
  return d ? clean(d.name) : null;
}

function parseLevel(q) {
  const m = /^(\d{1,3})\s*%?$/.exec(q.trim());
  return m ? Number(m[1]) : null;
}

// "+10" / "-10": a signed step, or null
function parseStep(q) {
  const m = /^([+-])\s*(\d{1,3})\s*%?$/.exec(q.trim());
  return m ? (m[1] === "-" ? -Number(m[2]) : Number(m[2])) : null;
}

function signed(n) {
  return `${n < 0 ? "-" : "+"}${Math.abs(n)}%`;
}

// The row that sets the volume (output) or input level to `level`, or changes it by `step`.
function volumeRow(scope, cur, level, step, devName, muted) {
  const target = step !== null ? Math.max(0, Math.min(100, Math.round(cur + step))) : level;
  const what = scope === "output" ? "volume" : "input level";
  return {
    title: step !== null ? `${scope === "output" ? "Volume" : "Input level"} ${signed(step)} → ${target}%` : `Set ${scope === "output" ? `${scope} volume` : what} to ${level}%`,
    subtitle: `Currently ${pct(cur)}${muted ? " (muted)" : ""} · ${devName}`,
    arg: action("volume", step !== null ? { scope, rel: step } : { scope, value: level }),
    icon: icon(scope === "output" ? (target === 0 ? "muted" : "volume") : target === 0 ? "mic_off" : "mic"),
  };
}

function audioItems(query) {
  let q = query.trim();
  let scope = "output";
  const m = /^(in|input|inputs|out|output|outputs)\b\s*([\s\S]*)$/i.exec(q);
  if (m) {
    scope = /^in/i.test(m[1]) ? "input" : "output";
    q = m[2];
  }
  const vol = HW.volume();
  const items = [];
  const level = parseLevel(q);
  const step = parseStep(q);
  if (level !== null || step !== null) {
    const cur = scope === "output" ? vol.output : vol.input;
    const devName = currentDeviceName(scope) || `No ${scope} device`;
    if (level > 100 || Math.abs(step) > 100) return [info("Volume goes from 0 to 100", `Type a number like 50, or +10 / -10`, "error")];
    if (cur === null)
      return [info(`${devName} has no adjustable volume`, "macOS reports no software volume for this device", "error")];
    const row = volumeRow(scope, cur, level, step, devName, scope === "output" && vol.muted);
    // the classic wording for an absolute output level
    if (step === null && scope === "output") row.title = `Set output volume to ${level}%`;
    if (step === null && scope === "input") row.title = `Set input volume to ${level}%`;
    return [row];
  }
  if (scope === "output" && /^(mute|unmute)$/i.test(q)) {
    const mute = /^mute$/i.test(q);
    return [{
      title: mute ? "Mute output" : "Unmute output",
      subtitle: `Currently ${vol.muted ? "muted" : vol.output === null ? "not adjustable" : pct(vol.output)} · ${currentDeviceName("output") || "No output device"}`,
      arg: action("mute", { value: mute }),
      icon: icon(mute ? "muted" : "volume"),
    }];
  }
  let rows;
  try {
    rows = deviceRows(scope, q);
  } catch (e) {
    return [info("Could not read audio devices", String(e.message || e), "error")];
  }
  items.push(...rows);
  if (!rows.length)
    items.push(info(q ? `No ${scope} device matches “${q}”` : `No ${scope} devices found`, q ? "Check the spelling or connect the device" : "Connect a device or check System Settings › Sound", "info"));
  if (!q) {
    const v = scope === "output" ? vol.output : vol.input;
    items.push(info(
      scope === "output" ? (vol.muted ? "Volume: muted" : v === null ? "Volume: not adjustable" : `Volume ${pct(v)}`) : v === null ? "Input level: not adjustable" : `Input level ${pct(v)}`,
      "Type a number to change it, e.g. 50 or +10" + (scope === "output" ? " · “mute” / “unmute”" : ""),
      scope === "output" ? (vol.muted ? "muted" : "volume") : "mic"
    ));
    items.push(info(
      scope === "output" ? "Input devices…" : "Output devices…",
      scope === "output" ? "Microphones and other inputs" : "Speakers and headphones",
      scope === "output" ? "mic" : "speaker",
      { valid: false, autocomplete: scope === "output" ? "in " : "" }
    ));
  }
  return items;
}

// ======================================================================
// Microphone
// ======================================================================

function micItems(query) {
  const q = query.trim();
  const vol = HW.volume();
  const name = currentDeviceName("input");
  const dev = currentInputDevice();
  const hwMute = dev ? HW.inputMute(dev.id) : null;
  const items = [];
  // The row does what its title says (mic-mute / mic-unmute), even if the state changes before ↩.
  // Typing "mute" or "unmute" asks for that one, and says so when it's already the case.
  const word = /^(mute|unmute)$/i.exec(q);
  const toggleRow = (muted, detail) => {
    const mute = word ? word[1].toLowerCase() === "mute" : !muted;
    const now = `${name} · ${muted ? "Muted" : detail}`;
    if (mute === muted) return info(muted ? "Microphone is already muted" : "Microphone is already on", now, muted ? "mic_off" : "mic");
    return {
      title: mute ? "Mute microphone" : "Unmute microphone",
      subtitle: now,
      arg: action(mute ? "mic-mute" : "mic-unmute"),
      icon: icon(muted ? "mic_off" : "mic"),
    };
  };
  if (!name) items.push(info("No input device", "Connect a microphone or check System Settings › Sound › Input", "error"));
  else if (vol.input === null) {
    // no software level (some USB microphones): use the device's own mute switch if it has one
    if (hwMute === null) items.push(info(`${name} has no adjustable input level`, "It can't be muted from here", "error"));
    else if (parseLevel(q) !== null || parseStep(q) !== null) return [info(`${name} has no adjustable input level`, "Type “mute” or “unmute” instead", "error")];
    else if (!q || matches(q, "mute unmute toggle microphone")) items.push(toggleRow(hwMute, "On"));
  } else {
    const level = parseLevel(q);
    const step = parseStep(q);
    if (level !== null || step !== null) {
      if (level > 100 || Math.abs(step) > 100) return [info("Input level goes from 0 to 100", "Type a number like 70, or +10 / -10", "error")];
      return [volumeRow("input", vol.input, level, step, name, false)];
    }
    const muted = vol.input === 0 || hwMute === true;
    if (!q || matches(q, "mute unmute toggle microphone")) items.push(toggleRow(muted, `Input level ${pct(vol.input)}`));
  }
  let rows = [];
  try {
    rows = deviceRows("input", /^(mute|unmute|toggle)$/i.test(q) ? "" : q);
  } catch (e) {
    items.push(info("Could not read audio devices", String(e.message || e), "error"));
  }
  items.push(...rows);
  if (!items.length) items.push(info(`No input device matches “${q}”`, "Check the spelling or connect the device"));
  return items;
}

function micState() {
  const path = `${dataDir()}/mic.json`;
  return { path, state: readObject(path) };
}

function defaultUnmuteLevel() {
  const n = parseInt(env("mic_level", "75"), 10);
  return n > 0 && n <= 100 ? n : 75;
}

function currentInputDevice() {
  const id = HW.audioDefaults().input;
  return HW.audioDevices().find((x) => x.id === id) || null;
}

// Mutes with the input level (remembered for unmuting) and, when the level can't be changed,
// with the device's own mute switch (kAudioDevicePropertyMute), as some USB microphones need.
function micToggle(forceMute) {
  const vol = HW.volume();
  const name = currentDeviceName("input");
  const dev = currentInputDevice();
  if (!name || !dev) return "No input device";
  const hwMute = HW.inputMute(dev.id);
  if (vol.input === null) {
    if (hwMute === null) return `${name} has no adjustable input level`;
    const mute = forceMute === undefined ? !hwMute : forceMute;
    if (mute === hwMute) return mute ? `🔇 Microphone is already muted · ${name}` : `🎙 Microphone is already on · ${name}`;
    setInputMute(dev, mute);
    return mute ? `🔇 Microphone muted · ${name}` : `🎙 Microphone on · ${name}`;
  }
  const { path, state } = micState();
  const muted = vol.input === 0 || hwMute === true;
  const mute = forceMute === undefined ? !muted : forceMute;
  // an explicit unmute of a live microphone must not reset its level to the remembered one
  if (mute === muted) return mute ? `🔇 Microphone is already muted · ${name}` : `🎙 Microphone is already on · ${pct(vol.input)} · ${name}`;
  if (mute) {
    if (vol.input > 0) writeJSON(path, Object.assign(state, { level: vol.input }));
    setVolume({ inputVolume: 0 });
    if (!DRY && (HW.volume().input || 0) > 0) {
      if (hwMute === null) return `${name} ignored the change: it has no software input level`;
      setInputMute(dev, true);
    }
    return `🔇 Microphone muted · ${name}`;
  }
  if (hwMute === true) setInputMute(dev, false);
  if (vol.input > 0 && hwMute === true) return `🎙 Microphone on · ${pct(vol.input)} · ${name}`;
  const level = state.level > 0 && state.level <= 100 ? Math.round(state.level) : defaultUnmuteLevel();
  setVolume({ inputVolume: level });
  return `🎙 Microphone on · ${level}% · ${name}`;
}

// ======================================================================
// Displays: helpers shared by res, bright and layout
// ======================================================================

function displays() {
  const ds = HW.displays();
  const label = disambiguate(ds, (d) => d.name);
  // main display (at the origin) first, then left to right
  return ds
    .map((d) => Object.assign(d, { label: label(d), main: d.x === 0 && d.y === 0 && !d.mirrorOf }))
    .sort((a, b) => b.main - a.main || a.x - b.x || a.y - b.y || a.id - b.id);
}

// Find a display by UUID (stable across reconnects), or by ID when it has none. Identical monitors
// without a serial number share a UUID: then the display ID decides. `used` makes matches one-to-one.
function findDisplay(list, uuid, id, used = new Set()) {
  const free = list.filter((d) => !used.has(d));
  if (!uuid) return free.find((d) => d.id === id) || null;
  const same = free.filter((d) => d.uuid && d.uuid.toUpperCase() === String(uuid).toUpperCase());
  return same.find((d) => d.id === id) || same[0] || null;
}

// Pair saved displays with connected ones, one to one.
function matchSaved(saved, list) {
  const used = new Set();
  return (saved || []).map((s) => {
    const d = findDisplay(list, s.uuid, s.id, used);
    if (d) used.add(d);
    return [s, d];
  });
}

function sameMode(a, b) {
  return a && b && a.w === b.w && a.h === b.h && a.pw === b.pw && a.ph === b.ph && Math.abs((a.hz || 0) - (b.hz || 0)) < 0.01;
}

function displayIcon(d) {
  return d.builtin ? "laptop" : "display";
}

// ======================================================================
// Resolution
// ======================================================================

function modeTitle(m) {
  const hidpi = m.pw > m.w;
  return `${m.w} × ${m.h}${hidpi ? " · HiDPI" : ""}${m.hz ? ` · ${fmtHz(m.hz)}` : ""}`;
}

function visibleModes(d) {
  const allHz = env("res_refresh", "highest") === "all";
  const lowRes = env("res_lowres", "0") === "1";
  const cur = d.current;
  let modes = d.modes().filter((m) => m.gui !== false || sameMode(m, cur));
  // one entry per size/scale/refresh
  const seen = new Set();
  modes = modes.filter((m) => {
    const k = `${m.w}x${m.h}/${m.pw}x${m.ph}@${Math.round((m.hz || 0) * 100)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!lowRes) {
    // Hide "low resolution" modes: a 1x copy of a HiDPI size, or any 1x mode on a built-in Retina
    // display except its native one. 1x modes of external displays (like 4K at 3840 × 2160) stay.
    const hidpiSizes = new Set(modes.filter((m) => m.pw > m.w).map((m) => `${m.w}x${m.h}`));
    const retina = d.builtin && hidpiSizes.size > 0;
    modes = modes.filter(
      (m) => m.pw > m.w || sameMode(m, cur) || (!hidpiSizes.has(`${m.w}x${m.h}`) && (!retina || m.flags & kDisplayModeNativeFlag))
    );
  }
  if (!allHz) {
    // the highest refresh rate of each size, plus the current mode
    const best = {};
    for (const m of modes) {
      const k = `${m.w}x${m.h}/${m.pw}x${m.ph}`;
      if (!best[k] || (m.hz || 0) > (best[k].hz || 0)) best[k] = m;
    }
    modes = modes.filter((m) => best[`${m.w}x${m.h}/${m.pw}x${m.ph}`] === m || sameMode(m, cur));
  }
  return modes.sort((a, b) => b.w - a.w || b.h - a.h || b.pw - a.pw || (b.hz || 0) - (a.hz || 0));
}

function resItems(query) {
  let list;
  try {
    list = displays();
  } catch (e) {
    return [info("Could not read displays", String(e.message || e), "error")];
  }
  if (!list.length) return [info("No displays found", "Wake the display or check the cable", "error")];
  const items = [];
  for (const d of list) {
    const cur = d.current;
    const mirror = d.mirrorOf ? list.find((x) => x.id === d.mirrorOf) : null;
    for (const m of visibleModes(d)) {
      const isCur = sameMode(m, cur);
      const tags = [];
      if (m.flags & kDisplayModeNativeFlag) tags.push("Native");
      if (m.flags & kDisplayModeDefaultFlag) tags.push("Default");
      const hay = [`${m.w}x${m.h}`, `${m.w} ${m.h}`, m.pw > m.w ? "hidpi retina" : "1x", fmtHz(m.hz).replace(" ", ""), d.label, tags.join(" "), isCur ? "current" : ""];
      if (query && !matches(query, ...hay)) continue;
      items.push({
        title: `${isCur ? "✓ " : ""}${modeTitle(m)}`,
        subtitle: [
          d.label + (mirror ? ` (mirrors ${mirror.label})` : ""),
          m.pw > m.w ? `${m.pw} × ${m.ph} pixels` : "",
          tags.join(", "),
          isCur ? "Current" : "↩ Switch",
        ].filter(Boolean).join(" · "),
        arg: action("res", { uuid: d.uuid, id: d.id, display: d.label, w: m.w, h: m.h, pw: m.pw, ph: m.ph, hz: m.hz, io: m.io }),
        valid: !isCur,
        icon: icon(displayIcon(d)),
        text: { copy: `${m.w}x${m.h}`, largetype: modeTitle(m) },
      });
    }
  }
  if (!items.length) items.push(info(`No display mode matches “${query}”`, "Try a width like 1920, “hidpi” or “60hz”"));
  return items;
}

function resAction(a) {
  const d = findDisplay(displays(), a.uuid, a.id);
  if (!d) return `${a.display || "That display"} is no longer connected`;
  const modes = d.modes();
  const want = { w: a.w, h: a.h, pw: a.pw, ph: a.ph, hz: a.hz };
  const m = modes.find((x) => sameMode(x, want) && x.io === a.io) || modes.find((x) => sameMode(x, want));
  if (!m) return `${modeTitle(want)} is no longer available on ${d.label}`;
  if (sameMode(m, d.current)) return `${d.label} already uses ${modeTitle(m)}`;
  configureDisplays([{ kind: "mode", id: d.id, mode: m }]);
  return `${d.label} · ${modeTitle(m)}`;
}

// ======================================================================
// Brightness
// ======================================================================

function betterDisplayRunning() {
  const forced = env("DA_BD_RUNNING", null); // tests
  if (forced !== null) return forced === "1";
  ObjC.import("AppKit");
  return Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier("pro.betterdisplay.BetterDisplay").count) > 0;
}

// Both the app binary and betterdisplaycli only talk to the running app (launching the app
// binary here would start a second copy), so without it running there is nothing to call.
function betterDisplayCLI() {
  const inDirs = which("betterdisplaycli");
  if (inDirs) return betterDisplayRunning() ? inDirs : "not-running";
  if (env("DA_BIN_DIRS", null) !== null) {
    const fake = which("BetterDisplay");
    return fake && !betterDisplayRunning() ? "not-running" : fake;
  }
  const home = $.NSHomeDirectory().js;
  for (const app of ["/Applications/BetterDisplay.app", `${home}/Applications/BetterDisplay.app`]) {
    const p = `${app}/Contents/MacOS/BetterDisplay`;
    if (isExecutable(p)) return betterDisplayRunning() ? p : "not-running";
  }
  return null;
}

// `m1ddc display list detailed` prints "[1] Name (UUID)" per display and, since v1.2.0, a
// " - Display ID:    N" line under it. With that ID the display is selected as `id=N`, which is
// exact even for identical monitors; older versions fall back to the list number.
function m1ddcDisplays(bin) {
  const r = spawn(bin, ["display", "list", "detailed"], 4);
  if (r.status !== 0) return [];
  const out = [];
  for (const line of r.out.split("\n")) {
    const m = /^\s*\[(\d+)\]\s+(.*?)\s*(?:\(([0-9A-Fa-f-]{36})\))?\s*$/.exec(line);
    if (m) {
      out.push({ index: m[1], select: m[1], name: m[2], uuid: (m[3] || "").toUpperCase(), displayId: null });
      continue;
    }
    const id = /^\s*-\s*Display ID:\s*(\d+)\s*$/.exec(line);
    if (id && out.length) {
      out[out.length - 1].displayId = Number(id[1]);
      out[out.length - 1].select = `id=${id[1]}`;
    }
  }
  return out;
}

// For each display: how its brightness can be controlled, and the current value (0–100 or null).
function brightnessTargets(list) {
  let bd;
  let m1;
  let m1list;
  const externals = list.filter((d) => HW.brightness(d.id) === null);
  return list.map((d) => {
    const native = HW.brightness(d.id);
    if (native !== null) return { d, via: "native", value: native * 100 };
    if (bd === undefined) bd = betterDisplayCLI();
    if (bd && bd !== "not-running") {
      const r = spawn(bd, ["get", `-displayID=${d.id}`, "-feature=brightness"], 3);
      const v = parseFloat(r.out);
      // a display BetterDisplay doesn't manage falls through to m1ddc
      if (r.status === 0 && isFinite(v)) return { d, via: "betterdisplay", bin: bd, value: v <= 1 ? v * 100 : v };
    }
    if (m1 === undefined) {
      m1 = which("m1ddc");
      m1list = m1 ? m1ddcDisplays(m1) : [];
    }
    if (m1) {
      let t = null;
      let reason = "m1ddc does not list this display";
      if (m1list.some((x) => x.displayId !== null)) {
        // m1ddc 1.2+ reports display IDs: an exact match or nothing (a UUID or name could be a twin's)
        t = m1list.find((x) => x.displayId === d.id) || null;
      } else {
        const byUuid = m1list.filter((x) => x.uuid && x.uuid === String(d.uuid).toUpperCase());
        if (byUuid.length === 1) t = byUuid[0];
        else if (byUuid.length > 1) reason = "identical displays share a UUID, so m1ddc can't tell them apart";
        else {
          const byName = m1list.filter((x) => x.name === d.name);
          if (byName.length === 1) t = byName[0];
          else if (byName.length > 1) reason = "m1ddc can't tell identical displays apart without their UUIDs";
        }
        if (!t && m1list.length === 1 && externals.length === 1) t = m1list[0];
      }
      if (t) {
        const r = spawn(m1, ["display", t.select, "get", "luminance"], 3);
        const v = /^\s*(\d+(?:\.\d+)?)\s*$/.test(r.out) ? parseFloat(r.out) : NaN; // errors go to stdout too
        return { d, via: "m1ddc", bin: m1, index: t.select, value: r.status === 0 && isFinite(v) ? v : null };
      }
      return { d, via: null, reason };
    }
    if (bd && bd !== "not-running") return { d, via: null, reason: "BetterDisplay can't control this display" };
    return { d, via: null, reason: bd === "not-running" ? "open-betterdisplay" : "install" };
  });
}

function viaLabel(t) {
  return { native: "", betterdisplay: "via BetterDisplay", m1ddc: "via m1ddc (DDC)" }[t.via] || "";
}

function brightItems(query) {
  let list;
  try {
    list = displays();
  } catch (e) {
    return [info("Could not read displays", String(e.message || e), "error")];
  }
  if (!list.length) return [info("No displays found", "Wake the display or check the cable", "error")];
  const q = query.trim();
  let rel = null;
  let level = null;
  const r = /^([+-])\s*(\d{1,3})\s*%?$/.exec(q);
  if (r) rel = r[1] === "-" ? -Number(r[2]) : Number(r[2]);
  else if (q) {
    level = parseLevel(q);
    if (level === null || level > 100) return [info("Type a brightness from 0 to 100", "Or +10 / -10 to adjust", "error")];
  }
  const targets = brightnessTargets(list); // a mirrored display still has its own backlight
  const ok = targets.filter((t) => t.via);
  const items = [];
  const status = (t) =>
    t.value === null || t.value === undefined ? "current level unknown" : `currently ${pct(t.value)}`;
  const targetArg = (t) => ({ id: t.d.id, uuid: t.d.uuid, name: t.d.label, via: t.via, index: t.index || null });
  const levels = level !== null || rel !== null ? [level] : [100, 75, 50, 25, 0];
  for (const lv of levels) {
    const what = rel !== null ? `${r[1]}${Math.abs(rel)}%` : `${lv}%`;
    const ico = "bright";
    if (ok.length > 1)
      items.push({
        title: rel !== null ? `Adjust all displays by ${what}` : `All displays → ${what}`,
        subtitle: ok.map((t) => `${t.d.label} ${t.value === null ? "?" : pct(t.value)}`).join(" · "),
        arg: action("bright", { value: lv, rel, targets: ok.map(targetArg) }),
        icon: icon(ico),
      });
    for (const t of ok)
      items.push({
        title: rel !== null ? `${t.d.label} ${what}` : ok.length > 1 ? `${t.d.label} → ${what}` : `Brightness ${what}`,
        subtitle: [ok.length > 1 ? "" : t.d.label, status(t), viaLabel(t)].filter(Boolean).join(" · "),
        arg: action("bright", { value: lv, rel, targets: [targetArg(t)] }),
        icon: icon(ico),
      });
  }
  for (const t of targets.filter((x) => !x.via)) {
    if (t.reason === "open-betterdisplay")
      items.push(info(`${t.d.label}: open BetterDisplay`, "Its command-line interface needs the app running", "info"));
    else if (t.reason === "install")
      items.push(info(`${t.d.label}: brightness not available`, "External displays need BetterDisplay or m1ddc (brew install m1ddc) · ↩ Open the m1ddc page", "install", {
        valid: true,
        arg: action("open", { url: "https://github.com/waydabber/m1ddc" }),
      }));
    else items.push(info(`${t.d.label}: brightness not available`, t.reason || "", "info"));
  }
  if (!ok.length && !items.length) items.push(info("No display supports brightness control", "", "info"));
  return items;
}

function clamp01(v) {
  return Math.max(0, Math.min(100, v));
}

function brightAction(a) {
  const list = displays();
  const done = [];
  const failed = [];
  for (const t of a.targets || []) {
    const d = t && typeof t === "object" ? findDisplay(list, t.uuid, t.id) : null;
    if (!d) {
      failed.push(`${clean((t && t.name) || "That display")} is not connected`);
      continue;
    }
    let cur = null;
    if (t.via === "native") cur = HW.brightness(d.id);
    cur = cur === null ? null : cur * 100;
    if (t.via === "native") {
      if (cur === null) {
        failed.push(`${d.label} can't change brightness`);
        continue;
      }
      const v = clamp01(a.rel !== null && a.rel !== undefined ? cur + a.rel : a.value);
      if (DRY) dry(`DisplayServicesSetBrightness(display=${d.id}, ${(v / 100).toFixed(2)})`);
      else if ($.DisplayServicesSetBrightness(d.id, v / 100) !== 0) {
        failed.push(`${d.label} refused the change`);
        continue;
      }
      done.push(`${d.label} ${pct(v)}`);
    } else if (t.via === "betterdisplay" || t.via === "m1ddc") {
      const [target] = brightnessTargets([d]);
      if (target.via !== t.via) {
        failed.push(`${d.label}: ${t.via === "m1ddc" ? "m1ddc" : "BetterDisplay"} is no longer available`);
        continue;
      }
      if (a.rel !== null && a.rel !== undefined && target.value === null) {
        failed.push(`${d.label}: current brightness unknown`);
        continue;
      }
      const v = Math.round(clamp01(a.rel !== null && a.rel !== undefined ? target.value + a.rel : a.value));
      const args = t.via === "betterdisplay"
        ? ["set", `-displayID=${d.id}`, "-feature=brightness", `-value=${(v / 100).toFixed(2)}`]
        : ["display", target.index, "set", "luminance", String(v)];
      if (DRY) dry([target.bin, ...args].map(shellQuote).join(" "));
      else {
        const r = spawn(target.bin, args, 5);
        if (r.status !== 0) {
          failed.push(`${d.label}: ${(r.err || r.out || "command failed").trim().split("\n")[0]}`);
          continue;
        }
      }
      done.push(`${d.label} ${pct(v)}`);
    }
  }
  return [done.length ? `☀️ ${done.join(" · ")}` : "", ...failed].filter(Boolean).join("\n") || "Nothing to change";
}

// ======================================================================
// Layout (display arrangements)
// ======================================================================

function layoutsPath() {
  return `${dataDir()}/layouts.json`;
}

// A prototype-less object, so names like "constructor" or "__proto__" are ordinary keys.
function hasLayout(layouts, name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(layouts, name);
}

function loadLayouts() {
  const l = readJSON(layoutsPath(), {});
  const out = Object.create(null);
  if (l && typeof l === "object" && !Array.isArray(l))
    for (const k of Object.keys(l)) if (l[k] && typeof l[k] === "object") out[k] = l[k];
  return out;
}

function snapshot(list) {
  const byId = {};
  for (const d of list) byId[d.id] = d;
  return list.map((d) => ({
    uuid: d.uuid,
    id: d.id,
    name: d.label,
    builtin: d.builtin,
    x: d.x,
    y: d.y,
    mirrorOf: d.mirrorOf && byId[d.mirrorOf] ? byId[d.mirrorOf].uuid : null,
    mirrorOfId: d.mirrorOf || null,
    rotation: d.rotation || 0,
    mode: d.current ? { w: d.current.w, h: d.current.h, pw: d.current.pw, ph: d.current.ph, hz: d.current.hz, io: d.current.io } : null,
  }));
}

function describeArrangement(snap) {
  return snap
    .map((s) => `${s.name}${s.mirrorOf ? " (mirrored)" : ` ${s.mode ? `${s.mode.w}×${s.mode.h}` : ""} at ${s.x},${s.y}`}`)
    .join(" · ");
}

function sameArrangement(saved, now) {
  if (!saved || saved.length !== now.length) return false;
  return matchSaved(saved, now).every(
    ([s, n]) =>
      n && n.x === s.x && n.y === s.y && (n.mirrorOf || null) === (s.mirrorOf || null) && sameMode(n.mode, s.mode) &&
      (s.rotation === undefined || (n.rotation || 0) === s.rotation)
  );
}

function missingDisplays(saved, list) {
  return matchSaved(saved, list).filter(([, d]) => !d).map(([s]) => s.name);
}

function displayplacerArgs(out) {
  const line = out.split("\n").reverse().find((l) => /^\s*displayplacer\s+"/.test(l));
  if (!line) return null;
  const args = [];
  const re = /"([^"]*)"/g;
  let m;
  while ((m = re.exec(line))) args.push(m[1]);
  return args.length ? args : null;
}

function layoutItems(query) {
  let list;
  try {
    list = displays();
  } catch (e) {
    return [info("Could not read displays", String(e.message || e), "error")];
  }
  const layouts = loadLayouts();
  // a delete waiting for confirmation (set by ⌥↩, then Alfred reopens with an empty query)
  const pending = pendingDelete();
  if (!query.trim() && pending && hasLayout(layouts, pending))
    return [
      { title: `Delete “${clean(pending)}”?`, subtitle: "↩ Delete this arrangement · This can't be undone", arg: action("layout-delete", { name: pending }), icon: icon("error") },
      { title: "Cancel", subtitle: "Keep the arrangement", arg: action("layout-delete-cancel"), icon: icon("layout") },
    ];
  const snap = snapshot(list);
  const dp = which("displayplacer");
  const engine = dp ? "via displayplacer" : "resolutions and positions";
  const q = query.trim();
  const items = [];
  const save = /^save\b\s*([\s\S]*)$/i.exec(q);
  const name = clean(save ? save[1] : q);
  const saveRow = () =>
    name
      ? {
          title: `${hasLayout(layouts, name) ? "Replace" : "Save"} “${name}”`,
          subtitle: `Save the current arrangement (${list.length} display${list.length === 1 ? "" : "s"}, ${engine})`,
          arg: action("layout-save", { name }),
          icon: icon("save"),
        }
      : info("Type a name for this arrangement", "e.g. save Desk", "save");
  // "save <name>" only saves; any other text filters the saved arrangements first, so ↩ on a
  // typed name restores it rather than overwriting it.
  if (save) return [saveRow()];
  if (!list.length) items.unshift(info("No displays found", "Wake the display or check the cable", "error"));
  const names = Object.keys(layouts).filter((n) => !q || matches(q, n)).sort((a, b) => a.localeCompare(b));
  const saved = names.map((n) => {
    const l = layouts[n];
    const current = sameArrangement(l.displays, snap);
    const missing = missingDisplays(l.displays, list);
    const arg = action("layout-restore", { name: n });
    return {
      title: `${current ? "✓ " : ""}${clean(n)}`,
      subtitle: missing.length
        ? `Missing: ${missing.join(", ")} · ↩ Restore the rest`
        : `${current ? "Current arrangement" : "↩ Restore"} · ${describeArrangement(l.displays || [])}`,
      arg,
      icon: icon("layout"),
      mods: { alt: { arg: action("layout-delete-ask", { name: n }), subtitle: `Delete “${clean(n)}”… (asks to confirm)` } },
    };
  });
  if (!q)
    items.push(info("Current arrangement", describeArrangement(snap) || "No displays", "layout", { autocomplete: "save " }));
  items.push(...saved);
  if (q && !hasLayout(layouts, name)) items.push(saveRow());
  if (!q && !names.length) items.push(info("No saved arrangements yet", "Type “save” and a name to save this one", "info", { autocomplete: "save " }));
  return items;
}

function layoutSave(a) {
  const name = clean(a.name || "");
  if (!name) return "Type a name for the arrangement";
  const list = displays();
  if (!list.length) return "No displays found";
  const entry = { saved: new Date().toISOString(), displays: snapshot(list) };
  const dp = which("displayplacer");
  if (dp) {
    const r = spawn(dp, ["list"], 10);
    const args = r.status === 0 ? displayplacerArgs(r.out) : null;
    if (args) entry.displayplacer = args;
  }
  const layouts = loadLayouts();
  layouts[name] = entry;
  if (!writeJSON(layoutsPath(), layouts)) return `Could not save “${name}”: the workflow’s data folder isn’t writable`;
  return `Saved “${name}” · ${list.length} display${list.length === 1 ? "" : "s"}`;
}

function layoutRestore(a) {
  const layouts = loadLayouts();
  const l = hasLayout(layouts, a.name) ? layouts[a.name] : null;
  if (!l) return `No arrangement named “${a.name}”`;
  const list = displays();
  const missing = missingDisplays(l.displays, list);
  const present = (l.displays || []).length - missing.length;
  if (!present) return `None of the displays in “${a.name}” are connected`;
  // nothing to do: don't make every display flicker through a reconfiguration
  if (!missing.length && sameArrangement(l.displays, snapshot(list))) return `“${a.name}” is already the current arrangement`;
  const dp = which("displayplacer");
  let note = "";
  if (dp && Array.isArray(l.displayplacer) && l.displayplacer.length && !missing.length) {
    if (DRY) {
      dry([dp, ...l.displayplacer].map(shellQuote).join(" "));
      return `Restored “${a.name}” with displayplacer`;
    }
    const r = spawn(dp, l.displayplacer.map(String), 20);
    if (r.status === 0) return `Restored “${a.name}” with displayplacer`;
    // Its screen IDs can change (see its README): fall back to the saved positions and modes.
    note = `displayplacer failed (${(r.err || r.out || "no output").trim().split("\n")[0]}), used the saved positions`;
  }
  const ops = [];
  for (const [s, d] of matchSaved(l.displays, list)) {
    if (!d) continue;
    if (s.mirrorOf) {
      const master = findDisplay(list, s.mirrorOf, s.mirrorOfId);
      if (master && d.mirrorOf !== master.id) ops.push({ kind: "mirror", id: d.id, master: master.id });
      continue;
    }
    if (d.mirrorOf) ops.push({ kind: "mirror", id: d.id, master: 0 });
    if (s.mode && !sameMode(d.current, s.mode)) {
      const modes = d.modes();
      const m = modes.find((x) => sameMode(x, s.mode) && x.io === s.mode.io) || modes.find((x) => sameMode(x, s.mode));
      if (m) ops.push({ kind: "mode", id: d.id, mode: m });
    }
    if (d.x !== s.x || d.y !== s.y || d.mirrorOf) ops.push({ kind: "origin", id: d.id, x: s.x, y: s.y });
  }
  if (!ops.length) return [`“${a.name}” is already the current arrangement`, note].filter(Boolean).join("\n");
  configureDisplays(ops);
  return [`Restored “${a.name}”`, missing.length ? `Not connected: ${missing.join(", ")}` : "", note].filter(Boolean).join("\n");
}

// ⌥↩ never deletes by itself: it remembers the name for a minute and reopens the keyword,
// which then shows "Delete …?" and "Cancel".
const CONFIRM_WINDOW = 60e3;
function confirmPath() {
  return `${dataDir()}/confirm-delete.json`;
}
function pendingDelete() {
  const c = readObject(confirmPath());
  return typeof c.name === "string" && typeof c.t === "number" && Date.now() - c.t >= 0 && Date.now() - c.t < CONFIRM_WINDOW ? c.name : null;
}
function clearPendingDelete() {
  $.NSFileManager.defaultManager.removeItemAtPathError(confirmPath(), $());
}

function layoutKeyword() {
  return env("keyword_layout", "").trim() || "layout";
}

function alfredSearch(q) {
  if (DRY) return dry(`Alfred search "${q}"`);
  Application("com.runningwithcrayons.Alfred").search(q);
}

function layoutDeleteAsk(a) {
  if (!hasLayout(loadLayouts(), a.name)) return `No arrangement named “${clean(String(a.name || ""))}”`;
  if (!writeJSON(confirmPath(), { name: a.name, t: Date.now() })) return "The workflow’s data folder isn’t writable";
  alfredSearch(`${layoutKeyword()} `);
  return undefined;
}

function layoutDeleteCancel() {
  clearPendingDelete();
  alfredSearch(`${layoutKeyword()} `);
  return undefined;
}

function layoutDelete(a) {
  clearPendingDelete();
  const layouts = loadLayouts();
  if (!hasLayout(layouts, a.name)) return `No arrangement named “${clean(String(a.name || ""))}”`;
  delete layouts[a.name];
  if (!writeJSON(layoutsPath(), layouts)) return `Could not delete “${a.name}”: the workflow’s data folder isn’t writable`;
  return `Deleted “${a.name}”`;
}

// ======================================================================
// AirPods listening mode (Control Center UI scripting: see anc.applescript)
// ======================================================================

const ANC_MODES = [
  { key: "Off", icon: "anc_off", note: "No noise control" },
  { key: "Transparency", icon: "anc_transparency", note: "Let outside sound in" },
  { key: "Adaptive", icon: "anc_adaptive", note: "Blend of both (AirPods Pro 2 and later, AirPods 4)" },
  { key: "Noise Cancellation", icon: "anc_nc", note: "Block outside sound" },
];

function ancOutput() {
  const defs = HW.audioDefaults();
  const d = HW.audioDevices().find((x) => x.id === defs.output);
  return d || null;
}

function ancStatePath() {
  return `${dataDir()}/anc.json`;
}

function ancItems(query) {
  const out = ancOutput();
  const state = readObject(ancStatePath());
  const wireless = isWireless(out);
  const items = [];
  if (!wireless)
    items.push(info("AirPods aren't the current output", out ? `Output is ${clean(out.name)} · connect your AirPods first` : "No output device", "info"));
  const known = state.device && out && state.device === out.name ? state.mode : null;
  for (const m of ANC_MODES) {
    if (query && !matches(query, m.key)) continue;
    const isCur = known === m.key;
    items.push({
      title: `${isCur ? "✓ " : ""}${m.key}`,
      subtitle: [wireless ? clean(out.name) : "", isCur ? "Last set" : m.note].filter(Boolean).join(" · "),
      arg: action("anc", { mode: m.key }),
      icon: icon(m.icon),
    });
  }
  if (!items.length) items.push(info(`No listening mode matches “${query}”`, "Off, Transparency, Adaptive or Noise Cancellation"));
  return items;
}

const ANC_ERRORS = {
  accessibility: "Alfred needs Accessibility permission: System Settings › Privacy & Security › Accessibility",
  "no-sound-item": "Show Sound in the menu bar: System Settings › Control Center › Sound › Always Show",
  "no-popover": "The Sound menu didn't open. Try again",
  "no-modes": "No listening modes in the Sound menu: are your AirPods connected and the current output?",
  unavailable: "Your AirPods don't offer that mode",
  "click-failed": "Control Center didn't accept the change. Try again",
};

function isWireless(d) {
  return !!d && (d.transport === "blue" || d.transport === "blea");
}

// The Sound menu's own words for the listening modes and the Spatial Audio choices, in the
// language Control Center uses, read from its string tables. anc.applescript then recognises
// the rows by label in any language instead of guessing from their position.
const CC_RESOURCES = "/System/Library/CoreServices/ControlCenter.app/Contents/Resources";
function ancLabels() {
  const dir = env("DA_CC_RESOURCES", CC_RESOURCES);
  const table = (name) => {
    const d = $.NSDictionary.dictionaryWithContentsOfFile(`${dir}/${name}.loctable`);
    return d.isNil() ? null : d;
  };
  const listening = table("ListeningMode");
  if (!listening) return null;
  const sound = table("Sound");
  const langs = ObjC.deepUnwrap(listening.allKeys).filter((k) => k !== "LocProvenance");
  const pick = $.NSBundle.preferredLocalizationsFromArrayForPreferences($(langs), $.NSLocale.preferredLanguages);
  const lang = pick.count ? pick.objectAtIndex(0).js : "en";
  const strings = (t) => {
    const o = t ? ObjC.deepUnwrap(t.objectForKey(lang)) : null;
    return o && typeof o === "object" ? o : {};
  };
  const lm = strings(listening);
  const sd = strings(sound);
  const modes = ["LISTENING_MODE_OFF", "Transparency", "Adaptive", "Noise Cancellation"].map((k) => (typeof lm[k] === "string" ? lm[k] : ""));
  if (!modes[1] || !modes[3]) return null;
  const other = ["Fixed", "Head Tracked", "Spatialize Stereo"].map((k) => sd[k]).filter((v) => typeof v === "string" && v);
  const one = (v) => String(v).replace(/[\t\n\r]/g, " ");
  return { modes: modes.map(one).join("\t"), other: other.map(one).join("\t") };
}

function ancAction(a) {
  const out = ancOutput();
  const device = out ? out.name : "";
  const modes = a.toggle ? [a.mode, a.other] : [a.mode];
  if (modes.some((m) => !ANC_MODES.find((x) => x.key === m))) return "Unknown listening mode";
  // don't open Control Center for nothing
  if (!isWireless(out)) return `Connect your AirPods first: the output is ${clean(device) || "not set"}`;
  let labels = null;
  try {
    labels = ancLabels();
  } catch (e) {
    labels = null; // fall back to the English names and the row structure
  }
  const argv = [...modes.slice(0, 1), modes[1] || "", device, env("anc_three", "auto"), labels ? labels.modes : "", labels ? labels.other : ""];
  const script = `${$.NSFileManager.defaultManager.currentDirectoryPath.js}/anc.applescript`;
  let res;
  if (DRY) {
    dry(["/usr/bin/osascript", "anc.applescript", ...argv].map(shellQuote).join(" "));
    res = { status: 0, out: `ok:${modes[0]}:${modes[0]}` };
  } else res = spawn("/usr/bin/osascript", [script, ...argv], 25);
  const text = (res.out || "").trim();
  const m = /^ok:([^:]*):(.*)$/.exec(text);
  if (m) {
    writeJSON(ancStatePath(), { mode: m[2], device, time: new Date().toISOString() });
    return `🎧 ${m[2]}${device ? ` · ${clean(device)}` : ""}`;
  }
  const e = /^error:(.*)$/.exec(text);
  if (e) return ANC_ERRORS[e[1]] || `Could not change the listening mode (${e[1]})`;
  if (/assistive|not allowed|1719|25211/i.test(res.err)) return ANC_ERRORS.accessibility;
  return `Could not change the listening mode${res.err ? `: ${res.err.trim().split("\n")[0]}` : ""}`;
}

// ======================================================================
// Actions
// ======================================================================

function deviceAction(a) {
  const scope = a.scope === "input" ? "input" : "output";
  // UIDs survive reconnects and sleep; device IDs don't. Fall back to the ID only without a UID.
  const dev = usableDevices(scope).find((d) => (a.uid ? d.uid === a.uid : d.id === a.id));
  if (!dev) return `${clean(a.name || "") || "That device"} is no longer connected`;
  setDefaultDevice(scope, dev);
  if (a.both) {
    const other = scope === "output" ? "input" : "output";
    const p = partnerDevice(dev, scope);
    if (!p) return `${scope === "output" ? "🔊" : "🎙"} ${clean(dev.name)} (it has no ${other === "input" ? "microphone" : "speakers"})`;
    setDefaultDevice(other, p);
    return `🎧 ${clean(dev.name)} · output and input`;
  }
  if (a.system && scope === "output") {
    if (dev.canSys === false) return `${clean(dev.name)} is now the output (it can't play alerts)`;
    setDefaultDevice("system", dev);
    return `🔊 ${clean(dev.name)} · output and alerts`;
  }
  return `${scope === "output" ? "🔊" : "🎙"} ${clean(dev.name)}`;
}

function volumeAction(a) {
  const scope = a.scope === "input" ? "input" : "output";
  const cur = scope === "input" ? HW.volume().input : HW.volume().output;
  if (cur === null)
    return `${currentDeviceName(scope) || `No ${scope} device`} has no adjustable ${scope === "input" ? "input level" : "volume"}`;
  // a step ("+10") is applied to the level at the moment of ↩, not when the row was shown
  const rel = typeof a.rel === "number" && isFinite(a.rel) ? a.rel : null;
  const v = Math.max(0, Math.min(100, Math.round(rel !== null ? cur + rel : Number(a.value))));
  if (!isFinite(v)) return "Invalid volume";
  if (scope === "input") {
    if (v > 0) {
      const { path, state } = micState();
      writeJSON(path, Object.assign(state, { level: v }));
    }
    setVolume({ inputVolume: v });
    return `🎙 Input level ${v}%`;
  }
  setVolume(v > 0 && HW.volume().muted ? { outputVolume: v, outputMuted: false } : { outputVolume: v });
  return `🔊 Volume ${v}%`;
}

function openURL(url) {
  if (!/^https:\/\//.test(url)) return undefined;
  if (DRY) return dry(`open ${url}`);
  ObjC.import("AppKit");
  $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url));
  return undefined;
}

function act(json) {
  let a;
  try {
    a = JSON.parse(json);
  } catch (e) {
    return "Invalid action";
  }
  // args come from this workflow's own rows, but keep a hand-edited or stale one harmless
  if (!a || typeof a !== "object" || Array.isArray(a)) return "Invalid action";
  if ("name" in a && typeof a.name !== "string") return "Invalid action";
  if ("targets" in a && !Array.isArray(a.targets)) return "Invalid action";
  switch (a.op) {
    case "device": return deviceAction(a);
    case "volume": return volumeAction(a);
    case "mute":
      setVolume({ outputMuted: !!a.value });
      return a.value ? "🔇 Output muted" : "🔊 Output unmuted";
    case "mic-toggle": return micToggle();
    case "mic-mute": return micToggle(true);
    case "mic-unmute": return micToggle(false);
    case "res": return resAction(a);
    case "bright": return brightAction(a);
    case "layout-save": return layoutSave(a);
    case "layout-restore": return layoutRestore(a);
    case "layout-delete": return layoutDelete(a);
    case "layout-delete-ask": return layoutDeleteAsk(a);
    case "layout-delete-cancel": return layoutDeleteCancel();
    case "anc": return ancAction(a);
    case "anc-toggle":
      return ancAction({ mode: env("anc_toggle_a", "Noise Cancellation"), other: env("anc_toggle_b", "Transparency"), toggle: true });
    case "open": return openURL(String(a.url || ""));
    default: return "Unknown action";
  }
}

// ======================================================================

const HANDLERS = { audio: audioItems, mic: micItems, res: resItems, bright: brightItems, layout: layoutItems, anc: ancItems };

function run(argv) {
  const [cmd, query = ""] = argv;
  if (cmd === "act") {
    let msg;
    try {
      msg = act(query);
    } catch (e) {
      msg = `Error: ${e.message || e}`;
    }
    // Nothing to say prints nothing at all (not even a newline), so the Notification object's
    // "only show if populated" stays silent.
    return [...dryCalls.map((c) => `DRY RUN: ${c}`), msg].filter(Boolean).join("\n") || undefined;
  }
  const h = HANDLERS[cmd];
  if (!h) return output([info(`Unknown command: ${cmd}`, "", "error")]);
  try {
    return output(h(String(query)));
  } catch (e) {
    return output([info("Something went wrong", String(e.message || e), "error")]);
  }
}
