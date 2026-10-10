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

### install claude code
```
curl -fsSL https://claude.ai/install.sh | bash
```

## run the app
```
npm install

# Native modules (better-sqlite3, argon2) compile a binary in their install
# script. Two gates block that script; the rebuild below clears both:
#   1. our global ignore-scripts=true  -> --ignore-scripts=false lifts it
#   2. npm's install-script allowlist  -> already granted by "allowScripts"
#      in package.json (committed), so no `npm install-scripts approve` needed
npm rebuild better-sqlite3 argon2 --foreground-scripts --ignore-scripts=false

npm start
```

## test in browser
open http://localhost:3000

## run the tests
```
npm test
```


--------------------------------------------------------

# PROD environment - ubuntu server (AWS EC2)

LorCiv runs on the same EC2 instance as LorChess, as a separate process under
its own system user, on its own port, with its own database and `.env`. The two
apps share nothing but the machine and Caddy. The instance, Node, pm2, Caddy
and the backup tooling are set up once, by the LorChess setup notes; this file
only covers what LorCiv adds.

## setup user

```
ssh ubuntu@IP_ADDRESS
sudo adduser --disabled-password --gecos "" lorciv
sudo -u lorciv -i
```

## project code
```
git clone https://github.com/lorand77/lorciv.git
cd ~/lorciv
```

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
PORT=3001
EOF

chmod 600 .env
```

- `SESSION_SECRET` — signs the session cookie. If unset, `src/config.js` falls
  back to a hardcoded dev default that is public in this repo; anyone who then
  obtains a session id (from logs or a DB backup) can turn it into a valid
  cookie. Use a different value per environment and never commit it. Changing it
  invalidates all existing sessions, i.e. logs everyone out.
- `NODE_ENV=production` — makes `npm install` skip devDependencies and puts
  Express in production mode. (Uncaught errors never send a stack trace to
  the client either way: `src/app.js` answers them itself.)
- `PORT=3001` — LorChess has 3000 on this machine. Caddy proxies to it below.

Everything else has a default and is read in `src/config.js`; put it in `.env`
only to change it:

- `DB_PATH` — the SQLite file (default `data/lorciv.sqlite` in the project).
- `DEACTIVATION_SWEEP_MS` — how often sockets of deactivated accounts are
  disconnected (default 30000, i.e. 30 s).
- `LOGIN_MAX_FAILURES`, `REGISTER_MAX`, `AUTH_WINDOW_MS` — failed logins and
  new accounts allowed per client IP within the window (default 10, 5 and
  900000, i.e. 15 min); past that, 429 until the window moves on.
- `HASH_MAX_CONCURRENT` — how many password hashes or checks may run at once
  (default 2, one per vCPU); more get 503 "server busy" instead of waiting.
- `LOG_LEVEL` — `error`, `warn`, `info` or `debug` (default `info`); `debug`
  adds detail for an investigation. See "Logging" in `design.md`.

## run the app
```
npm install
npm rebuild better-sqlite3 argon2 --foreground-scripts --ignore-scripts=false
```

with pm2 (installed globally for the machine already):
```
pm2 start npm --name "lorciv" -- start

# survive reboot (per user; LorChess did the same for its user):
pm2 save
pm2 startup

pm2 list                     # see all running processes and their status
pm2 logs lorciv              # tail live logs
pm2 logs lorciv --lines 100  # show last 100 lines
pm2 restart lorciv           # restart the app (e.g. after deploying new code)
pm2 stop lorciv              # stop without removing from pm2's list
pm2 delete lorciv            # remove from pm2 entirely
pm2 monit                    # live dashboard: CPU, memory, logs
```

### log rotation

pm2 appends the app's stdout and stderr to `~/.pm2/logs/lorciv-out.log` and
`~/.pm2/logs/lorciv-error.log` and never trims them, so without rotation they
grow until the disk is full (and SQLite can no longer write). pm2 runs per
user, so the rotation module is installed once for this user too:
```
pm2 install pm2-logrotate
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'   # rotate daily at midnight
pm2 set pm2-logrotate:max_size 50M                 # and early if a file reaches 50 MB
pm2 set pm2-logrotate:retain 14                    # keep 14 rotated files per log
pm2 set pm2-logrotate:compress true                # gzip the rotated files
```

`retain` counts files, not days: a size-triggered rotation adds a file, so
the 14 kept cover at most 14 days, never more. The privacy policy says logs
live 14 days: keep these settings in step with it.

## https with custom domain (Caddy)

Caddy is already installed and serving LorChess on this machine.

- name.com: manage DNS -> add A record: host `lorciv` -> IP_ADDRESS

Add a second site block to /etc/caddy/Caddyfile:
```
lorchess.lorand77.dev {
    reverse_proxy localhost:3000
}

lorciv.lorand77.dev {
    reverse_proxy localhost:3001
}
```

```
sudo systemctl reload caddy
```

Port 3001 must not be reachable from outside, only through Caddy: the app
trusts `X-Forwarded-For` for its login throttling (see `design.md`).

## deploying new code
```
git pull
npm install        # in case dependencies changed
pm2 restart lorciv
```

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
open tabs are disconnected within 30 s (`DEACTIVATION_SWEEP_MS`). Nothing is
deleted: the username stays taken, and reactivating restores the account.

Deleting a user is not built yet (see `plan.md`, M4); until then, deactivate.

## backing up sqlite database

```
mkdir -p backups

sqlite3 data/lorciv.sqlite "VACUUM INTO 'backups/lorciv-backup-$(date +\%F).sqlite'"
```

and move the backup file somewhere safe (e.g. download to local machine, upload
to cloud storage etc.)

```
pm2 stop lorciv
cp backups/lorciv-backup-DATE.sqlite data/lorciv.sqlite
rm -f data/lorciv.sqlite-wal data/lorciv.sqlite-shm
pm2 start lorciv
```

### backup to B2

rclone is already installed and configured for the LorChess backups; this user
needs its own `rclone config` (the config file is per user). Use a separate
bucket or prefix, e.g. `b2:lorciv-backups/`.

The nightly backup script (`scripts/backup.sh`) and its cron line come with
milestone M4 of `plan.md`.
