# Running PriceCompare on a home server

How the app runs as a Docker stack on another machine, how it gets there, and how to operate it.
The short form is in the README ("Run it on another machine with Docker").

## How it fits together

```
  this PC (Windows)                                   home server (Linux, Docker)
  ─────────────────                                   ───────────────────────────
  working tree ──tools/deploy.ps1──► tar over SSH ──► ~/projects/pricecompare/app/
  .env (keys) ──── -CopyEnv only ────────────────────►   .env            (kept between deploys)
                                                         compose.yaml ─► stack "pricecompare"
                                                                           app container (Node 26)
  browser ── http://localhost:8787                                         listens on 0.0.0.0:8787
     │                                                                      │
     └── SSH tunnel (tools/stack.ps1 tunnel) ──► server's 127.0.0.1:8787 ◄──┘ published here only
                                                         volume pricecompare_data: the SQLite database
```

- **Nothing is published to the network.** The port is bound to the server's 127.0.0.1, so the
  page is reached only through an SSH tunnel, like the other stacks on the server.
- **The stack stands alone:** its own project name, network and volume; it shares nothing with
  other stacks on the server.
- **Secrets stay out of the image and the repository.** The keys are in `.env` next to
  `compose.yaml` on the server (mode 600), read by Compose at start. The server's address is in
  `.env.deploy` on this PC, which git ignores.
- **Data survives redeploys:** the database (cache, local database of searches, credit ledger) is
  in the volume `pricecompare_data`, not in the code folder.

## Files

| File | What it does |
|---|---|
| `Dockerfile` | Stage `test`: all dependencies, type check and unit tests (a failure stops the build). Stage `app`: runtime dependencies, `src`, `public`, `data`, user `node`, `HOST=0.0.0.0`, database at `/data`. |
| `compose.yaml` | Project `pricecompare`, service `app`, port `127.0.0.1:8787`, `.env` optional, volume `data`, restart unless stopped. |
| `.dockerignore` | Keeps `.env*`, `.cache`, databases, `node_modules` and `.git` out of every image. |
| `tools/deploy.ps1` | Packs the files git knows (uncommitted changes included, ignored files never), copies and unpacks them on the server, keeps `.env` there, optionally copies `.env` (`-CopyEnv`), runs the test stage (`-Test`), then `docker compose up -d --build`. |
| `tools/stack.ps1` | Day-to-day: `status`, `logs`, `restart`, `stop`, `start`, `backup`, `tunnel`, `run -Script file.sh`. |
| `.env.deploy` (git-ignored) | `PRICECOMPARE_DEPLOY=user@host`. |

## Everyday use

```powershell
powershell -File tools/deploy.ps1 -Test          # deploy what is in the working tree, tests first
powershell -File tools/stack.ps1 tunnel          # then http://localhost:8787 (Ctrl+C closes it)
powershell -File tools/stack.ps1 status
powershell -File tools/stack.ps1 logs -Lines 50
powershell -File tools/stack.ps1 backup          # ~/pricecompare-backups/pricecompare-YYYYMMDD-HHMM.sqlite on the server
```

- **New or changed keys:** `deploy.ps1 -CopyEnv` (the file is copied as it is; its content is never shown).
- **Going back to an earlier version:** check out that commit here, then `deploy.ps1 -Test`; the
  data stays.
- **A local preview server on port 8787** blocks the tunnel; stop it first.

## Things learned while setting it up

- **SSH from Windows' own OpenSSH.** The scripts call `ssh`/`scp` from PowerShell; Git Bash's
  `ssh` uses another key store and may get "Permission denied (publickey)".
- **Remote commands go as a script on stdin** (`... | ssh host "tr -d '\r' | bash -s"`), because
  PowerShell 5 mangles quotes in inline commands. The scripts strip carriage returns and a byte
  order mark first.
- **`docker compose exec` reads stdin.** In a script piped to `bash -s` it swallows the rest of
  the script; give it `</dev/null`.
- **Restoring a backup:** stop the app, copy the file into the volume as root with a one-off
  container (`docker run --rm --user root -v pricecompare_data:/data -v <file>:/import.sqlite:ro
  pricecompare:latest sh -c 'cp /import.sqlite /data/price-compare.sqlite && rm -f
  /data/price-compare.sqlite-wal /data/price-compare.sqlite-shm && chown node:node
  /data/price-compare.sqlite'`), start the app. This is how this PC's database was carried over on
  2026-11-28.
