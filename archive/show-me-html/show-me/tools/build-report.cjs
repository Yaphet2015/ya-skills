const fs = require('fs');
const path = require('path');
const { escapeHtml: h, renderArchitecture, renderFlow } = require('./render-diagrams.cjs');

const [, , graphFile, outFile, ...options] = process.argv;
const maxBytes = options.length ? Number(options[1]) : Infinity;
if (
  !graphFile ||
  !outFile ||
  (options.length &&
    (options.length !== 2 ||
      options[0] !== '--max-bytes' ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1))
) {
  console.error('usage: node build-report.cjs <graph.json> <output.html> [--max-bytes N]');
  process.exit(1);
}
const doc = require('./read-document.cjs')(graphFile);
const asset = (name) => fs.readFileSync(path.join(__dirname, '..', 'assets', name), 'utf8');
const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
const details = (id, title, body) =>
  `<details class="report-section" id="${id}"><summary>${h(title)}</summary><div class="section-body">${body}</div></details>`;
const paragraph = (value, cls = '') => (value ? `<p class="${cls}">${h(value)}</p>` : '');
const ordered = (items) =>
  `<ol>${(items || []).map((item) => `<li>${h(item)}</li>`).join('')}</ol>`;
const card = (title, body) => `<article class="card"><h3>${h(title)}</h3>${body}</article>`;

const views = [];
function addView(view, depth = 0) {
  const flow =
    view.lens === 'data-flow'
      ? doc.flows.find((item) => item.id === (view.scope.flows?.[0] || doc.flows[0]?.id))
      : undefined;
  views.push({ view, depth, flow });
  view.children.forEach((child) => addView(child, depth + 1));
}
doc.views.forEach((view) => addView(view));
// A guide may address a flow directly, even when it has no named view.
for (const flow of doc.flows) {
  if (!views.some((item) => item.flow?.id === flow.id)) {
    views.push({
      view: { id: `flow-${flow.id}`, title: flow.title, lens: 'data-flow' },
      depth: 0,
      flow,
    });
  }
}
const initial = Math.max(
  0,
  views.findIndex((item) => item.view.defaultOpen)
);
const panels = views
  .map(({ view, depth, flow }, index) => {
    const id = `view-${index}`;
    const content = flow ? renderFlow(doc, flow, id) : renderArchitecture(doc, view, id);
    return `<input class="view-radio" type="radio" name="report-view" id="${id}" ${views.length === 1 ? 'hidden' : ''} data-view="${h(view.id)}" ${flow ? `data-flow="${h(flow.id)}"` : ''} ${index === initial ? 'checked' : ''}><label class="view-label" for="${id}" ${views.length === 1 ? 'hidden' : ''}>${depth ? '↳ ' : ''}${h(view.title)}</label><section class="view-panel" aria-label="${h(view.title)}">${view.title !== doc.title ? `<h2>${h(view.title)}</h2>` : ''}${paragraph(view.summary || flow?.summary, 'muted')}${content}</section>`;
  })
  .join('');

const meta = [];
const provenance = doc.provenance;
if (provenance?.repo)
  meta.push([provenance.repo.owner, provenance.repo.name].filter(Boolean).join('/'));
if (provenance?.base && provenance?.head)
  meta.push(`${provenance.base.sha.slice(0, 8)} → ${provenance.head.sha.slice(0, 8)}`);
if (doc.stats.filesChanged !== undefined) meta.push(`${doc.stats.filesChanged} 个文件`);
if (doc.stats.additions !== undefined && doc.stats.deletions !== undefined)
  meta.push(`+${doc.stats.additions} / -${doc.stats.deletions}`);
const chips = doc.stats.chips
  .map(
    (chip) => `<span class="badge ${h(chip.tone)}">${h(chip.label)}<b>${h(chip.value)}</b></span>`
  )
  .join('');
const steps = doc.walkthrough?.steps || [];
const guide = steps.length
  ? details(
      'guide',
      `逐步理解 · ${steps.length} 步`,
      `<div class="guide-controls"><button id="guide-prev" type="button" disabled>上一步</button><button id="guide-next" type="button">下一步</button><span id="guide-count" aria-live="polite"></span></div><ol class="walkthrough">${steps.map((step, index) => `<li><details class="card"><summary data-step="${index}">${index + 1}. ${h(step.heading)}</summary>${paragraph(step.body)}</details></li>`).join('')}</ol>`
    )
  : '';

const sections = [];
if (doc.design?.length)
  sections.push(
    details(
      'sec-design',
      `为什么这样改 · ${doc.design.length} 项`,
      doc.design
        .map((decision) =>
          card(
            decision.title,
            `${paragraph(decision.context)}<ul>${decision.options.map((option) => `<li>${option.label === decision.chosen ? '<span class="badge">已选</span> ' : ''}<strong>${h(option.label)}</strong>${option.summary ? `：${h(option.summary)}` : ''}</li>`).join('')}</ul>${paragraph(decision.rationale)}`
          )
        )
        .join('')
    )
  );
