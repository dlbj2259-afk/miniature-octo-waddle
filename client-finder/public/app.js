// WoogzMadeit Client Finder — single-page UI (no build step).
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- utils ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);
const link = (u, text) => (safeUrl(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(text || hostOf(u))}</a>` : esc(text || ''));
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const money = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : `$${Math.round(Number(n)).toLocaleString('en-US')}`);
const range = (lo, hi) => (lo == null ? '—' : `${money(lo)}–${money(hi)}`);
const toDate = (s) => (s ? new Date(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z') : null);
const fmtDate = (s) => { const d = toDate(s); return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; };
const fmtTime = (s) => { const d = toDate(s); return d ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; };
const ago = (s) => { const d = toDate(s); if (!d) return ''; const m = Math.round((Date.now() - d) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; if (m < 1440) return `${Math.round(m / 60)}h ago`; return `${Math.round(m / 1440)}d ago`; };
const tierBadge = (t) => (t ? `<span class="badge ${esc(t)}">${esc(t)}</span>` : '<span class="badge">Unscored</span>');
const scoreBox = (l) => `<div class="score ${esc(l.score_tier || '')}" title="Lead score">${l.score ?? '—'}</div>`;
const CHANNEL_LABEL = { email: 'Email', instagram_dm: 'Instagram DM', facebook_message: 'Facebook Messenger', phone_script: 'Phone script', linkedin_message: 'LinkedIn', text_message: 'Text message' };

/** Minimal, safe markdown → HTML (input is escaped first). */
function md(src) {
  const lines = esc(src || '').split('\n');
  let html = '';
  let list = null;
  const inline = (t) =>
    t
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`)
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${hostOf(url.replace(/&amp;/g, '&'))}</a>`)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*(?!\s)(.+?)\*(?=\s|$|[.,;:])/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)/))) { close(); html += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if (!line.trim()) { close(); }
    else if (/^---+$/.test(line.trim())) { close(); html += '<hr>'; }
    else { close(); html += `<p>${inline(line)}</p>`; }
  }
  close();
  return `<div class="md">${html}</div>`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/api/auth')) { showLogin(); throw new Error('Please sign in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  return data;
}

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = `toast${err ? ' err' : ''}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}

function modal(html, onMount) {
  $('#modal-card').innerHTML = html;
  $('#modal').classList.remove('hidden');
  const close = () => $('#modal').classList.add('hidden');
  $$('[data-close]', $('#modal-card')).forEach((b) => b.addEventListener('click', close));
  onMount?.($('#modal-card'), close);
  return close;
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });

// ---------- state ----------
const state = { status: null, runningRuns: new Map(), currentConversation: null, liveRunId: null, liveText: '', stages: [] };

// ---------- auth ----------
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
    $('#login-error').textContent = '';
    boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.hash = ''; showLogin(); });

// ---------- navigation ----------
const NAV = [
  { group: 'Command' },
  { id: '', label: 'Today', ic: '◎', title: 'Daily Client Intelligence' },
  { id: 'chat', label: 'AI Agent Chat', ic: '✦', title: 'AI Agent Chat' },
  { id: 'activity', label: 'Live Research Activity', ic: '◉', title: 'Live Research Activity' },
  { group: 'Prospects' },
  { id: 'leads', label: 'Lead Discovery', ic: '⌕', title: 'Lead Discovery' },
  { id: 'hot', label: 'Hot Leads', ic: '🔥', title: 'Hot Leads' },
  { id: 'pipeline', label: 'Sales Pipeline', ic: '▤', title: 'Sales Pipeline' },
  { group: 'Outreach' },
  { id: 'outreach', label: 'Outreach Drafts', ic: '✉', title: 'Outreach Drafts', count: 'drafts' },
  { id: 'follow-ups', label: 'Follow-Up Queue', ic: '↻', title: 'Follow-Up Queue', count: 'followups' },
  { id: 'revenue', label: 'Revenue Opportunities', ic: '$', title: 'Revenue Opportunities' },
  { group: 'System' },
  { id: 'reports', label: 'Daily Reports', ic: '☰', title: 'Daily Reports' },
  { id: 'settings', label: 'Agent Settings', ic: '⚙', title: 'Agent Settings' },
];
const counts = { drafts: 0, followups: 0 };

function renderNav() {
  const route = (location.hash.slice(2) || '').split('/')[0];
  $('#nav').innerHTML = NAV.map((n) =>
    n.group
      ? `<div class="group">${n.group}</div>`
      : `<a href="#/${n.id}" class="${route === n.id ? 'active' : ''}"><span class="ic">${n.ic}</span>${n.label}${n.count && counts[n.count] ? `<span class="count">${counts[n.count]}</span>` : ''}</a>`
  ).join('');
}

const VIEWS = {};
async function router() {
  const [route, param] = (location.hash.slice(2) || '').split('/');
  const n = NAV.find((x) => x.id === route) || NAV[1];
  $('#page-title').textContent = n.title;
  document.title = `${n.label} · WoogzMadeit Client Finder`;
  renderNav();
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('open');
  const view = $('#view');
  view.innerHTML = '<div class="empty">Loading…</div>';
  try {
    await (VIEWS[route] || VIEWS[''])(view, param);
  } catch (e) {
    view.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', router);
$('#menu-btn').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('open'); });
$('#scrim').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('open'); });

// ---------- integration banner ----------
function renderBanner() {
  const st = state.status?.integrations;
  if (!st) return;
  const missing = Object.values(st).filter((i) => i.required && !i.connected);
  $('#banner').innerHTML = missing.length
    ? `<div class="banner"><div><strong>Connect required services to start finding clients:</strong> ${missing.map((m) => esc(m.label)).join(' · ')}. Searches will not run until these are connected.</div><a class="btn sm" href="#/settings">Open Agent Settings</a></div>`
    : '';
}

async function refreshCounts() {
  try {
    const d = await api('/api/pipeline');
    counts.drafts = d.summary.drafts_pending;
    counts.followups = d.summary.follow_ups_due;
    renderNav();
  } catch { /* ignore */ }
}

// ---------- live events (SSE) ----------
const EVT_ICON = { status: '•', tool_call: '→', tool_result: '✓', web_search: '⌕', thinking: '…', warning: '!', error: '✕', tool_error: '✕', integration_missing: '⚠' };
let es;
function connectEvents() {
  es?.close();
  es = new EventSource('/api/events');
  es.onmessage = (m) => {
    const evt = JSON.parse(m.data);
    handleEvent(evt);
  };
}

function handleEvent(evt) {
  if (evt.run_id && evt.type === 'status') {
    if (['queued', 'running'].includes(evt.data?.status)) state.runningRuns.set(evt.run_id, evt.message);
    else state.runningRuns.delete(evt.run_id);
    updateAgentPill();
  }
  if (evt.run_id && evt.type === 'tool_call') { state.runningRuns.set(evt.run_id, evt.message); updateAgentPill(); }
  if (evt.type === 'error' && evt.run_id) { state.runningRuns.delete(evt.run_id); updateAgentPill(); toast(evt.message, true); }
  if (evt.type === 'integration_missing') toast(evt.message, true);
  if (['lead_saved', 'draft_created', 'run_finished'].includes(evt.type)) refreshCounts();
  if (evt.type === 'status' && evt.data?.status === 'succeeded') toast(evt.message);
  for (const fn of listeners) fn(evt);
}
const listeners = new Set();
function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function updateAgentPill() {
  const pill = $('#agent-pill');
  const n = state.runningRuns.size;
  pill.className = `agent-pill ${n ? 'running' : 'idle'}`;
  $('.txt', pill).textContent = n ? [...state.runningRuns.values()].pop() : 'Agent idle';
}

