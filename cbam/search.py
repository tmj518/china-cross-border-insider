#!/usr/bin/env python
"""EUR-Lex search (returns JSON). Retries hard through the flaky proxy."""
import subprocess, sys, time, json, os

def get(url, tries=6, accept="application/json"):
    for i in range(1, tries + 1):
        p = subprocess.run(["curl.exe", "-sS", "-L", "--max-time", "70",
                            "-H", "Accept: " + accept,
                            "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                            url], capture_output=True, text=True)
        out = (p.stdout or "")
        if len(out) > 200 and not out.startswith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<error"):
            return out
        print(f"  retry {i} len={len(out)} err={(p.stderr or '')[:80]}", flush=True)
        time.sleep(3)
    return None

if __name__ == "__main__":
    url = sys.argv[1]
    out = get(url)
    if out is None:
        print("FAILED")
        sys.exit(1)
    sys.stdout.reconfigure(encoding="utf-8")
    print(out[:20000])
