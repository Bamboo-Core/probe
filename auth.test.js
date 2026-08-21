// auth.test.js — runner nativo do Node (node --test), mesmo padrão do family.test.js.
// PROBE_SHARED_SECRET precisa estar definido/indefinido ANTES do módulo carregar
// (auth.js lê a env no import), então cada bloco isola via `node --test` em
// processos separados não é viável aqui — em vez disso, testamos via
// re-import dinâmico com um cache-buster de query string, que força o Node a
// avaliar o módulo de novo com a env já ajustada.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeReply() {
	const calls = [];
	return {
		calls,
		status(code) { calls.push({ code }); return this; },
		send(body) { calls.push({ body }); return this; },
	};
}

async function freshAuthModule() {
	// bust do cache de módulos ESM: cada import com querystring única recarrega
	// o arquivo do zero, relendo process.env.PROBE_SHARED_SECRET no topo.
	return import(`./auth.js?t=${Date.now()}-${Math.random()}`);
}

test('sem PROBE_SHARED_SECRET: modo legado por allowlist de IP (comportamento anterior)', async () => {
	delete process.env.PROBE_SHARED_SECRET;
	const auth = await freshAuthModule();
	const reply = fakeReply();
	await auth.ipAuthMiddleware({ ip: '10.0.0.5', headers: {}, socket: {} }, reply);
	assert.deepEqual(reply.calls, []); // autorizado, sem resposta de erro
});

test('sem PROBE_SHARED_SECRET: IP fora da allowlist é rejeitado com 403', async () => {
	delete process.env.PROBE_SHARED_SECRET;
	const auth = await freshAuthModule();
	const reply = fakeReply();
	await auth.ipAuthMiddleware({ ip: '203.0.113.7', headers: {}, socket: {} }, reply);
	assert.equal(reply.calls[0].code, 403);
});

test('com PROBE_SHARED_SECRET: header correto autoriza mesmo de um IP público', async () => {
	process.env.PROBE_SHARED_SECRET = 'segredo-de-teste-123';
	const auth = await freshAuthModule();
	const reply = fakeReply();
	await auth.ipAuthMiddleware(
		{ ip: '203.0.113.7', headers: { 'x-probe-key': 'segredo-de-teste-123' }, socket: {} },
		reply
	);
	assert.deepEqual(reply.calls, []);
});

test('com PROBE_SHARED_SECRET: header ausente é rejeitado com 401, mesmo de IP autorizado no modo legado', async () => {
	process.env.PROBE_SHARED_SECRET = 'segredo-de-teste-123';
	const auth = await freshAuthModule();
	const reply = fakeReply();
	// 10.0.0.5 estaria na allowlist legada — mas com segredo configurado, a
	// allowlist não conta mais pra nada.
	await auth.ipAuthMiddleware({ ip: '10.0.0.5', headers: {}, socket: {} }, reply);
	assert.equal(reply.calls[0].code, 401);
});

test('com PROBE_SHARED_SECRET: header errado (mesmo de IP "confiável") é rejeitado — isso é o bug real corrigido', async () => {
	process.env.PROBE_SHARED_SECRET = 'segredo-de-teste-123';
	const auth = await freshAuthModule();
	const reply = fakeReply();
	// Simula exatamente o ataque: cliente forja X-Forwarded-For como o IP do
	// coletor (o que definia request.ip com trustProxy=true), mas sem o
	// segredo correto — deve continuar bloqueado.
	await auth.ipAuthMiddleware(
		{ ip: '201.182.96.108', headers: { 'x-probe-key': 'chave-errada' }, socket: {} },
		reply
	);
	assert.equal(reply.calls[0].code, 401);
	delete process.env.PROBE_SHARED_SECRET;
});
