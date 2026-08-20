import { promises as dns } from 'dns';
import net from 'net';
import raw from 'raw-socket';
import { optionalAuthMiddleware } from '../../auth.js';
import { recordTraceroute, recordApiRequest } from '../../metrics.js';
import { parseFamily } from '../../family.js';
import { buildIcmpEcho, parseIcmpPacket } from './icmp.js';

// Constantes de comportamento (manter mesmas semantics/valores)
const RAW_TIMEOUT_PER_HOP = 700; // ms
const MAX_CONSECUTIVE_TIMEOUTS = 8;

const debugLog = (...a) => console.log('[TRACEROUTE RAW]', ...a);
const trim = (s) => (typeof s === 'string' ? s.trim() : '');

// --------------------------------------------------
// Execução do traceroute via raw-socket
// --------------------------------------------------
async function rawTraceroute(targetIP, maxHops) {
	const isIPv6 = net.isIPv6(targetIP);
	const hops = [];
	let reachedDestination = false;
	let consecutiveTimeouts = 0;
	const family = isIPv6 ? raw.AddressFamily.IPv6 : raw.AddressFamily.IPv4;
	const protocol = isIPv6 ? raw.Protocol.ICMPv6 : raw.Protocol.ICMP;
	const identifier = Math.floor(Math.random() * 0xffff);
	debugLog('Iniciando', { targetIP, maxHops, isIPv6 });

	for (let ttl = 1; ttl <= maxHops; ttl++) {
		const startHop = Date.now();
		let hopInfo = { hop: ttl, ip: null, hostname: null, responseTime: null, status: 'timeout' };
		let socket;
		try {
			socket = raw.createSocket({ addressFamily: family, protocol });
			try {
				if (isIPv6) socket.setOption(raw.SocketLevel.IPPROTO_IPV6, raw.SocketOption.IPV6_UNICAST_HOPS, ttl);
				else socket.setOption(raw.SocketLevel.IPPROTO_IP, raw.SocketOption.IP_TTL, ttl);
			} catch (optErr) { debugLog('Falha setOption', optErr.message); }

			const echo = buildIcmpEcho(isIPv6, identifier, ttl);
			const recvPromise = new Promise((resolve) => {
				socket.on('message', (buf, src) => {
					const parsed = parseIcmpPacket(isIPv6, buf);
					if (!parsed) return;
					const rtt = Date.now() - startHop;
						// IPv6: Echo Reply(129), Time Exceeded(3); IPv4: Echo Reply(0), Time Exceeded(11)
					const isReply = (isIPv6 && parsed.type === 129) || (!isIPv6 && parsed.type === 0);
					const isTime = (isIPv6 && parsed.type === 3) || (!isIPv6 && parsed.type === 11);
					if (!isReply && !isTime) return; // ignorar outros tipos
					// BUG CRÍTICO CORRIGIDO AQUI: sem checar identifier/sequence, este
					// socket aceitava a resposta ICMP de QUALQUER traceroute/ping
					// concorrente no mesmo host (raw socket recebe todo ICMP do
					// sistema) — o alvo A podia terminar mostrando os hops do alvo B.
					if (parsed.identifier !== identifier || parsed.sequence !== ttl) return;
					hopInfo = { hop: ttl, ip: src, hostname: src, responseTime: rtt, status: isReply ? 'reached' : 'intermediate' };
					if (isReply) reachedDestination = true;
					resolve();
				});
				socket.on('error', e => debugLog('Socket erro hop', ttl, e.message));
				setTimeout(() => resolve(), RAW_TIMEOUT_PER_HOP);
			});
			socket.send(echo, 0, echo.length, targetIP, (err) => err && debugLog('Erro send', ttl, err.message));
			await recvPromise;
		} catch (err) {
			debugLog('Erro hop', ttl, err.message);
			hopInfo.status = 'error';
			hopInfo.error = err.message;
		} finally { try { socket && socket.close(); } catch { /* noop */ } }

		if (hopInfo.status === 'timeout') consecutiveTimeouts++; else consecutiveTimeouts = 0;
		hops.push(hopInfo);
		if (reachedDestination || consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) break;
	}

	return {
		hops,
		reachedDestination,
		totalHops: hops.length,
		timeouts: hops.filter(h => h.status === 'timeout').length,
		// Heurística: se vários timeouts no final após pelo menos 1 hop responsivo
		suspectedDestination: (() => {
			if (reachedDestination) return null;
			const MIN_TRAILING_TIMEOUTS = 5; // configurável futuramente
			let lastResponsiveIdx = -1;
			for (let i = hops.length - 1; i >= 0; i--) {
				if (hops[i].status !== 'timeout') { lastResponsiveIdx = i; break; }
			}
			if (lastResponsiveIdx === -1) return null; // nenhum hop respondeu
			const trailing = hops.length - 1 - lastResponsiveIdx;
			if (trailing < MIN_TRAILING_TIMEOUTS) return null;
			const hop = hops[lastResponsiveIdx];
			if (hop.status === 'reached') return null; // já seria destino
			const suspected = {
				hop: hop.hop,
				ip: hop.ip,
				hostname: hop.hostname,
				trailingTimeouts: trailing,
				reason: 'consecutive_timeouts_after_last_response'
			};
			debugLog('suspectedDestination heurística', suspected);
			return suspected;
		})(),
		method: 'raw-socket-icmp'
	};
}

