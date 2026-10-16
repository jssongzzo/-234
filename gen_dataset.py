#!/usr/bin/env python3
"""합성 시험지 생성기: 인쇄 문제 + 손글씨(연필/펜) + 빨간 채점 + 사진 열화.

출력(배치 폴더): {id}.rgba (W*H*4 bytes), {id}.gt (W*H bytes: 0=배경 1=인쇄 2=손글씨), meta.json
사용: python3 gen_dataset.py OUT_DIR N SEED [--split train|val|shift]
  train : 학습용 글꼴/필기 스타일
  val   : 같은 분포, 다른 시드
  shift : 학습에 쓰지 않은 글꼴·필기 스타일(일반화 점검용)
"""
import sys, os, json, math, random
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont

W, H = 900, 1250
SS = 2  # 마스크는 2배 해상도로 그린 뒤 축소(안티앨리어싱)

NOTO = '/usr/share/fonts/opentype/noto/'
DJV = '/usr/share/fonts/truetype/dejavu/'
LIB = '/usr/share/fonts/truetype/liberation/'
FRE = '/usr/share/fonts/truetype/freefont/'
TG = '/usr/share/texmf/fonts/opentype/public/tex-gyre/'

# (경로, ttc index) — 한글 지원 CJK는 index 로 KR 변형 선택(없으면 0)
PRINT_TRAIN = [
    (NOTO + 'NotoSansCJK-Regular.ttc', 1), (NOTO + 'NotoSansCJK-Medium.ttc', 1), (NOTO + 'NotoSansCJK-Bold.ttc', 1),
    (NOTO + 'NotoSerifCJK-Regular.ttc', 1), (NOTO + 'NotoSerifCJK-Bold.ttc', 1),
    (DJV + 'DejaVuSans.ttf', 0), (DJV + 'DejaVuSerif.ttf', 0), (LIB + 'LiberationSerif-Regular.ttf', 0),
    (LIB + 'LiberationSans-Regular.ttf', 0), (FRE + 'FreeSerif.ttf', 0),
]
PRINT_SHIFT = [
    (NOTO + 'NotoSansCJK-Light.ttc', 1), (NOTO + 'NotoSerifCJK-Medium.ttc', 1), (NOTO + 'NotoSansCJK-DemiLight.ttc', 1),
    (DJV + 'DejaVuSansCondensed.ttf', 0), (FRE + 'FreeSans.ttf', 0), (TG + 'texgyretermes-regular.otf', 0),
    (TG + 'texgyrepagella-regular.otf', 0),
]
ITALIC_FONTS = [DJV + 'DejaVuSerif-Italic.ttf', LIB + 'LiberationSerif-Italic.ttf', FRE + 'FreeSerifItalic.ttf']
CJK_HAND_BASE = [NOTO + 'NotoSansCJK-Light.ttc', NOTO + 'NotoSansCJK-Regular.ttc', NOTO + 'NotoSerifCJK-Regular.ttc']

HERSHEY_TRAIN = [cv2.FONT_HERSHEY_SIMPLEX, cv2.FONT_HERSHEY_DUPLEX, cv2.FONT_HERSHEY_COMPLEX, cv2.FONT_HERSHEY_SCRIPT_SIMPLEX]
HERSHEY_SHIFT = [cv2.FONT_HERSHEY_TRIPLEX, cv2.FONT_HERSHEY_SCRIPT_COMPLEX, cv2.FONT_HERSHEY_COMPLEX_SMALL, cv2.FONT_HERSHEY_SIMPLEX | cv2.FONT_ITALIC]

