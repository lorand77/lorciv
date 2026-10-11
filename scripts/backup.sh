#!/bin/bash
# Daily SQLite backup to B2.
# Cron (as lorciv user):
#   0 3 * * * /home/lorciv/lorciv/scripts/backup.sh >> /home/lorciv/backups/backup.log 2>&1
set -e
export PATH=/usr/local/bin:/usr/bin:/bin

FILE=/home/lorciv/backups/lorciv-backup-$(date +%F).sqlite

mkdir -p /home/lorciv/backups
rm -f "$FILE"
sqlite3 /home/lorciv/lorciv/data/lorciv.sqlite "VACUUM INTO '$FILE'"
rclone copy "$FILE" b2:lorciv-backups/

# Delete local backups older than 7 days
find /home/lorciv/backups -name 'lorciv-backup-*.sqlite' -mtime +7 -delete

# Delete B2 backups older than 30 days
rclone delete b2:lorciv-backups/ --min-age 30d --b2-hard-delete

echo "$(date) backup OK: $FILE"
