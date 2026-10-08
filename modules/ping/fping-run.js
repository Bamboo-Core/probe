import { execFile } from 'node:child_process';
import { parseFpingBatch } from './fping-parse.js';

// Shell-out ao fping. targets = literais; family = 4|6; count = nº pacotes.
// Injetável (runner) p/ teste. RC != 0 quando algum alvo falha — é esperado,
// resolve com stdout mesmo assim.
export function runFping({ targets, family, count }) {
  return new Promise((resolve) => {
    const args = ['-c', String(count), '-q', `-${family}`, ...targets];
    execFile('fping', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (_err, stdout, stderr) => resolve(`${stdout || ''}\n${stderr || ''}`));
  });
}

export async function buildBatchResponse({ targets, family, count }, runner = runFping) {
  const list = Array.isArray(targets) ? targets.filter(Boolean) : [];
  const stdout = list.length ? await runner({ targets: list, family, count }) : '';
  return { datetime: new Date().toISOString(), family, results: parseFpingBatch(stdout) };
}
