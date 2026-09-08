const fs = require('fs');
const path = require('path');

const file = process.argv[2] || '.show-branch-diff/graph.zh.json';
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const errors = [];
const err = (msg) => errors.push(msg);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const DELTAS = ['added', 'modified', 'removed', 'unchanged'];
const NODE_KINDS = [
  'service',
  'app',
  'module',
  'function',
  'route',
  'job',
  'queue',
  'datastore',
  'cache',
  'external',
  'ui',
  'config',
  'test',
  'package',
  'other',
];
const EDGE_KINDS = ['call', 'http', 'rpc', 'event', 'queue', 'data', 'dependency', 'render', 'other'];
const MSG_KINDS = ['sync', 'async', 'return', 'self'];
const TONES = ['neutral', 'added', 'modified', 'removed', 'hero'];
const LENSES = ['architecture', 'data-flow'];

const checkId = (id, what) => {
  if (typeof id !== 'string' || !ID_RE.test(id)) err(`${what}: bad id "${id}"`);
  if (id && id.length > 128) err(`${what}: id over 128 chars`);
};

if (doc.schemaVersion !== '0.1.1') err(`schemaVersion must be 0.1.1, got ${doc.schemaVersion}`);
if (doc.kind !== 'graph') err(`kind must be "graph"`);
if (!Array.isArray(doc.lenses) || doc.lenses.some((l) => !LENSES.includes(l))) err('lenses invalid');
if (doc.flows.length > 0 && !doc.lenses.includes('data-flow')) err('document with flows must declare data-flow lens');
if (doc.title.length > 200) err('title too long');

const SHA_RE = /^[0-9a-f]{7,40}$/;
for (const side of ['base', 'head']) {
  const sha = doc.provenance?.[side]?.sha;
  if (!SHA_RE.test(sha || '')) err(`provenance.${side}.sha not lowercase hex 7-40: ${sha}`);
}
if (doc.provenance.base.sha === doc.provenance.head.sha) err('patch commits are the same');

const laneIds = new Set();
if (doc.lanes.length < 1 || doc.lanes.length > 16) err('lanes must be 1-16');
for (const lane of doc.lanes) {
  checkId(lane.id, 'lane');
  if (laneIds.has(lane.id)) err(`duplicate lane id ${lane.id}`);
  laneIds.add(lane.id);
  if (lane.order !== undefined && (lane.order < 0 || lane.order > 64)) err(`lane ${lane.id} order out of 0-64`);
  if (lane.delta && !DELTAS.includes(lane.delta)) err(`lane ${lane.id} bad delta`);
}

const nodeIds = new Set();
if (doc.nodes.length < 1 || doc.nodes.length > 256) err('nodes must be 1-256');
for (const n of doc.nodes) {
  checkId(n.id, 'node');
  if (nodeIds.has(n.id)) err(`DUPLICATE_ID node ${n.id}`);
  nodeIds.add(n.id);
  if (!laneIds.has(n.lane)) err(`node ${n.id} lane "${n.lane}" not declared`);
  if (!DELTAS.includes(n.delta)) err(`node ${n.id} bad delta ${n.delta}`);
  if (!NODE_KINDS.includes(n.kind)) err(`node ${n.id} bad kind ${n.kind}`);
  if (n.label.length > 120) err(`node ${n.id} label over 120`);
  if (n.summary && n.summary.length > 2000) err(`node ${n.id} summary over 2000`);
  if (n.files.length > 64) err(`node ${n.id} over 64 files`);
  if (n.badges.length > 6) err(`node ${n.id} over 6 badges`);
  for (const f of n.files) checkFileRef(f, `node ${n.id}`);
}
function checkFileRef(f, where) {
  if (f.path.startsWith('/') || f.path.includes('\\') || /^[A-Za-z]:/.test(f.path) || f.path.split('/').includes('..')) {
    err(`${where}: bad path ${f.path}`);
  }
  if (f.startLine !== undefined) {
    if (!Number.isInteger(f.startLine) || f.startLine < 1) err(`${where}: bad startLine`);
    if (f.endLine !== undefined && f.endLine < f.startLine) err(`${where}: endLine before startLine (${f.path})`);
  }
  if (f.revision !== undefined && !['base', 'head'].includes(f.revision)) err(`${where}: bad revision`);
}

