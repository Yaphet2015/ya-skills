const fs = require('fs');

// Shared defaults let a small architecture use the same renderer as a PR report.
module.exports = function readDocument(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.edges ??= [];
  doc.flows ??= [];
  doc.stats ??= {};
  doc.stats.chips ??= [];
  doc.views ??= [];
  if (!doc.views.length) {
    doc.views.push({ id: 'overview', title: doc.title, lens: 'architecture', scope: { kind: 'all' } });
  }
  function defaults(view) {
    view.scope ??= { kind: 'all' };
    view.children ??= [];
    view.children.forEach(defaults);
  }
  doc.views.forEach(defaults);
  for (const node of doc.nodes) {
    node.files ??= [];
    node.badges ??= [];
  }
  return doc;
};
