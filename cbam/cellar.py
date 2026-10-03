#!/usr/bin/env python
"""Resolve a CELEX number through CELLAR to a readable full-text file.

Usage: python cellar.py <CELEX> [--txt]
e.g.   python cellar.py 32025R2083 --txt

Strategy:
 1. GET http://publications.europa.eu/resource/celex/<CELEX>  -> RDF metadata (Accept rdf+xml)
 2. Find the OJ identifier (oj/JOL_... or L_...) for the same work
 3. Enumerate candidate CELLAR file URIs <workuuid>.<NNNN.NN>/DOC_1 and pick the XHTML one
"""
import subprocess, sys, os, time, re

DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, DIR)
from fetch import curl, to_text

BASE = "http://publications.europa.eu/resource"

def rdf(celex):
    out = os.path.join(DIR, f"rdf_{celex}.xml")
    ok, meta, err = curl(f"{BASE}/celex/{celex}", out, accept="application/rdf+xml", tries=6)
    if not ok:
        return None
    with open(out, "r", encoding="utf-8", errors="replace") as f:
        return f.read()

def main():
    celex = sys.argv[1]
    want_txt = "--txt" in sys.argv
    txt = rdf(celex)
    if txt is None:
        print(f"FAIL: could not fetch RDF for {celex}")
        return 1
    # work uuid = the cellar id whose block contains sameAs celex/<celex>
    works = re.findall(r'<rdf:Description rdf:about="[^"]*cellar/([0-9a-f\-]+)">(.*?)</rdf:Description>', txt, re.S)
    target = None
    ojs = []
    for uuid, body in works:
        if f"/celex/{celex}" in body:
            target = uuid
            ojs += re.findall(r'/oj/([A-Za-z0-9_]+)"', body)
    if target is None:
        # fall back: any block mentioning the celex
        m = re.search(r'cellar/([0-9a-f\-]+)">(?:(?!</rdf:Description>).)*?' + re.escape(celex), txt, re.S)
        target = m.group(1) if m else None
    print(f"WORK={target} OJ={sorted(set(ojs))}")
    if not target:
        return 1
    # try candidate file names
    cands = []
    for n in ("0006.03", "0006.02", "0006.01", "0005.03", "0005.02", "0005.01",
              "0004.03", "0004.02", "0004.01", "0003.03", "0003.02", "0003.01",
              "0002.03", "0002.02", "0002.01", "0001.03", "0001.02", "0001.01"):
        cands.append(f"{BASE}/cellar/{target}.{n}/DOC_1")
    found = None
    for c in cands:
        p = subprocess.run(["curl.exe", "-sS", "-L", "--max-time", "45", "-o", os.path.join(DIR, "_probe.bin"),
                            "-w", "%{http_code}|%{size_download}|%{content_type}", c],
                           capture_output=True, text=True)
        s = (p.stdout or "").strip()
        parts = s.split("|")
        print(f"  {c.rsplit('/',2)[-2]:>10} -> {s}")
        if parts[0] == "200" and "xhtml" in parts[2]:
            found = c
            break
    if found:
        out = os.path.join(DIR, f"{celex}.html")
        ok, meta, err = curl(found, out, accept="application/xhtml+xml")
        print(f"FULLTEXT {found} -> {out} size={meta[1]}")
        if want_txt:
            t = to_text(out)
            tp = os.path.join(DIR, f"{celex}.txt")
            open(tp, "w", encoding="utf-8").write(t)
            print(f"TXT={tp} chars={len(t)}")
    else:
        print("NO XHTML FILE FOUND")
    return 0

if __name__ == "__main__":
    sys.exit(main())
