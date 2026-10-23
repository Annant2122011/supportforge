import assert from 'node:assert/strict';
import test from 'node:test';

import { data } from '../src/commands/supportforge';

interface CommandOptionNode {
  name?: string;
  options?: CommandOptionNode[];
}

test('registered /supportforge command stays within Discord nested option limits', () => {
  const command = data.toJSON() as unknown as CommandOptionNode & { name: string };
  assert.equal(command.name, 'supportforge');

  const visit = (node: CommandOptionNode, path: string): void => {
    const options = node.options ?? [];
    assert.ok(
      options.length <= 25,
      path + ' declares ' + options.length + ' options; Discord permits at most 25 at each command/group level.',
    );
    assert.equal(
      new Set(options.map((option) => option.name)).size,
      options.length,
      path + ' contains duplicate sibling option names.',
    );
    for (const option of options) visit(option, path + ' ' + (option.name ?? '<unnamed>'));
  };

  visit(command, '/supportforge');
});
