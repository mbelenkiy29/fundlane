#!/bin/sh
set -eu
mkdir -p /data/documents /data/clamav
chown node:node /data/documents
chown clamav:clamav /data/clamav
# Persist signatures across releases. A refresh failure leaves scanning fail-closed.
printf 'DatabaseDirectory /data/clamav\nDatabaseMirror database.clamav.net\nChecks 12\n' > /etc/clamav/freshclam.conf
freshclam --quiet || printf 'Antivirus signature refresh unavailable; document validation may remain blocked.\n' >&2
freshclam --daemon --quiet || printf 'Antivirus updater unavailable; inspect runtime logs before accepting new uploads.\n' >&2
export MCA_DOCUMENT_SCANNER=clamscan
export MCA_DOCUMENT_SCANNER_COMMAND=/usr/local/bin/fundlane-scan
printf '#!/bin/sh\nexec clamscan --database=/data/clamav "$@"\n' > /usr/local/bin/fundlane-scan
chmod 755 /usr/local/bin/fundlane-scan
export MCA_DOCUMENT_STORAGE_PATH=/data/documents
export HOSTNAME=0.0.0.0
exec gosu node node supervisor.cjs