const edgeIds = new Set();
if (doc.edges.length > 512) err('over 512 edges');
const heroCount = doc.edges.filter((e) => e.emphasis === 'hero').length;
if (heroCount > 2) err(`${heroCount} hero edges — at most two`);
for (const e of doc.edges) {
  checkId(e.id, 'edge');
  if (edgeIds.has(e.id)) err(`DUPLICATE_ID edge ${e.id}`);
  edgeIds.add(e.id);
  if (!nodeIds.has(e.from)) err(`BROKEN_REFERENCE edge ${e.id} from "${e.from}"`);
  if (!nodeIds.has(e.to)) err(`BROKEN_REFERENCE edge ${e.id} to "${e.to}"`);
  if (!EDGE_KINDS.includes(e.kind)) err(`edge ${e.id} bad kind ${e.kind}`);
  if (!DELTAS.includes(e.delta)) err(`edge ${e.id} bad delta`);
  if (e.emphasis && !['normal', 'hero', 'muted'].includes(e.emphasis)) err(`edge ${e.id} bad emphasis`);
  if (e.label && e.label.length > 120) err(`edge ${e.id} label over 120`);
}

const flowIds = new Set();
if (doc.flows.length > 16) err('over 16 flows');
for (const fl of doc.flows) {
  checkId(fl.id, 'flow');
  if (flowIds.has(fl.id)) err(`DUPLICATE_ID flow ${fl.id}`);
  flowIds.add(fl.id);
  if (!DELTAS.includes(fl.delta)) err(`flow ${fl.id} bad delta`);
  if (fl.participants.length < 2 || fl.participants.length > 12) err(`flow ${fl.id} participants must be 2-12`);
  const parts = new Set();
  for (const p of fl.participants) {
    if (!nodeIds.has(p.node)) err(`BROKEN_REFERENCE flow ${fl.id} participant "${p.node}"`);
    if (parts.has(p.node)) err(`flow ${fl.id} duplicate participant ${p.node}`);
    parts.add(p.node);
  }
  if (fl.messages.length < 1 || fl.messages.length > 64) err(`flow ${fl.id} messages must be 1-64`);
  const msgIds = new Set();
  for (const m of fl.messages) {
    checkId(m.id, `flow ${fl.id} message`);
    if (msgIds.has(m.id)) err(`flow ${fl.id} duplicate message id ${m.id}`);
    msgIds.add(m.id);
    if (!MSG_KINDS.includes(m.kind)) err(`flow ${fl.id} message ${m.id} bad kind`);
    if (!DELTAS.includes(m.delta)) err(`flow ${fl.id} message ${m.id} bad delta`);
    if (m.kind === 'self' && m.from !== m.to) err(`flow ${fl.id} message ${m.id} self with differing endpoints`);
    if (m.kind !== 'self' && m.from === m.to) err(`flow ${fl.id} message ${m.id} non-self with equal endpoints`);
    if (!parts.has(m.from)) err(`BROKEN_REFERENCE flow ${fl.id} message ${m.id} from "${m.from}" not a participant`);
    if (!parts.has(m.to)) err(`BROKEN_REFERENCE flow ${fl.id} message ${m.id} to "${m.to}" not a participant`);
    if (m.label && m.label.length > 120) err(`flow ${fl.id} message ${m.id} label over 120`);
  }
}

if (doc.stats.chips.length > 8) err('over 8 chips');
for (const c of doc.stats.chips) {
  if (!TONES.includes(c.tone)) err(`chip bad tone ${c.tone}`);
  if (c.value.length > 32) err(`chip value over 32: ${c.value}`);
}

