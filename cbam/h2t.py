import sys, re, html, io

def to_text(path):
    with open(path, 'rb') as f:
        raw = f.read()
    txt = None
    for enc in ('utf-8', 'utf-8-sig', 'cp1252', 'latin-1'):
        try:
            txt = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if txt is None:
        txt = raw.decode('utf-8', 'replace')
    # drop script/style/head
    txt = re.sub(r'(?is)<script.*?</script>', ' ', txt)
    txt = re.sub(r'(?is)<style.*?</style>', ' ', txt)
    txt = re.sub(r'(?is)<head.*?</head>', ' ', txt)
    # block level -> newline
    txt = re.sub(r'(?i)</(p|div|tr|li|h1|h2|h3|h4|h5|h6|table|tfoot|thead|body|html)>', '\n', txt)
    txt = re.sub(r'(?i)<br\s*/?>', '\n', txt)
    txt = re.sub(r'(?i)</t[dh]>', ' | ', txt)
    txt = re.sub(r'(?i)<(p|div|tr|li|h1|h2|h3|h4|h5|h6|table)[^>]*>', '\n', txt)
    txt = re.sub(r'(?s)<[^>]+>', ' ', txt)
    txt = html.unescape(txt)
    txt = txt.replace('\u00a0', ' ').replace('\u2009', ' ').replace('\u202f', ' ')
    txt = re.sub(r'[ \t\x0b\x0c\r]+', ' ', txt)
    txt = re.sub(r' *\n *', '\n', txt)
    txt = re.sub(r'\n{3,}', '\n\n', txt)
    return txt.strip()

if __name__ == '__main__':
    t = to_text(sys.argv[1])
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        f.write(t)
    print(f"chars={len(t)} lines={t.count(chr(10))+1}")
