#!/usr/bin/env python3
"""Build the web asset bundle from an original Feeding Frenzy installer.

Pipeline:
  FeedingFrenzySetup.exe
    -> strip GameHouse wrapper stub (PE overlay + 4 byte tag) -> Inno Setup 5.1.7 installer
    -> innoextract                                              -> app/ tree
    -> unpack FFArchive.saf (Sprout archive)                    -> config/*.xml, resources/*
    -> merge colour JPG + '_'-prefixed alpha PNG                -> RGBA WebP/PNG
    -> MP3-in-RIFF music -> .mp3,  MS-ADPCM sfx -> 16-bit PCM .wav
    -> web/game/ (+ manifest.json holding every XML file)

Nothing produced here may be committed: it is the publisher's copyrighted data.

Usage: python3 tools/extract_assets.py FeedingFrenzySetup.exe [--out web/game]
Requires: innoextract (apt install innoextract), Pillow.
"""
import argparse
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install pillow")


# ---------------------------------------------------------------- installer --

def pe_overlay_offset(data):
    """Offset of the first byte after the last PE section (the overlay)."""
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise ValueError("not a PE file")
    nsec = struct.unpack_from("<H", data, pe + 6)[0]
    opt = struct.unpack_from("<H", data, pe + 20)[0]
    sec = pe + 24 + opt
    end = 0
    for i in range(nsec):
        raw_size, raw_ptr = struct.unpack_from("<II", data, sec + i * 40 + 16)
        end = max(end, raw_ptr + raw_size)
    return end


def unwrap_installer(path, workdir):
    """Return a path to the bare Inno Setup installer inside the wrapper."""
    data = open(path, "rb").read()
    off = pe_overlay_offset(data)
    inner = data[off:]
    # GameHouse stub: 4 byte tag followed by the real installer executable.
    for skip in (0, 4):
        if inner[skip:skip + 2] == b"MZ":
            out = os.path.join(workdir, "inno.exe")
            open(out, "wb").write(inner[skip:])
            return out
    return path  # already a plain Inno installer


def run_innoextract(installer, dest):
    if not shutil.which("innoextract"):
        sys.exit("innoextract not found (apt install innoextract / brew install innoextract)")
    subprocess.run(["innoextract", "-q", "-e", "-d", dest, installer], check=True, stdout=subprocess.DEVNULL)
    app = os.path.join(dest, "app")
    if not os.path.isfile(os.path.join(app, "FFArchive.saf")):
        sys.exit("FFArchive.saf not found - unexpected installer contents")
    return app


# ------------------------------------------------------------------ archive --

def read_saf(path):
    """Sprout archive: 'FFAS', u32 version, u32 dirOffset; data; directory.

    Directory: u32 ?, 16 byte digest, u32 count, then per entry
      u32 offset, u32 size, 16 byte digest, u16 nameLen (incl. NUL), name.
    """
    d = open(path, "rb").read()
    magic, _ver, diroff = struct.unpack_from("<4sII", d, 0)
    if magic != b"FFAS":
        raise ValueError("not a Sprout archive")
    p = diroff + 4 + 16
    count = struct.unpack_from("<I", d, p)[0]
    p += 4
    for _ in range(count):
        off, size = struct.unpack_from("<II", d, p)
        p += 8 + 16
        nlen = struct.unpack_from("<H", d, p)[0]
        p += 2
        name = d[p:p + nlen - 1].decode("latin1").replace("\\", "/").lower()
        p += nlen
        yield name, d[off:off + size]


# -------------------------------------------------------------------- audio --

ADPCM_ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230]


def riff_chunks(data):
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("not RIFF/WAVE")
    p = 12
    while p + 8 <= len(data):
        cid, size = struct.unpack_from("<4sI", data, p)
        yield cid, data[p + 8:p + 8 + size]
        p += 8 + size + (size & 1)


def decode_ms_adpcm(fmt, raw):
    channels, rate = struct.unpack_from("<HI", fmt, 2)
    block_align = struct.unpack_from("<H", fmt, 12)[0]
    ncoef = struct.unpack_from("<H", fmt, 20)[0]
    coefs = [struct.unpack_from("<hh", fmt, 22 + 4 * i) for i in range(ncoef)]
    out = bytearray()
    for b in range(0, len(raw), block_align):
        blk = raw[b:b + block_align]
        if len(blk) < 7 * channels:
            break
        st = []
        p = 0
        pred = list(blk[p:p + channels]); p += channels
        delta = [struct.unpack_from("<h", blk, p + 2 * c)[0] for c in range(channels)]; p += 2 * channels
        s1 = [struct.unpack_from("<h", blk, p + 2 * c)[0] for c in range(channels)]; p += 2 * channels
        s2 = [struct.unpack_from("<h", blk, p + 2 * c)[0] for c in range(channels)]; p += 2 * channels
        for c in range(channels):
            st.append([coefs[min(pred[c], ncoef - 1)], delta[c], s1[c], s2[c]])
        for c in range(channels):
            out += struct.pack("<h", st[c][3])
        for c in range(channels):
            out += struct.pack("<h", st[c][2])
        ch = 0
        for byte in blk[p:]:
            for nib in (byte >> 4, byte & 15):
                s = st[ch]
                (c1, c2), dl, a1, a2 = s
                signed = nib - 16 if nib & 8 else nib
                pv = ((a1 * c1) + (a2 * c2)) // 256 + signed * dl
                pv = max(-32768, min(32767, pv))
                s[3] = a1
                s[2] = pv
                s[1] = max(16, (ADPCM_ADAPT[nib] * dl) // 256)
                out += struct.pack("<h", pv)
                ch = (ch + 1) % channels
    return channels, rate, bytes(out)


IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
            73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408,
            449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
            2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
            9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767]
IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8]


def decode_ima_adpcm(fmt, raw):
    channels, rate = struct.unpack_from("<HI", fmt, 2)
    block_align = struct.unpack_from("<H", fmt, 12)[0]
    out = bytearray()
    for b in range(0, len(raw), block_align):
        blk = raw[b:b + block_align]
        if len(blk) < 4 * channels:
            break
        st = []
        for c in range(channels):
            pv, idx = struct.unpack_from("<hB", blk, 4 * c)
            st.append([pv, min(idx, 88)])
            out += struct.pack("<h", pv)
        body = blk[4 * channels:]
        # interleaved in 4 byte (8 sample) groups per channel
        samples = [[] for _ in range(channels)]
        for g in range(0, len(body), 4 * channels):
            for c in range(channels):
                for byte in body[g + 4 * c:g + 4 * c + 4]:
                    for nib in (byte & 15, byte >> 4):
                        pv, idx = st[c]
                        step = IMA_STEP[idx]
                        diff = step >> 3
                        if nib & 1: diff += step >> 2
                        if nib & 2: diff += step >> 1
                        if nib & 4: diff += step
                        pv = pv - diff if nib & 8 else pv + diff
                        pv = max(-32768, min(32767, pv))
                        idx = max(0, min(88, idx + IMA_INDEX[nib & 7]))
                        st[c] = [pv, idx]
                        samples[c].append(pv)
        if channels == 1:
            out += struct.pack("<%dh" % len(samples[0]), *samples[0])
        else:
            for frame in zip(*samples):
                out += struct.pack("<%dh" % channels, *frame)
    return channels, rate, bytes(out)


def pcm_wav(channels, rate, pcm):
    hdr = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(pcm), b"WAVE", b"fmt ", 16, 1,
                      channels, rate, rate * channels * 2, channels * 2, 16, b"data", len(pcm))
    return hdr + pcm


def convert_audio(data):
    """Return (extension, bytes) playable by every browser."""
    chunks = dict(riff_chunks(data))
    fmt, raw = chunks[b"fmt "], chunks[b"data"]
    tag = struct.unpack_from("<H", fmt, 0)[0]
    if tag == 0x55:  # MPEG layer 3 in a RIFF wrapper
        return ".mp3", raw
    if tag == 0x02:
        return ".wav", pcm_wav(*decode_ms_adpcm(fmt, raw))
    if tag == 0x11:
        return ".wav", pcm_wav(*decode_ima_adpcm(fmt, raw))
    if tag == 0x01:
        return ".wav", data
    raise ValueError("unsupported wav format tag %#x" % tag)


# ------------------------------------------------------------------- images --

def save_image(img, dest_noext, has_alpha):
    if has_alpha:
        img.save(dest_noext + ".webp", "WEBP", quality=92, method=4)
        return ".webp"
    img.convert("RGB").save(dest_noext + ".jpg", "JPEG", quality=90)
    return ".jpg"


def build(setup, out):
    files = {}
    with tempfile.TemporaryDirectory() as tmp:
        app = run_innoextract(unwrap_installer(setup, tmp), os.path.join(tmp, "x"))
        for name, data in read_saf(os.path.join(app, "FFArchive.saf")):
            files[name] = data
        loose = os.path.join(app, "resources")
        for root, _dirs, names in os.walk(loose):
            for n in names:
                rel = os.path.relpath(os.path.join(root, n), app).replace(os.sep, "/").lower()
                files.setdefault(rel, open(os.path.join(root, n), "rb").read())

    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)
    manifest = {"xml": {}, "images": {}, "sounds": {}}

    def dest(rel):
        p = os.path.join(out, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p

    for name in sorted(files):
        data = files[name]
        base, ext = os.path.splitext(name)
        if ext == ".xml":
            manifest["xml"][name] = data.decode("latin1")
        elif ext == ".wav":
            e, blob = convert_audio(data)
            open(dest(base + e), "wb").write(blob)
            manifest["sounds"][name] = base + e
        elif ext in (".jpg", ".png"):
            d, f = os.path.split(base)
            if f.startswith("_") and (os.path.join(d, f[1:]) + ".jpg") in files:
                continue  # alpha plane, merged below
            img = Image.open(io.BytesIO(data))
            alpha_name = os.path.join(d, "_" + f) + ".png"
            alpha = img.mode in ("RGBA", "LA") or "transparency" in img.info
            if ext == ".jpg" and alpha_name in files:
                mask = Image.open(io.BytesIO(files[alpha_name]))
                if mask.mode in ("RGBA", "LA") and mask.getchannel("A").getextrema()[0] < 255:
                    a = mask.getchannel("A")  # mask stored in the alpha channel
                else:
                    a = mask.convert("L")  # usual case: grey-scale mask
                img = img.convert("RGB")
                if a.size != img.size:
                    a = a.resize(img.size)
                img.putalpha(a)
                alpha = True
            elif alpha:
                img = img.convert("RGBA")
            e = save_image(img, dest(base), alpha)
            manifest["images"][name] = [base + e, img.size[0], img.size[1]]
    with open(os.path.join(out, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, separators=(",", ":"))
    print("wrote %d xml, %d images, %d sounds to %s" % (
        len(manifest["xml"]), len(manifest["images"]), len(manifest["sounds"]), out))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("setup", help="FeedingFrenzySetup.exe")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "web", "game"))
    a = ap.parse_args()
    build(a.setup, os.path.abspath(a.out))
