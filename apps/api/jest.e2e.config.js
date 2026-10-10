/** End-to-end tests: need `docker compose up -d`, migrations applied, and PAYMENT_GATEWAY=mock. */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.e2e.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 60000,
  forceExit: true,
};
