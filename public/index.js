// Reports list page.
(async () => {
  const res = await fetch('/api/reports');
  const { reports } = await res.json();
  const container = document.getElementById('reports');
  const count = document.getElementById('report-count');
  const empty = document.getElementById('empty');

  count.textContent = `${reports.length} report${reports.length === 1 ? '' : 's'}`;

  if (reports.length === 0) {
    empty.hidden = false;
    return;
  }

  for (const r of reports) {
    container.appendChild(renderRow(r));
  }
})();

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

function chip(label, value, level) {
  if (!value) return '';
  const cls = level ? ` chip-${level}` : '';
  return `<span class="chip${cls}" title="${label}">${value}</span>`;
}

function renderRow(r) {
  const div = document.createElement('a');
  div.className = 'report-row';
  div.href = `/r/${r.id}`;

  const src = r.source ?? {};
  const sum = r.summary ?? { results: 0, error: 0, warning: 0, note: 0 };
  const tools = (sum.tools ?? []).map((t) => t.name + (t.version ? `@${t.version}` : '')).join(', ') || '—';

  const repoLabel = src.repo
    ? (src.commit ? `${src.repo}@${src.commit.slice(0, 7)}` : src.repo)
    : (src.label ?? r.id.slice(0, 8));

  div.innerHTML = `
    <div class="row-main">
      <div class="row-title">${escapeHtml(repoLabel)}</div>
      <div class="row-sub muted">
        ${escapeHtml(tools)} · ${escapeHtml(src.workflow ?? 'workflow ?')} ${src.runId ? '#' + escapeHtml(src.runId) : ''}
        ${src.branch ? ' · ' + escapeHtml(src.branch) : ''}
        ${src.pr ? ' · PR #' + escapeHtml(src.pr) : ''}
      </div>
    </div>
    <div class="row-stats">
      ${chip('errors', sum.error, 'error')}
      ${chip('warnings', sum.warning, 'warning')}
      ${chip('notes', sum.note, 'note')}
      <span class="muted small">${fmtDate(r.uploadedAt)}</span>
    </div>
  `;
  return div;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
