// family.test.js — runner nativo do Node (node --test), sem dependências novas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFamily } from './family.js';

test('parseFamily: aceita 4 e 6 como string ou número', () => {
  assert.equal(parseFamily({ family: '4' }), 4);
  assert.equal(parseFamily({ family: '6' }), 6);
  assert.equal(parseFamily({ family: 4 }), 4);
  assert.equal(parseFamily({ family: 6 }), 6);
});

test('parseFamily: ausente/ inválido => null (comportamento padrão)', () => {
  assert.equal(parseFamily({}), null);
  assert.equal(parseFamily({ family: '' }), null);
  assert.equal(parseFamily({ family: 'x' }), null);
  assert.equal(parseFamily({ family: '5' }), null);
  assert.equal(parseFamily({ family: 46 }), null);
});

test('parseFamily: fonte ausente/nula não quebra', () => {
  assert.equal(parseFamily(undefined), null);
  assert.equal(parseFamily(null), null);
});
