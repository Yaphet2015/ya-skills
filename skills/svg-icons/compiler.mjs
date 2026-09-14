// Compiles .icon.json drawings on a 24 grid into SVG.
// Numeric construction rules are enforced here; optical review still happens by eye.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const spec = {
  canvas: 24,
  safe: [2, 22],
  stroke: 2,
  weights: [1.5, 1.75, 2],
  radius: { container: 2, small: 1, smallBelow: 8 },
  corner: 2,
  arrowHead: { axis: 6, diagonal: 8 },
  minGap: 3,
  nudgeMax: 0.5,
  categories: ["navigation", "actions", "status", "content", "entry-types", "agent", "controls", "shapes"]
};

const fmt = (n) => (Math.round(n * 100) / 100).toString().replace(/^(-?)0\./, "$1.");
const onGrid = (n) => Number.isFinite(n) && Math.abs(n * 2 - Math.round(n * 2)) < 1e-9;
const primitives = ["line", "polyline", "rect", "circle", "arc", "bend", "quad", "ellipse", "dot", "arrow", "path", "use"];

class IconError extends Error {
  constructor(icon, index, rule) {
    super(index == null ? `${icon}: ${rule}` : `${icon}: shape ${index}: ${rule}`);
  }
}

function transformPoint([x, y], shape) {
  const c = spec.canvas / 2;
  if (shape.mirror === "x") x = spec.canvas - x;
  if (shape.mirror === "y") y = spec.canvas - y;
  const turns = ((shape.rotate ?? 0) / 90) % 4;
  for (let i = 0; i < ((turns % 4) + 4) % 4; i++) [x, y] = [c - (y - c), c + (x - c)];
  if (shape.nudge) [x, y] = [x + shape.nudge[0], y + shape.nudge[1]];
  return [x, y];
}

function shapeInk(shape) {
  if (shape.ink == null) return 1;
  if (shape.ink !== 1 && shape.ink !== 2) {
    return null;
  }
  return shape.ink;
}

export function loadLibrary(srcDir) {
  return fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith(".icon.json"))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(srcDir, f), "utf8")) }));
}

