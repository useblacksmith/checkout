// Mock the gRPC dependencies before importing blacksmith-cache
jest.mock('@connectrpc/connect', () => ({
  createClient: jest.fn(),
  ConnectError: class ConnectError extends Error {},
  Code: {Aborted: 'ABORTED'}
}))

jest.mock('@connectrpc/connect-node', () => ({
  createGrpcTransport: jest.fn()
}))

jest.mock(
  '@buf/blacksmith_vm-agent.connectrpc_es/stickydisk/v1/stickydisk_connect',
  () => ({
    StickyDiskService: {}
  })
)

jest.mock('../src/container-detector', () => ({
  isRunningInContainer: jest.fn(() => false)
}))

import * as blacksmithCache from '../src/blacksmith-cache'
import {isRunningInContainer} from '../src/container-detector'

const mockIsRunningInContainer = isRunningInContainer as jest.MockedFunction<
  typeof isRunningInContainer
>

describe('blacksmith-cache tests', () => {
  describe('getMountPoint', () => {
    it('returns unique mount point for each repository', () => {
      const mountPoint1 = blacksmithCache.getMountPoint('owner1', 'repo1')
      const mountPoint2 = blacksmithCache.getMountPoint('owner1', 'repo2')
      const mountPoint3 = blacksmithCache.getMountPoint('owner2', 'repo1')

      // Each should be unique
      expect(mountPoint1).not.toBe(mountPoint2)
      expect(mountPoint1).not.toBe(mountPoint3)
      expect(mountPoint2).not.toBe(mountPoint3)
    })

    it('returns consistent mount point for same repository', () => {
      const mountPoint1 = blacksmithCache.getMountPoint('myorg', 'myrepo')
      const mountPoint2 = blacksmithCache.getMountPoint('myorg', 'myrepo')

      expect(mountPoint1).toBe(mountPoint2)
    })

    it('includes owner and repo in mount point path', () => {
      const mountPoint = blacksmithCache.getMountPoint('testorg', 'bigrepo')

      expect(mountPoint).toContain('testorg')
      expect(mountPoint).toContain('bigrepo')
      expect(mountPoint).toBe('/blacksmith-git-mirror/testorg/bigrepo')
    })

    it('avoids collisions from hyphenated names', () => {
      // These would collide with a flat naming scheme like -owner-repo
      // but are unique with directory structure /owner/repo
      const mountPoint1 = blacksmithCache.getMountPoint('foo-bar', 'baz')
      const mountPoint2 = blacksmithCache.getMountPoint('foo', 'bar-baz')

      expect(mountPoint1).toBe('/blacksmith-git-mirror/foo-bar/baz')
      expect(mountPoint2).toBe('/blacksmith-git-mirror/foo/bar-baz')
      expect(mountPoint1).not.toBe(mountPoint2)
    })
  })

  describe('getMirrorPath', () => {
    it('returns path under the unique mount point', () => {
      const mirrorPath = blacksmithCache.getMirrorPath('myorg', 'myrepo')
      const mountPoint = blacksmithCache.getMountPoint('myorg', 'myrepo')

      expect(mirrorPath.startsWith(mountPoint)).toBe(true)
    })

    it('returns unique mirror paths for different repositories', () => {
      const mirrorPath1 = blacksmithCache.getMirrorPath('owner1', 'repo1')
      const mirrorPath2 = blacksmithCache.getMirrorPath('owner1', 'repo2')
      const mirrorPath3 = blacksmithCache.getMirrorPath('owner2', 'repo1')

      // Each should be unique
      expect(mirrorPath1).not.toBe(mirrorPath2)
      expect(mirrorPath1).not.toBe(mirrorPath3)
      expect(mirrorPath2).not.toBe(mirrorPath3)
    })

    it('includes version directory in path', () => {
      const mirrorPath = blacksmithCache.getMirrorPath('myorg', 'myrepo')

      expect(mirrorPath).toContain('/v1/')
    })

    it('ends with .git extension', () => {
      const mirrorPath = blacksmithCache.getMirrorPath('myorg', 'myrepo')

      expect(mirrorPath).toMatch(/\.git$/)
    })

    it('returns expected full path format', () => {
      const mirrorPath = blacksmithCache.getMirrorPath('testorg', 'bigrepo')

      expect(mirrorPath).toBe(
        '/blacksmith-git-mirror/testorg/bigrepo/v1/testorg-bigrepo.git'
      )
    })
  })

  describe('isBlacksmithEnvironment', () => {
    const originalEnv = process.env

    beforeEach(() => {
      jest.resetModules()
      process.env = {...originalEnv}
    })

    afterAll(() => {
      process.env = originalEnv
    })

    it('returns true when BLACKSMITH_VM_ID is set', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      expect(blacksmithCache.isBlacksmithEnvironment()).toBe(true)
    })

    it('returns false when BLACKSMITH_VM_ID is not set', () => {
      delete process.env['BLACKSMITH_VM_ID']
      expect(blacksmithCache.isBlacksmithEnvironment()).toBe(false)
    })

    it('returns false when BLACKSMITH_VM_ID is empty string', () => {
      process.env['BLACKSMITH_VM_ID'] = ''
      expect(blacksmithCache.isBlacksmithEnvironment()).toBe(false)
    })
  })

  describe('shouldUseBlacksmithCache', () => {
    const originalEnv = process.env

    beforeEach(() => {
      jest.resetModules()
      process.env = {...originalEnv}
      process.env['BLACKSMITH_AGENT_ADDR'] = '192.168.127.1'
      process.env['BLACKSMITH_STICKY_DISK_GRPC_PORT'] = '5557'
      mockIsRunningInContainer.mockReturnValue(false)
    })

    afterAll(() => {
      process.env = originalEnv
    })

    it('returns true when in Blacksmith env and kill switch is unset', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      delete process.env['BLACKSMITH_BYPASS_CHECKOUT']
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(true)
    })

    it('returns false outside of a Blacksmith env regardless of kill switch', () => {
      delete process.env['BLACKSMITH_VM_ID']
      process.env['BLACKSMITH_BYPASS_CHECKOUT'] = 'true'
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(false)
    })

    it('returns false when BLACKSMITH_AGENT_ADDR is not set', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      delete process.env['BLACKSMITH_AGENT_ADDR']
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(false)
    })

    it('returns false when BLACKSMITH_STICKY_DISK_GRPC_PORT is not set', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      delete process.env['BLACKSMITH_STICKY_DISK_GRPC_PORT']
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(false)
    })

    it('returns false when BLACKSMITH_BYPASS_CHECKOUT=true (control-plane kill switch)', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      process.env['BLACKSMITH_BYPASS_CHECKOUT'] = 'true'
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(false)
    })

    it('returns true when BLACKSMITH_BYPASS_CHECKOUT is any value other than "true"', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      process.env['BLACKSMITH_BYPASS_CHECKOUT'] = 'false'
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(true)

      process.env['BLACKSMITH_BYPASS_CHECKOUT'] = '1'
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(true)

      process.env['BLACKSMITH_BYPASS_CHECKOUT'] = ''
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(true)
    })

    it('returns false when running inside a container', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      delete process.env['BLACKSMITH_BYPASS_CHECKOUT']
      mockIsRunningInContainer.mockReturnValue(true)
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(false)
    })

    it('returns true inside a container when allow-inside-container input is true', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      process.env['INPUT_ALLOW-INSIDE-CONTAINER'] = 'true'
      mockIsRunningInContainer.mockReturnValue(true)
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(true)
    })

    it('returns true inside a container when BLACKSMITH_ALLOW_INSIDE_CONTAINER=true', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      process.env['BLACKSMITH_ALLOW_INSIDE_CONTAINER'] = 'true'
      mockIsRunningInContainer.mockReturnValue(true)
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(true)
    })

    it('returns false inside a container when opt-in values are not "true"', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      process.env['INPUT_ALLOW-INSIDE-CONTAINER'] = 'false'
      process.env['BLACKSMITH_ALLOW_INSIDE_CONTAINER'] = '1'
      mockIsRunningInContainer.mockReturnValue(true)
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(false)
    })

    it('container opt-in still honors the BLACKSMITH_BYPASS_CHECKOUT kill switch', () => {
      process.env['BLACKSMITH_VM_ID'] = 'test-vm-id'
      process.env['BLACKSMITH_BYPASS_CHECKOUT'] = 'true'
      process.env['INPUT_ALLOW-INSIDE-CONTAINER'] = 'true'
      mockIsRunningInContainer.mockReturnValue(true)
      expect(blacksmithCache.shouldUseBlacksmithCache()).toBe(false)
    })
  })

  describe('isAllowedInsideContainer', () => {
    const originalEnv = process.env

    beforeEach(() => {
      jest.resetModules()
      process.env = {...originalEnv}
      delete process.env['INPUT_ALLOW-INSIDE-CONTAINER']
      delete process.env['BLACKSMITH_ALLOW_INSIDE_CONTAINER']
    })

    afterAll(() => {
      process.env = originalEnv
    })

    it('defaults to false', () => {
      expect(blacksmithCache.isAllowedInsideContainer()).toBe(false)
    })

    it('is case-insensitive for the action input', () => {
      process.env['INPUT_ALLOW-INSIDE-CONTAINER'] = 'True'
      expect(blacksmithCache.isAllowedInsideContainer()).toBe(true)
    })

    it('is case-insensitive for the environment variable', () => {
      process.env['BLACKSMITH_ALLOW_INSIDE_CONTAINER'] = 'TRUE'
      expect(blacksmithCache.isAllowedInsideContainer()).toBe(true)
    })
  })

  describe('diffMirrorRefs', () => {
    const shaA = 'a'.repeat(40)
    const shaB = 'b'.repeat(40)
    const shaC = 'c'.repeat(40)

    it('returns no changes when local refs match the remote', () => {
      const lsRemote = `${shaA}\trefs/heads/main\n${shaB}\trefs/tags/v1\n`
      const local = `${shaA} refs/heads/main\n${shaB} refs/tags/v1\n`
      const diff = blacksmithCache.diffMirrorRefs(lsRemote, local)
      expect(diff.updatedRefSpecs).toEqual([])
      expect(diff.deletedRefs).toEqual([])
      expect(diff.remoteRefCount).toBe(2)
    })

    it('detects moved and new refs', () => {
      const lsRemote = `${shaB}\trefs/heads/main\n${shaC}\trefs/heads/feature\n`
      const local = `${shaA} refs/heads/main\n`
      const diff = blacksmithCache.diffMirrorRefs(lsRemote, local)
      expect(diff.updatedRefSpecs.sort()).toEqual([
        '+refs/heads/feature:refs/heads/feature',
        '+refs/heads/main:refs/heads/main'
      ])
      expect(diff.deletedRefs).toEqual([])
    })

    it('uses old tips of changed refs as negotiation tips', () => {
      const lsRemote = `${shaB}\trefs/heads/main\n${shaC}\trefs/heads/feature\n`
      const local = `${shaA} refs/heads/main\n`
      const diff = blacksmithCache.diffMirrorRefs(lsRemote, local)
      expect(diff.negotiationTips).toEqual([shaA])
    })

    it('falls back to the default branch tip when all changed refs are new', () => {
      const lsRemote = `${shaA}\trefs/heads/main\n${shaC}\trefs/heads/feature\n`
      const local = `${shaA} refs/heads/main\n`
      const diff = blacksmithCache.diffMirrorRefs(lsRemote, local)
      expect(diff.updatedRefSpecs).toEqual([
        '+refs/heads/feature:refs/heads/feature'
      ])
      expect(diff.negotiationTips).toEqual([shaA])
    })

    it('detects refs deleted on the remote', () => {
      const lsRemote = `${shaA}\trefs/heads/main\n`
      const local = `${shaA} refs/heads/main\n${shaB} refs/heads/gone\n`
      const diff = blacksmithCache.diffMirrorRefs(lsRemote, local)
      expect(diff.updatedRefSpecs).toEqual([])
      expect(diff.deletedRefs).toEqual(['refs/heads/gone'])
    })

    it('ignores peeled annotated tag entries', () => {
      const lsRemote = `${shaA}\trefs/tags/v1\n${shaB}\trefs/tags/v1^{}\n`
      const local = `${shaA} refs/tags/v1\n`
      const diff = blacksmithCache.diffMirrorRefs(lsRemote, local)
      expect(diff.updatedRefSpecs).toEqual([])
      expect(diff.deletedRefs).toEqual([])
      expect(diff.remoteRefCount).toBe(1)
    })

    it('handles empty inputs', () => {
      const diff = blacksmithCache.diffMirrorRefs('', '')
      expect(diff.updatedRefSpecs).toEqual([])
      expect(diff.deletedRefs).toEqual([])
      expect(diff.remoteRefCount).toBe(0)
    })

    it('marks local refs missing from the advertisement as deletions', () => {
      const lsRemote = `${shaA}\trefs/heads/main\n`
      const local = `${shaA} refs/heads/main\n${shaB} refs/heads/gone\n${shaC} refs/tags/v0.1\n`
      const diff = blacksmithCache.diffMirrorRefs(lsRemote, local)
      expect(diff.updatedRefSpecs).toEqual([])
      expect(diff.deletedRefs.sort()).toEqual([
        'refs/heads/gone',
        'refs/tags/v0.1'
      ])
    })
  })

  describe('mapMirrorRefToWorkspace', () => {
    it('maps branches to remote-tracking refs', () => {
      expect(
        blacksmithCache.mapMirrorRefToWorkspace('refs/heads/feature/x')
      ).toBe('refs/remotes/origin/feature/x')
    })

    it('keeps tags as tags', () => {
      expect(blacksmithCache.mapMirrorRefToWorkspace('refs/tags/v1.2')).toBe(
        'refs/tags/v1.2'
      )
    })

    it('skips other refs', () => {
      expect(
        blacksmithCache.mapMirrorRefToWorkspace('refs/pull/12/merge')
      ).toBeNull()
    })
  })

  describe('buildRefCopyInstructions', () => {
    const shaA = 'a'.repeat(40)
    const shaB = 'b'.repeat(40)
    const shaC = 'c'.repeat(40)

    it('updates all mirror heads and tags into an empty workspace', () => {
      const mirror = `${shaA} refs/heads/main\n${shaB} refs/tags/v1\n`
      expect(blacksmithCache.buildRefCopyInstructions(mirror, '')).toEqual([
        `update refs/remotes/origin/main ${shaA}`,
        `update refs/tags/v1 ${shaB}`
      ])
    })

    it('deletes workspace refs no longer in the mirror (prune)', () => {
      const mirror = `${shaA} refs/heads/main\n`
      const workspace = `${shaA} refs/remotes/origin/main\n${shaB} refs/remotes/origin/gone\n${shaC} refs/tags/v0\n`
      expect(
        blacksmithCache.buildRefCopyInstructions(mirror, workspace)
      ).toEqual(['delete refs/remotes/origin/gone', 'delete refs/tags/v0'])
    })

    it('skips refs already at the desired value and updates changed ones', () => {
      const mirror = `${shaA} refs/heads/main\n${shaB} refs/heads/dev\n`
      const workspace = `${shaA} refs/remotes/origin/main\n${shaC} refs/remotes/origin/dev\n`
      expect(
        blacksmithCache.buildRefCopyInstructions(mirror, workspace)
      ).toEqual([`update refs/remotes/origin/dev ${shaB}`])
    })

    it('does not copy or delete non-branch non-tag refs', () => {
      const mirror = `${shaA} refs/heads/main\n${shaB} refs/pull/1/merge\n`
      const workspace = `${shaC} refs/heads/local-branch\n`
      expect(
        blacksmithCache.buildRefCopyInstructions(mirror, workspace)
      ).toEqual([`update refs/remotes/origin/main ${shaA}`])
    })

    it('handles empty inputs', () => {
      expect(blacksmithCache.buildRefCopyInstructions('', '')).toEqual([])
    })

    it('never deletes or rewrites symbolic refs like origin/HEAD', () => {
      const mirror = `${shaA} refs/heads/main\n`
      const workspace =
        `${shaA} refs/remotes/origin/HEAD refs/remotes/origin/main\n` +
        `${shaA} refs/remotes/origin/main\n`
      expect(
        blacksmithCache.buildRefCopyInstructions(mirror, workspace)
      ).toEqual([])
    })

    it('still updates the branch behind a symbolic ref', () => {
      const mirror = `${shaB} refs/heads/main\n`
      const workspace =
        `${shaA} refs/remotes/origin/HEAD refs/remotes/origin/main\n` +
        `${shaA} refs/remotes/origin/main\n`
      expect(
        blacksmithCache.buildRefCopyInstructions(mirror, workspace)
      ).toEqual([`update refs/remotes/origin/main ${shaB}`])
    })
  })

  describe('buildPackedRefsContent', () => {
    const shaA = 'a'.repeat(40)
    const shaB = 'b'.repeat(40)
    const shaC = 'c'.repeat(40)

    it('maps heads and tags and byte-sorts by refname', () => {
      const mirror = `${shaB} refs/tags/v1\n${shaA} refs/heads/main\n${shaC} refs/heads/dev\n`
      expect(blacksmithCache.buildPackedRefsContent(mirror)).toBe(
        '# pack-refs with: sorted\n' +
          `${shaC} refs/remotes/origin/dev\n` +
          `${shaA} refs/remotes/origin/main\n` +
          `${shaB} refs/tags/v1\n`
      )
    })

    it('skips refs outside heads and tags', () => {
      const mirror = `${shaA} refs/heads/main\n${shaB} refs/pull/1/merge\n`
      expect(blacksmithCache.buildPackedRefsContent(mirror)).toBe(
        `# pack-refs with: sorted\n${shaA} refs/remotes/origin/main\n`
      )
    })

    it('handles empty input', () => {
      expect(blacksmithCache.buildPackedRefsContent('')).toBe(
        '# pack-refs with: sorted\n'
      )
    })
  })

  describe('shallowNegotiationTipRefs', () => {
    it('offers the same branch then HEAD', () => {
      expect(
        blacksmithCache.shallowNegotiationTipRefs('refs/heads/feature', '')
      ).toEqual(['refs/heads/feature', 'HEAD'])
    })

    it('offers the same tag then HEAD', () => {
      expect(
        blacksmithCache.shallowNegotiationTipRefs('refs/tags/v1', 'main')
      ).toEqual(['refs/tags/v1', 'HEAD'])
    })

    it('offers the base branch for pull request refs', () => {
      expect(
        blacksmithCache.shallowNegotiationTipRefs('refs/pull/42/merge', 'main')
      ).toEqual(['refs/heads/main', 'HEAD'])
      expect(
        blacksmithCache.shallowNegotiationTipRefs(
          'refs/pull/42/head',
          'refs/heads/release'
        )
      ).toEqual(['refs/heads/release', 'HEAD'])
    })

    it('falls back to HEAD for pull request refs without a base and for bare SHAs', () => {
      expect(
        blacksmithCache.shallowNegotiationTipRefs('refs/pull/42/merge', '')
      ).toEqual(['HEAD'])
      expect(blacksmithCache.shallowNegotiationTipRefs('', '')).toEqual([
        'HEAD'
      ])
    })

    it('tries both branch and tag for an unqualified ref', () => {
      expect(blacksmithCache.shallowNegotiationTipRefs('v1', '')).toEqual([
        'refs/heads/v1',
        'refs/tags/v1',
        'HEAD'
      ])
    })
  })

  describe('parseMissingRemoteRefs', () => {
    it('extracts a single missing ref', () => {
      const stderr =
        "fatal: couldn't find remote ref refs/heads/trunk-temp/pr-41568/f00ba4"
      expect(blacksmithCache.parseMissingRemoteRefs(stderr)).toEqual([
        'refs/heads/trunk-temp/pr-41568/f00ba4'
      ])
    })

    it('extracts multiple missing refs across lines', () => {
      const stderr = [
        "fatal: couldn't find remote ref refs/heads/a",
        'error: some other line',
        "fatal: couldn't find remote ref refs/tags/b"
      ].join('\n')
      expect(blacksmithCache.parseMissingRemoteRefs(stderr)).toEqual([
        'refs/heads/a',
        'refs/tags/b'
      ])
    })

    it('returns empty for unrelated errors', () => {
      expect(
        blacksmithCache.parseMissingRemoteRefs(
          'fatal: unable to access remote: 403'
        )
      ).toEqual([])
      expect(blacksmithCache.parseMissingRemoteRefs('')).toEqual([])
    })
  })

  describe('multiple checkout scenario', () => {
    it('each repo gets isolated paths that do not conflict', () => {
      // Simulate the multiple checkout scenario from the customer issue:
      // 1. First checkout: testorg/bigrepo (workflow repo)
      // 2. Second checkout: testorg/shared-actions

      const repo1 = {owner: 'testorg', repo: 'bigrepo'}
      const repo2 = {owner: 'testorg', repo: 'shared-actions'}

      const mountPoint1 = blacksmithCache.getMountPoint(repo1.owner, repo1.repo)
      const mountPoint2 = blacksmithCache.getMountPoint(repo2.owner, repo2.repo)

      const mirrorPath1 = blacksmithCache.getMirrorPath(repo1.owner, repo1.repo)
      const mirrorPath2 = blacksmithCache.getMirrorPath(repo2.owner, repo2.repo)

      // Mount points should be different
      expect(mountPoint1).toBe('/blacksmith-git-mirror/testorg/bigrepo')
      expect(mountPoint2).toBe('/blacksmith-git-mirror/testorg/shared-actions')
      expect(mountPoint1).not.toBe(mountPoint2)

      // Mirror paths should be under their respective mount points
      expect(mirrorPath1.startsWith(mountPoint1)).toBe(true)
      expect(mirrorPath2.startsWith(mountPoint2)).toBe(true)

      // Mirror paths should not overlap
      expect(mirrorPath1.startsWith(mountPoint2)).toBe(false)
      expect(mirrorPath2.startsWith(mountPoint1)).toBe(false)
    })
  })
})
