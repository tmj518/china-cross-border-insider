#!/usr/bin/env python
"""CBAM research fetch toolkit.

Usage:
  python fetch.py <outname> <url> [accept]
  python fetch.py --txt <outname> <url> [accept]
Fetches via curl.exe (proxy from ~/.curlrc), retries 6x, saves into this dir.
Prints: OUT=<path> CODE=<http> SIZE=<n> TYPE=<mime> FINAL=<url>
"""
import subprocess, sys, os, time, re, html

DIR = os.path.dirname(os.path.abspath(__file__))

def curl(url, outpath, accept="application/xhtml+xml", tries=6):
    last = None
    for i in range(1, tries + 1):
        cmd = ["curl.exe", "-sS", "-L", "--max-time", "100",
               "-H", f"Accept: {accept}",
               "-o", outpath, "-w", "%{http_code}|%{size_download}|%{content_type}|%{url_effective}",
               url]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=140)
            s = (p.stdout or "").strip()
            err = (p.stderr or "").strip()
        except subprocess.TimeoutExpired:
            s, err = "000|0|timeout|" + url, "timeout"
        parts = (s.split("|") + ["", "", "", ""])[:4]
        code, size = parts[0], parts[1]
        last = (code, size, parts[2], parts[3])
        try:
            sz = int(size)
        except ValueError:
            sz = 0
        if code == "200" and sz > 1500:
            return True, last, err
        print(f"  retry {i}/{tries} code={code} size={size} err={err[:80]}", flush=True)
        time.sleep(3)
    return False, last, ""

def to_text(path):
    with open(path, "rb") as f:
        raw = f.read()
    txt = None
    for enc in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            txt = raw.decode(enc); break
        except UnicodeDecodeError:
            continue
    if txt is None:
        txt = raw.decode("utf-8", "replace")
    txt = re.sub(r"(?is)<script.*?</script>", " ", txt)
    txt = re.sub(r"(?is)<style.*?</style>", " ", txt)
    txt = re.sub(r"(?is)<head.*?</head>", " ", txt)
    txt = re.sub(r"(?i)</(p|div|tr|li|h1|h2|h3|h4|h5|h6|table|tfoot|thead|body|html)>", "\n", txt)
    txt = re.sub(r"(?i)<br\s*/?>", "\n", txt)
    txt = re.sub(r"(?i)</t[dh]>", " | ", txt)
    txt = re.sub(r"(?i)<(p|div|tr|li|h1|h2|h3|h4|h5|h6|table)[^>]*>", "\n", txt)
    txt = re.sub(r"(?s)<[^>]+>", " ", txt)
    txt = html.unescape(txt)
    txt = txt.replace("\u00a0", " ").replace("\u2009", " ").replace("\u202f", " ")
    txt = re.sub(r"[ \t\x0b\x0c\r]+", " ", txt)
    txt = re.sub(r" *\n *", "\n", txt)
    txt = re.sub(r"\n{3,}", "\n\n", txt)
    return txt.strip()

def main():
    args = sys.argv[1:]
    do_txt = False
    if args and args[0] == "--txt":
        do_txt = True; args = args[1:]
    outname, url = args[0], args[1]
    accept = args[2] if len(args) > 2 else "application/xhtml+xml"
    outpath = os.path.join(DIR, outname)
    ok, meta, err = curl(url, outpath, accept)
    tag = "OK" if ok else "FAIL"
    print(f"{tag} OUT={outpath} CODE={meta[0]} SIZE={meta[1]} TYPE={meta[2]} FINAL={meta[3]}")
    if err:
        print(f"  stderr: {err[:200]}")
    if ok and do_txt:
        t = to_text(outpath)
        tpath = os.path.splitext(outpath)[0] + ".txt"
        with open(tpath, "w", encoding="utf-8") as f:
            f.write(t)
        print(f"TXT={tpath} chars={len(t)} lines={t.count(chr(10))+1}")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
