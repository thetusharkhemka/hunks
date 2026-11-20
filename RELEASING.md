# Releasing

`.github/workflows/release.yml` builds a release when a version tag is
pushed and stages it on npm through trusted publishing: no token is
involved, and the release carries a provenance attestation. Nothing
becomes public until a person approves it twice: the run on GitHub, then
the staged package on npm, with two-factor authentication.

## Once, on GitHub

1. Create the repository and push `main` and the tags. Pushing a tag
   starts the release workflow as it was in that commit, and before 1.2.0
   it had no approval step, so disable **Release** in the **Actions** tab
   while you push the older tags, and enable it again afterwards.
2. `package.json` names the repository. npm matches the provenance
   against it, so change it if the repository moves.
3. **Settings → Environments → New environment** named `npm`: add yourself
   as a required reviewer, turn off the bypass for administrators, and
   limit deployments to tags matching `v*`.
4. **Settings → Rules → Rulesets**:
   - for `main`: require a pull request and the CI and CodeQL checks,
     and block force pushes and deletion;
   - for tags `v*`: block updates and deletion, so a release tag cannot
     be moved or removed once it exists.
5. **Settings → Actions → General**: set workflow permissions to read
   only. Require approval for workflows from outside contributors. Allow
   only actions by GitHub, plus `ossf/scorecard-action`.
6. **Settings → Advanced Security**: turn on private vulnerability
   reporting, Dependabot alerts, secret scanning and push protection.

## Once, on npmjs.com

1. Package **Settings → Trusted publishing**: add GitHub Actions with the
   repository owner, `hunks`, workflow `release.yml` and environment
   `npm`. Allow `npm stage publish` only, not `npm publish` or
   `npm dist-tag`. Do this just before pushing a release tag: npm expires
   a connection that no release has used within two days.
2. Then, under **Publishing access**, choose **Require two-factor
   authentication and disallow bypass 2fa tokens**. Trusted publishing
   keeps working, and a leaked token can no longer publish without your
   second factor.
3. On the account, use a security key or passkey for two-factor
   authentication, and delete any access tokens you no longer need.

## Each release

1. Update `version` in `package.json` and add the release to
   `CHANGELOG.md`. Run `npm install --package-lock-only` so the lockfile
   carries the new version too, and merge the change into `main`
   through a pull request.
2. Tag that commit and push the tag:

   ```sh
   git tag -a v1.2.1 -m 'hunks 1.2.1'
   git push origin v1.2.1
   ```

3. Approve the run in the **Actions** tab. The workflow checks that the
   tag matches `package.json`, verifies the dev dependencies' signatures,
   runs the tests, builds, and stages the package on npm.
4. Approve the staged package on npmjs.com, in the **Staged Packages** tab
   of your account, or with `npm stage approve <id>`. Either way, npm asks
   for your second factor.
5. Check the result:

   ```sh
   npm view @thetusharkhemka/hunks@1.2.1 dist.attestations
   node scripts/verify-release.ts
   ```
