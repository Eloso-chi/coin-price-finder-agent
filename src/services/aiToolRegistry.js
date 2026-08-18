'use strict';

const pcgsService = require('./pcgsService');
const { priceCoin } = require('./pricingService');
const {
  validateIdentifyInput,
  validatePriceInput,
  validatePurchaseInput,
} = require('../schemas/aiToolSchemas');

const TOOL_NAMES = Object.freeze(['identify_coin', 'price_coin', 'evaluate_purchase']);

function createToolRegistry({ identify = pcgsService.parseDescription, price = priceCoin } = {}) {
  const tools = {
    identify_coin: {
      validate: validateIdentifyInput,
      timeoutMs: 5000,
      execute: async (input) => ({
        query: input.query,
        parsed: identify(input.query),
        provenance: { source: 'deterministic-coin-intent', observed: true },
      }),
    },
    price_coin: {
      validate: validatePriceInput,
      timeoutMs: 45000,
      execute: async (input, trustedContext) => ({
        result: await price(input, trustedContext),
        provenance: { source: 'deterministic-pricing-service', observed: true },
      }),
    },
    evaluate_purchase: {
      validate: validatePurchaseInput,
      timeoutMs: 45000,
      execute: async (input, trustedContext) => ({
        result: await price(input, trustedContext),
        provenance: { source: 'deterministic-purchase-evaluation', observed: true },
      }),
    },
  };

  return Object.freeze({
    names: TOOL_NAMES,
    get(name) {
      if (!Object.prototype.hasOwnProperty.call(tools, name)) {
        throw new Error(`Tool is not allowlisted: ${name}`);
      }
      return tools[name];
    },
    async execute(name, input, trustedContext) {
      const tool = this.get(name);
      const validated = tool.validate(input);
      return tool.execute(validated, trustedContext);
    },
  });
}

module.exports = { TOOL_NAMES, createToolRegistry };