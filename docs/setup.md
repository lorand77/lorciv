# DEV environment

## general setup
- laptop/desktop
- OS (Windows)
- browser (Brave)
- VSC
- git
- WSL2
- Docker

## setup project
- folder with code in the OS
- open folder with VSC ("VSC project")
- Ctrl-Sh-P add dev container... (ubuntu)
- create git repo + publish to github

## install stuff
- install node+npm packages
- install claude code


### install node+npm
```
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

npm config set ignore-scripts true
npm config set save-exact true
npm config set min-release-age=7

npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
# close terminal and open a new terminal

npm install -g @socketsecurity/cli


socket wrapper on
npm install PACKAGE_NAME     ## routed via socket now


# if needed:
npm install PACKAGE_NAME --ignore-scripts=false
```

The wrapper aliases `npm` to `socket npm`. A leading backslash (`\npm`) skips the
alias and runs plain npm, without Socket's check. Four things the wrapper changes:
- It scans only packages that an install adds or changes in `node_modules`. For
  a full scan: `rm -rf node_modules && npm ci`, and look for
  `Socket npm found no risks` (not "no *new* risks").
- It adds `--no-audit` whenever `node_modules` exists, so `npm audit fix` fixes
  nothing. Use `npm audit fix --audit`.
- `npm rebuild` through it runs no install scripts, yet still reports success.
  Rebuild with `\npm rebuild ...`; the packages were already scanned when they
  were installed.
- Scripts (`npm test`, `npm run dev`, `npm start`) run under Node's permission
  model, allowed to write only in the project, npm's prefix and npm's cache.
  The tests put their database in the OS temp dir, so through the wrapper they
  fail with `ERR_ACCESS_DENIED`. Run scripts with `node --run test` (built into
  Node, no npm) or `\npm test`.

### install claude code
```
curl -fsSL https://claude.ai/install.sh | bash
```

or install the VSC extension

## run the app
```
npm ci             # installs exactly package-lock.json; wipes node_modules first

# Native modules (better-sqlite3, argon2) get their binary from their install
# script. Two gates block that script; the rebuild below clears both:
#   1. our global ignore-scripts=true  -> --ignore-scripts=false lifts it
#   2. npm's install-script allowlist -> already granted by "allowScripts"
#      in package.json (committed), so no `npm install-scripts approve` needed
# The backslash bypasses the socket alias, whose rebuild silently does nothing.
# Needed after every `npm ci`, since that deletes the compiled binary.
\npm rebuild better-sqlite3 argon2 --foreground-scripts --ignore-scripts=false

npm start
```

If `npm test` or `npm start` fails with "Could not locate the bindings file",
the rebuild was skipped or ran through the wrapper: run the `\npm rebuild` line.

## test in browser
open http://localhost:3001

## run the tests
```
node --run test    # or: \npm test
```
Plain `npm test` goes through the wrapper, whose permission model blocks the
tests' temporary database (see above).

## updating node and socket
npm is the version bundled with Node and is updated along with it.
```
sudo apt update && sudo apt install --only-upgrade nodejs

# socket, through the alias so socket checks its own update; if it trips over
# replacing itself mid-install, run it once as \npm install -g ...
npm install -g @socketsecurity/cli

# check: a full socket scan, the native rebuild and the tests
npm ci    # look for "Socket npm found no risks"
\npm rebuild better-sqlite3 argon2 --foreground-scripts --ignore-scripts=false
\npm test
```

--------------------------------------------------------

# PROD environment - ubuntu server (AWS EC2)

LorCiv runs on the same EC2 instance as LorChess, as a separate process under
its own system user, on its own port, with its own database, `.env`, pm2 daemon
and backups. The two apps share nothing but the machine and Caddy.

Machine-wide pieces (Node, the global pm2 package, Caddy, sqlite3, rclone) were
installed once by the LorChess setup and are not repeated here; what follows is
what LorCiv adds, plus the per-user steps, which every app user does for
themselves.

## setup user

