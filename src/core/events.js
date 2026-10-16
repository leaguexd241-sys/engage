'use strict';

const { EventEmitter } = require('node:events');

/**
 * Bus de eventos interno. El panel web se suscribe para mostrar cambios en vivo.
 * Eventos: change (guildId, kind, payload), audit (entry)
 */
class EventBus extends EventEmitter {
  constructor() {
    super();
    // El panel añade un oyente por conexión SSE; el límite evita avisos falsos pero
    // cada oyente se elimina al cerrar la conexión (ver web/sse.js).
    this.setMaxListeners(200);
  }

  change(guildId, kind, payload = {}) {
    this.emit('change', { guildId, kind, payload, at: Date.now() });
  }
}

module.exports = { EventBus };
