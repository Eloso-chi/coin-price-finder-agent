// src/services/MetalsSpotPriceError.js — Typed error for metals spot price failures
// CommonJS

class MetalsSpotPriceError extends Error {
  /**
   * @param {string} message
   * @param {object} details
   * @param {string[]} details.providersTried
   * @param {number|null} details.lastStatus
   * @param {string|null} details.lastErrorMessage
   * @param {string} details.metal
   * @param {string} details.currency
   */
  constructor(message, { providersTried, lastStatus, lastErrorMessage, metal, currency } = {}) {
    super(message);
    this.name = 'MetalsSpotPriceError';
    this.providersTried = providersTried || [];
    this.lastStatus = lastStatus || null;
    this.lastErrorMessage = lastErrorMessage || null;
    this.metal = metal || null;
    this.currency = currency || null;
  }
}

module.exports = { MetalsSpotPriceError };
