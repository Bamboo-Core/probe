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
