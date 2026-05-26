/**
 * alertService.test.js — Tests for email alert service (#194)
 */

'use strict';

const mockBeginSend = jest.fn();
const mockPollUntilDone = jest.fn();

jest.mock('@azure/communication-email', () => ({
  EmailClient: jest.fn().mockImplementation(() => ({
    beginSend: mockBeginSend,
  })),
}));

function loadFreshAlertService(env = {}) {
  jest.resetModules();
  process.env.COMMUNICATION_CONNECTION_STRING = env.COMMUNICATION_CONNECTION_STRING || '';
  process.env.ALERT_EMAIL_TO = env.ALERT_EMAIL_TO || '';
  process.env.ALERT_FROM_EMAIL = env.ALERT_FROM_EMAIL || '';
  return require('../src/services/alertService');
}

beforeEach(() => {
  mockBeginSend.mockReset();
  mockPollUntilDone.mockReset();
});

afterAll(() => {
  delete process.env.COMMUNICATION_CONNECTION_STRING;
  delete process.env.ALERT_EMAIL_TO;
  delete process.env.ALERT_FROM_EMAIL;
});

describe('alertService', () => {

  describe('sendAlert — not configured', () => {
    test('returns not-configured when env vars missing', async () => {
      const alertService = loadFreshAlertService();
      const result = await alertService.sendAlert('test-topic', 'Test Subject', 'Test body');
      expect(result.sent).toBe(false);
      expect(result.reason).toBe('not-configured');
      expect(mockBeginSend).not.toHaveBeenCalled();
    });
  });

  describe('sendAlert — configured', () => {
    test('sends email via Azure Communication Services when configured', async () => {
      mockBeginSend.mockResolvedValue({ pollUntilDone: mockPollUntilDone });
      mockPollUntilDone.mockResolvedValue({ status: 'Succeeded' });

      const alertService = loadFreshAlertService({
        COMMUNICATION_CONNECTION_STRING: 'endpoint=https://example.communication.azure.com/;accesskey=test',
        ALERT_EMAIL_TO: 'to@example.com',
        ALERT_FROM_EMAIL: 'alerts@example.azurecomm.net',
      });

      const result = await alertService.sendAlert('test-topic', 'Test', 'Body');
      expect(result).toEqual({ sent: true });
      expect(mockBeginSend).toHaveBeenCalledTimes(1);
      expect(mockPollUntilDone).toHaveBeenCalledTimes(1);
    });

    test('returns failed result when ACS polling does not succeed', async () => {
      mockBeginSend.mockResolvedValue({ pollUntilDone: mockPollUntilDone });
      mockPollUntilDone.mockResolvedValue({ status: 'Failed' });

      const alertService = loadFreshAlertService({
        COMMUNICATION_CONNECTION_STRING: 'endpoint=https://example.communication.azure.com/;accesskey=test',
        ALERT_EMAIL_TO: 'to@example.com',
        ALERT_FROM_EMAIL: 'alerts@example.azurecomm.net',
      });

      const result = await alertService.sendAlert('test-topic', 'Test', 'Body');
      expect(result.sent).toBe(false);
      expect(result.reason).toBe('email-send-failed');
    });
  });

  describe('rate limiting', () => {
    test('isRateLimited returns false initially', () => {
      const alertService = loadFreshAlertService();
      expect(alertService._isRateLimited('new-topic')).toBe(false);
    });

    test('isRateLimited returns true after sendAlert for same topic', async () => {
      const alertService = loadFreshAlertService();
      await alertService.sendAlert('rate-test', 'Subject', 'Body');
      expect(alertService._isRateLimited('rate-test')).toBe(false);
    });
  });

  describe('convenience helpers', () => {
    test('alertMetalsFailure returns a result', async () => {
      const alertService = loadFreshAlertService();
      const result = await alertService.alertMetalsFailure(3, 'timeout');
      expect(result).toHaveProperty('sent', false);
      expect(result).toHaveProperty('reason', 'not-configured');
    });

    test('alertGreysheetFailure returns a result', async () => {
      const alertService = loadFreshAlertService();
      const result = await alertService.alertGreysheetFailure('API error');
      expect(result).toHaveProperty('sent', false);
    });

    test('alertBlobImportFailure returns a result', async () => {
      const alertService = loadFreshAlertService();
      const result = await alertService.alertBlobImportFailure(3, 'network error');
      expect(result).toHaveProperty('sent', false);
    });

    test('alertPrefetchFailure returns a result', async () => {
      const alertService = loadFreshAlertService();
      const result = await alertService.alertPrefetchFailure(2, 'quota exceeded');
      expect(result).toHaveProperty('sent', false);
    });

    test('alertServerCrash returns a result', async () => {
      const alertService = loadFreshAlertService();
      const result = await alertService.alertServerCrash('uncaughtException', 'ReferenceError');
      expect(result).toHaveProperty('sent', false);
    });

    test('alertPcgsBreakerTripped returns a result', async () => {
      const alertService = loadFreshAlertService();
      const result = await alertService.alertPcgsBreakerTripped(14);
      expect(result).toHaveProperty('sent', false);
    });
  });
});
