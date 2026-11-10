// Optional guided focus. Reading, view selection and disclosure also work without this script.
const steps = JSON.parse(document.getElementById('guide-data').textContent);
const guide = document.getElementById('guide');
if (guide && steps.length) {
  document.documentElement.classList.add('enhanced');
  let current = -1;
  function reset() {
    document
      .querySelectorAll('.dim, [data-step].active')
      .forEach((element) => element.classList.remove('dim', 'active'));
  }
  function showStep(index) {
    if (index < 0 || index >= steps.length) return;
    current = index;
    const step = steps[index];
    reset();
    const radio = Array.from(document.querySelectorAll('.view-radio')).find((input) =>
      step.stage?.kind === 'flow'
        ? input.dataset.flow === step.stage.flow
        : input.dataset.view === step.stage?.view
    );
    if (radio) radio.checked = true;
    const selected = document.querySelector('.view-radio:checked');
    const panel = selected?.nextElementSibling?.nextElementSibling;
    const focus = step.focus;
    if (panel && focus && focus.kind !== 'all') {
      panel.querySelectorAll('[data-focusable]').forEach((element) => {
        const active =
          (focus.nodes || []).includes(element.dataset.node) ||
          (focus.edges || []).includes(element.dataset.edge) ||
          (focus.messages || []).includes(element.dataset.message);
        element.classList.toggle('dim', !active);
      });
    }
    const heading = guide.querySelector(`[data-step="${index}"]`);
    heading?.classList.add('active');
    if (heading) heading.parentElement.open = true;
    document.getElementById('guide-count').textContent = `${index + 1} / ${steps.length}`;
    document.getElementById('guide-prev').disabled = index === 0;
    document.getElementById('guide-next').disabled = index === steps.length - 1;
  }
  // Listen after the native disclosure action; click handlers can undo its toggle.
  guide.querySelectorAll('[data-step]').forEach((heading) =>
    heading.parentElement.addEventListener('toggle', () => {
      if (heading.parentElement.open && current !== Number(heading.dataset.step)) {
        showStep(Number(heading.dataset.step));
      }
    })
  );
  document.getElementById('guide-prev').addEventListener('click', () => showStep(current - 1));
  document.getElementById('guide-next').addEventListener('click', () => showStep(current + 1));
  guide.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      showStep(current + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
  document
    .querySelectorAll('.view-radio')
    .forEach((radio) => radio.addEventListener('change', reset));
}
