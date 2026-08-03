# Blacksmith Checkout

> **Beta:** Git checkout caching is currently in beta. Stay on the latest `v1` release while we continue improving reliability and incorporating feedback.

`useblacksmith/checkout` is Blacksmith's fork of [`actions/checkout`](https://github.com/actions/checkout). It is a drop-in replacement that supports the same inputs and checkout behavior while adding persistent Git repository caching for Blacksmith runners.

The action is built on [Blacksmith Sticky Disks](https://docs.blacksmith.sh/blacksmith-caching/dependencies-sticky-disks). Instead of cloning the entire repository from GitHub on every workflow run, it maintains a persistent bare Git mirror and updates that mirror incrementally.

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

Blacksmith Checkout keeps the repository's Git objects on a Sticky Disk so later jobs only need to fetch changes made since the previous run. This is particularly useful for:

- Large repositories with slow clone times
- Workflows that require full history with `fetch-depth: 0`
- Frequently run workflows that can reuse a warm mirror
- Reducing network transfers and exposure to transient GitHub failures or rate limits

Small repositories using shallow checkouts may see performance similar to the upstream action.

## How It Works

Blacksmith runners are ephemeral, but Sticky Disks persist data across workflow runs. Blacksmith Checkout uses that persistent storage to maintain a bare Git mirror for the repository.

### 1. Initial Hydration

On the first run, the action creates a full `git clone --mirror` of the repository on a Sticky Disk. This hydration downloads the complete repository and may take as long as a normal full clone, but it only needs to happen once while the cache remains active.

### 2. Incremental Updates

On subsequent runs, the action updates the mirror with `git fetch --prune`. Only new refs and objects are fetched from GitHub rather than downloading the complete repository again.

The mirror always contains the complete repository, while the workspace still respects inputs such as `fetch-depth`. For example, `fetch-depth: 1` continues to produce a shallow workspace checkout.

### 3. Workspace Checkout

The workspace uses [Git's alternates mechanism](https://git-scm.com/docs/gitrepository-layout) to reference objects in the mirror without copying them. This keeps the workspace checkout fast and avoids duplicating the full repository on disk.

### 4. Concurrent Jobs and Safe Fallbacks

If another job starts while the mirror is being hydrated, it automatically falls back to the standard checkout behavior rather than waiting for hydration to finish.

The same fallback applies if the Sticky Disk or cached mirror is unavailable. Cache failures do not fail the workflow. The affected run simply clones from GitHub as it would with the upstream action.

Git garbage collection runs during post-job cleanup rather than during checkout, keeping cache maintenance off the critical path for the rest of the workflow.

## Docker-Based Actions

By default, the workspace references Git objects stored on the Sticky Disk mount. Docker-based actions may not have access to that mount.

Set `dissociate: true` to copy the required objects into the workspace and make the checkout self-contained:

```yaml
steps:
  - uses: useblacksmith/checkout@v1
    with:
      dissociate: true
```

This makes the repository available without the mirror mount at the cost of a slightly longer checkout and a larger workspace.

## Cache Lifecycle and Monitoring

Git mirror caches are automatically evicted after seven days of inactivity. Each workflow run that uses the mirror resets its last-used timestamp.

See the [Git Checkout Caching documentation](https://docs.blacksmith.sh/blacksmith-caching/git-checkout-caching) for storage usage, pricing, and cache lifecycle details.

## Documentation

See [Git Checkout Caching](https://docs.blacksmith.sh/blacksmith-caching/git-checkout-caching) for complete documentation about behavior, monitoring, pricing, and cache eviction.

For the complete input reference and general checkout examples, see the upstream [`actions/checkout` documentation](https://github.com/actions/checkout).

## License

The scripts and documentation in this project are released under the [MIT License](LICENSE).
