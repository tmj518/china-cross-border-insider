#!/usr/bin/env python
"""Identify the language of each CELLAR file version for a work UUID."""
import subprocess, sys, os, re
DIR = os.path.dirname(os.path.abspath(__file__))
BASE = "http://publications.europa.eu/resource"

def lang_of(uuid, ver, doc="DOC_1"):
    url = f"{BASE}/cellar/{uuid}.{ver}/{doc}"
    p = subprocess.run(["curl.exe", "-sS", "-L", "--max-time", "90", "-r", "0-4000", url],
                       capture_output=True)
    b = p.stdout or b""
    head = b.decode("utf-8", "replace")
    m = re.search(r'xml:lang="([a-zA-Z\-]+)"', head) or re.search(r'\blang="([a-zA-Z\-]+)"', head)
    lg = m.group(1) if m else "?"
    title = re.search(r"(?is)<title[^>]*>(.*?)</title>", head)
    return lg, (title.group(1)[:80] if title else ""), len(b)

if __name__ == "__main__":
    uuid = sys.argv[1]
    for n in range(1, 13):
        for rev in ("03", "02", "01"):
            lg, t, ln = lang_of(uuid, f"{n:04d}.{rev}")
            if ln > 500:
                print(f"{n:04d}.{rev} lang={lg} :: {t}")
