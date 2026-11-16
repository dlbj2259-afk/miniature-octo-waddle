// The agent loop: Claude + tool calling, persisted runs, live events.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { all, get, run, parseJson } from '../db.js';
import { getSecret } from '../secrets.js';
import { emitRunEvent, emitAppEvent } from '../events.js';
import { IntegrationMissingError } from '../integrations/errors.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { TOOL_DEFS, EXECUTORS, validateToolInput, toolSummary } from './tools.js';

let client = null;
let clientKey = null;
let fallbacksSupported = config.serverSideFallbacks;

export function claudeConfigured() {
  return Boolean(getSecret('ANTHROPIC_API_KEY'));
}

function getClient() {
  const key = getSecret('ANTHROPIC_API_KEY');
  if (!key) {
    throw new IntegrationMissingError('Claude (Anthropic API)', 'Add ANTHROPIC_API_KEY from console.anthropic.com in Agent Settings or the server environment.');
  }
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key, maxRetries: 3, timeout: 10 * 60 * 1000 });
    clientKey = key;
  }
  return client;
}

function tools() {
  const list = [...TOOL_DEFS];
  if (config.webSearchEnabled) {
    list.push({
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 10,
      user_location: { type: 'approximate', city: 'Pontiac', region: 'Michigan', country: 'US', timezone: config.timezone },
    });
  }
  return list;
}

// ---- conversation storage ----
export function createConversation(title) {
  return Number(run('INSERT INTO conversations(title) VALUES(?)', title.slice(0, 120)).lastInsertRowid);
}

function appendMessage(conversationId, role, content, runId) {
  run('INSERT INTO messages(conversation_id, role, content, run_id) VALUES(?,?,?,?)', conversationId, role, JSON.stringify(content), runId);
  run("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", conversationId);
}

function loadHistory(conversationId) {
  const msgs = all('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id', conversationId).map((m) => ({
    role: m.role,
    content: parseJson(m.content, ''),
  }));
  // Repair a history interrupted mid tool-call (e.g. server restart).
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    out.push(msgs[i]);
    const m = msgs[i];
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const uses = m.content.filter((b) => b.type === 'tool_use');
      const next = msgs[i + 1];
      const answered = next && next.role === 'user' && Array.isArray(next.content) && next.content.some((b) => b.type === 'tool_result');
      if (uses.length && !answered) {
        out.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Interrupted before this tool ran.' })) });
      }
    }
  }
  return out;
}

// ---- concurrency ----
let active = 0;
const queue = [];

function schedule(fn) {
  return new Promise((resolve) => {
    const go = async () => {
      active++;
      try {
        resolve(await fn());
      } finally {
        active--;
        const next = queue.shift();
        if (next) next();
      }
    };
    if (active < config.maxConcurrentRuns) go();
    else queue.push(go);
  });
}

export function markInterruptedRuns() {
  run("UPDATE agent_runs SET status = 'failed', error = 'Interrupted by server restart', finished_at = datetime('now') WHERE status IN ('queued','running')");
}

/**
 * Start an agent run. Returns immediately with { runId, conversationId };
 * the work continues in the background (browser can be closed).
 */
export function startRun({ prompt, conversationId = null, kind = 'chat', trigger = 'user', title = null }) {
  const convId = conversationId || createConversation(title || prompt);
  const runId = Number(
    run('INSERT INTO agent_runs(conversation_id, kind, trigger, prompt) VALUES(?,?,?,?)', convId, kind, trigger, prompt).lastInsertRowid
  );
  emitRunEvent(runId, 'status', 'Queued', { status: 'queued', conversation_id: convId, kind });
  const done = schedule(() => executeRun(runId, convId, prompt));
  return { runId, conversationId: convId, done };
}

