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
});