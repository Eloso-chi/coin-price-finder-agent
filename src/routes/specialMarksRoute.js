'use strict';

const express = require('express');
const {
  SPECIAL_MARKS_REGISTRY_VERSION,
  listApplicableMarks,
  markApplies,
  inferProgramDenomination,
  serializeMark,
} = require('../data/specialMarksRegistry');

const router = express.Router();

router.get('/', (req, res) => {
  const textFields = ['program', 'metal', 'finish', 'mint', 'denomination'];
  if (textFields.some(field => req.query[field] != null
    && (typeof req.query[field] !== 'string' || req.query[field].length > 100))) {
    return res.status(400).json({ error: 'Special-mark lookup context is invalid' });
  }
  if ((req.query.year != null && (typeof req.query.year !== 'string' || !/^\d{4}$/.test(req.query.year)))
    || (req.query.weight != null && (typeof req.query.weight !== 'string'
      || !/^\d{1,3}(?:\.\d{1,6})?$/.test(req.query.weight)
      || Number(req.query.weight) <= 0 || Number(req.query.weight) > 100))) {
    return res.status(400).json({ error: 'Special-mark lookup context is invalid' });
  }
  if (!req.query.program) {
    return res.json({ registryVersion: SPECIAL_MARKS_REGISTRY_VERSION, marks: [] });
  }
  const context = {
    program: req.query.program,
    year: req.query.year,
    metal: req.query.metal,
    weight: req.query.weight,
    finish: req.query.finish,
    mint: req.query.mint,
    denomination: req.query.denomination || inferProgramDenomination(req.query.program, req.query.metal),
  };
  const marks = listApplicableMarks(context)
    .filter(mark => markApplies(mark, context, true))
    .map(serializeMark);
  return res.json({ registryVersion: SPECIAL_MARKS_REGISTRY_VERSION, marks });
});

module.exports = router;