async function executeRun(runId, conversationId, prompt) {
  run("UPDATE agent_runs SET status = 'running', started_at = datetime('now') WHERE id = ?", runId);
  emitRunEvent(runId, 'status', 'Agent started', { status: 'running' });
  const ctx = { runId, corpus: [], seenUrls: [], savedLeads: [], drafts: [], webSearches: 0 };
  const today = new Date().toLocaleDateString('en-US', { timeZone: config.timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  try {
    const anthropic = getClient();
    appendMessage(conversationId, 'user', [{ type: 'text', text: `${prompt}\n\n[Context: today is ${today}; home base ${config.homeBase.name}.]` }], runId);
    let messages = loadHistory(conversationId);
    let finalText = '';
    let jsonRetries = 0;

    for (let iter = 0; iter < config.maxAgentIterations; iter++) {
      const params = {
        model: config.model,
        max_tokens: 32000,
        system: SYSTEM_PROMPT,
        tools: tools(),
        messages,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: config.effort },
        cache_control: { type: 'ephemeral' },
      };

      let message;
      try {
        message = await streamOnce(anthropic, params, runId);
        jsonRetries = 0;
      } catch (err) {
        if (!(err instanceof Anthropic.APIError) && /json/i.test(err.message) && jsonRetries++ < 2) {
          emitRunEvent(runId, 'warning', 'Tool input was not valid JSON; retrying the turn');
          continue;
        }
        throw err;
      }

      run('UPDATE agent_runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?',
        (message.usage?.input_tokens || 0) + (message.usage?.cache_read_input_tokens || 0) + (message.usage?.cache_creation_input_tokens || 0),
        message.usage?.output_tokens || 0, runId);

      collectWebSearch(message, ctx, runId);
      messages.push({ role: 'assistant', content: message.content });
      appendMessage(conversationId, 'assistant', message.content, runId);
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text.trim()) finalText = text;

      if (message.stop_reason === 'refusal') {
        finalText = finalText || 'The model declined this request.';
        emitRunEvent(runId, 'warning', `Model declined: ${message.stop_details?.explanation || 'no details'}`);
        break;
      }
      if (message.stop_reason === 'pause_turn') continue;
      const toolUses = message.content.filter((b) => b.type === 'tool_use');
      if (message.stop_reason === 'max_tokens' && toolUses.length) {
        throw new Error('A tool call was cut off by the output limit. Try a narrower request.');
      }
      if (!toolUses.length) break;

      const results = await Promise.all(toolUses.map((tu) => runTool(tu, ctx, runId)));
      messages.push({ role: 'user', content: results });
      appendMessage(conversationId, 'user', results, runId);
      if (iter === config.maxAgentIterations - 1) {
        emitRunEvent(runId, 'warning', `Stopped after ${config.maxAgentIterations} steps (limit).`);
      }
    }

    run("UPDATE agent_runs SET status = 'succeeded', summary = ?, web_searches = ?, finished_at = datetime('now') WHERE id = ?", finalText.slice(0, 20000), ctx.webSearches, runId);
    emitRunEvent(runId, 'status', `Finished — ${ctx.savedLeads.length} lead(s) saved, ${ctx.drafts.length} draft(s) prepared`, {
      status: 'succeeded', leads: ctx.savedLeads, drafts: ctx.drafts,
    });
    return { ok: true, text: finalText, ctx };
  } catch (err) {
    const msg = describeError(err);
    run("UPDATE agent_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?", msg, runId);
    emitRunEvent(runId, 'error', msg, { status: 'failed', integration: err.integration || null });
    // Record the failure in the conversation so the chat shows it.
    appendMessage(conversationId, 'assistant', [{ type: 'text', text: `⚠️ Run failed: ${msg}` }], runId);
    return { ok: false, error: msg, ctx };
  } finally {
    emitAppEvent('run_finished', { run_id: runId, conversation_id: conversationId });
  }
}

