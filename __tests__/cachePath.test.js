// __tests__/cachePath.test.js — Unit tests for src/utils/cachePath.js
'use strict';

const fs = require('fs');
const path = require('path');

describe('cachePath', () => {
  const originalEnv = process.env.CACHE_DIR;

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.CACHE_DIR = originalEnv;
    } else {
      delete process.env.CACHE_DIR;
    }
    jest.resetModules();
  });

  test('exports CACHE_DIR string', () => {
    const { CACHE_DIR } = require('../src/utils/cachePath');
    expect(typeof CACHE_DIR).toBe('string');
    expect(CACHE_DIR.length).toBeGreaterThan(0);
  });

  test('defaults to project-level cache/ when CACHE_DIR env is unset', () => {
    delete process.env.CACHE_DIR;
    jest.resetModules();

    const { CACHE_DIR } = require('../src/utils/cachePath');
    const expected = path.resolve(__dirname, '..', 'cache');
    expect(CACHE_DIR).toBe(expected);
  });

  test('uses CACHE_DIR env var when set', () => {
    const customDir = path.join(__dirname, '..', 'tmp-test-cache-' + Date.now());
    process.env.CACHE_DIR = customDir;
    jest.resetModules();

    const { CACHE_DIR } = require('../src/utils/cachePath');
    expect(CACHE_DIR).toBe(customDir);

    // Clean up created directory
    if (fs.existsSync(customDir)) fs.rmSync(customDir, { recursive: true });
  });

  test('creates the cache directory if it does not exist', () => {
    const customDir = path.join(__dirname, '..', 'tmp-test-cache-create-' + Date.now());
    expect(fs.existsSync(customDir)).toBe(false);

    process.env.CACHE_DIR = customDir;
    jest.resetModules();

    require('../src/utils/cachePath');
    expect(fs.existsSync(customDir)).toBe(true);

    // Clean up
    fs.rmSync(customDir, { recursive: true });
  });

  test('does not throw if directory already exists', () => {
    const customDir = path.join(__dirname, '..', 'tmp-test-cache-exists-' + Date.now());
    fs.mkdirSync(customDir, { recursive: true });

    process.env.CACHE_DIR = customDir;
    jest.resetModules();

    expect(() => require('../src/utils/cachePath')).not.toThrow();

    // Clean up
    fs.rmSync(customDir, { recursive: true });
  });

  test('CACHE_DIR is an absolute path', () => {
    const { CACHE_DIR } = require('../src/utils/cachePath');
    expect(path.isAbsolute(CACHE_DIR)).toBe(true);
  });
});
