"""Process everything dropped into uploads/: GPX tracks and photos.

- GPX: works out which planned side-trail segments the track walked (and so which hikes),
  saves a light copy of the track to data/tracks/, and records the trip date.
- Photos (JPEG/PNG/HEIC/WebP): reads the date taken and GPS from the photo's metadata. If the photo
  has no GPS, it is placed on the matching trip's track by the time it was taken. Photos are
  resized for the web (metadata stripped) into photos/<date>/.
- Processed files are removed from uploads/. A summary of the run goes to data/last_run.json.

Run from the repository root:  python scripts/process_uploads.py
"""
import hashlib, io, json, math, os, re, sys, datetime as dt
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo
import numpy as np
from PIL import Image, ImageOps

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:  # HEIC photos will be reported as unreadable
    pillow_heif = None

LOCAL = ZoneInfo('America/Toronto')
UP, DATA, PHOTOS = 'uploads', 'data', 'photos'
PHOTO_EXT = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp'}
MATCH_M = 35          # a trail point counts as walked if the track passes within this distance
SEG_FRAC = 0.75       # share of a segment's points that must be walked to count it as covered
PHOTO_SLACK = dt.timedelta(minutes=30)   # photos up to this long before/after a track still match it


# ---------------------------------------------------------------- geometry helpers
def to_xy(lon, lat, lat0):
    """Local equirectangular projection in metres (fine over a few km)."""
    k = 111320.0
    return np.c_[(np.asarray(lon) * k * math.cos(math.radians(lat0))), np.asarray(lat) * k]