function evtRow(e, withTitle = false) {
  return `<div class="evt ${esc(e.type)}"><div class="i">${EVT_ICON[e.type] || '·'}</div><div><div class="m">${esc(e.message)}</div><div class="when">${withTitle && e.title ? `${esc(e.title)} · ` : ''}${fmtTime(e.created_at)}</div></div></div>`;
}

// ---------- agent actions ----------
async function agentAction(body, label) {
  try {
    const r = await api('/api/agent/action', { method: 'POST', body });
    toast(`${label} started — watch Live Research Activity`);
    return r;
  } catch (e) {
    toast(e.message, true);
    if (e.data?.integration) location.hash = '#/settings';
    return null;
  }
}

function findClientsModal(prefill = {}) {
  modal(
    `<h2>⚡ Find Clients Now</h2>
     <p class="muted small">The agent searches Google Places and the public web, analyzes each business, scores it, and drafts outreach for your approval.</p>
     <form id="fc" class="grid">
       <label>Type of business<input name="industry" value="${esc(prefill.industry || '')}" placeholder="e.g. bakeries and chocolatiers" required></label>
       <div class="form-grid">
         <label>Area<input name="area" value="${esc(prefill.area || 'Pontiac, Waterford & Auburn Hills, MI')}"></label>
         <label>How many<input name="count" type="number" min="1" max="30" value="${esc(prefill.count || 10)}"></label>
       </div>
       <label>Product focus (optional)<select name="product"><option value="">Any WoogzMadeit service</option>
         ${['Custom food-grade silicone molds', 'Custom promotional products & keychains', 'Custom signage & LED displays', 'Prototyping & product development', 'Small-batch manufacturing', 'Custom branded merchandise', 'Custom 3D printing'].map((p) => `<option>${p}</option>`).join('')}
       </select></label>
       <div class="actions"><button class="btn primary" type="submit">Start search</button><button class="btn" type="button" data-close>Cancel</button></div>
     </form>`,
    (root, close) => {
      $('#fc', root).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        const r = await agentAction({ action: 'find_clients', ...f }, 'Client search');
        if (r) { close(); location.hash = `#/chat/${r.conversation_id}`; }
      });
    }
  );
}
$('#find-now').addEventListener('click', () => findClientsModal());
$('#find-now').innerHTML = '⚡ <span class="lbl">Find Clients Now</span>';

function researchModal() {
  modal(
    `<h2>Research This Business</h2>
     <form id="rb" class="grid">
       <label>Business name, website, or Instagram/Facebook URL<input name="target" required placeholder="e.g. Sweet Treats Bakery, Rochester Hills"></label>
       <div class="actions"><button class="btn primary">Research</button><button class="btn" type="button" data-close>Cancel</button></div>
     </form>`,
    (root, close) => {
      $('#rb', root).addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await agentAction({ action: 'research', target: new FormData(e.target).get('target') }, 'Research');
        if (r) { close(); location.hash = `#/chat/${r.conversation_id}`; }
      });
    }
  );
}

// ---------- VIEW: Today (dashboard) ----------
VIEWS[''] = async (view) => {
  const d = await api('/api/dashboard');
  const p = d.pipeline;
  view.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="label">New leads (24h)</div><div class="value">${d.new_leads.length}</div><div class="sub">${money(d.new_leads_est_value)} est. value</div></div>
      <div class="kpi"><div class="label">Hot / Warm leads</div><div class="value">${p.hot} <span class="muted" style="font-size:16px">/ ${p.warm}</span></div><div class="sub">open opportunities</div></div>
      <div class="kpi"><div class="label">Open pipeline (est.)</div><div class="value">${money(p.open_pipeline_est_value)}</div><div class="sub">estimates, not booked</div></div>
      <div class="kpi"><div class="label">Awaiting approval</div><div class="value">${p.drafts_pending}</div><div class="sub">outreach drafts</div></div>
      <div class="kpi"><div class="label">Follow-ups due</div><div class="value">${p.follow_ups_due}</div><div class="sub">today / overdue</div></div>
      <div class="kpi"><div class="label">Won revenue</div><div class="value">${money(p.won_revenue)}</div><div class="sub">closed sales</div></div>
    </div>
    <div class="two-col">
      <div class="grid">
        <div class="card"><h2>Recommended next actions<span class="spacer"></span><button class="btn sm" id="gen-report">Generate report</button></h2>
          <ol class="steps">${d.recommended_actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>
        </div>
        <div class="card"><h2>Highest-priority opportunities<span class="spacer"></span><a class="btn sm" href="#/hot">All hot leads</a></h2>
          <div class="list">${d.top_opportunities.length ? d.top_opportunities.map((l) => `
            <div class="row clickable" data-lead="${l.id}"><div class="score ${esc(l.tier || '')}">${l.score}</div>
              <div class="grow"><div class="title">${esc(l.name)}</div><div class="muted small">${esc(l.product || '')} · ${esc(l.stage)}</div></div>
              <div class="nowrap small hide-sm">${range(l.est_value_low, l.est_value_high)}</div></div>`).join('') : '<div class="empty">No scored leads yet. Click “Find Clients Now”.</div>'}</div>
        </div>
      </div>
      <div class="grid">
        <div class="card"><h2>Manual controls</h2>
          <div class="actions">
            <button class="btn primary" id="a-find">⚡ Find Clients Now</button>
            <button class="btn" id="a-research">🔎 Research This Business</button>
            <a class="btn" href="#/outreach">✉ Review drafts</a>
            <a class="btn" href="#/follow-ups">↻ Follow-ups</a>
          </div>
          <div class="chips" style="margin-top:12px">
            ${['Find 20 bakeries in Oakland County that could use custom silicone molds.', 'Find businesses around Pontiac that need promotional products.', 'Find 10 potential clients for custom LED signs.', 'Show me my highest-value prospects.'].map((s) => `<span class="chip s" data-ask="${esc(s)}">${esc(s)}</span>`).join('')}
          </div>
        </div>
        <div class="card"><h2>Outreach awaiting approval</h2><div class="list">${d.pending_drafts.slice(0, 6).map((x) => `
          <div class="row"><div class="grow"><div class="title">${esc(x.name)}</div><div class="muted small">${esc(CHANNEL_LABEL[x.channel] || x.channel)} · ${x.kind === 'follow_up' ? 'follow-up' : 'initial'}</div></div>${tierBadge(x.score_tier)}</div>`).join('') || '<div class="empty">Nothing waiting.</div>'}</div></div>
        <div class="card"><h2>Follow-ups due</h2><div class="list">${d.follow_ups_due.slice(0, 6).map((f) => `
          <div class="row clickable" data-lead="${f.lead_id}"><div class="grow"><div class="title">${esc(f.name)}</div><div class="muted small">${esc(f.reason || '')}</div></div><span class="small nowrap">${fmtDate(f.due_at)}</span></div>`).join('') || '<div class="empty">No follow-ups due.</div>'}</div></div>
        <div class="card"><h2>Needs more research</h2><div class="list">${d.needs_research.slice(0, 6).map((l) => `
          <div class="row clickable" data-lead="${l.id}"><div class="grow"><div class="title">${esc(l.name)}</div><div class="muted small">${esc(l.research_gaps || 'Missing contact details')}</div></div></div>`).join('') || '<div class="empty">All caught up.</div>'}</div></div>
      </div>
    </div>`;
  bindLeadClicks(view);
  $('#a-find').onclick = () => findClientsModal();
  $('#a-research').onclick = researchModal;
  $('#gen-report').onclick = async () => { await api('/api/reports', { method: 'POST', body: {} }); toast('Report generated'); location.hash = '#/reports'; };
  $$('[data-ask]', view).forEach((c) => (c.onclick = () => askAgent(c.dataset.ask)));
};

async function askAgent(message, conversationId = null) {
  try {
    const r = await api('/api/agent/chat', { method: 'POST', body: { message, conversation_id: conversationId } });
    location.hash = `#/chat/${r.conversation_id}`;
    return r;
  } catch (e) {
    toast(e.message, true);
    if (e.data?.integration) location.hash = '#/settings';
  }
}

