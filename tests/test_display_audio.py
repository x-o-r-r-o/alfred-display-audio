#!/usr/bin/env python3
"""End-to-end tests: run the Script Filters and actions the way Alfred does and validate the output.

Hardware comes from JSON fixtures (DA_FIXTURE), which also forces dry-run mode, so no test ever
changes the real audio devices, volume, microphone, display modes, arrangement or brightness.
The RealHardware tests only list (read-only).
"""
import json, os, plistlib, stat, subprocess, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
TMP = tempfile.mkdtemp(prefix="display-audio-test-")
EMPTY_BIN = os.path.join(TMP, "empty-bin")
os.makedirs(EMPTY_BIN)

UUID_MAC = "37D8832A-2D66-02CA-B9F7-8F30A301B230"
UUID_DELL1 = "11111111-2222-3333-4444-555555555555"
UUID_DELL2 = "66666666-7777-8888-9999-AAAAAAAAAAAA"

# ---------- fixtures ----------

def dev(id, name, uid, transport="bltn", out=0, inp=0, can_out=None, can_in=None, can_sys=None, hidden=False):
    return {"id": id, "uid": uid, "name": name, "transport": transport, "out": out, "in": inp,
            "canOut": out > 0 if can_out is None else can_out, "canIn": inp > 0 if can_in is None else can_in,
            "canSys": out > 0 if can_sys is None else can_sys, "hidden": hidden}


DEVICES = [
    dev(81, "MacBook Pro Microphone", "BuiltInMicrophoneDevice", inp=1),
    dev(86, "MacBook Pro Speakers", "BuiltInSpeakerDevice", out=1),
    dev(57, "Microsoft Teams Audio", "MSLoopbackDriverDevice_UID", "virt", out=1, inp=1, can_out=False, can_in=False),
    dev(90, "BlackHole 2ch", "BlackHole2ch_UID", "virt", out=2, inp=2),
    dev(91, "Multi-Output Device", "~:AMS2_StackedOutput:0", "grup", out=2, can_sys=False),
    dev(92, "Xorro’s AirPods Pro", "AA-BB-CC-DD-EE-FF:output", "blue", out=1, inp=1),
    dev(93, "USB Audio Device", "AppleUSBAudioEngine:A:1", "usb", out=2, inp=1),
    dev(94, "USB Audio Device", "AppleUSBAudioEngine:B:2", "usb", out=2, inp=1),
    dev(95, "LG HDR 4K", "AppleGFXHDAEngineOutputDP:1", "dprt", out=2),
    dev(96, "Écouteurs “Studio” de Zoé", "ZoeStudio", "usb", out=2),
    dev(97, "Hidden Device", "hidden", "virt", out=2, hidden=True),
]


def audio(devices=DEVICES, output=86, input=81, system=86, vol=None):
    v = {"output": 40, "input": 60, "alert": 100, "muted": False}
    v.update(vol or {})
    return {"devices": devices, "defaults": {"output": output, "input": input, "system": system}, "volume": v}


def mode(w, h, scale=2, hz=60.0, io=0, flags=0, gui=True):
    return {"w": w, "h": h, "pw": w * scale, "ph": h * scale, "hz": hz, "io": io, "flags": flags, "gui": gui}


BUILTIN_MODES = [
    mode(1728, 1117, 2, 120, 54, 0x02000004), mode(1728, 1117, 2, 60, 55),
    mode(1512, 982, 2, 120, 50), mode(1512, 982, 2, 60, 51),
    mode(2056, 1329, 2, 120, 58), mode(1728, 1117, 1, 120, 90),  # low resolution
    mode(1728, 1117, 2, 120, 54, 0x02000004),  # duplicate
    mode(800, 600, 1, 60, 99, gui=False),
]
DELL_MODES = [mode(2560, 1440, 1, 60, 10), mode(1920, 1080, 2, 60, 11), mode(1920, 1080, 2, 30, 12),
              mode(1920, 1080, 1, 60, 13), mode(3840, 2160, 1, 30, 14)]


def display(id, name, uuid, builtin=False, x=0, y=0, cur=None, modes=None, brightness=None, mirror=0):
    d = {"id": id, "name": name, "uuid": uuid, "builtin": builtin, "x": x, "y": y, "mirrorOf": mirror,
         "current": cur, "modes": modes or []}
    if brightness is not None:
        d["brightness"] = brightness
    return d


def mac(**k):
    base = dict(builtin=True, cur=BUILTIN_MODES[0], modes=BUILTIN_MODES, brightness=0.47)
    base.update(k)
    return display(1, "Built-in Retina Display", UUID_MAC, **base)


def dell(id=2, uuid=UUID_DELL1, **k):
    base = dict(x=1728, y=-200, cur=DELL_MODES[0], modes=DELL_MODES)
    base.update(k)
    return display(id, "DELL U2720Q", uuid, **base)


def fixture(**parts):
    f = {"audio": audio(), "displays": [mac()]}
    f.update(parts)
    path = os.path.join(TMP, f"fixture-{abs(hash(json.dumps(f, sort_keys=True)))}.json")
    with open(path, "w") as fh:
        json.dump(f, fh, ensure_ascii=False)
    return path


def data_dir(name):
    d = os.path.join(TMP, "data-" + name)
    os.makedirs(d, exist_ok=True)
    return d


