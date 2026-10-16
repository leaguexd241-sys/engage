'use strict';

const express = require('express');
const { isUserError } = require('../core/errors');

/** Rutas del simulador (sólo existen en modo demo/simulador). */
function createSimApi({ sim, log }) {
  const r = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req.body || {}, req));
    } catch (err) {
      if (isUserError(err)) return res.status(400).json({ ok: false, error: err.message });
      log.error('Error en el simulador:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
    return undefined;
  };

  r.get('/state', (req, res) => {
    try {
      res.json(sim.state(String(req.query.user || ''), String(req.query.channel || '')));
    } catch (err) {
      log.error('Error leyendo el estado del simulador:', err);
      res.status(500).json({ error: err.message });
    }
  });
  r.post('/command', wrap((b) => sim.command(b)));
  r.post('/button', wrap((b) => sim.button(b)));
  r.post('/modal', wrap((b) => sim.modal(b)));
  r.post('/modal/cancel', wrap((b) => sim.cancelModal(b.userId)));
  r.post('/autocomplete', wrap((b) => sim.autocomplete(b)));
  r.post('/x', wrap((b) => sim.xAction(b)));
  r.post('/advance', wrap((b) => sim.advance(b)));
  return r;
}

module.exports = { createSimApi };
