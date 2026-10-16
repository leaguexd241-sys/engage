'use strict';

class BusyError extends Error {
  constructor(message = 'The system is busy. Try again shortly.') {
    super(message);
    this.name = 'BusyError';
    this.code = 'BUSY';
  }
}

/**
 * Limita cuántas tareas asíncronas se ejecutan a la vez.
 * La cola tiene un tamaño máximo para no acumular memoria si algo externo se cuelga.
 */
class ConcurrencyLimiter {
  constructor(concurrency = 4, maxQueue = 1000) {
    this.concurrency = Math.max(1, concurrency);
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.maxQueue) {
        reject(new BusyError());
        return;
      }
      this.queue.push({ fn, resolve, reject });
      this._next();
    });
  }

  _next() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this._next();
        });
    }
  }

  get pending() {
    return this.queue.length;
  }
}

/** Ejecuta `fn` sobre cada elemento con un máximo de `concurrency` en paralelo. */
async function mapLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { ConcurrencyLimiter, BusyError, mapLimit };