```
ssh ubuntu@IP_ADDRESS
sudo adduser --disabled-password --gecos "" lorciv
```

`lorciv` owns the code, the database and its pm2 daemon, and has no sudo.
Commands starting with `sudo` run as `ubuntu`; everything else runs as
`lorciv`, after `sudo -u lorciv -i`.


## project code
```
sudo -u lorciv -i
git clone https://github.com/lorand77/lorciv.git
```

## node+npm

Already on the machine (LorChess installed it). A Node update is machine-wide:
```
sudo apt update && sudo apt install --only-upgrade nodejs
```
then `pm2 update` as `lorciv` AND as `lorchess`: each app keeps running on the
old Node until its own daemon is told (see "updating pm2").

## configure environment

Create `.env` in the project dir. It is gitignored, and the `npm` scripts load
it at startup via `node --env-file-if-exists=.env` (nothing else reads it).

```
cd ~/lorciv

# generate a fresh secret:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

cat > .env <<EOF
SESSION_SECRET=<generated hex>
NODE_ENV=production
EOF

chmod 600 .env
```

- `SESSION_SECRET` — signs the session cookie. If unset, `src/config.js` falls
  back to a hardcoded dev default that is public in this repo; anyone who then
  obtains a session id (from logs or a DB backup) can turn it into a valid
  cookie. Use a different value per environment and never commit it. Changing it
  invalidates all existing sessions, i.e. logs everyone out.
- `NODE_ENV=production` — puts Express in production mode, and names the
  session cookie `__Host-lorciv.sid`, always `Secure` (`src/config.js`): a
  page on another `*.lorand77.dev` host cannot then plant a cookie of that
  name. The app must then be reached over HTTPS, through Caddy; a request
  straight to port 3001 over HTTP gets no session cookie and cannot sign in.
  Without it the cookie is `lorciv.sid`, as in development. Turning it on, or
  deploying the change that introduced the name (2026-10-11), signs everyone
  out once: their old cookie has a different name. npm never reads
  `.env`, so it does not make `npm ci` skip devDependencies: that is what
  `--omit=dev` is for. (Uncaught errors never send a stack trace to
  the client either way: `src/app.js` answers them itself.)

Everything else has a default and is read in `src/config.js`; put it in `.env`
only to change it:

- `PORT` — the HTTP port (default 3001; LorChess has 3000 on this machine, and
  Caddy proxies to 3001 below).
- `DB_PATH` — the SQLite file (default `data/lorciv.sqlite` in the project).
- `DEADLINE_SWEEP_MS` — how often expired human turns are ended (default 1000).
- `ABANDON_DAYS` — tables and games untouched this long are aborted (default 30).
- `CHAT_RETENTION_DAYS` — how long in-game chat is kept after a game ends;
  `-1` keeps it for ever (default 30).
- `LOGIN_MAX_FAILURES`, `REGISTER_MAX`, `AUTH_WINDOW_MS` — failed logins and
  new accounts allowed per client IP within the window (default 10, 5 and
  900000, i.e. 15 min); past that, 429 until the window moves on.
- `HASH_MAX_CONCURRENT` — how many password hashes or checks may run at once
  (default 2, one per vCPU); more get 503 "server busy" instead of waiting.
- `DEACTIVATION_SWEEP_MS` — how often sockets of accounts deactivated from the
  command line are disconnected (default 30000, i.e. 30 s).
- `LOG_LEVEL` — `silent`, `error`, `warn`, `info` or `debug` (default `info`);
  `debug` adds detail for an investigation. See "Logging" in `design.md`.

## run the app
```
npm ci --omit=dev
npm start
```

