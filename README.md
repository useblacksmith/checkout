# Blacksmith Checkout

> **Beta:** Git checkout caching is currently in beta. Stay on the latest `v1` release while we continue improving reliability and incorporating feedback.

`useblacksmith/checkout` is Blacksmith's fork of [`actions/checkout`](https://github.com/actions/checkout). It is a drop-in replacement that preserves the upstream action's inputs and checkout behavior while adding persistent Git repository caching on Blacksmith runners.

The cache is built on [Blacksmith Sticky Disks](https://docs.blacksmith.sh/blacksmith-caching/dependencies-sticky-disks). Blacksmith runners are ephemeral, but Sticky Disks persist across workflow runs. This lets the action reuse a bare Git mirror instead of downloading every Git object from GitHub for every job.

## Usage

Replace `actions/checkout` with `useblacksmith/checkout@v1`:

```yaml
steps:
  - uses: useblacksmith/checkout@v1
    with:
      fetch-depth: 0
```

All standard [`actions/checkout` inputs](https://github.com/actions/checkout) continue to work. The `v1` tag tracks the latest compatible Blacksmith Checkout release.

## Why use this over the default?

A normal checkout starts from an empty runner and downloads the repository from GitHub for every job. For large repositories or workflows that need substantial Git history, this can add minutes of repeated network transfer to each run.

Blacksmith Checkout keeps Git objects on a Sticky Disk so warm jobs can reuse objects that are already available locally and fetch only what is missing. This is particularly useful for:

- Large repositories with slow clone times
- Workflows that require full history with `fetch-depth: 0`
- Frequently run workflows that can reuse a warm mirror
- Reducing repeated network transfer and exposure to transient GitHub failures or rate limits

Small repositories using shallow checkouts may see performance similar to the upstream action. The first run must also hydrate the mirror, so the benefit is realized on subsequent runs.

## How it works

Each repository checked out by the action gets an isolated Sticky Disk and bare Git mirror. Multiple repositories checked out in the same job do not share a mirror.

### 1. Initial hydration

When no mirror exists, the action creates a full `git clone --mirror` on the Sticky Disk. This initial hydration downloads the complete repository and may take as long as a normal full clone.

Only one job hydrates a mirror at a time. If another job checks out the same repository while hydration is in progress, it falls back to a standard checkout from GitHub for that run rather than waiting.

### 2. Warm checkout

When a mirror already exists, the action mounts its Sticky Disk and uses [Git's alternates mechanism](https://git-scm.com/docs/gitrepository-layout) to make the mirror's objects available to the workspace without copying them.

The workspace then performs the normal upstream-compatible fetch. Objects already present in the mirror are reused locally, while objects that are newer than the mirror are fetched from GitHub. This means a stale mirror does not block checkout or prevent the requested commit from being fetched.

The mirror always contains full history, but the workspace still respects inputs such as `fetch-depth`, `fetch-tags`, sparse checkout, LFS, and submodules. For example, `fetch-depth: 1` still produces a shallow workspace checkout.

### 3. Post-job refresh

The action refreshes an existing mirror with `git fetch --prune` during post-job cleanup, outside the critical checkout path. This prepares the mirror for subsequent workflow runs without delaying the checkout step itself.

Post-job cleanup also runs Git's lightweight automatic garbage collection, flushes pending writes, and safely unmounts the Sticky Disk. An updated disk is persisted only when the workflow and cache maintenance leave it in a safe state. Failed or incomplete cache updates are discarded rather than replacing a healthy mirror.

### 4. Safe fallbacks

If the Blacksmith agent, Sticky Disk, or mirror cannot be prepared, the action falls back to the standard `actions/checkout` behavior. Cache maintenance failures are reported as warnings and do not invalidate the completed workspace checkout.

The caching path can also be disabled by Blacksmith's control plane without requiring customers to change their workflows.

## Containers and Docker-based actions

Container jobs and Docker-based actions that consume a checkout have different requirements.

### Container jobs

Jobs configured with `container:` bypass the Sticky Disk cache by default because the runner's block device is not normally visible inside the container. The checkout still works, but uses the standard upstream behavior.

Advanced users can opt in with `allow-inside-container: true` when the container has been started with the runner's devices passed through, such as with privileged mode and `/dev` mounted:

```yaml
steps:
  - uses: useblacksmith/checkout@v1
    with:
      allow-inside-container: true
```

If the device is still unavailable, the action falls back to a standard checkout.

### Docker-based actions

By default, Blacksmith Checkout writes a Git alternates file into the workspace. That file points to Git objects on the Sticky Disk mounted on the runner. If a later step runs a Docker-based action, its container may receive the workspace but not the Sticky Disk mount. Git commands inside that container can then be unable to resolve objects referenced by the checkout.

Set `dissociate: true` when later Docker-based actions need to run Git commands against the repository:

```yaml
steps:
  - uses: useblacksmith/checkout@v1
    with:
      dissociate: true
```

The action copies the required objects into the workspace and removes its dependency on the mirror mount. This makes the repository self-contained inside later containers at the cost of a slightly longer checkout and a larger workspace.

## Blacksmith-specific inputs

In addition to all upstream `actions/checkout` inputs, this action provides:

| Input | Default | Description |
| --- | --- | --- |
| `dissociate` | `false` | Copies objects from the mirror into the workspace so it no longer depends on the Sticky Disk mount. |
| `allow-inside-container` | `false` | Attempts to use the Sticky Disk cache inside a container job whose runner devices have been passed through. |
| `verbose` | `false` | Enables verbose Git tracing for mirror operations when debugging checkout or cache performance. |

## Documentation

See [Git Checkout Caching](https://docs.blacksmith.sh/blacksmith-caching/git-checkout-caching) for cache lifecycle, storage usage, pricing, monitoring, and troubleshooting.

For the complete input reference and general checkout examples, see the upstream [`actions/checkout` documentation](https://github.com/actions/checkout).

## License

The scripts and documentation in this project are released under the [MIT License](LICENSE).
