// Parser da saída do `fping -q` (modo lote). Uma linha de sumário por host.
// Mesmas regras de contabilização do agente OpenWrt (migration 007):
//   mediu+eco -> ms/min_ms/max_ms/loss_pct ; mediu+sem eco -> ms:null+loss_pct ;
//   não-medido -> ms:null + err NotMeasured (SEM loss_pct).
const LOSS_RE = /%loss = \d+\/\d+\/(\d+)%/;
const MMM_RE = /min\/avg\/max = ([\d.]+)\/([\d.]+)\/([\d.]+)/;

export function parseFpingBatch(stdout) {
  const out = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes(' : ')) continue;
    const target = line.split(' ')[0];
    const loss = line.match(LOSS_RE);
    const mmm = line.match(MMM_RE);
    if (mmm) {
      out.push({
        target,
        ms: Number(mmm[2]),
        min_ms: Number(mmm[1]),
        max_ms: Number(mmm[3]),
        loss_pct: loss ? Number(loss[1]) : 0,
      });
    } else if (loss) {
      out.push({ target, ms: null, loss_pct: Number(loss[1]),
        err: { message: `sem resposta de ${target}` } });
    } else {
      out.push({ target, ms: null,
        err: { name: 'NotMeasured', message: `sem medição de ${target}` } });
    }
  }
  return out;
}
