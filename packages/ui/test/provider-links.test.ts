import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerEntityUrl } from '../../../shared/provider-links.ts';

for (const source of [{ kind: 'github', host: 'github.com' }, { kind: 'gitlab', host: 'gitlab.example.test:8443' }]) {
  const base = `https://${source.host}/team/project`;
  const gl = source.kind === 'gitlab';
  test(`${source.kind}: every addressable entity`, () => {
    const build = (entity: Parameters<typeof providerEntityUrl>[1]) => providerEntityUrl(source, { projectPath: 'team/project', ...entity });
    assert.equal(build({ kind: 'source' }), `https://${source.host}/`);
    assert.equal(build({ kind: 'label', label: 'type::bug' }), `${base}/${gl ? '-/issues?label_name%5B%5D=type%3A%3Abug' : 'issues?q=label%3A%22type%3A%3Abug%22'}`);
    assert.equal(build({ kind: 'repo' }), base);
    assert.equal(build({ kind: 'profile', username: 'contributor' }), `https://${source.host}/contributor`);
    assert.equal(build({ kind: 'issue', iid: 7 }), `${base}/${gl ? '-/issues' : 'issues'}/7`);
    assert.equal(build({ kind: 'change_request', iid: 8 }), `${base}/${gl ? '-/merge_requests' : 'pull'}/8`);
    assert.equal(build({ kind: 'commit', sha: 'abcdef123456' }), `${base}/${gl ? '-/commit' : 'commit'}/abcdef123456`);
    assert.equal(build({ kind: 'branch', ref: 'feature/links' }), `${base}/${gl ? '-/tree' : 'tree'}/feature%2Flinks`);
    assert.equal(build({ kind: 'tag', ref: 'refs/tags/v1' }), `${base}/${gl ? '-/tree' : 'tree'}/v1`);
    assert.equal(build({ kind: 'workflow_run', iid: 9 }), `${base}/${gl ? '-/pipelines' : 'actions/runs'}/9`);
    assert.equal(build({ kind: 'file', ref: 'abcdef123456', path: 'src/link.ts' }), `${base}/${gl ? '-/blob' : 'blob'}/abcdef123456/src/link.ts`);
    assert.equal(build({ kind: 'directory', ref: 'abcdef123456', path: 'src' }), `${base}/${gl ? '-/tree' : 'tree'}/abcdef123456/src`);
    assert.equal(build({ kind: 'directory', ref: 'abcdef123456', path: '.' }), `${base}/${gl ? '-/tree' : 'tree'}/abcdef123456`);
    assert.equal(build({ kind: 'review', url: `${base}/review-permalink#review-1` }), `${base}/review-permalink#review-1`);
    assert.equal(build({ kind: 'comment', url: `${base}/comment-permalink#comment-1` }), `${base}/comment-permalink#comment-1`);
    assert.equal(build({ kind: 'review', iid: 8 }), null);
    assert.equal(build({ kind: 'comment', iid: 8 }), null);
  });
}

test('exact URLs win; missing and unsafe data remain unlinked', () => {
  const source = { kind: 'gitlab', host: 'gitlab.example.test' };
  assert.equal(providerEntityUrl(source, { kind: 'repo', projectPath: 'group/sub/project' }), 'https://gitlab.example.test/group/sub/project');
  assert.equal(providerEntityUrl(source, { kind: 'profile', username: 'bot[bot]', url: 'https://github.com/apps/example' }), 'https://github.com/apps/example');
  assert.equal(providerEntityUrl(source, { kind: 'issue', iid: 0, projectPath: 'a/b' }), null);
  assert.equal(providerEntityUrl(source, { kind: 'commit', sha: '000000', projectPath: 'a/b' }), null);
  assert.equal(providerEntityUrl(source, { kind: 'repo', projectPath: 'a/../b' }), null);
  assert.equal(providerEntityUrl(source, { kind: 'profile', username: 'Display Name' }), null);
  assert.equal(providerEntityUrl(null, { kind: 'repo', projectPath: 'a/b' }), null);
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'mailto:person@example.test', 'https://name:password@example.test/path']) {
    assert.equal(providerEntityUrl(null, { kind: 'comment', url }), null);
  }
});