def densify(xy, step=20.0):
    out = [xy[0]]
    for a, b in zip(xy[:-1], xy[1:]):
        d = float(np.hypot(*(b - a)))
        n = max(1, int(d // step))
        for i in range(1, n + 1):
            out.append(a + (b - a) * i / n)
    return np.array(out)


def min_dist(points, line_pts, chunk=2000):
    """Distance from each point to the nearest densified line point."""
    best = np.full(len(points), np.inf)
    for i in range(0, len(line_pts), chunk):
        c = line_pts[i:i + chunk]
        d = np.sqrt(((points[:, None, :] - c[None, :, :]) ** 2).sum(-1)).min(1)
        best = np.minimum(best, d)
    return best


def rdp(xy, tol):
    """Douglas-Peucker simplification; returns kept indices."""
    keep = np.zeros(len(xy), bool); keep[0] = keep[-1] = True
    stack = [(0, len(xy) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = xy[a], xy[b]; seg = q - p; L = np.hypot(*seg)
        pts = xy[a + 1:b]
        if L == 0:
            d = np.hypot(*(pts - p).T)
        else:
            v = pts - p
            d = np.abs(seg[0] * v[:, 1] - seg[1] * v[:, 0]) / L
        i = int(np.argmax(d))
        if d[i] > tol:
            keep[a + 1 + i] = True; stack += [(a, a + 1 + i), (a + 1 + i, b)]
    return np.where(keep)[0]


# ---------------------------------------------------------------- loading
def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, obj, pretty=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1 if pretty else None, separators=None if pretty else (',', ':'))


def parse_time(s):
    if not s:
        return None
    s = s.strip().replace('Z', '+00:00')
    try:
        t = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def read_gpx(path):
    root = ET.parse(path).getroot()
    ns = {'g': root.tag.split('}')[0].strip('{')} if root.tag.startswith('{') else {'g': ''}
    q = (lambda tag: f'g:{tag}') if ns['g'] else (lambda tag: tag)
    name_el = root.find(f'.//{q("trk")}/{q("name")}', ns)
    if name_el is None:
        name_el = root.find(f'.//{q("metadata")}/{q("name")}', ns)
    pts = []
    for tag in ('trkpt', 'rtept'):
        for p in root.iter(f'{{{ns["g"]}}}{tag}' if ns['g'] else tag):
            t = p.find(q('time'), ns)
            pts.append((float(p.get('lon')), float(p.get('lat')), parse_time(t.text if t is not None else None)))
        if pts:
            break
    return (name_el.text.strip() if name_el is not None and name_el.text else ''), pts


# ---------------------------------------------------------------- photos
EXIF_IFD, GPS_IFD = 0x8769, 0x8825


def _ratio(v):
    try:
        return float(v)
    except TypeError:
        return v[0] / v[1]


def photo_meta(img):
    """(time taken as aware datetime or None, (lon, lat) or None) from EXIF."""
    ex = img.getexif()
    sub = ex.get_ifd(EXIF_IFD) if ex else {}
    raw = sub.get(36867) or sub.get(36868) or ex.get(306)  # DateTimeOriginal / Digitized / DateTime
    when = None
    if raw:
        try:
            when = dt.datetime.strptime(str(raw).strip()[:19], '%Y:%m:%d %H:%M:%S')
            off = sub.get(36881) or sub.get(36882)  # OffsetTimeOriginal
            if off and re.match(r'^[+-]\d\d:\d\d$', str(off).strip()):
                when = when.replace(tzinfo=dt.datetime.strptime(str(off).strip(), '%z').tzinfo)
            else:
                when = when.replace(tzinfo=LOCAL)
        except ValueError:
            when = None
    gps = ex.get_ifd(GPS_IFD) if ex else {}
    pos = None
    try:
        if gps and 2 in gps and 4 in gps:
            lat = sum(_ratio(v) / 60 ** i for i, v in enumerate(gps[2]))
            lon = sum(_ratio(v) / 60 ** i for i, v in enumerate(gps[4]))
            if str(gps.get(1, 'N')).upper().startswith('S'): lat = -lat
            if str(gps.get(3, 'E')).upper().startswith('W'): lon = -lon
            if 41 < lat < 47 and -83 < lon < -77:      # sanity: southern Ontario
                pos = (round(lon, 6), round(lat, 6))
    except (TypeError, ZeroDivisionError, ValueError):
        pos = None
    return when, pos


def save_web_copies(img, folder, stem):
    img = ImageOps.exif_transpose(img).convert('RGB')
    os.makedirs(folder, exist_ok=True)
    for suffix, size, q in (('', 1600, 82), ('_t', 360, 75)):
        c = img.copy(); c.thumbnail((size, size))
        c.save(os.path.join(folder, f'{stem}{suffix}.jpg'), 'JPEG', quality=q, optimize=True)
    return f'{folder}/{stem}.jpg', f'{folder}/{stem}_t.jpg', img.size


# ---------------------------------------------------------------- main
def main():
    segs = load_json(f'{DATA}/side_trails.json', [])
    hikes = {h['hike']: h for h in load_json(f'{DATA}/hikes.json', [])}
    prog = load_json(f'{DATA}/progress.json', {'trips': [], 'photos': [], 'covered': {}})
    _before = json.dumps({k: v for k, v in prog.items() if k != 'updated'}, sort_keys=True)
    prog.setdefault('trips', []); prog.setdefault('photos', []); prog.setdefault('covered', {})
    seg_lat0 = 44.0
    seg_xy = [to_xy([c[0] for c in s['coords']], [c[1] for c in s['coords']], seg_lat0) for s in segs]
    seg_box = [(a[:, 0].min(), a[:, 0].max(), a[:, 1].min(), a[:, 1].max()) for a in seg_xy]
    def match(xy):
        dens = densify(xy, 15)
        bx = (dens[:, 0].min() - 100, dens[:, 0].max() + 100, dens[:, 1].min() - 100, dens[:, 1].max() + 100)
        out = []
        for s, a, b in zip(segs, seg_xy, seg_box):
            if b[1] < bx[0] or b[0] > bx[1] or b[3] < bx[2] or b[2] > bx[3]:
                continue
            sp = densify(a, 20)
            frac = float((min_dist(sp, dens) <= MATCH_M).mean())
            if frac >= (0.5 if s['km'] < 0.08 else SEG_FRAC):
                out.append(s['oid'])
        return out
    log = {'run': dt.datetime.now(LOCAL).isoformat(timespec='seconds'), 'tracks': [], 'photos': [], 'problems': []}
    files = []
    for dp, _, fs in os.walk(UP):
        for f in fs:
            if not f.startswith('.') and f != 'README.md':
                files.append(os.path.join(dp, f))
    done = []

    # -------- tracks
    for path in sorted(p for p in files if p.lower().endswith('.gpx')):
        try:
            name, pts = read_gpx(path)
        except ET.ParseError as e:
            log['problems'].append(f'{os.path.basename(path)}: not a readable GPX file ({e})'); continue
        if len(pts) < 2:
            log['problems'].append(f'{os.path.basename(path)}: no track points'); continue
        lon = np.array([p[0] for p in pts]); lat = np.array([p[1] for p in pts])
        xy = to_xy(lon, lat, seg_lat0)
        times = [p[2] for p in pts]
        has_t = all(t is not None for t in times)
        start = min(t for t in times if t) if any(times) else None
        end = max(t for t in times if t) if any(times) else None
        date = start.astimezone(LOCAL).date().isoformat() if start else dt.date.today().isoformat()
        km = float(np.hypot(*np.diff(xy, axis=0).T).sum() / 1000)
        dens = densify(xy, 15)
        bx = (dens[:, 0].min() - 100, dens[:, 0].max() + 100, dens[:, 1].min() - 100, dens[:, 1].max() + 100)
        walked = match(xy)
        hk = sorted({s['hike'] for s in segs if s['oid'] in walked and s.get('hike')})
        tid = f"{date}_{hashlib.sha1(open(path, 'rb').read()).hexdigest()[:6]}"
        if any(t['id'] == tid for t in prog['trips']):
            log['problems'].append(f'{os.path.basename(path)}: already uploaded before (skipped)'); done.append(path); continue
        keep = rdp(xy, 4.0)
        track = {'id': tid, 'coords': [[round(float(lon[i]), 5), round(float(lat[i]), 5)] for i in keep]}
        if has_t:
            track['t'] = [int(times[i].timestamp()) for i in keep]
        save_json(f'{DATA}/tracks/{tid}.json', track)
        new_cov = 0.0
        for o in walked:
            if str(o) not in prog['covered']:
                prog['covered'][str(o)] = date
                new_cov += next(s['km'] for s in segs if s['oid'] == o)
        trip = {'id': tid, 'date': date, 'name': name or os.path.basename(path), 'km': round(km, 2),
                'start': start.isoformat() if start else None, 'end': end.isoformat() if end else None,
                'hikes': hk, 'segments': walked, 'new_km': round(new_cov, 2), 'track': f'{DATA}/tracks/{tid}.json'}
        prog['trips'].append(trip)
        log['tracks'].append({'file': os.path.basename(path), 'date': date, 'km': round(km, 1), 'hikes': hk,
                              'side_trail_km_new': round(new_cov, 2)})
        if not hk:
            log['problems'].append(f'{os.path.basename(path)}: did not match any planned side trail (kept as a bonus trip)')
        if not has_t:
            log['problems'].append(f'{os.path.basename(path)}: track has no timestamps, so photos without GPS cannot be placed on it')
        done.append(path)

    # -------- photos
    known = {p['hash'] for p in prog['photos']}
    for path in sorted(p for p in files if os.path.splitext(p)[1].lower() in PHOTO_EXT):
        raw = open(path, 'rb').read(); h = hashlib.sha1(raw).hexdigest()[:12]
        if h in known:
            log['problems'].append(f'{os.path.basename(path)}: already uploaded before (skipped)'); done.append(path); continue
        try:
            img = Image.open(io.BytesIO(raw)); img.load()
        except Exception as e:
            msg = 'HEIC support missing' if path.lower().endswith(('.heic', '.heif')) and not pillow_heif else str(e)
            log['problems'].append(f'{os.path.basename(path)}: could not open ({msg})'); continue
        when, pos = photo_meta(img)
        date = when.astimezone(LOCAL).date().isoformat() if when else 'undated'
        full, thumb, size = save_web_copies(img, f'{PHOTOS}/{date}', h)
        rec = {'hash': h, 'file': full, 'thumb': thumb, 'w': size[0], 'h': size[1], 'taken': when.isoformat() if when else None,
               'date': None if date == 'undated' else date, 'lon': pos[0] if pos else None, 'lat': pos[1] if pos else None,
               'gps': bool(pos), 'trip': None, 'original': os.path.basename(path)}
        prog['photos'].append(rec); known.add(h)
        log['photos'].append({'file': os.path.basename(path), 'date': rec['date'], 'gps': bool(pos)})
        done.append(path)

    # -------- re-match all stored tracks against the current trail data, so updates to the trail network
    #          (renamed / split / new side trails) are reflected in what counts as walked
    prog['covered'] = {}
    km_of = {s['oid']: s['km'] for s in segs}
    for t in sorted(prog['trips'], key=lambda t: (t['date'], t['start'] or '')):
        tr = load_json(t['track'], {})
        if not tr.get('coords'): continue
        c = np.array(tr['coords']); w = match(to_xy(c[:, 0], c[:, 1], seg_lat0))
        t['segments'] = w; t['hikes'] = sorted({s['hike'] for s in segs if s['oid'] in w and s.get('hike')})
        new = 0.0
        for o in w:
            if str(o) not in prog['covered']: prog['covered'][str(o)] = t['date']; new += km_of.get(o, 0)
        t['new_km'] = round(new, 2)

    # -------- attach photos to trips (re-run every time so photos uploaded before their GPX still get placed)
    tracks = {t['id']: load_json(t['track'], {}) for t in prog['trips']}
    for p in prog['photos']:
        when = parse_time(p['taken']) if p['taken'] else None
        best = None
        for t in prog['trips']:
            tr = tracks.get(t['id'], {})
            if when and t['start'] and parse_time(t['start']) - PHOTO_SLACK <= when <= parse_time(t['end']) + PHOTO_SLACK:
                best = t; break
        if best is None and p['lon'] is not None:
            for t in prog['trips']:
                c = np.array(tracks.get(t['id'], {}).get('coords', []))
                if len(c) and (p['date'] in (None, t['date'])):
                    d = min_dist(to_xy([p['lon']], [p['lat']], seg_lat0), to_xy(c[:, 0], c[:, 1], seg_lat0))[0]
                    if d < 300: best = t; break
        if best is None and p['date']:
            same = [t for t in prog['trips'] if t['date'] == p['date']]
            best = same[0] if len(same) == 1 else None
        p['trip'] = best['id'] if best else None
        if best and not p['gps']:
            tr = tracks.get(best['id'], {})
            if when and 't' in tr:          # interpolate position along the track by time
                ts = np.array(tr['t']); c = np.array(tr['coords']); x = when.timestamp()
                x = min(max(x, ts[0]), ts[-1])
                p['lon'] = round(float(np.interp(x, ts, c[:, 0])), 6); p['lat'] = round(float(np.interp(x, ts, c[:, 1])), 6)
                p['placed_by'] = 'time'
            else:
                p['lon'] = p['lat'] = None; p['placed_by'] = None
        elif p['gps']:
            p['placed_by'] = 'gps'
        if p['trip'] is None and p['date']:
            pass  # kept in the gallery for that date; placed on the map only if it has GPS
    for p in prog['photos']:
        if p['trip'] is None:
            log['problems'].append(f"{p['original']}: no trip matched yet (date {p['date'] or 'unknown'}); it will be matched when that day's GPX is uploaded")

    prog['trips'].sort(key=lambda t: (t['date'], t['start'] or ''))
    prog['photos'].sort(key=lambda p: (p['taken'] or '9999'))
    changed = json.dumps({k: v for k, v in prog.items() if k != 'updated'}, sort_keys=True) != _before
    if changed or files:                     # avoid a bot commit on every push when nothing changed
        prog['updated'] = log['run']
        save_json(f'{DATA}/progress.json', prog, pretty=True)
    if files:
        save_json(f'{DATA}/last_run.json', log, pretty=True)
    for p in done:
        os.remove(p)
    print(json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in log.items()}))
    for m in log['problems']:
        print('note:', m)


if __name__ == '__main__':
    sys.exit(main())
