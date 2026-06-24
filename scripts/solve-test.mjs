#!/usr/bin/env node
'use strict';

/**
 * Author-only integration test for the intended solve path.
 * Not part of smoke test — run manually: node scripts/solve-test.mjs
 */

import WebSocket from 'ws';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

const CLIENT_MAGIC = 0x56;
const SERVER_MAGIC = 0x58;
const TYPE = { START: 1, MOVE: 2, RESUME: 9, HIDDEN: 11 };
const SERVER = { HELLO: 1, STATE: 3, GUARD: 6, ERROR: 8, FLAG: 12 };

function checksum(type, seq, len, cal) {
  return (type + ((seq >> 8) & 0xff) + (seq & 0xff) + len + cal) & 0xff;
}

function encode(type, seq, payload, cal) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(5 + body.length);
  frame[0] = CLIENT_MAGIC;
  frame[1] = type;
  frame[2] = (seq >> 8) & 0xff;
  frame[3] = seq & 0xff;
  frame[4] = checksum(type, seq, body.length, cal);
  body.copy(frame, 5);
  return frame;
}

function decode(buf, cal) {
  const type = buf[1];
  const seq = (buf[2] << 8) | buf[3];
  const body = buf.subarray(5);
  const payload = JSON.parse(body.toString('utf8'));
  return { type, seq, payload };
}

function waitGuardAsleep(ws, cal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('guard timeout')), 15000);
    ws.on('message', (data) => {
      const buf = Buffer.from(data);
      if (buf[0] !== SERVER_MAGIC) return;
      const { type, payload } = decode(buf, cal);
      if (type === SERVER.GUARD && payload.guard === 'asleep') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function onceFlag(ws, cal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('flag timeout')), 5000);
    const handler = (data) => {
      const buf = Buffer.from(data);
      if (buf[0] !== SERVER_MAGIC) return;
      const { type, payload } = decode(buf, cal);
      if (type === SERVER.FLAG) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(payload);
      }
      if (type === SERVER.ERROR) {
        clearTimeout(timer);
        ws.off('message', handler);
        reject(new Error(payload.code));
      }
    };
    ws.on('message', handler);
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'nodebuffer';
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function drainHello(ws, cal) {
  return new Promise((resolve) => {
    ws.on('message', function handler(data) {
      const buf = Buffer.from(data);
      if (buf[1] === SERVER.HELLO) {
        const { payload } = decode(buf, cal);
        ws.off('message', handler);
        resolve(payload);
      }
    });
  });
}

async function run() {
  console.log('Solve-path integration test...');

  const wsA = await connect();
  let seqA = 1;
  let cal = 0;
  let resume = null;

  const helloP = drainHello(wsA, 0);
  wsA.send(encode(TYPE.START, seqA++, { nickname: 'solve_bot' }, 0));
  const hello = await helloP;
  cal = hello.calibration;
  resume = hello.resume;
  console.log('  Tab A started, zone', hello.zone);

  for (let i = hello.zone; i < 3; i++) {
    wsA.send(encode(TYPE.MOVE, seqA++, { dir: 'forward' }, cal));
    await new Promise((r) => setTimeout(r, 80));
  }
  console.log('  Tab A at Security Room');

  const wsB = await connect();
  let seqB = 1;
  const helloBP = drainHello(wsB, cal);
  wsB.send(encode(TYPE.START, seqB++, { nickname: 'solve_bot', resume }, 0));
  await helloBP;
  console.log('  Tab B resumed at Security Room');

  wsA.send(encode(TYPE.MOVE, seqA++, { dir: 'forward' }, cal));
  await new Promise((r) => setTimeout(r, 80));
  console.log('  Tab A moved to Vault Door');

  wsB.send(encode(TYPE.RESUME, seqB++, { resume, nickname: 'solve_bot' }, cal));
  await new Promise((r) => setTimeout(r, 80));
  console.log('  Tab B RESUME — desync triggered');

  await waitGuardAsleep(wsB, cal);
  console.log('  Guard asleep');

  const flagP = onceFlag(wsB, cal);
  wsB.send(encode(TYPE.HIDDEN, seqB++, { target: 'case_7', intent: 'inspect' }, cal));
  const result = await flagP;

  if (!result.flag || !result.flag.startsWith('NF404{vault_exe_')) {
    throw new Error('Invalid flag: ' + result.flag);
  }

  console.log('  FLAG:', result.flag);
  console.log('SOLVE TEST PASSED');
  wsA.close();
  wsB.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('SOLVE TEST FAILED:', err.message);
  process.exit(1);
});
