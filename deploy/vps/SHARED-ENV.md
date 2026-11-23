# Shared variables: cutover runbook

Run this once, after the release that carries the shared-variable commands (#1284 S1 to S4) is live on the host. It moves the coworkers' GitHub and EverOS access from the key files into the engine, checks the result, and removes the key files only after the checks pass.

Every command runs from the repository folder on the host, one at a time, as:

    docker compose exec -T engine node dist/cli/bin.js <command>

Never run two `shared-env set` commands at once. Values are never printed and never written into this file or into a run record.

## Step 1, check

    docker compose exec -T engine node dist/cli/bin.js shared-env list

Expected output: `No shared variables.`. Anything else stops the runbook: find out what is already set before going on.

## Step 2, move the values

The values are read from the old key files and passed on stdin, so they never appear on the command line or on screen.

    docker compose exec -T engine sh -c 'node dist/cli/bin.js shared-env set GH_TOKEN < /data/tools/github/token'
    docker compose exec -T engine sh -c 'node dist/cli/bin.js shared-env set EVEROS_TOKEN < /data/tools/everos/token'
    docker compose exec -T engine sh -c 'sed -n "s/^export EVEROS_URL=\([^ ]*\).*/\1/p" /data/tools/bin/everos-mcp | node dist/cli/bin.js shared-env set EVEROS_URL'

Then set the plain values, one at a time. Each is passed with `printf` on stdin:

    printf '%s' 'default' | docker compose exec -T engine node dist/cli/bin.js shared-env set EVEROS_USER_ID
    printf '%s' 'rerun' | docker compose exec -T engine node dist/cli/bin.js shared-env set EVEROS_APP
    printf '%s' 'special-place-administrator' | docker compose exec -T engine node dist/cli/bin.js shared-env set GIT_AUTHOR_NAME
    printf '%s' 'special-place-administrator' | docker compose exec -T engine node dist/cli/bin.js shared-env set GIT_COMMITTER_NAME
    printf '%s' '<the email of the special-place-administrator GitHub account>' | docker compose exec -T engine node dist/cli/bin.js shared-env set GIT_AUTHOR_EMAIL
    printf '%s' '<the same email>' | docker compose exec -T engine node dist/cli/bin.js shared-env set GIT_COMMITTER_EMAIL
    printf '%s' '1' | docker compose exec -T engine node dist/cli/bin.js shared-env set GH_PROMPT_DISABLED
    printf '%s' '1' | docker compose exec -T engine node dist/cli/bin.js shared-env set GH_NO_UPDATE_NOTIFIER

The email is typed by the operator from that GitHub account's settings. It is not written in this repository.

After each `set`, run `shared-env list` and confirm the name is there. If a name is missing or a `set` printed an error, do not continue: the engine may have been killed mid-write or the disk may be full. Remove the partial name with `shared-env remove <NAME>` and set it again.

## Step 3, switch the coworkers' EverOS server

First count the coworkers that hold the old launcher:

    docker compose exec -T engine sh -c 'grep -l /data/tools/bin/everos-mcp /data/agents/*/config.json | wc -l'

Then replace the definition on every coworker that has it, with the definition in this repository:

    docker compose exec -T engine node dist/cli/bin.js mcp set-all everos < deploy/vps/everos-mcp.json

The number the command reports must equal the count from the first command. If it differs, stop: a coworker was added or removed in between, and the count must be checked again. Roll back by running `mcp set-all everos` again with the old definition `{"name":"everos","command":"/data/tools/bin/everos-mcp"}`.

## Step 4, move the old wrappers aside

    mkdir /data/tools/bin.pre-1284
    mv /data/tools/bin/gh /data/tools/bin/git /data/tools/bin/git-credential-ghtoken /data/tools/bin/everos-mcp /data/tools/bin.pre-1284/
    ln -s /data/tools/gh/bin/gh /data/tools/bin/gh
    ln -s /usr/bin/git /data/tools/bin/git

The two links keep the paths that `factory.py` and the briefs call. Rollback: remove the two links and move the four wrappers back from `bin.pre-1284`.

## Step 5, restart the engine

    docker compose restart engine

A coworker that is already running keeps the entry it started with. The restart is what makes every coworker take the new definition and the shared variables.

## Step 6, checks

Every check must pass before Step 7. Any failure stops the runbook and goes to the rollback of the step that was run last.

1. The GitHub token works through the engine, and it is the account of the operator:

        docker compose exec -T engine node dist/cli/bin.js shared-env run /data/tools/bin/gh api user --jq .login

   Expected output: `special-place-administrator`.

2. A private repository can be read with the shared token:

        docker compose exec -T engine node dist/cli/bin.js shared-env run /data/tools/bin/git ls-remote https://github.com/special-place-ai-heaven/testpilot HEAD

   Expected output: a commit sha on one line.

3. The EverOS server is up for a coworker. Use the id of any coworker that holds the definition:

        docker compose exec -T engine node dist/cli/bin.js mcp status <coworker id>

   Expected: `ok` for `everos`.

4. One coworker runs the GitHub check in its own shell. Shared `GH_TOKEN` is no longer in the coworker shell: put `GH_TOKEN` in that coworker's own `.env` (or UI key), and confirm the coworker with `rerun agent everos-allow <id>` if it is not already allowlisted. Then:

        /data/tools/bin/gh api user --jq .login

   Expected output: `special-place-administrator`.

5. One coworker's `memory_search` answers. Ask it a plain question in its own session and read the reply.

## Step 7, remove the key files

Only when every check of Step 6 passed. This is the only place the runbook removes those paths:

    rm -rf /data/tools/github /data/tools/everos /data/tools/git /data/tools/gh/config /data/tools/bin.pre-1284

Until this step runs, the old wrappers stay in `bin.pre-1284`, so every earlier step can still be undone.

## Rollback to an older engine

If the engine is rolled back to a release that reads the key files, the files are gone and must be rebuilt from the shared values first:

    docker compose exec -T engine node dist/cli/bin.js shared-env run sh -c 'umask 077; mkdir -p /data/tools/github; printf %s "$GH_TOKEN" > /data/tools/github/token'
    docker compose exec -T engine node dist/cli/bin.js shared-env run sh -c 'umask 077; mkdir -p /data/tools/everos; printf %s "$EVEROS_TOKEN" > /data/tools/everos/token'

The release PR that carries this runbook copies this section into its Deploy notes.

## EverOS token from the UI

The engine release that carries data-dir step 6 (`everos-direct`) rewrites, on its first boot, every coworker and Boss whose `everos` server still runs `/data/tools/bin/everos-mcp` to the direct definition in `deploy/vps/everos-mcp.json`. A second boot changes nothing. After that, the `everos` server takes `EVEROS_TOKEN` from the coworker's own key (UI, agent `.env`) when it has one, and from the shared `EVEROS_TOKEN` when it has none and the coworker is on the engine allowlist (created from the hub or `rerun agent create`, or confirmed with `rerun agent everos-allow <id>` / `POST /agents/:id/everos-shared`). When it falls back, `EVEROS_URL`, `EVEROS_USER_ID` and `EVEROS_APP` also come from the shared env only, and the server gets only its fixed env keys. The fallback applies only to a stdio server with exactly the definition in `deploy/vps/everos-mcp.json`. Imported, duplicated-from-imported, and unconfirmed pre-version coworkers are not on the allowlist: they need their own key, or an operator confirm. A missing or unreadable allowlist fails closed as `config_error` with `EVEROS_TOKEN`. An empty or blank token counts as not set. Every other MCP server ignores the shared `EVEROS_TOKEN`, and no file on the host sets it. The shared `EVEROS_TOKEN` stays set, because the `everos` server falls back to it for allowlisted coworkers and the rollback above rebuilds `/data/tools/everos/token` from it.

Data-dir step 7 (`everos-shared-allowlist`) creates the allowlist table with no rows. Existing coworkers need a one-time confirm after deploy: `rerun agent everos-pending` lists them, `rerun agent everos-allow <id>` grants both the shared EverOS fallback and shell. Until then they show `config_error, missing EVEROS_TOKEN` and `shell needs operator confirm`. Shared secrets (`GH_TOKEN`, `EVEROS_TOKEN`, and any other secret) are not copied into the coworker shell env; a shell script that needs one must use that coworker's own `.env`. Non-secret shared keys such as `EVEROS_URL`, `EVEROS_USER_ID`, `EVEROS_APP`, `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL`, `GH_PROMPT_DISABLED` and `GH_NO_UPDATE_NOTIFIER` still reach the shell. `shared-env run` is unchanged and still injects every shared variable for the operator.

Before deploying that release, check that the shared values the direct definition needs are set, because a missing one now shows the server as `config_error` with the missing name:

    docker compose exec -T engine node dist/cli/bin.js shared-env list

Expected: `EVEROS_URL`, `EVEROS_USER_ID` and `EVEROS_APP` are listed. If one is missing, set it as in Step 2.

A coworker or Boss that should use a different EverOS token gets its own `EVEROS_TOKEN` key in the UI. Its own key wins over the shared one.

After the deploy, the old wrapper must not stay where a hand-made definition could still call it. If Step 4 has not run yet, move it aside now:

    mkdir -p /data/tools/bin.pre-1284
    mv /data/tools/bin/everos-mcp /data/tools/bin.pre-1284/

Then restart the engine and run check 3 of Step 6 for one allowlisted coworker. A coworker without a key of its own shows `ok everos stdio 4 tools` while the shared `EVEROS_TOKEN` is set, and `config_error` with `EVEROS_TOKEN` as the missing name when neither is set, or when the coworker is not on the allowlist. Its prompt lists the server the same way: `config_error, missing EVEROS_TOKEN` instead of `local command`.

## Rotation

Set the name again with `shared-env set <NAME>`, value on stdin. New processes read it straight away; no restart is needed.

- When GitHub rejects or revokes the token, `gh` and `git` print `401` or `Authentication failed` in the coworker's run. For an operator `shared-env run`, the repair is `printf '%s' '<new token>' | ... shared-env set GH_TOKEN`. For a coworker shell, also set `GH_TOKEN` on that coworker's own `.env`.
- When a value landed in a run record, redact the record with `rerun redact <agentId>`, value on stdin, then set a new token with `shared-env set`.

## How Rob runs gh by hand

    docker compose exec -T engine node dist/cli/bin.js shared-env run /data/tools/bin/gh <arguments>

The runbook prints no value and quotes no token.