KO_PHRASES = [
    '다음 식을 간단히 하시오.', '다음 방정식의 해를 구하시오.', '함수 f(x)의 최댓값을 구하시오.', '두 수의 합이 최소가 되도록 하는 값은?',
    '다음 중 옳은 것을 고르시오.', '그림과 같이 삼각형 ABC에서 각 B의 크기는?', '이차함수의 그래프가 x축과 만나는 점의 좌표를 구하시오.',
    '모든 실수 x에 대하여 부등식이 성립하도록 하는 정수 k의 개수는?', '다음 조건을 만족시키는 자연수 n의 값을 구하시오.',
    '등차수열의 첫째항과 공차를 각각 구하시오.', '확률을 구하시오.', '직선과 원이 한 점에서 만날 때 상수 a의 값을 구하시오.',
]
KO_HAND = ['답', '정답', '풀이', '따라서', '그러므로', '확인', '공식', '계산', '다시', '실수', '주의']


# ----------------------------------------------------------------- 유틸
def load_font(spec, size):
    path, idx = spec if isinstance(spec, tuple) else (spec, 0)
    try:
        return ImageFont.truetype(path, size, index=idx)
    except Exception:
        return ImageFont.truetype(path, size, index=0)


def rnd_expr(rng):
    a, b, c = rng.randint(1, 9), rng.randint(1, 12), rng.randint(1, 20)
    s1, s2 = rng.choice('+-'), rng.choice('+-')
    forms = [
        f'{a}x {s1} {b} = {c}', f'x² {s1} {b}x {s2} {c} = 0', f'{a}x² {s1} {b}x {s2} {c}', f'f(x) = {a}x {s1} {b}',
        f'y = {a}x² {s1} {b}', f'({a}x {s1} {b})({a}x {s2} {c})', f'{a}a + {b}b = {c}', f'∠A + ∠B = {a * 10}°',
        f'{a}² + {b}² = c²', f'log₂ {c} = x', f'x ≥ {a},  y ≤ {b}', f'{a}/{b} + {c}/{a}',
    ]
    return rng.choice(forms)


def rnd_hand_expr(rng):
    a, b, c = rng.randint(1, 9), rng.randint(1, 15), rng.randint(1, 30)
    forms = [f'{a}x+{b}={c}', f'{a}x={c - b}', f'x={rng.randint(-9, 9)}', f'{a}x^2-{b}x+{c}', f'({a}x+{b})({a}x-{c})',
             f'{a}x{b}={a * b}', f'{a}/{b}+{c}', f'y=-{a}x+{b}', f'{c}', f'{a}.{b}', f'= {a * b}', f'a^2+b^2={c}',
             f'{a}+{b}={a + b}', f'{c}-{a}={c - a}', f'x={a}, y={b}', f'3({a}x-{b})', f'f({a})={c}']
    return rng.choice(forms)


def elastic(img, rng, amp, sigma):
    h, w = img.shape[:2]
    dx = cv2.GaussianBlur((rng.random((h, w)).astype(np.float32) * 2 - 1), (0, 0), sigma) * amp * (sigma ** 0.5) * 3
    dy = cv2.GaussianBlur((rng.random((h, w)).astype(np.float32) * 2 - 1), (0, 0), sigma) * amp * (sigma ** 0.5) * 3
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    return cv2.remap(img, gx + dx, gy + dy, cv2.INTER_LINEAR, borderValue=0)


def paste_max(dst, src, x, y):
    h, w = src.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(dst.shape[1], x + w), min(dst.shape[0], y + h)
    if x1 <= x0 or y1 <= y0:
        return
    dst[y0:y1, x0:x1] = np.maximum(dst[y0:y1, x0:x1], src[y0 - y:y1 - y, x0 - x:x1 - x])


# ----------------------------------------------------------------- 인쇄 레이어
class PrintCanvas:
    def __init__(self, rng):
        self.img = Image.new('L', (W * SS, H * SS), 0)
        self.d = ImageDraw.Draw(self.img)
        self.rng = rng
        self.gaps = []  # 손글씨를 쓸 만한 빈 영역 (SS 좌표)

    def text(self, x, y, s, font, fill=255):
        self.d.text((x, y), s, font=font, fill=fill)
        b = self.d.textbbox((x, y), s, font=font)
        return b

    def line(self, p, q, w=2):
        self.d.line([p, q], fill=255, width=max(1, int(w)))

    def arr(self):
        return np.array(self.img)


