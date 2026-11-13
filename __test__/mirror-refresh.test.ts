import {
  deferredRefreshSkipReason,
  parseRefreshMirrorInput
} from '../src/mirror-refresh'

describe('deferredRefreshSkipReason', () => {
  it('runs the refresh by default', () => {
    expect(
      deferredRefreshSkipReason({refreshMirror: true, commitEarlyDenyReason: ''})
    ).toBe('')
  })

  it('skips the refresh when the commit is already denied', () => {
    expect(
      deferredRefreshSkipReason({
        refreshMirror: true,
        commitEarlyDenyReason: 'branch protection'
      })
    ).toBe('commit denied for this job (branch protection)')
  })

  it('skips the refresh when the workflow opts out', () => {
    expect(
      deferredRefreshSkipReason({
        refreshMirror: false,
        commitEarlyDenyReason: ''
      })
    ).toBe('refresh-mirror is false')
  })
})

describe('parseRefreshMirrorInput', () => {
  it.each([
    ['', true],
    ['true', true],
    ['TRUE', true],
    ['false', false],
    [' False ', false]
  ])('parses %p as %p', (value, expected) => {
    expect(parseRefreshMirrorInput(value)).toBe(expected)
  })
})