export function resolve(icon, byName, seen = []) {
  if (seen.includes(icon.name)) throw new IconError(icon.name, null, `use cycle through ${seen.join(" > ")}`);
  const out = [];
  icon.shapes.forEach((shape, i) => {
    const kind = primitives.find((p) => p in shape);
    if (!kind) throw new IconError(icon.name, i, `unknown primitive; expected one of ${primitives.join(", ")}`);
    const ink = shapeInk(shape);
    if (ink == null) throw new IconError(icon.name, i, "ink must be 1 or 2");
    if (shape.rotate != null && shape.rotate % 90 !== 0) throw new IconError(icon.name, i, "rotate must be a multiple of 90");
    if (shape.nudge && (shape.nudge.length !== 2 || shape.nudge.some((n) => Math.abs(n) > spec.nudgeMax)))
      throw new IconError(icon.name, i, `nudge is limited to ${spec.nudgeMax} in each axis`);
    if (shape.join && !["round", "miter"].includes(shape.join)) throw new IconError(icon.name, i, "join must be round or miter");
    if (kind === "use") {
      const target = byName.get(shape.use);
      if (!target) throw new IconError(icon.name, i, `use of unknown icon "${shape.use}"`);
      const scale = shape.scale ?? 1;
      if (![0.5, 1].includes(scale)) throw new IconError(icon.name, i, "use scale must be 0.5 or 1");
      const [dx, dy] = shape.offset ?? [0, 0];
      const c = spec.canvas / 2;
      const map = ([x, y]) => [c + (x - c) * scale + dx, c + (y - c) * scale + dy];
      for (const g of resolve(target, byName, [...seen, icon.name])) {
        out.push({
          ...g,
          index: i,
          points: g.points.map(map),
          scale: (g.scale ?? 1) * scale,
          offset: [dx, dy],
          ink: shape.ink != null ? ink : g.ink
        });
      }
      return;
    }
    const t = (p) => transformPoint(p, shape);
    if (shape.corner != null && (shape.corner < 0 || shape.corner > 4)) throw new IconError(icon.name, i, "corner must be between 0 and 4");
    const rec = { index: i, kind, join: shape.join ?? "round", corner: shape.join === "miter" ? 0 : shape.corner ?? spec.corner, flagged: kind === "path", ink };
    switch (kind) {
      case "line": {
        const [x1, y1, x2, y2] = shape.line;
        rec.points = [t([x1, y1]), t([x2, y2])];
        break;
      }
      case "polyline": {
        if (shape.polyline.length < 2) throw new IconError(icon.name, i, "polyline needs two or more points");
        rec.points = shape.polyline.map((p) => t(Array.isArray(p) ? p : p.to));
        rec.segs = shape.polyline.map((p) => (Array.isArray(p) ? null : { r: p.r, large: !!p.large, flip: !!p.flip !== !!shape.mirror }));
        for (const [k, seg] of rec.segs.entries()) if (seg && !(seg.r > 0)) throw new IconError(icon.name, i, `polyline point ${k} arc needs a positive radius`);
        rec.close = !!shape.close;
        const [f, l] = [rec.points[0], rec.points.at(-1)];
        if (rec.close && rec.points.length > 2 && f[0] === l[0] && f[1] === l[1]) {
          rec.points.pop();
          rec.segs[0] = rec.segs.pop();
        }
        break;
      }
      case "rect": {
        const [x, y, w, h] = shape.rect;
        if (w <= 0 || h <= 0) throw new IconError(icon.name, i, "rect needs positive width and height");
        const r = shape.radius ?? (Math.min(w, h) < spec.radius.smallBelow ? spec.radius.small : spec.radius.container);
        if (r * 2 > Math.min(w, h)) throw new IconError(icon.name, i, `radius ${r} exceeds half the shorter side`);
        rec.points = [t([x, y]), t([x + w, y + h])];
        rec.radius = r;
        break;
      }
      case "circle": {
        const [cx, cy, r] = shape.circle;
        if (r <= 0) throw new IconError(icon.name, i, "circle needs a positive radius");
        rec.points = [t([cx, cy])];
        rec.r = r;
        break;
      }
      case "ellipse": {
        const [cx, cy, rx, ry] = shape.ellipse;
        rec.points = [t([cx, cy])];
        rec.rx = rx;
        rec.ry = ry;
        break;
      }
      case "arc": {
        const [cx, cy, r, from, to] = shape.arc;
        if (from % 45 !== 0 || to % 45 !== 0) throw new IconError(icon.name, i, "arc angles must be multiples of 45 degrees");
        rec.points = [t([cx, cy])];
        rec.r = r;
        rec.from = from;
        rec.to = to;
        break;
      }
      case "bend": {
        const [x1, y1, x2, y2, r] = shape.bend;
        const chord = Math.hypot(x2 - x1, y2 - y1);
        if (r <= 0) throw new IconError(icon.name, i, "bend needs a positive radius");
        if (r * 2 < chord - 1e-9) throw new IconError(icon.name, i, `bend radius ${r} is under half the chord (${fmt(chord / 2)})`);
        rec.points = [t([x1, y1]), t([x2, y2])];
        rec.r = r;
        rec.large = !!shape.large;
        rec.flip = !!shape.flip !== !!shape.mirror;
        break;
      }
      case "quad": {
        const [x1, y1, cx, cy, x2, y2] = shape.quad;
        rec.points = [t([x1, y1]), t([cx, cy]), t([x2, y2])];
        break;
      }
      case "dot": {
        rec.points = [t(shape.dot)];
        break;
      }
      case "arrow": {
        const [x1, y1, x2, y2] = shape.arrow;
        rec.points = [t([x1, y1]), t([x2, y2])];
        rec.head = shape.head;
        break;
      }
      case "path": {
        rec.d = shape.path;
        rec.points = [...shape.path.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number).reduce((acc, n, k, arr) => (k % 2 ? acc : [...acc, [n, arr[k + 1]]]), []);
        break;
      }
    }
    out.push(rec);
  });
  return out;
}

function arrowLegs([x1, y1], [x2, y2], head) {
  const dx = Math.sign(x2 - x1),
    dy = Math.sign(y2 - y1);
  if (dx && dy) {
    const h = head ?? spec.arrowHead.diagonal;
    return [
      [x2 - dx * h, y2],
      [x2, y2 - dy * h]
    ];
  }
  const h = head ?? spec.arrowHead.axis;
  return dx
    ? [
        [x2 - dx * h, y2 - h],
        [x2 - dx * h, y2 + h]
      ]
    : [
        [x2 - h, y2 - dy * h],
        [x2 + h, y2 - dy * h]
      ];
}

const polar = (cx, cy, r, deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];