or better use pm2 (the global package is already installed, by LorChess's
setup; each user runs their own daemon):
```
sudo -u lorciv -i
pm2 start npm --name "lorciv" -- start

# survive reboot:
pm2 save
pm2 startup                     # prints a `sudo env PATH=... pm2 startup ... -u lorciv --hp /home/lorciv` line: run that as ubuntu


pm2 list                        # see all running processes and their status
pm2 logs lorciv                 # tail live logs
pm2 logs lorciv --lines 100     # show last 100 lines
pm2 restart lorciv              # restart the app (e.g. after deploying new code)
pm2 stop lorciv                 # stop without removing from pm2's list
pm2 delete lorciv               # remove from pm2 entirely
pm2 monit                       # live dashboard: CPU, memory, logs
```

The boot service from `pm2 startup` is per user (`pm2-lorciv`), next to
LorChess's `pm2-lorchess`; each brings its own daemon and app up at boot.

### updating pm2

Two parts: the global package (installed with sudo, shared by both apps) and
the daemon already running the app, which keeps the old version until told to
reload.
```
sudo npm install -g pm2@latest  # as ubuntu, once for the machine

sudo -u lorciv -i
pm2 update                      # saves the list, restarts the daemon and the app (a few seconds down)
pm2 save
```
and the same `pm2 update` as `lorchess`.

- A Node update leaves pm2 installed, but the daemon keeps the old Node until
  `pm2 update`.
- The boot service from `pm2 startup` calls `/usr/bin/pm2`, which doesn't move,
  so `pm2 startup` needn't be rerun.

Check:
```
pm2 list                        # lorciv "online"
```


### log rotation

pm2 appends the app's stdout and stderr to `~/.pm2/logs/lorciv-out.log` and
`~/.pm2/logs/lorciv-error.log` and never trims them, so without rotation they
grow until the disk is full (and SQLite can no longer write). The rotation
module is per user: install it as `lorciv` too:
```
pm2 install pm2-logrotate
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'   # rotate daily at midnight
pm2 set pm2-logrotate:max_size 50M                 # and early if a file reaches 50 MB
pm2 set pm2-logrotate:retain 14                    # keep 14 rotated files per log
pm2 set pm2-logrotate:compress true                # gzip the rotated files
```

Rotated files sit next to the live ones as `lorciv-out__<date>.log.gz`.
`retain` counts files, not days: a size-triggered rotation adds a file, so
the 14 kept cover at most 14 days, never more. Rotation copies the file and
then truncates it, so the app keeps writing without a restart. pm2's own
`~/.pm2/pm2.log` is rotated too. The privacy policy says logs live 14 days:
keep these settings in step with it.

```
pm2 conf pm2-logrotate     # show the current settings
ls -lh ~/.pm2/logs/        # live and rotated files with their sizes
```

## https with custom domain (Caddy)

Caddy is installed and serving LorChess on this machine; ports 80 and 443 are
open in the EC2 firewall. Port 3001 is not, and must stay closed: the app
trusts `X-Forwarded-For` for its login throttling (see `design.md`), which is
only safe while every request comes through Caddy.

- name.com: manage DNS -> add A record: host `lorciv` -> IP_ADDRESS

Add a second site block to /etc/caddy/Caddyfile:
```
lorchess.lorand77.dev {
    reverse_proxy localhost:3000
}

lorciv.lorand77.dev {
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy localhost:3001
}
```

The `header` line is HSTS: a browser that has been to the site once goes
straight to HTTPS for a year, so a hostile network cannot hold a later visit
on plain HTTP. It covers this host only; adding `includeSubDomains` on the
parent domain, or `preload`, would commit every `*.lorand77.dev` host to
HTTPS and is a decision for the whole domain. On a server already running,
add the line to the existing block and reload Caddy as below.

```
sudo systemctl reload caddy
```

## deploying new code
```
git pull
npm ci --omit=dev  # exactly the committed package-lock.json, nothing re-resolved
pm2 restart lorciv
```

As one line, run as `lorciv` from anywhere; a failed pull or install stops it
before the restart:
```
cd ~/lorciv && git pull && npm ci --omit=dev && pm2 restart lorciv
```

`npm ci` deletes `node_modules` and reinstalls, so restart straight after.
Here ignore-scripts is not set, so the native modules build during `npm ci`. If
it ever is set on the server, add the `\npm rebuild ...` line from the dev
"run the app" section before restarting. Never `npm install` or `npm audit fix`
on the server: change dependencies in dev, test, commit the lockfile, deploy.

