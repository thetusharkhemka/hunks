# Releasing

Releases are published by `.github/workflows/release.yml` when a version
tag is pushed. npm trusted publishing lets that workflow publish without
any token, and every release gets a provenance attestation. A person
approves each release.

## Once, on GitHub

1. Create the repository and push `main` and the tags.
2. Add the repository to `package.json`, so that npm can match the
   provenance to it:

   ```json
   "repository": { "type": "git", "url": "git+https://github.com/OWNER/hunks.git" },
   "bugs": "https://github.com/OWNER/hunks/issues",
   "homepage": "https://github.com/OWNER/hunks#readme",
   ```

3. **Settings → Environments → New environment** named `npm`: add yourself
   as a required reviewer, and limit deployments to tags matching `v*`.
4. **Settings → Rules → Rulesets**:
   - for `main`: require a pull request and the CI checks, and block
     force pushes and deletion;
   - for tags `v*`: restrict creation, updates and deletion to
     maintainers, so a release tag cannot be moved once it exists.
5. **Settings → Actions → General**: set workflow permissions to read
   only. Require approval for workflows from outside contributors. Allow
   only actions by GitHub, plus `ossf/scorecard-action`.
6. **Settings → Advanced Security**: turn on private vulnerability
   reporting, Dependabot alerts, secret scanning and push protection.

## Once, on npmjs.com

1. Package **Settings → Trusted publishing**: add GitHub Actions with the
   repository owner, `hunks`, workflow `release.yml` and environment `npm`.
2. Then, under **Publishing access**, choose **Require two-factor
   authentication and disallow tokens**. Trusted publishing keeps working.
   A token that leaks can then no longer publish.
3. On the account, use a security key or passkey for two-factor
   authentication, and delete any access tokens you no longer need.

## Each release

1. Update `version` in `package.json` and add the release to
   `CHANGELOG.md`. Run `npm install --package-lock-only` so the lockfile
   carries the new version too, and commit.
2. Tag the commit and push the tag:

   ```sh
   git tag v1.2.0
   git push origin v1.2.0
   ```

3. Approve the run in the **Actions** tab. The workflow checks that the
   tag matches `package.json`, verifies the dev dependencies' signatures,
   runs the tests, builds and publishes.
4. Check the result:

   ```sh
   npm view @thetusharkhemka/hunks@1.2.0 dist.attestations
   node scripts/verify-release.ts
   ```