function roundedCorner(a, v, b, r) {
  const [ax, ay] = [a[0] - v[0], a[1] - v[1]],
    [bx, by] = [b[0] - v[0], b[1] - v[1]];
  const la = Math.hypot(ax, ay),
    lb = Math.hypot(bx, by);
  const cos = (ax * bx + ay * by) / (la * lb);
  const theta = Math.acos(Math.max(-1, Math.min(1, cos)));
  if (!r || theta > Math.PI - 1e-6 || theta < 1e-6) return null;
  let t = r / Math.tan(theta / 2);
  const max = Math.min(la, lb) * 0.4;
  if (t > max) {
    t = max;
    r = t * Math.tan(theta / 2);
  }
  const p1 = [v[0] + (ax / la) * t, v[1] + (ay / la) * t];
  const p2 = [v[0] + (bx / lb) * t, v[1] + (by / lb) * t];
  const sweep = ax * by - ay * bx < 0 ? 1 : 0;
  const bis = [ax / la + bx / lb, ay / la + by / lb],
    lbis = Math.hypot(...bis);
  const apex = [
    v[0] + (bis[0] / lbis) * (r / Math.sin(theta / 2) - r),
    v[1] + (bis[1] / lbis) * (r / Math.sin(theta / 2) - r)
  ];
  return { p1, p2, r, sweep, apex };
}

function polylinePath(points, close, corner, segs = []) {
  const P = (p) => p.map(fmt).join(" ");
  const n = points.length;
  const arcInto = (i) => segs[((i % n) + n) % n];
  const cornerAt = (i) => {
    if (!close && (i === 0 || i === n - 1)) return null;
    if (arcInto(i) || arcInto(i + 1)) return null;
    return roundedCorner(points[(i - 1 + n) % n], points[i], points[(i + 1) % n], corner);
  };
  const corners = points.map((_, i) => cornerAt(i));
  const seg = (c, i) => {
    const a = arcInto(i);
    if (a) return `A${fmt(a.r)} ${fmt(a.r)} 0 ${a.large ? 1 : 0} ${a.flip ? 0 : 1} ${P(points[i % n])}`;
    return c ? `L${P(c.p1)}A${fmt(c.r)} ${fmt(c.r)} 0 0 ${c.sweep} ${P(c.p2)}` : `L${P(points[i % n])}`;
  };
  if (!close) return `M${P(points[0])}` + points.slice(1).map((_, k) => seg(corners[k + 1], k + 1)).join("");
  const start = corners[0] ? corners[0].p2 : points[0];
  let d = `M${P(start)}`;
  for (let i = 1; i < n; i++) d += seg(corners[i], i);
  d += seg(corners[0], n);
  return d + "Z";
}

function toPath(g) {
  const P = (p) => p.map(fmt).join(" ");
  switch (g.kind) {
    case "line":
      return `M${P(g.points[0])}L${P(g.points[1])}`;
    case "polyline":
      return polylinePath(g.points, g.close, g.corner, g.segs);
    case "rect": {
      const [[x1, y1], [x2, y2]] = [
        [Math.min(g.points[0][0], g.points[1][0]), Math.min(g.points[0][1], g.points[1][1])],
        [Math.max(g.points[0][0], g.points[1][0]), Math.max(g.points[0][1], g.points[1][1])]
      ];
      const r = g.radius * (g.scale ?? 1);
      if (!r) return `M${fmt(x1)} ${fmt(y1)}H${fmt(x2)}V${fmt(y2)}H${fmt(x1)}Z`;
      const a = (x, y) => `A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x)} ${fmt(y)}`;
      return `M${fmt(x1 + r)} ${fmt(y1)}H${fmt(x2 - r)}${a(x2, y1 + r)}V${fmt(y2 - r)}${a(x2 - r, y2)}H${fmt(x1 + r)}${a(x1, y2 - r)}V${fmt(y1 + r)}${a(x1 + r, y1)}Z`;
    }
    case "circle": {
      const [cx, cy] = g.points[0],
        r = g.r * (g.scale ?? 1);
      return `M${fmt(cx - r)} ${fmt(cy)}a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2 * r)} 0a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2 * r)} 0Z`;
    }
    case "ellipse": {
      const [cx, cy] = g.points[0],
        rx = g.rx * (g.scale ?? 1),
        ry = g.ry * (g.scale ?? 1);
      return `M${fmt(cx - rx)} ${fmt(cy)}a${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(2 * rx)} 0a${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(-2 * rx)} 0Z`;
    }
    case "arc": {
      const [cx, cy] = g.points[0],
        r = g.r * (g.scale ?? 1);
      const sweep = ((g.to - g.from) % 360 + 360) % 360 || 360;
      const [sx, sy] = polar(cx, cy, r, g.from),
        [ex, ey] = polar(cx, cy, r, g.to);
      return `M${fmt(sx)} ${fmt(sy)}A${fmt(r)} ${fmt(r)} 0 ${sweep > 180 ? 1 : 0} 1 ${fmt(ex)} ${fmt(ey)}`;
    }
    case "bend": {
      const r = g.r * (g.scale ?? 1);
      return `M${P(g.points[0])}A${fmt(r)} ${fmt(r)} 0 ${g.large ? 1 : 0} ${g.flip ? 0 : 1} ${P(g.points[1])}`;
    }
    case "quad":
      return `M${P(g.points[0])}Q${P(g.points[1])} ${P(g.points[2])}`;
    case "dot":
      return `M${P(g.points[0])}v.01`;
    case "arrow": {
      const [a, b] = g.points,
        [l1, l2] = arrowLegs(a, b, g.head);
      const c = roundedCorner(l1, b, l2, g.corner);
      const end = c ? c.apex : b;
      return `M${P(a)}L${P(end)}${polylinePath([l1, b, l2], false, g.corner)}`;
    }
    case "path":
      return g.d;
  }
}

