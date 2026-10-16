(() => {
  'use strict';

  const MAX_SRC = 2600;   // 원본 보관 최대 변(px)
  const MAX_WORK = 1800;  // 편집용 최대 변(px)
  const PAD = 18;         // 자르기 캔버스 안쪽 여백(손잡이가 잘리지 않도록)

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* =========================================================
   * 공통 UI
   * ========================================================= */
  const screens = { home: $('#screen-home'), crop: $('#screen-crop'), edit: $('#screen-edit') };
  const order = ['home', 'crop', 'edit'];
  let current = 'home';

  function go(name) {
    current = name;
    for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
    $('#btnBack').hidden = name === 'home';
    const idx = order.indexOf(name);
    $$('#steps li').forEach((li) => {
      const i = order.indexOf(li.dataset.step);
      li.classList.toggle('on', i === idx);
      li.classList.toggle('done', i < idx);
    });
    if (name === 'crop') requestAnimationFrame(() => { layoutCrop(); drawCrop(); });
    if (name === 'edit') requestAnimationFrame(layoutEdit);
  }

  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  const busy = (on) => { $('#busy').hidden = !on; };
  const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  /* =========================================================
   * 1) 사진 불러오기
   * ========================================================= */
  let srcCanvas = null;                       // 회전이 반영된 원본(최대 MAX_SRC)
  let crop = { x0: 0, y0: 0, x1: 1, y1: 1 }; // 0~1 비율

  function loadViaImg(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load')); };
      img.src = url;
    });
  }

  async function loadFile(file) {
    if (!file) return;
    busy(true);
    await nextPaint();
    try {
      let bmp;
      try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (_) { bmp = await loadViaImg(file); }
      const bw = bmp.width, bh = bmp.height;
      const s = Math.min(1, MAX_SRC / Math.max(bw, bh));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bw * s)); c.height = Math.max(1, Math.round(bh * s));
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      srcCanvas = c;
      crop = { x0: 0, y0: 0, x1: 1, y1: 1 };
      go('crop');
    } catch (err) {
      console.error(err);
      toast('사진을 열 수 없어요. JPG 또는 PNG 사진으로 다시 시도해 주세요.');
    } finally {
      busy(false);
    }
  }

  const fileCam = $('#fileCam'), fileGal = $('#fileGal');
  $('#btnCam').addEventListener('click', () => fileCam.click());
  $('#btnGallery').addEventListener('click', () => fileGal.click());
  for (const inp of [fileCam, fileGal]) {
    inp.addEventListener('change', () => { const f = inp.files && inp.files[0]; inp.value = ''; loadFile(f); });
  }
  // 데스크톱: 끌어다 놓기
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /^image\//.test(f.type)) loadFile(f);
  });

  // 홈 화면 데모
  $('#demoBtn').addEventListener('click', (e) => {
    const demo = e.currentTarget.closest('.demo');
    const on = demo.classList.toggle('cleaned');
    e.currentTarget.textContent = on ? '되돌리기' : '지워 보기';
    e.currentTarget.setAttribute('aria-pressed', String(on));
  });

  $('#btnBack').addEventListener('click', () => {
    if (current === 'edit') go('crop');
    else if (current === 'crop') go('home');
  });

  /* =========================================================
   * 2) 자르기
   * ========================================================= */
  const cropEl = $('#cropCanvas'), cropStage = $('#cropStage');
  let cl = { w: 0, h: 0 }; // 화면에 보이는 이미지 크기(css px)

  function layoutCrop() {
    if (!srcCanvas) return;
    const availW = Math.max(60, cropStage.clientWidth - 2 * PAD);
    const availH = Math.max(60, cropStage.clientHeight - 2 * PAD);
    const s = Math.min(availW / srcCanvas.width, availH / srcCanvas.height);
    cl.w = Math.floor(srcCanvas.width * s); cl.h = Math.floor(srcCanvas.height * s);
    const dpr = window.devicePixelRatio || 1;
    cropEl.style.width = (cl.w + 2 * PAD) + 'px';
    cropEl.style.height = (cl.h + 2 * PAD) + 'px';
    cropEl.width = Math.round((cl.w + 2 * PAD) * dpr);
    cropEl.height = Math.round((cl.h + 2 * PAD) * dpr);
  }

  const cropRectCss = () => ({
    x: PAD + crop.x0 * cl.w, y: PAD + crop.y0 * cl.h,
    w: (crop.x1 - crop.x0) * cl.w, h: (crop.y1 - crop.y0) * cl.h,
  });

  function handlePoints(r) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, x2 = r.x + r.w, y2 = r.y + r.h;
    return [
      { name: 'nw', x: r.x, y: r.y, big: 1 }, { name: 'ne', x: x2, y: r.y, big: 1 },
      { name: 'se', x: x2, y: y2, big: 1 }, { name: 'sw', x: r.x, y: y2, big: 1 },
      { name: 'n', x: cx, y: r.y }, { name: 'e', x: x2, y: cy },
      { name: 's', x: cx, y: y2 }, { name: 'w', x: r.x, y: cy },
    ];
  }

  function drawCrop() {
    if (!srcCanvas || !cl.w) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = cropEl.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cl.w + 2 * PAD, cl.h + 2 * PAD);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCanvas, PAD, PAD, cl.w, cl.h);
    const r = cropRectCss();
    ctx.fillStyle = 'rgba(16,36,59,.58)';
    ctx.beginPath(); ctx.rect(PAD, PAD, cl.w, cl.h); ctx.rect(r.x, r.y, r.w, r.h); ctx.fill('evenodd');
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo(r.x + (r.w * i) / 3, r.y); ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
      ctx.moveTo(r.x, r.y + (r.h * i) / 3); ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
    }
    ctx.stroke();
    for (const h of handlePoints(r)) {
      ctx.beginPath(); ctx.arc(h.x, h.y, h.big ? 9 : 6, 0, Math.PI * 2);
      ctx.fillStyle = h.big ? '#FFE066' : '#fff'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#10243B'; ctx.stroke();
    }
  }

  let cdrag = null;
  const cropPt = (e) => { const b = cropEl.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };

  cropEl.addEventListener('pointerdown', (e) => {
    if (!srcCanvas) return;
    const p = cropPt(e), r = cropRectCss();
    let hit = null, best = 30;
    for (const h of handlePoints(r)) {
      const d = Math.hypot(h.x - p.x, h.y - p.y);
      if (d < best) { best = d; hit = h.name; }
    }
    if (!hit && p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) hit = 'move';
    if (!hit) return;
    e.preventDefault();
    cdrag = { mode: hit, start: p, rect: r };
    cropEl.setPointerCapture(e.pointerId);
  });

  cropEl.addEventListener('pointermove', (e) => {
    if (!cdrag) return;
    const p = cropPt(e), dx = p.x - cdrag.start.x, dy = p.y - cdrag.start.y;
    const { x, y, w, h } = cdrag.rect;
    const L = PAD, T = PAD, R = PAD + cl.w, B = PAD + cl.h, MIN = 44;
    let x1 = x, y1 = y, x2 = x + w, y2 = y + h;
    const m = cdrag.mode;
    if (m === 'move') {
      const nx = clamp(x + dx, L, R - w), ny = clamp(y + dy, T, B - h);
      x1 = nx; y1 = ny; x2 = nx + w; y2 = ny + h;
    } else {
      if (m.includes('w')) x1 = clamp(x + dx, L, x2 - MIN);
      if (m.includes('e')) x2 = clamp(x + w + dx, x1 + MIN, R);
      if (m.includes('n')) y1 = clamp(y + dy, T, y2 - MIN);
      if (m.includes('s')) y2 = clamp(y + h + dy, y1 + MIN, B);
    }
    crop = { x0: (x1 - PAD) / cl.w, y0: (y1 - PAD) / cl.h, x1: (x2 - PAD) / cl.w, y1: (y2 - PAD) / cl.h };
    drawCrop();
  });
  const endCropDrag = () => { cdrag = null; };
  cropEl.addEventListener('pointerup', endCropDrag);
  cropEl.addEventListener('pointercancel', endCropDrag);

  $('#btnRotate').addEventListener('click', () => {
    if (!srcCanvas) return;
    const c = document.createElement('canvas');
    c.width = srcCanvas.height; c.height = srcCanvas.width;
    const x = c.getContext('2d');
    x.translate(c.width, 0); x.rotate(Math.PI / 2); x.drawImage(srcCanvas, 0, 0);
    srcCanvas = c;
    crop = { x0: 0, y0: 0, x1: 1, y1: 1 };
    layoutCrop(); drawCrop();
  });
  $('#btnCropReset').addEventListener('click', () => { crop = { x0: 0, y0: 0, x1: 1, y1: 1 }; drawCrop(); });
  $('#btnCropNext').addEventListener('click', startEdit);

  /* =========================================================
   * 3) 지우기
   * ========================================================= */
  const mainCanvas = $('#mainCanvas'), ovl = $('#ovlCanvas');
  const mainCtx = mainCanvas.getContext('2d'), ovlCtx = ovl.getContext('2d');
  const wrap = $('#canvasWrap'), editStage = $('#editStage');

  let W = 0, H = 0;
  let baseCanvas = null, baseData = null, resCanvas = null, resCtx = null;
  let A = null;                 // Engine.analyze 결과
  let manual = null;            // 직접 지운 영역 마스크
  let ops = [];                 // 직접 지우기 기록(되돌리기용)
  let inks = [];                // 선택한 글씨 색
  let zoom = 1;
  let showOrig = false;

  const opt = { red: true, sens: 55, tool: 'brush', brush: 10, inkAngle: 22, hwSens: 50 };
  let det = null, regionSel = [], detTried = false;   // 손글씨 자동 감지 결과
  const redT = () => Math.round(100 - opt.sens * 0.8);
  const dilR = () => Math.max(2, Math.round(Math.max(W, H) / 450));

  async function startEdit() {
    busy(true);
    await nextPaint();
    try {
      const sw = srcCanvas.width, sh = srcCanvas.height;
      const sx = Math.round(crop.x0 * sw), sy = Math.round(crop.y0 * sh);
      const cw = Math.max(1, Math.round((crop.x1 - crop.x0) * sw));
      const ch = Math.max(1, Math.round((crop.y1 - crop.y0) * sh));
      const s = Math.min(1, MAX_WORK / Math.max(cw, ch));
      W = Math.max(1, Math.round(cw * s)); H = Math.max(1, Math.round(ch * s));

      baseCanvas = document.createElement('canvas'); baseCanvas.width = W; baseCanvas.height = H;
      const bctx = baseCanvas.getContext('2d', { willReadFrequently: true });
      bctx.imageSmoothingQuality = 'high';
      bctx.drawImage(srcCanvas, sx, sy, cw, ch, 0, 0, W, H);
      baseData = bctx.getImageData(0, 0, W, H);

      resCanvas = document.createElement('canvas'); resCanvas.width = W; resCanvas.height = H;
      resCtx = resCanvas.getContext('2d');

      mainCanvas.width = ovl.width = W;
      mainCanvas.height = ovl.height = H;

      A = Engine.analyze(baseData.data, W, H);
      manual = new Uint8Array(W * H);
      ops = []; inks = []; zoom = 1; showOrig = false; det = null; regionSel = []; detTried = false;
      renderChips(); updateUndo(); updateZoomLabel();

      go('edit');
      doRender();
      toast('채점 표시를 지웠어요. 내 풀이는 아래 도구로 지워 보세요.', 3200);
    } catch (err) {
      console.error(err);
      toast('이미지를 처리하지 못했어요. 더 작은 사진으로 시도해 주세요.');
    } finally {
      busy(false);
    }
  }

  /* ----- 마스크 만들기 & 렌더링 ----- */
  function buildHole(skipDetect) {
    const N = W * H;
    const auto = new Uint8Array(N);
    let any = false;
    if (opt.red) {
      const T = redT(), rd = A.redD;
      for (let i = 0; i < N; i++) if (rd[i] > T) { auto[i] = 1; any = true; }
    }
    for (const ink of inks) { Engine.inkMask(auto, baseData.data, A, W, H, ink, opt.inkAngle); any = true; }
    const hole = any ? Engine.dilate(auto, W, H, dilR()) : auto;
    if (skipDetect) return hole;
    if (det && regionSel.some(Boolean)) {
      const hw = new Uint8Array(N), lab = det.label, cr = det.compRegion;
      for (let i = 0; i < N; i++) { const l = lab[i]; if (l && cr[l] >= 0 && regionSel[cr[l]]) hw[i] = 1; }
      const hwd = Engine.dilate(hw, W, H, dilR() + 1);
      for (let i = 0; i < N; i++) if (hwd[i]) hole[i] = 1;
    }
    if (ops.length) {
      const man = Engine.dilate(manual, W, H, 2);
      for (let i = 0; i < N; i++) if (man[i]) hole[i] = 1;
    }
    return hole;
  }

  function doRender() {
    const hole = buildHole();
    let any = false;
    for (let i = 0; i < hole.length; i++) if (hole[i]) { any = true; break; }
    const out = new ImageData(new Uint8ClampedArray(baseData.data), W, H);
    if (any) Engine.inpaint(out.data, W, H, hole, A.srcOK, 5);
    resCtx.putImageData(out, 0, 0);
    drawMain();
  }

  function drawMain() { mainCtx.drawImage(showOrig ? baseCanvas : resCanvas, 0, 0); }

  let renderTimer = 0;
  function scheduleRender(delay = 0) {
    clearTimeout(renderTimer);
    busy(true);
    renderTimer = setTimeout(async () => {
      await nextPaint();
      try { doRender(); } catch (err) { console.error(err); toast('처리 중 문제가 생겼어요.'); }
      busy(false);
    }, delay);
  }

  /* ----- 레이아웃 / 확대 ----- */
  function layoutEdit() {
    if (!W) return;
    const aw = Math.max(80, editStage.clientWidth - 24), ah = Math.max(80, editStage.clientHeight - 24);
    const fit = Math.min(aw / W, ah / H);
    const cssW = W * fit * zoom;
    wrap.style.width = cssW + 'px';
    wrap.style.height = (cssW * H / W) + 'px';
  }
  function updateZoomLabel() { $('#zoomVal').textContent = Math.round(zoom * 100) + '%'; }
  $('#zoomIn').addEventListener('click', () => { zoom = Math.min(4, +(zoom + 0.5).toFixed(1)); layoutEdit(); updateZoomLabel(); });
  $('#zoomOut').addEventListener('click', () => { zoom = Math.max(1, +(zoom - 0.5).toFixed(1)); layoutEdit(); updateZoomLabel(); });

  /* ----- 도구 선택 ----- */
  function setTool(t) {
    opt.tool = t;
    wrap.dataset.tool = t;
    $$('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tool === t)));
    for (const k of ['brush', 'rect', 'ink', 'auto', 'pan']) $('#opt-' + k).hidden = k !== t;
    drawRegions();
    if (t === 'auto' && W && !detTried) runDetect();
  }
  $$('.seg button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  $('#optRed').addEventListener('change', (e) => { opt.red = e.target.checked; scheduleRender(0); });
  $('#redSens').addEventListener('input', (e) => {
    opt.sens = +e.target.value;
    if (!opt.red) { opt.red = true; $('#optRed').checked = true; }
    scheduleRender(120);
  });
  $('#brushSize').addEventListener('input', (e) => { opt.brush = +e.target.value; });
  $('#inkAngle').addEventListener('input', (e) => { opt.inkAngle = +e.target.value; if (inks.length) scheduleRender(120); });

  /* ----- 손글씨 자동 감지 ----- */
  async function runDetect() {
    if (!W) return;
    detTried = true;
    busy(true); await nextPaint();
    try {
      const exclude = buildHole(true);           // 이미 지운 채점·글씨색은 종이로 취급
      det = Engine.detectHandwriting(baseData.data, W, H, A, exclude, { sens: opt.hwSens });
      regionSel = det.regions.map(() => true);
      $('#autoTip').textContent = det.regions.length
        ? `손글씨로 보이는 ${det.regions.length}곳을 지웠어요. 노란 칸이 지워진 부분이에요. 지우면 안 되는 칸은 탭해서 빼 주세요.`
        : '손글씨를 찾지 못했어요. 민감도를 올리거나 브러시·영역으로 직접 지워 주세요.';
      doRender();
      drawRegions();
    } catch (err) {
      console.error(err); toast('손글씨 감지 중 문제가 생겼어요.');
    } finally { busy(false); }
  }
  function drawRegions() {
    ovlCtx.clearRect(0, 0, W || 1, H || 1);
    if (!det || opt.tool !== 'auto') return;
    const pad = Math.max(4, Math.round(det.medH * 0.4)), lw = Math.max(2, W / 350);
    det.regions.forEach((r, i) => {
      const x = r.x0 - pad, y = r.y0 - pad, w = r.x1 - r.x0 + 2 * pad, h = r.y1 - r.y0 + 2 * pad;
      ovlCtx.lineWidth = lw;
      if (regionSel[i]) {
        ovlCtx.fillStyle = 'rgba(255, 196, 0, 0.32)'; ovlCtx.fillRect(x, y, w, h);
        ovlCtx.setLineDash([]); ovlCtx.strokeStyle = '#10243B';
      } else {
        ovlCtx.setLineDash([lw * 3, lw * 2]); ovlCtx.strokeStyle = '#C8372D';
      }
      ovlCtx.strokeRect(x, y, w, h);
    });
    ovlCtx.setLineDash([]);
  }
  function toggleRegionAt(p) {
    if (!det) return;
    const pad = Math.max(4, Math.round(det.medH * 0.4));
    let best = -1, bestA = Infinity;
    det.regions.forEach((r, i) => {
      if (p.x >= r.x0 - pad && p.x <= r.x1 + pad && p.y >= r.y0 - pad && p.y <= r.y1 + pad) {
        const ar = (r.x1 - r.x0) * (r.y1 - r.y0);
        if (ar < bestA) { bestA = ar; best = i; }
      }
    });
    if (best < 0) return;
    regionSel[best] = !regionSel[best];
    drawRegions(); scheduleRender(0);
  }
  $('#btnDetect').addEventListener('click', runDetect);
  $('#btnDetectClear').addEventListener('click', () => { det = null; regionSel = []; detTried = true; drawRegions(); scheduleRender(0); $('#autoTip').textContent = '자동 감지를 취소했어요. "다시 찾기"로 다시 시도할 수 있어요.'; });
  $('#hwSens').addEventListener('input', (e) => { opt.hwSens = +e.target.value; });
  $('#hwSens').addEventListener('change', runDetect);

  /* ----- 직접 지우기 (브러시 / 영역) ----- */
  const brushR = () => Math.max(2, (opt.brush * W) / 400);
  const imgPt = (e) => {
    const b = ovl.getBoundingClientRect();
    return { x: ((e.clientX - b.left) * W) / b.width, y: ((e.clientY - b.top) * H) / b.height };
  };

  function stampDisk(cx, cy, r) {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) { const dx = x - cx; if (dx * dx + dy * dy <= r2) manual[y * W + x] = 1; }
    }
  }
  function stampOp(op) {
    if (op.t === 'b') {
      const pts = op.pts;
      stampDisk(pts[0].x, pts[0].y, op.r);
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k];
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const step = Math.max(1, op.r / 3), n = Math.ceil(dist / step);
        for (let i = 1; i <= n; i++) stampDisk(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n, op.r);
      }
    } else {
      const x0 = Math.max(0, Math.floor(op.x0)), x1 = Math.min(W - 1, Math.ceil(op.x1));
      const y0 = Math.max(0, Math.floor(op.y0)), y1 = Math.min(H - 1, Math.ceil(op.y1));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) manual[y * W + x] = 1;
    }
  }
  function updateUndo() { $('#btnUndo').disabled = ops.length === 0; }

  const PREVIEW = 'rgba(255, 196, 0, 0.5)';
  let stroke = null;

  ovl.addEventListener('pointerdown', (e) => {
    if (!W || opt.tool === 'pan') return;
    e.preventDefault();
    const p = imgPt(e);
    if (opt.tool === 'ink') { pickInk(p.x, p.y); return; }
    if (opt.tool === 'auto') { toggleRegionAt(p); return; }
    ovl.setPointerCapture(e.pointerId);
    stroke = { tool: opt.tool, pts: [p], start: p, cur: p, r: brushR() };
    if (stroke.tool === 'brush') {
      ovlCtx.fillStyle = PREVIEW;
      ovlCtx.beginPath(); ovlCtx.arc(p.x, p.y, stroke.r, 0, Math.PI * 2); ovlCtx.fill();
    }
  });

  ovl.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const p = imgPt(e);
    if (stroke.tool === 'brush') {
      const last = stroke.pts[stroke.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 1) return;
      stroke.pts.push(p);
      ovlCtx.strokeStyle = PREVIEW; ovlCtx.lineWidth = stroke.r * 2; ovlCtx.lineCap = 'round';
      ovlCtx.beginPath(); ovlCtx.moveTo(last.x, last.y); ovlCtx.lineTo(p.x, p.y); ovlCtx.stroke();
    } else {
      stroke.cur = p;
      ovlCtx.clearRect(0, 0, W, H);
      const x = Math.min(stroke.start.x, p.x), y = Math.min(stroke.start.y, p.y);
      const w = Math.abs(p.x - stroke.start.x), h = Math.abs(p.y - stroke.start.y);
      ovlCtx.fillStyle = PREVIEW; ovlCtx.fillRect(x, y, w, h);
      ovlCtx.strokeStyle = '#10243B'; ovlCtx.lineWidth = Math.max(2, W / 400);
      ovlCtx.setLineDash([W / 100, W / 160]); ovlCtx.strokeRect(x, y, w, h); ovlCtx.setLineDash([]);
    }
  });

  function endStroke(commit) {
    if (!stroke) return;
    const s = stroke; stroke = null;
    ovlCtx.clearRect(0, 0, W, H);
    if (!commit) return;
    let op = null;
    if (s.tool === 'brush') op = { t: 'b', r: s.r, pts: s.pts };
    else {
      const x0 = Math.min(s.start.x, s.cur.x), x1 = Math.max(s.start.x, s.cur.x);
      const y0 = Math.min(s.start.y, s.cur.y), y1 = Math.max(s.start.y, s.cur.y);
      if (x1 - x0 < 4 || y1 - y0 < 4) return;
      op = { t: 'r', x0, y0, x1, y1 };
    }
    ops.push(op); stampOp(op); updateUndo(); scheduleRender(0);
  }
  ovl.addEventListener('pointerup', () => endStroke(true));
  ovl.addEventListener('pointercancel', () => endStroke(false));

  $('#btnUndo').addEventListener('click', () => {
    if (!ops.length) return;
    ops.pop(); manual.fill(0); ops.forEach(stampOp);
    updateUndo(); scheduleRender(0);
  });

  /* ----- 글씨 색 고르기 ----- */
  function pickInk(x, y) {
    const R = Math.max(4, Math.round(W / 250));
    const ink = Engine.sampleInk(baseData.data, W, H, x, y, R);
    if (!ink) { toast('이 부분은 색이 거의 없어요. 펜 글씨 위를 탭하거나, 검정·연필은 브러시를 쓰세요.', 3400); return; }
    const [cx, cy, cz] = ink.c;
    const n = Math.hypot(cx, cy, cz);
    for (const o of inks) {
      const on = Math.hypot(o.c[0], o.c[1], o.c[2]);
      if ((cx * o.c[0] + cy * o.c[1] + cz * o.c[2]) / (n * on) > 0.97) { toast('이미 선택한 색이에요.'); return; }
    }
    if (inks.length >= 5) { toast('색은 최대 5개까지 고를 수 있어요. 선택한 색을 눌러 빼 주세요.'); return; }
    inks.push(ink); renderChips(); scheduleRender(0);
  }
  function renderChips() {
    const box = $('#inkChips'); box.textContent = '';
    inks.forEach((ink, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip';
      b.style.background = `rgb(${ink.rgb[0]},${ink.rgb[1]},${ink.rgb[2]})`;
      b.setAttribute('aria-label', '선택한 색 ' + (i + 1) + ' 빼기');
      b.addEventListener('click', () => { inks.splice(i, 1); renderChips(); scheduleRender(0); });
      box.appendChild(b);
    });
  }

  /* ----- 원본 보기 (누르는 동안) ----- */
  const btnOrig = $('#btnOrig');
  const holdOn = (e) => { e.preventDefault(); showOrig = true; drawMain(); };
  const holdOff = () => { if (showOrig) { showOrig = false; drawMain(); } };
  btnOrig.addEventListener('pointerdown', holdOn);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btnOrig.addEventListener(ev, holdOff);
  btnOrig.addEventListener('contextmenu', (e) => e.preventDefault());

  /* =========================================================
   * 4) 저장
   * ========================================================= */
  const dlg = $('#saveDlg');
  let saveBlob = null, saveUrl = null;
  const stamp = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };
  const fileName = () => `odap-${stamp()}.png`;
  const canShareFiles = () => {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'a.png', { type: 'image/png' })] })); }
    catch (_) { return false; }
  };

  $('#btnSave').addEventListener('click', () => {
    clearTimeout(renderTimer);
    resCanvas.toBlob((blob) => {
      if (!blob) { toast('이미지를 만들지 못했어요.'); return; }
      saveBlob = blob;
      if (saveUrl) URL.revokeObjectURL(saveUrl);
      saveUrl = URL.createObjectURL(blob);
      $('#savePrev').src = saveUrl;
      $('#btnShare').hidden = !canShareFiles();
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    }, 'image/png');
  });

  $('#btnDownload').addEventListener('click', () => {
    if (!saveUrl) return;
    const a = document.createElement('a');
    a.href = saveUrl; a.download = fileName();
    document.body.appendChild(a); a.click(); a.remove();
    toast('이미지를 저장했어요.');
  });
  $('#btnShare').addEventListener('click', async () => {
    if (!saveBlob) return;
    try { await navigator.share({ files: [new File([saveBlob], fileName(), { type: 'image/png' })], title: '오답노트' }); }
    catch (_) { /* 사용자가 취소 */ }
  });
  const closeDlg = () => { if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); };
  $('#btnCloseDlg').addEventListener('click', closeDlg);
  $('#btnNew').addEventListener('click', () => { closeDlg(); go('home'); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDlg(); });

  /* =========================================================
   * 5) 창 크기 변화 / PWA 설치 / 서비스 워커
   * ========================================================= */
  let rz = 0;
  addEventListener('resize', () => {
    clearTimeout(rz);
    rz = setTimeout(() => {
      if (current === 'crop') { layoutCrop(); drawCrop(); }
      if (current === 'edit') layoutEdit();
    }, 80);
  });

  let deferredInstall = null;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredInstall = e; $('#btnInstall').hidden = false;
  });
  $('#btnInstall').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (_) {}
    deferredInstall = null; $('#btnInstall').hidden = true;
  });
  addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; });

  const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS && !isStandalone) $('#iosHint').hidden = false;

  if ('serviceWorker' in navigator) {
    addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW 등록 실패', e)); });
  }

  setTool('brush');
  go('home');
})();
