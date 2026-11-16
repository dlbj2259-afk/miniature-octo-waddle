// In-process event bus for live research activity (fanned out to SSE clients).
import { EventEmitter } from 'node:events';
import { run } from './db.js';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

/** Persist a run event and broadcast it. Text deltas are broadcast only. */
export function emitRunEvent(runId, type, message, data) {
  const evt = { run_id: runId, type, message, data: data ?? null, created_at: new Date().toISOString() };
  if (type !== 'text_delta') {
    const r = run(
      'INSERT INTO run_events(run_id, type, message, data) VALUES(?,?,?,?)',
      runId,
      type,
      String(message).slice(0, 2000),
      data == null ? null : JSON.stringify(data).slice(0, 20000)
    );
    evt.id = Number(r.lastInsertRowid);
  }
  bus.emit('event', evt);
  return evt;
}

export function emitAppEvent(type, data) {
  bus.emit('event', { type, data, created_at: new Date().toISOString() });
}
