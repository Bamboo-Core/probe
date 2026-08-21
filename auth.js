// Middleware de autenticação dos endpoints da probe.
//
// Camada primária: segredo compartilhado (header X-Probe-Key), mesmo padrão
// já usado pelo probe-collector para se proteger (X-Collector-Key). Camada de
// fallback: allowlist de IP (localhost e redes privadas/bogons) — só entra em
// jogo quando PROBE_SHARED_SECRET não está configurado (rollout gradual: o
// binário novo não quebra probes que ainda não receberam o segredo).
//
// ATENÇÃO — a allowlist de IP por si só NÃO é suficiente contra a internet: o
// Fastify (main.js) precisa estar com trustProxy desligado (ou restrito a
// proxies confiáveis), senão qualquer cliente pode forjar seu IP autorizado
// via header X-Forwarded-For e o allowlist não protege nada.

import net from 'net';
import crypto from 'crypto';

const SHARED_SECRET = process.env.PROBE_SHARED_SECRET || '';

/** Compara em tempo constante; tamanhos diferentes nunca vazam por timing. */
function timingSafeEqualStr(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
        // Compara contra si mesmo só para gastar tempo equivalente — evita que
        // a diferença de tamanho seja um oráculo de timing.
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

let authorizedIPs = [];
let initialized = false;

// Redes sempre autorizadas (localhost + RFC1918 + link-local).
// Quando a nova API estiver pronta, IPs adicionais podem ser injetados aqui.
const STATIC_AUTHORIZED_NETWORKS = [
    // Coletor
    '201.182.96.108',
    // Localhost
    '127.0.0.0/8',
    '::1/128',

    // Private networks (RFC 1918)
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',

    // Link-local
    '169.254.0.0/16',
    'fe80::/10',
];

/**
 * Normaliza um endereço IPv6 para formato completo (8 grupos de 4 hex)
 */
function normalizeIPv6(ip) {
    ip = ip.split('%')[0];

    let parts = ip.split(':');

    const emptyIndex = parts.indexOf('');
    if (emptyIndex !== -1) {
        const nonEmptyParts = parts.filter(p => p !== '');
        const zerosNeeded = 8 - nonEmptyParts.length;

        const before = parts.slice(0, emptyIndex).filter(p => p !== '');
        const after = parts.slice(emptyIndex).filter(p => p !== '');
        const zeros = new Array(zerosNeeded).fill('0000');

        parts = [...before, ...zeros, ...after];
    }

    parts = parts.map(p => p.padStart(4, '0').toLowerCase());

    while (parts.length < 8) {
        parts.push('0000');
    }

    return parts.slice(0, 8).join(':');
}

/**
 * Verifica se um IP está dentro de uma rede CIDR
 */
function isIPInNetwork(ip, network) {
    const [networkAddr, prefixLength] = network.split('/');
    const prefix = parseInt(prefixLength);

    if (net.isIPv4(ip) && net.isIPv4(networkAddr)) {
        const ipInt = ipToInt(ip);
        const networkInt = ipToInt(networkAddr);
        const mask = (0xFFFFFFFF << (32 - prefix)) >>> 0;
        return (ipInt & mask) === (networkInt & mask);
    } else if (net.isIPv6(ip) && net.isIPv6(networkAddr)) {
        const normalizedIP = normalizeIPv6(ip);
        const normalizedNetwork = normalizeIPv6(networkAddr);

        const ipParts = normalizedIP.split(':').map(p => parseInt(p, 16));
        const networkParts = normalizedNetwork.split(':').map(p => parseInt(p, 16));

        let bitsToCompare = prefix;
        for (let i = 0; i < 8 && bitsToCompare > 0; i++) {
            const bitsInThisGroup = Math.min(bitsToCompare, 16);
            const mask = (0xFFFF << (16 - bitsInThisGroup)) & 0xFFFF;

            if ((ipParts[i] & mask) !== (networkParts[i] & mask)) {
                return false;
            }

            bitsToCompare -= 16;
        }
        return true;
    }

    return false;
}

function ipToInt(ip) {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
}

/**
 * Inicializa o sistema de autenticação
 */
export async function initializeAuth() {
    if (initialized) return;
    authorizedIPs = [...STATIC_AUTHORIZED_NETWORKS];
    initialized = true;
}

/**
 * Middleware de autenticação. Com PROBE_SHARED_SECRET configurado, o segredo
 * é a ÚNICA via de acesso (a allowlist de IP não entra em jogo — IP sozinho
 * nunca deveria autorizar nada exposto à internet). Sem o segredo configurado
 * (probe ainda não recebeu a variável, rollout em andamento), cai no
 * comportamento anterior de allowlist de IP.
 */
export async function ipAuthMiddleware(request, reply) {
    if (SHARED_SECRET) {
        const provided = request.headers['x-probe-key'] || '';
        if (provided && timingSafeEqualStr(provided, SHARED_SECRET)) return;
        reply.status(401).send({
            error: 'Invalid or missing probe key',
            message: 'Requisição precisa do header X-Probe-Key correto.'
        });
        return;
    }

    if (!initialized) {
        await initializeAuth();
    }

    const clientIP = request.ip || request.socket.remoteAddress;

    if (!clientIP) {
        reply.status(401).send({
            error: 'Unable to determine client IP',
            message: 'Could not identify the source IP address'
        });
        return;
    }

    let authorized = false;
    for (const network of authorizedIPs) {
        if (network.includes('/')) {
            if (isIPInNetwork(clientIP, network)) {
                authorized = true;
                break;
            }
        } else {
            if (clientIP === network) {
                authorized = true;
                break;
            }
        }
    }

    if (!authorized) {
        reply.status(403).send({
            error: 'IP not authorized',
            message: `Access denied for IP: ${clientIP}`,
            clientIP: clientIP
        });
        return;
    }
}

export async function optionalAuthMiddleware(request, reply) {
    return await ipAuthMiddleware(request, reply);
}

export async function authMiddleware(request, reply) {
    return await ipAuthMiddleware(request, reply);
}

/**
 * Handler para status da autenticação. Endpoint PÚBLICO (sem middleware) —
 * não expõe a allowlist de IP nem o segredo aqui: listar exatamente quais IPs
 * passam é dar a receita de bypass pra quem só precisa forjar X-Forwarded-For.
 */
export async function authStatusHandler(request, reply) {
    if (!initialized) {
        await initializeAuth();
    }

    const response = {
        authType: SHARED_SECRET ? 'shared-secret' : 'ip-allowlist (legado)',
        message: SHARED_SECRET
            ? 'Autenticação por segredo compartilhado (header X-Probe-Key).'
            : 'Sem PROBE_SHARED_SECRET configurado — usando allowlist de IP (modo legado).'
    };

    if (!reply) {
        return response;
    }

    return response;
}
