/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '(src|test)/.*\.spec\.ts$',
  transform: { '^.+\.ts$': ['ts-jest', { diagnostics: false }] },
  testEnvironment: 'node',
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
};
