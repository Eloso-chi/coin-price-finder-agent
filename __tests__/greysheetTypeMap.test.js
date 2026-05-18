// __tests__/greysheetTypeMap.test.js -- Tests for Greysheet Type GSID lookup
'use strict';

const { lookupTypeGsid, TYPE_GSID_MAP, _detectMetal, _detectWeight, _detectFinish } = require('../src/data/greysheetTypeMap');

describe('greysheetTypeMap', () => {

  // ── _detectMetal ────────────────────────────────────────────
  describe('_detectMetal', () => {
    it('detects silver', () => expect(_detectMetal('Mexican Silver Libertad')).toBe('silver'));
    it('detects gold', () => expect(_detectMetal('Gold Eagle 1 oz')).toBe('gold'));
    it('detects platinum', () => expect(_detectMetal('Platinum Eagle')).toBe('platinum'));
    it('detects palladium', () => expect(_detectMetal('Palladium Eagle')).toBe('palladium'));
    it('returns null for unknown', () => expect(_detectMetal('Kennedy Half Dollar')).toBeNull());
    it('returns null for empty', () => expect(_detectMetal('')).toBeNull());
    it('returns null for null', () => expect(_detectMetal(null)).toBeNull());
  });

  // ── _detectWeight ───────────────────────────────────────────
  describe('_detectWeight', () => {
    it('detects 1 oz', () => expect(_detectWeight('1 oz Silver Eagle')).toBe(1));
    it('detects 1/2 oz', () => expect(_detectWeight('1/2 oz Gold Eagle')).toBe(0.5));
    it('detects half oz', () => expect(_detectWeight('half oz Libertad')).toBe(0.5));
    it('detects 1/4 oz', () => expect(_detectWeight('1/4 oz Maple Leaf')).toBe(0.25));
    it('detects quarter oz', () => expect(_detectWeight('quarter oz Krugerrand')).toBe(0.25));
    it('detects 1/10 oz', () => expect(_detectWeight('1/10 oz Gold Eagle')).toBe(0.1));
    it('detects tenth oz', () => expect(_detectWeight('tenth oz Libertad')).toBe(0.1));
    it('detects 1/20 oz', () => expect(_detectWeight('1/20 oz Libertad')).toBe(0.05));
    it('detects twentieth oz', () => expect(_detectWeight('twentieth oz Maple')).toBe(0.05));
    it('returns null for no weight', () => expect(_detectWeight('Morgan Silver Dollar')).toBeNull());
  });

  // ── lookupTypeGsid: Bullion series ─────────────────────────
  describe('lookupTypeGsid - bullion', () => {

    it('resolves ASE (Silver Eagle 1 oz)', () => {
      const r = lookupTypeGsid('American Silver Eagle 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72469);
      expect(r.lookupKey).toBe('silver eagle|1');
    });

    it('resolves ASE without explicit weight via hints', () => {
      const r = lookupTypeGsid('American Silver Eagle', { weight: 1 });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72469);
    });

    it('resolves Gold Eagle 1/10 oz', () => {
      const r = lookupTypeGsid('American Gold Eagle 1/10 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(74227);
      expect(r.lookupKey).toBe('gold eagle|0.1');
    });

    it('resolves Gold Eagle 1/4 oz', () => {
      const r = lookupTypeGsid('Gold Eagle quarter oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(74228);
    });

    it('resolves Gold Eagle 1/2 oz', () => {
      const r = lookupTypeGsid('Gold Eagle half oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(74229);
    });

    it('resolves Gold Eagle 1 oz', () => {
      const r = lookupTypeGsid('American Gold Eagle 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(74237);
    });

    it('resolves Platinum Eagle 1 oz', () => {
      const r = lookupTypeGsid('Platinum Eagle 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(74270);
    });

    it('resolves Palladium Eagle 1 oz', () => {
      const r = lookupTypeGsid('Palladium Eagle 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(376573);
    });

    it('resolves Gold Buffalo 1 oz', () => {
      const r = lookupTypeGsid('American Gold Buffalo 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(74456);
    });
  });

  // ── lookupTypeGsid: Canada ─────────────────────────────────
  describe('lookupTypeGsid - Canada', () => {

    it('resolves Silver Maple Leaf 1 oz', () => {
      const r = lookupTypeGsid('Canadian Silver Maple Leaf 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(373777);
    });

    it('resolves Gold Maple Leaf 1 oz', () => {
      const r = lookupTypeGsid('Canadian Gold Maple Leaf 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(213178);
    });

    it('resolves Gold Maple Leaf 1/10 oz', () => {
      const r = lookupTypeGsid('Gold Maple Leaf 1/10 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(373793);
    });
  });

  // ── lookupTypeGsid: Mexico ─────────────────────────────────
  describe('lookupTypeGsid - Mexico Libertad', () => {

    it('resolves Silver Libertad 1 oz', () => {
      const r = lookupTypeGsid('Mexican Silver Libertad 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393495);
      expect(r.lookupKey).toBe('libertad|1|silver');
    });

    it('resolves Silver Libertad 1/2 oz', () => {
      const r = lookupTypeGsid('Silver Libertad 1/2 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393819);
    });

    it('resolves Silver Libertad 1/4 oz', () => {
      const r = lookupTypeGsid('Silver Libertad 1/4 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393815);
    });

    it('resolves Silver Libertad 1/10 oz', () => {
      const r = lookupTypeGsid('Silver Libertad 1/10 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393739);
    });

    it('resolves Silver Libertad 1/20 oz', () => {
      const r = lookupTypeGsid('Silver Libertad 1/20 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(374245);
    });

    it('resolves Gold Libertad 1 oz', () => {
      const r = lookupTypeGsid('Gold Libertad 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393496);
    });

    it('resolves Gold Libertad 1/2 oz', () => {
      const r = lookupTypeGsid('Gold Libertad half oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393956);
    });

    it('resolves via hints when text is sparse', () => {
      const r = lookupTypeGsid('Libertad', { metal: 'silver', weight: 1 });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393495);
    });
  });

  // ── lookupTypeGsid: Australia ──────────────────────────────
  describe('lookupTypeGsid - Australia', () => {

    it('resolves Silver Kookaburra 1 oz', () => {
      const r = lookupTypeGsid('Australian Silver Kookaburra 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393577);
    });

    it('resolves Silver Kangaroo 1 oz', () => {
      const r = lookupTypeGsid('Australian Silver Kangaroo 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393506);
    });

    it('resolves Silver Lunar 1 oz', () => {
      const r = lookupTypeGsid('Australian Lunar Silver 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393681);
    });

    it('resolves Gold Lunar 1 oz', () => {
      const r = lookupTypeGsid('Australian Gold Lunar 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393627);
    });
  });

  // ── lookupTypeGsid: Austria ────────────────────────────────
  describe('lookupTypeGsid - Austria', () => {

    it('resolves Silver Philharmonic 1 oz', () => {
      const r = lookupTypeGsid('Austrian Silver Philharmonic 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(374302);
    });

    it('resolves Gold Philharmonic 1 oz', () => {
      const r = lookupTypeGsid('Gold Philharmonic 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(395557);
    });
  });

  // ── lookupTypeGsid: South Africa ───────────────────────────
  describe('lookupTypeGsid - South Africa', () => {

    it('resolves Gold Krugerrand 1 oz', () => {
      const r = lookupTypeGsid('Gold Krugerrand 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(373711);
    });

    it('resolves Gold Krugerrand 1/4 oz', () => {
      const r = lookupTypeGsid('Gold Krugerrand 1/4 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(395932);
    });

    it('resolves Gold Krugerrand 1/10 oz', () => {
      const r = lookupTypeGsid('Gold Krugerrand 1/10 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(396050);
    });
  });

  // ── lookupTypeGsid: China ──────────────────────────────────
  describe('lookupTypeGsid - China', () => {

    it('resolves Gold Panda 1 oz', () => {
      const r = lookupTypeGsid('Chinese Gold Panda 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(395439);
    });

    it('resolves Silver Panda 1 oz', () => {
      const r = lookupTypeGsid('Chinese Silver Panda 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(373776);
    });
  });

  // ── lookupTypeGsid: US Classics ────────────────────────────
  describe('lookupTypeGsid - US Classics', () => {

    it('resolves Morgan Silver Dollar', () => {
      const r = lookupTypeGsid('Morgan Silver Dollar');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72404);
    });

    it('resolves Peace Silver Dollar', () => {
      const r = lookupTypeGsid('Peace Silver Dollar');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72407);
    });

    it('resolves Eisenhower Dollar', () => {
      const r = lookupTypeGsid('Eisenhower Dollar');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(376575);
    });

    it('resolves Ike Dollar via alias', () => {
      const r = lookupTypeGsid('Ike Dollar');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(376575);
    });

    it('resolves Walking Liberty Half', () => {
      const r = lookupTypeGsid('Walking Liberty Half Dollar');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72414);
    });

    it('resolves Franklin Half Dollar', () => {
      const r = lookupTypeGsid('Franklin Half Dollar');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(76527);
    });

    it('resolves Kennedy Half Dollar (silver)', () => {
      const r = lookupTypeGsid('Kennedy Half Dollar silver');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(24983);
    });

    it('resolves Mercury Dime', () => {
      const r = lookupTypeGsid('Mercury Dime');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72464);
    });

    it('resolves Barber Dime', () => {
      const r = lookupTypeGsid('Barber Dime');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72463);
    });

    it('resolves Roosevelt Dime (silver)', () => {
      const r = lookupTypeGsid('Roosevelt Dime silver');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(76246);
    });

    it('resolves Standing Liberty Quarter', () => {
      const r = lookupTypeGsid('Standing Liberty Quarter');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72441);
    });

    it('resolves Washington Quarter silver', () => {
      const r = lookupTypeGsid('Washington Quarter silver');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72443);
    });

    it('resolves Barber Quarter', () => {
      const r = lookupTypeGsid('Barber Quarter');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72438);
    });

    it('resolves Barber Half Dollar', () => {
      const r = lookupTypeGsid('Barber Half Dollar');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72413);
    });

    it('resolves Buffalo Nickel', () => {
      const r = lookupTypeGsid('Buffalo Nickel');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72361);
    });
  });

  // ── lookupTypeGsid: No match ───────────────────────────────
  describe('lookupTypeGsid - no match', () => {

    it('returns null for unknown series', () => {
      expect(lookupTypeGsid('Swiss Vreneli Gold')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(lookupTypeGsid('')).toBeNull();
    });

    it('returns null for Britannia (not in catalog)', () => {
      expect(lookupTypeGsid('British Gold Britannia 1 oz')).toBeNull();
    });

    it('returns null for Silver Krugerrand MS (no MS entry in catalog)', () => {
      expect(lookupTypeGsid('Silver Krugerrand 1 oz')).toBeNull();
    });

    it('resolves Silver Krugerrand 1 oz Proof', () => {
      const r = lookupTypeGsid('Silver Krugerrand 1 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(373710);
      expect(r.lookupKey).toBe('krugerrand|1|silver|proof');
    });
  });

  // ── lookupTypeGsid: hints override ─────────────────────────
  describe('lookupTypeGsid - hints', () => {

    it('uses metal hint to disambiguate Maple Leaf', () => {
      const gold = lookupTypeGsid('Maple Leaf 1 oz', { metal: 'gold' });
      const silver = lookupTypeGsid('Maple Leaf 1 oz', { metal: 'silver' });
      expect(gold.gsid).toBe(213178);
      expect(silver.gsid).toBe(373777);
    });

    it('uses weight hint when not in text', () => {
      const r = lookupTypeGsid('Silver Libertad', { weight: 0.25 });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393815);
    });

    it('uses series hint', () => {
      const r = lookupTypeGsid('1 oz bullion', { series: 'Silver Eagle', weight: 1 });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72469);
    });
  });

  // ── TYPE_GSID_MAP integrity ────────────────────────────────
  describe('TYPE_GSID_MAP integrity', () => {

    it('has at least 50 entries', () => {
      expect(Object.keys(TYPE_GSID_MAP).length).toBeGreaterThanOrEqual(50);
    });

    it('all values are positive integers', () => {
      for (const [key, gsid] of Object.entries(TYPE_GSID_MAP)) {
        expect(typeof gsid).toBe('number');
        expect(gsid).toBeGreaterThan(0);
        expect(Number.isInteger(gsid)).toBe(true);
      }
    });

    it('has no duplicate GSIDs', () => {
      const vals = Object.values(TYPE_GSID_MAP);
      expect(new Set(vals).size).toBe(vals.length);
    });
  });

  // ── _detectFinish ──────────────────────────────────────────
  describe('_detectFinish', () => {
    it('detects proof', () => expect(_detectFinish('Silver Eagle Proof')).toBe('proof'));
    it('detects reverse proof', () => expect(_detectFinish('Libertad Reverse Proof')).toBe('reverse proof'));
    it('detects burnished', () => expect(_detectFinish('ASE Burnished')).toBe('burnished'));
    it('detects satin', () => expect(_detectFinish('Buffalo Nickel Satin Finish')).toBe('satin'));
    it('detects PR (case-sensitive)', () => expect(_detectFinish('ASE PR DCAM')).toBe('proof'));
    it('returns null for MS coins', () => expect(_detectFinish('Silver Eagle 1 oz')).toBeNull());
    it('returns null for null', () => expect(_detectFinish(null)).toBeNull());
    it('returns null for empty', () => expect(_detectFinish('')).toBeNull());
    it('prefers reverse proof over plain proof', () => {
      expect(_detectFinish('Libertad Reverse Proof 1 oz')).toBe('reverse proof');
    });
  });

  // ── lookupTypeGsid: Proof finish ───────────────────────────
  describe('lookupTypeGsid - proof finish', () => {

    it('resolves ASE Proof', () => {
      const r = lookupTypeGsid('American Silver Eagle 1 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72470);
      expect(r.lookupKey).toBe('silver eagle|1|proof');
    });

    it('resolves AGE 1 oz Proof', () => {
      const r = lookupTypeGsid('Gold Eagle 1 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(74303);
    });

    it('resolves AGE 1/10 oz Proof', () => {
      const r = lookupTypeGsid('Gold Eagle 1/10 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(74286);
    });

    it('resolves Platinum Eagle 1 oz Proof', () => {
      const r = lookupTypeGsid('Platinum Eagle 1 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(74275);
    });

    it('resolves Silver Libertad 1 oz Proof', () => {
      const r = lookupTypeGsid('Mexican Silver Libertad 1 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393825);
      expect(r.lookupKey).toBe('libertad|1|silver|proof');
    });

    it('resolves Silver Libertad 1/2 oz Proof', () => {
      const r = lookupTypeGsid('Silver Libertad 1/2 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393821);
    });

    it('resolves Silver Libertad 1/20 oz Proof', () => {
      const r = lookupTypeGsid('Silver Libertad 1/20 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(374246);
    });

    it('resolves Gold Libertad 1 oz Proof', () => {
      const r = lookupTypeGsid('Gold Libertad 1 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393960);
    });

    it('resolves Silver Panda 1 oz Proof', () => {
      const r = lookupTypeGsid('Chinese Silver Panda 1 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(395448);
    });

    it('resolves Gold Panda 1 oz Proof', () => {
      const r = lookupTypeGsid('Chinese Gold Panda 1 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(395440);
    });

    it('resolves Silver Maple Leaf 1 oz Proof', () => {
      const r = lookupTypeGsid('Silver Maple Leaf 1 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(396685);
    });

    it('resolves Silver Lunar 1/2 oz Proof', () => {
      const r = lookupTypeGsid('Australian Lunar Silver 1/2 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(395571);
    });

    it('uses finish hint to resolve Proof', () => {
      const r = lookupTypeGsid('Silver Eagle 1 oz', { finish: 'proof' });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72470);
    });

    it('uses finish hint for Gold Libertad Proof', () => {
      const r = lookupTypeGsid('Gold Libertad 1 oz', { finish: 'proof' });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(393960);
      expect(r.lookupKey).toBe('libertad|1|gold|proof');
    });

    it('uses finish hint for Silver Panda Proof', () => {
      const r = lookupTypeGsid('Silver Panda 1 oz', { finish: 'proof' });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(395448);
    });

    it('uses finish hint for Gold Eagle 1/4 oz Proof', () => {
      const r = lookupTypeGsid('Gold Eagle 1/4 oz', { finish: 'proof' });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(74291);
    });

    it('uses finish hint for Platinum Eagle 1/2 oz Proof', () => {
      const r = lookupTypeGsid('Platinum Eagle 1/2 oz', { finish: 'proof' });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(74283);
    });

    it('uses finish hint for Lunar 1/2 oz Proof', () => {
      const r = lookupTypeGsid('Australian Lunar Silver 1/2 oz', { finish: 'proof' });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(395571);
    });

    it('finish hint is case-insensitive (Proof vs proof)', () => {
      const r = lookupTypeGsid('Silver Eagle 1 oz', { finish: 'Proof' });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72470);
    });

    it('burnished finish falls back to MS (no burnished entries)', () => {
      const r = lookupTypeGsid('Silver Eagle 1 oz', { finish: 'burnished' });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72469); // MS fallback
    });

    it('reverse proof falls back to MS (no RP entries)', () => {
      const r = lookupTypeGsid('Silver Eagle 1 oz', { finish: 'reverse proof' });
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72469); // MS fallback
    });

    it('falls back to MS when proof key does not exist', () => {
      // Gold Buffalo has no proof entry -- should fall back to MS
      const r = lookupTypeGsid('Gold Buffalo 1 oz Proof');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(74456); // MS fallback
    });

    it('returns MS when no proof keyword present', () => {
      // Same query without "Proof" should return MS
      const r = lookupTypeGsid('Silver Eagle 1 oz');
      expect(r).not.toBeNull();
      expect(r.gsid).toBe(72469); // MS
    });
  });
});
