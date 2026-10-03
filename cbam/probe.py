#!/usr/bin/env python
"""Probe CELLAR file URIs for a given work UUID until an XHTML document is found."""
import subprocess, sys, os
DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, DIR)
from fetch import curl, to_text
BASE = "http://publications.europa.eu/resource"

def probe(uuid, celex, want_txt=True, maxn=8):
    for doc in ("DOC_1", "DOC_2", "DOC_3"):
        for n in range(maxn, 0, -1):
            for rev in ("03", "02", "01"):
                fu = f"{uuid}.{n:04d}.{rev}"
                p = subprocess.run(["curl.exe", "-sS", "-L", "--max-time", "50", "-o", os.path.join(DIR, "_probe.bin"),
                                    "-w", "%{http_code}|%{size_download}|%{content_type}",
                                    f"{BASE}/cellar/{fu}/{doc}"], capture_output=True, text=True)
                s = (p.stdout or "").strip()
                parts = s.split("|")
                if parts[0] == "200" and int(parts[1]) > 3000:
                    print(f"  {fu}/{doc} -> {s}")
                    if "xhtml" in parts[2] or "html" in parts[2]:
                        out = os.path.join(DIR, f"{celex}.html")
                        ok, m2, _ = curl(f"{BASE}/cellar/{fu}/{doc}", out, accept="application/xhtml+xml")
                        print(f"FULLTEXT={BASE}/cellar/{fu}/{doc} -> {out} size={m2[1]}")
                        if want_txt:
                            t = to_text(out)
                            tp = os.path.join(DIR, f"{celex}.txt")
                            open(tp, "w", encoding="utf-8").write(t)
                            print(f"TXT={tp} chars={len(t)}")
                        return True
                else:
                    if parts[0] not in ("404",):
                        print(f"  {fu}/{doc} -> {s}")
    print("NOT FOUND")
    return False

if __name__ == "__main__":
    probe(sys.argv[1], sys.argv[2], want_txt="--txt" in sys.argv)
