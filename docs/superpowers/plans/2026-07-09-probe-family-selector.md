# Seletor de família IPv4/IPv6 no `probe` — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar um query param opcional `?family=4|6` a cada módulo do `probe` baseado em resolução, forçando a coleta a usar só IPv4 ou só IPv6; ausente = comportamento atual (100% retrocompatível).

**Architecture:** Um helper puro compartilhado `parseFamily(source)` (root, ao lado de `auth.js`/`metrics.js`) lê a preferência da query. Cada módulo passa essa preferência para sua própria lógica de resolução (mantida local — a duplicação existente é preservada, conforme o spec): resolve **só** a família pedida, com erro limpo quando não há registro (`HostNotFoundError`, `ipVersion:0`) ou quando a VM não tem egress v6 (`IPv6NotSupportedError`). O cache de DNS (ping/smokeping) é usado **apenas** no caminho padrão para não misturar famílias.

**Tech Stack:** Node.js ≥20 (ES modules), Fastify, `dns.promises`, `raw-socket`, `dgram`. Teste unitário do helper puro com o runner nativo `node --test` (sem novas dependências). Módulos com I/O de rede são verificados por smoke test (o repo não tem suíte automatizada — ver CLAUDE.md).

**Spec:** `docs/superpowers/specs/2026-07-09-probe-family-selector-design.md`

**Branch:** `feat/dual-stack-ipv6` (já criada; o spec já está commitado nela).

---

## Estrutura de arquivos

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `family.js` (root) | Helper puro `parseFamily(source)` → `4 | 6 | null` | Criar |
| `family.test.js` (root) | Teste `node --test` do helper puro | Criar |
| `modules/ping/main.js` | `resolveHost(host, family)` + ler `family` no handler | Modificar |
| `modules/smokeping/main.js` | idem ping (mesmo `resolveHost` com cache) | Modificar |
| `modules/traceroute/main.js` | `resolveTarget(attrIP, family)` + ler `family` | Modificar |
| `modules/mtu/main.js` | resolução inline respeita `family` + ler `family` | Modificar |
| `modules/portscan/main.js` | resolução inline respeita `family` + ler `family` (query/body) | Modificar |
| `modules/http/main.js` | helper local `resolveForFamily` nos 2 blocos + `options.family` + ler `family` | Modificar |
| `README.md` (root) | documentar o param `?family=` | Modificar |

**Fora de escopo:** módulo `dns` (já separa por `?method=A|AAAA`), unificação de resolvers entre módulos, novas rotas.

---

## Task 1: Helper puro `parseFamily` (TDD)