// --------------------------------------------------
// Resolução de target (hostname/IP) mantendo mesma lógica de fallback
// --------------------------------------------------
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

// --------------------------------------------------
// Módulo Fastify exportado
// --------------------------------------------------
export const tracerouteModule = {
	route: '/traceroute/:id/:maxhops?',
	method: 'get',
	middleware: [optionalAuthMiddleware],
	handler: async (request, reply) => {
		const startTime = Date.now();
		try {
			const attrIP = request.params.id.toString();
			const family = parseFamily(request.query);
			const maxHops = request.params.maxhops ? parseInt(trim(request.params.maxhops)) : 30;
			const sessionID = request.query.sessionID;
			debugLog('Params', { attrIP, maxHops, sessionID });

			if (maxHops < 1 || maxHops > 64) {
				recordApiRequest('traceroute', '/traceroute', Date.now() - startTime, 'failure');
				return { timestamp: new Date().toISOString(), target: attrIP, err: 'invalid max hops (1-64)', sessionID, responseTimeMs: Date.now() - startTime };
			}

			// Atualiza sID global preservando faixa
			global.sID = (global.sID >= 65535) ? 0 : (global.sID + 1 || 0);
			const sID = global.sID;

			const { targetIP, resolvedIPs, ipVersion, err } = await resolveTarget(attrIP, family);
			if (err) {
				recordApiRequest('traceroute', '/traceroute', Date.now() - startTime, 'failure');
				return { timestamp: new Date().toISOString(), target: attrIP, err, sessionID, ipVersion: 0, responseTimeMs: Date.now() - startTime };
			}

			debugLog('Executando rawTraceroute', { targetIP, ipVersion });
			let finalResult;
			try {
				finalResult = await rawTraceroute(targetIP, maxHops);
			} catch (rtErr) {
				recordApiRequest('traceroute', '/traceroute', Date.now() - startTime, 'failure');
				return { timestamp: new Date().toISOString(), target: attrIP, err: 'raw traceroute failed: ' + rtErr.message, ipVersion, responseTimeMs: Date.now() - startTime };
			}

			// Record traceroute metrics
			recordTraceroute(targetIP, finalResult.hops, Date.now() - startTime, finalResult.reachedDestination, ipVersion);
			recordApiRequest('traceroute', '/traceroute', Date.now() - startTime, 'success');

			return {
				timestamp: new Date().toISOString(),
				target: attrIP,
				targetIP,
				resolvedIPs,
				maxHops,
				totalHops: finalResult.totalHops,
				reachedDestination: finalResult.reachedDestination,
				timeouts: finalResult.timeouts,
				hops: finalResult.hops,
				suspectedDestination: finalResult.suspectedDestination,
				method: finalResult.method,
				sessionID,
				sID,
				ipVersion,
				responseTimeMs: Date.now() - startTime
			};
		} catch (error) {
			debugLog('ERRO CRÍTICO', error.message, error.stack);
			recordApiRequest('traceroute', '/traceroute', Date.now() - startTime, 'error');
			
			return { timestamp: new Date().toISOString(), target: request.params.id, err: error.message, sessionID: request.query.sessionID, sID: global.sID, responseTimeMs: Date.now() - startTime };
		}
	}
};
