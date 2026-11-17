#!/usr/bin/env python3
"""
Maakt Bodycap Web geschikt voor gebruik zonder internet.

    python tools/maak_offline.py           # downloaden en omschakelen
    python tools/maak_offline.py --online  # weer omschakelen naar internet

Downloadt MediaPipe voor het web (ongeveer 30 MB) naar vendor/mediapipe en de
herkenningsmodellen van Google (ongeveer 65 MB) naar models, en zet daarna
OFFLINE = true in js/config.js.
"""

import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3"
GOOGLE = "https://storage.googleapis.com/mediapipe-models"

FILES = [
    (f"{CDN}/vision_bundle.mjs", "vendor/mediapipe/vision_bundle.mjs"),
    (f"{CDN}/wasm/vision_wasm_internal.js", "vendor/mediapipe/wasm/vision_wasm_internal.js"),
    (f"{CDN}/wasm/vision_wasm_internal.wasm", "vendor/mediapipe/wasm/vision_wasm_internal.wasm"),
    (f"{CDN}/wasm/vision_wasm_module_internal.js", "vendor/mediapipe/wasm/vision_wasm_module_internal.js"),
    (f"{CDN}/wasm/vision_wasm_module_internal.wasm", "vendor/mediapipe/wasm/vision_wasm_module_internal.wasm"),
    (f"{GOOGLE}/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task", "models/holistic_landmarker.task"),
    (f"{GOOGLE}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task", "models/pose_landmarker_lite.task"),
    (f"{GOOGLE}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task", "models/pose_landmarker_full.task"),
    (f"{GOOGLE}/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task", "models/pose_landmarker_heavy.task"),
    (f"{GOOGLE}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task", "models/hand_landmarker.task"),
]


def set_offline(value: bool):
    config = ROOT / "js" / "config.js"
    text = config.read_text(encoding="utf-8")
    new, n = re.subn(r"export const OFFLINE = (true|false);", f"export const OFFLINE = {'true' if value else 'false'};", text)
    if n != 1:
        raise SystemExit("Kon de regel 'export const OFFLINE = ...' niet vinden in js/config.js.")
    config.write_text(new, encoding="utf-8")


def main():
    if "--online" in sys.argv:
        set_offline(False)
        print("De app haalt MediaPipe en de modellen weer van internet.")
        return
    for url, rel in FILES:
        target = ROOT / rel
        if target.exists() and target.stat().st_size > 0:
            print(f"  staat er al: {rel}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        print(f"  downloaden: {rel} ...", end="", flush=True)
        tmp = target.with_name(target.name + ".download")
        try:
            urllib.request.urlretrieve(url, tmp)
            tmp.replace(target)
        except Exception as exc:
            tmp.unlink(missing_ok=True)
            raise SystemExit(f"\nDownloaden mislukt ({exc}).\nDownload het bestand zelf via:\n  {url}\nen zet het neer als {rel}.")
        print(f" {target.stat().st_size / 1e6:.1f} MB")
    set_offline(True)
    print("Klaar. De app werkt nu zonder internet (OFFLINE = true in js/config.js).")


if __name__ == "__main__":
    main()