if (doc.repro?.length)
  sections.push(
    details(
      'sec-repro',
      `测试覆盖 · ${doc.repro.length} 组`,
      doc.repro
        .map((entry) =>
          card(
            entry.title,
            `${entry.manual ? '<span class="badge modified">未自动化覆盖</span>' : ''}${entry.command ? `<pre><code>${h(entry.command)}</code></pre>` : ''}${entry.steps?.length ? ordered(entry.steps) : ''}${paragraph(entry.note, 'muted')}${paragraph(entry.result)}${entry.expected ? paragraph(`预期：${entry.expected}`) : ''}`
          )
        )
        .join('')
    )
  );
if (doc.testSteps?.length)
  sections.push(
    details(
      'sec-steps',
      `建议手动测试 · ${doc.testSteps.length} 组`,
      doc.testSteps
        .map((entry) =>
          card(entry.title, `${ordered(entry.steps)}${paragraph(`预期：${entry.expected}`)}`)
        )
        .join('')
    )
  );

const mime = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};
if (doc.evidence?.length) {
  const evidence = doc.evidence
    .map((entry) => {
      const absolute = path.resolve(path.dirname(path.resolve(graphFile)), entry.path);
      const uri = `data:${mime[path.extname(entry.path).slice(1).toLowerCase()]};base64,${fs.readFileSync(absolute).toString('base64')}`;
      const media =
        entry.kind === 'video'
          ? `<video controls preload="none" src="${uri}" aria-label="${h(entry.title)}"></video>`
          : `<img loading="lazy" src="${uri}" alt="${h(entry.title)}">`;
      return `<figure class="card"><h3>${h(entry.title)}</h3>${media}${entry.note ? `<figcaption>${h(entry.note)}</figcaption>` : ''}</figure>`;
    })
    .join('');
  sections.push(details('sec-evidence', `验证证据 · ${doc.evidence.length} 项`, evidence));
}
const hasMermaid = Boolean(doc.mermaid?.length);
if (hasMermaid)
  sections.push(
    details(
      'sec-mermaid',
      `补充图示 · ${doc.mermaid.length} 张`,
      doc.mermaid
        .map((entry) =>
          card(
            entry.title,
            `${paragraph(entry.summary)}<p class="mermaid-fallback muted">${entry.summary ? '图示说明见上文；可展开查看源代码。' : '此预览未显示补充图，可展开查看源代码。'}</p><div class="mermaid" hidden>${h(entry.code)}</div><details><summary>图示源代码</summary><pre><code>${h(entry.code)}</code></pre></details>`
          )
        )
        .join('')
    )
  );
const manualCount = (doc.repro || []).filter((entry) => entry.manual).length;
const legend =
  '<p class="legend">重点关系使用强调色；节点可展开查看说明与文件。<span class="added"> 新增</span> · <span class="modified">修改</span> · <span class="removed">移除</span> · 已有</p>';
const mermaidBundle = hasMermaid
  ? `<script>${fs.readFileSync(path.join(__dirname, 'vendor', 'mermaid.min.js'), 'utf8').replace(/<\/script>/gi, '<\\/script>')}</script><script>
mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'default'});
const supplement = document.getElementById('sec-mermaid');
supplement.addEventListener('toggle', async () => {
  if (!supplement.open) return;
  const pending = Array.from(supplement.querySelectorAll('.mermaid:not([data-processed])'));
  pending.forEach(element => element.hidden = false);
  try {
    await mermaid.run({nodes:pending});
    supplement.querySelectorAll('.card').forEach(card => {
      if (card.querySelector('.mermaid svg')) card.querySelector('.mermaid-fallback').hidden = true;
    });
  } catch (error) {
    pending.forEach(element => element.hidden = true);
    console.error('Supplementary diagram unavailable',error);
  }
});
</script>`
  : '';
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(doc.title)}</title><style>${asset('report.css')}</style></head><body><main>
<header><h1>${h(doc.title)}</h1><p class="summary">${h(doc.summary)}</p>${chips ? `<div class="chips">${chips}</div>` : ''}</header>
${manualCount ? `<p class="callout">${manualCount} 组测试未覆盖自动化，见“测试覆盖”。</p>` : ''}
<div class="views" role="group" aria-label="报告视图">${panels}</div>${legend}
${guide}${sections.join('')}${meta.length ? details('metadata', '来源与版本', paragraph(meta.join(' · '), 'meta')) : ''}
</main><script type="application/json" id="guide-data">${json(steps)}</script><script>${asset('report.js')}</script>${mermaidBundle}</body></html>`;
const size = Buffer.byteLength(html);
if (size > maxBytes) {
  console.error(
    `Report exceeds host size limit (${size} > ${maxBytes} bytes). Keep the summary report small and deliver large evidence separately; no output was replaced.`
  );
  process.exit(1);
}
fs.writeFileSync(outFile, html);
console.log(`wrote ${outFile} (${(size / 1024).toFixed(1)} KB)`);