A restart is safe at any moment: every accepted action is already in SQLite,
every active game is rebuilt when the server comes back, and a turn that ran
out while it was down is ended on the first sweep.

## changing a user's password

There is no self-service reset flow. Run this in the project dir on the server
(same user the app runs as, so it picks up `.env` / `DB_PATH`). It is safe to run
while the app is up.

```
npm run user:password -- <username>
```

It prompts twice for the new password with echo off. The password is never
passed as an argument, so it does not land in shell history. Non-interactive
use (e.g. from a deploy script) reads the first line of stdin instead:

```
echo "<new password>" | npm run user:password -- <username>
```

Minimum length is 6, matching registration. The user's existing sessions stay
logged in; if they must be kicked out, restart the app with a new
`SESSION_SECRET` (logs everyone out).

## deactivating a user

Same place and same rules as above (project dir, app user, safe while running):

```
npm run user:deactivate -- <username>
npm run user:reactivate -- <username>
```

A deactivated user cannot log in (they are told the account is deactivated,
but only after typing the right password). Their sessions are ended at once;
open tabs are disconnected within 30 s (`DEACTIVATION_SWEEP_MS`). A seat they
hold in a live game is not touched: its turns run out on the table's clock and
after three the AI takes the seat, as for any absent player. Nothing is
deleted: the username stays taken, and reactivating restores the account.

## deleting a user

For a deletion request (the privacy policy promises one by email). Same place
and rules as above. There is no undo:

```
npm run user:delete -- <username>
```

It prints what will be kept and deleted and asks you to type the username back.
The account becomes `deleted-<id>`. It can't log in and appears nowhere; the
games it took part in stay in the other players' records under that name. Its
chat and sessions are deleted, tables it hosted are cancelled, seats it held at
other tables are released, and the old username can be registered again. If
the user holds a seat in a live game it refuses: deactivate them first, let the
turn clock hand the seat to the AI, then delete. A game with no clock never
does that; its other players can leave it. Copies in B2 backups expire with the
backups.

Before deleting, make sure the request really comes from the account's owner.
There is no email on file, so ask them to prove it from inside the account, for
example by sending a chat message you name in one of their games.

## backing up sqlite database

sqlite3 is installed (by LorChess's setup). As `lorciv`:
```
sudo -u lorciv -i
cd ~/lorciv
mkdir -p ~/backups
sqlite3 data/lorciv.sqlite "VACUUM INTO '$HOME/backups/lorciv-backup-$(date +%F).sqlite'"
```

and move the backup file somewhere safe (e.g. download to local machine, upload to cloud storage etc.)


### backup to B2

rclone is installed (by LorChess's setup), but its configuration is per user:
`lorciv` configures its own remote, pointing at its own bucket.
```
sudo -u lorciv -i
rclone config                   # a remote named b2, bucket lorciv-backups
rclone copy test1.txt b2:lorciv-backups/
# restore:
rclone copy b2:lorciv-backups/test1.txt .
```

and create a cron job to run the backup script `scripts/backup.sh` daily: as
`lorciv`, `crontab -e` and add
```
0 3 * * * /home/lorciv/lorciv/scripts/backup.sh >> /home/lorciv/backups/backup.log 2>&1
```
It writes to `~/backups/`, the same folder as the manual backup above, and
keeps 7 days there and 30 days in B2. The privacy policy says backups are kept
for at most 90 days; this keeps well within that.

#### restoring from B2

Restore, in the project dir:
```
rclone copy b2:lorciv-backups/lorciv-backup-DATE.sqlite ~/backups/   # only if it isn't in ~/backups
pm2 stop lorciv
cp ~/backups/lorciv-backup-DATE.sqlite data/lorciv.sqlite
rm -f data/lorciv.sqlite-wal data/lorciv.sqlite-shm
pm2 start lorciv
```