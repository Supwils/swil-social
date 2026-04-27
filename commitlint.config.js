/**
 * Conventional Commits — enforced via commit-msg git hook.
 *
 * Format: <type>(<scope>)?: <subject>
 * Examples:
 *   feat(client): add post echo composer
 *   fix(server): correct cursor encoding for empty page
 *   chore(deps): bump axios to 1.7.7
 *   docs: update README install steps
 *
 * Allowed types match @commitlint/config-conventional plus a few project
 * conventions actually used in this repo's history (perf, test, build, ci).
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Body lines may be long (commit messages with context can run over 100)
    'body-max-line-length': [0, 'always'],
    'footer-max-line-length': [0, 'always'],
    // Cap subject length to keep PR titles readable in GitHub UI
    'subject-max-length': [2, 'always', 100],
    'header-max-length': [2, 'always', 120],
    // Allow these scopes (loose — empty is fine, common ones documented)
    'scope-enum': [
      0, // disabled — keep flexibility, just document common scopes
    ],
    'type-enum': [
      2,
      'always',
      [
        'feat',     // new feature
        'fix',      // bug fix
        'docs',     // documentation only
        'style',    // formatting, missing semicolons, etc — no code change
        'refactor', // code change that neither fixes a bug nor adds a feature
        'perf',     // performance improvement
        'test',     // adding tests
        'build',    // build system, deps, tooling
        'ci',       // CI config / scripts
        'chore',    // other maintenance (rarely use; prefer specific types)
        'revert',   // revert a previous commit
      ],
    ],
  },
};
