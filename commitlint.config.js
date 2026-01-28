module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', ['vault', 'repo', 'ci', 'docs', 'deps', 'release']],
  },
};
