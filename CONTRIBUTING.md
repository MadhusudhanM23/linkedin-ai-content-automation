# Contributing

Thanks for taking an interest in this project. Bug reports, fixes and
documentation improvements are all welcome.

Maintainer: **Madhusudhan M** — [madhusudhan2315@gmail.com](mailto:madhusudhan2315@gmail.com)
· [github.com/MadhusudhanM23](https://github.com/MadhusudhanM23)

---

## Before you start

Please open an issue before writing a large change, so we can agree on the
approach first. Small fixes can go straight to a pull request.

---

## Setting up

```bash
git clone https://github.com/MadhusudhanM23/linkedin-ai-content-automation.git
cd linkedin-ai-content-automation

npm install
cd local-image && npm install && cd ..

cp .env.example .env     # fill in your own values
npm test                 # expect: 76 passed, 0 failed
```

The acceptance tests need no network, no Google account and no LinkedIn app, so
you can work on `lib/` without any credentials at all.

---

## Never commit secrets

This is the one rule with no exceptions.

- `.env` is git-ignored. Keep it that way, and never paste its contents into an
  issue, pull request or screenshot.
- `apps-script/Code.gs` ships a placeholder `TOKEN`. Set your real one locally
  and do not commit it back.
- Do not add your Google Sheet ID, LinkedIn person URN, `/exec` URL, or any API
  key to tracked files. Use a placeholder such as `<YOUR_SHEET_ID>`.
- Google scans public repositories for leaked `AIza...` keys and revokes them
  within minutes. A leaked LinkedIn token lets anyone post as you.

Before pushing:

```bash
git diff --cached        # read every line you are about to commit
```

If you do leak something, rotate the credential immediately — removing the
commit is not enough.

---

## Code conventions

The codebase follows a few deliberate rules. Please keep to them.

- **`lib/` stays pure.** No network, no filesystem, no clock reads. Time and
  timezone come in as arguments. This is what keeps the test suite offline.
- **I/O lives in `scripts/`.** `scripts/run-once.js` is the only orchestrator.
- **The validator rejects, it does not repair.** If a generated post fails a
  check, the correct behaviour is to refuse to publish, not to patch the text.
- **Never weaken the duplicate guards.** Column G (the LinkedIn Post ID) is the
  backstop against posting twice. Any change touching claim tokens, idempotency
  keys or the publish path needs a test.
- **No new runtime dependencies** in `lib/` or `scripts/` without a good reason.
- Plain CommonJS, 2-space indent, no build step. Match the surrounding style.

---

## Tests

```bash
npm test
```

Add a case to `tests/acceptance.test.js` for any behaviour change. A pull
request that changes scheduling, validation or duplicate prevention without a
test will be asked for one.

Run `npm run doctor` if you have credentials configured and want to check a
change end to end. Keep `AUTO_PUBLISH=false` while developing.

---

## Pull requests

1. Branch from `main`.
2. Keep the change focused — one concern per pull request.
3. Make sure `npm test` passes.
4. Write a commit message that says what changed and why.
5. In the description, note anything a user has to do after upgrading, such as
   a new `.env` key or an Apps Script redeploy.

---

## Reporting a bug

Open an issue with:

- what you expected and what happened instead
- the relevant lines from `run.log` — **with tokens, keys and URLs removed**
- your Node version (`node -v`) and OS
- whether it reproduces with `npm run run` (the dry run)

## Reporting a security issue

Please do not open a public issue. Email
[madhusudhan2315@gmail.com](mailto:madhusudhan2315@gmail.com) directly.
