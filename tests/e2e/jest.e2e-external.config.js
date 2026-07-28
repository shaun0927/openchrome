const base = require('./jest.e2e.config');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/tests/e2e/scenarios/ecommerce-checkout.e2e.ts'],
};
