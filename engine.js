/* 오답노트 - 이미지 처리 엔진
 * 외부 라이브러리 없이 동작하는 순수 함수 모음 (브라우저 / Node 공용)
 *  - analyze : 빨간 펜 후보, 종이색 판별 정보 계산
 *  - inkMask : 사용자가 찍은 색과 비슷한 잉크(파란 펜 등) 마스크
 *  - dilate  : 마스크 확장 (펜 가장자리 번짐까지 지우기 위함)
 *  - inpaint : 마스크 영역을 주변 종이 색으로 메우기 (push-pull 방식)
 */
(function (root) {
  'use strict';
  const Engine = {};

  /** RGBA 데이터를 분석한다. */
  Engine.analyze = function (d, W, H) {
    const N = W * H;
    const redD = new Uint8Array(N);   // 빨강 정도 (r - max(g,b)), 주황/분홍 제외
    const luma = new Uint8Array(N);
    const srcOK = new Uint8Array(N);  // 메우기에 참고해도 되는 "종이색" 픽셀
    const hist = new Uint32Array(256);

    for (let i = 0, j = 0; i < N; i++, j += 4) {
      const r = d[j], g = d[j + 1], b = d[j + 2];
      const l = (r * 77 + g * 150 + b * 29) >> 8;
      luma[i] = l; hist[l]++;
      const dd = r - (g > b ? g : b);
      if (dd > 0 && r > 70 && (g - b) < 0.55 * dd) redD[i] = dd > 255 ? 255 : dd;
    }

    // 종이 밝기 = 상위 20% 지점의 밝기
    let acc = 0, paper = 255;
    const target = N * 0.8;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) { paper = v; break; } }
    const thr = paper * 0.66;

    // 종이 색의 색조(R-G, G-B) 평균: 종이로 볼 수 있는 가장 밝은 픽셀들에서 추정
    let sRG = 0, sGB = 0, cnt = 0;
    const bright = paper * 0.95;
    for (let i = 0, j = 0; i < N; i += 7, j += 28) {          // 샘플링
      if (luma[i] >= bright) { sRG += d[j] - d[j + 1]; sGB += d[j + 1] - d[j + 2]; cnt++; }
    }
    const pRG = cnt ? sRG / cnt : 0, pGB = cnt ? sGB / cnt : 0;

    for (let i = 0, j = 0; i < N; i++, j += 4) {
      const r = d[j], g = d[j + 1], b = d[j + 2];
      const rg = r - g, gb = g - b;
      // 종이처럼 밝고, 종이와 색조가 비슷한 픽셀만 "참고색"으로 사용 (JPEG 색 번짐 제외)
      srcOK[i] = (luma[i] >= thr && Math.abs(rg - pRG) <= 16 && Math.abs(gb - pGB) <= 16) ? 1 : 0;
    }
    return { redD, luma, srcOK, paper };
  };

  /** 클릭한 위치 주변에서 가장 색이 진한 픽셀로 잉크 색 샘플을 만든다. 없으면 null */
  Engine.sampleInk = function (d, W, H, x, y, R) {
    let best = -1, bi = -1;
    const x0 = Math.max(0, Math.round(x) - R), x1 = Math.min(W - 1, Math.round(x) + R);
    const y0 = Math.max(0, Math.round(y) - R), y1 = Math.min(H - 1, Math.round(y) + R);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const j = (yy * W + xx) * 4;
        const r = d[j], g = d[j + 1], b = d[j + 2];
        const c = Math.max(r, g, b) - Math.min(r, g, b);
        if (c > best) { best = c; bi = j; }
      }
    }
    if (best < 30) return null;
    const r = d[bi], g = d[bi + 1], b = d[bi + 2];
    const m = (r + g + b) / 3;
    return { c: [r - m, g - m, b - m], rgb: [r, g, b] };
  };

  /** 잉크 색(색상 방향)이 비슷한 픽셀을 out 에 1로 표시한다. angleDeg: 허용 각도 */
  Engine.inkMask = function (out, d, A, W, H, ink, angleDeg) {
    const N = W * H;
    const cx = ink.c[0], cy = ink.c[1], cz = ink.c[2];
    const cn2 = cx * cx + cy * cy + cz * cz;
    const cs = Math.cos(angleDeg * Math.PI / 180);
    const k = cs * cs * cn2;
    const MINC2 = 24 * 24;
    const maxLuma = A.paper * 0.9;
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      if (A.luma[i] > maxLuma) continue;               // 종이색 근처는 제외
      const r = d[j], g = d[j + 1], b = d[j + 2];
      const m = (r + g + b) / 3;
      const a = r - m, bb = g - m, c = b - m;
      const n2 = a * a + bb * bb + c * c;
      if (n2 < MINC2) continue;                        // 거의 무채색(검정/회색)은 제외
      const dot = a * cx + bb * cy + c * cz;
      if (dot > 0 && dot * dot > k * n2) out[i] = 1;
    }
  };

  /** 0/1 마스크를 반경 r 만큼 사각형 모양으로 확장한다. */
  Engine.dilate = function (m, W, H, r) {
    if (r <= 0) return Uint8Array.from(m);
    const t = new Uint8Array(W * H), o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W; let cnt = 0;
      for (let x = 0; x < Math.min(r, W); x++) cnt += m[row + x];
      for (let x = 0; x < W; x++) {
        const add = x + r; if (add < W) cnt += m[row + add];
        const rem = x - r - 1; if (rem >= 0) cnt -= m[row + rem];
        t[row + x] = cnt > 0 ? 1 : 0;
      }
    }
    for (let x = 0; x < W; x++) {
      let cnt = 0;
      for (let y = 0; y < Math.min(r, H); y++) cnt += t[y * W + x];
      for (let y = 0; y < H; y++) {
        const add = y + r; if (add < H) cnt += t[add * W + x];
        const rem = y - r - 1; if (rem >= 0) cnt -= t[rem * W + x];
        o[y * W + x] = cnt > 0 ? 1 : 0;
      }
    }
    return o;
  };

  /**
   * hole(1) 영역을 srcOK 픽셀들의 색으로 메운다 (push-pull 피라미드).
   * px: RGBA Uint8ClampedArray (제자리 수정)
   */
  Engine.inpaint = function (px, W, H, hole, srcOK, margin) {
    const N = W * H;
    const near = margin > 0 ? Engine.dilate(hole, W, H, margin) : hole;   // 펜 번짐이 남은 가장자리 제외용
    const col0 = new Float32Array(N * 3);
    const ok0 = new Uint8Array(N);
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      if (srcOK[i] && !near[i]) {
        ok0[i] = 1;
        const k = i * 3; col0[k] = px[j]; col0[k + 1] = px[j + 1]; col0[k + 2] = px[j + 2];
      }
    }
    const levels = [{ w: W, h: H, col: col0, ok: ok0 }];

    // push: 점점 작게 (2x2 평균, 유효한 픽셀만)
    for (;;) {
      const L = levels[levels.length - 1];
      const nw = (L.w + 1) >> 1, nh = (L.h + 1) >> 1;
      const ncol = new Float32Array(nw * nh * 3), nok = new Uint8Array(nw * nh);
      let missing = 0;
      for (let y2 = 0; y2 < nh; y2++) {
        for (let x2 = 0; x2 < nw; x2++) {
          let r = 0, g = 0, b = 0, c = 0;
          for (let dy = 0; dy < 2; dy++) {
            const y = y2 * 2 + dy; if (y >= L.h) continue;
            for (let dx = 0; dx < 2; dx++) {
              const x = x2 * 2 + dx; if (x >= L.w) continue;
              const i = y * L.w + x;
              if (L.ok[i]) { const k = i * 3; r += L.col[k]; g += L.col[k + 1]; b += L.col[k + 2]; c++; }
            }
          }
          const o = y2 * nw + x2;
          if (c) { ncol[o * 3] = r / c; ncol[o * 3 + 1] = g / c; ncol[o * 3 + 2] = b / c; nok[o] = 1; }
          else missing++;
        }
      }
      levels.push({ w: nw, h: nh, col: ncol, ok: nok });
      if (missing === 0) break;
      if (nw === 1 && nh === 1) {           // 참고할 종이 픽셀이 전혀 없는 경우
        ncol[0] = ncol[1] = ncol[2] = 255; nok[0] = 1; break;
      }
    }

    // pull: 위에서부터 내려오며 비어 있는 픽셀을 양선형 보간으로 채움
    for (let l = levels.length - 2; l >= 0; l--) {
      const L = levels[l], P = levels[l + 1];
      for (let y = 0; y < L.h; y++) {
        const fy = (y + 0.5) / 2 - 0.5;
        let y0 = Math.floor(fy); const ty = fy - y0;
        let y1 = Math.min(y0 + 1, P.h - 1); y0 = Math.max(y0, 0);
        for (let x = 0; x < L.w; x++) {
          const i = y * L.w + x;
          if (L.ok[i]) continue;
          const fx = (x + 0.5) / 2 - 0.5;
          let x0 = Math.floor(fx); const tx = fx - x0;
          let x1 = Math.min(x0 + 1, P.w - 1); x0 = Math.max(x0, 0);
          const a = (y0 * P.w + x0) * 3, b = (y0 * P.w + x1) * 3;
          const c = (y1 * P.w + x0) * 3, d = (y1 * P.w + x1) * 3;
          const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
          const k = i * 3;
          L.col[k]     = P.col[a]     * w00 + P.col[b]     * w10 + P.col[c]     * w01 + P.col[d]     * w11;
          L.col[k + 1] = P.col[a + 1] * w00 + P.col[b + 1] * w10 + P.col[c + 1] * w01 + P.col[d + 1] * w11;
          L.col[k + 2] = P.col[a + 2] * w00 + P.col[b + 2] * w10 + P.col[c + 2] * w01 + P.col[d + 2] * w11;
          L.ok[i] = 1;
        }
      }
    }

    // 결과 반영 (hole 픽셀만)
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      if (hole[i]) {
        const k = i * 3;
        px[j] = col0[k]; px[j + 1] = col0[k + 1]; px[j + 2] = col0[k + 2]; px[j + 3] = 255;
      }
    }
  };


  /* =========================================================
   * 손글씨(연필·검정 펜) 자동 감지  — 모델 없이 동작하는 규칙 기반 분석
   *  1) 지역 배경 대비로 잉크 픽셀 추출 (그림자에 강함)
   *  2) 연결 성분(글자 조각) 분리
   *  3) 단서 ① 농도: 인쇄 글자보다 옅은 회색(연필)이면 손글씨
   *     단서 ② 배열: 같은 줄로 묶었을 때 밑줄이 들쭉날쭉/크기가 제각각이면 손글씨
   *  4) 손글씨 성분을 가까운 것끼리 "영역"으로 묶어 사용자가 확인·조정
   * ========================================================= */
  function median(a) {
    if (!a.length) return 0;
    const b = Array.from(a).sort((x, y) => x - y), m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }

  // 확장 bbox 가 겹치는 성분끼리 묶는다 (union-find + 격자 해시). 반환: id -> 그룹 대표 id
  function groupComps(list, gx, gy) {
    const parent = new Map();
    const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
    const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const cs = Math.max(8, gx * 2), cells = new Map();
    for (const c of list) {
      parent.set(c.id, c.id);
      const ex0 = c.x0 - gx, ex1 = c.x1 + gx, ey0 = c.y0 - gy, ey1 = c.y1 + gy;
      const cx0 = Math.floor(ex0 / cs), cx1 = Math.floor(ex1 / cs), cy0 = Math.floor(ey0 / cs), cy1 = Math.floor(ey1 / cs);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const key = cy * 100003 + cx;
        let arr = cells.get(key);
        if (!arr) { arr = []; cells.set(key, arr); }
        for (const m of arr) {
          if (ex0 <= m.x1 + gx && ex1 >= m.x0 - gx && ey0 <= m.y1 + gy && ey1 >= m.y0 - gy) uni(c.id, m.id);
        }
        arr.push(c);
      }
    }
    const out = new Map();
    for (const c of list) out.set(c.id, find(c.id));
    return out;
  }

  /**
   * @param d       RGBA 데이터
   * @param A       Engine.analyze 결과 (luma, paper)
   * @param exclude 이미 지운 영역(0/1) — 종이로 취급
   * @param o       { sens: 0~100 }
   */
  Engine.detectHandwriting = function (d, W, H, A, exclude, o) {
    o = o || {};
    const sens = o.sens == null ? 50 : o.sens;
    const dT = 0.20 - sens * 0.0012;      // 인쇄 대비 얼마나 옅어야 연필로 볼지
    const baseT = 0.30 - sens * 0.0020;   // 밑줄 흔들림 허용치 (글자 높이 대비)
    const hcvT = 0.60 - sens * 0.0030;    // 글자 크기 편차 허용치
    const N = W * H, paper = A.paper;

    const L = new Uint8Array(N);
    for (let i = 0; i < N; i++) L[i] = (exclude && exclude[i]) ? paper : A.luma[i];

    // --- 1) 지역 배경 추정 + 잉크 추출
    const g1 = paper * 0.7, IW = W + 1;
    const sum = new Uint32Array(IW * (H + 1)), cnt = new Uint32Array(IW * (H + 1));
    for (let y = 0; y < H; y++) {
      let rs = 0, rc = 0;
      for (let x = 0; x < W; x++) {
        const v = L[y * W + x];
        if (v >= g1) { rs += v; rc++; }
        const k = (y + 1) * IW + x + 1, u = y * IW + x + 1;
        sum[k] = sum[u] + rs; cnt[k] = cnt[u] + rc;
      }
    }
    const R = Math.max(12, Math.round(Math.max(W, H) / 40));
    const ink = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1);
        const a = y0 * IW + x0, b = y0 * IW + x1, c = y1 * IW + x0, e = y1 * IW + x1;
        const n = cnt[e] - cnt[b] - cnt[c] + cnt[a];
        const bg = n > 20 ? (sum[e] - sum[b] - sum[c] + sum[a]) / n : paper;
        if (L[y * W + x] < bg * 0.84) ink[y * W + x] = 1;
      }
    }

    // --- 2) 연결 성분
    const label = new Int32Array(N), stack = new Int32Array(N), all = [null];
    let nid = 0;
    for (let i = 0; i < N; i++) {
      if (!ink[i] || label[i]) continue;
      const id = ++nid; let sp = 0; stack[sp++] = i; label[i] = id;
      let area = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, sl = 0, ml = 255;
      while (sp) {
        const p = stack[--sp], x = p % W, y = (p - x) / W;
        area++; const v = L[p]; sl += v; if (v < ml) ml = v;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx; if (nx < 0 || nx >= W) continue;
            const q = ny * W + nx;
            if (ink[q] && !label[q]) { label[q] = id; stack[sp++] = q; }
          }
        }
      }
      all.push({ id, area, x0, y0, x1, y1, sl, ml });
    }
    const minArea = Math.max(6, (N / 200000) | 0);
    const keep = new Uint8Array(nid + 1), comps = [];
    for (let id = 1; id <= nid; id++) {
      const c = all[id];
      if (c.area < minArea) continue;
      keep[id] = 1;
      c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1;
      c.tone = (c.ml * 0.5 + (c.sl / c.area) * 0.5) / paper;
      c.big = c.h > H * 0.12 || c.w > W * 0.5;
      c.hw = false;
      comps.push(c);
    }
    for (let i = 0; i < N; i++) if (label[i] && !keep[label[i]]) label[i] = 0;
    if (comps.length < 3) return { label, comps, regions: [], compRegion: new Int32Array(nid + 1).fill(-1), medH: 0, tref: 0 };

    // --- 3) 기준값: 인쇄 농도, 글자 높이
    const byTone = comps.slice().sort((a, b) => a.tone - b.tone);
    let totalArea = 0; for (const c of comps) totalArea += c.area;
    let acc = 0, tref = byTone[0].tone;
    for (const c of byTone) { acc += c.area; if (acc >= totalArea * 0.2) { tref = c.tone; break; } }
    const charLike = comps.filter((c) => !c.big && c.h >= 4);
    const medH = Math.max(6, median(charLike.map((c) => c.h)));

    // 단서 ① 농도
    for (const c of comps) if (c.tone > tref + dT) { c.hw = true; c.byTone = true; }

    // 단서 ② 배열 — 줄 단위로 묶어 규칙성 검사
    const gmap = groupComps(comps.filter((c) => !c.big), Math.round(medH * 1.5), Math.round(medH * 0.2));
    const groups = new Map();
    for (const c of comps) { if (c.big) continue; const g = gmap.get(c.id); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
    for (const mem of groups.values()) {
      const ch = mem.filter((c) => c.h >= medH * 0.45);
      if (ch.length < 3) continue;
      const sample = ch.length > 40 ? ch.filter((_, i) => i % Math.ceil(ch.length / 40) === 0) : ch;
      const slopes = [];
      for (let i = 0; i < sample.length; i++) for (let j = i + 1; j < sample.length; j++) {
        const dx = (sample[j].x0 + sample[j].x1) / 2 - (sample[i].x0 + sample[i].x1) / 2;
        if (Math.abs(dx) > 1) slopes.push((sample[j].y1 - sample[i].y1) / dx);
      }
      const slope = median(slopes);
      const bs = ch.map((c) => c.y1 - slope * ((c.x0 + c.x1) / 2));
      const b0 = median(bs);
      const baseDev = median(bs.map((v) => Math.abs(v - b0))) / medH;
      const hs = ch.map((c) => c.h), mh = hs.reduce((a, v) => a + v, 0) / hs.length;
      const hcv = Math.sqrt(hs.reduce((a, v) => a + (v - mh) * (v - mh), 0) / hs.length) / mh;
      if (baseDev > baseT || hcv > hcvT) {
        // 줄 전체가 아니라, 같은 줄의 "다수(인쇄)" 기준선·크기에서 벗어난 글자만 표시한다.
        const mhh = median(hs);
        const tol = Math.max(baseT, 0.12) * (o.tolMul || 1);
        if (baseDev > 0.5 * baseT) {
          // 줄 전체가 흔들리는 경우(순수 손글씨 줄): 전부 표시
          if (baseDev > baseT * (o.fullMul || 2.2) || hcv > hcvT * (o.fullMul ? o.fullMul * 0.75 : 1.6)) { for (const c of mem) c.hw = true; continue; }
        }
        for (const c of mem) {
          const res = Math.abs(c.y1 - slope * ((c.x0 + c.x1) / 2) - b0) / medH;
          const hr = c.h / mhh;
          if (res > tol || hr > (o.hrHi || 1.5) || hr < (o.hrLo || 0.55)) c.hw = true;
        }
      }
    }

    // --- 4) 확인용 "영역" 만들기 (+ 인쇄 줄에 드문드문 걸린 오탐 걸러내기)
    const base = comps.filter((c) => !c.big);
    function buildRegions() {
      const hwList = comps.filter((c) => c.hw);
      const compRegion = new Int32Array(nid + 1).fill(-1), regions = [];
      if (hwList.length) {
        const rmap = groupComps(hwList, Math.round(medH * 2), Math.round(medH * 0.8));
        const rid = new Map();
        for (const c of hwList) {
          const g = rmap.get(c.id);
          if (!rid.has(g)) { rid.set(g, regions.length); regions.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, n: 0, mem: [] }); }
          const r = regions[rid.get(g)];
          r.x0 = Math.min(r.x0, c.x0); r.y0 = Math.min(r.y0, c.y0); r.x1 = Math.max(r.x1, c.x1); r.y1 = Math.max(r.y1, c.y1);
          r.n++; r.mem.push(c); compRegion[c.id] = rid.get(g);
        }
      }
      return { compRegion, regions };
    }
    let built = buildRegions(), changed = false;
    for (const r of built.regions) {
      let total = 0;
      for (const c of base) {
        const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
        if (cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1) total++;
      }
      const frac = r.n / Math.max(1, total);
      if (frac < 0.5) for (const c of r.mem) if (!c.byTone) { c.hw = false; changed = true; }
    }
    if (changed) built = buildRegions();
    const compRegion = built.compRegion, regions = built.regions.map((r) => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, n: r.n }));
    return { label, comps, regions, compRegion, medH, tref };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(typeof self !== 'undefined' ? self : this);