function extents(g) {
  const s = g.scale ?? 1;
  switch (g.kind) {
    case "circle": {
      const [cx, cy] = g.points[0],
        r = g.r * s;
      return [
        [cx - r, cy - r],
        [cx + r, cy + r]
      ];
    }
    case "arc": {
      const [cx, cy] = g.points[0],
        r = g.r * s;
      const sweep = ((g.to - g.from) % 360 + 360) % 360 || 360;
      const pts = [polar(cx, cy, r, g.from), polar(cx, cy, r, g.to)];
      for (const a of [0, 90, 180, 270]) if (((a - g.from) % 360 + 360) % 360 <= sweep) pts.push(polar(cx, cy, r, a));
      return pts.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
    }
    case "ellipse": {
      const [cx, cy] = g.points[0];
      return [
        [cx - g.rx * s, cy - g.ry * s],
        [cx + g.rx * s, cy + g.ry * s]
      ];
    }
    case "arrow":
      return [...g.points, ...arrowLegs(g.points[0], g.points[1], g.head)];
    case "bend":
      return [...g.points, bendApex(g)];
    default:
      return g.points;
  }
}

function bendApex(g) {
  const [[x1, y1], [x2, y2]] = g.points,
    r = g.r * (g.scale ?? 1);
  const mx = (x1 + x2) / 2,
    my = (y1 + y2) / 2,
    half = Math.hypot(x2 - x1, y2 - y1) / 2;
  const h = Math.sqrt(Math.max(0, r * r - half * half));
  const nx = -(y2 - y1) / (2 * half),
    ny = (x2 - x1) / (2 * half);
  const side = (g.flip ? -1 : 1) * (g.large ? -1 : 1);
  const cx = mx + nx * h * side,
    cy = my + ny * h * side;
  return [cx - nx * r * side, cy - ny * r * side];
}

export function validate(icon, geometry) {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(icon.name)) throw new IconError(icon.name, null, "name must be kebab-case");
  if (icon.file && icon.file !== `${icon.name}.icon.json`) throw new IconError(icon.name, null, `file ${icon.file} does not match name`);
  if (!icon.title) throw new IconError(icon.name, null, "title is required");
  if (!Array.isArray(icon.categories) || !icon.categories.length) throw new IconError(icon.name, null, "at least one category is required");
  for (const c of icon.categories) if (!spec.categories.includes(c)) throw new IconError(icon.name, null, `unknown category "${c}"; expected one of ${spec.categories.join(", ")}`);
  if (!Array.isArray(icon.keywords)) throw new IconError(icon.name, null, "keywords must be a list");
  if (!icon.shapes?.length) throw new IconError(icon.name, null, "at least one shape is required");
  const lines = [];
  for (const g of geometry) {
    for (const [x, y] of g.points) if (!g.flagged && !(onGrid(x) && onGrid(y))) throw new IconError(icon.name, g.index, `point ${fmt(x)},${fmt(y)} is off the half grid`);
    for (const [x, y] of extents(g)) {
      if (x < spec.safe[0] || x > spec.safe[1] || y < spec.safe[0] || y > spec.safe[1])
        throw new IconError(icon.name, g.index, `point ${fmt(x)},${fmt(y)} is outside the safe area (${spec.safe[0]} to ${spec.safe[1]})`);
    }
    if (g.kind === "circle" || g.kind === "arc" || g.kind === "bend") if (!onGrid(g.r * (g.scale ?? 1))) throw new IconError(icon.name, g.index, "radius must land on the half grid");
    const segment = ([x1, y1], [x2, y2]) => {
      if (x1 === x2) lines.push({ axis: "v", at: x1, index: g.index, lo: Math.min(y1, y2), hi: Math.max(y1, y2) });
      if (y1 === y2) lines.push({ axis: "h", at: y1, index: g.index, lo: Math.min(x1, x2), hi: Math.max(x1, x2) });
    };
    if (g.kind === "line" || g.kind === "arrow") {
      const [[x1, y1], [x2, y2]] = g.points;
      if (x1 === x2 && y1 === y2) throw new IconError(icon.name, g.index, "line has zero length");
      segment(g.points[0], g.points[1]);
    }
    if (g.kind === "polyline") for (let k = 1; k < g.points.length; k++) segment(g.points[k - 1], g.points[k]);
    if (g.kind === "rect") {
      const [[x1, y1], [x2, y2]] = g.points;
      segment([x1, y1], [x2, y1]);
      segment([x1, y2], [x2, y2]);
      segment([x1, y1], [x1, y2]);
      segment([x2, y1], [x2, y2]);
    }
  }
  for (let a = 0; a < lines.length; a++)
    for (let b = a + 1; b < lines.length; b++) {
      const p = lines[a],
        q = lines[b];
      if (p.axis !== q.axis || p.at === q.at) continue;
      const overlap = Math.min(p.hi, q.hi) - Math.max(p.lo, q.lo);
      if (overlap > 0 && Math.abs(p.at - q.at) < spec.minGap)
        throw new IconError(icon.name, q.index, `parallel stroke ${Math.abs(p.at - q.at)} from shape ${p.index}; minimum gap is ${spec.minGap}`);
    }
}

