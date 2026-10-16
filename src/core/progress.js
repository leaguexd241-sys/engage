'use strict';

/** Estados de un envío que cuentan como "hecho". */
const DONE = 'verified';
const WAITING = new Set(['pending', 'awaiting']);

/**
 * Progreso de un usuario en una tarea.
 * state: complete | pending (esperando revisión/captura) | partial | none
 */
function progressFor(task, subs) {
  const byAction = new Map();
  for (const s of subs) byAction.set(s.action, s);
  const items = task.actions.map((action) => {
    const sub = byAction.get(action) || null;
    return { action, sub, status: sub ? sub.status : 'none' };
  });
  const done = items.filter((i) => i.status === DONE).length;
  const total = items.length;
  const waiting = items.some((i) => WAITING.has(i.status));
  const touched = items.some((i) => i.status !== 'none');
  let state = 'none';
  if (total > 0 && done === total) state = 'complete';
  else if (waiting) state = 'pending';
  else if (touched) state = 'partial';
  return { items, done, total, complete: state === 'complete', state };
}

/**
 * Resumen de una tarea: quién completó, quién está pendiente, quién la dejó a medias y quién no participó.
 * @param {object} task
 * @param {object[]} subs todos los envíos de la tarea
 * @param {{source:string, members:{id:string,name?:string,avatar?:string}[]}|null} expected
 * @param {(id:string)=>object} [describe] información extra de cada usuario (nombre, @ de X)
 */
function summarize(task, subs, expected, describe = () => ({})) {
  const byUser = new Map();
  for (const s of subs) {
    if (!byUser.has(s.userId)) byUser.set(s.userId, []);
    byUser.get(s.userId).push(s);
  }

  const expectedMap = new Map((expected?.members || []).map((m) => [m.id, m]));
  const entry = (id) => ({ id, ...(expectedMap.get(id) || {}), ...describe(id) });

  const completed = [];
  const pending = [];
  const partial = [];
  for (const [userId, list] of byUser) {
    const p = progressFor(task, list);
    const e = { ...entry(userId), done: p.done, total: p.total, state: p.state, actions: Object.fromEntries(p.items.map((i) => [i.action, i.status])) };
    if (p.state === 'complete') completed.push(e);
    else if (p.state === 'pending') pending.push(e);
    else if (p.state === 'partial') partial.push(e);
  }

  const missing = [];
  for (const m of expectedMap.values()) {
    if (!byUser.has(m.id)) missing.push(entry(m.id));
  }

  const perAction = {};
  for (const a of task.actions) perAction[a] = { verified: 0, pending: 0, rejected: 0, byMethod: {} };
  let qualitySum = 0;
  let qualityCount = 0;
  for (const s of subs) {
    const pa = perAction[s.action];
    if (!pa) continue;
    if (s.status === 'verified') {
      pa.verified += 1;
      pa.byMethod[s.method] = (pa.byMethod[s.method] || 0) + 1;
      if (s.quality !== null && s.quality !== undefined) {
        qualitySum += s.quality;
        qualityCount += 1;
      }
    } else if (WAITING.has(s.status)) pa.pending += 1;
    else if (s.status === 'rejected' || s.status === 'revoked') pa.rejected += 1;
  }

  const byName = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'es');
  completed.sort(byName);
  pending.sort(byName);
  partial.sort(byName);
  missing.sort(byName);

  const expectedCount = expected ? expectedMap.size : null;
  const participants = byUser.size;
  const base = expectedCount || participants;
  return {
    taskId: task.id,
    expectedSource: expected?.source || null,
    expectedCount,
    participants,
    completed,
    pending,
    partial,
    missing,
    notCompletedCount: (expectedCount !== null ? missing.length : 0) + partial.length + pending.length,
    completionRate: base ? Math.round((completed.length / base) * 100) : 0,
    perAction,
    avgQuality: qualityCount ? Math.round(qualitySum / qualityCount) : null,
  };
}

/**
 * Detecta incoherencias entre lo declarado y lo que muestran los contadores públicos del post.
 * Si 30 personas dicen haber dado like pero el contador sólo subió 8, algo no cuadra.
 */
function computeFlags(task, subs, start, last) {
  const flags = [];
  if (!start || !last) return flags;
  const check = (action, metric, label) => {
    if (!task.actions.includes(action)) return;
    const s0 = start[metric];
    const s1 = last[metric];
    if (!Number.isFinite(s0) || !Number.isFinite(s1)) return;
    const claimed = subs.filter((s) => s.action === action && s.status === 'verified').length;
    const delta = Math.max(0, s1 - s0);
    const tolerance = Math.max(2, Math.ceil(claimed * 0.2));
    if (claimed >= 3 && claimed > delta + tolerance) {
      flags.push({
        type: `${action}_mismatch`,
        action,
        claimed,
        delta,
        message: `${claimed} miembros registraron ${label}, pero el contador público sólo subió ${delta}.`,
      });
    }
  };
  check('like', 'likes', 'like');
  check('repost', 'reposts', 'repost');
  return flags;
}

module.exports = { progressFor, summarize, computeFlags, DONE, WAITING };
