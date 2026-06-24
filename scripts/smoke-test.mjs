#!/usr/bin/env node
'use strict';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const tests = [];
let passed = 0;
let failed = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    tests.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    tests.push({ name, ok: false, detail });
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function fetchJson(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, text, json };
}

async function run() {
  console.log(`\nVault.exe smoke test — ${BASE_URL}\n`);

  try {
    const health = await fetchJson('/health');
    assert('/health returns 200', health.res.status === 200);
    assert('/health ok field', health.json?.ok === true);

    const flag = await fetchJson('/api/flag');
    assert('/api/flag returns 403', flag.res.status === 403);
    assert('/api/flag does not contain NF404', !flag.text.includes('NF404'));

    const me = await fetchJson('/api/me');
    assert('/api/me returns 200', me.res.status === 200);
    assert('/api/me has name', me.json?.name === 'Vault.exe');

    const lb = await fetchJson('/api/leaderboard');
    assert('/api/leaderboard returns 200', lb.res.status === 200);
    assert('/api/leaderboard has entries array', Array.isArray(lb.json?.entries));

    const manual = await fetch(`${BASE_URL}/manual`);
    const manualText = await manual.text();
    assert('/manual returns 200', manual.status === 200);
    assert('/manual contains frame info', manualText.includes('Vault Frame Manual'));

    const vault = await fetchJson('/api/vault');
    assert('/api/vault returns 200', vault.res.status === 200);
    assert('/api/vault does not leak flag', !vault.text.includes('NF404{'));

    const debug = await fetchJson('/api/debug');
    assert('/api/debug returns 200', debug.res.status === 200);
    assert('/api/debug does not leak flag', !debug.text.includes('NF404{'));
  } catch (err) {
    console.error(`\n  ✗ Connection failed: ${err.message}`);
    console.error('  Is the server running? Try: npm run dev\n');
    process.exit(1);
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('SMOKE TEST FAILED\n');
    process.exit(1);
  }
  console.log('SMOKE TEST PASSED\n');
}

run();
