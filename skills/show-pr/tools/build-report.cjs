const fs = require('fs');
const path = require('path');

const [, , graphFile = '.show-pr/graph.zh.json', outFile = '.show-pr/report.html'] = process.argv;
const doc = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const docJson = JSON.stringify(doc).replace(/</g, '\\u003c');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const evidenceJson = JSON.stringify(
  (doc.evidence || []).map(function (ev) {
    const abs = path.resolve(path.dirname(path.resolve(graphFile)), ev.path);
    const ext = ev.path.split('.').pop().toLowerCase();
    const dataUri = 'data:' + (MIME[ext] || 'application/octet-stream') + ';base64,' + fs.readFileSync(abs).toString('base64');
    return Object.assign({}, ev, { dataUri: dataUri });
  })
).replace(/</g, '\\u003c');

const hasMermaid = Array.isArray(doc.mermaid) && doc.mermaid.length > 0;
const mermaidBundle = hasMermaid
  ? fs.readFileSync(path.join(__dirname, 'vendor', 'mermaid.min.js'), 'utf8').replace(/<\/script>/gi, '<\\/script>')
  : '';
const mermaidBootstrap = hasMermaid
  ? "<script>try{mermaid.initialize({startOnLoad:false,theme:'dark',securityLevel:'loose',fontFamily:'-apple-system,PingFang SC,Microsoft YaHei,sans-serif'});mermaid.init();}catch(e){document.querySelectorAll('.mermaid').forEach(function(d){if(!d.querySelector('svg'))d.textContent='Mermaid \u6e32\u67d3\u5931\u8d25\uff1a'+e.message;});}</script>"
  : '';

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${doc.title}</title>
<style>
  :root {
    --bg: #0b0e14; --surface: #131720; --surface2: #0f141d; --border: #263143;
    --text: #e6eaf2; --sub: #9aa6b8; --faint: #64748b;
    --hero: #818cf8; --added: #22c55e; --modified: #eab308; --removed: #ef4444; --unchanged: #64748b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif; }
  header { padding: 26px 36px 18px; border-bottom: 1px solid var(--border); }
  h1 { font-size: 19px; margin: 0 0 8px; }
  .summary { font-size: 13px; color: var(--sub); max-width: 1050px; line-height: 1.55; margin: 0 0 14px; }
  .meta { font-size: 11px; color: var(--faint); margin-top: 12px; font-family: ui-monospace, monospace; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; }
  .chip { border: 1px solid; border-radius: 8px; padding: 4px 12px; font-size: 11.5px; }
  .chip b { font-weight: 600; margin-left: 6px; }
  .chip.hero { border-color: var(--hero); color: #c7d2fe; }
  .chip.added { border-color: var(--added); color: #86efac; }
  .chip.modified { border-color: var(--modified); color: #fde047; }
  .chip.removed { border-color: var(--removed); color: #fca5a5; }
  .chip.neutral { border-color: var(--border); color: var(--sub); }

  nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 36px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 5; }
  .vbtn { padding: 6px 13px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: #cbd5e1; font-size: 12px; cursor: pointer; }
  .vbtn:hover { border-color: #3b4c66; }
  .vbtn.active { border-color: var(--hero); color: #c7d2fe; background: #1a2030; }
  .vbtn.child { margin-left: 16px; font-size: 11px; padding: 5px 11px; }

  main { display: flex; align-items: flex-start; }
  aside { width: 330px; flex-shrink: 0; border-right: 1px solid var(--border); padding: 18px 20px 40px; position: sticky; top: 57px; max-height: calc(100vh - 57px); overflow-y: auto; }
  aside h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--faint); margin: 0 0 12px; }
  .wcontrols { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .wbtn { border: 1px solid var(--border); background: var(--surface); color: #cbd5e1; border-radius: 8px; padding: 5px 12px; cursor: pointer; font-size: 13px; }
  .wbtn:hover { border-color: #3b4c66; }
  .wcount { font-size: 11px; color: var(--faint); font-family: ui-monospace, monospace; }
  .step { padding: 11px 14px; border: 1px solid var(--border); border-radius: 10px; margin-bottom: 10px; cursor: pointer; background: var(--surface2); }
  .step:hover { border-color: #3b4c66; }
  .step.active { border-color: var(--hero); background: #141b29; }
  .step .no { font-size: 10px; color: var(--faint); font-family: ui-monospace, monospace; }
  .step h3 { font-size: 13px; margin: 4px 0 6px; font-weight: 600; }
  .step p { font-size: 11.5px; color: var(--sub); margin: 0; line-height: 1.5; }

  #stage { flex: 1; min-width: 0; overflow: auto; padding: 22px 30px 70px; }
  .diagram { display: none; }
  .diagram.on { display: block; }
  .dcaption { margin-bottom: 6px; }
  .dcaption h2 { font-size: 15px; margin: 0 0 4px; }
  .dcaption p { font-size: 12px; color: var(--sub); margin: 0 0 14px; }
  .dg { transition: opacity .25s; }
  .dim { opacity: .12; }
  .edge-label { font-size: 9.5px; paint-order: stroke; stroke: var(--bg); stroke-width: 5px; fill: #b9c3d3; }
  .edge-label.hero { fill: #c7d2fe; font-weight: 600; }
  .lane-title { font-size: 12px; font-weight: 700; fill: #dbe3f0; }
  .lane-sub { font-size: 10px; fill: var(--faint); }
  .node-label { font-size: 12.5px; font-weight: 600; fill: var(--text); }
  .node-sub { font-size: 10px; fill: var(--sub); }
  .node-group { font-size: 8.5px; fill: var(--faint); letter-spacing: .05em; text-transform: uppercase; }
  .node-delta { font-size: 8px; font-weight: 700; letter-spacing: .04em; }
  .flow-part { font-size: 11.5px; font-weight: 600; fill: var(--text); }
  .flow-msg { font-size: 10px; paint-order: stroke; stroke: var(--bg); stroke-width: 5px; fill: #b9c3d3; }
  .flow-note { font-size: 9px; fill: #8a94a6; font-style: italic; paint-order: stroke; stroke: var(--bg); stroke-width: 4px; }
  .anim-dash { animation: dashmove 1.1s linear infinite; }
  @keyframes dashmove { to { stroke-dashoffset: -24; } }

  .legend { display: flex; flex-wrap: wrap; gap: 18px; padding: 12px 36px; font-size: 11px; color: #7d8aa0; border-top: 1px solid var(--border); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }

  /* ---------- report sections (stacked below the diagrams) ---------- */
  #sections { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 18px; }
  .report-sec { margin-bottom: 34px; max-width: 1080px; }
  .report-sec > h2 { font-size: 15px; margin: 0 0 4px; }
  .report-sec > .phint { margin: 0 0 14px; }
  .rcard { border: 1px solid var(--border); background: var(--surface2); border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; max-width: 880px; }
  .rtitle { font-size: 14px; margin: 0 0 6px; font-weight: 600; }
  .rsummary { font-size: 12.5px; color: var(--sub); line-height: 1.65; margin: 0 0 10px; white-space: pre-wrap; }
  .rnote { font-size: 12px; color: var(--sub); margin: 8px 0 0; line-height: 1.65; }
  .rresult { font-size: 12.5px; color: #86efac; margin: 8px 0 0; line-height: 1.6; }
  .rresult b { font-weight: 600; }
  .phint { font-size: 12px; color: var(--faint); margin: 0 0 14px; }
  .cmd { font-family: ui-monospace, monospace; font-size: 12px; background: #0d1119; border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; color: #a5d6ff; overflow-x: auto; margin: 8px 0; }
  .log { font-family: ui-monospace, monospace; font-size: 11.5px; background: #0d1119; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; color: #9fb0c8; white-space: pre-wrap; max-height: 420px; overflow: auto; margin: 8px 0; }
  .lhead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .exit { font-family: ui-monospace, monospace; font-size: 11px; border-radius: 7px; padding: 2px 10px; border: 1px solid; flex-shrink: 0; }
  .exit.ok { color: #86efac; border-color: var(--added); }
  .exit.fail { color: #fca5a5; border-color: var(--removed); }
  .step-card { position: relative; padding-left: 56px; }
  .rno { position: absolute; left: 18px; top: 16px; font-family: ui-monospace, monospace; font-size: 11px; color: var(--faint); }
  .shot { max-width: 100%; border-radius: 8px; border: 1px solid var(--border); display: block; }
  .page video { max-width: 100%; border-radius: 8px; border: 1px solid var(--border); display: block; }  .opts { list-style: none; padding: 0; margin: 4px 0 10px; }
  .opts li { font-size: 12.5px; color: var(--sub); padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; }
  .opts li.chosen { border-color: var(--hero); color: #c7d2fe; background: #141b29; }
  .chiptag { font-size: 10px; color: var(--hero); margin-left: 8px; }
  .expected { font-size: 12.5px; color: #86efac; margin: 8px 0 0; line-height: 1.6; }
  .mermaid { background: #0d1119; border: 1px solid var(--border); border-radius: 10px; padding: 14px; overflow-x: auto; text-align: center; color: var(--text); }
</style>
</head>
<body>
<header>
  <h1></h1>
  <p class="summary"></p>
  <div class="chips" id="chips"></div>
  <div class="meta" id="meta"></div>
</header>
<nav id="nav"></nav>
<main>
  <aside>
    <h2>导览</h2>
    <div class="wcontrols">
      <button class="wbtn" id="wprev">&lsaquo; 上一步</button>
      <button class="wbtn" id="wnext">下一步 &rsaquo;</button>
      <span class="wcount" id="wcount"></span>
    </div>
    <div id="steps"></div>
  </aside>
  <section id="stage">
    <div class="diagram" id="arch">
      <div class="dcaption"><h2 id="archTitle"></h2><p id="archSummary"></p></div>
      <div id="archHolder"></div>
    </div>
    <div id="flowHolder"></div>
    <div id="sections"></div>
  </section>
</main>
<div class="legend">
  <span><i class="dot" style="background:var(--added)"></i>新增</span>
  <span><i class="dot" style="background:var(--modified)"></i>修改</span>
  <span><i class="dot" style="background:var(--removed)"></i>移除</span>
  <span><i class="dot" style="background:var(--unchanged)"></i>未变</span>
  <span><svg width="34" height="10"><line x1="0" y1="5" x2="34" y2="5" stroke="var(--hero)" stroke-width="2.6"/></svg>hero 边</span>
  <span><svg width="34" height="10"><line x1="0" y1="5" x2="34" y2="5" stroke="var(--removed)" stroke-width="1.4" stroke-dasharray="5 4"/></svg>已移除的边</span>
  <span>点击导览步骤可聚焦对应变更 &middot; 方向键切换</span>
</div>
${mermaidBundle ? '<script>' + mermaidBundle + '</script>' : ''}
<script>
const EVIDENCE = ${evidenceJson};
const DOC = ${docJson};

const DELTA = { added: '#22c55e', modified: '#eab308', removed: '#ef4444', unchanged: '#64748b' };
const DELTA_TEXT = { added: '新增', modified: '修改', removed: '移除', unchanged: '未变' };
const DELTA_W = 10;
const HERO = '#818cf8';
const BG = '#0b0e14', SURFACE = '#131720', BORDER = '#263143';

const nodesById = {}; DOC.nodes.forEach(function (n) { nodesById[n.id] = n; });

function trunc(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '\\u2026' : (s || ''); }
function svgEl(tag, attrs, parent) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}
function textEl(parent, x, y, cls, str, anchor) {
  const t = svgEl('text', { x: x, y: y, 'class': cls }, parent);
  if (anchor) t.setAttribute('text-anchor', anchor);
  t.textContent = str;
  return t;
}

/* ---------- header ---------- */
document.querySelector('h1').textContent = DOC.title;
document.querySelector('.summary').textContent = DOC.summary;
const chipsEl = document.getElementById('chips');
DOC.stats.chips.forEach(function (c) {
  const d = document.createElement('div');
  d.className = 'chip ' + c.tone;
  d.innerHTML = c.label + '<b></b>';
  d.querySelector('b').textContent = c.value;
  chipsEl.appendChild(d);
});
document.getElementById('meta').textContent =
  DOC.provenance.repo.host + ':' + DOC.provenance.repo.owner + '/' + DOC.provenance.repo.name +
  '  \\u00b7  base ' + DOC.provenance.base.sha.slice(0, 8) + ' \\u2192 head ' + DOC.provenance.head.sha.slice(0, 8) +
  '  \\u00b7  ' + DOC.stats.filesChanged + ' 个文件  +' + DOC.stats.additions + ' / -' + DOC.stats.deletions;

/* ---------- architecture diagram ---------- */
const CARD_W = 232, V_GAP = 26, LANE_GAP = 98, PAD_X = 40, PAD_Y = 76;
const lanes = DOC.lanes.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
const laneIdx = {}; lanes.forEach(function (l, i) { laneIdx[l.id] = i; });

const laneNodes = {};
DOC.nodes.forEach(function (n) { (laneNodes[n.lane] = laneNodes[n.lane] || []).push(n); });

const pos = {};
let maxH = 0;
lanes.forEach(function (l, li) {
  let y = PAD_Y;
  (laneNodes[l.id] || []).forEach(function (n) {
    const h = 44 + (n.group ? 14 : 0) + (n.subtitle ? 16 : 0);
    pos[n.id] = { x: PAD_X + li * (CARD_W + LANE_GAP), y: y, w: CARD_W, h: h, cx: PAD_X + li * (CARD_W + LANE_GAP) + CARD_W / 2, cy: y + h / 2, laneIdx: li };
    y += h + V_GAP;
  });
  maxH = Math.max(maxH, y);
});
const ARCH_W = PAD_X * 2 + lanes.length * CARD_W + (lanes.length - 1) * LANE_GAP + 20;
const ARCH_H = maxH + 30;

const archSvg = svgEl('svg', { width: ARCH_W, height: ARCH_H, viewBox: '0 0 ' + ARCH_W + ' ' + ARCH_H, style: 'max-width:none' });
document.getElementById('archHolder').appendChild(archSvg);

const defs = svgEl('defs', {}, archSvg);
Object.keys(DELTA).forEach(function (d) {
  const mk = svgEl('marker', { id: 'ah-' + d, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
  svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: DELTA[d] }, mk);
});
const mkHero = svgEl('marker', { id: 'ah-hero', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7.5, markerHeight: 7.5, orient: 'auto-start-reverse' }, defs);
svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: HERO }, mkHero);

lanes.forEach(function (l, li) {
  const x = PAD_X + li * (CARD_W + LANE_GAP) - 16;
  const band = svgEl('g', { 'class': 'dg' }, archSvg);
  svgEl('rect', { x: x, y: 34, width: CARD_W + 32, height: ARCH_H - 50, rx: 14, fill: '#0e121b', stroke: '#1c2534' }, band);
  textEl(band, x + 16, 54, 'lane-title', l.label);
  if (l.subtitle) textEl(band, x + 16, 68, 'lane-sub', l.subtitle + ' \\u00b7 ' + (laneNodes[l.id] || []).length + ' 个部件');
});

const edgeLayer = svgEl('g', {}, archSvg);
const nodeLayer = svgEl('g', {}, archSvg);
const edgePaths = [];

DOC.edges.forEach(function (e, i) {
  const a = pos[e.from], b = pos[e.to];
  let d;
  if (a.laneIdx === b.laneIdx) {
    const down = b.y > a.y;
    const off = 16 * (i % 2 ? 1 : -1);
    const sx = a.cx + off, sy = down ? a.y + a.h : a.y;
    const tx = b.cx + off, ty = down ? b.y : b.y + b.h;
    const d1 = down ? 48 : -48;
    d = 'M' + sx + ',' + sy + ' C' + sx + ',' + (sy + d1) + ' ' + tx + ',' + (ty - d1) + ' ' + tx + ',' + ty;
  } else {
    const forward = b.laneIdx > a.laneIdx;
    const sx = forward ? a.x + a.w : a.x, sy = a.cy;
    const tx = forward ? b.x : b.x + b.w, ty = b.cy;
    const dx = Math.min(92, Math.abs(tx - sx) * 0.45);
    d = 'M' + sx + ',' + sy + ' C' + (sx + (forward ? dx : -dx)) + ',' + sy + ' ' + (tx + (forward ? -dx : dx)) + ',' + ty + ' ' + tx + ',' + ty;
  }
  const isHero = e.emphasis === 'hero';
  const color = isHero ? HERO : DELTA[e.delta];
  const g = svgEl('g', { id: 'edge-' + e.id, 'class': 'dg', 'data-focusable': '1' }, edgeLayer);
  const attrs = { d: d, fill: 'none', stroke: color, 'stroke-width': isHero ? 2.6 : 1.4, opacity: e.delta === 'unchanged' ? 0.55 : 0.9 };
  if (e.delta === 'removed') attrs['stroke-dasharray'] = '5 4';
  if (e.animated && e.delta !== 'removed') { attrs['stroke-dasharray'] = '8 5'; attrs['class'] = 'anim-dash'; }
  attrs['marker-end'] = 'url(#ah-' + (isHero ? 'hero' : e.delta) + ')';
  const p = svgEl('path', attrs, g);
  if (e.label) edgePaths.push({ g: g, path: p, label: e.label, hero: isHero, color: color });
});

edgePaths.forEach(function (ep) {
  const len = ep.path.getTotalLength();
  const pt = ep.path.getPointAtLength(len * 0.5);
  const t = textEl(ep.g, pt.x, pt.y - 7, 'edge-label' + (ep.hero ? ' hero' : ''), ep.label, 'middle');
});

DOC.nodes.forEach(function (n) {
  const P = pos[n.id];
  const g = svgEl('g', { id: 'node-' + n.id, 'class': 'dg', 'data-focusable': '1' }, nodeLayer);
  const tip = svgEl('title', {}, g);
  tip.textContent = n.summary + (n.files.length ? '\\n\\n文件：\\n' + n.files.map(function (f) { return f.path + (f.startLine ? ':' + f.startLine : ''); }).join('\\n') : '');
  svgEl('rect', { x: P.x, y: P.y, width: P.w, height: P.h, rx: 10, fill: SURFACE, stroke: DELTA[n.delta], 'stroke-opacity': n.delta === 'unchanged' ? 0.35 : 0.6, 'stroke-width': 1.2, 'stroke-dasharray': n.delta === 'removed' ? '4 3' : 'none' }, g);
  svgEl('rect', { x: P.x, y: P.y + 8, width: 3.5, height: P.h - 16, rx: 1.5, fill: DELTA[n.delta] }, g);
  let ty = P.y + 22;
  if (n.group) { textEl(g, P.x + 12, ty, 'node-group', trunc(n.group, 26)); ty += 15; }
  textEl(g, P.x + 12, ty + 2, 'node-label', trunc(n.label, 28));
  ty += 17;
  if (n.subtitle) textEl(g, P.x + 12, ty + 2, 'node-sub', trunc(n.subtitle, 36));
  const dtext = DELTA_TEXT[n.delta] || n.delta;
  const dw = dtext.length * DELTA_W + 12;
  svgEl('rect', { x: P.x + P.w - dw - 8, y: P.y + 7, width: dw, height: 14, rx: 7, fill: DELTA[n.delta], 'fill-opacity': 0.16, stroke: DELTA[n.delta], 'stroke-opacity': 0.55 }, g);
  const dt = textEl(g, P.x + P.w - 8 - dw / 2, P.y + 17.5, 'node-delta', dtext, 'middle');
  dt.setAttribute('fill', DELTA[n.delta]);
});

/* ---------- flow diagrams ---------- */
const flowSvgs = {};
const flowHolder = document.getElementById('flowHolder');
DOC.flows.forEach(function (fl) {
  const wrap = document.createElement('div');
  wrap.className = 'diagram';
  wrap.id = 'flow-diagram-' + fl.id;
  const cap = document.createElement('div');
  cap.className = 'dcaption';
  cap.innerHTML = '<h2></h2><p></p>';
  cap.querySelector('h2').textContent = fl.title;
  cap.querySelector('p').textContent = fl.summary || '';
  wrap.appendChild(cap);
  flowHolder.appendChild(wrap);

  const PW = 150, PGAP = 46, SX = 34, HEAD = 48, STEP = 50, TOP = 122;
  const W = SX * 2 + fl.participants.length * PW + (fl.participants.length - 1) * PGAP;
  const H = TOP + fl.messages.length * STEP + 56;
  const svg = svgEl('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, style: 'max-width:none' });
  wrap.appendChild(svg);
  flowSvgs[fl.id] = wrap;

  const defs2 = svgEl('defs', {}, svg);
  Object.keys(DELTA).forEach(function (d) {
    ['f', 'o'].forEach(function (style) {
      const mk = svgEl('marker', { id: 'fm-' + style + '-' + d + '-' + fl.id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs2);
      svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: style === 'f' ? DELTA[d] : 'none', stroke: DELTA[d], 'stroke-width': style === 'o' ? 1.4 : 0 }, mk);
    });
  });

  const px = [];
  fl.participants.forEach(function (p, i) {
    px[i] = SX + i * (PW + PGAP) + PW / 2;
    const nd = nodesById[p.node];
    const g = svgEl('g', { 'class': 'dg' }, svg);
    svgEl('rect', { x: px[i] - PW / 2, y: HEAD - 30, width: PW, height: 42, rx: 9, fill: SURFACE, stroke: DELTA[nd.delta], 'stroke-opacity': 0.6 }, g);
    textEl(g, px[i], HEAD - 13, 'flow-part', trunc(p.label || nd.label, 19), 'middle');
    svgEl('circle', { cx: px[i] - PW / 2 + 10, cy: HEAD - 9, r: 3, fill: DELTA[nd.delta] }, g);
    svgEl('line', { x1: px[i], y1: HEAD + 12, x2: px[i], y2: H - 40, stroke: '#243044', 'stroke-dasharray': '3 5' }, svg);
  });

  fl.messages.forEach(function (m, i) {
    const y = TOP + i * STEP;
    const fi = fl.participants.findIndex(function (p) { return p.node === m.from; });
    const ti = fl.participants.findIndex(function (p) { return p.node === m.to; });
    const color = DELTA[m.delta];
    const g = svgEl('g', { id: 'fm-' + fl.id + '-' + m.id, 'class': 'dg', 'data-focusable': '1' }, svg);
    const label = m.label + (m.repeat ? ' \\u00d7' + m.repeat : '');
    if (m.kind === 'self') {
      svgEl('path', { d: 'M' + px[fi] + ',' + (y - 6) + ' c 34 0, 34 40, 0 40', fill: 'none', stroke: color, 'stroke-width': 1.4, 'marker-end': 'url(#fm-f-' + m.delta + '-' + fl.id + ')' }, g);
      textEl(g, px[fi] + 14, y + 10, 'flow-msg', trunc(label, 44));
      if (m.note) textEl(g, px[fi] + 14, y + 23, 'flow-note', trunc(m.note, 60));
    } else {
      const attrs = { x1: px[fi], y1: y, x2: px[ti], y2: y, stroke: color, 'stroke-width': 1.5, 'marker-end': 'url(#fm-' + (m.kind === 'return' ? 'o' : 'f') + '-' + m.delta + '-' + fl.id + ')' };
      if (m.kind === 'async') attrs['stroke-dasharray'] = '7 4';
      if (m.kind === 'return') attrs['stroke-dasharray'] = '3 3';
      svgEl('line', attrs, g);
      const mid = (px[fi] + px[ti]) / 2;
      textEl(g, mid, y - 9, 'flow-msg', trunc(label, 42), 'middle');
      if (m.note) textEl(g, mid, y + 16, 'flow-note', trunc(m.note, 72), 'middle');
    }
  });
});

/* ---------- views + nav ---------- */
const viewById = {};
const navItems = [];
DOC.views.forEach(function (v) {
  viewById[v.id] = v;
  const item = { id: v.id, depth: 0, kind: v.lens === 'data-flow' ? 'flow' : 'arch', flowId: v.lens === 'data-flow' ? v.scope.flows[0] : null, title: v.title };
  navItems.push(item);
  (v.children || []).forEach(function (c) {
    viewById[c.id] = c;
    navItems.push({ id: c.id, depth: 1, kind: 'arch', flowId: null, title: c.title });
  });
});

const navEl = document.getElementById('nav');
const state = { mode: 'arch', archViewId: 'overview', flowId: null, step: -1 };

navItems.forEach(function (item) {
  const b = document.createElement('button');
  b.className = 'vbtn' + (item.depth ? ' child' : '');
  b.textContent = item.title;
  b.id = 'nav-' + item.id;
  b.onclick = function () { state.step = -1; clearStepActive(); if (item.kind === 'flow') setFlow(item.flowId, item.id); else setArchView(item.id); clearDim(); };
  navEl.appendChild(b);
});

function setActiveNav(id) {
  navEl.querySelectorAll('.vbtn').forEach(function (b) { b.classList.remove('active'); });
  const b = document.getElementById('nav-' + id);
  if (b) b.classList.add('active');
}

function setArchView(id) {
  state.mode = 'arch'; state.archViewId = id;
  document.getElementById('arch').classList.add('on');
  Object.keys(flowSvgs).forEach(function (fid) { flowSvgs[fid].classList.remove('on'); });
  const v = viewById[id];
  document.getElementById('archTitle').textContent = v.title;
  document.getElementById('archSummary').textContent = v.summary || '';
  let nodes = null, edges = null;
  if (v.scope.kind === 'all') {
    nodes = null;
  } else {
    nodes = new Set(v.scope.nodes || []);
    edges = new Set(v.scope.edges || []);
    (v.scope.edges || []).forEach(function (eid) {
      const e = DOC.edges.find(function (x) { return x.id === eid; });
      if (e) { nodes.add(e.from); nodes.add(e.to); }
    });
  }
  nodeLayer.querySelectorAll('g[data-focusable]').forEach(function (g) {
    g.style.display = (!nodes || nodes.has(g.id.slice(5))) ? '' : 'none';
  });
  edgeLayer.querySelectorAll('g[data-focusable]').forEach(function (g) {
    g.style.display = (!edges || edges.has(g.id.slice(5))) ? '' : 'none';
  });
  setActiveNav(id);
}

function setFlow(fid, navId) {
  state.mode = 'flow'; state.flowId = fid;
  document.getElementById('arch').classList.remove('on');
  Object.keys(flowSvgs).forEach(function (k) { flowSvgs[k].classList.toggle('on', k === fid); });
  setActiveNav(navId || ('flow-' + fid));
  const fv = navItems.find(function (it) { return it.kind === 'flow' && it.flowId === fid; });
  if (fv) setActiveNav(fv.id);
}

/* ---------- focus dimming ---------- */
function currentContainer() {
  return state.mode === 'arch' ? document.getElementById('arch') : flowSvgs[state.flowId];
}
function clearDim() {
  const c = currentContainer();
  if (c) c.querySelectorAll('[data-focusable]').forEach(function (el) { el.classList.remove('dim'); });
}
function applyFocus(focus) {
  const c = currentContainer();
  if (!c) return;
  const all = c.querySelectorAll('[data-focusable]');
  if (!focus || focus.kind === 'all') {
    all.forEach(function (el) { el.classList.remove('dim'); });
    return;
  }
  all.forEach(function (el) { el.classList.add('dim'); });
  const sel = focus;
  (sel.nodes || []).forEach(function (id) { const el = c.querySelector('#node-' + CSS.escape(id)); if (el) el.classList.remove('dim'); });
  (sel.edges || []).forEach(function (id) { const el = c.querySelector('#edge-' + CSS.escape(id)); if (el) el.classList.remove('dim'); });
  (sel.messages || []).forEach(function (id) { const el = c.querySelector('#fm-' + CSS.escape(state.flowId) + '-' + CSS.escape(id)); if (el) el.classList.remove('dim'); });
}

/* ---------- walkthrough ---------- */
const stepsEl = document.getElementById('steps');
const steps = (DOC.walkthrough && DOC.walkthrough.steps) || [];
steps.forEach(function (s, i) {
  const d = document.createElement('div');
  d.className = 'step';
  d.id = 'step-' + s.id;
  const no = document.createElement('div');
  no.className = 'no';
  no.textContent = String(i + 1).padStart(2, '0');
  const h = document.createElement('h3');
  h.textContent = s.heading;
  const p = document.createElement('p');
  p.textContent = s.body;
  d.appendChild(no); d.appendChild(h); d.appendChild(p);
  d.onclick = function () { goStep(i); };
  stepsEl.appendChild(d);
});
function clearStepActive() {
  stepsEl.querySelectorAll('.step').forEach(function (el) { el.classList.remove('active'); });
  document.getElementById('wcount').textContent = '';
}
function goStep(i) {
  if (i < 0 || i >= steps.length) return;
  state.step = i;
  const s = steps[i];
  clearStepActive();
  const el = document.getElementById('step-' + s.id);
  if (el) el.classList.add('active');
  document.getElementById('wcount').textContent = (i + 1) + ' / ' + steps.length;
  if (s.stage) {
    if (s.stage.kind === 'view') setArchView(s.stage.view);
    else setFlow(s.stage.flow);
  }
  applyFocus(s.focus || { kind: 'all' });
}
document.getElementById('wprev').onclick = function () { goStep(state.step - 1); };
document.getElementById('wnext').onclick = function () { goStep(state.step + 1); };
document.addEventListener('keydown', function (e) {
  if (e.key === 'ArrowRight') goStep(state.step + 1);
  if (e.key === 'ArrowLeft') goStep(state.step - 1);
});

/* ---------- report sections: mermaid / repro / logs / evidence / design / test steps (stacked below the diagrams) ---------- */
const sectionsEl = document.getElementById('sections');
function mkEl(tag, cls, parent) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (parent) parent.appendChild(el);
  return el;
}
function addSection(id, label, hint) {
  const sec = mkEl('section', 'report-sec', sectionsEl);
  sec.id = 'sec-' + id;
  mkEl('h2', '', sec).textContent = label;
  if (hint) mkEl('p', 'phint', sec).textContent = hint;
  return sec;
}

if (DOC.mermaid && DOC.mermaid.length) {
  const p = addSection('mermaid', 'Mermaid 图');
  DOC.mermaid.forEach(function (m) {
    const card = mkEl('div', 'rcard', p);
    mkEl('h3', 'rtitle', card).textContent = m.title;
    if (m.summary) mkEl('p', 'rsummary', card).textContent = m.summary;
    mkEl('div', 'mermaid', card).textContent = m.code;
  });
}
if (DOC.repro && DOC.repro.length) {
  const p = addSection('repro', '复现步骤');
  mkEl('p', 'phint', p).textContent = '枚举分支改动涉及的用例：每条给出复现命令与测试结果；未被自动化覆盖的用例单独注明，需手工验证。';
  DOC.repro.forEach(function (r, i) {
    const card = mkEl('div', 'rcard step-card', p);
    mkEl('div', 'rno', card).textContent = String(i + 1).padStart(2, '0');
    mkEl('h3', 'rtitle', card).textContent = r.title;
    if (r.command) mkEl('pre', 'cmd', card).textContent = r.command;
    if (r.note) mkEl('p', 'rnote', card).textContent = r.note;
    if (r.result) {
      const res = mkEl('p', 'rresult', card);
      const b = mkEl('b', '', res);
      b.textContent = '结果：';
      res.appendChild(document.createTextNode(r.result));
    }
  });
}
if (DOC.testLogs && DOC.testLogs.length) {
  const p = addSection('logs', '测试日志');
  mkEl('p', 'phint', p).textContent = '以下为真实运行的原始输出，未做编辑；退出码非 0 的记录同样保留。';
  DOC.testLogs.forEach(function (t) {
    const card = mkEl('div', 'rcard', p);
    const head = mkEl('div', 'lhead', card);
    mkEl('h3', 'rtitle', head).textContent = t.title;
    const badge = mkEl('span', 'exit ' + (t.exitCode === 0 ? 'ok' : 'fail'), head);
    badge.textContent = 'exit ' + t.exitCode;
    mkEl('pre', 'cmd', card).textContent = t.command;
    mkEl('pre', 'log', card).textContent = t.output;
  });
}
if (EVIDENCE.length) {
  const p = addSection('evidence', '验证证据');
  EVIDENCE.forEach(function (ev) {
    const card = mkEl('figure', 'rcard', p);
    mkEl('h3', 'rtitle', card).textContent = ev.title;
    if (ev.kind === 'video') {
      const v = mkEl('video', '', card);
      v.controls = true;
      v.src = ev.dataUri;
    } else {
      const img = mkEl('img', 'shot', card);
      img.src = ev.dataUri;
      img.alt = ev.title;
    }
    if (ev.note) mkEl('figcaption', 'rnote', card).textContent = ev.note;
  });
}
if (DOC.design && DOC.design.length) {
  const p = addSection('design', '设计决策');
  DOC.design.forEach(function (d) {
    const card = mkEl('div', 'rcard', p);
    mkEl('h3', 'rtitle', card).textContent = d.title;
    mkEl('p', 'rsummary', card).textContent = d.context;
    const list = mkEl('ul', 'opts', card);
    d.options.forEach(function (o) {
      const li = mkEl('li', o.label === d.chosen ? 'chosen' : '', list);
      const b = mkEl('b', '', li);
      b.textContent = o.label;
      if (o.label === d.chosen) mkEl('span', 'chiptag', li).textContent = '✓ 已选';
      if (o.summary) li.appendChild(document.createTextNode(' — ' + o.summary));
    });
    const why = mkEl('p', 'rnote', card);
    const b2 = mkEl('b', '', why);
    b2.textContent = '理由：';
    why.appendChild(document.createTextNode(d.rationale));
  });
}
if (DOC.testSteps && DOC.testSteps.length) {
  const p = addSection('steps', 'Reviewer 验证');
  mkEl('p', 'phint', p).textContent = '按顺序执行，每步核对预期结果。';
  DOC.testSteps.forEach(function (s, i) {
    const card = mkEl('div', 'rcard step-card', p);
    mkEl('div', 'rno', card).textContent = String(i + 1).padStart(2, '0');
    mkEl('h3', 'rtitle', card).textContent = s.title;
    if (s.command) mkEl('pre', 'cmd', card).textContent = s.command;
    const exp = mkEl('p', 'expected', card);
    const b3 = mkEl('b', '', exp);
    b3.textContent = '预期：';
    exp.appendChild(document.createTextNode(s.expected));
  });
}

/* ---------- init ---------- */
setArchView('overview');
if (steps.length) goStep(0);
</script>
${mermaidBootstrap}
</body>
</html>
`;

fs.writeFileSync(outFile, html);
console.log('wrote ' + outFile + ' (' + (html.length / 1024).toFixed(1) + ' KB)');
