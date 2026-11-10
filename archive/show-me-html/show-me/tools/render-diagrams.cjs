// Build-time graph layout. Essential diagrams never depend on browser scripts.
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const deltaText = { added: '新增', modified: '修改', removed: '移除', unchanged: '已有' };
const color = (delta) => `var(--${delta === 'unchanged' ? 'muted-foreground' : delta})`;
// Approximate full-width characters as two Latin units; preserve every character.
const lines = (value, length = 30) => {
  const result = [];
  let line = '',
    width = 0;
  for (const character of value || '') {
    const units = character.codePointAt(0) > 127 ? 2 : 1;
    if (width + units > length && line) {
      result.push(line);
      line = '';
      width = 0;
    }
    line += character;
    width += units;
  }
  if (line) result.push(line);
  return result;
};
const text = (value, x, y, cls = '', anchor = 'start') =>
  `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${escapeHtml(value)}</text>`;
const badge = (delta) => `<span class="badge ${delta}">${deltaText[delta]}</span>`;
const markers = (prefix) =>
  `<defs>${['added', 'modified', 'removed', 'unchanged', 'hero'].map((delta) => `<marker id="${prefix}-${delta}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${delta === 'hero' ? 'var(--accent-foreground)' : color(delta)}"/></marker>`).join('')}</defs>`;

