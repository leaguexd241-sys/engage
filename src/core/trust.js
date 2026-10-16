'use strict';

/** Cambios de confianza por evento. La confianza va de 0 a 100 (inicio: 50). */
const TRUST_DELTA = Object.freeze({
  auto_verified: 2,
  screenshot_approved: 1,
  manual_approved: 1,
  declared: 0,
  task_completed: 1,
  task_missed: -1,
  rejected_quality: -2,
  wrong_account: -4,
  duplicate: -6,
  rejected_manual: -10,
  revoked: -12,
});

function applyTrust(current, event) {
  const delta = TRUST_DELTA[event] ?? 0;
  return Math.max(0, Math.min(100, Math.round((current ?? 50) + delta)));
}

function trustLevel(t) {
  const v = Number(t ?? 50);
  if (v >= 85) return { key: 'elite', label: 'Elite', emoji: '💎' };
  if (v >= 60) return { key: 'confiable', label: 'Trusted', emoji: '🟢' };
  if (v >= 30) return { key: 'normal', label: 'Normal', emoji: '🟡' };
  return { key: 'riesgo', label: 'At risk', emoji: '🔴' };
}

module.exports = { TRUST_DELTA, applyTrust, trustLevel };
