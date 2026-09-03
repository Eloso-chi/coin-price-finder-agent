/**
 * @jest-environment jsdom
 */
/* global document, KeyboardEvent */
'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function loadCoinForm() {
  const start = source.indexOf('const CoinForm = {');
  const end = source.indexOf('// Boot CoinForm', start);
  const definition = source.slice(start, end);
  return new Function('document', 'zodiacAnimal', 'perthSeriesNum', 'runQuery', `${definition}\nreturn CoinForm;`)(
    document, () => null, () => null, global.runQuery
  );
}

function field(id, control) {
  return `<div class="field"><label for="${id}">${id}</label>${control}</div>`;
}

describe('structured Maple Leaf privy form workflow', () => {
  let CoinForm;

  beforeEach(() => {
    global.runQuery = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ marks: [], requiresSelection: false }),
    });
    document.body.innerHTML = `
      ${field('coinName', '<input id="coinName">')}
      ${field('coinYear', '<input id="coinYear">')}
      ${field('coinMint', '<input id="coinMint">')}
      ${field('coinGrade', '<input id="coinGrade">')}
      ${field('coinFinish', '<select id="coinFinish"><option value=""></option><option value="Reverse Proof">Reverse Proof</option></select>')}
      ${field('coinMetal', '<select id="coinMetal"><option value=""></option><option value="silver">Silver</option><option value="gold">Gold</option></select>')}
      ${field('coinSpecialMark', '<select id="coinSpecialMark" aria-describedby="coinSpecialMark-hint coinSpecialMark-status"><option value="unspecified">Not specified</option><option value="standard">Standard</option><option value="unknown">Not listed</option><option value="rcm.maple.emc2" data-registry-mark="true" data-canonical-name="E=mc2">E=mc2</option></select><span id="coinSpecialMark-hint">Known marks</span><span id="coinSpecialMark-status" role="status" aria-live="polite"></span>')}
      <label id="silverCheckLabel"><input id="coinSilver" type="checkbox">Silver</label>
      ${field('coinLabel', '<select id="coinLabel"><option value=""></option></select>')}
      <div class="field" id="coinVariantDetailRow" style="display:none">
        <label for="coinVariantDetail">Privy name or mark</label>
        <input id="coinVariantDetail" aria-describedby="coinVariantDetail-hint coinVariantDetail-error">
        <span id="coinVariantDetail-hint">Required</span>
        <div class="field-error-msg" id="coinVariantDetail-error">Enter the specific privy name or mark</div>
      </div>
      ${field('coinWeight', '<select id="coinWeight"><option value="" selected>1 oz (bullion default)</option><option value="0.5">1/2 oz</option></select>')}
      ${field('setType', '<select id="setType"><option value="clad">Clad Proof Set</option></select>')}
      <div id="setTypeRow"></div>
      <input id="pcgsNumber"><input id="askingPrice"><input id="quickAskingPrice">
      <input id="query"><select id="quickWeight"><option value=""></option></select>
      <select id="saleContext"><option value="ebay">eBay</option></select>
      <input id="appealMultiplier" value="1">
      <div id="query-preview" class="empty"><span id="preview-text"></span></div>
      <span id="coinZodiacHint"></span>
      <button id="submit"></button><button id="quick-submit"></button>
    `;

    CoinForm = loadCoinForm();
    CoinForm.els = {
      coinName: document.getElementById('coinName'), coinYear: document.getElementById('coinYear'),
      coinMint: document.getElementById('coinMint'), grade: document.getElementById('coinGrade'),
      coinFinish: document.getElementById('coinFinish'), coinMetal: document.getElementById('coinMetal'),
      specialMark: document.getElementById('coinSpecialMark'),
      coinSilver: document.getElementById('coinSilver'), silverLabel: document.getElementById('silverCheckLabel'),
      coinLabel: document.getElementById('coinLabel'), variantDetail: document.getElementById('coinVariantDetail'),
      variantDetailRow: document.getElementById('coinVariantDetailRow'), coinWeight: document.getElementById('coinWeight'),
      quickWeight: document.getElementById('quickWeight'), setType: document.getElementById('setType'),
      setTypeRow: document.getElementById('setTypeRow'), pcgsNumber: document.getElementById('pcgsNumber'),
      specialMarkStatus: document.getElementById('coinSpecialMark-status'),
      askingPrice: document.getElementById('askingPrice'), quickAsk: document.getElementById('quickAskingPrice'),
      query: document.getElementById('query'), previewWrap: document.getElementById('query-preview'),
      previewText: document.getElementById('preview-text'), submit: document.getElementById('submit'),
      quickSubmit: document.getElementById('quick-submit'),
    };
    CoinForm._bindSetDetection();
    CoinForm._bindPreview();
  });

  afterEach(() => {
    clearTimeout(CoinForm.specialMarkRefreshTimer);
    delete global.fetch;
    delete global.runQuery;
  });

  test('preserves the exact 1 oz silver Reverse Proof EMC2 identity', () => {
    CoinForm.els.coinName.value = 'Canadian Maple Leaf';
    CoinForm.els.coinYear.value = '2015';
    CoinForm.els.coinFinish.value = 'Reverse Proof';
    CoinForm.els.coinMetal.value = 'silver';
    const markOption = document.createElement('option');
    markOption.value = 'rcm.maple.emc2';
    markOption.dataset.registryMark = 'true';
    markOption.dataset.canonicalName = 'E=mc2';
    markOption.textContent = 'E=mc2';
    CoinForm.els.specialMark.add(markOption);
    CoinForm.els.specialMark.value = 'rcm.maple.emc2';
    CoinForm.els.specialMark.dispatchEvent(new Event('change'));
    CoinForm._updatePreview();
    CoinForm.specialMarkContextKey = CoinForm._currentSpecialMarkContextKey();

    expect(CoinForm.els.variantDetailRow.style.display).toBe('none');
    expect(CoinForm.els.previewText.textContent).toBe('2015 Canadian Maple Leaf Silver Reverse Proof E=mc2 Privy 1 oz');
    expect(CoinForm.getData()).toEqual(expect.objectContaining({
      query: '2015 Canadian Maple Leaf Silver Reverse Proof E=mc2 Privy 1 oz',
      coinData: expect.objectContaining({
        composition: 'silver', finish: 'Reverse Proof', specialMarkMode: 'exact',
        specialMarks: [{ markId: 'rcm.maple.emc2' }], variantDetail: null, weight: 1,
      }),
    }));

    CoinForm.els.coinWeight.value = '0.5';
    CoinForm.els.coinWeight.dispatchEvent(new Event('input'));
    expect(CoinForm.els.previewText.textContent).toBe('2015 Canadian Maple Leaf Silver Reverse Proof E=mc2 Privy 1/2 oz');
  });

  test('blocks a blank Privy detail and focuses its accessible error', () => {
    CoinForm.els.coinName.value = 'Canadian Maple Leaf';
    CoinForm.els.coinYear.value = '2015';
    CoinForm.els.specialMark.value = 'unknown';
    CoinForm.els.specialMark.dispatchEvent(new Event('change'));
    CoinForm.specialMarkContextKey = CoinForm._currentSpecialMarkContextKey();

    expect(CoinForm.validate()).toBe(false);
    expect(CoinForm.els.variantDetail.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(CoinForm.els.variantDetail);
    expect(CoinForm.els.variantDetail.getAttribute('aria-describedby')).toContain('coinVariantDetail-error');
  });

  test('clears hidden detail and supports Enter submission from the detail field', () => {
    CoinForm._bindSubmit();
    CoinForm.els.specialMark.value = 'unknown';
    CoinForm.els.specialMark.dispatchEvent(new Event('change'));
    CoinForm.els.variantDetail.value = 'EMC2';
    CoinForm.els.variantDetail.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(global.runQuery).toHaveBeenCalledTimes(1);

    CoinForm.els.specialMark.value = 'standard';
    CoinForm.els.specialMark.dispatchEvent(new Event('change'));
    expect(CoinForm.els.variantDetailRow.style.display).toBe('none');
    expect(CoinForm.els.variantDetail.value).toBe('');
    expect(CoinForm.els.variantDetail.required).toBe(false);
    expect(CoinForm.getData()).toBeNull();
  });

  test('does not apply the bullion 1 oz default to a numismatic coin', () => {
    CoinForm.els.coinName.value = 'Morgan Dollar';
    CoinForm.els.coinYear.value = '1921';
    CoinForm._updatePreview();
    CoinForm.specialMarkContextKey = CoinForm._currentSpecialMarkContextKey();

    expect(CoinForm.els.previewText.textContent).toBe('1921 Morgan Dollar');
    expect(CoinForm.getData().coinData.weight).toBeNull();
  });

  test.each([
    ['Canadian Silver Maple Leaf', 'silver'],
    ['Canadian Gold Maple Leaf', 'gold'],
  ])('synchronizes %s to its deterministic metal', (name, metal) => {
    CoinForm.els.coinName.value = name;
    CoinForm.els.coinName.dispatchEvent(new Event('change'));
    expect(CoinForm.els.coinMetal.value).toBe(metal);
  });

  test('corrects a manual metal contradiction for an explicitly named Maple Leaf program', () => {
    CoinForm.els.coinName.value = 'Canadian Gold Maple Leaf';
    CoinForm.els.coinName.dispatchEvent(new Event('change'));
    CoinForm.els.coinMetal.value = 'silver';
    CoinForm.els.coinMetal.dispatchEvent(new Event('change'));

    expect(CoinForm.els.coinMetal.value).toBe('gold');
    CoinForm.els.coinYear.value = '2024';
    CoinForm.specialMarksLoading = false;
    CoinForm.specialMarkContextKey = CoinForm._currentSpecialMarkContextKey();
    expect(CoinForm.getData().coinData.composition).toBe('gold');
  });

  test('loads a single 2015 mark without requiring selection', async () => {
    global.fetch.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({
        marks: [{ markId: 'rcm.maple.emc2', canonicalName: 'E=mc2', kind: 'privy' }],
        requiresSelection: false,
      }),
    });
    CoinForm.specialMarkCache.clear();
    CoinForm.els.coinName.value = 'Canadian Silver Maple Leaf';
    CoinForm.els.coinYear.value = '2015';
    CoinForm.els.coinFinish.value = 'Reverse Proof';
    CoinForm.els.coinMetal.value = 'silver';

    await CoinForm._updateSpecialMarkOptions();

    expect(CoinForm.specialMarkSelectionRequired).toBe(false);
    expect(CoinForm.els.specialMark.querySelector('option[value="rcm.maple.emc2"]')).not.toBeNull();
    expect(CoinForm.els.specialMarkStatus.textContent).toBe('1 applicable special mark available');
  });

  test('loads both 2018 privies and blocks unspecified pricing with an associated error', async () => {
    global.fetch.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({
        marks: [
          { markId: 'rcm.maple.pronghorn-antelope.2018', canonicalName: 'Pronghorn Antelope', kind: 'privy' },
          { markId: 'rcm.maple.wood-bison.2018', canonicalName: 'Wood Bison', kind: 'privy' },
        ],
        requiresSelection: true,
      }),
    });
    CoinForm.specialMarkCache.clear();
    CoinForm.els.coinName.value = 'Canadian Silver Maple Leaf';
    CoinForm.els.coinYear.value = '2018';
    CoinForm.els.coinFinish.value = 'Reverse Proof';
    CoinForm.els.coinMetal.value = 'silver';

    await CoinForm._updateSpecialMarkOptions();

    expect(CoinForm.validate()).toBe(false);
    expect(CoinForm.els.specialMark.getAttribute('aria-invalid')).toBe('true');
    expect(CoinForm.els.specialMark.closest('.field').classList.contains('has-error')).toBe(true);
    expect(CoinForm.els.specialMark.getAttribute('aria-describedby')).toContain('coinSpecialMark-status');
    expect(CoinForm.els.specialMarkStatus.textContent).toContain('My mark is not listed');
    expect([...CoinForm.els.specialMark.options].map(option => option.textContent)).toEqual(expect.arrayContaining([
      'Pronghorn Antelope (privy)', 'Wood Bison (privy)',
    ]));
    expect(document.activeElement).toBe(CoinForm.els.specialMark);

    CoinForm.els.specialMark.value = 'standard';
    expect(CoinForm.validate()).toBe(true);
  });

  test('ignores a stale response after the program changes from Silver to Gold', async () => {
    let resolveSilver;
    const silverResponse = new Promise(resolve => { resolveSilver = resolve; });
    global.fetch.mockReset()
      .mockReturnValueOnce(silverResponse)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ marks: [], requiresSelection: false }) });
    CoinForm.specialMarkCache.clear();
    CoinForm.els.coinName.value = 'Canadian Silver Maple Leaf';
    CoinForm.els.coinYear.value = '2018';
    CoinForm.els.coinFinish.value = 'Reverse Proof';
    CoinForm.els.coinMetal.value = 'silver';
    const staleLookup = CoinForm._updateSpecialMarkOptions();
    const staleSignal = global.fetch.mock.calls[0][1].signal;

    CoinForm.els.coinName.value = 'Canadian Gold Maple Leaf';
    CoinForm.els.coinName.dispatchEvent(new Event('input'));
    const currentLookup = CoinForm._updateSpecialMarkOptions();
    expect(staleSignal.aborted).toBe(true);
    await currentLookup;
    resolveSilver({
      ok: true,
      json: async () => ({
        marks: [{ markId: 'rcm.maple.wood-bison.2018', canonicalName: 'Wood Bison', kind: 'privy' }],
        requiresSelection: false,
      }),
    });
    await staleLookup;

    expect(CoinForm.els.coinMetal.value).toBe('gold');
    expect(CoinForm.els.specialMark.querySelector('option[value="rcm.maple.wood-bison.2018"]')).toBeNull();
    expect(CoinForm.els.specialMarkStatus.textContent).toBe('No registered special marks apply');
  });

  test('aborts a pending lookup when the replacement context is already cached', async () => {
    let resolveSilver;
    global.fetch.mockReset().mockReturnValue(new Promise(resolve => { resolveSilver = resolve; }));
    CoinForm.specialMarkCache.clear();
    CoinForm.specialMarkRequests.clear();
    CoinForm.els.coinName.value = 'Canadian Silver Maple Leaf';
    CoinForm.els.coinYear.value = '2018';
    CoinForm.els.coinFinish.value = 'Reverse Proof';
    CoinForm.els.coinMetal.value = 'silver';
    const silverKey = CoinForm._currentSpecialMarkContextKey();
    const pendingSilver = CoinForm._updateSpecialMarkOptions();
    const silverSignal = global.fetch.mock.calls[0][1].signal;

    CoinForm.els.coinName.value = 'Canadian Gold Maple Leaf';
    CoinForm.els.coinMetal.value = 'gold';
    const goldKey = CoinForm._currentSpecialMarkContextKey();
    CoinForm.specialMarkCache.set(goldKey, { marks: [], requiresSelection: false });
    await CoinForm._updateSpecialMarkOptions();

    expect(silverSignal.aborted).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    resolveSilver({ ok: true, json: async () => ({ marks: [], requiresSelection: false }) });
    await pendingSilver;
    expect(CoinForm.specialMarkRequests.size).toBe(0);
    expect(CoinForm.specialMarkCache.has(goldKey)).toBe(true);
    expect(CoinForm.specialMarkCache.has(silverKey)).toBe(false);
  });

  test('normalizes equivalent contexts and bounds the completed-response cache', async () => {
    CoinForm.els.coinName.value = '  CANADIAN   SILVER MAPLE LEAF  ';
    CoinForm.els.coinYear.value = '2018';
    CoinForm.els.coinFinish.value = 'Reverse Proof';
    CoinForm.els.coinMetal.value = 'silver';
    const firstKey = CoinForm._currentSpecialMarkContextKey();
    CoinForm.els.coinName.value = 'canadian silver maple leaf';
    expect(CoinForm._currentSpecialMarkContextKey()).toBe(firstKey);

    CoinForm.specialMarkCache.clear();
    for (let index = 0; index < CoinForm.specialMarkCacheLimit; index++) {
      CoinForm.specialMarkCache.set(`old-${index}`, { marks: [] });
    }
    global.fetch.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({ marks: [], requiresSelection: false }),
    });
    await CoinForm._updateSpecialMarkOptions();

    expect(CoinForm.specialMarkCache.size).toBe(CoinForm.specialMarkCacheLimit);
    expect(CoinForm.specialMarkCache.has('old-0')).toBe(false);
    expect(CoinForm.specialMarkCache.has(firstKey)).toBe(true);
  });

  test('coalesces concurrent lookups for the same normalized context', async () => {
    let resolveLookup;
    global.fetch.mockReset().mockReturnValue(new Promise(resolve => { resolveLookup = resolve; }));
    CoinForm.specialMarkCache.clear();
    CoinForm.specialMarkRequests.clear();
    CoinForm.els.coinName.value = 'Canadian Silver Maple Leaf';
    CoinForm.els.coinYear.value = '2018';
    CoinForm.els.coinFinish.value = 'Reverse Proof';
    CoinForm.els.coinMetal.value = 'silver';

    const first = CoinForm._updateSpecialMarkOptions();
    const second = CoinForm._updateSpecialMarkOptions();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    resolveLookup({ ok: true, json: async () => ({ marks: [], requiresSelection: false }) });
    await Promise.all([first, second]);

    expect(CoinForm.specialMarkRequests.size).toBe(0);
  });
});