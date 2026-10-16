'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildConfig } = require('../src/config');
const { tmpDir } = require('./helpers');

const KEYS = ['RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_PUBLIC_DOMAIN', 'RAILWAY_VOLUME_MOUNT_PATH', 'PORT', 'DASHBOARD_PORT', 'DASHBOARD_HOST', 'PUBLIC_URL', 'TRUST_PROXY', 'DATA_DIR', 'DASHBOARD_PASSWORD'];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('en local: sólo este PC, puerto 3000, sin proxy', () => {
  const dir = tmpDir();
  const c = withEnv({ DATA_DIR: dir }, () => buildConfig());
  assert.equal(c.platform, 'local');
  assert.equal(c.web.host, '127.0.0.1');
  assert.equal(c.web.port, 3000);
  assert.equal(c.web.publicUrl, 'http://localhost:3000');
  assert.equal(c.web.trustProxy, false);
  assert.equal(c.web.secureCookies, false);
  assert.ok(fs.existsSync(c.web.passwordFile), 'genera la contraseña del panel');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('en Railway se configura solo: puerto, red, dominio HTTPS, proxy y volumen', () => {
  const vol = tmpDir();
  const c = withEnv(
    { RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_PUBLIC_DOMAIN: 'engage-production.up.railway.app', RAILWAY_VOLUME_MOUNT_PATH: vol, PORT: '8080', DASHBOARD_PORT: '3000' },
    () => buildConfig(),
  );
  assert.equal(c.platform, 'railway');
  assert.equal(c.web.port, 8080, 'PORT de la plataforma tiene prioridad');
  assert.equal(c.web.host, '0.0.0.0');
  assert.equal(c.web.publicUrl, 'https://engage-production.up.railway.app');
  assert.equal(c.web.trustProxy, true);
  assert.equal(c.web.secureCookies, true);
  assert.equal(c.dataDir, vol, 'los datos van al volumen');
  fs.rmSync(vol, { recursive: true, force: true });
});

test('las variables explícitas mandan sobre la detección automática', () => {
  const dir = tmpDir();
  const c = withEnv(
    { RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app', PUBLIC_URL: 'https://panel.midominio.com/', DASHBOARD_HOST: '127.0.0.1', TRUST_PROXY: 'false', DATA_DIR: dir, DASHBOARD_PASSWORD: 'secreta' },
    () => buildConfig(),
  );
  assert.equal(c.web.publicUrl, 'https://panel.midominio.com');
  assert.equal(c.web.host, '127.0.0.1');
  assert.equal(c.web.trustProxy, false);
  assert.equal(c.web.password, 'secreta');
  assert.equal(c.web.passwordFile, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