function pathTag(d, join, stroke) {
  const joinAttr = join === "round" ? "" : ` stroke-linejoin="${join}"`;
  const strokeAttr = stroke ? ` stroke="${stroke}"` : "";
  return `<path${joinAttr}${strokeAttr} d="${d}"/>`;
}

export function compileToSvg(icon, options = {}) {
  const ink1 = options.ink1 ?? "currentColor";
  const ink2 = options.ink2 ?? "currentColor";
  const library = Array.isArray(options.library) ? options.library : [];
  const sources = [...library.filter((item) => item.name !== icon.name), icon];
  const names = sources.map((item) => item.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) throw new Error(`icons: duplicate names ${dupes.join(", ")}`);
  const byName = new Map(sources.map((item) => [item.name, item]));
  if (!icon.shapes?.length) throw new IconError(icon.name, null, "at least one shape is required");
  const geometry = resolve(icon, byName);
  validate(icon, geometry);
  const inks = [...new Set(geometry.map((g) => g.ink ?? 1))];
  if (inks.some((ink) => ink !== 1 && ink !== 2) || inks.length > 2) {
    throw new IconError(icon.name, null, "ink must be 1 or 2; at most two inks");
  }
  const groups = [];
  for (const g of geometry) {
    const d = toPath(g);
    const ink = g.ink ?? 1;
    const last = groups.at(-1);
    if (last && last.join === g.join && last.ink === ink) last.d += d;
    else groups.push({ join: g.join, ink, d });
  }
  const rootStroke = ink1;
  const paths = groups.map((gr) => {
    const color = gr.ink === 2 ? ink2 : ink1;
    const extra = color !== rootStroke ? color : "";
    return pathTag(gr.d, gr.join, extra);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${rootStroke}" stroke-width="${spec.stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.join("")}</svg>\n`;
}

export function compileFile(iconPath, options = {}) {
  const icon = { ...JSON.parse(fs.readFileSync(iconPath, "utf8")), file: path.basename(iconPath) };
  const library = options.libraryDir ? loadLibrary(options.libraryDir) : [];
  const svg = compileToSvg(icon, { library, ink1: options.ink1, ink2: options.ink2 });
  if (options.outPath) fs.writeFileSync(options.outPath, svg);
  return svg;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!args.includes("--emit")) {
    console.error("usage: bun compiler.mjs --emit <file.icon.json> -o <file.svg> [--library <dir>] [--ink1 <color>] [--ink2 <color>]");
    process.exit(2);
  }
  const iconPath = argValue(args, "--emit");
  const outPath = argValue(args, "-o");
  if (!iconPath || !outPath) {
    console.error("usage: bun compiler.mjs --emit <file.icon.json> -o <file.svg> [--library <dir>] [--ink1 <color>] [--ink2 <color>]");
    process.exit(2);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    compileFile(iconPath, {
      libraryDir: argValue(args, "--library") ?? path.join(here, "src"),
      outPath,
      ink1: argValue(args, "--ink1"),
      ink2: argValue(args, "--ink2")
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
