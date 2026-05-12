// SARIF viewer page. Renders a single report's results, with filtering by
// level and free-text search. Pure vanilla — no React/build step.

const id = location.pathname.split('/').pop();
const state = {
  meta: null,
  sarif: null,
  filter: '',
  levels: { error: true, warning: true, note: true, none: false },
};

(async () => {
  const [metaRes, sarifRes] = await Promise.all([
    fetch(`/api/reports/${id}`),
    fetch(`/api/reports/${id}/sarif`),
  ]);
  if (!metaRes.ok || !sarifRes.ok) {
    document.getElementById('results').textContent = 'Report not found.';
    return;
  }
  state.meta = await metaRes.json();
  state.sarif = await sarifRes.json();
  document.getElementById('download-raw').href = `/api/reports/${id}/sarif`;
  renderMetaBar();
  renderSummary();
  bindControls();
  renderResults();
})();

function renderMetaBar() {
  const s = state.meta.source ?? {};
  const bits = [];
  if (s.repo) bits.push(escapeHtml(s.repo));
  if (s.commit) bits.push(escapeHtml(s.commit.slice(0, 12)));
  if (s.branch) bits.push(escapeHtml(s.branch));
  if (s.workflow) bits.push(escapeHtml(s.workflow));
  if (s.runUrl) bits.push(`<a href="${escapeAttr(s.runUrl)}" target="_blank" rel="noopener">run</a>`);
  if (s.pr) bits.push(`PR #${escapeHtml(s.pr)}`);
  bits.push(new Date(state.meta.uploadedAt).toLocaleString());
  document.getElementById('meta-bar').innerHTML = bits.join(' · ');
}

function renderSummary() {
  const sum = state.meta.summary ?? {};
  const tools = (sum.tools ?? []).map((t) => t.name + (t.version ? `@${t.version}` : '')).join(', ') || 'unknown';
  document.getElementById('summary').innerHTML = `
    <div class="stat stat-error"><span class="num">${sum.error ?? 0}</span><span class="lbl">errors</span></div>
    <div class="stat stat-warning"><span class="num">${sum.warning ?? 0}</span><span class="lbl">warnings</span></div>
    <div class="stat stat-note"><span class="num">${sum.note ?? 0}</span><span class="lbl">notes</span></div>
    <div class="stat"><span class="num">${sum.results ?? 0}</span><span class="lbl">total</span></div>
    <div class="tool muted">${escapeHtml(tools)} · ${sum.runs ?? 0} run${sum.runs === 1 ? '' : 's'}</div>
  `;
}

function bindControls() {
  const f = document.getElementById('filter');
  f.addEventListener('input', () => {
    state.filter = f.value.toLowerCase().trim();
    renderResults();
  });
  for (const level of Object.keys(state.levels)) {
    const cb = document.getElementById(`lvl-${level}`);
    if (!cb) continue;
    cb.checked = state.levels[level];
    cb.addEventListener('change', () => {
      state.levels[level] = cb.checked;
      renderResults();
    });
  }
}

function collectResults() {
  const out = [];
  const runs = state.sarif.runs ?? [];
  for (let runIdx = 0; runIdx < runs.length; runIdx += 1) {
    const run = runs[runIdx];
    const rules = indexRules(run);
    const results = run.results ?? [];
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      const ruleId = r.ruleId ?? r.rule?.id ?? '(unknown)';
      const rule = rules.get(ruleId) ?? rules.get(r.rule?.id);
      const level = (r.level ?? rule?.defaultConfiguration?.level ?? 'warning').toLowerCase();
      const message = extractMessage(r, rule);
      const locs = (r.locations ?? []).map(extractLocation).filter(Boolean);
      out.push({
        runIdx,
        idx: i,
        ruleId,
        rule,
        level,
        message,
        locations: locs,
        raw: r,
      });
    }
  }
  return out;
}

function indexRules(run) {
  const map = new Map();
  const rules = run?.tool?.driver?.rules ?? [];
  for (const rule of rules) {
    if (rule?.id) map.set(rule.id, rule);
  }
  for (const ext of run?.tool?.extensions ?? []) {
    for (const rule of ext?.rules ?? []) {
      if (rule?.id) map.set(rule.id, rule);
    }
  }
  return map;
}

