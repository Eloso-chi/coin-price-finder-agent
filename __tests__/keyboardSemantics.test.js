'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function tagWithId(id) {
  const match = source.match(new RegExp(`<[^>]+id=["']${id}["'][^>]*>`));
  expect(match).not.toBeNull();
  return match[0];
}

describe('native keyboard semantics contract (#304H)', () => {
  test.each([
    ['tp-file-browse-btn', 'Choose CSV File'],
    ['bulk-excel-browse-btn', 'Upload Excel'],
  ])('%s is a visible native file-browse button', (id, label) => {
    const tag = tagWithId(id);
    expect(tag).toMatch(/^<button\b/);
    expect(tag).toContain('type="button"');
    expect(source).toContain(`id="${id}"`);
    expect(source).toContain(`>${label}</button>`);
  });

  test('file-browse buttons activate their corresponding inputs', () => {
    expect(source).toContain("this.els.browseBtn.addEventListener('click', () => this.els.fileInput.click())");
    expect(source).toContain("excelBrowse.addEventListener('click', function() { excelInput.click(); })");
    expect(tagWithId('tp-file-input')).toContain('accept=".csv,.tsv,.txt"');
    expect(tagWithId('bulk-excel-input')).toContain('accept=".xlsx"');
  });

  test('cross-tab shortcuts are native buttons on both result renderers', () => {
    const buttonMarkup = '<button type="button" class="cross-tab-link" data-tab="tab-melt"';
    expect(source.split(buttonMarkup)).toHaveLength(3);
    expect(source).not.toMatch(/<a data-tab="tab-(?:melt|tracker|history)"/);
    expect(source).toContain("querySelectorAll('.cross-tab-links button[data-tab]')");
  });

  test('cross-tab activation focuses the destination unless login owns focus', () => {
    expect(source).toContain('if (!authDialog || !authDialog.open) tabBtn.focus()');
    expect(source).toContain('tabBtn.click()');
  });

  test('locked tabs remain actionable and describe the login transition', () => {
    expect(source).not.toContain("btn.setAttribute('aria-disabled', 'true')");
    expect(source).toContain("btn.setAttribute('aria-label', destination + '. Sign in to open.')");
    expect(source).toContain("btn.setAttribute('title', 'Sign in to open ' + destination)");
    expect(source).toContain("btn.removeAttribute('aria-label')");
  });
});
