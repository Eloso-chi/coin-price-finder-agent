'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CUSTOMIZATION_DIRS = [
  path.join(ROOT, '.github', 'agents'),
  path.join(ROOT, '.github', 'prompts'),
];
const CONCRETE_TOOL_IDS = [
  'read_file',
  'grep_search',
  'file_search',
  'semantic_search',
  'list_dir',
  'run_in_terminal',
  'get_terminal_output',
  'get_errors',
  'manage_todo_list',
  'runSubagent',
  'replace_string_in_file',
  'multi_replace_string_in_file',
  'create_file',
];

function customizationFiles() {
  return CUSTOMIZATION_DIRS.flatMap(directory => fs.readdirSync(directory)
    .filter(file => file.endsWith('.agent.md') || file.endsWith('.prompt.md'))
    .map(file => path.join(directory, file)));
}

function frontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : '';
}

describe('agent customization contract', () => {
  test.each(customizationFiles())('%s uses supported tool capability aliases', file => {
    const metadata = frontmatter(fs.readFileSync(file, 'utf8'));
    for (const toolId of CONCRETE_TOOL_IDS) {
      expect(metadata).not.toMatch(new RegExp(`(^|[\\s,[\\]])${toolId}($|[\\s,\\]])`, 'm'));
    }
  });

  test.each(customizationFiles().filter(file => file.endsWith('.prompt.md')))(
    '%s uses current prompt agent frontmatter',
    file => {
      const metadata = frontmatter(fs.readFileSync(file, 'utf8'));
      expect(metadata).not.toMatch(/^mode:/m);
    },
  );

  test('/review-deep owns non-recursive specialist orchestration', () => {
    const prompt = fs.readFileSync(
      path.join(ROOT, '.github', 'prompts', 'review-deep.prompt.md'),
      'utf8',
    );
    const primaryReviewer = fs.readFileSync(
      path.join(ROOT, '.github', 'agents', 'code-reviewer.approval-gated.agent.md'),
      'utf8',
    );

    expect(frontmatter(prompt)).toContain('agent: agent');
    expect(frontmatter(prompt)).toContain('agent]');
    expect(prompt).toContain('Code Reviewer (Approval-Gated)');
    expect(prompt).toContain('Security Reviewer');
    expect(prompt).toContain('Performance Reviewer');
    expect(primaryReviewer).not.toContain('runSubagent');
    expect(primaryReviewer).not.toContain('security-review.sub');
    expect(primaryReviewer).not.toContain('performance-review.sub');
  });

  test('INC-017 workflow gates stay aligned across canonical surfaces', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'skills', 'workflow', 'SKILL.md'), 'utf8');
    const preCommit = fs.readFileSync(path.join(ROOT, '.github', 'agents', 'pre-commit-reviewer.agent.md'), 'utf8');
    const instructions = fs.readFileSync(path.join(ROOT, '.github', 'copilot-instructions.md'), 'utf8');
    const contributing = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');
    const prTemplate = fs.readFileSync(path.join(ROOT, '.github', 'pull_request_template.md'), 'utf8');
    const inventory = fs.readFileSync(path.join(ROOT, 'docs', 'memory', 'agents-and-prompts.md'), 'utf8');
    const onboard = fs.readFileSync(path.join(ROOT, '.github', 'agents', 'onboard.agent.md'), 'utf8');
    const ledger = fs.readFileSync(path.join(ROOT, 'docs', 'WASTE-LEDGER.md'), 'utf8');

    const allSurfaces = [workflow, preCommit, instructions, contributing, prTemplate, inventory, onboard];
    for (const content of allSurfaces) {
      expect(content).toMatch(/Onboard acceptance|Onboard agent[\s\S]{0,80}acceptance|Onboard PASS/i);
      expect(content).toMatch(/required CI|CI checks/i);
    }
    for (const content of [workflow, preCommit, instructions, contributing, prTemplate, inventory]) {
      expect(content).toMatch(/material|contract-affecting/i);
      expect(content).toMatch(/architecture/i);
      expect(content).toMatch(/API/i);
      expect(content).toMatch(/operations/i);
      expect(content).toMatch(/environment/i);
      expect(content).toMatch(/agent|customization/i);
      expect(content).toMatch(/user-facing\s+workflow/i);
      expect(content).toMatch(/current commit|that commit|exact commit|newly created commit/i);
      expect(content).toMatch(/no-impact exemption/i);
      expect(content).toMatch(/complete(?:s|d)? successfully/i);
    }
    expect(workflow).toContain('Documentation Coverage (BLOCK');
    expect(workflow).toContain('user-facing');
    expect(workflow).toContain('current commit');
    expect(workflow).toContain('no-impact exemption');
    expect(workflow).toContain('gh pr checks <N> --watch');
    expect(workflow.indexOf('### 4. Commit')).toBeLessThan(workflow.indexOf('### 5. Post-commit Onboard acceptance'));
    expect(inventory).toMatch(/10\. Complete post-merge bookkeeping/);
    expect(workflow).not.toContain('gh pr merge <N> --admin --merge --delete-branch');
    expect(workflow).toContain('`--admin` is\nnot the default'.replace('\\n', '\n'));
    expect(preCommit).toContain('Documentation Coverage (BLOCK if missing)');
    expect(preCommit).toContain('user-facing workflows');
    expect(preCommit).toMatch(/current commit|newly created commit/);
    expect(preCommit).toContain('reviewer-approved no-impact exemption');
    expect(preCommit).toContain('WASTE-LEDGER Support Evidence (BLOCK if incomplete)');
    expect(ledger).toContain('Every required CI check MUST complete successfully before merge');
    expect(ledger).not.toMatch(/CI checks MUST[\s\S]{0,120}emergency exception/i);
    expect(instructions).toContain('user-facing workflows');
    expect(contributing).toContain('user-facing workflows');
    expect(prTemplate).toContain('current commit');
    expect(prTemplate).toContain('reviewer-approved no-impact exemption');
    for (const content of [workflow, preCommit, instructions, contributing, prTemplate, inventory]) {
      expect(content).toContain('--admin');
      expect(content).toMatch(/explicit(?:ly)?(?: user)? approval|user explicitly approves/i);
      expect(content).toMatch(/documented reason|record the reason/i);
    }
  });

  test('support-ready WASTE-LEDGER schemas and privacy rules stay synchronized', () => {
    const ledger = fs.readFileSync(path.join(ROOT, 'docs', 'WASTE-LEDGER.md'), 'utf8');
    const processSkill = fs.readFileSync(path.join(ROOT, '.github', 'skills', 'process-discipline', 'SKILL.md'), 'utf8');
    const preCommit = fs.readFileSync(path.join(ROOT, '.github', 'agents', 'pre-commit-reviewer.agent.md'), 'utf8');
    const prTemplate = fs.readFileSync(path.join(ROOT, '.github', 'pull_request_template.md'), 'utf8');

    const requiredFields = [
      'Date / UTC window', 'Category', 'Attribution', 'Rule(s) violated',
      'Root cause', 'Impact', 'Mistakes', 'PR / commit evidence',
      'Session evidence', 'Workflow evidence', 'Rework inventory', 'Measured usage',
      'Estimated usage', 'Cost calculation', 'User attention', 'Total (direct cost)',
      'Billing review request', 'Evidence confidence', 'Resolution', 'Rules added / enforcement',
      'Support case status',
    ];
    function schemaFields(content, heading, endHeading) {
      const section = content.split(heading)[1].split(endHeading)[0].replaceAll('**', '');
      return [...section.matchAll(/^\| ([^|]+?) \|/gm)]
        .map(match => match[1].trim())
        .filter(field => field !== 'Field' && field !== '-------');
    }
    const ledgerFields = schemaFields(ledger, '### Support-ready incident template', '### Anti-bot incident template');
    const skillFields = schemaFields(processSkill, '### INC-NNN: <Short Title>', '```');
    expect(ledgerFields).toEqual(skillFields);
    expect(ledgerFields).toEqual(requiredFields);

    const incidentSection = ledger.split('### INC-017:')[1].split('## Summary')[0].replaceAll('**', '');
    const incidentFields = [...incidentSection.matchAll(/^\| ([^|]+?) \|/gm)]
      .map(match => match[1].trim())
      .filter(field => field !== 'Field' && field !== '-------');
    expect(incidentFields).toEqual(requiredFields);

    const testSource = fs.readFileSync(__filename, 'utf8');
    const privacySurfaces = [ledger, processSkill, preCommit, prTemplate];
    for (const content of privacySurfaces) {
      expect(content).toContain('.local/github-support/INC-NNN.txt');
      expect(content).toMatch(/public-safe/i);
      for (const prohibited of [
        '\\bcredentials\\b', '\\bcookies\\b', '\\bsigned\\s+URLs?\\b',
        '\\bemails?\\b', '\\bIPs?\\b', '\\blocal\\s+user\\s+paths?\\b',
        '\\braw\\s+prompts?\\b', '\\btranscripts?\\b',
        '\\bbilling/account\\s+IDs?\\b', '\\bfull\\s+session(?:\\s+UUID|\\s+IDs?)?\\b',
        '\\bfull\\s+support[- ]case(?:\\s+IDs?)?\\b',
      ]) {
        expect(content).toMatch(new RegExp(prohibited, 'i'));
      }
    }
    expect(ledger).toContain('Copy/paste GitHub Support summary');
    expect(processSkill).toContain('Copy/paste GitHub Support summary');
    const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
    for (const content of [...privacySurfaces, testSource]) {
      expect(content).not.toMatch(uuidPattern);
    }
  });
});