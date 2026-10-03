#!/usr/bin/env python
"""Full CELLAR resolver: CELEX -> work UUID -> RDF for THAT work -> manifestation file UUIDs."""
import subprocess, sys, os, re, time

DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, DIR)
from fetch import curl, to_text

BASE = "http://publications.europa.eu/resource"

def raw(url, accept, tries=6):
    out = os.path.join(DIR, "_tmp_probe.out")
    ok, meta, err = curl(url, out, accept=accept, tries=tries)
    if not ok:
        return None, meta
    with open(out, "r", encoding="utf-8", errors="replace") as f:
        return f.read(), meta

def walk(celex, want_txt=True, verbose=True):
    rdf, meta = raw(f"{BASE}/celex/{celex}", "application/rdf+xml")
    if rdf is None:
        print(f"FAIL celex/{celex} meta={meta}")
        return None
    idm = re.search(r'<owl:sameAs rdf:resource="[^"]*cellar/([0-9a-f\-]+)"', rdf)
    works = set(re.findall(r'cellar/([0-9a-f\-]{36})', rdf))
    if verbose:
        print(f"celex/{celex}: {len(works)} cellar ids")
    # Direct try: the id whose sameAs block mentions this celex
    direct = None
    for uuid, body in re.findall(r'<rdf:Description rdf:about="[^"]*cellar/([0-9a-f\-]+)">(.*?)</rdf:Description>', rdf, re.S):
        if f"/celex/{celex}" in body:
            direct = uuid
            break
    cands = []
    if direct:
        cands.append(direct)
    cands += [w for w in works if w != direct]
    for uuid in cands[:8]:
        # get manifestation rdf
        sub, _ = raw(f"{BASE}/cellar/{uuid}", "application/rdf+xml", tries=3)
        if not sub:
            continue
        # file uuids referenced in the SAME document
        files = sorted(set(re.findall(r'cellar/([0-9a-f\-]{36}\.\d{4}\.\d{2})', sub)))
        if not files:
            # nested: follow owl:sameAs manifestation
            for m in set(re.findall(r'cellar/([0-9a-f\-]{36})', sub)):
                if m == uuid:
                    continue
                sub2, _ = raw(f"{BASE}/cellar/{m}", "application/rdf+xml", tries=2)
                if sub2:
                    files += sorted(set(re.findall(r'cellar/([0-9a-f\-]{36}\.\d{4}\.\d{2})', sub2)))
        for fu in files:
            p = subprocess.run(["curl.exe", "-sS", "-L", "--max-time", "60", "-o", os.path.join(DIR, "_probe.bin"),
                                "-w", "%{http_code}|%{size_download}|%{content_type}",
                                f"{BASE}/cellar/{fu}/DOC_1"], capture_output=True, text=True)
            s = (p.stdout or "").strip()
            parts = s.split("|")
            if verbose:
                print(f"   {uuid[:8]} {fu[-12:]:>12} -> {s[:70]}")
            if parts[0] == "200" and "xhtml" in parts[2] and int(parts[1]) > 3000:
                out = os.path.join(DIR, f"{celex}.html")
                ok, m2, _ = curl(f"{BASE}/cellar/{fu}/DOC_1", out, accept="application/xhtml+xml")
                print(f"FULLTEXT={BASE}/cellar/{fu}/DOC_1 -> {out} size={m2[1]}")
                if want_txt:
                    t = to_text(out)
                    tp = os.path.join(DIR, f"{celex}.txt")
                    open(tp, "w", encoding="utf-8").write(t)
                    print(f"TXT={tp} chars={len(t)}")
                return out
    print("NO XHTML FOUND")
    return None

if __name__ == "__main__":
    celex = sys.argv[1]
    walk(celex, want_txt="--txt" in sys.argv)
