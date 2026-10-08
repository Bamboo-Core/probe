import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFpingBatch } from './fping-parse.js';

test('eco recebido: ms médio + perda parcial', () => {
  const out = '203.0.113.10 : xmt/rcv/%loss = 4/3/25%, min/avg/max = 3.10/3.30/3.50';
  const [r] = parseFpingBatch(out);
  assert.equal(r.target, '203.0.113.10');
  assert.equal(r.ms, 3.30);
  assert.equal(r.min_ms, 3.10);
  assert.equal(r.max_ms, 3.50);
  assert.equal(r.loss_pct, 25);
  assert.ok(!('err' in r));
});

test('mediu e nenhum eco: perda real 100, sem ms', () => {
  const [r] = parseFpingBatch('198.51.100.7 : xmt/rcv/%loss = 4/0/100%');
  assert.equal(r.ms, null);
  assert.equal(r.loss_pct, 100);
});

test('não-medido: NotMeasured, SEM loss_pct', () => {
  const [r] = parseFpingBatch('192.0.2.9 : address not found');
  assert.equal(r.ms, null);
  assert.equal(r.err.name, 'NotMeasured');
  assert.ok(!('loss_pct' in r));
});

test('multi-linha: uma entrada por host, ignora ruído', () => {
  const out = [
    '203.0.113.10 : xmt/rcv/%loss = 4/4/0%, min/avg/max = 1.0/2.0/3.0',
    '',
    '198.51.100.7 : xmt/rcv/%loss = 4/0/100%',
  ].join('\n');
  const rs = parseFpingBatch(out);
  assert.equal(rs.length, 2);
  assert.equal(rs[0].loss_pct, 0);
  assert.equal(rs[1].loss_pct, 100);
});