function renderArchitecture(doc, view, prefix) {
  const scoped = view.scope.kind !== 'all';
  const selectedEdges = new Set(view.scope.edges || []);
  const edges = doc.edges.filter((edge) => !scoped || selectedEdges.has(edge.id));
  const selectedNodes = new Set(view.scope.nodes || []);
  edges.forEach((edge) => {
    selectedNodes.add(edge.from);
    selectedNodes.add(edge.to);
  });
  const nodes = doc.nodes.filter((node) => !scoped || selectedNodes.has(node.id));
  const lanes = doc.lanes
    .filter((lane) => nodes.some((node) => node.lane === lane.id))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const positions = new Map();
  let height = 100;
  const laneWidth = 250,
    gap = 110;
  const nodeTop = 56 + Math.max(1, ...lanes.map((lane) => lines(lane.label, 30).length)) * 18;
  const bands = lanes.map((lane, index) => {
    let y = nodeTop;
    for (const node of nodes.filter((item) => item.lane === lane.id)) {
      const label = lines(node.label);
      const subtitle = lines(node.subtitle, 28);
      const h = 40 + label.length * 20 + subtitle.length * 17;
      positions.set(node.id, { x: 24 + index * (laneWidth + gap), y, h, label, subtitle, index });
      y += h + 24;
    }
    height = Math.max(height, y + 12);
    return { lane, index };
  });
  const width = Math.max(
    300,
    48 +
      lanes.length * laneWidth +
      Math.max(0, lanes.length - 1) * gap +
      (edges.some(
        (edge) =>
          positions.get(edge.from).index === lanes.length - 1 &&
          positions.get(edge.from).index === positions.get(edge.to).index
      )
        ? 110
        : 0)
  );
  const svg = [
    `<svg role="img" aria-label="${escapeHtml(view.title)}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    markers(prefix),
  ];
  for (const { lane, index } of bands) {
    const x = 14 + index * (laneWidth + gap);
    svg.push(
      `<rect class="lane-box" x="${x}" y="10" width="270" height="${height - 20}" rx="10"/>`,
      ...lines(lane.label, 30).map((line, i) => text(line, x + 12, 34 + i * 18, 'lane-title'))
    );
  }
  for (const edge of edges) {
    const a = positions.get(edge.from),
      b = positions.get(edge.to);
    const forward = b.index > a.index;
    let sx, sy, tx, ty, cx1, cy1, cx2, cy2;
    if (edge.from === edge.to) {
      sx = tx = a.x + laneWidth;
      sy = a.y + a.h / 3;
      ty = a.y + (a.h * 2) / 3;
      cx1 = cx2 = sx + 60;
      cy1 = sy;
      cy2 = ty;
    } else if (a.index === b.index) {
      sx = tx = a.x + laneWidth;
      sy = a.y + a.h / 2;
      ty = b.y + b.h / 2;
      cx1 = cx2 = sx + 60;
      cy1 = sy;
      cy2 = ty;
    } else {
      sx = a.x + (forward ? laneWidth : 0);
      sy = a.y + a.h / 2;
      tx = b.x + (forward ? 0 : laneWidth);
      ty = b.y + b.h / 2;
      cx1 = sx + (forward ? 60 : -60);
      cx2 = tx + (forward ? -60 : 60);
      cy1 = sy;
      cy2 = ty;
    }
    const hero = edge.emphasis === 'hero';
    svg.push(
      `<g data-edge="${escapeHtml(edge.id)}" data-focusable><path d="M${sx},${sy} C${cx1},${cy1} ${cx2},${cy2} ${tx},${ty}" fill="none" stroke="${hero ? 'var(--accent-foreground)' : color(edge.delta)}" stroke-width="${hero ? 2.5 : 1.5}" ${edge.delta === 'removed' ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#${prefix}-${hero ? 'hero' : edge.delta})"/>`
    );
    lines(edge.label, 14).forEach((line, i) =>
      svg.push(
        text(
          line,
          a.index === b.index ? a.x + laneWidth + 10 : (sx + 3 * cx1 + 3 * cx2 + tx) / 8,
          (sy + 3 * cy1 + 3 * cy2 + ty) / 8 - 8 + i * 15,
          `edge-label${hero ? ' hero' : ''}`,
          a.index === b.index ? 'start' : 'middle'
        )
      )
    );
    svg.push('</g>');
  }
  for (const node of nodes) {
    const p = positions.get(node.id);
    svg.push(
      `<g data-node="${escapeHtml(node.id)}" data-focusable><title>${escapeHtml(node.summary || node.label)}</title><rect class="node-box" x="${p.x}" y="${p.y}" width="${laneWidth}" height="${p.h}" rx="8"/><rect x="${p.x}" y="${p.y + 8}" width="3" height="${p.h - 16}" fill="${color(node.delta)}"/>`
    );
    p.label.forEach((line, i) => svg.push(text(line, p.x + 12, p.y + 24 + i * 20)));
    p.subtitle.forEach((line, i) =>
      svg.push(text(line, p.x + 12, p.y + 24 + p.label.length * 20 + i * 17, 'secondary'))
    );
    svg.push(
      text(deltaText[node.delta], p.x + laneWidth - 12, p.y + p.h - 8, 'delta-label', 'end'),
      '</g>'
    );
  }
  svg.push('</svg>');
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const relationships = edges
    .map(
      (edge) =>
        `<li class="card ${edge.emphasis === 'hero' ? 'hero' : ''}" data-edge="${escapeHtml(edge.id)}" data-focusable><strong>${escapeHtml(byId.get(edge.from).label)}<span class="arrow">→</span>${escapeHtml(byId.get(edge.to).label)}</strong><p>${badge(edge.delta)} ${escapeHtml(edge.label || edge.kind)}</p></li>`
    )
    .join('');
  const details = nodes
    .map(
      (node) =>
        `<details class="card" data-node="${escapeHtml(node.id)}" data-focusable><summary>${escapeHtml(node.label)} ${badge(node.delta)}</summary>${node.summary ? `<p>${escapeHtml(node.summary)}</p>` : ''}${node.subtitle ? `<p class="muted">${escapeHtml(node.subtitle)}</p>` : ''}${node.group ? `<p class="muted">${escapeHtml(node.group)}</p>` : ''}${node.badges.map((value) => `<span class="badge">${escapeHtml(value)}</span>`).join('')}<ul class="source-list">${node.files.map((file) => `<li><code>${escapeHtml(file.path)}${file.startLine ? `:${file.startLine}` : ''}</code></li>`).join('')}</ul></details>`
    )
    .join('');
  return `<div class="diagram-scroll wide-diagram" tabindex="0" role="region" aria-label="${escapeHtml(view.title)}：关系图">${svg.join('')}</div><div class="narrow-diagram"><ol class="relationships">${relationships}</ol></div><div class="node-grid">${details}</div>`;
}

