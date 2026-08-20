// icmp.test.js — runner nativo do Node (node --test), mesmo padrão do family.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcmpPacket } from './icmp.js';

// -------- helpers pra montar pacotes de teste --------

function ipv4Header({ ihlWords = 5 } = {}) {
  const buf = Buffer.alloc(ihlWords * 4);
  buf.writeUInt8((4 << 4) | ihlWords, 0); // version=4, ihl
  return buf;
}

function icmpEchoReply4(identifier, sequence) {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(0, 0); // type: Echo Reply
  buf.writeUInt8(0, 1); // code
  buf.writeUInt16BE(0, 2); // checksum (irrelevante pro parse)
  buf.writeUInt16BE(identifier, 4);
  buf.writeUInt16BE(sequence, 6);
  return buf;
}

function icmpTimeExceeded4(embeddedOriginal) {
  const header = Buffer.alloc(8);
  header.writeUInt8(11, 0); // type: Time Exceeded
  header.writeUInt8(0, 1); // code
  return Buffer.concat([header, embeddedOriginal]);
}

function icmpEchoRequest4(identifier, sequence) {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(8, 0); // type: Echo Request
  buf.writeUInt8(0, 1);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(identifier, 4);
  buf.writeUInt16BE(sequence, 6);
  return buf;
}

function icmpv6EchoReply(identifier, sequence) {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(129, 0); // type: Echo Reply
  buf.writeUInt8(0, 1);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(identifier, 4);
  buf.writeUInt16BE(sequence, 6);
  return buf;
}

function icmpv6EchoRequest(identifier, sequence) {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(128, 0); // type: Echo Request
  buf.writeUInt8(0, 1);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(identifier, 4);
  buf.writeUInt16BE(sequence, 6);
  return buf;
}

function icmpv6TimeExceeded(embeddedOriginal) {
  const header = Buffer.alloc(8);
  header.writeUInt8(3, 0); // type: Time Exceeded
  header.writeUInt8(0, 1);
  const ipv6Header = Buffer.alloc(40); // cabeçalho IPv6 é sempre 40 bytes fixos
  return Buffer.concat([header, ipv6Header, embeddedOriginal]);
}

// -------- IPv4 --------

test('parseIcmpPacket (IPv4): Echo Reply extrai identifier/sequence do cabeçalho', () => {
  const packet = Buffer.concat([ipv4Header(), icmpEchoReply4(1234, 5)]);
  const parsed = parseIcmpPacket(false, packet);
  assert.equal(parsed.type, 0);
  assert.equal(parsed.identifier, 1234);
  assert.equal(parsed.sequence, 5);
});

test('parseIcmpPacket (IPv4): Time Exceeded extrai identifier/sequence do echo request ORIGINAL embutido', () => {
  const embedded = Buffer.concat([ipv4Header(), icmpEchoRequest4(4321, 7)]);
  const packet = Buffer.concat([ipv4Header(), icmpTimeExceeded4(embedded)]);
  const parsed = parseIcmpPacket(false, packet);
  assert.equal(parsed.type, 11);
  assert.equal(parsed.identifier, 4321);
  assert.equal(parsed.sequence, 7);
});

test('parseIcmpPacket (IPv4): Time Exceeded cujo pacote embutido NÃO é um echo request → identifier null (não inventa)', () => {
  const naoEcho = Buffer.alloc(8); // type=0 (echo reply, não request) — não é o que esperamos embutido
  const embedded = Buffer.concat([ipv4Header(), naoEcho]);
  const packet = Buffer.concat([ipv4Header(), icmpTimeExceeded4(embedded)]);
  const parsed = parseIcmpPacket(false, packet);
  assert.equal(parsed.type, 11);
  assert.equal(parsed.identifier, null);
  assert.equal(parsed.sequence, null);
});

test('parseIcmpPacket (IPv4): honra IHL variável (cabeçalho IP com opções)', () => {
  // IHL=6 palavras (24 bytes) em vez do mínimo de 5 — o offset do ICMP deve acompanhar.
  const packet = Buffer.concat([ipv4Header({ ihlWords: 6 }), icmpEchoReply4(999, 3)]);
  const parsed = parseIcmpPacket(false, packet);
  assert.equal(parsed.identifier, 999);
  assert.equal(parsed.sequence, 3);
});

test('parseIcmpPacket (IPv4): pacote curto demais → null', () => {
  assert.equal(parseIcmpPacket(false, Buffer.alloc(10)), null);
});

// -------- IPv6 --------

test('parseIcmpPacket (IPv6): Echo Reply extrai identifier/sequence direto (sem cabeçalho IP)', () => {
  const packet = icmpv6EchoReply(1111, 2);
  const parsed = parseIcmpPacket(true, packet);
  assert.equal(parsed.type, 129);
  assert.equal(parsed.identifier, 1111);
  assert.equal(parsed.sequence, 2);
});

test('parseIcmpPacket (IPv6): Time Exceeded extrai identifier/sequence do echo request original embutido após os 40 bytes fixos do IPv6', () => {
  const embedded = icmpv6EchoRequest(2222, 9);
  const packet = icmpv6TimeExceeded(embedded);
  const parsed = parseIcmpPacket(true, packet);
  assert.equal(parsed.type, 3);
  assert.equal(parsed.identifier, 2222);
  assert.equal(parsed.sequence, 9);
});

// -------- o cenário do bug: duas resoluções concorrentes não devem se confundir --------

test('cenário do bug: resposta de OUTRO traceroute (identifier diferente) deve ser descartável pelo chamador', () => {
  // Traceroute A usa identifier=100; chega uma resposta cujo identifier é de
  // um traceroute B concorrente (identifier=200) — o parser devolve o
  // identifier REAL embutido no pacote, e é responsabilidade de quem chama
  // comparar contra o identifier esperado antes de aceitar (rawTraceroute
  // agora faz isso: `if (parsed.identifier !== identifier ...) return;`).
  const embeddedDeOutroTeste = Buffer.concat([ipv4Header(), icmpEchoRequest4(200, 3)]);
  const packet = Buffer.concat([ipv4Header(), icmpTimeExceeded4(embeddedDeOutroTeste)]);
  const parsed = parseIcmpPacket(false, packet);
  const identifierEsperadoPorA = 100;
  assert.notEqual(parsed.identifier, identifierEsperadoPorA);
});
