# OkazuDB Codex Cloud runbook

## Product boundary

The primary development client is **Codex Web / Codex Cloud**. ChatGPT Work is not required and is not used as a wrapper or software-development execution platform.

- Code source of truth: GitHub `main` in `saitoutomoya0425-bot/db-web-x-ai-mvp-1`
- Normal execution: Codex Cloud environment
- Local fallback: Codex CLI plus the existing Mac repo and local state
- GitHub Actions: optional; not a hop in normal read/edit/test/review work
- Production mutation: disabled by default and outside environment setup

OpenAI's current documentation says a Cloud chat checks out the selected branch or SHA, runs setup, gives the agent a terminal for edits and checks, then returns a summary and diff that can be sent to a pull request. It also documents setup and maintenance scripts, environment variables, setup-only secrets, per-environment internet controls, and container caching for up to 12 hours:

- [Codex cloud](https://learn.chatgpt.com/docs/cloud)
- [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment)
- [Agent internet access](https://learn.chatgpt.com/docs/cloud/internet-access)

## One-time setup in Codex Web

These are the only expected UI-only setup actions.

1. Open Codex Web, connect GitHub, authorize only `saitoutomoya0425-bot/db-web-x-ai-mvp-1`, and create an environment named `OkazuDB` for `main`.
2. Configure the environment fields below and run the Cloud smoke task. Enter secret values in the Codex environment UI only; never paste them into a task or repository file.

Environment configuration:

| Field | Value |
| --- | --- |
| Runtime | Node 22, if the UI offers version pinning |
| Setup script | `node scripts/cloud/setup-codex-cloud.mjs` |
| Maintenance script | `node scripts/cloud/setup-codex-cloud.mjs` |
| Environment variable | `CODEX_CLOUD=true` |
| Environment variable | `OKAZU_CLOUD_RESTORE_STATE=true` |
| Environment variable | `OKAZU_STATE_BUCKET=okazudb-state-private` |
| Environment variable | `NEXT_PUBLIC_SUPABASE_URL` |
| Secret | `SUPABASE_SERVICE_ROLE_KEY` |

`SUPABASE_SERVICE_ROLE_KEY` is used by setup only to restore allowlisted private state. OpenAI documents that Cloud secrets are removed before the agent phase. Do not weaken this by placing the service-role value in a normal environment variable.

The setup is idempotent. It runs `npm ci` only when `package-lock.json` changed or the cached `node_modules` directory is missing. It initializes the state root, verifies Node 22 and required env names, rejects Production-write flags, and restores only files listed in `config/codex-cloud-state-restore.json`.

## Model and reasoning

At the start of the first Cloud task, inspect the actual model and reasoning selectors in the Codex Web UI.

- Preferred when actually available: `GPT-5.6 Sol`
- Preferred reasoning when actually available: `xhigh` / very high
- Do not assume Local CLI labels appear unchanged in Cloud.
- If either option is unavailable, record the options shown and the selected value. Do not silently pin a lower model.

The OpenAI API model guide confirms that the GPT-5.6 family includes Sol, Terra, and Luna and that the API supports `none`, `low`, `medium`, `high`, `xhigh`, and `max`; that does not prove that every Codex Cloud account UI exposes the same list. See [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model).

## Network policy

Use the smallest policy the task needs.

- Setup phase: dependency installation uses the setup network provided by Codex Cloud.
- Normal code/test agent phase: internet **Off** is preferred.
- Read-only deployment verification: enable a custom allowlist only for the exact Vercel and Supabase project domains, with `GET`, `HEAD`, and `OPTIONS` only.
- Do not use `All (unrestricted)` for normal work.
- FANZA and MyFans domains are not required in Phase 7A.

GitHub source/PR integration should use the native Codex GitHub flow. Do not add a broad GitHub token merely to reproduce native branch or PR behavior.

## Daily workflow

1. Open Codex Web.
2. Select `OkazuDB`.
3. Confirm the task starts from current GitHub `main`.
4. Paste the task, including scope, safety gates, and success criteria.
5. Let Codex edit and run targeted tests inside the Cloud environment.
6. Review the Cloud summary and diff.
7. Use the native GitHub branch / PR flow to return the change to GitHub.
8. Merge only after required checks and review pass. Until repository protection and native auto-merge behavior are verified, expect one user merge action rather than weakening protection.
9. Let Vercel's existing GitHub integration deploy `main`; do not trigger a duplicate deployment.
10. For tasks that need durable evidence, verify the allowlisted state files and `cloud-state-index.json` in private Storage.

Normal code tasks do not require opening GitHub Actions. They also do not require Supabase or Vercel secrets unless the task explicitly needs those systems.

## First Cloud smoke

Run this as a Codex Cloud task after the environment is created:

> Open the exact current GitHub main commit. Report `node --version`, the package name/version, and `git status --short`. Run `npm run test:codex-cloud`. Create `/tmp/okazudb-codex-cloud-smoke.json` containing only the commit SHA and test result, report its SHA-256, then delete it. Do not commit. Do not access FANZA or MyFans. Do not write Business DB rows, Vercel env, or Supabase Business data.

Cloud smoke is `PASS` only when this task actually runs in Codex Cloud. A local run is not a substitute.

## Persistent state

Canonical durable state uses the private Supabase Storage bucket `okazudb-state-private`.

- `public=false`
- anonymous read/write policies: none
- service-role access only
- public URL generation: prohibited
- remote canonical index: `cloud-state-index.json`
- maximum selected migration set: less than 50 MiB
- local state deletion: prohibited

The allowlist is `config/codex-cloud-state-restore.json`. The helper accepts exact files only and rejects traversal, secret-looking paths, cache directories, browser profiles, images, media, PDFs, and raw HTML.

Local one-time sync:

```bash
node --env-file=.env.local scripts/cloud/sync-codex-cloud-state.mjs
```

Single-file operations:

```bash
npm run state:codex-cloud -- preflight
npm run state:codex-cloud -- restore --logical-path myfans-research/phase6c-browser-transport-20260901/transport-self-test.json
```

Do not run a recursive HOME sync. Do not put state into this public GitHub repository. Actions artifacts are short-lived output only, never the sole canonical manifest or checkpoint.

Because Codex Cloud secrets are setup-only, the service-role key is intentionally unavailable to the agent phase. Setup can restore durable state safely. A Cloud task that produces new durable state must use a separately reviewed, exact-file persistence operation; never expose the service role as a normal environment variable. This restriction does not affect normal code edits, which return through GitHub.

## Production approval flow

Production work is separate from normal development. Require all of the following before any Production write:

1. dry-run output;
2. exact manifest hash and expected count;
3. approval provenance such as `owner_delegated_via_chatgpt` when that is the truthful provenance;
4. target-scoped preflight and verification;
5. checkpoint before mutation;
6. no arbitrary SQL, no free-form shell, no blind retry;
7. transaction and old-value condition for DB updates;
8. rollback on any count or value mismatch.

Cloud setup never performs Production work. Phase 7A does not enable Business writes.

## FANZA and MyFans safety

- No ingest, promotion, publish, thumbnail review, or catalog request occurs during Cloud setup.
- Keep certificate bypass, anti-bot bypass, and private API access at zero.
- The next MyFans phase must evaluate the Cloud network/browser capability from a clean policy baseline; it must not inherit Mac Chrome workarounds.
- Preserve existing STOP evidence and approval contracts.

## Local CLI fallback

If Codex Cloud is unavailable:

1. Use the existing Mac repo and Codex CLI.
2. Verify GitHub `main` before starting.
3. Keep `$HOME/Documents/Codex/okazudb-state` as the local fallback root, or set an absolute `OKAZU_STATE_ROOT`.
4. Follow the same targeted-test, secret, state, Git, and Production gates.
5. Return code to GitHub; do not make Mac-only code the new canonical source.

## Capability audit

`YES (official)` means the current OpenAI documentation establishes the feature. `UNKNOWN` means this migration session could not verify the account-specific UI or execute a real Cloud task.

| Capability | Status | Evidence / limit |
| --- | --- | --- |
| GitHub repo connection | YES (connector), Cloud environment link UNKNOWN | This session's GitHub connector can read the target repo with push/admin permission; Codex Cloud UI authorization was not available to inspect. |
| Environment creation | YES (official), actual UNKNOWN | UI-only action remains. |
| Setup / maintenance scripts | YES (official) | Repo-side script is ready. |
| Environment variables | YES (official) | Available through setup and agent phases. |
| Secrets | YES (official) | Decrypted for setup only; removed before agent phase. |
| Agent internet policy | YES (official) | Off or allowlisted domains; HTTP methods can be limited. |
| Shell execution and targeted tests | YES (official) | Agent runs terminal commands. |
| Branch / commit publication | UNKNOWN at account level | Native result/diff and PR flow are official; exact account behavior was not executed. |
| PR creation | YES (official), actual UNKNOWN | Cloud result can open a PR; no Cloud task was run. |
| Cloud task background continuation | YES (official) | Tasks can continue in dedicated Cloud environments. |
| Container persistence | CACHE ONLY | Cache may last up to 12 hours; it is not canonical durable state. |
| Artifact/output behavior | Summary and diff YES; durable arbitrary artifact UNKNOWN | Use private Storage for canonical state. |
| Model selector | UNKNOWN | Account UI not inspected. |
| Reasoning selector | UNKNOWN | Account UI not inspected. |

Current GitHub repository settings expose merge commit, squash, and rebase and have auto-merge disabled. Branch protection details were not changed. Enabling safe auto-merge is a later option only after required checks and protection are verified; do not remove reviews or weaken protection to reduce one click.