def build_print(rng, prng, fonts, fs0):
    pc = PrintCanvas(prng)
    S = SS
    base_font = prng.choice(fonts)
    ital = prng.choice(ITALIC_FONTS)
    m = int(W * S * prng.uniform(0.07, 0.12))
    y = int(H * S * prng.uniform(0.04, 0.09))
    right = W * S - m
    fs = int(fs0 * S)
    num = prng.randint(1, 30)
    first = True
    while y < H * S - fs * 4:
        kind = prng.choices(['text', 'expr', 'frac', 'choices', 'table', 'graph', 'geo', 'blank'],
                            [3, 3, 1.4, 2.2, 1, 1.2, 1, 0.6])[0]
        f = load_font(base_font, fs)
        if first or kind == 'text':
            q = f'{num}. ' + prng.choice(KO_PHRASES)
            b = pc.text(m, y, q, f)
            y = b[3] + int(fs * prng.uniform(0.5, 1.0))
            num += 1 if not first else 0
            first = False
            if prng.random() < 0.35:
                pc.gaps.append((m, y, right, y + int(fs * prng.uniform(1.0, 2.2))))
                y += int(fs * prng.uniform(1.0, 2.2))
        elif kind == 'expr':
            fi = load_font(ital if prng.random() < 0.5 else base_font, int(fs * prng.uniform(1.0, 1.3)))
            x = m + int(fs * prng.uniform(1, 4))
            b = pc.text(x, y, rnd_expr(prng), fi)
            y = b[3] + int(fs * prng.uniform(0.6, 1.0))
            pc.gaps.append((m, y, right, y + int(fs * prng.uniform(1.2, 2.5))))
            y += int(fs * prng.uniform(1.2, 2.5))
        elif kind == 'frac':
            x = m + int(fs * prng.uniform(1, 5))
            fi = load_font(ital, int(fs * 1.0))
            n, dnm = str(prng.randint(1, 20)) + 'x', str(prng.randint(2, 30)) + 'y'
            bn = pc.d.textbbox((0, 0), n, font=fi); bd = pc.d.textbbox((0, 0), dnm, font=fi)
            wmax = max(bn[2], bd[2]) + 6
            pc.text(x + (wmax - bn[2]) // 2, y, n, fi)
            ly = y + bn[3] + 6
            pc.line((x, ly), (x + wmax, ly), max(2, S))
            pc.text(x + (wmax - bd[2]) // 2, ly + 4, dnm, fi)
            pc.text(x + wmax + 20, y + int(fs * 0.4), f'= {prng.randint(1, 9)}', f)
            y = ly + bd[3] + int(fs * 1.0)
            pc.gaps.append((m, y, right, y + int(fs * 1.5)))
            y += int(fs * 1.5)
        elif kind == 'choices':
            cs = '①②③④⑤'
            cf = load_font((NOTO + 'NotoSansCJK-Regular.ttc', 1), fs)
            n = prng.choice([4, 5])
            step = (right - m) // n
            for k in range(n):
                v = prng.choice([str(prng.randint(-9, 99)), f'{prng.randint(1, 9)}/{prng.randint(2, 9)}', f'{prng.randint(1, 9)}√{prng.randint(2, 7)}'])
                pc.text(m + k * step, y, cs[k] + ' ' + v, cf)
            y += int(fs * 1.6)
            pc.gaps.append((m, y, right, y + int(fs * 1.5)))
            y += int(fs * 1.5)
        elif kind == 'table':
            rows, cols = prng.randint(2, 4), prng.randint(3, 6)
            cw, rh = int(fs * prng.uniform(2.2, 3.2)), int(fs * 1.6)
            x0 = m + int(fs * prng.uniform(0, 3))
            tf = load_font(base_font, int(fs * 0.9))
            for r in range(rows + 1):
                pc.line((x0, y + r * rh), (x0 + cols * cw, y + r * rh), max(2, S))
            for c in range(cols + 1):
                pc.line((x0 + c * cw, y), (x0 + c * cw, y + rows * rh), max(2, S))
            for r in range(rows):
                for c in range(cols):
                    t = ('x' if r == 0 and c == 0 else 'y' if c == 0 else str(prng.randint(-9, 99)))
                    pc.text(x0 + c * cw + cw // 3, y + r * rh + rh // 5, t, tf)
            y += rows * rh + int(fs * 0.8)
        elif kind == 'graph':
            gw, gh = int(fs * prng.uniform(7, 11)), int(fs * prng.uniform(5, 8))
            x0 = m + int(fs * prng.uniform(0, 5)); ox, oy = x0 + gw // 2, y + gh // 2
            lw = max(2, S)
            pc.line((x0, oy), (x0 + gw, oy), lw); pc.line((ox, y), (ox, y + gh), lw)
            pc.line((x0 + gw, oy), (x0 + gw - 12, oy - 7), lw); pc.line((x0 + gw, oy), (x0 + gw - 12, oy + 7), lw)
            pc.line((ox, y), (ox - 7, y + 12), lw); pc.line((ox, y), (ox + 7, y + 12), lw)
            a = prng.uniform(0.003, 0.012) * prng.choice([-1, 1])
            pts = [(ox + t, oy - a * t * t * 40) for t in range(-gw // 2 + 4, gw // 2 - 4, 4)]
            pts = [(px, py) for px, py in pts if y + 4 < py < y + gh - 4]
            if len(pts) > 2:
                pc.d.line(pts, fill=255, width=lw + 1)
            gf = load_font(ital, int(fs * 0.8))
            pc.text(x0 + gw + 6, oy - fs // 2, 'x', gf); pc.text(ox + 8, y - fs // 3, 'y', gf); pc.text(ox - fs, oy + 4, 'O', gf)
            y += gh + int(fs * 0.9)
        elif kind == 'geo':
            gw, gh = int(fs * 6), int(fs * 4.5)
            x0 = m + int(fs * prng.uniform(1, 6)); gf = load_font(ital, int(fs * 0.85))
            lw = max(2, S)
            if prng.random() < 0.5:
                P = [(x0, y + gh), (x0 + gw, y + gh), (x0 + int(gw * prng.uniform(0.2, 0.8)), y)]
                pc.d.line(P + [P[0]], fill=255, width=lw)
                for t, (px, py) in zip('ABC', P):
                    pc.text(px - 8 if t != 'B' else px + 6, py + (6 if t != 'C' else -fs), t, gf)
            else:
                cx, cy, r = x0 + gw // 2, y + gh // 2, gh // 2
                pc.d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=255, width=lw)
                pc.text(cx - 6, cy - 6, 'O', gf)
                pc.line((cx, cy), (cx + r, cy), lw)
            y += gh + int(fs * 1.0)
        else:
            if prng.random() < 0.7:
                pc.text(right - int(fs * 6), y, '답: ______', f)
            else:
                pc.d.rectangle((right - int(fs * 6), y, right, y + int(fs * 1.7)), outline=255, width=max(2, S))
            y += int(fs * 2.0)
        y += int(fs * prng.uniform(0.2, 0.9))
    return pc


# ----------------------------------------------------------------- 손글씨 레이어
def hand_glyph(ch, size, hfont, rng):
    """한 글자를 (size*2)^2 캔버스에 단일 획 글꼴로 그림 → 변형"""
    S2 = int(size * 2.2) + 8
    tmp = np.zeros((S2, S2), np.uint8)
    base = 22.0
    scale = size / base * 0.95
    th = max(1, int(round(size * rng.uniform(0.045, 0.11))))
    pad = int(size * 0.5)
    if ch == '×':
        cv2.line(tmp, (pad, pad + int(size * .25)), (pad + int(size * .6), pad + int(size * .85)), 255, th, cv2.LINE_AA)
        cv2.line(tmp, (pad + int(size * .6), pad + int(size * .25)), (pad, pad + int(size * .85)), 255, th, cv2.LINE_AA)
    elif ch == '√':
        pts = np.array([[pad, pad + size * .6], [pad + size * .2, pad + size * .95], [pad + size * .5, pad + size * .1], [pad + size * 1.1, pad + size * .1]], np.int32)
        cv2.polylines(tmp, [pts], False, 255, th, cv2.LINE_AA)
    else:
        cv2.putText(tmp, ch, (pad, pad + size), hfont, scale, 255, th, cv2.LINE_AA)
    ang = rng.uniform(-9, 9); shear = rng.uniform(-0.28, 0.12); sx = rng.uniform(0.85, 1.15)
    M = np.array([[sx * math.cos(math.radians(ang)), -math.sin(math.radians(ang)) + shear, 0],
                  [math.sin(math.radians(ang)), math.cos(math.radians(ang)), 0]], np.float32)
    M[:, 2] = [-(M[0, 0] * S2 / 2 + M[0, 1] * S2 / 2) + S2 / 2, -(M[1, 0] * S2 / 2 + M[1, 1] * S2 / 2) + S2 / 2]
    tmp = cv2.warpAffine(tmp, M, (S2, S2), flags=cv2.INTER_LINEAR)
    tmp = elastic(tmp, np.random.default_rng(rng.integers(1 << 30)), amp=rng.uniform(0.4, 1.2), sigma=max(3, size / 8))
    if rng.random() < 0.4:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2, 2))
        tmp = cv2.dilate(tmp, k) if rng.random() < 0.5 else cv2.erode(tmp, k)
    return tmp


def hand_text(mask, text, x, y, size, hfonts, rng):
    cx = x
    drift = rng.uniform(-0.12, 0.12)
    ph = rng.uniform(0, 6.28)
    for i, ch in enumerate(text):
        if ch == ' ':
            cx += int(size * rng.uniform(0.3, 0.6)); continue
        hf = rng.choice(hfonts) if rng.random() < 0.15 else hfonts[0]
        g = hand_glyph(ch, size, hf, rng)
        yy = int(y + math.sin(i * 0.7 + ph) * size * 0.08 + drift * (cx - x) + rng.uniform(-0.07, 0.07) * size)
        paste_max(mask, g, int(cx - size * 0.5), int(yy - size * 0.5))
        (tw, _), _ = cv2.getTextSize(ch, hf if ch not in '×√' else cv2.FONT_HERSHEY_SIMPLEX, size / 22 * 0.95, 1)
        cx += int(max(size * 0.45, tw) * rng.uniform(0.85, 1.25))
    return cx


def hand_ko(mask, text, x, y, size, rng):
    f = ImageFont.truetype(rng.choice(CJK_HAND_BASE), size, index=1)
    cx = x
    for ch in text:
        im = Image.new('L', (size * 2, size * 2), 0)
        ImageDraw.Draw(im).text((size // 2, size // 4), ch, font=f, fill=255)
        a = np.array(im)
        if rng.random() < 0.7:
            a = cv2.erode(a, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2, 2)))
        ang = rng.uniform(-8, 8)
        M = cv2.getRotationMatrix2D((size, size), ang, rng.uniform(0.9, 1.1))
        a = cv2.warpAffine(a, M, (size * 2, size * 2))
        a = elastic(a, np.random.default_rng(rng.integers(1 << 30)), amp=rng.uniform(1.0, 2.2), sigma=max(3, size / 7))
        paste_max(mask, a, int(cx - size / 2), int(y - size / 2 + rng.uniform(-0.1, 0.1) * size))
        cx += int(size * rng.uniform(0.9, 1.15))
    return cx


def hand_circle(mask, x0, y0, x1, y1, th, rng):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = (x1 - x0) / 2 * rng.uniform(1.0, 1.25), (y1 - y0) / 2 * rng.uniform(1.0, 1.35)
    n = int(rng.uniform(1.1, 1.8) * 60)
    t = np.linspace(rng.uniform(0, 6.28), rng.uniform(0, 6.28) + 6.28 * rng.uniform(1.0, 1.6), n)
    wob = 1 + 0.06 * np.sin(t * rng.uniform(1, 3) + rng.uniform(0, 6)) + np.linspace(0, rng.uniform(-.08, .08), n)
    pts = np.stack([cx + rx * np.cos(t) * wob, cy + ry * np.sin(t) * wob], 1).astype(np.int32)
    cv2.polylines(mask, [pts], False, 255, th, cv2.LINE_AA)


def hand_scribble_line(mask, x0, y0, x1, y1, th, rng, wave=0.03):
    n = max(6, int(abs(x1 - x0) / 12))
    xs = np.linspace(x0, x1, n); ys = np.linspace(y0, y1, n) + np.sin(np.linspace(0, rng.uniform(2, 8), n)) * abs(x1 - x0) * wave * rng.uniform(.3, 1)
    cv2.polylines(mask, [np.stack([xs, ys], 1).astype(np.int32)], False, 255, th, cv2.LINE_AA)


def hand_check(mask, x, y, s, th, rng):
    p = np.array([[x, y + s * .55], [x + s * .3, y + s], [x + s * 1.1, y - s * .1]], np.float32)
    p += rng.uniform(-s * .06, s * .06, p.shape)
    cv2.polylines(mask, [p.astype(np.int32)], False, 255, th, cv2.LINE_AA)


def build_hand(rng, prng, pc, hershey, fs0):
    """pc.gaps 중에서 손글씨를 쓴다. 반환: (연필/펜 마스크 리스트)"""
    S = SS
    m = np.zeros((H * S, W * S), np.uint8)
    hfonts = [prng.choice(hershey)] + [prng.choice(hershey) for _ in range(3)]
    gaps = list(pc.gaps)
    prng.shuffle(gaps)
    size_base = fs0 * S * prng.uniform(0.75, 1.3)
    th_base = prng.uniform(0.9, 1.0)
    n_lines = 0
    for (gx0, gy0, gx1, gy1) in gaps:
        if prng.random() < 0.15:
            continue
        gh = gy1 - gy0
        if gh < size_base * 0.9:
            continue
        nl = max(1, min(3, int(gh // (size_base * 1.3))))
        for k in range(nl):
            size = int(size_base * prng.uniform(0.85, 1.15))
            y = gy0 + size * 0.8 + k * size * 1.3 + prng.uniform(0, size * 0.3)
            x = gx0 + (gx1 - gx0) * prng.uniform(0, 0.5)
            if prng.random() < 0.18:
                x1 = hand_ko(m, prng.choice(KO_HAND), int(x), int(y), size, rng)
                x = x1 + size * 0.5
            txt = rnd_hand_expr(prng)
            x1 = hand_text(m, txt, int(x), int(y), size, hfonts, rng)
            n_lines += 1
            if prng.random() < 0.2:
                hand_scribble_line(m, x, y + size * .55, x1, y + size * .55, max(2, int(size * .07)), rng)
            if prng.random() < 0.15:
                hand_check(m, x1 + size * .3, y - size * .6, size * .7, max(2, int(size * .09)), rng)
    # 객관식 번호 동그라미 / 밑줄 / 여백 낙서
    if prng.random() < 0.5:
        for _ in range(prng.randint(1, 3)):
            cx, cy = prng.randint(int(W * S * .1), int(W * S * .9)), prng.randint(int(H * S * .1), int(H * S * .9))
            r = int(fs0 * S * prng.uniform(0.7, 1.2))
            hand_circle(m, cx - r, cy - r * .7, cx + r, cy + r * .7, max(2, int(fs0 * S * .09)), rng)
    if prng.random() < 0.35:
        x = int(W * S * prng.uniform(.62, .85)); y = int(H * S * prng.uniform(.05, .9)); s = int(fs0 * S * prng.uniform(0.9, 1.3))
        hand_text(m, str(prng.randint(1, 30)), x, y, s, hfonts, rng)
    if prng.random() < 0.3 and n_lines > 0:
        y = int(H * S * prng.uniform(.1, .9)); x0 = int(W * S * prng.uniform(.1, .4))
        hand_scribble_line(m, x0, y, x0 + int(W * S * prng.uniform(.2, .4)), y + prng.randint(-20, 20), max(2, int(fs0 * S * .08)), rng)
    return m


# ----------------------------------------------------------------- 합성/열화
def paper_texture(rng, prng):
    base = np.array([prng.uniform(228, 252), prng.uniform(226, 250), prng.uniform(216, 248)], np.float32)
    img = np.ones((H, W, 3), np.float32) * base
    gx, gy = np.meshgrid(np.linspace(-1, 1, W), np.linspace(-1, 1, H))
    ang = prng.uniform(0, 6.28)
    light = 1 + prng.uniform(0.02, 0.12) * (np.cos(ang) * gx + np.sin(ang) * gy)
    light *= 1 - prng.uniform(0, 0.18) * (gx ** 2 + gy ** 2)
    if prng.random() < 0.3:  # 그림자 띠
        d = (np.cos(ang + 1.2) * gx + np.sin(ang + 1.2) * gy - prng.uniform(-.5, .5)) * prng.uniform(3, 8)
        light *= 1 - prng.uniform(0.08, 0.25) / (1 + np.exp(-d))
    img *= light[..., None]
    fib = cv2.GaussianBlur(rng.normal(0, 1, (H, W)).astype(np.float32), (0, 0), 1.5) * prng.uniform(1.0, 3.0)
    return img + fib[..., None]


def blend(img, mask, color, alpha):
    a = (mask.astype(np.float32) / 255.0 * alpha)[..., None]
    img[:] = img * (1 - a) + np.array(color, np.float32) * a


def instrument(prng):
    r = prng.random()
    if r < 0.45:   # 연필
        g = prng.uniform(70, 150); return (g, g, g + prng.uniform(-3, 6)), prng.uniform(0.55, 0.9), 'pencil'
    if r < 0.60:   # 샤프(얇고 연함)
        g = prng.uniform(90, 160); return (g, g, g), prng.uniform(0.5, 0.8), 'mech'
    g = prng.uniform(18, 75)  # 검정/진한 펜
    return (g, g + prng.uniform(0, 8), g + prng.uniform(0, 20)), prng.uniform(0.88, 1.0), 'pen'


def make_page(seed, split):
    prng = random.Random(seed); rng = np.random.default_rng(seed)
    fonts = PRINT_SHIFT if split == 'shift' else PRINT_TRAIN
    hershey = HERSHEY_SHIFT if split == 'shift' else HERSHEY_TRAIN
    fs0 = prng.uniform(20, 38)
    pc = build_print(rng, prng, fonts, fs0)
    P = cv2.resize(pc.arr(), (W, H), interpolation=cv2.INTER_AREA)
    if prng.random() < 0.15:  # 손글씨가 전혀 없는 깨끗한 문제(오탐 점검용)
        Hm = np.zeros((H, W), np.uint8)
        H2 = np.zeros((H, W), np.uint8)
    else:
        hm = build_hand(rng, prng, pc, hershey, fs0)
        Hm = cv2.resize(hm, (W, H), interpolation=cv2.INTER_AREA)
        H2 = np.zeros((H, W), np.uint8)
        if prng.random() < 0.25:  # 다른 필기구로 덧쓴 두 번째 레이어
            hm2 = build_hand(rng, prng, pc, hershey, fs0)
            H2 = cv2.resize(hm2, (W, H), interpolation=cv2.INTER_AREA)
    img = paper_texture(rng, prng)
    pg = prng.uniform(10, 90)
    blend(img, P, (pg, pg, pg + prng.uniform(0, 10)), prng.uniform(0.85, 1.0))
    c1, a1, _ = instrument(prng); blend(img, Hm, c1, a1)
    if H2.any():
        c2, a2, _ = instrument(prng); blend(img, H2, c2, a2)
    # 연필 질감: 필기 영역의 농도를 낮은 주파수 노이즈로 흔든다
    gt = np.zeros((H, W), np.uint8)
    gt[P > 90] = 1
    gt[(Hm > 70) | (H2 > 70)] = 2
    # 빨간 채점 표시
    if prng.random() < 0.6:
        red = np.zeros((H, W), np.uint8)
        for _ in range(prng.randint(1, 4)):
            t = prng.choice(['circle', 'check', 'x', 'num'])
            cx, cy = prng.randint(60, W - 60), prng.randint(60, H - 60)
            th = prng.randint(3, 7)
            if t == 'circle':
                cv2.ellipse(red, (cx, cy), (prng.randint(30, 110), prng.randint(20, 60)), prng.uniform(-10, 10), 0, 360, 255, th, cv2.LINE_AA)
            elif t == 'check':
                cv2.polylines(red, [np.array([[cx, cy], [cx + 25, cy + 40], [cx + 90, cy - 50]], np.int32)], False, 255, th, cv2.LINE_AA)
            elif t == 'x':
                cv2.line(red, (cx - 40, cy - 40), (cx + 40, cy + 40), 255, th, cv2.LINE_AA); cv2.line(red, (cx + 40, cy - 40), (cx - 40, cy + 40), 255, th, cv2.LINE_AA)
            else:
                cv2.putText(red, str(prng.randint(0, 100)), (cx, cy), cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, prng.uniform(1.5, 3), 255, th, cv2.LINE_AA)
        blend(img, red, (prng.uniform(180, 235), prng.uniform(25, 75), prng.uniform(30, 80)), prng.uniform(0.85, 1.0))
    # 사진 열화 + 기하 변환
    zoom = prng.uniform(0.8, 1.7); ang = prng.uniform(-2.5, 2.5)
    M = cv2.getRotationMatrix2D((W / 2, H / 2), ang, zoom)
    M[:, 2] += [prng.uniform(-0.15, 0.15) * W * (zoom - 0.8), prng.uniform(-0.15, 0.15) * H * (zoom - 0.8)]
    img8 = np.clip(img, 0, 255).astype(np.uint8)
    img8 = cv2.warpAffine(img8, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    gt = cv2.warpAffine(gt, M, (W, H), flags=cv2.INTER_NEAREST, borderValue=0)
    img8 = cv2.GaussianBlur(img8, (0, 0), prng.uniform(0.5, 1.6)).astype(np.float32)
    img8 += rng.normal(0, prng.uniform(1.5, 5), img8.shape).astype(np.float32)
    img8 = np.clip(img8, 0, 255).astype(np.uint8)
    q = prng.randint(55, 92)
    ok, enc = cv2.imencode('.jpg', img8[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, q])
    img8 = cv2.imdecode(enc, cv2.IMREAD_COLOR)[..., ::-1]
    rgba = np.dstack([img8, np.full((H, W), 255, np.uint8)])
    return np.ascontiguousarray(rgba), gt


def main():
    out, n, seed = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    split = sys.argv[sys.argv.index('--split') + 1] if '--split' in sys.argv else 'train'
    os.makedirs(out, exist_ok=True)
    ids = []
    for i in range(n):
        rgba, gt = make_page(seed * 100000 + i, split)
        rgba.tofile(os.path.join(out, f'{i}.rgba')); gt.tofile(os.path.join(out, f'{i}.gt'))
        ids.append(i)
    json.dump({'W': W, 'H': H, 'ids': ids, 'split': split}, open(os.path.join(out, 'meta.json'), 'w'))


if __name__ == '__main__':
    main()