const viewIds = new Set();
const roots = doc.views;
if (roots.length > 32) err('over 32 root views');
function checkView(v, depth) {
  checkId(v.id, 'view');
  if (viewIds.has(v.id)) err(`DUPLICATE_ID view ${v.id}`);
  viewIds.add(v.id);
  if (!doc.lenses.includes(v.lens)) err(`view ${v.id} lens ${v.lens} not declared in document`);
  if (v.title.length > 120) err(`view ${v.id} title over 120`);
  if (v.scope.kind === 'selection') {
    const n = (v.scope.nodes || []).length + (v.scope.edges || []).length + (v.scope.lanes || []).length + (v.scope.flows || []).length;
    if (n < 1) err(`view ${v.id} selection names nothing`);
    for (const id of v.scope.nodes || []) if (!nodeIds.has(id)) err(`BROKEN_REFERENCE view ${v.id} node "${id}"`);
    for (const id of v.scope.edges || []) if (!edgeIds.has(id)) err(`BROKEN_REFERENCE view ${v.id} edge "${id}"`);
    for (const id of v.scope.lanes || []) if (!laneIds.has(id)) err(`BROKEN_REFERENCE view ${v.id} lane "${id}"`);
    for (const id of v.scope.flows || []) if (!flowIds.has(id)) err(`BROKEN_REFERENCE view ${v.id} flow "${id}"`);
  } else if (v.scope.kind !== 'all') {
    err(`view ${v.id} bad scope kind ${v.scope.kind}`);
  }
  if (v.children.length > 32) err(`view ${v.id} over 32 children`);
  if (depth > 32) err('views nested over 32 levels');
  for (const c of v.children) checkView(c, depth + 1);
}
for (const v of roots) checkView(v, 0);

const steps = doc.walkthrough?.steps || [];
if (steps.length < 2 || steps.length > 12) err(`walkthrough must be 2-12 steps, got ${steps.length}`);
const stepIds = new Set();
const flowMsgIds = {};
for (const fl of doc.flows) flowMsgIds[fl.id] = new Set(fl.messages.map((m) => m.id));
for (const s of steps) {
  checkId(s.id, 'walkthrough step');
  if (stepIds.has(s.id)) err(`walkthrough duplicate step id ${s.id}`);
  stepIds.add(s.id);
  if (!s.heading || s.heading.length > 48) err(`step ${s.id} heading missing or over 48 chars`);
  if (!s.body || s.body.length > 140) err(`step ${s.id} body missing or over 140 chars`);
  if (s.stage) {
    if (s.stage.kind === 'view') {
      if (!viewIds.has(s.stage.view)) err(`BROKEN_REFERENCE step ${s.id} view "${s.stage.view}"`);
    } else if (s.stage.kind === 'flow') {
      if (!flowIds.has(s.stage.flow)) err(`BROKEN_REFERENCE step ${s.id} flow "${s.stage.flow}"`);
    } else {
      err(`step ${s.id} bad stage kind`);
    }
  }
  if (s.focus && s.focus.kind === 'selection') {
    const sel = s.focus;
    const count = (sel.lanes || []).length + (sel.nodes || []).length + (sel.edges || []).length + (sel.messages || []).length;
    if (count < 1) err(`step ${s.id} focus selection names nothing`);
    for (const id of sel.lanes || []) if (!laneIds.has(id)) err(`step ${s.id} focus lane "${id}" not declared`);
    for (const id of sel.nodes || []) if (!nodeIds.has(id)) err(`step ${s.id} focus node "${id}" not declared`);
    for (const id of sel.edges || []) if (!edgeIds.has(id)) err(`step ${s.id} focus edge "${id}" not declared`);
    const shownFlow = s.stage?.kind === 'flow' ? s.stage.flow : null;
    for (const id of sel.messages || []) {
      if (!shownFlow) err(`step ${s.id} focuses message "${id}" but stage is not a flow`);
      else if (!flowMsgIds[shownFlow].has(id)) err(`step ${s.id} focuses message "${id}" not in flow ${shownFlow}`);
    }
  } else if (s.focus && s.focus.kind !== 'all') {
    err(`step ${s.id} bad focus kind`);
  }
}

if (errors.length) {
  console.error(`INVALID (${file}) — ${errors.length} problem(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`VALID — ${doc.lanes.length} lanes, ${doc.nodes.length} nodes, ${doc.edges.length} edges, ${doc.flows.length} flows, ${roots.length} root views, ${steps.length} walkthrough steps`);
