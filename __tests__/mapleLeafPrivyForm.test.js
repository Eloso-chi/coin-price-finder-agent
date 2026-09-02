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
    document.body.innerHTML = `
      ${field('coinName', '<input id="coinName">')}
      ${field('coinYear', '<input id="coinYear">')}
      ${field('coinMint', '<input id="coinMint">')}
      ${field('coinGrade', '<input id="coinGrade">')}
      ${field('coinFinish', '<select id="coinFinish"><option value=""></option><option value="Reverse Proof">Reverse Proof</option></select>')}
      ${field('coinMetal', '<select id="coinMetal"><option value=""></option><option value="silver">Silver</option><option value="gold">Gold</option></select>')}
      ${field('coinSpecialMark', '<select id="coinSpecialMark"><option value="unspecified">Not specified</option><option value="standard">Standard</option><option value="unknown">Not listed</option><option value="rcm.maple.emc2" data-registry-mark="true" data-canonical-name="E=mc2">E=mc2</option></select>')}
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
      askingPrice: document.getElementById('askingPrice'), quickAsk: document.getElementById('quickAskingPrice'),
      query: document.getElementById('query'), previewWrap: document.getElementById('query-preview'),
      previewText: document.getElementById('preview-text'), submit: document.getElementById('submit'),
      quickSubmit: document.getElementById('quick-submit'),
    };
    CoinForm._bindSetDetection();
    CoinForm._bindPreview();
  });

  afterEach(() => { delete global.runQuery; });

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
});