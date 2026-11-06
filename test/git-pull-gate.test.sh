#!/bin/sh
# Testa o gate PROBE_GIT_PULL do cron-setup.sh com um `crontab` falso (grava o stdin num arquivo).
set -eu
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/crontab" <<'FAKE'
#!/bin/sh
if [ "$1" = "-r" ]; then rm -f "$OUT"; else cat > "$OUT"; fi
FAKE
chmod +x "$tmp/crontab"
export OUT="$tmp/saida" CRONTAB_BIN="$tmp/crontab"
falhas=0
ok() { echo "ok - $1"; }
nok() { echo "FALHOU - $1"; falhas=$((falhas + 1)); }

env -u PROBE_GIT_PULL ./cron-setup.sh
grep -q 'git pull' "$OUT" && ok "sem PROBE_GIT_PULL: crontab contém git pull" || nok "sem PROBE_GIT_PULL deveria ter git pull"

rm -f "$OUT"; PROBE_GIT_PULL=1 ./cron-setup.sh
grep -q 'git pull' "$OUT" && ok "PROBE_GIT_PULL=1: crontab contém git pull" || nok "PROBE_GIT_PULL=1 deveria ter git pull"

PROBE_GIT_PULL=0 ./cron-setup.sh
if [ -f "$OUT" ] && grep -q 'git pull' "$OUT"; then nok "PROBE_GIT_PULL=0 não pode ter git pull"; else ok "PROBE_GIT_PULL=0: crontab sem git pull"; fi

[ "$falhas" -eq 0 ]
