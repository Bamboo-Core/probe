// icmp.js — utilidades ICMP puras (sem I/O de socket), extraídas de main.js pra
// serem testáveis sem depender de `raw-socket` (binário nativo, exige toolchain
// de compilação que nem sempre está disponível no ambiente).

const DEFAULT_PAYLOAD_SIZE = 32;

export function checksum(buf) {
	let sum = 0;
	for (let i = 0; i < buf.length; i += 2) {
		sum += buf.readUInt16BE(i);
		while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
	}
	return (~sum) & 0xffff;
}

export function buildIcmpEcho(isIPv6, identifier, seq) {
	const type = isIPv6 ? 128 : 8; // Echo Request types
	const buf = Buffer.alloc(8 + DEFAULT_PAYLOAD_SIZE, 0x61);
	buf.writeUInt8(type, 0);
	buf.writeUInt8(0, 1); // code
	buf.writeUInt16BE(0, 2); // checksum placeholder
	buf.writeUInt16BE(identifier & 0xffff, 4);
	buf.writeUInt16BE(seq & 0xffff, 6);
	buf.writeUInt16BE(checksum(buf), 2);
	return buf;
}

// Extrai type/code e, quando possível, o identifier/sequence do ECHO REQUEST
// ORIGINAL que gerou esta resposta — é o que garante que esta resposta é do
// NOSSO pacote, e não de outro traceroute/ping concorrente no mesmo host.
// Sockets ICMP raw recebem TODO tráfego ICMP daquele protocolo no sistema,
// não só a resposta ao pacote que este socket enviou (não há demultiplexação
// por porta como em TCP/UDP) — sem essa verificação, um traceroute concorrente
// pra outro alvo pode ter sua resposta aceita aqui por engano.
//   - Echo Reply: identifier/sequence vêm direto no cabeçalho ICMP da resposta.
//   - Time Exceeded: a resposta embute o pacote IP original (nosso echo
//     request) no corpo — o identifier/sequence reais estão dentro dele, não
//     no cabeçalho externo do Time Exceeded.
export function parseIcmpPacket(isIPv6, packet) {
	if (isIPv6) { // Sem cabeçalho IP: raw socket IPv6 entrega o payload ICMPv6 direto.
		if (packet.length < 8) return null;
		const type = packet[0], code = packet[1];
		if (type === 129) { // Echo Reply
			return { type, code, identifier: packet.readUInt16BE(4), sequence: packet.readUInt16BE(6) };
		}
		if (type === 3) { // Time Exceeded — embute IPv6 original (40 bytes fixos) + ICMPv6 original
			const origIcmpOffset = 8 + 40;
			if (packet.length >= origIcmpOffset + 8 && packet[origIcmpOffset] === 128) {
				return {
					type, code,
					identifier: packet.readUInt16BE(origIcmpOffset + 4),
					sequence: packet.readUInt16BE(origIcmpOffset + 6),
				};
			}
			return { type, code, identifier: null, sequence: null };
		}
		return { type, code, identifier: null, sequence: null };
	}
	if (packet.length < 28) return null; // IPv4 header + ICMP
	const ihl = (packet[0] & 0x0f) * 4;
	if (packet.length < ihl + 8) return null;
	const type = packet[ihl], code = packet[ihl + 1];
	if (type === 0) { // Echo Reply
		return { type, code, identifier: packet.readUInt16BE(ihl + 4), sequence: packet.readUInt16BE(ihl + 6) };
	}
	if (type === 11) { // Time Exceeded — embute IP original (IHL variável) + ICMP original
		const origIpOffset = ihl + 8;
		if (packet.length < origIpOffset + 20) return { type, code, identifier: null, sequence: null };
		const origIhl = (packet[origIpOffset] & 0x0f) * 4;
		const origIcmpOffset = origIpOffset + origIhl;
		if (packet.length < origIcmpOffset + 8 || packet[origIcmpOffset] !== 8) {
			return { type, code, identifier: null, sequence: null };
		}
		return {
			type, code,
			identifier: packet.readUInt16BE(origIcmpOffset + 4),
			sequence: packet.readUInt16BE(origIcmpOffset + 6),
		};
	}
	return { type, code, identifier: null, sequence: null };
}
