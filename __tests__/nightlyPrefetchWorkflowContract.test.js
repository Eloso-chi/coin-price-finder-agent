'use strict';

const fs = require('fs');
const path = require('path');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'nightly-prefetch.yml');

function workflowText() {
  return fs.readFileSync(workflowPath, 'utf8');
}

describe('nightly prefetch workflow contract', () => {
  test('keeps both UTC schedules and gates them to the intended Pacific hour', () => {
    const text = workflowText();
    expect(text).toMatch(/^\s*workflow_dispatch:/m);
    expect(text).toMatch(/^\s*schedule:/m);
    expect(text).toContain("cron: '5 6,7 * * *'");
    expect(text).toContain('TZ=America/Los_Angeles date +%H');
    expect(text).toContain('[ "$PACIFIC_HOUR" != "23" ]');
    expect(text.match(/if: steps\.pacific_gate\.outputs\.should_run == 'true'/g)).toHaveLength(3);
  });

  test('fails when the scheduler result is not completed', () => {
    const text = workflowText();
    expect(text).toContain('if [ "$RUN_STATUS" != "completed" ]');
    expect(text).toContain('::error::Prefetch scheduler finished with status $RUN_STATUS');
    expect(text).toMatch(/if \[ "\$RUN_STATUS" != "completed" \][\s\S]{0,200}exit 1/);
  });

  test('fails instead of masking an unverified polling timeout', () => {
    const text = workflowText();
    expect(text).toContain('::error::Prefetch polling timed out after 30 minutes');
    expect(text).toMatch(/Prefetch polling timed out after 30 minutes[\s\S]{0,300}exit 1/);
  });
});