function bindLeadClicks(root) {
  $$('[data-lead]', root).forEach((el) => el.addEventListener('click', (e) => { if (e.target.closest('a,button,select')) return; openLead(Number(el.dataset.lead)); }));
}

// ---------- VIEW: Chat ----------
let chatCleanup = null;
VIEWS.chat = async (view, convId) => {
  chatCleanup?.();
  const convs = await api('/api/conversations');
  state.currentConversation = convId ? Number(convId) : null;
  view.innerHTML = `
    <div class="chat">
      <div class="card conv-card" style="padding:0;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:12px;border-bottom:1px solid var(--line)"><a class="btn block" href="#/chat">＋ New conversation</a></div>
        <div class="conv-list">${convs.map((c) => `<div class="conv ${c.id === state.currentConversation ? 'active' : ''}" data-conv="${c.id}"><div class="t">${esc(c.title)}</div><div class="muted small">${ago(c.updated_at)}${c.last_status === 'failed' ? ' · <span style="color:var(--err)">failed</span>' : c.last_status === 'running' ? ' · running' : ''}</div></div>`).join('') || '<div class="empty small">No conversations yet</div>'}</div>
      </div>
      <div class="card chat-main">
        <div class="transcript" id="transcript"></div>
        <div class="composer">
          <div class="chips">${['Find 20 bakeries in Oakland County that could use custom silicone molds.', 'Find businesses around Pontiac that need promotional products.', 'Find 10 potential clients for custom LED signs.', 'Show me my highest-value prospects.', 'Research this company and explain how we could win their business: '].map((s) => `<span class="chip s" data-sugg="${esc(s)}">${esc(s.length > 48 ? s.slice(0, 46) + '…' : s)}</span>`).join('')}</div>
          <form id="chat-form"><textarea id="chat-input" rows="1" placeholder="Tell the agent what to do… e.g. “Find 10 schools near Troy that could use custom keychains”"></textarea><button class="btn primary" id="send">Send</button></form>
        </div>
      </div>
      <div class="card activity-card" style="padding:0;display:flex;flex-direction:column;overflow:hidden">
        <h2 style="padding:14px 14px 0">Live research activity</h2>
        <div class="activity" id="side-activity"><div class="empty small">Agent steps appear here in real time.</div></div>
      </div>
    </div>`;
  $$('[data-conv]', view).forEach((el) => (el.onclick = () => (location.hash = `#/chat/${el.dataset.conv}`)));
  $$('[data-sugg]', view).forEach((el) => (el.onclick = () => { $('#chat-input').value = el.dataset.sugg; $('#chat-input').focus(); }));
  const input = $('#chat-input');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); } });
  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = input.value.trim();
    if (!msg) return;
    $('#send').disabled = true;
    try {
      const r = await api('/api/agent/chat', { method: 'POST', body: { message: msg, conversation_id: state.currentConversation } });
      input.value = '';
      state.liveRunId = r.run_id;
      state.liveText = '';
      if (state.currentConversation !== r.conversation_id) { location.hash = `#/chat/${r.conversation_id}`; return; }
      appendUser(msg);
      ensureLiveBubble();
    } catch (err) {
      toast(err.message, true);
      if (err.data?.integration) location.hash = '#/settings';
    } finally {
      $('#send').disabled = false;
    }
  });

  if (state.currentConversation) await loadTranscript();
  else $('#transcript').innerHTML = `<div class="empty"><h3 style="margin-bottom:6px">What should the agent work on?</h3>Describe the clients you want — industry, area, product — and the agent will search, research, score and draft outreach. Every result links to its sources.</div>`;

  const off = onEvent((evt) => {
    if (!evt.run_id) {
      if (evt.type === 'run_finished' && evt.data?.conversation_id === state.currentConversation) { state.liveRunId = null; loadTranscript(); }
      return;
    }
    if (evt.run_id !== state.liveRunId) return;
    if (evt.type === 'text_delta') {
      state.liveText += evt.message;
      const b = ensureLiveBubble();
      $('.md-live', b).innerHTML = md(state.liveText);
      scrollBottom();
    } else {
      const side = $('#side-activity');
      if (side) { if (side.querySelector('.empty')) side.innerHTML = ''; side.insertAdjacentHTML('beforeend', evtRow(evt)); side.scrollTop = side.scrollHeight; }
      if (['tool_call', 'web_search'].includes(evt.type)) {
        const b = ensureLiveBubble();
        $('.chips', b).insertAdjacentHTML('beforeend', `<span class="chip">${esc(evt.message)}</span>`);
        state.liveText += '\n\n';
      }
    }
  });
  chatCleanup = () => off();
};

