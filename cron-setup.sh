#!/bin/sh
# Instala o crontab do container. O `git pull` a cada 10 min só entra quando
# PROBE_GIT_PULL != "0" (imagens versionadas do NOC sobem com PROBE_GIT_PULL=0;
# Fly e instalações atuais não definem a env e mantêm o comportamento anterior).
# CRONTAB_BIN permite substituir o `crontab` nos testes.
set -eu
CRONTAB_BIN="${CRONTAB_BIN:-crontab}"

if [ "${PROBE_GIT_PULL:-1}" = "0" ]; then
	"$CRONTAB_BIN" -r 2>/dev/null || true
else
	echo "*/10 * * * * cd /app && git pull" | "$CRONTAB_BIN" -
fi
