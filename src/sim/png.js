'use strict';

const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * Genera un PNG sencillo (sin dependencias). `paint(x, y)` devuelve [r, g, b].
 * Se usa para las capturas de ejemplo del simulador y en las pruebas.
 */
function makePng(width, height, paint) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profundidad
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Imagen de ejemplo tipo "captura": fondo oscuro, barra azul y un corazón rojo. */
function sampleProofPng() {
  const w = 360;
  const h = 200;
  return makePng(w, h, (x, y) => {
    if (y < 34) return [21, 32, 43];
    const hx = (x - 60) / 26;
    const hy = (120 - y) / 24;
    const heart = (hx * hx + hy * hy - 1) ** 3 - hx * hx * hy * hy * hy < 0;
    if (heart) return [249, 24, 128];
    if (y > 150 && y < 162 && x > 110 && x < 330) return [113, 118, 123];
    if (y > 95 && y < 110 && x > 110 && x < 300) return [231, 233, 234];
    return [0, 0, 0];
  });
}

module.exports = { makePng, sampleProofPng, crc32 };
