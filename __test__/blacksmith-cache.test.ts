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

import * as blacksmithCache from '../src/blacksmith-cache'

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
      const mountPoint = blacksmithCache.getMountPoint(
        'descriptinc',
        'descript'
      )

      expect(mountPoint).toContain('descriptinc')
      expect(mountPoint).toContain('descript')
      expect(mountPoint).toBe('/blacksmith-git-mirror/descriptinc/descript')
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
      const mirrorPath = blacksmithCache.getMirrorPath(
        'descriptinc',
        'descript'
      )

      expect(mirrorPath).toBe(
        '/blacksmith-git-mirror/descriptinc/descript/v1/descriptinc-descript.git'
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

  describe('multiple checkout scenario', () => {
    it('each repo gets isolated paths that do not conflict', () => {
      // Simulate the multiple checkout scenario from the customer issue:
      // 1. First checkout: descriptinc/descript (workflow repo)
      // 2. Second checkout: descriptinc/shared-actions

      const repo1 = {owner: 'descriptinc', repo: 'descript'}
      const repo2 = {owner: 'descriptinc', repo: 'shared-actions'}

      const mountPoint1 = blacksmithCache.getMountPoint(repo1.owner, repo1.repo)
      const mountPoint2 = blacksmithCache.getMountPoint(repo2.owner, repo2.repo)

      const mirrorPath1 = blacksmithCache.getMirrorPath(repo1.owner, repo1.repo)
      const mirrorPath2 = blacksmithCache.getMirrorPath(repo2.owner, repo2.repo)

      // Mount points should be different
      expect(mountPoint1).toBe('/blacksmith-git-mirror/descriptinc/descript')
      expect(mountPoint2).toBe(
        '/blacksmith-git-mirror/descriptinc/shared-actions'
      )
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
