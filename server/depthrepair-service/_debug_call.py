import json
import sys
from pathlib import Path

import requests


def main():
    url = "http://127.0.0.1:7870/api/repair-depth"
    root = Path(__file__).resolve().parent / "lingbot-depth" / "examples" / "0"
    body = {
        "rgbPath": str(root / "rgb.png"),
        "depthPath": str(root / "raw_depth.png"),
        "intrinsicsPath": str(root / "intrinsics.txt"),
        "outputDepthNpyPath": str(Path(__file__).resolve().parents[1] / "uploads" / "project_1" / "depth" / "_debug_depth_fix.npy"),
        "outputDepthPngPath": str(Path(__file__).resolve().parents[1] / "uploads" / "project_1" / "depth" / "_debug_depth_fix.png"),
        "device": "cuda",
    }
    r = requests.post(url, json=body, timeout=600)
    print("status", r.status_code)
    try:
        print(json.dumps(r.json(), ensure_ascii=False)[:1000])
    except Exception:
        print(r.text[:1000])
    return 0 if r.ok else 1


if __name__ == "__main__":
    sys.exit(main())