function renderFlow(doc, flow, prefix) {
  const nodes = new Map(doc.nodes.map((node) => [node.id, node]));
  const x = new Map(
    flow.participants.map((participant, index) => [participant.node, 110 + index * 230])
  );
  const labels = flow.participants.map((participant) =>
    lines(participant.label || nodes.get(participant.node).label, 22)
  );
  const headerHeight = Math.max(56, ...labels.map((label) => label.length * 18 + 20));
  const messageLabels = flow.messages.map((message) =>
    lines(message.label + (message.repeat ? ` ×${message.repeat}` : ''), 28)
  );
  const rowHeights = messageLabels.map((label) => Math.max(86, label.length * 16 + 50));
  const width = Math.max(300, flow.participants.length * 230);
  const height = headerHeight + 42 + rowHeights.reduce((sum, h) => sum + h, 0);
  const svg = [
    `<svg role="img" aria-label="${escapeHtml(flow.title)}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    markers(prefix),
  ];
  flow.participants.forEach((participant, index) => {
    const px = x.get(participant.node);
    svg.push(
      `<rect class="node-box" x="${px - 100}" y="12" width="200" height="${headerHeight}" rx="8"/>`
    );
    labels[index].forEach((line, i) => svg.push(text(line, px, 34 + i * 18, '', 'middle')));
    svg.push(
      `<path d="M${px},${12 + headerHeight} V${height - 12}" fill="none" stroke="var(--border)" stroke-dasharray="4 5"/>`
    );
  });
  let rowTop = headerHeight + 42;
  const rows = flow.messages.map((message, index) => {
    const from = x.get(message.from),
      to = x.get(message.to),
      y = rowTop + messageLabels[index].length * 16 + 8;
    rowTop += rowHeights[index];
    const label = message.label + (message.repeat ? ` ×${message.repeat}` : '');
    svg.push(
      `<g data-message="${escapeHtml(message.id)}" data-focusable><path d="${message.kind === 'self' ? `M${from},${y} c60,0 60,36 0,36` : `M${from},${y} H${to}`}" fill="none" stroke="${color(message.delta)}" stroke-width="1.5" ${['async', 'return'].includes(message.kind) ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#${prefix}-${message.delta})"/>`
    );
    messageLabels[index].forEach((line, i) =>
      svg.push(
        text(
          line,
          (from + to) / 2,
          y - 12 - (messageLabels[index].length - i - 1) * 16,
          'edge-label',
          'middle'
        )
      )
    );
    svg.push('</g>');
    return `<li class="card" data-message="${escapeHtml(message.id)}" data-focusable><strong>${index + 1}. ${escapeHtml(nodes.get(message.from).label)} → ${escapeHtml(nodes.get(message.to).label)}</strong><p>${badge(message.delta)} ${escapeHtml(label)}</p>${message.note ? `<p class="muted">${escapeHtml(message.note)}</p>` : ''}</li>`;
  });
  svg.push('</svg>');
  return `<div class="diagram-scroll wide-diagram" tabindex="0" role="region" aria-label="${escapeHtml(flow.title)}：时序图">${svg.join('')}</div><ol class="relationships narrow-diagram">${rows.join('')}</ol>${flow.messages.some((message) => message.note) ? `<details class="report-section"><summary>消息说明</summary><ol class="section-body">${rows.join('')}</ol></details>` : ''}`;
}
module.exports = { escapeHtml, renderArchitecture, renderFlow };