function scrollBottom() { const t = $('#transcript'); if (t) t.scrollTop = t.scrollHeight; }
function appendUser(text) {
  const t = $('#transcript');
  if (t.querySelector('.empty')) t.innerHTML = '';
  t.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text)}</div>`);
  scrollBottom();
}
function ensureLiveBubble() {
  let b = $('#live-bubble');
  if (!b) {
    $('#transcript').insertAdjacentHTML('beforeend', `<div class="msg assistant" id="live-bubble"><div class="bubble"><div class="chips"></div><div class="md-live typing"></div></div></div>`);
    b = $('#live-bubble');
    scrollBottom();
  }
  return b;
}

async function loadTranscript() {
  const d = await api(`/api/conversations/${state.currentConversation}`);
  const t = $('#transcript');
  if (!t) return;
  const running = d.runs.find((r) => ['queued', 'running'].includes(r.status));
  // Merge consecutive assistant items from the same run into one bubble.
  const groups = [];
  for (const it of d.items) {
    const last = groups[groups.length - 1];
    if (it.role === 'assistant' && last?.role === 'assistant' && last.run_id === it.run_id) {
      last.text += it.text ? `\n\n${it.text}` : '';
      last.tools.push(...it.tools);
      last.citations.push(...it.citations);
    } else groups.push({ ...it, tools: [...(it.tools || [])], citations: [...(it.citations || [])] });
  }
  t.innerHTML = groups.map((g) => {
    if (g.role === 'user') return `<div class="msg user">${esc(g.text)}</div>`;
    const cites = [...new Map(g.citations.map((c) => [c.url, c])).values()];
    return `<div class="msg assistant"><div class="bubble">
      ${g.tools.length ? `<details><summary class="muted small">${g.tools.length} research step(s)</summary><div class="chips">${g.tools.map((x) => `<span class="chip">${esc(x.name === 'web_search' ? `Web search: ${x.input?.query || ''}` : `${x.name}${x.input?.query ? `: ${x.input.query}` : x.input?.name ? `: ${x.input.name}` : x.input?.url ? `: ${hostOf(x.input.url)}` : ''}`)}</span>`).join('')}</div></details>` : ''}
      ${md(g.text)}
      ${cites.length ? `<div class="cites"><span class="muted">Sources:</span>${cites.slice(0, 20).map((c) => link(c.url, c.title || hostOf(c.url))).join('')}</div>` : ''}
    </div></div>`;
  }).join('');
  if (running) {
    state.liveRunId = running.id;
    state.liveText = '';
    ensureLiveBubble();
    const evts = await api(`/api/runs/${running.id}/events`);
    const side = $('#side-activity');
    if (side) side.innerHTML = evts.map((e) => evtRow(e)).join('');
  } else if (d.runs.length) {
    const evts = await api(`/api/runs/${d.runs[d.runs.length - 1].id}/events`);
    const side = $('#side-activity');
    if (side && evts.length) side.innerHTML = evts.map((e) => evtRow(e)).join('');
  }
  scrollBottom();
}

// ---------- VIEW: Live activity ----------
let actCleanup = null;
VIEWS.activity = async (view) => {
  actCleanup?.();
  const [events, runs, searches] = await Promise.all([api('/api/activity?limit=150'), api('/api/runs?limit=30'), api('/api/search-history')]);
  view.innerHTML = `
    <div class="two-col">
      <div class="card"><h2>Live feed<span class="spacer"></span><span class="badge ok">● live</span></h2><div id="feed" class="activity" style="max-height:70vh;padding:0">${events.map((e) => evtRow(e, true)).join('') || '<div class="empty">No agent activity yet.</div>'}</div></div>
      <div class="grid">
        <div class="card"><h2>Agent runs</h2><div class="list">${runs.map((r) => `
          <div class="row clickable" data-conv="${r.conversation_id}"><div class="grow"><div class="title">${esc(r.title || r.prompt)}</div><div class="muted small">${esc(r.kind)} · ${fmtTime(r.created_at)} · ${r.input_tokens + r.output_tokens} tokens${r.web_searches ? ` · ${r.web_searches} web searches` : ''}</div>${r.error ? `<div class="small" style="color:var(--err)">${esc(r.error)}</div>` : ''}</div>
          <span class="badge ${r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'err' : ''}">${esc(r.status)}</span></div>`).join('') || '<div class="empty">No runs yet.</div>'}</div></div>
        <div class="card"><h2>Search history</h2><div class="table-wrap"><table><thead><tr><th>Provider</th><th>Query</th><th>Results</th><th>When</th></tr></thead><tbody>${searches.slice(0, 60).map((s) => `
          <tr><td class="nowrap">${esc(s.provider)}</td><td>${esc(s.query)}${s.error ? `<div class="small" style="color:var(--err)">${esc(s.error)}</div>` : ''}</td><td>${s.status === 'ok' ? s.result_count ?? '—' : `<span class="badge err">${esc(s.status)}</span>`}</td><td class="nowrap small">${ago(s.created_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No searches yet.</td></tr>'}</tbody></table></div></div>
      </div>
    </div>`;
  $$('[data-conv]', view).forEach((el) => (el.onclick = () => (location.hash = `#/chat/${el.dataset.conv}`)));
  const off = onEvent((evt) => {
    if (!evt.run_id || evt.type === 'text_delta') return;
    const feed = $('#feed');
    if (!feed) return;
    if (feed.querySelector('.empty')) feed.innerHTML = '';
    feed.insertAdjacentHTML('afterbegin', evtRow(evt));
  });
  actCleanup = off;
};

// ---------- VIEW: Leads ----------
VIEWS.leads = async (view) => {
  const params = new URLSearchParams(sessionStorage.getItem('leadFilters') || '');
  view.innerHTML = `
    <div class="card">
      <div class="filters">
        <input type="search" name="q" placeholder="Search name, industry, city, need…" value="${esc(params.get('q') || '')}">
        <select name="tier"><option value="">All tiers</option>${['Hot', 'Warm', 'Cold'].map((t) => `<option ${params.get('tier') === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <select name="stage"><option value="">All stages</option>${state.stages.map((s) => `<option value="${s.id}" ${params.get('stage') === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
        <input name="city" placeholder="City" value="${esc(params.get('city') || '')}">
        <select name="sort">${[['score', 'Highest score'], ['value', 'Highest value'], ['recent', 'Newest'], ['distance', 'Closest']].map(([v, l]) => `<option value="${v}" ${params.get('sort') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div class="actions" style="margin-bottom:12px"><button class="btn primary" id="l-find">⚡ Find Clients Now</button><button class="btn" id="l-research">🔎 Research This Business</button><button class="btn" id="l-add">＋ Add lead manually</button></div>
      <div id="lead-table"></div>
    </div>`;
  const load = async () => {
    const f = Object.fromEntries($$('.filters [name]', view).map((i) => [i.name, i.value]).filter(([, v]) => v));
    sessionStorage.setItem('leadFilters', new URLSearchParams(f).toString());
    const d = await api(`/api/leads?${new URLSearchParams({ ...f, limit: 200 })}`);
    $('#lead-table').innerHTML = d.leads.length ? `
      <div class="muted small" style="margin-bottom:6px">${d.total} lead(s)</div>
      <div class="table-wrap"><table><thead><tr><th>Score</th><th>Business</th><th class="hide-sm">Recommended</th><th class="hide-sm">Location</th><th>Stage</th><th class="hide-sm">Est. value</th><th class="hide-sm">Verified</th></tr></thead><tbody>
      ${d.leads.map((l) => `<tr class="clickable" data-lead="${l.id}"><td>${scoreBox(l)}</td><td><div style="font-weight:600">${esc(l.name)}</div><div class="muted small">${esc(l.industry || l.category || '')}</div></td>
        <td class="hide-sm small">${esc((l.recommended_products || []).slice(0, 2).join(', '))}</td><td class="hide-sm small">${esc(l.city || '')}${l.distance_miles != null ? ` · ${l.distance_miles} mi` : ''}</td>
        <td><span class="badge">${esc(l.stage_label)}</span></td><td class="hide-sm small nowrap">${range(l.est_value_low, l.est_value_high)}</td><td class="hide-sm small nowrap">${fmtDate(l.last_verified_at)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No leads match. Use “Find Clients Now” to discover businesses.</div>';
    bindLeadClicks($('#lead-table'));
  };
  $$('.filters [name]', view).forEach((i) => i.addEventListener(i.tagName === 'INPUT' ? 'input' : 'change', debounce(load, 250)));
  $('#l-find').onclick = () => findClientsModal();
  $('#l-research').onclick = researchModal;
  $('#l-add').onclick = addLeadModal;
  await load();
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function addLeadModal() {
  modal(`<h2>Add lead manually</h2><form id="al" class="grid">
    <label>Business name<input name="name" required></label>
    <div class="form-grid"><label>Industry<input name="industry"></label><label>City<input name="city"></label>
    <label>Website<input name="website" type="url" placeholder="https://"></label><label>Phone<input name="phone"></label></div>
    <label>Email<input name="email" type="email"></label>
    <div class="actions"><button class="btn primary">Save</button><button class="btn" type="button" data-close>Cancel</button></div></form>`,
  (root, close) => $('#al', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api('/api/leads', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); close(); toast(r.created ? 'Lead added' : `Matched existing lead (${r.matchedOn})`); openLead(r.lead.id); }
    catch (err) { toast(err.message, true); }
  }));
}

// ---------- VIEW: Hot leads ----------
VIEWS.hot = async (view) => {
  const d = await api('/api/leads?tier=Hot&sort=score&limit=100');
  const w = await api('/api/leads?tier=Warm&sort=score&limit=12');
  const card = (l) => `<div class="card clickable" data-lead="${l.id}" style="display:grid;gap:8px">
      <div style="display:flex;gap:10px;align-items:center">${scoreBox(l)}<div class="grow" style="min-width:0"><div style="font-weight:700">${esc(l.name)}</div><div class="muted small">${esc(l.industry || '')} · ${esc(l.city || '')}${l.distance_miles != null ? ` · ${l.distance_miles} mi` : ''}</div></div>${tierBadge(l.score_tier)}</div>
      <div class="small">${esc(l.need_reason || '')}</div>
      <div class="chips">${(l.recommended_products || []).slice(0, 3).map((p) => `<span class="chip">${esc(p)}</span>`).join('')}</div>
      <div class="muted small">Est. ${range(l.est_value_low, l.est_value_high)} (estimate) · ${esc(l.stage_label)}</div>
      <div class="actions"><button class="btn sm primary" data-pitch="${l.id}">Generate pitch</button><button class="btn sm" data-research="${l.id}">Re-research</button></div>
    </div>`;
  view.innerHTML = `
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">${d.leads.map(card).join('') || '<div class="card empty">No Hot leads yet. Hot = score 70+ with cited evidence of need.</div>'}</div>
    ${w.leads.length ? `<h2 style="margin:24px 0 12px;font-size:16px">Top Warm leads</h2><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">${w.leads.map(card).join('')}</div>` : ''}`;
  bindLeadClicks(view);
  $$('[data-pitch]', view).forEach((b) => (b.onclick = () => pitchModal(Number(b.dataset.pitch))));
  $$('[data-research]', view).forEach((b) => (b.onclick = () => agentAction({ action: 'research', lead_id: Number(b.dataset.research) }, 'Research')));
};

function pitchModal(leadId) {
  modal(`<h2>Generate pitch</h2><p class="muted small">The agent writes drafts using only verified facts from this lead. Nothing is sent until you approve and send it.</p>
    <form id="pm" class="grid">${Object.entries(CHANNEL_LABEL).map(([k, v]) => `<label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" name="ch" value="${k}" style="width:auto" ${['email', 'instagram_dm', 'phone_script'].includes(k) ? 'checked' : ''}>${v}</label>`).join('')}
    <div class="actions"><button class="btn primary">Generate drafts</button><button class="btn" type="button" data-close>Cancel</button></div></form>`,
  (root, close) => $('#pm', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const channels = new FormData(e.target).getAll('ch');
    if (await agentAction({ action: 'pitch', lead_id: leadId, channels }, 'Pitch generation')) close();
  }));
}

// ---------- VIEW: Pipeline ----------
VIEWS.pipeline = async (view) => {
  const d = await api('/api/pipeline');
  view.innerHTML = `
    <div class="kpis">${d.summary.stages.filter((s) => !['new'].includes(s.stage)).slice(0, 6).map((s) => `<div class="kpi"><div class="label">${esc(s.label)}</div><div class="value">${s.count}</div><div class="sub">${money(s.est_value)} est.</div></div>`).join('')}</div>
    <div class="board">${d.columns.map((c) => `
      <div class="col" data-stage="${c.id}"><div class="col-head">${esc(c.label)} <small>${c.leads.length}</small></div>
        ${c.leads.map((l) => `<div class="deal" draggable="true" data-id="${l.id}" data-lead="${l.id}">
          <div class="t">${esc(l.name)}</div>
          <div class="meta">${tierBadge(l.score_tier)}<span>${l.score ?? '—'}</span><span>· ${money(l.potential_revenue ?? l.est_value_mid)}</span>${l.next_follow_up_at ? `<span>· ↻ ${fmtDate(l.next_follow_up_at)}</span>` : ''}</div>
          <select data-move="${l.id}" aria-label="Move stage">${state.stages.map((s) => `<option value="${s.id}" ${s.id === l.stage ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
        </div>`).join('')}
      </div>`).join('')}</div>`;
  bindLeadClicks(view);
  const move = async (id, stage) => {
    try { await api(`/api/leads/${id}`, { method: 'PATCH', body: { stage } }); toast('Stage updated'); router(); } catch (e) { toast(e.message, true); }
  };
  $$('[data-move]', view).forEach((s) => s.addEventListener('change', () => move(s.dataset.move, s.value)));
  $$('.deal', view).forEach((el) => el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', el.dataset.id)));
  $$('.col', view).forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('dragover'); move(e.dataTransfer.getData('text/plain'), col.dataset.stage); });
  });
};

// ---------- VIEW: Outreach drafts ----------
VIEWS.outreach = async (view) => {
  const status = sessionStorage.getItem('draftStatus') || 'pending';
  const drafts = await api(`/api/drafts?status=${status}`);
  view.innerHTML = `
    <div class="filters" style="max-width:420px"><select id="dstatus">${['pending', 'approved', 'sent', 'rejected', 'all'].map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${s === 'pending' ? 'Awaiting approval' : s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></div>
    <p class="muted small">The agent never sends messages. Approve a draft, then send it yourself — emails can be sent from here once SMTP is connected; DMs and scripts are copied and sent from your own accounts.</p>
    <div class="grid">${drafts.map(draftCard).join('') || '<div class="card empty">No drafts in this view.</div>'}</div>`;
  $('#dstatus').onchange = (e) => { sessionStorage.setItem('draftStatus', e.target.value); router(); };
  bindDraftActions(view);
};

function draftCard(d) {
  const social = d.social || {};
  const profile = d.channel === 'instagram_dm' ? social.instagram : d.channel === 'facebook_message' ? social.facebook : d.channel === 'linkedin_message' ? social.linkedin : null;
  const to = d.contact_email || d.lead_email;
  return `<div class="draft" data-draft="${d.id}">
    <div class="head"><strong class="clickable" data-lead="${d.lead_id}">${esc(d.lead_name)}</strong>${tierBadge(d.score_tier)}<span class="badge">${esc(CHANNEL_LABEL[d.channel] || d.channel)}</span><span class="badge">${d.kind === 'follow_up' ? 'Follow-up' : 'Initial'}</span><span class="badge ${d.status === 'approved' || d.status === 'sent' ? 'ok' : d.status === 'rejected' ? 'err' : ''}">${esc(d.status)}</span><span class="muted small" style="margin-left:auto">${ago(d.created_at)}</span></div>
    ${d.channel === 'email' ? `<div class="small"><span class="muted">To:</span> ${to ? esc(to) : '<span style="color:var(--err)">no public email on file</span>'}</div><input class="d-subject" value="${esc(d.subject || '')}" placeholder="Subject" ${d.status === 'sent' ? 'disabled' : ''}>` : ''}
    ${d.channel === 'phone_script' && d.lead_phone ? `<div class="small"><span class="muted">Call:</span> <a href="tel:${esc(d.lead_phone)}">${esc(d.lead_phone)}</a></div>` : ''}
    ${profile ? `<div class="small"><span class="muted">Profile:</span> ${link(profile)}</div>` : ''}
    <textarea class="d-body" rows="7" ${d.status === 'sent' ? 'disabled' : ''}>${esc(d.body)}</textarea>
    <div class="actions">
      ${d.status === 'pending' ? `<button class="btn sm primary" data-act="approve">✓ Approve</button><button class="btn sm" data-act="save">Save edits</button><button class="btn sm danger" data-act="reject">Reject</button>` : ''}
      ${d.status === 'approved' && d.channel === 'email' && to ? `<button class="btn sm dark" data-act="send">Send email…</button>` : ''}
      ${d.status === 'approved' ? `<button class="btn sm" data-act="mark-sent">Mark as sent</button>` : ''}
      <button class="btn sm" data-act="copy">Copy</button>
    </div></div>`;
}

function bindDraftActions(root) {
  bindLeadClicks(root);
  $$('.draft', root).forEach((el) => {
    const id = el.dataset.draft;
    const body = () => ({ body: $('.d-body', el).value, subject: $('.d-subject', el)?.value });
    $$('[data-act]', el).forEach((b) => (b.onclick = async () => {
      try {
        const act = b.dataset.act;
        if (act === 'copy') { await navigator.clipboard.writeText(($('.d-subject', el)?.value ? `Subject: ${$('.d-subject', el).value}\n\n` : '') + $('.d-body', el).value); return toast('Copied'); }
        if (act === 'save') await api(`/api/drafts/${id}`, { method: 'PATCH', body: body() });
        if (act === 'approve') await api(`/api/drafts/${id}`, { method: 'PATCH', body: { ...body(), status: 'approved' } });
        if (act === 'reject') await api(`/api/drafts/${id}`, { method: 'PATCH', body: { status: 'rejected' } });
        if (act === 'mark-sent') await api(`/api/drafts/${id}`, { method: 'PATCH', body: { status: 'sent' } });
        if (act === 'send') {
          if (!confirm('Send this email now from your connected mailbox?')) return;
          await api(`/api/drafts/${id}/send`, { method: 'POST', body: { confirm: true } });
        }
        toast({ save: 'Saved', approve: 'Approved', reject: 'Rejected', 'mark-sent': 'Marked as sent — lead moved to Contacted', send: 'Email sent' }[act]);
        refreshCounts();
        if ($('#drawer:not(.hidden)')) openLead(Number($('#drawer-panel').dataset.lead)); else router();
      } catch (e) { toast(e.message, true); }
    }));
  });
}

// ---------- VIEW: Follow-ups ----------
VIEWS['follow-ups'] = async (view) => {
  const rows = await api('/api/follow-ups');
  const now = Date.now();
  const section = (title, list) => `<div class="card"><h2>${title} <span class="muted small">${list.length}</span></h2><div class="list">${list.map((f) => `
    <div class="row" data-lead="${f.lead_id}"><div class="score ${esc(f.score_tier || '')}">${f.score ?? '—'}</div><div class="grow clickable"><div class="title">${esc(f.name)}</div><div class="muted small">${esc(f.reason || '')} · due ${fmtDate(f.due_at)}</div></div>
    <div class="actions"><button class="btn sm primary" data-prep="${f.lead_id}">Prepare follow-up</button><button class="btn sm" data-done="${f.id}">Done</button><button class="btn sm ghost" data-skip="${f.id}">Skip</button></div></div>`).join('') || '<div class="empty">None.</div>'}</div></div>`;
  const overdue = rows.filter((r) => toDate(r.due_at) < now - 864e5);
  const today = rows.filter((r) => toDate(r.due_at) >= now - 864e5 && toDate(r.due_at) <= now + 864e5);
  const later = rows.filter((r) => toDate(r.due_at) > now + 864e5);
  view.innerHTML = `<div class="grid">${section('Overdue', overdue)}${section('Due today', today)}${section('Upcoming', later)}</div>`;
  bindLeadClicks(view);
  $$('[data-prep]', view).forEach((b) => (b.onclick = () => agentAction({ action: 'follow_up', lead_id: Number(b.dataset.prep) }, 'Follow-up preparation')));
  $$('[data-done]', view).forEach((b) => (b.onclick = async () => { await api(`/api/follow-ups/${b.dataset.done}/complete`, { method: 'POST', body: {} }); refreshCounts(); router(); }));
  $$('[data-skip]', view).forEach((b) => (b.onclick = async () => { await api(`/api/follow-ups/${b.dataset.skip}/complete`, { method: 'POST', body: { status: 'skipped' } }); refreshCounts(); router(); }));
};

// ---------- VIEW: Revenue ----------
VIEWS.revenue = async (view) => {
  const d = await api('/api/revenue');
  const s = d.summary;
  view.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="label">Open pipeline (est.)</div><div class="value">${money(s.open_pipeline_est_value)}</div><div class="sub">estimates from public info</div></div>
      <div class="kpi"><div class="label">Open quotes</div><div class="value">${money(s.quotes_open_value)}</div><div class="sub">draft + sent</div></div>
      <div class="kpi"><div class="label">Won revenue</div><div class="value">${money(s.won_revenue)}</div><div class="sub">${d.won.length} customer(s)</div></div>
    </div>
    <div class="two-col">
      <div class="card"><h2>Revenue opportunities</h2><div class="table-wrap"><table><thead><tr><th>Business</th><th>Stage</th><th>Est. annual value</th><th class="hide-sm">Basis</th></tr></thead><tbody>
        ${d.opportunities.map((l) => `<tr class="clickable" data-lead="${l.id}"><td><strong>${esc(l.name)}</strong><div class="muted small">${tierBadge(l.score_tier)} ${l.score ?? ''}</div></td><td><span class="badge">${esc(l.stage_label)}</span></td><td class="nowrap">${l.potential_revenue ? `${money(l.potential_revenue)} <span class="muted small">(quoted)</span>` : range(l.est_value_low, l.est_value_high)}</td><td class="hide-sm small muted">${esc(l.est_value_basis || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No opportunities yet.</td></tr>'}
      </tbody></table></div></div>
      <div class="grid">
        <div class="card"><h2>Quotes</h2><div class="list">${d.quotes.map((q) => `<div class="row" data-lead="${q.lead_id}"><div class="grow clickable"><div class="title">${esc(q.name)}</div><div class="muted small">${esc(q.description)}</div></div><strong>${money(q.amount)}</strong><span class="badge ${q.status === 'accepted' ? 'ok' : q.status === 'rejected' ? 'err' : ''}">${esc(q.status)}</span></div>`).join('') || '<div class="empty">No quotes yet. Add quotes from a lead.</div>'}</div></div>
        <div class="card"><h2>Completed sales</h2><div class="list">${d.won.map((w) => `<div class="row clickable" data-lead="${w.id}"><div class="grow"><div class="title">${esc(w.name)}</div><div class="muted small">${fmtDate(w.updated_at)}</div></div><strong>${money(w.won_revenue)}</strong></div>`).join('') || '<div class="empty">No won deals yet.</div>'}</div></div>
      </div>
    </div>`;
  bindLeadClicks(view);
};

// ---------- VIEW: Reports ----------
VIEWS.reports = async (view, id) => {
  const [list, current] = await Promise.all([api('/api/reports'), id ? api(`/api/reports/${id}`) : api('/api/reports/latest')]);
  view.innerHTML = `
    <div class="two-col">
      <div class="card report"><h2>${current.preview ? 'Preview (not yet generated)' : `Report — ${esc(current.report_date)}`}<span class="spacer"></span><button class="btn sm" id="r-gen">Generate now</button><button class="btn sm" id="r-email">Generate + email</button></h2>
        ${current.email_error ? `<p class="error small">Email not sent: ${esc(current.email_error)}</p>` : current.emailed_at ? `<p class="small muted">Emailed ${fmtTime(current.emailed_at)}</p>` : ''}
        ${md(current.markdown)}</div>
      <div class="card"><h2>History</h2><div class="list">${list.map((r) => `<div class="row clickable" data-report="${r.id}"><div class="grow"><div class="title">${esc(r.report_date)}</div><div class="muted small">${fmtTime(r.created_at)}${r.emailed_at ? ' · emailed' : ''}</div></div></div>`).join('') || '<div class="empty">No reports yet. The scheduler generates one every morning.</div>'}</div></div>
    </div>`;
  $$('[data-report]', view).forEach((el) => (el.onclick = () => (location.hash = `#/reports/${el.dataset.report}`)));
  $('#r-gen').onclick = async () => { const r = await api('/api/reports', { method: 'POST', body: {} }); location.hash = `#/reports/${r.id}`; };
  $('#r-email').onclick = async () => { const r = await api('/api/reports', { method: 'POST', body: { email: true } }); if (r.email_error) toast(`Email not sent: ${r.email_error}`, true); else toast('Report emailed'); location.hash = `#/reports/${r.id}`; };
};

// ---------- VIEW: Settings ----------
VIEWS.settings = async (view) => {
  const [st, settings, schedules] = await Promise.all([api('/api/status'), api('/api/settings'), api('/api/schedules')]);
  state.status = st;
  renderBanner();
  const secretFor = { claude: 'ANTHROPIC_API_KEY', google_places: 'GOOGLE_PLACES_API_KEY', sam_gov: 'SAM_GOV_API_KEY', email: 'SMTP_PASS' };
  view.innerHTML = `
    <div class="two-col">
      <div class="grid">
        <div class="card integrations"><h2>Connected services</h2>
          <p class="muted small">Keys entered here are encrypted at rest (AES-256-GCM) and never sent back to the browser. Keys set as server environment variables take precedence.</p>
          <div class="list">${Object.entries(st.integrations).map(([k, i]) => {
            const sec = st.secrets.find((s) => s.name === secretFor[k]);
            return `<div class="row" style="flex-wrap:wrap"><div class="grow"><div class="title">${esc(i.label)} ${i.required ? '<span class="badge">required</span>' : '<span class="badge">optional</span>'}</div><div class="muted small">${esc(i.how)}</div>
              ${sec && sec.source !== 'environment' ? `<form class="key-form" data-secret="${sec.name}" style="display:flex;gap:6px;margin-top:6px"><input type="password" autocomplete="off" placeholder="${sec.configured ? '•••••••• (stored) — enter to replace' : `Paste ${sec.name}`}"><button class="btn sm">Save</button>${sec.configured ? `<button class="btn sm danger" type="button" data-clear="${sec.name}">Remove</button>` : ''}</form>` : sec ? '<div class="small muted">Set via server environment.</div>' : ''}</div>
              <span class="status badge ${i.connected ? 'ok' : 'err'}">${i.connected ? 'Connected' : 'Not connected'}</span></div>`;
          }).join('')}</div></div>
        <div class="card"><h2>Scheduled agent jobs</h2><p class="muted small">Runs on the server (time zone ${esc(st.timezone)}) — no browser needed.${st.scheduler ? '' : ' <strong style="color:var(--err)">Scheduler disabled (ENABLE_SCHEDULER=false).</strong>'}</p>
          <div class="list">${schedules.map((s) => `<div class="row" style="flex-wrap:wrap"><div class="grow"><div class="title">${esc(s.name)}</div><div class="muted small">Next: ${fmtTime(s.next_run_at)} · Last: ${s.last_run_at ? `${fmtTime(s.last_run_at)} — ${esc(s.last_status || '')}` : 'never'}</div></div>
            ${s.daily_time ? `<input type="time" value="${esc(s.daily_time)}" data-time="${s.id}" style="width:auto">` : '<span class="small muted">weekly</span>'}
            <label style="display:flex;gap:6px;align-items:center;font-weight:500"><input type="checkbox" data-enable="${s.id}" ${s.enabled ? 'checked' : ''} style="width:auto">On</label>
            <button class="btn sm" data-runnow="${s.id}">Run now</button></div>`).join('')}</div></div>
      </div>
      <div class="card"><h2>Agent settings</h2>
        <form id="settings-form" class="grid">
          <label>Target cities (one per line)<textarea name="target_cities" rows="6">${esc(settings.target_cities.join('\n'))}</textarea></label>
          <label>Search scope for scheduled sweeps<select name="search_scope">${[['local', 'Home territory (metro Detroit)'], ['michigan', 'All of Michigan'], ['nationwide', 'Nationwide']].map(([v, l]) => `<option value="${v}" ${settings.search_scope === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Priority industries (rotation order, one per line)<textarea name="priority_industries" rows="8">${esc(settings.priority_industries.join('\n'))}</textarea></label>
          <div class="form-grid">
            <label>New leads per daily sweep<input name="daily_new_lead_target" type="number" min="1" max="30" value="${settings.daily_new_lead_target}"></label>
            <label>Min score to auto-draft outreach<input name="min_score_to_draft" type="number" min="0" max="100" value="${settings.min_score_to_draft}"></label>
          </div>
          <label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" name="report_email_enabled" style="width:auto" ${settings.report_email_enabled ? 'checked' : ''}>Email the daily report</label>
          <label>Report recipient<input name="report_email_to" type="email" value="${esc(settings.report_email_to || '')}" placeholder="you@yourbusiness.com"></label>
          <div class="muted small">Model: ${esc(st.integrations.claude.model)} · Home base: ${esc(st.home_base.name)} · Web search ${st.integrations.claude.web_search ? 'enabled' : 'disabled'}</div>
          <div class="actions"><button class="btn primary">Save settings</button></div>
        </form></div>
    </div>`;
  $$('.key-form', view).forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = $('input', f).value.trim();
    if (!value) return;
    try { await api(`/api/secrets/${f.dataset.secret}`, { method: 'PUT', body: { value } }); toast('Key saved (encrypted)'); router(); } catch (err) { toast(err.message, true); }
  }));
  $$('[data-clear]', view).forEach((b) => (b.onclick = async () => { if (!confirm('Remove this key?')) return; await api(`/api/secrets/${b.dataset.clear}`, { method: 'PUT', body: { value: '' } }); router(); }));
  $$('[data-enable]', view).forEach((c) => (c.onchange = () => api(`/api/schedules/${c.dataset.enable}`, { method: 'PATCH', body: { enabled: c.checked } }).then(() => toast('Schedule updated'))));
  $$('[data-time]', view).forEach((c) => (c.onchange = () => api(`/api/schedules/${c.dataset.time}`, { method: 'PATCH', body: { daily_time: c.value } }).then(() => { toast('Time updated'); router(); }).catch((e) => toast(e.message, true))));
  $$('[data-runnow]', view).forEach((b) => (b.onclick = async () => { try { const r = await api(`/api/schedules/${b.dataset.runnow}/run`, { method: 'POST', body: {} }); toast(r.message); } catch (e) { toast(e.message, true); } }));
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const lines = (k) => String(f.get(k) || '').split('\n').map((s) => s.trim()).filter(Boolean);
    await api('/api/settings', { method: 'PUT', body: {
      target_cities: lines('target_cities'), priority_industries: lines('priority_industries'), search_scope: f.get('search_scope'),
      daily_new_lead_target: Number(f.get('daily_new_lead_target')), min_score_to_draft: Number(f.get('min_score_to_draft')),
      report_email_enabled: f.get('report_email_enabled') === 'on', report_email_to: f.get('report_email_to'),
    } });
    toast('Settings saved');
  });
};

// ---------- Lead drawer ----------
const FACTOR_LABEL = { service_match: 'Service match', purchase_evidence: 'Evidence of need', size_value: 'Size / order value', distance: 'Distance', upcoming_signals: 'Upcoming events', likelihood: 'Likelihood to buy' };
async function openLead(id) {
  const l = await api(`/api/leads/${id}`);
  const panel = $('#drawer-panel');
  panel.dataset.lead = id;
  const social = Object.entries(l.social || {}).filter(([, u]) => safeUrl(u));
  panel.innerHTML = `
    <div class="drawer-head">${scoreBox(l)}<div class="grow" style="min-width:0"><h2>${esc(l.name)}</h2><div class="muted">${esc(l.industry || l.category || '')} · ${esc([l.city, l.state].filter(Boolean).join(', '))}${l.distance_miles != null ? ` · ${l.distance_miles} mi from Pontiac` : ''}</div>
      <div class="chips">${tierBadge(l.score_tier)}<span class="badge">${esc(l.stage_label)}</span><span class="badge">${esc(l.research_status)}</span></div></div>
      <button class="icon-btn" id="drawer-close" aria-label="Close">✕</button></div>
    <div class="actions" style="margin-bottom:14px">
      <button class="btn sm primary" id="d-pitch">✉ Generate Pitch</button><button class="btn sm" id="d-fu">↻ Prepare Follow-Up</button><button class="btn sm" id="d-research">🔎 Research Again</button>
      <select id="d-stage" style="width:auto">${state.stages.map((s) => `<option value="${s.id}" ${s.id === l.stage ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
    </div>
    <div class="grid">
      <div class="card"><h2>Why WoogzMadeit fits</h2><p>${esc(l.need_reason || 'Not yet analyzed.')}</p>
        <div class="chips">${l.recommended_products.map((p) => `<span class="chip">${esc(p)}</span>`).join('')}</div>
        <p class="small"><strong>Estimated opportunity:</strong> ${range(l.est_value_low, l.est_value_high)} <span class="muted">(estimate${l.est_value_basis ? ` — ${esc(l.est_value_basis)}` : ''})</span></p></div>
      <div class="card"><h2>Score breakdown <span class="spacer"></span><span class="muted small">${l.score ?? '—'}/100</span></h2>
        <div class="breakdown">${Object.entries(l.score_breakdown || {}).map(([k, b]) => `<div class="b"><div>${FACTOR_LABEL[k] || k}</div><div class="bar"><span style="width:${(b.points / b.weight) * 100}%"></span></div><div class="nowrap small">${b.points}/${b.weight}</div><div class="why">${esc(b.reason || '')}</div></div>`).join('') || '<div class="empty">Not scored yet.</div>'}</div></div>
      <div class="card"><h2>Evidence</h2>${l.evidence.length ? `<div class="list">${l.evidence.map((e) => `<div class="row"><div class="grow"><div>${esc(e.claim)}</div>${e.quote ? `<div class="muted small">“${esc(e.quote)}”</div>` : ''}<div class="small">${link(e.source_url)} · <span class="muted">${esc(e.kind)}</span></div></div></div>`).join('')}</div>` : '<p class="muted">No cited evidence of purchasing intent yet — the score reflects fit only.</p>'}
        ${l.research_gaps ? `<p class="small"><strong>Research gaps:</strong> ${esc(l.research_gaps)}</p>` : ''}</div>
      <div class="card"><h2>Contact (public business info)</h2><dl class="kv">
        <dt>Website</dt><dd>${link(l.website) || '—'}</dd>
        <dt>Business email</dt><dd>${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>${l.email_source_url ? ` <span class="small">(${link(l.email_source_url, 'source')})</span>` : ''}` : '<span class="muted">Not found publicly</span>'}</dd>
        <dt>Business phone</dt><dd>${l.phone ? `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : '<span class="muted">Not found</span>'}</dd>
        <dt>Decision-maker</dt><dd>${l.contact_name ? `${esc(l.contact_name)}${l.contact_title ? `, ${esc(l.contact_title)}` : ''}${l.contact_email ? ` · ${esc(l.contact_email)}` : ''}${l.contact_phone ? ` · ${esc(l.contact_phone)}` : ''} ${l.contact_source_url ? `<span class="small">(${link(l.contact_source_url, 'source')})</span>` : ''}` : '<span class="muted">Not publicly listed</span>'}</dd>
        <dt>Address</dt><dd>${esc(l.address || '—')} ${l.google_maps_url ? link(l.google_maps_url, 'Map') : ''}</dd>
        <dt>Social</dt><dd>${social.map(([k, u]) => link(u, k)).join(' · ') || '—'}</dd>
        <dt>Google rating</dt><dd>${l.rating ? `${l.rating} ★ (${l.review_count} reviews)` : '—'}</dd>
        <dt>Last verified</dt><dd>${fmtTime(l.last_verified_at)}</dd>
      </dl></div>
      <div class="card"><h2>Outreach drafts</h2><div class="grid">${l.drafts.map((d) => draftCard({ ...d, lead_name: l.name, lead_email: l.email, contact_email: l.contact_email, score_tier: l.score_tier, social: l.social, lead_phone: l.phone })).join('') || '<p class="muted">No drafts yet — click Generate Pitch.</p>'}</div></div>
      <div class="card"><h2>Log conversation / note</h2><form id="d-act" class="grid"><div class="form-grid"><select name="type"><option value="note">Note</option><option value="call">Phone call</option><option value="email">Email</option><option value="dm">DM</option><option value="meeting">Meeting</option><option value="reply">They replied</option></select><input name="due_date" type="date" title="Schedule follow-up (optional)"></div><textarea name="summary" rows="3" placeholder="What happened?" required></textarea><button class="btn sm primary" style="justify-self:start">Save to history</button></form></div>
      <div class="card"><h2>Quotes</h2><div class="list">${l.quotes.map((q) => `<div class="row"><div class="grow"><div class="title">${esc(q.description)}</div><div class="muted small">${fmtDate(q.created_at)}</div></div><strong>${money(q.amount)}</strong><select data-quote="${q.id}" style="width:auto">${['draft', 'sent', 'accepted', 'rejected'].map((s) => `<option ${s === q.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>`).join('')}</div>
        <form id="d-quote" class="form-grid" style="margin-top:8px"><input name="description" placeholder="e.g. 200 custom logo chocolate molds" required><div style="display:flex;gap:6px"><input name="amount" type="number" step="0.01" min="0" placeholder="$" required><select name="status" style="width:auto"><option value="draft">draft</option><option value="sent">sent</option></select><button class="btn sm">Add</button></div></form></div>
      <div class="card"><h2>Follow-ups</h2><div class="list">${l.follow_ups.map((f) => `<div class="row"><div class="grow">${fmtDate(f.due_at)} — ${esc(f.reason || '')}</div><span class="badge ${f.status === 'done' ? 'ok' : ''}">${esc(f.status)}</span></div>`).join('') || '<p class="muted">None scheduled.</p>'}</div></div>
      <div class="card"><h2>History</h2><div class="list">${l.activities.map((a) => `<div class="row"><div class="grow"><div>${esc(a.summary)}</div><div class="muted small">${esc(a.type)} · ${fmtTime(a.created_at)}</div></div></div>`).join('')}</div></div>
      <div class="card"><h2>Sources</h2><div class="list">${l.sources.map((s) => `<div class="row"><div class="grow">${link(s.url, s.title || s.url)}<div class="muted small">${esc(s.source_type || '')} · retrieved ${fmtDate(s.retrieved_at)}</div></div></div>`).join('') || '<p class="muted">No sources.</p>'}</div></div>
      <div class="actions"><button class="btn sm danger" id="d-archive">${l.archived ? 'Unarchive' : 'Archive lead'}</button></div>
    </div>`;
  $('#drawer').classList.remove('hidden');
  $('#drawer-close').onclick = closeDrawer;
  $('#d-pitch').onclick = () => pitchModal(id);
  $('#d-fu').onclick = () => agentAction({ action: 'follow_up', lead_id: id }, 'Follow-up preparation');
  $('#d-research').onclick = () => agentAction({ action: 'research', lead_id: id }, 'Research');
  $('#d-stage').onchange = async (e) => { await api(`/api/leads/${id}`, { method: 'PATCH', body: { stage: e.target.value } }); toast('Stage updated'); openLead(id); };
  $('#d-archive').onclick = async () => { await api(`/api/leads/${id}`, { method: 'PATCH', body: { archived: l.archived ? 0 : 1 } }); closeDrawer(); router(); };
  $('#d-act').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    await api(`/api/leads/${id}/activities`, { method: 'POST', body: { type: f.type, summary: f.summary } });
    if (f.due_date) await api(`/api/leads/${id}/follow-ups`, { method: 'POST', body: { due_date: f.due_date, reason: f.summary.slice(0, 140) } });
    if (f.type === 'reply' && ['contacted', 'qualified', 'researched', 'new'].includes(l.stage)) await api(`/api/leads/${id}`, { method: 'PATCH', body: { stage: 'interested' } });
    toast('Saved');
    openLead(id);
  });
  $('#d-quote').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api(`/api/leads/${id}/quotes`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Quote added'); openLead(id); } catch (err) { toast(err.message, true); }
  });
  $$('[data-quote]', panel).forEach((s) => (s.onchange = async () => { await api(`/api/quotes/${s.dataset.quote}`, { method: 'PATCH', body: { status: s.value } }); toast('Quote updated'); openLead(id); }));
  bindDraftActions(panel);
}
function closeDrawer() { $('#drawer').classList.add('hidden'); }
$('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); $('#modal').classList.add('hidden'); } });

// ---------- boot ----------
async function boot() {
  try {
    await api('/api/auth/me');
  } catch {
    return showLogin();
  }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  state.status = await api('/api/status');
  state.stages = state.status.stages;
  renderBanner();
  connectEvents();
  const runs = await api('/api/runs?limit=10');
  for (const r of runs) if (['queued', 'running'].includes(r.status)) state.runningRuns.set(r.id, r.title || 'Working…');
  updateAgentPill();
  refreshCounts();
  router();
}
boot();