**Files:**
- Create: `family.js`
- Test: `family.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Criar `family.test.js`:

```js
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
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node --test family.test.js`
Expected: FAIL — `Cannot find module '.../family.js'` (o helper ainda não existe).

- [ ] **Step 3: Implementar o mínimo para passar**

Criar `family.js`:

```js
// family.js
// Lê a preferência de família de endereço (IPv4/IPv6) de um objeto de query/body.
// Retorna 4, 6 ou null. null = sem preferência => o módulo mantém seu comportamento
// padrão (IPv4-first, fallback IPv6). Puro, sem I/O.
export function parseFamily(source) {
  const raw = source && source.family;
  if (raw === 4 || raw === '4') return 4;
  if (raw === 6 || raw === '6') return 6;
  return null;
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `node --test family.test.js`
Expected: PASS — `# pass 3`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add family.js family.test.js
git commit -m "feat(probe): parseFamily — helper puro para o seletor ?family=4|6"
```

---

## Task 2: `ping` respeita `family`

**Files:**
- Modify: `modules/ping/main.js` (import, `resolveHost` linhas 28-40, handler linhas 186/191)

- [ ] **Step 1: Adicionar o import do helper**

Em `modules/ping/main.js`, logo após a linha 5 (`import { recordPingSuccess, ... } from '../../metrics.js';`), adicionar:

```js
import { parseFamily } from '../../family.js';
```

- [ ] **Step 2: Substituir `resolveHost` para respeitar `family`**

Trocar a função atual (linhas 28-40):

```js
async function resolveHost(host) {
	if (net.isIP(host)) return { ips: [host], version: net.isIPv6(host) ? 6 : 4 };
	const c = getCached(host); if (c) return c;
	try {
		const v4 = await dns.resolve4(host);
		if (v4?.length) { const e = { ips: v4, version: 4, expires: Date.now() + DNS_CACHE_TTL }; dnsCache.set(host, e); return e; }
	} catch (_) {}
	try {
		const v6 = await dns.resolve6(host);
		if (v6?.length) { const e = { ips: v6, version: 6, expires: Date.now() + DNS_CACHE_TTL }; dnsCache.set(host, e); return e; }
	} catch (_) {}
	return { ips: [], version: 0, error: 'host not found' };
}
```

por:

```js
// family: 4 | 6 | null. null => IPv4-first com fallback IPv6 (comportamento original).
// Com família explícita, resolve SÓ aquela família e NÃO usa o cache (evita misturar v4/v6
// no mesmo host). Sem família, o caminho é idêntico ao original (incluindo o cache).
async function resolveHost(host, family = null) {
	if (net.isIP(host)) {
		const v = net.isIPv6(host) ? 6 : 4;
		if (family && family !== v) return { ips: [], version: 0, error: 'host not found' };
		return { ips: [host], version: v };
	}
	if (!family) { const c = getCached(host); if (c) return c; }
	if (family === 6 && global.ipv6Support === false) {
		return { ips: [], version: 0, error: 'ipv6-only (disabled)' };
	}
	if (family !== 6) {
		try {
			const v4 = await dns.resolve4(host);
			if (v4?.length) { const e = { ips: v4, version: 4, expires: Date.now() + DNS_CACHE_TTL }; if (!family) dnsCache.set(host, e); return e; }
		} catch (_) {}
		if (family === 4) return { ips: [], version: 0, error: 'host not found' };
	}
	try {
		const v6 = await dns.resolve6(host);
		if (v6?.length) { const e = { ips: v6, version: 6, expires: Date.now() + DNS_CACHE_TTL }; if (!family) dnsCache.set(host, e); return e; }
	} catch (_) {}
	return { ips: [], version: 0, error: 'host not found' };
}
```

- [ ] **Step 3: Ler `family` no handler e passar para `resolveHost`**

No handler, trocar a linha 186:

```js
			const input = String(request.params.id || '');
```

por (adicionar a leitura do param logo abaixo):

```js
			const input = String(request.params.id || '');
			const family = parseFamily(request.query);
```

E trocar a linha 191:

```js
				const res = await resolveHost(input);
```

por:

```js
				const res = await resolveHost(input, family);
```

> O mapeamento de erro já existente (linhas 194-196) transforma `'ipv6-only (disabled)'` em `IPv6NotSupportedError` e o resto em `HostNotFoundError`, ambos com `ipVersion:0` — nada mais a mudar no handler.

- [ ] **Step 4: Verificar (smoke test)**

Pré-requisito: probe rodando (`npm run dev`). ICMP exige privilégio de raw socket (Linux: `CAP_NET_RAW`/sudo; no Windows, admin). Se não houver privilégio local, validar no probe implantado.

```bash
curl -s "http://localhost:8000/ping/www.google.com"            # inalterado: ipVersion 4
curl -s "http://localhost:8000/ping/www.google.com?family=6"   # ipVersion 6, ms preenchido
curl -s "http://localhost:8000/ping/www.google.com?family=4"   # ipVersion 4
curl -s "http://localhost:8000/ping/1.1.1.1?family=6"          # err HostNotFoundError, ipVersion 0
```
Expected: os `ipVersion`/`err` acima; a chamada sem `family` idêntica ao comportamento anterior.

- [ ] **Step 5: Commit**

```bash
git add modules/ping/main.js
git commit -m "feat(probe): ping respeita ?family=4|6"
```

---

## Task 3: `smokeping` respeita `family`

**Files:**
- Modify: `modules/smokeping/main.js` (import, `resolveHost` linhas 42-54, handler linhas 609/626)

> O `resolveHost` do smokeping é idêntico ao do ping (com cache + `ipv6-only`); a mudança é a mesma.

- [ ] **Step 1: Adicionar o import do helper**

Em `modules/smokeping/main.js`, após a linha 6 (`import { recordApiRequest } from '../../metrics.js';`), adicionar:

```js
import { parseFamily } from '../../family.js';
```

- [ ] **Step 2: Substituir `resolveHost` para respeitar `family`**

Trocar a função atual (linhas 42-54):

```js
async function resolveHost(host) {
	if (net.isIP(host)) return { ips: [host], version: net.isIPv6(host) ? 6 : 4 };
	const c = getCached(host); if (c) return c;
	try {
		const v4 = await dns.resolve4(host);
		if (v4?.length) { const e = { ips: v4, version: 4, expires: Date.now() + DNS_CACHE_TTL }; dnsCache.set(host, e); return e; }
	} catch (_) {}
	try {
		const v6 = await dns.resolve6(host);
		if (v6?.length) { const e = { ips: v6, version: 6, expires: Date.now() + DNS_CACHE_TTL }; dnsCache.set(host, e); return e; }
	} catch (_) {}
	return { ips: [], version: 0, error: 'host not found' };
}
```

por:

```js
// family: 4 | 6 | null. null => IPv4-first com fallback IPv6 (comportamento original).
// Com família explícita, resolve SÓ aquela família e NÃO usa o cache (evita misturar v4/v6).
async function resolveHost(host, family = null) {
	if (net.isIP(host)) {
		const v = net.isIPv6(host) ? 6 : 4;
		if (family && family !== v) return { ips: [], version: 0, error: 'host not found' };
		return { ips: [host], version: v };
	}
	if (!family) { const c = getCached(host); if (c) return c; }
	if (family === 6 && global.ipv6Support === false) {
		return { ips: [], version: 0, error: 'ipv6-only (disabled)' };
	}
	if (family !== 6) {
		try {
			const v4 = await dns.resolve4(host);
			if (v4?.length) { const e = { ips: v4, version: 4, expires: Date.now() + DNS_CACHE_TTL }; if (!family) dnsCache.set(host, e); return e; }
		} catch (_) {}
		if (family === 4) return { ips: [], version: 0, error: 'host not found' };
	}
	try {
		const v6 = await dns.resolve6(host);
		if (v6?.length) { const e = { ips: v6, version: 6, expires: Date.now() + DNS_CACHE_TTL }; if (!family) dnsCache.set(host, e); return e; }
	} catch (_) {}
	return { ips: [], version: 0, error: 'host not found' };
}
```

- [ ] **Step 3: Ler `family` no handler e passar para `resolveHost`**

No handler, trocar a linha 609:

```js
		const input = String(request.params.id || '');
```

por:

```js
		const input = String(request.params.id || '');
		const family = parseFamily(request.query);
```

E trocar a linha 626:

```js
			const res = await resolveHost(input);
```

por:

```js
			const res = await resolveHost(input, family);
```

> O mapeamento de erro existente (linhas 630-632) já trata `'ipv6-only (disabled)'`/`HostNotFoundError`.

- [ ] **Step 4: Verificar (smoke test)**

Pré-requisito: probe rodando + privilégio de raw socket (ver Task 2).

```bash
curl -s "http://localhost:8000/smokeping/www.google.com?count=5"            # inalterado
curl -s "http://localhost:8000/smokeping/www.google.com?count=5&family=6"   # median_ms via IPv6
curl -s "http://localhost:8000/smokeping/1.1.1.1?count=5&family=6"          # err HostNotFoundError
```
Expected: `family=6` mede via IPv6; `1.1.1.1?family=6` erra com `HostNotFoundError` e `loss_pct:100`.

- [ ] **Step 5: Commit**

```bash
git add modules/smokeping/main.js
git commit -m "feat(probe): smokeping respeita ?family=4|6"
```

---

## Task 4: `traceroute` respeita `family`

**Files:**
- Modify: `modules/traceroute/main.js` (import, `resolveTarget` linhas 139-154, handler linhas 166/180)

- [ ] **Step 1: Adicionar o import do helper**

Em `modules/traceroute/main.js`, após a linha 5 (`import { recordTraceroute, recordApiRequest } from '../../metrics.js';`), adicionar:

```js
import { parseFamily } from '../../family.js';
```

- [ ] **Step 2: Substituir `resolveTarget` para respeitar `family`**

Trocar a função atual (linhas 139-154):

```js
async function resolveTarget(attrIP) {
	if (net.isIP(attrIP)) {
		return { targetIP: attrIP, resolvedIPs: null, ipVersion: net.isIPv6(attrIP) ? 6 : 4 };
	}
	try {
		try { // tentar IPv4 primeiro
			const ipv4s = await dns.resolve4(attrIP);
			return { targetIP: ipv4s[0], resolvedIPs: ipv4s, ipVersion: 4 };
		} catch (v4err) {
			const ipv6s = await dns.resolve6(attrIP); // fallback IPv6
			return { targetIP: ipv6s[0], resolvedIPs: ipv6s, ipVersion: 6 };
		}
	} catch (e) {
		return { err: 'host not found' };
	}
}
```

por:

```js
// family: 4 | 6 | null. null => IPv4-first com fallback IPv6 (comportamento original).
async function resolveTarget(attrIP, family = null) {
	if (net.isIP(attrIP)) {
		const v = net.isIPv6(attrIP) ? 6 : 4;
		if (family && family !== v) return { err: 'host not found' };
		return { targetIP: attrIP, resolvedIPs: null, ipVersion: v };
	}
	if (family === 6 && global.ipv6Support === false) {
		return { err: 'IPv6 not supported on this probe' };
	}
	try {
		if (family !== 6) {
			try {
				const ipv4s = await dns.resolve4(attrIP);
				return { targetIP: ipv4s[0], resolvedIPs: ipv4s, ipVersion: 4 };
			} catch (v4err) {
				if (family === 4) throw v4err; // não cai para v6 quando v4 é obrigatório
			}
		}
		const ipv6s = await dns.resolve6(attrIP);
		return { targetIP: ipv6s[0], resolvedIPs: ipv6s, ipVersion: 6 };
	} catch (e) {
		return { err: 'host not found' };
	}
}
```

- [ ] **Step 3: Ler `family` no handler e passar para `resolveTarget`**

No handler, trocar a linha 166:

```js
			const attrIP = request.params.id.toString();
```

por:

```js
			const attrIP = request.params.id.toString();
			const family = parseFamily(request.query);
```

E trocar a linha 180:

```js
			const { targetIP, resolvedIPs, ipVersion, err } = await resolveTarget(attrIP);
```

por:

```js
			const { targetIP, resolvedIPs, ipVersion, err } = await resolveTarget(attrIP, family);
```

- [ ] **Step 4: Verificar (smoke test)**

Pré-requisito: probe rodando + privilégio de raw socket (ver Task 2).

```bash
curl -s "http://localhost:8000/traceroute/www.google.com/10"            # inalterado: ipVersion 4
curl -s "http://localhost:8000/traceroute/www.google.com/10?family=6"   # ipVersion 6, hops v6
curl -s "http://localhost:8000/traceroute/1.1.1.1/10?family=6"          # err host not found, ipVersion 0
```
Expected: `family=6` traça via IPv6 (hops com IPs v6); `1.1.1.1?family=6` erra com `ipVersion:0`.

- [ ] **Step 5: Commit**

```bash
git add modules/traceroute/main.js
git commit -m "feat(probe): traceroute respeita ?family=4|6"
```

---

## Task 5: `mtu` respeita `family`

**Files:**
- Modify: `modules/mtu/main.js` (import, handler: leitura do param + bloco de resolução linhas 17-56)

- [ ] **Step 1: Adicionar o import do helper**

Em `modules/mtu/main.js`, após a linha 5 (`import { recordMtuDiscovery, recordApiRequest } from '../../metrics.js';`), adicionar:

```js
import { parseFamily } from '../../family.js';
```

- [ ] **Step 2: Ler `family` no handler**

Trocar a linha 17-18:

```js
			let attrIP = request.params.id.toString();
			const sessionID = request.query.sessionID;
```

por:

```js
			let attrIP = request.params.id.toString();
			const sessionID = request.query.sessionID;
			const family = parseFamily(request.query);
```

- [ ] **Step 3: Substituir o bloco de resolução para respeitar `family`**

Trocar o bloco atual (linhas 28-56):

```js
			if (!net.isIP(attrIP)) {
				try {
					// Tentar resolver IPv4 primeiro
					try {
						const ipv4s = await dns.resolve4(attrIP);
						resolvedIPs = ipv4s;
						targetIP = ipv4s[0];
						ipVersion = 4;
					} catch (ipv4Error) {
						const ipv6s = await dns.resolve6(attrIP);
						resolvedIPs = ipv6s;
						targetIP = ipv6s[0];
						ipVersion = 6;
					}
				} catch (err) {
					recordApiRequest('mtu', '/mtu', Date.now() - startTime, 'failure');
					return {
						"timestamp": new Date().toISOString(),
						"target": attrIP,
						"err": 'host not found',
						"sessionID": sessionID,
						"ipVersion": 0,
						"responseTimeMs": Date.now() - startTime
					};
				}
			} else {
				const is6 = net.isIPv6(attrIP);
				ipVersion = is6 ? 6 : 4;
			}
```

por:

```js
			if (!net.isIP(attrIP)) {
				if (family === 6 && global.ipv6Support === false) {
					recordApiRequest('mtu', '/mtu', Date.now() - startTime, 'failure');
					return {
						"timestamp": new Date().toISOString(),
						"target": attrIP,
						"err": 'IPv6 not supported on this probe',
						"sessionID": sessionID,
						"ipVersion": 0,
						"responseTimeMs": Date.now() - startTime
					};
				}
				try {
					// family: 4|6 => resolve só aquela família; null => v4-first com fallback v6.
					let resolved = false;
					if (family !== 6) {
						try {
							const ipv4s = await dns.resolve4(attrIP);
							resolvedIPs = ipv4s;
							targetIP = ipv4s[0];
							ipVersion = 4;
							resolved = true;
						} catch (ipv4Error) {
							if (family === 4) throw ipv4Error;
						}
					}
					if (!resolved) {
						const ipv6s = await dns.resolve6(attrIP);
						resolvedIPs = ipv6s;
						targetIP = ipv6s[0];
						ipVersion = 6;
					}
				} catch (err) {
					recordApiRequest('mtu', '/mtu', Date.now() - startTime, 'failure');
					return {
						"timestamp": new Date().toISOString(),
						"target": attrIP,
						"err": 'host not found',
						"sessionID": sessionID,
						"ipVersion": 0,
						"responseTimeMs": Date.now() - startTime
					};
				}
			} else {
				const is6 = net.isIPv6(attrIP);
				ipVersion = is6 ? 6 : 4;
				if (family && family !== ipVersion) {
					recordApiRequest('mtu', '/mtu', Date.now() - startTime, 'failure');
					return {
						"timestamp": new Date().toISOString(),
						"target": attrIP,
						"err": 'host not found',
						"sessionID": sessionID,
						"ipVersion": 0,
						"responseTimeMs": Date.now() - startTime
					};
				}
			}
```

- [ ] **Step 4: Verificar (smoke test)**

Pré-requisito: probe rodando + privilégio de raw socket (o MTU usa raw sockets).

```bash
curl -s "http://localhost:8000/mtu/www.google.com"            # inalterado: ipVersion 4
curl -s "http://localhost:8000/mtu/www.google.com?family=6"   # ipVersion 6, discoveredMTU via IPv6
curl -s "http://localhost:8000/mtu/1.1.1.1?family=6"          # err host not found, ipVersion 0
```
Expected: `family=6` descobre MTU via IPv6; `1.1.1.1?family=6` erra com `ipVersion:0`.

- [ ] **Step 5: Commit**

```bash
git add modules/mtu/main.js
git commit -m "feat(probe): mtu respeita ?family=4|6"
```

---

## Task 6: `portscan` respeita `family`

**Files:**
- Modify: `modules/portscan/main.js` (import, `portscanHandler`: leitura do param linha 112 + bloco de resolução linhas 173-202)

> `portscanHandler` atende GET (params na URL, `request.query`) e POST (params no `request.body`). Lê-se `family` de ambos.

- [ ] **Step 1: Adicionar o import do helper**

Em `modules/portscan/main.js`, após a linha 7 (`import { recordPortscan, recordApiRequest } from '../../metrics.js';`), adicionar:

```js
import { parseFamily } from '../../family.js';
```

- [ ] **Step 2: Ler `family` no início do handler**

Trocar a linha 112-113:

```js
		const startTime = Date.now();
		try {
```

por:

```js
		const startTime = Date.now();
		const family = parseFamily(request.query) ?? parseFamily(request.body || {});
		try {
```

- [ ] **Step 3: Substituir o bloco de resolução para respeitar `family`**

Trocar o bloco atual (linhas 173-202):

```js
			if (!net.isIP(attrIP)) {
				try {
					// Tentar resolver IPv4 primeiro
					try {
						const ipv4s = await dns.resolve4(attrIP);
						resolvedIPs = ipv4s;
						targetHost = ipv4s[0];
						ipVersion = 4;
					} catch (ipv4Error) {
						const ipv6s = await dns.resolve6(attrIP);
						resolvedIPs = ipv6s;
						targetHost = ipv6s[0];
						ipVersion = 6;
					}
				} catch (dnsError) {
					recordApiRequest('portscan', '/portscan', Date.now() - startTime, 'failure');
					return {
						"timestamp": new Date().toISOString(),
						"protocol": protocol,
						"method": method,
						"host": attrIP,
						"err": 'host not found',
						"ipVersion": 0,
						"responseTimeMs": Date.now() - startTime
					};
				}
			} else {
				const is6 = net.isIPv6(attrIP);
				ipVersion = is6 ? 6 : 4;
			}
```

por:

```js
			if (!net.isIP(attrIP)) {
				if (family === 6 && global.ipv6Support === false) {
					recordApiRequest('portscan', '/portscan', Date.now() - startTime, 'failure');
					return {
						"timestamp": new Date().toISOString(),
						"protocol": protocol,
						"method": method,
						"host": attrIP,
						"err": 'IPv6 not supported on this probe',
						"ipVersion": 0,
						"responseTimeMs": Date.now() - startTime
					};
				}
				try {
					// family: 4|6 => resolve só aquela família; null => v4-first com fallback v6.
					let resolved = false;
					if (family !== 6) {
						try {
							const ipv4s = await dns.resolve4(attrIP);
							resolvedIPs = ipv4s;
							targetHost = ipv4s[0];
							ipVersion = 4;
							resolved = true;
						} catch (ipv4Error) {
							if (family === 4) throw ipv4Error;
						}
					}
					if (!resolved) {
						const ipv6s = await dns.resolve6(attrIP);
						resolvedIPs = ipv6s;
						targetHost = ipv6s[0];
						ipVersion = 6;
					}
				} catch (dnsError) {
					recordApiRequest('portscan', '/portscan', Date.now() - startTime, 'failure');
					return {
						"timestamp": new Date().toISOString(),
						"protocol": protocol,
						"method": method,
						"host": attrIP,
						"err": 'host not found',
						"ipVersion": 0,
						"responseTimeMs": Date.now() - startTime
					};
				}
			} else {
				const is6 = net.isIPv6(attrIP);
				ipVersion = is6 ? 6 : 4;
				if (family && family !== ipVersion) {
					recordApiRequest('portscan', '/portscan', Date.now() - startTime, 'failure');
					return {
						"timestamp": new Date().toISOString(),
						"protocol": protocol,
						"method": method,
						"host": attrIP,
						"err": 'host not found',
						"ipVersion": 0,
						"responseTimeMs": Date.now() - startTime
					};
				}
			}
```

- [ ] **Step 4: Verificar (smoke test)**

Portscan TCP não usa raw socket — testável localmente sem privilégio elevado.

```bash
curl -s "http://localhost:8000/portscan/tcp/COMMON/www.google.com"            # inalterado: ipVersion 4
curl -s "http://localhost:8000/portscan/tcp/COMMON/www.google.com?family=6"   # ipVersion 6, scan via IPv6
curl -s "http://localhost:8000/portscan/tcp/COMMON/1.1.1.1?family=6"          # err host not found, ipVersion 0
```
Expected: `family=6` escaneia via IPv6 (`ipVersion:6`); `1.1.1.1?family=6` erra com `ipVersion:0`.

- [ ] **Step 5: Commit**

```bash
git add modules/portscan/main.js
git commit -m "feat(probe): portscan respeita ?family=4|6 (query e body)"
```

---

## Task 7: `http` respeita `family` (Host/SNI intacto)

**Files:**
- Modify: `modules/http/main.js` (import, handler: leitura do param; helper local `resolveForFamily`; 2 blocos de resolução linhas 163-187 e 215-240; `options.family` linha 244)

> Em `http`, forçar a família muda só **qual IP é usado na conexão** (`options.family`), mantendo `Host`/SNI = hostname (o `client.get` recebe `targetUrl`, que é a URL com o hostname). A resolução manual serve para reportar `ipVersion`/`resolvedIPs` e para errar cedo quando a família pedida não resolve.

- [ ] **Step 1: Adicionar o import do helper**

Em `modules/http/main.js`, após a linha 7 (`import { recordHttpSuccess, ... } from '../../metrics.js';`), adicionar:

```js
import { parseFamily } from '../../family.js';
```

- [ ] **Step 2: Adicionar o helper local de resolução por família**

Logo antes de `export const httpModule = {` (linha 113), adicionar a função:

```js
// Resolve o hostname respeitando a família pedida. family: 4|6|null.
// null => IPv4-first com fallback IPv6 (comportamento original). Lança em falha de resolução
// (o chamador transforma em erro DNS com ipVersion 0). Para IP literal que contradiz a
// família pedida (ex.: 1.1.1.1 com family=6), também lança.
async function resolveForFamily(hostname, family) {
	if (net.isIP(hostname)) {
		const v = net.isIPv6(hostname) ? 6 : 4;
		if (family && family !== v) throw new Error('host not found');
		return { resolvedIPs: null, ipVersion: v };
	}
	if (family === 6 && global.ipv6Support === false) {
		throw new Error('IPv6 not supported on this probe');
	}
	if (family !== 6) {
		try {
			const ipv4s = await dns.resolve4(hostname);
			return { resolvedIPs: ipv4s, ipVersion: 4 };
		} catch (ipv4Error) {
			if (family === 4) throw ipv4Error; // não cai para v6 quando v4 é obrigatório
		}
	}
	const ipv6s = await dns.resolve6(hostname);
	return { resolvedIPs: ipv6s, ipVersion: 6 };
}
```

- [ ] **Step 3: Ler `family` no início do handler**

Trocar a linha 118-119:

```js
			const startTime = Date.now();
			try {
```

por:

```js
			const startTime = Date.now();
			const family = parseFamily(request.query);
			try {
```

- [ ] **Step 4: Substituir o 1º bloco de resolução (externo) pelo helper**

Trocar o bloco atual (linhas 163-187):

```js
				if (hostname && !net.isIP(hostname)) {
					try {
						// Tentar resolver IPv4 primeiro
						try {
							const ipv4s = await dns.resolve4(hostname);
							resolvedIPs = ipv4s;
							ipVersion = 4;
						} catch (ipv4Error) {
							// Se IPv4 falhar, tentar IPv6 sempre
							const ipv6s = await dns.resolve6(hostname);
							resolvedIPs = ipv6s;
							ipVersion = 6;
						}
					} catch (dnsError) {
						return {
							"timestamp": new Date().toISOString(),
							"url": attrIP,
							"err": 'DNS resolution failed: ' + dnsError.message,
							"ipVersion": 0,
							"responseTimeMs": Date.now() - startTime
						};
					}
				} else if (net.isIP(hostname)) {
					ipVersion = net.isIPv6(hostname) ? 6 : 4;
				}
```

por:

```js
				if (hostname && !net.isIP(hostname)) {
					try {
						const r = await resolveForFamily(hostname, family);
						resolvedIPs = r.resolvedIPs;
						ipVersion = r.ipVersion;
					} catch (dnsError) {
						return {
							"timestamp": new Date().toISOString(),
							"url": attrIP,
							"err": 'DNS resolution failed: ' + dnsError.message,
							"ipVersion": 0,
							"responseTimeMs": Date.now() - startTime
						};
					}
				} else if (net.isIP(hostname)) {
					ipVersion = net.isIPv6(hostname) ? 6 : 4;
				}
```

- [ ] **Step 5: Substituir o 2º bloco de resolução (dentro de `makeRequest`) pelo helper**

Trocar o bloco atual (linhas 215-240):

```js
						if (currentParsedUrl.hostname && !net.isIP(currentParsedUrl.hostname)) {
							const dnsStart = Date.now();
							try {
								try {
									const ipv4s = await dns.resolve4(currentParsedUrl.hostname);
									currentResolvedIPs = ipv4s;
									currentIpVersion = 4;
								} catch (ipv4Error) {
									const ipv6s = await dns.resolve6(currentParsedUrl.hostname);
									currentResolvedIPs = ipv6s;
									currentIpVersion = 6;
								}
								dnsMs = Date.now() - dnsStart;
							} catch (dnsError) {
								reject({
									"timestamp": new Date().toISOString(),
									"url": targetUrl,
									"err": 'DNS resolution failed: ' + dnsError.message,
									"ipVersion": 0,
									"responseTimeMs": Date.now() - startTime
								});
								return;
							}
						} else if (net.isIP(currentParsedUrl.hostname)) {
							currentIpVersion = net.isIPv6(currentParsedUrl.hostname) ? 6 : 4;
						}
```

por:

```js
						if (currentParsedUrl.hostname && !net.isIP(currentParsedUrl.hostname)) {
							const dnsStart = Date.now();
							try {
								const r = await resolveForFamily(currentParsedUrl.hostname, family);
								currentResolvedIPs = r.resolvedIPs;
								currentIpVersion = r.ipVersion;
								dnsMs = Date.now() - dnsStart;
							} catch (dnsError) {
								reject({
									"timestamp": new Date().toISOString(),
									"url": targetUrl,
									"err": 'DNS resolution failed: ' + dnsError.message,
									"ipVersion": 0,
									"responseTimeMs": Date.now() - startTime
								});
								return;
							}
						} else if (net.isIP(currentParsedUrl.hostname)) {
							currentIpVersion = net.isIPv6(currentParsedUrl.hostname) ? 6 : 4;
						}
```

- [ ] **Step 6: Forçar `options.family` para a família pedida**

Trocar a linha 244:

```js
							family: currentIpVersion === 6 ? 6 : (currentIpVersion === 4 ? 4 : 0),
```

por:

```js
							family: family || (currentIpVersion === 6 ? 6 : (currentIpVersion === 4 ? 4 : 0)),
```

- [ ] **Step 7: Verificar (smoke test)**

HTTP não usa raw socket — testável localmente. A URL é base64 (ver CLAUDE.md), mas o módulo também aceita hostname direto no path.

```bash
curl -s "http://localhost:8000/http/www.google.com"            # inalterado: ipVersion 4, status 200/3xx
curl -s "http://localhost:8000/http/www.google.com?family=6"   # ipVersion 6, Host correto (200/3xx)
curl -s "http://localhost:8000/http/www.google.com?family=4"   # ipVersion 4
```
Expected: `family=6` conecta via IPv6 (`ipVersion:6`) e retorna status HTTP normal (Host/SNI preservados). Sem `family`, saída idêntica à anterior.

- [ ] **Step 8: Commit**

```bash
git add modules/http/main.js
git commit -m "feat(probe): http respeita ?family=4|6 (Host/SNI intactos)"
```

---

## Task 8: Documentar o param + varredura final

**Files:**
- Modify: `README.md` (root) — seção de módulos/uso

- [ ] **Step 1: Documentar `?family=` no README**

Adicionar (na seção que descreve os módulos/endpoints do probe) um parágrafo:

```markdown
### Seleção de família de endereço (IPv4/IPv6)

Todos os módulos baseados em resolução (`ping`, `http`, `traceroute`, `mtu`, `portscan`,
`smokeping`) aceitam o query param opcional **`family`**:

- `?family=4` — resolve e sonda **apenas** via IPv4 (só registros `A`).
- `?family=6` — resolve e sonda **apenas** via IPv6 (só registros `AAAA`).
- ausente — comportamento padrão: IPv4-first com fallback para IPv6.

Quando a família pedida não tem registro (ex.: `1.1.1.1?family=6`), a resposta vem com
`ipVersion: 0` e `err` (`HostNotFoundError`; ou `IPv6NotSupportedError` quando a VM não tem
egress IPv6). O módulo `dns` não usa `family` — ele já separa por `?method=A|AAAA`.
```

- [ ] **Step 2: Varredura de smoke test de retrocompatibilidade**

Com o probe rodando, confirmar que **toda** chamada sem `family` produz saída idêntica à de antes desta branch (comparar com o `main`, se possível):

```bash
for m in "ping/www.google.com" "traceroute/www.google.com/10" "mtu/www.google.com" \
         "portscan/tcp/COMMON/www.google.com" "http/www.google.com" "smokeping/www.google.com?count=5"; do
  echo "== $m =="; curl -s "http://localhost:8000/$m" | head -c 400; echo
done
```
Expected: cada resposta traz `ipVersion` coerente (4 por padrão para hosts dual-stack) e nenhum erro novo. Nenhuma regressão nas chamadas sem `family`.

- [ ] **Step 3: Rodar o teste unitário do helper (garantia)**

Run: `node --test family.test.js`
Expected: PASS (`# fail 0`).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(probe): documenta o query param ?family=4|6"
```

---

## Notas de verificação (repo sem suíte automatizada)

- `parseFamily` tem teste real via `node --test` (Task 1/Task 8) — sem novas dependências.
- Os módulos fazem I/O de rede/raw socket; são verificados por **smoke test** com `curl`
  (padrão do repo — ver `CLAUDE.md`). `http` e `portscan/tcp` rodam sem privilégio elevado;
  `ping`, `traceroute`, `mtu`, `smokeping` usam raw sockets (ICMP) e podem exigir
  `CAP_NET_RAW`/sudo (Linux) ou admin (Windows) — quando indisponível localmente, validar no
  probe implantado (Fly.io/PM2).
- **Retrocompatibilidade é requisito**: qualquer chamada sem `family` deve permanecer
  idêntica ao comportamento atual (o coletor de hoje não envia `family`).

## Próximo passo

Após implementado e verificado (e a branch integrada), seguir para o **sub-projeto #2**
(`probe-collector` + migrations): brainstorm → spec → plano, threadando `ip_version` como
dimensão de 1ª classe (seeding v4+v6, coluna, unique key, queries/analytics, `/overview`).