def call(args, fx=None, data=None, bins=EMPTY_BIN, **env):
    e = dict(os.environ, alfred_workflow_data=data or data_dir("default"), DA_BIN_DIRS=bins, **env)
    e.pop("DA_DRY_RUN", None)
    if fx:
        e["DA_FIXTURE"] = fx
    out = subprocess.run(["osascript", "-l", "JavaScript", "./displayaudio.js", *args], cwd=SRC, env=e,
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return out.stdout.rstrip("\n")


def sf(cmd, query="", fx=None, **kw):
    data = json.loads(call([cmd, query], fx or fixture(), **kw))
    validate(data)
    return data["items"]


def act(op, fx=None, **kw):
    """Run an action; fixtures force dry-run, so this only prints what it would do."""
    return call(["act", op if isinstance(op, str) else json.dumps(op)], fx or fixture(), **kw)


def validate(data):
    assert data.get("skipknowledge") is True
    assert isinstance(data.get("items"), list) and data["items"], data
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        assert os.path.exists(os.path.join(SRC, it["icon"]["path"])), it["icon"]
        if it.get("valid", True) is not False:
            assert "arg" in it, it
            json.loads(it["arg"])
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, m


def titles(items):
    return [i["title"] for i in items]


def find(items, prefix):
    for i in items:
        if i["title"].startswith(prefix):
            return i
    raise AssertionError(f"no item starting with {prefix!r}: {titles(items)}")


def load(path):
    with open(path) as f:
        return json.load(f)


def fake_bin(name, script):
    d = tempfile.mkdtemp(dir=TMP, prefix="bin-")
    p = os.path.join(d, name)
    with open(p, "w") as f:
        f.write("#!/bin/bash\n" + script)
    os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
    return d


# ---------- audio ----------

class AudioTests(unittest.TestCase):
    def test_outputs_current_first_and_filtered(self):
        it = sf("audio")
        self.assertEqual(it[0]["title"], "✓ MacBook Pro Speakers")
        self.assertIn("Alerts play here", it[0]["subtitle"])
        t = titles(it)
        self.assertNotIn("Microsoft Teams Audio", " ".join(t))  # can't be a default device
        self.assertNotIn("Hidden Device", " ".join(t))
        self.assertNotIn("MacBook Pro Microphone", t)  # input only
        self.assertIn("BlackHole 2ch", t)
        self.assertIn("Virtual", find(it, "BlackHole")["subtitle"])
        self.assertIn("Aggregate", find(it, "Multi-Output")["subtitle"])
        self.assertTrue(find(it, "Volume 40%"))
        self.assertEqual(find(it, "Input devices")["autocomplete"], "in ")

    def test_identical_names_are_numbered_and_use_uid(self):
        it = sf("audio", "usb audio")
        self.assertEqual(titles(it), ["USB Audio Device (1)", "USB Audio Device (2)"])
        uids = [json.loads(i["arg"])["uid"] for i in it]
        self.assertEqual(uids, ["AppleUSBAudioEngine:A:1", "AppleUSBAudioEngine:B:2"])
        out = act(it[1]["arg"])
        self.assertIn("device=94", out)

    def test_same_name_different_transport(self):
        devs = [dev(1, "Studio", "u1", "usb", out=2), dev(2, "Studio", "b1", "blue", out=2)]
        it = sf("audio", "studio", fixture(audio=audio(devs, output=1)))
        self.assertEqual(sorted(titles(it)), ["Studio (Bluetooth)", "✓ Studio (USB)"])

    def test_unicode_names_and_accent_insensitive_filter(self):
        it = sf("audio", "ecouteurs zoe")
        self.assertEqual(titles(it), ["Écouteurs “Studio” de Zoé"])
        it = sf("audio", "xorro’s")
        self.assertEqual(it[0]["icon"]["path"], "icons/airpods.png")
        out = act(it[0]["arg"])
        self.assertIn("Xorro’s AirPods Pro", out)

    def test_cmd_sets_system_device_too(self):
        it = sf("audio", "lg hdr")
        out = act(it[0]["mods"]["cmd"]["arg"])
        self.assertIn("'dOut', device=95", out)
        self.assertIn("'sOut', device=95", out)
        it = sf("audio", "multi-output")
        self.assertIs(it[0]["mods"]["cmd"]["valid"], False)

    def test_set_output_dry_run(self):
        out = act({"op": "device", "scope": "output", "uid": "BlackHole2ch_UID", "name": "BlackHole 2ch"})
        self.assertEqual(out.splitlines()[0], "DRY RUN: AudioObjectSetPropertyData(kAudioObjectSystemObject, 'dOut', device=90 \"BlackHole 2ch\" uid=BlackHole2ch_UID)")
        self.assertNotIn("sOut", out)

    def test_disconnected_device(self):
        out = act({"op": "device", "scope": "output", "uid": "gone", "name": "Old Speaker"})
        self.assertEqual(out, "Old Speaker is no longer connected")
        self.assertNotIn("DRY RUN", out)

    def test_inputs(self):
        it = sf("audio", "in")
        self.assertEqual(it[0]["title"], "✓ MacBook Pro Microphone")
        self.assertIn("BlackHole 2ch", titles(it))
        self.assertTrue(find(it, "Input level 60%"))
        out = act(find(it, "BlackHole")["arg"])
        self.assertIn("'dIn ', device=90", out)
        self.assertEqual(titles(sf("audio", "in blackhole")), ["BlackHole 2ch"])

    def test_volume(self):
        it = sf("audio", "50")
        self.assertEqual(it[0]["title"], "Set output volume to 50%")
        self.assertIn("Currently 40%", it[0]["subtitle"])
        self.assertIn("DRY RUN: set volume outputVolume 50", act(it[0]["arg"]))
        self.assertEqual(sf("audio", "150")[0]["valid"], False)
        it = sf("audio", "in 70%")
        self.assertIn("DRY RUN: set volume inputVolume 70", act(it[0]["arg"], data=data_dir("vol")))

    def test_volume_unmutes_when_muted(self):
        fx = fixture(audio=audio(vol={"muted": True}))
        self.assertIn("outputMuted false", act({"op": "volume", "scope": "output", "value": 30}, fx))
        self.assertEqual(find(sf("audio", "", fx), "Volume")["title"], "Volume: muted")

    def test_mute_words(self):
        it = sf("audio", "mute")
        self.assertEqual(it[0]["title"], "Mute output")
        self.assertIn("outputMuted true", act(it[0]["arg"]))

    def test_volume_not_adjustable(self):
        fx = fixture(audio=audio(output=95, vol={"output": None}))
        self.assertIn("has no adjustable volume", sf("audio", "50", fx)[0]["title"])
        self.assertTrue(find(sf("audio", "", fx), "Volume: not adjustable"))

    def test_no_devices_and_no_match(self):
        fx = fixture(audio=audio([], output=0, input=0, system=0))
        self.assertEqual(sf("audio", "", fx)[0]["title"], "No output devices found")
        self.assertTrue(sf("audio", "zzz")[0]["title"].startswith("No output device matches"))

    def test_quotes_and_newlines_in_query(self):
        for q in ['"; rm -rf ~', "zz\nqq", "'", "\\", "${HOME}"]:
            self.assertTrue(sf("audio", q)[0]["title"].startswith("No output device matches"))


# ---------- microphone ----------

class MicTests(unittest.TestCase):
    def test_toggle_row(self):
        it = sf("mic")
        self.assertEqual(it[0]["title"], "Mute microphone")
        self.assertIn("Input level 60%", it[0]["subtitle"])
        self.assertEqual(it[1]["title"], "✓ MacBook Pro Microphone")
        it = sf("mic", "", fixture(audio=audio(vol={"input": 0})))
        self.assertEqual(it[0]["title"], "Unmute microphone")

    def test_mute_remembers_level_and_unmute_restores(self):
        d = data_dir("mic")
        out = act({"op": "mic-toggle"}, data=d)
        self.assertIn("DRY RUN: set volume inputVolume 0", out)
        self.assertIn("Microphone muted", out)
        self.assertEqual(load(os.path.join(d, "mic.json"))["level"], 60)
        out = act({"op": "mic-toggle"}, fixture(audio=audio(vol={"input": 0})), data=d)
        self.assertIn("DRY RUN: set volume inputVolume 60", out)

    def test_unmute_default_level(self):
        d = data_dir("mic-default")
        fx = fixture(audio=audio(vol={"input": 0}))
        self.assertIn("inputVolume 75", act({"op": "mic-toggle"}, fx, data=d))
        self.assertIn("inputVolume 30", act({"op": "mic-toggle"}, fx, data=d, mic_level="30"))
        self.assertIn("inputVolume 75", act({"op": "mic-toggle"}, fx, data=d, mic_level="abc"))

    def test_muting_twice_keeps_level(self):
        d = data_dir("mic-twice")
        act({"op": "mic-mute"}, data=d)
        act({"op": "mic-mute"}, fixture(audio=audio(vol={"input": 0})), data=d)
        self.assertEqual(load(os.path.join(d, "mic.json"))["level"], 60)

    def test_no_input_or_no_level(self):
        fx = fixture(audio=audio(output=86, input=0))
        self.assertEqual(sf("mic", "", fx)[0]["title"], "No input device")
        self.assertEqual(act({"op": "mic-toggle"}, fx), "No input device")
        fx = fixture(audio=audio(vol={"input": None}))
        self.assertIn("no adjustable input level", sf("mic", "", fx)[0]["title"])
        self.assertIn("no adjustable input level", act({"op": "mic-toggle"}, fx))

    def test_level_and_filter(self):
        it = sf("mic", "30")
        self.assertEqual(it[0]["title"], "Set input level to 30%")
        self.assertEqual(titles(sf("mic", "blackhole")), ["BlackHole 2ch"])


# ---------- resolution ----------

class ResolutionTests(unittest.TestCase):
    def test_modes_marked_and_deduplicated(self):
        it = sf("res")
        t = titles(it)
        self.assertEqual(t.count("✓ 1728 × 1117 · HiDPI · 120 Hz"), 1)
        cur = find(it, "✓")
        self.assertIs(cur["valid"], False)
        self.assertIn("Native, Default", cur["subtitle"])
        self.assertNotIn("1728 × 1117 · HiDPI · 60 Hz", t)  # highest refresh only
        self.assertNotIn("1728 × 1117 · 120 Hz", t)  # low resolution hidden
        self.assertNotIn("800 × 600 · 60 Hz", t)  # not usable for the desktop
        self.assertEqual(t[0], "2056 × 1329 · HiDPI · 120 Hz")

    def test_options(self):
        t = titles(sf("res", "", res_refresh="all", res_lowres="1"))
        self.assertIn("1728 × 1117 · HiDPI · 60 Hz", t)
        self.assertIn("1728 × 1117 · 120 Hz", t)

    def test_two_displays_and_filters(self):
        fx = fixture(displays=[mac(), dell()])
        it = sf("res", "", fx)
        self.assertTrue(any("DELL U2720Q" in i["subtitle"] for i in it))
        self.assertTrue(it[0]["subtitle"].startswith("Built-in"))
        it = sf("res", "dell hidpi", fx)
        self.assertEqual(titles(it), ["1920 × 1080 · HiDPI · 60 Hz"])
        self.assertEqual(titles(sf("res", "3840x2160", fx)), ["3840 × 2160 · 30 Hz"])  # 1x on an external display stays
        self.assertNotIn("1920 × 1080 · 60 Hz", titles(sf("res", "dell", fx)))  # 1x copy of a HiDPI size
        self.assertTrue(sf("res", "9999", fx)[0]["title"].startswith("No display mode matches"))

    def test_switch_dry_run(self):
        fx = fixture(displays=[mac(), dell()])
        it = sf("res", "dell hidpi", fx)
        out = act(it[0]["arg"], fx)
        self.assertEqual(out.splitlines()[:3], [
            "DRY RUN: CGBeginDisplayConfiguration",
            "DRY RUN: CGConfigureDisplayWithDisplayMode(display=2, 1920x1080 HiDPI 60Hz io=11)",
            "DRY RUN: CGCompleteDisplayConfiguration(kCGConfigurePermanently)",
        ])
        self.assertTrue(out.endswith("DELL U2720Q · 1920 × 1080 · HiDPI · 60 Hz"))

    def test_display_ids_change_after_reconnect(self):
        fx = fixture(displays=[mac(), dell()])
        arg = sf("res", "dell hidpi", fx)[0]["arg"]
        fx2 = fixture(displays=[mac(), dell(id=7, modes=[dict(m, io=m["io"] + 100) for m in DELL_MODES])])
        self.assertIn("display=7, 1920x1080 HiDPI 60Hz io=111", act(arg, fx2))

    def test_identical_displays(self):
        fx = fixture(displays=[mac(), dell(), dell(id=3, uuid=UUID_DELL2, x=4288, y=-200)])
        it = sf("res", "2560", fx)
        self.assertEqual([i["subtitle"].split(" · ")[0] for i in it], ["DELL U2720Q (1)", "DELL U2720Q (2)"])
        out = act(it[1]["arg"], fixture(displays=[mac(), dell(), dell(id=3, uuid=UUID_DELL2, x=4288, y=-200, cur=DELL_MODES[1])]))
        self.assertIn("display=3", out)

    def test_disconnected_and_vanished_mode(self):
        fx = fixture(displays=[mac(), dell()])
        arg = sf("res", "dell hidpi", fx)[0]["arg"]
        self.assertEqual(act(arg, fixture(displays=[mac()])), "DELL U2720Q is no longer connected")
        self.assertIn("no longer available", act(arg, fixture(displays=[mac(), dell(modes=DELL_MODES[:1])])))
        self.assertIn("already uses", act(arg, fixture(displays=[mac(), dell(cur=DELL_MODES[1])])))

    def test_mac_mini_and_clamshell(self):
        fx = fixture(displays=[dell(x=0, y=0)])
        it = sf("res", "", fx)
        self.assertEqual(it[0]["icon"]["path"], "icons/display.png")
        self.assertTrue(find(it, "✓ 2560 × 1440"))
        self.assertEqual(sf("res", "", fixture(displays=[]))[0]["title"], "No displays found")

    def test_mirrored_display(self):
        fx = fixture(displays=[mac(), dell(x=0, y=0, mirror=1)])
        self.assertIn("(mirrors Built-in Retina Display)", sf("res", "dell", fx)[0]["subtitle"])


# ---------- brightness ----------

M1DDC = r'''
case "$*" in
  "display list") echo "[1] DELL U2720Q (11111111-2222-3333-4444-555555555555)"; echo "[2] DELL U2720Q (66666666-7777-8888-9999-AAAAAAAAAAAA)";;
  "display 1 get luminance") echo 30;;
  "display 2 get luminance") echo 80;;
  *) echo "unexpected: $*" >&2; exit 1;;
esac
'''


class BrightnessTests(unittest.TestCase):
    def test_presets_single_display(self):
        it = sf("bright")
        self.assertEqual(titles(it), ["Brightness 100%", "Brightness 75%", "Brightness 50%", "Brightness 25%", "Brightness 0%"])
        self.assertIn("currently 47%", it[0]["subtitle"])

    def test_set_and_adjust_dry_run(self):
        it = sf("bright", "60")
        self.assertEqual(len(it), 1)
        self.assertIn("DRY RUN: DisplayServicesSetBrightness(display=1, 0.60)", act(it[0]["arg"]))
        it = sf("bright", "+10")
        self.assertIn("0.57", act(it[0]["arg"]))
        it = sf("bright", "-90")
        self.assertIn("0.00)", act(it[0]["arg"]))

    def test_invalid(self):
        for q in ["abc", "150", "50 50"]:
            self.assertEqual(sf("bright", q)[0]["title"], "Type a brightness from 0 to 100")

    def test_external_without_tools(self):
        fx = fixture(displays=[mac(), dell()])
        it = sf("bright", "", fx)
        hint = find(it, "DELL U2720Q: brightness not available")
        self.assertIn("m1ddc", hint["subtitle"])
        self.assertIn("github.com", act(hint["arg"], fx))

    def test_external_with_m1ddc_identical_names(self):
        bins = fake_bin("m1ddc", M1DDC)
        fx = fixture(displays=[mac(), dell(), dell(id=3, uuid=UUID_DELL2, x=4288)])
        it = sf("bright", "40", fx, bins=bins)
        self.assertEqual(titles(it), ["All displays → 40%", "Built-in Retina Display → 40%", "DELL U2720Q (1) → 40%", "DELL U2720Q (2) → 40%"])
        self.assertIn("currently 80%", it[3]["subtitle"])
        out = act(it[0]["arg"], fx, bins=bins)
        self.assertIn("DisplayServicesSetBrightness(display=1, 0.40)", out)
        self.assertIn("m1ddc display 1 set luminance 40", out)
        self.assertIn("m1ddc display 2 set luminance 40", out)
        out = act(sf("bright", "+30", fx, bins=bins)[3]["arg"], fx, bins=bins)
        self.assertIn("display 2 set luminance 100", out)

    def test_betterdisplay(self):
        bins = fake_bin("betterdisplaycli", 'case "$1" in get) echo 0.25;; set) exit 0;; esac\n')
        fx = fixture(displays=[mac(), dell()])
        it = sf("bright", "70", fx, bins=bins)
        d = find(it, "DELL U2720Q")
        self.assertIn("currently 25%", d["subtitle"])
        self.assertIn("via BetterDisplay", d["subtitle"])
        self.assertIn("betterdisplaycli set -displayID=2 -feature=brightness -value=0.70", act(d["arg"], fx, bins=bins))

    def test_display_gone_before_action(self):
        arg = sf("bright", "50")[0]["arg"]
        self.assertIn("is not connected", act(arg, fixture(displays=[dell(x=0, y=0)])))

    def test_clamshell_external_only(self):
        fx = fixture(displays=[dell(x=0, y=0)])
        it = sf("bright", "", fx)
        self.assertEqual(it[0]["title"], "DELL U2720Q: brightness not available")


# ---------- arrangements ----------

DISPLAYPLACER = r'''
if [ "$1" = list ]; then
  echo 'Persistent screen id: 37D8832A-2D66-02CA-B9F7-8F30A301B230'
  echo ''
  echo 'Execute the command below to set your screens to the current arrangement:'
  echo ''
  echo 'displayplacer "id:37D8832A-2D66-02CA-B9F7-8F30A301B230 res:1728x1117 hz:120 color_depth:8 enabled:true scaling:on origin:(0,0) degree:0" "id:11111111-2222-3333-4444-555555555555 res:2560x1440 hz:60 color_depth:8 enabled:true scaling:off origin:(1728,-200) degree:90"'
  exit 0
fi
exit 1
'''


class LayoutTests(unittest.TestCase):
    def test_save_list_restore_delete(self):
        d = data_dir("layout")
        fx = fixture(displays=[mac(), dell()])
        it = sf("layout", "save Desk “home” 'x'", fx, data=d)
        self.assertEqual(it[0]["title"], "Save “Desk “home” 'x'”")
        self.assertIn("Saved", act(it[0]["arg"], fx, data=d))
        saved = load(os.path.join(d, "layouts.json"))
        self.assertEqual(saved["Desk “home” 'x'"]["displays"][1]["x"], 1728)
        it = sf("layout", "", fx, data=d)
        self.assertEqual(it[0]["title"], "Current arrangement")
        self.assertEqual(find(it, "✓ Desk")["subtitle"].split(" · ")[0], "Current arrangement")
        self.assertIn("already the current arrangement", act(find(it, "✓ Desk")["arg"], fx, data=d))
        # move the external display and switch its mode, then restore
        moved = fixture(displays=[mac(), dell(x=-2560, y=0, cur=DELL_MODES[1])])
        item = find(sf("layout", "", moved, data=d), "Desk")
        self.assertFalse(item["title"].startswith("✓"))
        out = act(item["arg"], moved, data=d)
        self.assertIn("CGConfigureDisplayWithDisplayMode(display=2, 2560x1440 60Hz io=10)", out)
        self.assertIn("CGConfigureDisplayOrigin(display=2, x=1728, y=-200)", out)
        self.assertNotIn("display=1,", out)
        self.assertIn("Restored", out)
        out = act(item["mods"]["alt"]["arg"], moved, data=d)
        self.assertIn("Deleted", out)
        self.assertEqual(load(os.path.join(d, "layouts.json")), {})

    def test_missing_display(self):
        d = data_dir("layout-missing")
        two = fixture(displays=[mac(), dell()])
        act({"op": "layout-save", "name": "Office"}, two, data=d)
        one = fixture(displays=[mac(x=0)])
        item = find(sf("layout", "office", one, data=d), "Office")
        self.assertIn("Missing: DELL U2720Q", item["subtitle"])
        out = act(item["arg"], one, data=d)
        self.assertIn("already the current arrangement", out)
        only_dell = fixture(displays=[dell(x=0, y=0)])
        out = act(item["arg"], only_dell, data=d)
        self.assertIn("CGConfigureDisplayOrigin(display=2, x=1728, y=-200)", out)
        self.assertIn("Not connected: Built-in Retina Display", out)
        self.assertIn("None of the displays", act(item["arg"], fixture(displays=[dell(id=5, uuid=UUID_DELL2)]), data=d))

    def test_mirroring_restored(self):
        d = data_dir("layout-mirror")
        act({"op": "layout-save", "name": "Mirror"}, fixture(displays=[mac(), dell(x=0, y=0, mirror=1)]), data=d)
        out = act({"op": "layout-restore", "name": "Mirror"}, fixture(displays=[mac(), dell()]), data=d)
        self.assertIn("CGConfigureDisplayMirrorOfDisplay(display=2, master=1)", out)
        act({"op": "layout-save", "name": "Extend"}, fixture(displays=[mac(), dell()]), data=d)
        out = act({"op": "layout-restore", "name": "Extend"}, fixture(displays=[mac(), dell(x=0, y=0, mirror=1)]), data=d)
        self.assertIn("CGConfigureDisplayMirrorOfDisplay(display=2, master=0)", out)
        self.assertIn("CGConfigureDisplayOrigin(display=2, x=1728, y=-200)", out)

    def test_displayplacer(self):
        d = data_dir("layout-dp")
        bins = fake_bin("displayplacer", DISPLAYPLACER)
        fx = fixture(displays=[mac(), dell()])
        self.assertIn("via displayplacer", sf("layout", "save Rotated", fx, data=d, bins=bins)[0]["subtitle"])
        act({"op": "layout-save", "name": "Rotated"}, fx, data=d, bins=bins)
        saved = load(os.path.join(d, "layouts.json"))["Rotated"]
        self.assertEqual(len(saved["displayplacer"]), 2)
        self.assertIn("degree:90", saved["displayplacer"][1])
        out = act({"op": "layout-restore", "name": "Rotated"}, fx, data=d, bins=bins)
        self.assertIn("displayplacer 'id:37D8832A-2D66-02CA-B9F7-8F30A301B230 res:1728x1117", out)
        self.assertIn("with displayplacer", out)

    def test_empty_states(self):
        d = data_dir("layout-empty")
        it = sf("layout", "", data=d)
        self.assertEqual(titles(it), ["Current arrangement", "No saved arrangements yet"])
        self.assertEqual(sf("layout", "save", data=d)[0]["title"], "Type a name for this arrangement")
        self.assertEqual(sf("layout", "Work", data=d)[0]["title"], "Save “Work”")
        self.assertEqual(act({"op": "layout-restore", "name": "Nope"}, data=d), "No arrangement named “Nope”")

    def test_corrupt_layouts_file(self):
        d = data_dir("layout-corrupt")
        with open(os.path.join(d, "layouts.json"), "w") as f:
            f.write("{not json")
        self.assertEqual(titles(sf("layout", "", data=d))[1], "No saved arrangements yet")


# ---------- AirPods ----------

class ANCTests(unittest.TestCase):
    def test_not_airpods(self):
        it = sf("anc")
        self.assertEqual(it[0]["title"], "AirPods aren't the current output")
        self.assertEqual(titles(it)[1:], ["Off", "Transparency", "Adaptive", "Noise Cancellation"])

    def test_set_mode_dry_run_and_state(self):
        d = data_dir("anc")
        fx = fixture(audio=audio(output=92))
        it = sf("anc", "noise", fx, data=d)
        self.assertEqual(titles(it), ["Noise Cancellation"])
        self.assertIn("Xorro’s AirPods Pro", it[0]["subtitle"])
        out = act(it[0]["arg"], fx, data=d)
        self.assertIn("DRY RUN: /usr/bin/osascript anc.applescript 'Noise Cancellation' '' 'Xorro’s AirPods Pro' auto", out)
        self.assertTrue(out.endswith("Noise Cancellation · Xorro’s AirPods Pro"))
        self.assertEqual(find(sf("anc", "", fx, data=d), "✓")["title"], "✓ Noise Cancellation")

    def test_hotkey_toggle_uses_configuration(self):
        fx = fixture(audio=audio(output=92))
        out = act({"op": "anc-toggle"}, fx, anc_toggle_a="Adaptive", anc_toggle_b="Off", anc_three="off")
        self.assertIn("anc.applescript Adaptive Off", out)
        self.assertIn(" off", out.splitlines()[0])

    def test_unknown_mode(self):
        self.assertEqual(act({"op": "anc", "mode": "Loud"}), "Unknown listening mode")

    def test_applescript_compiles(self):
        out = subprocess.run(["osacompile", "-o", os.path.join(TMP, "anc.scpt"), os.path.join(SRC, "anc.applescript")],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)


# ---------- misc ----------

HARNESS = """
on run argv
	set s to load script POSIX file (item 1 of argv)
	set dev to item 2 of argv
	set layout3 to item 3 of argv
	set infos to {}
	set AppleScript's text item delimiters to tab
	repeat with i from 4 to count of argv
		set f to text items of (item i of argv)
		set end of infos to {kind:item 1 of f, ident:item 2 of f, lbl:item 3 of f, checked:(item 4 of f is "1")}
	end repeat
	set idx to s's pickRows(infos, dev)
	set labels to {}
	repeat with i in idx
		set end of labels to lbl of item i of infos
	end repeat
	set names to s's namesFor(labels, dev, layout3)
	set AppleScript's text item delimiters to ","
	return (idx as text) & "|" & (names as text)
end run
"""


def sound_menu(device="AirPods Pro", modes=("Transparency", "Adaptive", "Noise Cancellation"), checked=2,
               spatial=("Off", "Fixed", "Head Tracked"), selected=True, output_heading_id=""):
    """Rows of the Sound menu as (role, identifier, label, on)."""
    dev_id = "sound-device-" + device
    rows = [("AXHeading", output_heading_id, "Output", 0),
            ("AXCheckBox", "sound-device-MacBook Pro Speakers", "MacBook Pro Speakers", 0 if selected else 1),
            ("AXCheckBox", dev_id, device + ", 80%", 1 if selected else 0),
            ("AXDisclosureTriangle", dev_id, "", 1)]
    if modes:
        rows.append(("AXHeading", dev_id, "Listening Mode", 0))
        rows += [("AXCheckBox", dev_id, m, 1 if i == checked else 0) for i, m in enumerate(modes)]
    if spatial:
        rows.append(("AXHeading", dev_id, "Spatial Audio", 0))
        rows += [("AXCheckBox", dev_id, m, 1 if i == 0 else 0) for i, m in enumerate(spatial)]
    rows.append(("AXButton", "", "Sound Settings…", 0))
    return rows


def pick(rows, device="AirPods Pro", layout3="auto"):
    compiled = os.path.join(TMP, "anc-under-test.scpt")
    if not os.path.exists(compiled):
        subprocess.run(["osacompile", "-o", compiled, os.path.join(SRC, "anc.applescript")], check=True)
    harness = os.path.join(TMP, "harness.applescript")
    with open(harness, "w") as f:
        f.write(HARNESS)
    argv = [compiled, device, layout3] + ["\t".join([r[0], r[1], r[2], str(r[3])]) for r in rows]
    out = subprocess.run(["osascript", harness, *argv], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    idx, names = out.stdout.strip().split("|")
    labels = [rows[int(i) - 1][2] for i in idx.split(",")] if idx else []
    return labels, names.split(",") if names else []


class ANCRowPickingTests(unittest.TestCase):
    """The Control Center row logic of anc.applescript, fed with simulated Sound menus."""

    def test_english_pro(self):
        self.assertEqual(pick(sound_menu()), (["Transparency", "Adaptive", "Noise Cancellation"],) * 2)

    def test_english_with_off(self):
        rows = sound_menu(modes=("Off", "Transparency", "Adaptive", "Noise Cancellation"))
        self.assertEqual(pick(rows)[1], ["Off", "Transparency", "Adaptive", "Noise Cancellation"])

    def test_german(self):
        rows = sound_menu(modes=("Transparenz", "Adaptiv", "Geräuschunterdrückung"), spatial=("Aus", "Fixiert", "Kopfbewegung"))
        labels, names = pick(rows)
        self.assertEqual(labels, ["Transparenz", "Adaptiv", "Geräuschunterdrückung"])
        self.assertEqual(names, ["Transparency", "Adaptive", "Noise Cancellation"])

    def test_max_in_french(self):
        rows = sound_menu("AirPods Max de Zoé", modes=("Désactivé", "Transparence", "Réduction du bruit"), spatial=("Désactivé", "Fixe", "Suivi"))
        labels, names = pick(rows, "AirPods Max de Zoé")
        self.assertEqual(labels, ["Désactivé", "Transparence", "Réduction du bruit"])
        self.assertEqual(names, ["Off", "Transparency", "Noise Cancellation"])
        self.assertEqual(pick(rows, "AirPods Max de Zoé", "adaptive")[1], ["Transparency", "Adaptive", "Noise Cancellation"])

    def test_spatial_audio_only_is_never_picked(self):
        self.assertEqual(pick(sound_menu(modes=None)), ([], []))

    def test_device_list_is_never_picked(self):
        # AirPods not the current output, three devices under an Output heading that has an identifier
        rows = sound_menu(modes=None, spatial=None, selected=False, output_heading_id="output-section")
        rows.insert(3, ("AXCheckBox", "sound-device-LG HDR 4K", "LG HDR 4K", 0))
        self.assertEqual(pick(rows), ([], []))

    def test_other_language_without_selected_device_is_refused(self):
        rows = sound_menu(modes=("Transparenz", "Adaptiv", "Geräuschunterdrückung"), spatial=("Aus", "Fixiert", "Kopfbewegung"), selected=False)
        self.assertEqual(pick(rows), ([], []))

    def test_other_device_name_is_refused(self):
        rows = sound_menu(modes=("Transparenz", "Adaptiv", "Geräuschunterdrückung"), spatial=None)
        self.assertEqual(pick(rows, "Other AirPods"), ([], []))


class ActionTests(unittest.TestCase):
    def test_invalid_actions(self):
        self.assertEqual(act("not json"), "Invalid action")
        self.assertEqual(act({"op": "nope"}), "Unknown action")
        self.assertEqual(act({"op": "open", "url": "file:///etc/hosts"}), "")

    def test_unknown_command(self):
        data = json.loads(call(["nope", ""], fixture()))
        self.assertEqual(data["items"][0]["title"], "Unknown command: nope")


class AuditPass1Tests(unittest.TestCase):
    """Regressions for bugs found in the first audit."""

    def test_volume_on_device_without_volume(self):
        fx = fixture(audio=audio(output=95, vol={"output": None}))
        out = act({"op": "volume", "scope": "output", "value": 30}, fx)
        self.assertEqual(out, "LG HDR 4K has no adjustable volume")
        fx = fixture(audio=audio(vol={"input": None}))
        self.assertIn("no adjustable input level", act({"op": "volume", "scope": "input", "value": 30}, fx))

    def test_device_without_uid_uses_id(self):
        devs = [dev(1, "Odd A", "", "usb", out=2), dev(2, "Odd B", "", "usb", out=2)]
        fx = fixture(audio=audio(devs, output=1))
        arg = find(sf("audio", "odd b", fx), "Odd B")["arg"]
        self.assertIn("device=2", act(arg, fx))

    def test_highest_refresh_keeps_current_and_offers_faster(self):
        fx = fixture(displays=[mac(cur=BUILTIN_MODES[1])])  # 1728 × 1117 HiDPI at 60 Hz
        t = titles(sf("res", "1728", fx))
        self.assertIn("✓ 1728 × 1117 · HiDPI · 60 Hz", t)
        self.assertIn("1728 × 1117 · HiDPI · 120 Hz", t)

    def test_mirrored_external_brightness(self):
        bins = fake_bin("m1ddc", M1DDC)
        fx = fixture(displays=[mac(), dell(x=0, y=0, mirror=1)])
        self.assertTrue(find(sf("bright", "50", fx, bins=bins), "DELL U2720Q → 50%"))

    def test_typing_a_saved_name_restores_instead_of_replacing(self):
        d = data_dir("pass1-layout")
        fx = fixture(displays=[mac(), dell()])
        act({"op": "layout-save", "name": "Desk"}, fx, data=d)
        it = sf("layout", "Desk", fx, data=d)
        self.assertEqual(json.loads(it[0]["arg"])["op"], "layout-restore")
        self.assertNotIn("Replace “Desk”", titles(it))
        self.assertEqual(titles(sf("layout", "save Desk", fx, data=d)), ["Replace “Desk”"])
        it = sf("layout", "De", fx, data=d)
        self.assertEqual(json.loads(it[0]["arg"])["op"], "layout-restore")
        self.assertEqual(it[-1]["title"], "Save “De”")

    def test_layout_names_that_are_object_keys(self):
        d = data_dir("pass1-proto")
        fx = fixture(displays=[mac()])
        self.assertEqual(sf("layout", "constructor", fx, data=d)[0]["title"], "Save “constructor”")
        self.assertEqual(act({"op": "layout-restore", "name": "constructor"}, fx, data=d), "No arrangement named “constructor”")
        for n in ["__proto__", "constructor", "toString"]:
            act({"op": "layout-save", "name": n}, fx, data=d)
        self.assertEqual(sorted(load(os.path.join(d, "layouts.json"))), ["__proto__", "constructor", "toString"])
        self.assertIn("already the current", act({"op": "layout-restore", "name": "__proto__"}, fx, data=d))
        self.assertEqual(act({"op": "layout-delete", "name": "__proto__"}, fx, data=d), "Deleted “__proto__”")

    def test_m1ddc_identical_names_without_uuid(self):
        bins = fake_bin("m1ddc", 'case "$*" in "display list") echo "[1] DELL U2720Q"; echo "[2] DELL U2720Q";; *) echo 50;; esac\n')
        fx = fixture(displays=[mac(), dell(), dell(id=3, uuid=UUID_DELL2, x=4288)])
        it = sf("bright", "", fx, bins=bins)
        self.assertIn("identical displays", find(it, "DELL U2720Q (1): brightness not available")["subtitle"])


class AuditPass2Tests(unittest.TestCase):
    """Regressions for bugs found in the second audit."""

    def twins(self, x2=1728, x3=4288):
        # identical monitors without serial numbers: same UUID, different display IDs
        return [mac(), dell(id=2, uuid=UUID_DELL1, x=x2), dell(id=3, uuid=UUID_DELL1, x=x3)]

    def test_resolution_on_twin_with_shared_uuid(self):
        fx = fixture(displays=self.twins())
        it = sf("res", "dell 2560", fx)
        self.assertEqual(len(it), 2)
        arg = [i["arg"] for i in it if json.loads(i["arg"])["id"] == 3][0]
        self.assertIn("display=3", act(arg, fixture(displays=[mac(), dell(id=2, uuid=UUID_DELL1, cur=DELL_MODES[1]), dell(id=3, uuid=UUID_DELL1, x=4288, cur=DELL_MODES[1])])))

    def test_layout_with_twins_is_one_to_one(self):
        d = data_dir("pass2-twins")
        act({"op": "layout-save", "name": "Twins"}, fixture(displays=self.twins()), data=d)
        self.assertTrue(find(sf("layout", "", fixture(displays=self.twins()), data=d), "✓ Twins"))
        swapped = fixture(displays=self.twins(x2=4288, x3=1728))
        out = act({"op": "layout-restore", "name": "Twins"}, swapped, data=d)
        self.assertIn("CGConfigureDisplayOrigin(display=2, x=1728, y=-200)", out)
        self.assertIn("CGConfigureDisplayOrigin(display=3, x=4288, y=-200)", out)
        # one twin unplugged: the other is not counted twice
        one = fixture(displays=[mac(), dell(id=2, uuid=UUID_DELL1)])
        self.assertIn("Missing: DELL U2720Q (2)", find(sf("layout", "", one, data=d), "Twins")["subtitle"])

    def test_m1ddc_with_shared_uuid_refuses_to_guess(self):
        bins = fake_bin("m1ddc", 'case "$*" in "display list") echo "[1] DELL U2720Q (%s)"; echo "[2] DELL U2720Q (%s)";; *) echo 50;; esac\n' % (UUID_DELL1, UUID_DELL1))
        it = sf("bright", "", fixture(displays=self.twins()), bins=bins)
        self.assertIn("share a UUID", find(it, "DELL U2720Q (1): brightness not available")["subtitle"])


class AuditPass3Tests(unittest.TestCase):
    """Regressions for bugs found in the third audit."""

    def test_betterdisplay_falls_back_to_m1ddc(self):
        d = tempfile.mkdtemp(dir=TMP, prefix="bin-")
        for name, script in [("betterdisplaycli", "echo 'display not found' >&2; exit 1\n"), ("m1ddc", M1DDC)]:
            p = os.path.join(d, name)
            with open(p, "w") as f:
                f.write("#!/bin/bash\n" + script)
            os.chmod(p, 0o755)
        fx = fixture(displays=[mac(), dell()])
        row = find(sf("bright", "40", fx, bins=d), "DELL U2720Q")
        self.assertIn("via m1ddc", row["subtitle"])
        self.assertIn("m1ddc display 1 set luminance 40", act(row["arg"], fx, bins=d))

    def test_betterdisplay_without_the_display(self):
        bins = fake_bin("betterdisplaycli", "exit 1\n")
        it = sf("bright", "", fixture(displays=[mac(), dell()]), bins=bins)
        self.assertIn("BetterDisplay can't control", find(it, "DELL U2720Q: brightness not available")["subtitle"])

    def test_anc_hotkey_without_airpods_does_not_open_control_center(self):
        out = act({"op": "anc-toggle"})
        self.assertNotIn("DRY RUN", out)
        self.assertEqual(out, "Connect your AirPods first: the output is MacBook Pro Speakers")
        out = act({"op": "anc", "mode": "Transparency"}, fixture(audio=audio(output=0)))
        self.assertEqual(out, "Connect your AirPods first: the output is not set")

    def test_external_1x_modes_are_not_called_low_resolution(self):
        fx = fixture(displays=[mac(), dell()])
        self.assertEqual(sf("res", "low resolution", fx)[0]["title"], "No display mode matches “low resolution”")
        self.assertIn("3840 × 2160 · 30 Hz", titles(sf("res", "1x", fx)))


class RealHardwareTests(unittest.TestCase):
    """Read-only: list the real devices and displays; never runs an action."""

    def test_listings(self):
        for cmd, q in [("audio", ""), ("audio", "in"), ("mic", ""), ("res", ""), ("bright", ""), ("layout", ""), ("anc", "")]:
            e = dict(os.environ, alfred_workflow_data=data_dir("real"), DA_BIN_DIRS=EMPTY_BIN)
            e.pop("DA_FIXTURE", None)
            out = subprocess.run(["osascript", "-l", "JavaScript", "./displayaudio.js", cmd, q], cwd=SRC, env=e,
                                 capture_output=True, text=True, timeout=60)
            self.assertEqual(out.returncode, 0, out.stderr)
            validate(json.loads(out.stdout))


class RealHardwareDryRunTests(unittest.TestCase):
    """Real devices, DA_DRY_RUN=1. Every action here is also a no-op if the dry-run guard failed:
    it sets a value to what it already is."""

    def real(self, *args):
        e = dict(os.environ, alfred_workflow_data=data_dir("real-dry"), DA_BIN_DIRS=EMPTY_BIN, DA_DRY_RUN="1")
        e.pop("DA_FIXTURE", None)
        out = subprocess.run(["osascript", "-l", "JavaScript", "./displayaudio.js", *args], cwd=SRC, env=e,
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        return out.stdout

    def test_current_output_device(self):
        items = json.loads(self.real("audio", ""))["items"]
        cur = [i for i in items if i["title"].startswith("✓")]
        if not cur:
            self.skipTest("no current output device")
        out = self.real("act", cur[0]["arg"])
        self.assertTrue(out.startswith("DRY RUN: AudioObjectSetPropertyData(kAudioObjectSystemObject, 'dOut'"), out)

    def test_same_volume(self):
        items = json.loads(self.real("audio", "0"))["items"]
        if items[0].get("valid") is False:
            self.skipTest("output has no volume")
        import re
        cur = int(re.search(r"Currently (\d+)%", items[0]["subtitle"]).group(1))
        out = self.real("act", json.dumps({"op": "volume", "scope": "output", "value": cur}))
        self.assertTrue(out.startswith(f"DRY RUN: set volume outputVolume {cur}"), out)

    def test_same_brightness(self):
        items = json.loads(self.real("bright", "+0"))["items"]
        rows = [i for i in items if i.get("valid", True) is not False]
        if not rows:
            self.skipTest("no display with brightness control")
        out = self.real("act", rows[0]["arg"])
        self.assertIn("DRY RUN: DisplayServicesSetBrightness(display=", out)

    def test_current_resolution_is_not_reapplied(self):
        items = json.loads(self.real("res", "current"))["items"]
        cur = [i for i in items if i["title"].startswith("✓")]
        if not cur:
            self.skipTest("no current display mode")
        self.assertIn("already uses", self.real("act", cur[0]["arg"]))


class PlistTests(unittest.TestCase):
    def test_build_and_plist(self):
        subprocess.run([sys.executable, "tools/build.py"], cwd=ROOT, check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            p = plistlib.load(f)
        uids = [o["uid"] for o in p["objects"]]
        self.assertEqual(len(uids), len(set(uids)))
        for src, conns in p["connections"].items():
            self.assertIn(src, uids)
            for c in conns:
                self.assertIn(c["destinationuid"], uids)
        kws = [o["config"]["keyword"] for o in p["objects"] if o["config"].get("keyword")]
        self.assertEqual(len(kws), 6)
        for kw in kws:
            self.assertRegex(kw, r"^\{var:keyword_\w+\}$")
        self.assertTrue(p["readme"].startswith("## Usage"))
        self.assertNotIn("images/", p["readme"])
        self.assertEqual(p["bundleid"], "io.github.x-o-r-r-o.display-audio")
        out = subprocess.run(["sips", "-g", "pixelWidth", os.path.join(SRC, "icon.png")], capture_output=True, text=True).stdout
        self.assertGreaterEqual(int(out.split()[-1]), 256)

    def test_no_binaries_in_src(self):
        for base, _, files in os.walk(SRC):
            for f in files:
                with open(os.path.join(base, f), "rb") as fh:
                    head = fh.read(4)
                self.assertNotIn(head, (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xcf"), f)


if __name__ == "__main__":
    unittest.main(verbosity=1)
