import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBatchResponse } from './fping-run.js';

test('buildBatchResponse monta {family, results} a partir do stdout', async () => {
  const fakeRun = async () =>
    '203.0.113.10 : xmt/rcv/%loss = 4/4/0%, min/avg/max = 1.0/2.0/3.0';
  const res = await buildBatchResponse({ targets: ['203.0.113.10'], family: 4, count: 4 }, fakeRun);
  assert.equal(res.family, 4);
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].target, '203.0.113.10');
  assert.equal(typeof res.datetime, 'string');
});

test('lista vazia não chama fping', async () => {
  let called = false;
  const fakeRun = async () => { called = true; return ''; };
  const res = await buildBatchResponse({ targets: [], family: 4, count: 4 }, fakeRun);
  assert.equal(called, false);
  assert.deepEqual(res.results, []);
});
