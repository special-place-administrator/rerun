# VPS deploy runbook

This is the production update for the checkout at `/docker/rerun-src`. The Compose project name is `rerun`. App and engine images come from GHCR; `factory-dispatcher` is added by the VPS overlay. Do not put secrets or token values in a release note or in this file.

## Prerequisites

- A shell on the VPS, in `/docker/rerun-src`.
- `.env` sets `COMPOSE_FILE=docker-compose.yml:deploy/vps/docker-compose.vps.yml` (this is what `deploy/vps/make-env.sh` writes).
- The Supabase stack is up. Migrations read the database password from `$SUPABASE_DIR/.env`, which defaults to `/docker/supabase-rerun`.
- The Images workflow has already pushed the tag you intend to run (see below).
- Call out any new environment variables or Compose changes in the release note before you run the update.

## Standard deploy

Replace `sha-<7>` with the image tag (seven hex characters, with the `sha-` prefix):

```
cd /docker/rerun-src && sudo env NO_DRAIN=1 RERUN_IMAGE_TAG=sha-<7> sh deploy/vps/update.sh && sudo docker compose restart factory-dispatcher
```

`NO_DRAIN=1` skips setting a drain mark and skips waiting for running factory work to finish. Every production deploy uses it.

The dispatcher bind-mounts `tools/factory` from this checkout and runs `launch.py`. `docker compose up -d` does not restart that service when its Compose config is unchanged, so the one-line deploy always ends with `docker compose restart factory-dispatcher`. On start, `launch.py` turns on its start-check and either continues a recorded good or trial commit, or runs the bind-mounted checkout.

## What `update.sh` does

The script always `cd`s to the repository root (the folder that contains `deploy/vps/update.sh`). It then:

1. Fast-forwards the checkout with `git pull --ff-only`, as the repo owner, then re-executes itself so the newly pulled script is what runs.
2. Checks that `docker compose config` resolves.
3. If the engine is running and has the `rerun snapshot` command, snapshots the coworker databases.
4. Pulls images. Compose uses `${RERUN_IMAGE_TAG:-dev}` for `app` and `engine` (`ghcr.io/special-place-ai-heaven/moldwright` and `moldwright-engine`).
5. Unless `NO_DRAIN=1`, waits for the factory drain to reach zero running work (or gives up after a timeout).
6. Applies pending Supabase migrations with `supabase db push --include-all --yes` (CLI 2.113.0, against the live database). This step does not roll migrations back.
7. Runs `docker compose up -d`. If an old `rerun-factory` project container is still present, it is stopped and removed first so the dispatcher can move into this project. Then it prints `docker compose ps`, prunes dangling images, and installs `deploy/vps/keeper.sh` (a keeper install failure is reported but does not fail the update).
8. Runs `deploy/vps/doctor.sh`. A doctor failure is reported (`The checks above found a problem. The deploy itself is done.`) and does not fail the update.

## How to pick the image tag

On each push to `dev`, the Images workflow tags `ghcr.io/special-place-ai-heaven/moldwright` and `moldwright-engine` with `sha-<7>` (short SHA) and with `:dev`. `:dev` moves on every Images run, so deploy with the `sha-<7>` tag.

Images is skipped when the push touches only `docs/**`, `tools/factory/**`, and/or `deploy/vps/**`. For those commits, use the last tag Images actually built. Confirm CI is green on the commit you are deploying; Factory tools still runs when `tools/factory` or `deploy/vps` change.

## After the deploy

```
cd /docker/rerun-src && sudo sh deploy/vps/doctor.sh
cd /docker/rerun-src && sudo docker compose ps --format '{{.Service}} {{.Image}} {{.Status}}'
cd /docker/rerun-src && sudo docker compose logs --since 5m factory-dispatcher 2>/dev/null | grep ' beat ' | tail -5
```

Doctor may wait up to three minutes. It is a pass when it prints `doctor: all checks pass`. It checks:

- HTTPS on the app and engine hosts from `.env` (`RERUN_APP_HOST`, `RERUN_ENGINE_HOST`); 2xx, 3xx, 401, and 403 count as a pass.
- That `.env` and `deploy/vps/.env` do not still point at `RERUN_OLD_APP_HOST`.
- A factory-dispatcher `beat` in the last five minutes, with no HTTP 3xx/4xx/5xx and no `could not start` / `cannot read` line.
- If the `factory-token` service is in Compose, that the token file was renewed within the last hour.

Also confirm `app` and `engine` are on the new `sha-<7>` tag and that `factory-dispatcher` is up and healthy. When work is queued, the factory should show at least one job in the Running state.

## Rollback

```
cd /docker/rerun-src && sudo env NO_DRAIN=1 RERUN_IMAGE_TAG=sha-<previous> sh deploy/vps/update.sh && sudo docker compose restart factory-dispatcher
```

Image rollback does not undo migrations. `update.sh` always fast-forwards the git checkout, so the dispatcher stays on the newer `tools/factory` (and on any commit it has already recorded as good or trial) unless you reset that separately before restarting it.
