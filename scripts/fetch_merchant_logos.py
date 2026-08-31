#!/usr/bin/env python3
"""Pull a logo for every brand this book actually pays, and wire it up.

The ledger names its payees the way a bank statement does — "BOX8 - Desi
Meals", "Box8 @ Swiggy", "CaliB" — so a brand is a domain plus every spelling
of it that has turned up. The domain gets the picture; the spellings get it
found.

Needs Pillow, which Homebrew's Python will not install into itself, so it
lives in a venv. Once:

    python3 -m venv .venv && .venv/bin/pip install Pillow

Then, from the repo root:

    .venv/bin/python scripts/fetch_merchant_logos.py           # only what is missing
    .venv/bin/python scripts/fetch_merchant_logos.py --force   # fetch everything again

It writes PNGs to public/merchants/ and regenerates
src/lib/merchant-logos.ts, which is the file the app reads. Nothing here
runs at app time: the logos ship with the build, so the ledger draws them
offline and no row waits on a network round trip.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "merchants"
TS_FILE = ROOT / "src" / "lib" / "merchant-logos.ts"

# All three are asked, and the biggest picture wins rather than the first
# to answer. They disagree wildly about the same brand — Instamart is 32px
# at one and 192px at the next — and taking whichever replied first is how
# you end up shipping a blurry logo upscaled from a thumbnail.
SOURCES = [
    "https://www.google.com/s2/favicons?domain={domain}&sz=256",
    "https://icons.duckduckgo.com/ip3/{domain}.ico",
    "https://icon.horse/icon/{domain}",
]

# What the first two hand back when they have never heard of the domain: a
# grey globe, byte-identical every time, so one hash rejects the lot.
PLACEHOLDERS = {
    "59bfe9bc385ad69f50793ce4a53397316d7a875a7148a63c16df9b674c6cda64",
    "e5db88ea2322863ca17817b99d60006c625a31cff0dad49cf05d3c6d16a75c17",
}

# The third has no fixed placeholder: it draws the domain's first letter on a
# grey square, so every miss looks different. Asking it for a domain that
# starts with the same letter and cannot exist gets that same square back,
# which is how a miss is recognised. Answers are cached per letter.
LETTER_MISS = "{letter}zzqqxx-not-a-real-domain.example"
_letter_misses: dict[str, str | None] = {}

# The biggest a logo is ever drawn is a 36px avatar, so 128 is already twice
# what a retina screen asks for. Some of these arrive at 1754px.
MAX_PX = 128

# Brands whose own domain only serves a 16px favicon, and where the picture
# has to be taken from somewhere else on their site. `svg` crops the file
# down to the mark before it is drawn — a bank's logo file is usually the
# whole wordmark, and only its left-hand square belongs in a 36px avatar.
OVERRIDES: dict[str, dict[str, str]] = {
    # HDFC publish one 16x16 favicon and nothing else. Their page's og:image
    # is the full "HDFC BANK" lockup as vector; this is the chequered square
    # at the left of it, which is the half anybody recognises.
    "hdfc": {
        "url": "https://www.hdfc.bank.in/content/dam/hdfcbankpws/home-page/hdfc-bank-logo.svg",
        "svg_view": "2 2 29.3 31.2",
    },
    # Blinkit's own favicon is a hard-edged square. This one arrives as the
    # plate itself — a yellow roundel on transparency — so it bleeds rather
    # than being inset, and the tile's own squircle does the rounding.
    "blinkit": {
        "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/2/2a/"
               "Blinkit-yellow-rounded.svg/1280px-Blinkit-yellow-rounded.svg.png",
        "bleed": "yes",
    },
    # The three below are all the brand's mark knocked out of its own dark
    # plate. The favicons are not: Apple's is a hairline grey ring with a
    # small apple adrift in it, AlphaSense's runs its blue rule off the
    # bottom edge, Netflix's is a bare N. Taking the plate versions puts
    # them in the same family as the other plated brands.
    "alphasense": {
        "url": "https://research.com/resized/uploads/alphasense_8c9547ce18.webp"
               "?format=thumbnail",
    },
    "apple": {
        "url": "https://substackcdn.com/image/fetch/$s_!G1lk!,f_auto,q_auto:good,"
               "fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com"
               "%2Fpublic%2Fimages%2F8ed3d547-94ff-48e1-9f20-8c14a7030a02_2000x2000.jpeg",
    },
    "netflix": {
        "url": "https://images.ctfassets.net/4cd45et68cgf/Rx83JoRDMkYNlMC9MKzcB/"
               "2b14d5a59fc3937afd3f03191e19502d/Netflix-Symbol.png?w=700&h=456",
    },
}

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)

MAGIC = [
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF8", ".gif"),
    (b"\x00\x00\x01\x00", ".ico"),
]

# Brands deliberately left out: every logo directory returns something for
# them, and every one of those is wrong — a parked page's WordPress mark for
# AMB Cinemas, a cropped banner for Lulu. A payee with no logo keeps its
# category glyph, which says less but never says something untrue.
#
# slug -> (domain, [every spelling of it that appears in the book])
#
# The canonical name is implied by the slug and always matches; the list is
# for the rest — abbreviations, misspellings, the delivery app's suffix, the
# branch tacked on the end.
BRANDS: dict[str, tuple[str, list[str]]] = {
    # ------------------------------------------------------------ food
    # Instamart rides on Swiggy's mark: it is the same app to the person
    # paying, and its own logo reads as a separate brand in the row.
    "swiggy": ("swiggy.com", ["Swiggy", "Instamart", "Swiggy Instamart"]),
    "zomato": ("zomato.com", ["Zomato"]),
    "blinkit": ("blinkit.com", ["Blinkit"]),
    "box8": ("box8.in", ["Box 8", "Box8", "BOX8", "BOX8 - Desi Meals", "Box8 @ Swiggy"]),
    "starbucks": ("starbucks.com", ["Starbucks", "Starbucks Coffee"]),
    "california-burrito": (
        "californiaburrito.in",
        ["California Burrito", "CaliB", "Cali B", "CaliB @ Swiggy"],
    ),
    "taco-bell": ("tacobell.com", ["Taco Bell"]),
    "subway": ("subway.com", ["Subway"]),
    "mcdonalds": ("mcdonalds.com", ["McDonald's", "McDonalds"]),
    "chowman": ("chowman.in", ["Chowman", "Chowman Madhapur"]),
    "behrouz": ("behrouzbiryani.com", ["Behrouz", "Behrouz Biryani"]),
    "burma-burma": ("burmaburma.in", ["Burma Burma"]),
    "punjab-grill": ("punjabgrill.in", ["Punjab Grill"]),
    "pista-house": ("pistahouse.in", ["Pista House", "PistaHouse"]),
    "almond-house": ("almondhouse.in", ["Almond House"]),
    "thalappakatti": ("thalappakatti.com", ["Dindigul Thalappakatti", "Thalappakatti"]),
    "samosa-party": ("samosaparty.com", ["Samosa Party"]),
    "frozen-bottle": ("frozenbottle.com", ["Frozen Bottle"]),
    "natural-ice-cream": ("naturalicecreams.in", ["Natural Ice Cream", "NIC", "Naturals Ice Cream"]),
    "chaayos": ("chaayos.com", ["Chaayos", "Chaayos Chai+Snacks=Relax"]),
    "chai-point": ("chaipoint.com", ["Chai Point"]),
    "blue-tokai": ("bluetokaicoffee.com", ["Blue Tokai"]),
    "tim-hortons": ("timhortons.in", ["Tim Hortons", "Tim Horton's"]),
    "costa-coffee": ("costacoffee.com", ["Costa", "Costa Coffee"]),
    "toscano": ("toscano.co.in", ["Toscano"]),
    "good-flippin-burgers": ("goodflippin.com", ["Good Flippin' Burgers", "Good Flippin Burgers"]),
    "a2b": ("aabsweets.com", ["A2B", "Adyar Ananda Bhavan"]),
    # -------------------------------------------------------- getting about
    "rapido": ("rapido.bike", ["Rapido"]),
    "uber": ("uber.com", ["Uber"]),
    "irctc": ("irctctourism.com", ["IRCTC"]),
    "redbus": ("redbus.in", ["RedBus", "Redbus"]),
    "makemytrip": ("makemytrip.com", ["MakeMyTrip", "Make My Trip"]),
    "goibibo": ("goibibo.com", ["Goibibo"]),
    "indigo": ("goindigo.in", ["Indigo", "IndiGo"]),
    "porter": ("porter.in", ["Porter"]),
    "dmrc": ("delhimetrorail.com", ["DMRC"]),
    "indian-oil": ("iocl.com", ["IndianOil", "Indian Oil"]),
    "bharat-gas": ("ebharatgas.com", ["BharatGas", "Bharat Gas"]),
    "supergas": ("supergas.com", ["SuperGaS", "SuperGas"]),
    "triumph": ("triumphmotorcycles.in", ["Triumph Service Centre", "Triumph Service Center", "Triumph"]),
    # ----------------------------------------------------------- shopping
    "amazon": ("amazon.in", ["Amazon", "Amazon Pay"]),
    "myntra": ("myntra.com", ["Myntra", "Mynta"]),
    "ikea": ("ikea.com", ["IKEA"]),
    "croma": ("croma.com", ["Croma"]),
    "reliance-digital": ("reliancedigital.in", ["Reliance Digital"]),
    "hm": ("hm.com", ["H&M"]),
    "levis": ("levi.in", ["Levis", "Levis Indiranagar", "Levi's"]),
    "samsonite": ("samsonite.in", ["Samsonite"]),
    "joyalukkas": ("joyalukkas.in", ["Joyalukkas", "Joyalukkas India Lim"]),
    "crossword": ("crossword.in", ["Crossword", "Crosswords"]),
    # -------------------------------------------------------------- tech
    "apple": ("apple.com", ["Apple", "App Store"]),
    "google": ("google.com", ["Google"]),
    "samsung": ("samsung.com", ["Samsung"]),
    "lg": ("lg.com", ["LG"]),
    "hp": ("hp.com", ["HP"]),
    "adobe": ("adobe.com", ["Adobe"]),
    "cursor": ("cursor.com", ["Cursor", "Me → Raj : Cursor"]),
    "claude": ("claude.ai", ["Claude", "Claude Subscription"]),
    "netflix": ("netflix.com", ["Netflix"]),
    "spotify": ("spotify.com", ["Spotify"]),
    "playstation": ("playstation.com", ["PlayStation", "PS Store"]),
    "fancode": ("fancode.com", ["Fancode", "FanCode"]),
    "formula1": ("formula1.com", ["F1", "F1TV"]),
    "jio": ("jio.com", ["Jio"]),
    "airtel": ("airtel.in", ["Airtel"]),
    "act": ("actcorp.in", ["ACT", "Act", "Act Fibernet", "Sameen's Share ACT"]),
    # --------------------------------------------------------- going out
    "bookmyshow": ("bookmyshow.com", ["BookMyShow", "Bookmyshow", "Book My Show"]),
    "pvr": ("pvrcinemas.com", ["PVR"]),
    "inox": ("inoxmovies.com", ["INOX", "Inox"]),
    "cinepolis": ("cinepolisindia.com", ["Cinepolis", "Cinépolis"]),
    "district": ("district.in", ["District"]),
    "game-nation": ("gamenation.in", ["Game Nation", "Gamenation"]),
    # -------------------------------------------------- money & services
    "hdfc": ("hdfcbank.com", ["HDFC", "HDFC Bank"]),
    "icici": ("icicibank.com", ["ICICI", "ICICI Bank"]),
    "federal-bank": ("federalbank.co.in", ["Federal Bank", "Federal Bank RD"]),
    "indian-bank": ("indianbank.in", ["Indian Bank"]),
    "cleartax": ("cleartax.in", ["ClearTax"]),
    "urban-company": ("urbancompany.com", ["Urban Company", "UrbanClap"]),
    "toni-and-guy": ("toniandguy.com", ["Toni&Guy", "Toni & Guy"]),
    "apollo": ("apollopharmacy.in", ["Apollo", "Apollo Pharmacy", "Apollo 24/7"]),
    "medplus": ("medplusmart.com", ["MedPlus"]),
    "naturals-salon": ("naturals.in", ["Naturals"]),
    # ----------------------------------------------------- funds & work
    "nippon-india": ("mf.nipponindiaim.com", ["Nippon India Small Cap", "Nippon India Large Cap", "Nippon India"]),
    "quant-mutual": ("quantmutual.com", ["Quant Small Cap", "Quant Mid Cap", "Quant Mutual"]),
    "sbi-mutual": ("sbimf.com", ["SBI Gold Direct Plan", "SBI Mutual Fund"]),
    "alphasense": ("alpha-sense.com", ["AlphaSense", "Alphasense"]),
    "freshworks": ("freshworks.com", ["Freshworks"]),
    "nonceblox": ("nonceblox.com", ["Nonceblox"]),
    "visual-bi": ("visualbi.com", ["Visual BI"]),
    "drivea": ("drivea.co.uk", ["Drivea"]),
}


def normalise(name: str) -> str:
    """The key a merchant is looked up by: letters and digits, nothing else.

    "Toni&Guy", "Toni & Guy" and "toni and guy" are one payee, and an
    apostrophe that arrived curly from one importer and straight from
    another must not split a merchant in two.
    """
    text = unicodedata.normalize("NFKD", name)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def extension_of(data: bytes) -> str | None:
    """The kind of picture this is, by its first bytes. WEBP hides behind a
    RIFF header, so it is checked apart from the rest."""
    for magic, ext in MAGIC:
        if data.startswith(magic):
            return ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


def get(url: str) -> bytes | None:
    request = urllib.request.Request(url, headers={"User-Agent": "midas-logo-fetch/1"})
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return response.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def letter_miss(domain: str) -> str | None:
    """What the letter-avatar service draws for a domain starting the way
    this one does — the thing a real logo must not be equal to."""
    letter = next((ch for ch in domain.lower() if ch.isalpha()), "x")
    if letter not in _letter_misses:
        data = get(SOURCES[2].format(domain=LETTER_MISS.format(letter=letter)))
        _letter_misses[letter] = hashlib.sha256(data).hexdigest() if data else None
    return _letter_misses[letter]


def dimensions(data: bytes, ext: str) -> tuple[int, int]:
    """How big the picture is, read from its header. Used only to rank two
    candidates against each other, so a format we can't read scores zero and
    simply loses to one we can."""
    try:
        if ext == ".png":
            w, h = struct.unpack(">II", data[16:24])
            return w, h
        if ext == ".gif":
            w, h = struct.unpack("<HH", data[6:10])
            return w, h
        if ext == ".ico":
            best = (0, 0)
            for i in range(struct.unpack("<H", data[4:6])[0]):
                entry = data[6 + i * 16 : 22 + i * 16]
                size = (entry[0] or 256, entry[1] or 256)
                if size[0] * size[1] > best[0] * best[1]:
                    best = size
            return best
        if ext == ".webp":
            return struct.unpack("<HH", data[26:30])
        if ext == ".jpg":
            i = 2
            while i < len(data) - 9:
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                # The SOF markers carry the size; DHT/DAC/RST/SOS do not.
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                    return w, h
                i += 2 + struct.unpack(">H", data[i + 2 : i + 4])[0]
    except (struct.error, IndexError):
        pass
    return 0, 0


def extension_of(data: bytes) -> str | None:
    """The kind of picture this is, by its first bytes. WEBP hides behind a
    RIFF header, so it is checked apart from the rest."""
    for magic, ext in MAGIC:
        if data.startswith(magic):
            return ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data.lstrip()[:5] in (b"<svg ", b"<?xml"):
        return ".svg"
    return None


def get(url: str) -> bytes | None:
    request = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return response.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def letter_miss(domain: str) -> str | None:
    """What the letter-avatar service draws for a domain starting the way
    this one does — the thing a real logo must not be equal to."""
    letter = next((ch for ch in domain.lower() if ch.isalpha()), "x")
    if letter not in _letter_misses:
        data = get(SOURCES[2].format(domain=LETTER_MISS.format(letter=letter)))
        _letter_misses[letter] = hashlib.sha256(data).hexdigest() if data else None
    return _letter_misses[letter]


def rasterise(svg: bytes, view: str | None) -> bytes | None:
    """Draw an SVG at a size worth keeping, optionally cropping it to a part
    of itself first. Quick Look does the drawing, which is the one SVG
    renderer every Mac already has."""
    import shutil
    import subprocess
    import tempfile

    if not shutil.which("qlmanage"):
        return None
    text = svg.decode("utf-8", "replace")
    if view:
        text = re.sub(r'viewBox="[^"]*"', f'viewBox="{view}"', text, count=1)
        text = re.sub(r'width="[^"]*"\s+height="[^"]*"', 'width="512" height="512"', text, count=1)
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "logo.svg"
        source.write_text(text)
        subprocess.run(
            ["qlmanage", "-t", "-s", "512", "-o", tmp, str(source)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        drawn = next(iter(Path(tmp).glob("*.png")), None)
        return drawn.read_bytes() if drawn else None


def fetch(slug: str, domain: str) -> tuple[bytes, str] | None:
    """The best picture anyone has for this brand, and its extension.

    Every source is asked and the largest answer wins, because they disagree
    by a factor of six about the same logo and the smallest of them gets
    upscaled into a blur. A brand with an override skips the directories
    entirely — they only had junk for it, which is why it has one.
    """
    override = OVERRIDES.get(slug)
    if override:
        data = get(override["url"])
        if data and extension_of(data) == ".svg":
            data = rasterise(data, override.get("svg_view"))
        if data:
            ext = extension_of(data)
            if ext and ext != ".svg":
                return data, ext
        print("(override failed, falling back) ", end="")

    best: tuple[int, bytes, str] | None = None
    for i, template in enumerate(SOURCES):
        data = get(template.format(domain=urllib.parse.quote(domain)))
        if not data:
            continue
        ext = extension_of(data)
        if ext is None or ext == ".svg":
            continue
        digest = hashlib.sha256(data).hexdigest()
        if digest in PLACEHOLDERS:
            continue
        if i == 2 and digest == letter_miss(domain):
            continue
        w, h = dimensions(data, ext)
        if best is None or w * h > best[0]:
            best = (w * h, data, ext)
    return (best[1], best[2]) if best else None


# How much of its square the mark itself is given. One number for every
# brand, which is the entire point of it: a roundel, a wordmark and a mark
# on a coloured plate that each filled a different fraction of their file
# is what made a column of them look like it had been assembled by three
# different people. 0.84 clears the squircle's corners on the diagonal
# while still leaving a circle looking like it fills the tile.
MARK = 0.84


def field(image) -> tuple[int, int, int, int] | None:
    """The colour of the field the mark is sitting on, or None if it has none.

    Read from the whole border rather than the four corners. A wordmark with
    a rule running off the bottom edge — AlphaSense — puts two different
    colours in the corners and would fail a corner test, but white still
    holds three quarters of the rim, and white is the answer we want. The
    field is what the mark gets re-centred on, so a brand that came on its
    own coloured plate keeps that plate.
    """
    w, h = image.size
    px = image.load()
    rim = [px[x, y] for x in range(w) for y in (0, h - 1)]
    rim += [px[x, y] for y in range(h) for x in (0, w - 1)]

    # Bucketed so anti-aliasing and JPEG mush don't split one field into
    # fifty near-identical colours, then averaged back to an exact value.
    buckets: dict[tuple, list] = {}
    for p in rim:
        key = "clear" if p[3] < 24 else (p[0] // 12, p[1] // 12, p[2] // 12)
        buckets.setdefault(key, []).append(p)
    key, members = max(buckets.items(), key=lambda kv: len(kv[1]))
    if len(members) < len(rim) * 0.55:
        return None  # no field: the mark runs to every edge
    if key == "clear":
        return (0, 0, 0, 0)
    n = len(members)
    return tuple(sum(c[i] for c in members) // n for i in range(4))  # type: ignore[return-value]


def trim(path: Path) -> None:
    """Sit the mark in the middle of its own field at a fixed size.

    A favicon is drawn for a browser tab, so it arrives however its designer
    felt: a roundel adrift in white, a wordmark bled to all four edges, a
    logo on its brand's coloured plate. Shipped as they come, those three
    read as three unrelated kinds of object down the ledger's left edge —
    one rattling around inside the tile, one with its ends bitten off by the
    squircle, one filling the tile as a hard-cornered block.

    So each is cut back to the mark itself, then re-centred on a square of
    its own field colour with the mark held to `MARK` of the side. White
    fields stay white and vanish against the chip; a brand's plate stays its
    plate and fills the tile; nothing reaches the corners to be clipped.

    Needs Pillow — `main` refuses to run without it, because a silent skip
    here ships 89 logos that all look subtly wrong and says nothing.
    """
    from PIL import Image, ImageChops

    image = Image.open(path).convert("RGBA")
    back = field(image)

    if back is None:
        # Nothing to cut back to, so the whole picture is the mark. It still
        # gets the inset, which is what stops it being clipped.
        mark, pad = image, (0, 0, 0, 0)
    else:
        if back[3] < 24:
            hit = image.getchannel("A").point(lambda v: 255 if v > 24 else 0)
        else:
            plate = Image.new("RGBA", image.size, back)
            hit = ImageChops.difference(
                image.convert("RGB"), plate.convert("RGB")
            ).convert("L").point(lambda v: 255 if v > 24 else 0)
        box = hit.getbbox()
        if box is None:
            return  # a picture of nothing but its own field
        mark, pad = image.crop(box), back

    # A logo that arrives as its own plate is already the shape the tile
    # wants to be. Inset it and you get a rounded square floating inside a
    # squircle with a gutter between the two; let it bleed and the tile's
    # own corners do the rounding, which is how every other plated brand
    # in the directory reads.
    fill = 1.0 if OVERRIDES.get(path.stem, {}).get("bleed") else MARK
    side = round(max(mark.size) / fill)
    square = Image.new("RGBA", (side, side), pad)
    square.paste(mark, ((side - mark.width) // 2, (side - mark.height) // 2), mark)
    square.save(path)


def tidy(path: Path) -> Path:
    """Bring an oversized logo down to avatar size, trim its padding, and put
    it in the one format everything else is in — a 69KB Windows icon of a bank
    is a strange thing to ship in a Mac app, and a JPEG has no transparency to
    trim back.

    `sips` comes with macOS; anywhere it doesn't, the file is left exactly as
    it arrived and the browser deals with it."""
    import shutil
    import subprocess

    def sips(*args: str) -> bool:
        return subprocess.run(
            ["sips", *args],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode == 0

    if not shutil.which("sips"):
        return path
    if path.suffix != ".png":
        png = path.with_suffix(".png")
        if sips("-s", "format", "png", str(path), "--out", str(png)):
            path.unlink()
            path = png
    sips("--resampleHeightWidthMax", str(MAX_PX), str(path))
    if path.suffix == ".png":
        trim(path)
        sips("--resampleHeightWidthMax", str(MAX_PX), str(path))
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-fetch logos already on disk")
    args = parser.parse_args()

    # Checked here rather than shrugged off in `trim`, which is how every
    # logo in this directory came to keep the padding it was born with while
    # the script reported a tidy ✓ for each one.
    try:
        import PIL  # noqa: F401
    except ImportError:
        print(
            "Pillow is missing, and without it the logos cannot be squared up.\n"
            "Homebrew's Python refuses to install into itself (PEP 668), so:\n"
            "    python3 -m venv .venv && .venv/bin/pip install Pillow\n"
            "    .venv/bin/python scripts/fetch_merchant_logos.py",
            file=sys.stderr,
        )
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    have: dict[str, tuple[str, list[str]]] = {}

    def on_disk(slug: str) -> Path | None:
        return next(iter(sorted(OUT_DIR.glob(f"{slug}.*"))), None)

    for slug, (domain, aliases) in sorted(BRANDS.items()):
        found = on_disk(slug)
        if found and not args.force:
            have[slug] = (domain, aliases)
            continue
        print(f"  → {slug} ({domain})", end=" ", flush=True)
        result = fetch(slug, domain)
        if result is None:
            # A brand nobody has a logo for keeps the category glyph it has;
            # a broken image would be worse than none.
            print("— nothing found, left with its category glyph")
            if found:
                found.unlink()
            continue
        data, ext = result
        if found and found.suffix != ext:
            found.unlink()
        path = OUT_DIR / f"{slug}{ext}"
        path.write_bytes(data)
        path = tidy(path)
        print(f"✓ {path.name} ({path.stat().st_size // 1024 or 1}KB)")
        have[slug] = (domain, aliases)
        time.sleep(0.15)

    # Anything on disk from an earlier run counts, even if this run skipped it.
    for slug, (domain, aliases) in BRANDS.items():
        if on_disk(slug):
            have[slug] = (domain, aliases)

    lookup: dict[str, str] = {}
    for slug, (_domain, aliases) in sorted(have.items()):
        file = on_disk(slug)
        if file is None:
            continue
        for name in [slug.replace("-", " "), *aliases]:
            key = normalise(name)
            if key and key not in lookup:
                lookup[key] = file.name

    lines = [
        "/* Generated by scripts/fetch_merchant_logos.py — do not edit by hand.",
        " *",
        " * Every spelling of a brand that this book has used, pointing at the one",
        " * logo that belongs to it. Regenerate after adding a brand to that script.",
        " */",
        "",
        "/** Normalised merchant name → the file in public/merchants that shows it. */",
        "export const MERCHANT_LOGOS: Record<string, string> = {",
    ]
    for key, slug in sorted(lookup.items()):
        lines.append(f"  {json.dumps(key)}: {json.dumps(slug)},")
    lines.append("};")
    lines.append("")
    TS_FILE.write_text("\n".join(lines))

    print(f"\n{len(have)} logos in {OUT_DIR.relative_to(ROOT)}, "
          f"{len(lookup)} spellings written to {TS_FILE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
