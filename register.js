import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces } from 'os';

let registrationIntervalId = null;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE_HASH_FILE = join(__dirname, '.probe-hash');

let cachedProbeHash = null;

/**
 * Lê o machine-id do sistema operacional Linux
 */
function getMachineId() {
    const machineIdPaths = [
        '/etc/machine-id',
        '/var/lib/dbus/machine-id'
    ];

    for (const path of machineIdPaths) {
        try {
            if (existsSync(path)) {
                const machineId = readFileSync(path, 'utf8').trim();
                if (machineId && machineId.length > 0) {
                    return machineId;
                }
            }
        } catch (error) {
            // tenta próximo caminho
        }
    }

    return `fallback-${process.env.HOSTNAME || 'unknown'}-${process.pid}`;
}

/**
 * Gera ou recupera o hash único da probe
 */
function getOrCreateProbeHash() {
    if (cachedProbeHash) {
        return cachedProbeHash;
    }

    try {
        if (existsSync(PROBE_HASH_FILE)) {
            const savedData = JSON.parse(readFileSync(PROBE_HASH_FILE, 'utf8'));
            if (savedData.hash && savedData.createdAt) {
                cachedProbeHash = savedData.hash;
                console.log(`✓ [${global.sID || process.pid}] Probe hash loaded (created: ${savedData.createdAt})`);
                return cachedProbeHash;
            }
        }
    } catch (error) {
        console.warn(`⚠ [${global.sID || process.pid}] Failed to load probe hash: ${error.message}`);
    }

    const machineId = getMachineId();
    const createdAt = new Date().toISOString();
    const timestamp = Date.now();

    const dataToHash = `${machineId}:${timestamp}:${createdAt}`;
    const hash = createHash('sha256').update(dataToHash).digest('hex');

    try {
        const hashData = {
            hash,
            machineId: machineId.substring(0, 8) + '...',
            createdAt,
            timestamp
        };
        writeFileSync(PROBE_HASH_FILE, JSON.stringify(hashData, null, 2), 'utf8');
        console.log(`✓ [${global.sID || process.pid}] New probe hash generated and saved`);
    } catch (error) {
        console.warn(`⚠ [${global.sID || process.pid}] Failed to save probe hash: ${error.message}`);
    }

    cachedProbeHash = hash;
    return hash;
}

/**
 * Detecta suporte IPv4/IPv6 e endereços locais a partir das interfaces da máquina,
 * sem qualquer chamada externa.
 */
function detectLocalIPs() {
    const result = {
        ipv4: { supported: false, ip: null, port: global.serverPort },
        ipv6: { supported: false, ip: null, port: global.serverPort }
    };

    const interfaces = networkInterfaces();

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (iface.internal) continue;

            if (iface.family === 'IPv4' && !result.ipv4.supported) {
                result.ipv4.supported = true;
                result.ipv4.ip = iface.address;
            } else if (iface.family === 'IPv6' && !result.ipv6.supported) {
                // Ignora link-local IPv6 (fe80::/10)
                if (!iface.address.toLowerCase().startsWith('fe80')) {
                    result.ipv6.supported = true;
                    result.ipv6.ip = iface.address;
                }
            }
        }
    }

    return result;
}

/**
 * Detecta suporte IPv4/IPv6 a partir das interfaces locais e prepara o probeHash.
 * Não realiza chamadas externas.
 */
export async function detectNetworkSupport() {
    const { ipv4, ipv6 } = detectLocalIPs();

    global.ipv4Support = ipv4.supported;
    global.ipv6Support = ipv6.supported;

    global.probeIPs = {
        ipv4: ipv4.ip,
        ipv6: ipv6.ip
    };

    global.probeHash = getOrCreateProbeHash();

    return { ipv4Result: ipv4, ipv6Result: ipv6 };
}

/**
 * Registro remoto desabilitado. Mantido como no-op até a nova API ser configurada.
 */
async function performRegistration() {
    global.isRegistered = false;
    console.log(`ℹ [${global.sID || process.pid}] Remote registration disabled (no external API configured)`);
    return false;
}

function shouldRunRegistration() {
    const instanceId = process.env.NODE_APP_INSTANCE || process.env.PM2_INSTANCE_ID || '0';
    return instanceId === '0';
}

/**
 * Inicializa o sistema de registro. Atualmente é um no-op: a probe não envia
 * dados para nenhum endpoint externo. Quando a nova API estiver disponível,
 * a lógica de registro deverá ser plugada em `performRegistration`.
 */
export async function initializeRegistration() {
    if (!shouldRunRegistration()) {
        return;
    }

    await performRegistration();
}

export function stopRegistration() {
    if (registrationIntervalId) {
        clearInterval(registrationIntervalId);
        registrationIntervalId = null;
    }
}