function describeError(err) {
  if (err instanceof IntegrationMissingError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic API key was rejected (401). Check ANTHROPIC_API_KEY.';
  if (err instanceof Anthropic.PermissionDeniedError) return `Anthropic API permission denied: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic API rate limit reached. The run will need to be retried shortly.';
  if (err instanceof Anthropic.BadRequestError) return `Anthropic API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ''}: ${err.message}`;
  return err?.message || String(err);
}

async function streamOnce(anthropic, params, runId) {
  const attempt = (useFallbacks) => {
    const stream = useFallbacks
      ? anthropic.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : anthropic.messages.stream(params);
    stream.on('text', (delta) => emitRunEvent(runId, 'text_delta', delta));
    stream.on('contentBlock', (block) => {
      if (block.type === 'server_tool_use' && block.name === 'web_search') {
        emitRunEvent(runId, 'web_search', `Web search: “${block.input?.query ?? ''}”`, { query: block.input?.query });
      } else if (block.type === 'thinking' && block.thinking) {
        emitRunEvent(runId, 'thinking', block.thinking.slice(0, 600));
      } else if (block.type === 'tool_use') {
        emitRunEvent(runId, 'tool_call', describeToolCall(block.name, block.input), { tool: block.name, input: block.input });
      } else if (block.type === 'fallback') {
        emitRunEvent(runId, 'warning', `Model fallback: ${block.from?.model} → ${block.to?.model}`);
      }
    });
    return stream.finalMessage();
  };
  if (fallbacksSupported) {
    try {
      return await attempt(true);
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
        fallbacksSupported = false; // not available for this account/model; continue without
        emitRunEvent(runId, 'warning', 'Server-side model fallbacks unavailable; continuing without them.');
      } else throw err;
    }
  }
  return attempt(false);
}

function describeToolCall(name, input = {}) {
  switch (name) {
    case 'search_businesses':
      return `Searching Google Places: “${input.query}”${input.area ? ` in ${input.area}` : ''}`;
    case 'analyze_website':
      return `Reading website ${input.url}`;
    case 'search_procurement':
      return `Searching SAM.gov: “${input.keywords}”`;
    case 'save_lead':
      return `Scoring & saving ${input.name}`;
    case 'draft_outreach':
      return `Drafting ${input.kind === 'follow_up' ? 'follow-up' : 'outreach'} (${input.channel}) for lead #${input.lead_id}`;
    case 'find_leads':
      return 'Querying lead database';
    case 'get_lead':
      return `Loading lead #${input.lead_id}`;
    case 'update_lead':
      return `Updating lead #${input.lead_id}${input.stage ? ` → ${input.stage}` : ''}`;
    case 'schedule_follow_up':
      return `Scheduling follow-up for lead #${input.lead_id} on ${input.due_date}`;
    case 'pipeline_summary':
      return 'Reviewing sales pipeline';
    case 'follow_up_queue':
      return 'Checking follow-up queue';
    default:
      return `Running ${name}`;
  }
}

function collectWebSearch(message, ctx, runId) {
  for (const b of message.content) {
    if (b.type === 'server_tool_use' && b.name === 'web_search') {
      ctx.webSearches++;
      run('INSERT INTO search_history(run_id, provider, query, status) VALUES(?,?,?,?)', runId, 'claude_web_search', b.input?.query || '', 'ok');
    }
    if (b.type === 'web_search_tool_result') {
      if (Array.isArray(b.content)) {
        for (const r of b.content) {
          if (r.url) ctx.seenUrls.push(r.url);
          if (r.title) ctx.corpus.push(`${r.title} ${r.url}`);
        }
        const last = get("SELECT id FROM search_history WHERE run_id = ? AND provider = 'claude_web_search' ORDER BY id DESC LIMIT 1", runId);
        if (last) run('UPDATE search_history SET result_count = ?, results = ? WHERE id = ?', b.content.length, JSON.stringify(b.content.map((r) => ({ url: r.url, title: r.title }))), last.id);
      } else if (b.content?.error_code) {
        emitRunEvent(runId, 'warning', `Web search error: ${b.content.error_code}`);
        run("UPDATE search_history SET status = 'error', error = ? WHERE id = (SELECT MAX(id) FROM search_history WHERE run_id = ? AND provider = 'claude_web_search')", b.content.error_code, runId);
      }
    }
    if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) {
        if (c.url) ctx.seenUrls.push(c.url);
        if (c.cited_text) ctx.corpus.push(`${c.cited_text} ${c.url || ''}`);
      }
    }
  }
}

async function runTool(tu, ctx, runId) {
  const invalid = validateToolInput(tu.name, tu.input);
  if (invalid) {
    emitRunEvent(runId, 'tool_error', `${tu.name}: ${invalid}`);
    return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_INPUT: invalid }) };
  }
  const exec = EXECUTORS[tu.name];
  try {
    const result = await exec(tu.input, ctx);
    const summary = toolSummary(tu.name, result);
    emitRunEvent(runId, 'tool_result', summary, { tool: tu.name, warnings: result?.warnings, lead_id: result?.lead_id });
    if (result?.warnings?.length) emitRunEvent(runId, 'warning', result.warnings.join(' | '));
    return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 60000) };
  } catch (err) {
    const missing = err instanceof IntegrationMissingError;
    emitRunEvent(runId, missing ? 'integration_missing' : 'tool_error', `${tu.name}: ${err.message}`, { tool: tu.name, integration: err.integration || null });
    return {
      type: 'tool_result',
      tool_use_id: tu.id,
      is_error: true,
      content: missing ? `INTEGRATION_NOT_CONNECTED: ${err.message} Do not retry this tool in this run; tell the owner what to connect.` : `Error: ${err.message}`,
    };
  }
}