function extractMessage(result, rule) {
  if (result?.message?.text) return result.message.text;
  if (result?.message?.markdown) return result.message.markdown;
  if (rule?.shortDescription?.text) return rule.shortDescription.text;
  if (rule?.fullDescription?.text) return rule.fullDescription.text;
  return '(no message)';
}

function extractLocation(loc) {
  const phys = loc?.physicalLocation;
  if (!phys) return null;
  const uri = phys.artifactLocation?.uri ?? phys.artifactLocation?.uriBaseId ?? null;
  const region = phys.region ?? {};
  const startLine = region.startLine ?? null;
  const startCol = region.startColumn ?? null;
  const endLine = region.endLine ?? null;
  const snippet = region.snippet?.text ?? phys.contextRegion?.snippet?.text ?? null;
  return { uri, startLine, startCol, endLine, snippet };
}

function renderResults() {
  const container = document.getElementById('results');
  const all = collectResults();
  const filter = state.filter;
  const filtered = all.filter((r) => {
    if (!state.levels[r.level]) return false;
    if (!filter) return true;
    const hay = `${r.ruleId} ${r.message} ${r.locations.map((l) => l.uri).join(' ')}`.toLowerCase();
    return hay.includes(filter);
  });

  if (filtered.length === 0) {
    container.innerHTML = `<p class="muted">No results match the current filter.</p>`;
    return;
  }

  filtered.sort((a, b) => severityRank(b.level) - severityRank(a.level));

  const frag = document.createDocumentFragment();
  for (const r of filtered) frag.appendChild(renderResult(r));
  container.replaceChildren(frag);
}

function severityRank(level) {
  return { error: 3, warning: 2, note: 1, none: 0 }[level] ?? 0;
}

function renderResult(r) {
  const el = document.createElement('details');
  el.className = `result result-${r.level}`;

  const helpUri = r.rule?.helpUri;
  const ruleLink = helpUri
    ? `<a href="${escapeAttr(helpUri)}" target="_blank" rel="noopener">${escapeHtml(r.ruleId)}</a>`
    : escapeHtml(r.ruleId);

  const firstLoc = r.locations[0];
  const locLabel = firstLoc
    ? `${escapeHtml(firstLoc.uri ?? '(unknown)')}${firstLoc.startLine ? `:${firstLoc.startLine}${firstLoc.startCol ? `:${firstLoc.startCol}` : ''}` : ''}`
    : '(no location)';

  el.innerHTML = `
    <summary>
      <span class="level-badge level-${r.level}">${r.level}</span>
      <span class="rule">${ruleLink}</span>
      <span class="loc muted">${locLabel}</span>
      <span class="msg">${escapeHtml(truncate(r.message, 160))}</span>
    </summary>
    <div class="result-body">
      <div class="message">${escapeHtml(r.message)}</div>
      ${r.locations.length ? renderLocations(r.locations) : ''}
      ${r.rule?.helpUri ? `<div><a href="${escapeAttr(r.rule.helpUri)}" target="_blank" rel="noopener">${escapeHtml(r.rule.helpUri)}</a></div>` : ''}
      ${r.rule?.fullDescription?.text ? `<div class="rule-desc muted">${escapeHtml(r.rule.fullDescription.text)}</div>` : ''}
      <details class="raw"><summary class="muted small">raw JSON</summary><pre>${escapeHtml(JSON.stringify(r.raw, null, 2))}</pre></details>
    </div>
  `;
  return el;
}

function renderLocations(locs) {
  const items = locs.map((l) => {
    const head = `${escapeHtml(l.uri ?? '(unknown)')}${l.startLine ? `:${l.startLine}${l.startCol ? `:${l.startCol}` : ''}` : ''}${l.endLine && l.endLine !== l.startLine ? `–${l.endLine}` : ''}`;
    const snip = l.snippet ? `<pre class="snippet">${escapeHtml(l.snippet)}</pre>` : '';
    return `<li><code>${head}</code>${snip}</li>`;
  });
  return `<ul class="locations">${items.join('')}</ul>`;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s);
}
