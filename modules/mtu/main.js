import { promises as dns } from 'dns';
import net from 'net';
import { optionalAuthMiddleware } from '../../auth.js';
import { discoverMTU } from './mtu-tester.js';
import { recordMtuDiscovery, recordApiRequest } from '../../metrics.js';
import { parseFamily } from '../../family.js';

// Configuração específica do módulo MTU
const MTU_TIMEOUT = 500; // 500ms para descoberta de MTU rápida

export const mtuModule = {
	route: '/mtu/:id',
	method: 'get',
	middleware: [optionalAuthMiddleware],
	handler: async (request, reply) => {
		const startTime = Date.now();
		try {
			let attrIP = request.params.id.toString();
			const sessionID = request.query.sessionID;
			const family = parseFamily(request.query);
			
			let sID = (global.sID >= 65535) ? 0 : global.sID + 1;
			global.sID = sID;

			// Resolver DNS se necessário para IPv4 e IPv6
			let targetIP = attrIP;
			let resolvedIPs = null;
			let ipVersion = 0;
			
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

			// Executar descoberta de MTU
			const result = await discoverMTU(targetIP, MTU_TIMEOUT);
			
			// Record MTU discovery metrics
			recordMtuDiscovery(targetIP, result.mtu, Date.now() - startTime, result.supportsJumbo, ipVersion);
			recordApiRequest('mtu', '/mtu', Date.now() - startTime, 'success');
			
			return {
				"timestamp": new Date().toISOString(),
				"target": attrIP,
				"targetIP": targetIP,
				"resolvedIPs": resolvedIPs,
				"discoveredMTU": result.mtu,
				"supportsJumbo": result.supportsJumbo,
				"tests": result.tests,
				"validation": result.validation,
				"sessionID": sessionID,
				"sID": sID,
				"ipVersion": ipVersion,
				"responseTimeMs": Date.now() - startTime
			};

		} catch (error) {
			recordApiRequest('mtu', '/mtu', Date.now() - startTime, 'error');
			return {
				"timestamp": new Date().toISOString(),
				"target": request.params.id,
				"err": error.message,
				"sessionID": request.query.sessionID,
				"sID": global.sID,
				"responseTimeMs": Date.now() - startTime
			};
		}
	}
};
