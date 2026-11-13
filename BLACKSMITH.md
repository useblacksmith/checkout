# Blacksmith Git Mirror Cache

This document explains how the Blacksmith-optimized checkout action accelerates repository cloning through persistent git mirror caching.

## How It Works

```
                                    BLACKSMITH VM
    ┌─────────────────────────────────────────────────────────────────────────┐
    │                                                                         │
    │   ┌─────────────────────────────────────────────────────────────────┐   │
    │   │                     STICKY DISK (Persistent)                    │   │
    │   │                    /blacksmith-git-mirror/v1/                   │   │
    │   │                                                                 │   │
    │   │   ┌─────────────────────────────────────────────────────────┐   │   │
    │   │   │              BARE MIRROR (owner-repo.git)               │   │   │
    │   │   │                                                         │   │   │
    │   │   │  objects/                                               │   │   │
    │   │   │    ├── pack/                                            │   │   │
    │   │   │    │   ├── pack-abc123.pack   (compressed objects)      │   │   │
    │   │   │    │   └── pack-abc123.idx    (pack index)              │   │   │
    │   │   │    └── info/                                            │   │   │
    │   │   │  refs/                                                  │   │   │
    │   │   │    ├── heads/   (all branches)                          │   │   │
    │   │   │    └── tags/    (all tags)                              │   │   │
    │   │   │                                                         │   │   │
    │   │   └─────────────────────────────────────────────────────────┘   │   │
    │   │                            │                                    │   │
    │   └────────────────────────────│────────────────────────────────────┘   │
    │                                │                                        │
    │                                │ alternates                             │
    │                                ▼                                        │
    │   ┌─────────────────────────────────────────────────────────────────┐   │
    │   │                      WORKSPACE CHECKOUT                         │   │
    │   │                   $GITHUB_WORKSPACE/repo/                       │   │
    │   │                                                                 │   │
    │   │   .git/                                                         │   │
    │   │     ├── objects/                                                │   │
    │   │     │   └── info/                                               │   │
    │   │     │       └── alternates ──► /blacksmith-git-mirror/.../      │   │
    │   │     │                                objects                    │   │
    │   │     ├── refs/                                                   │   │
    │   │     └── HEAD                                                    │   │
    │   │                                                                 │   │
    │   │   src/                                                          │   │
    │   │   README.md                                                     │   │
    │   │   ...                                                           │   │
    │   │                                                                 │   │
    │   └─────────────────────────────────────────────────────────────────┘   │
    │                                                                         │
    └─────────────────────────────────────────────────────────────────────────┘
```

## Checkout Flow

```
    ┌──────────────────┐
    │   Workflow Run   │
    └────────┬─────────┘
             │
             ▼
    ┌──────────────────┐     No      ┌──────────────────┐
    │  Is Blacksmith   │────────────►│  Standard clone  │
    │   environment?   │             │   from GitHub    │
    └────────┬─────────┘             └──────────────────┘
             │ Yes
             ▼
    ┌──────────────────┐
    │  Request sticky  │ ◄─────── gRPC to VM agent (192.168.127.1:5557)
    │   disk from VM   │           GetStickyDisk(key: "owner-repo")
    └────────┬─────────┘
             │
             ▼
    ┌──────────────────┐
    │  Mount disk at   │
    │  /blacksmith-    │
    │    git-mirror/   │
    └────────┬─────────┘
             │
             ▼
    ┌──────────────────┐     No      ┌──────────────────┐
    │  Mirror exists?  │────────────►│  git clone       │
    │                  │             │    --mirror      │
    └────────┬─────────┘             └────────┬─────────┘
             │ Yes                            │
             ▼                                │
    ┌──────────────────┐                      │
    │  git fetch       │                      │
    │    --prune       │                      │
    └────────┬─────────┘                      │
             │                                │
             ◄────────────────────────────────┘
             │
             ▼
    ┌──────────────────┐
    │  git init in     │
    │   workspace      │
    └────────┬─────────┘
             │
             ▼
    ┌──────────────────┐
    │ Write alternates │ ◄─────── .git/objects/info/alternates
    │ file pointing to │           points to mirror/objects
    │     mirror       │
    └────────┬─────────┘
             │
             ▼
    ┌──────────────────┐
    │  git fetch from  │ ◄─────── Objects already in mirror
    │     origin       │           are NOT re-downloaded
    └────────┬─────────┘
             │
             ▼
    ┌──────────────────┐
    │  git checkout    │
    │   requested ref  │
    └────────┬─────────┘
             │
             ▼
    ┌──────────────────┐     Yes     ┌──────────────────┐
    │  dissociate:     │────────────►│  git repack -a   │
    │     true?        │             │  (copy objects)  │
    └────────┬─────────┘             └────────┬─────────┘
             │ No                             │
             ▼                                │
    ┌──────────────────┐                      │
    │  Checkout done!  │◄─────────────────────┘
    │  (fast path)     │
    └──────────────────┘
```

## Why This Is Fast

### Traditional Clone (No Cache)
```
GitHub ──────────────────────────────────────────────► Workspace
        Download ALL objects every time
        (100MB+ for large repos)
```

### With Blacksmith Mirror Cache
```
                    First Run:
GitHub ──────────────────────────────────────────────► Mirror (persistent)
        Download ALL objects once                          │
                                                          │ alternates
                    Subsequent Runs:                       ▼
GitHub ─── fetch delta only (new commits) ───────────► Mirror ───► Workspace
        (typically KB to small MB)                     (objects shared,
                                                        not copied)
```

**Key optimizations:**
1. **Bare mirror**: Stores all branches/tags, no working tree overhead
2. **Persistent storage**: Survives across workflow runs via sticky disk
3. **Alternates**: Workspace references mirror objects without copying
4. **Delta fetch**: Only new commits since last run are downloaded

## Cache Failure Semantics

The implementation is designed to be **fail-safe** - cache failures never break your workflow:

```
    ┌──────────────────┐
    │ setupCache()     │
    │ or ensureMirror()│
    │    fails         │
    └────────┬─────────┘
             │
             ▼
    ┌──────────────────┐
    │ core.warning()   │ ◄─────── "Blacksmith cache setup failed,
    │ Log the error    │           using standard checkout: <error>"
    └────────┬─────────┘
             │
             ▼
    ┌──────────────────┐
    │ cacheInfo = null │ ◄─────── Cache disabled for this run
    └────────┬─────────┘
             │
             ▼
    ┌──────────────────┐
    │ Standard clone   │ ◄─────── Falls back to normal git clone
    │ proceeds without │           from GitHub (slower but works)
    │    mirror        │
    └──────────────────┘
```

**Failure scenarios handled:**
- gRPC connection to VM agent fails
- Sticky disk unavailable
- Mirror clone/fetch fails
- Filesystem errors

**Post-job cleanup** also handles failures gracefully:
- If unmount fails: warning logged, continues
- If commit fails: warning logged, data may not persist (but workflow succeeded)

## Garbage Collection

GC runs **in the post-job cleanup phase** to avoid impacting checkout performance or VM boot time.

```
    WORKFLOW TIMELINE
    ─────────────────────────────────────────────────────────────────────────────►
    │                                                                            │
    │  VM Boot      Checkout (hot path)         User Steps        Post-job       │
    │    │               │                          │                │           │
    │    ▼               ▼                          ▼                ▼           │
    │  ┌─────┐     ┌───────────┐            ┌────────────┐    ┌────────────┐    │
    │  │Start│     │setupCache │            │ build/test │    │  git gc    │    │
    │  │ VM  │     │ensureMirror│            │   etc.     │    │--prune=now │    │
    │  └─────┘     │(fetch only)│            └────────────┘    │  unmount   │    │
    │              └───────────┘                               │  commit    │    │
    │                   │                                      └────────────┘    │
    │                   │                                            │           │
    │              NO GC HERE                              GC RUNS HERE          │
    │           (fast checkout)                          (after user code)       │
    │                                                                            │
    └────────────────────────────────────────────────────────────────────────────┘
```

### What GC Does

We run **`git gc --prune=now`** which orchestrates:
- **Repack**: Consolidates all reachable objects into optimized pack files
- **Prune**: Removes all unreachable loose objects immediately
- **Pack-refs**: Compresses refs for faster lookups
- **Reflog expire**: Cleans up old reflog entries

```
    Before GC:                              After GC:
    ┌────────────────────────────┐          ┌────────────────────────────┐
    │ pack-aaa.pack  (100MB)     │          │ pack-consolidated.pack     │
    │ pack-bbb.pack  (5MB)       │          │ (95MB - only reachable     │
    │ pack-ccc.pack  (3MB)       │    ──►   │  objects, deduplicated)    │
    │ loose objects  (2MB)       │          │                            │
    │ unreachable    (10MB)      │          │ Unreachable: removed       │
    │                            │          │                            │
    │ Total: ~120MB              │          │ Total: ~95MB               │
    └────────────────────────────┘          └────────────────────────────┘
```

### Why `--prune=now` Is Safe

Using `--prune=now` (immediate pruning) is safe in our context because:

1. **Post-job timing**: GC runs after all user workflow steps complete
2. **No concurrent writes**: The mirror is idle during cleanup
3. **Single consumer**: Only the checkout action uses the mirror

The default `git gc` uses `--prune=2.weeks.ago` to protect against concurrent processes, but that's unnecessary here.

### Why Post-Job GC?

| Phase | Operation | Impact if GC ran here |
|-------|-----------|----------------------|
| VM Boot | Mount sticky disk | Would delay job start |
| Checkout | `git fetch` | Would delay checkout |
| User Steps | build, test, etc | N/A (GC not applicable) |
| **Post-Job** | **GC + commit** | **No user impact** |

### Disk Size Growth

With GC, the mirror is bounded to approximately the size of reachable objects:
- **Repository history**: All reachable commits, trees, blobs
- **All branches and tags**: Objects referenced by any ref

Unreachable objects (from force-pushes, deleted branches) are removed immediately.

## Syncing with Upstream

The mirror stays in sync with GitHub through **incremental fetches**:

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                         BARE MIRROR                            │
    │                                                                 │
    │  Before fetch:                   After fetch:                   │
    │  refs/heads/main → abc123        refs/heads/main → def456      │
    │  refs/heads/feature → xyz789     refs/heads/feature → (deleted)│
    │                                  refs/heads/newbranch → ghi012 │
    │                                                                 │
    └─────────────────────────────────────────────────────────────────┘
                                  │
                                  │  git fetch --prune origin
                                  │
                                  ▼
    ┌─────────────────────────────────────────────────────────────────┐
    │                         WHAT HAPPENS                            │
    │                                                                 │
    │  1. Download new commits (def456, ghi012)                       │
    │  2. Update refs/heads/main to point to def456                   │
    │  3. Delete refs/heads/feature (--prune removes deleted refs)    │
    │  4. Create refs/heads/newbranch pointing to ghi012              │
    │  5. Objects from deleted branch xyz789 remain (no GC)           │
    │                                                                 │
    └─────────────────────────────────────────────────────────────────┘
```

**What syncs:**
- All branches (refs/heads/*)
- All tags (refs/tags/*)
- New commits and their objects

**What gets cleaned up (in post-job GC):**
- Redundant pack files (consolidated into single optimized pack)
- All unreachable objects (removed immediately via `git gc --prune=now`)

## Serving the Workspace with gitfs

When the job's installation has `use_gitfs_checkout` enabled, the agent
exports `BLACKSMITH_USE_GITFS=true` into the runner environment and the
action serves the workspace from the mirror with
[gitfs](https://github.com/useblacksmith/gitfs) instead of fetching and
checking it out:

1. The requested ref/commit is resolved in the mirror. If the mirror does not
   have it yet (a push it has not synced, a pull-request merge ref), only that
   ref is fetched *into the mirror*, where the regular path would have fetched
   it into the workspace.
2. `gitfs mount <mirror> --ref <sha> $GITHUB_WORKSPACE --daemon` mounts the
   tree in milliseconds. gitfs writes the real checkout out in the background
   and atomically swaps it in for the mount once it is complete (seconds, even
   for 100k-file trees); until then reads are served lazily from the mirror's
   packs and writes go straight into the tree being written.
3. `.git` is created through the mount exactly as in the regular path
   (`git init`, alternates to the mirror, `origin`, auth, the mirror's
   branch/tag refs, the local branch or detached HEAD the checkout would have
   produced) plus `git read-tree <sha>` for the index. Git is usable from the
   first step; the first `git status` verifies file contents instead of
   trusting stat data.
4. The post step takes gitfs down before the mirror sticky disk is unmounted
   (after the swap the FUSE view stays mounted on a hidden sibling path so
   processes that were inside it keep a working cwd; `gitfs unmount` removes
   it). If the job ends before the swap, the partial tree is discarded.

When the mirror lacks the revision — an empty sticky disk on the repository's
first job, a push the mirror has not synced, a pull-request merge ref — the
action does not hydrate with a blocking `git clone --mirror`. It creates an
empty bare mirror (first job) and runs `gitfs mount <mirror> --ref <rev>
--url <repo>`: gitfs fetches the revision with `--depth 1` *into the mirror*
and serves the pack as it arrives, so the step returns as soon as the commit
is in (about a second for a 28 000-file repository from GitHub); when that
pack is complete gitfs fetches the rest of the repository in the background,
and the sticky disk is committed with a complete, ordinary mirror. The post
step's `gitfs unmount` ends a fetch still in flight; a mirror left shallow
that way is completed by the next job's mount.

gitfs is only used for the plain case — Linux runner VM (not inside a
container), the mirror mounted, and no submodules, LFS, sparse checkout,
`filter` or `dissociate` — and only when the `gitfs` binary is on the PATH.
Everything else, and any gitfs failure, falls through to the regular fetch +
checkout. Because objects come from the mirror through alternates, the
workspace has the full history regardless of `fetch-depth`.

## The `dissociate` Option

When to use `dissociate: true`:

```yaml
- uses: useblacksmith/checkout@v6
  with:
    dissociate: true  # Copy objects locally
```

```
    WITHOUT dissociate (default):          WITH dissociate: true:
    ┌────────────────────────────┐         ┌────────────────────────────┐
    │      Docker Container      │         │      Docker Container      │
    │                            │         │                            │
    │   .git/objects/info/       │         │   .git/objects/            │
    │     alternates ──────────┐ │         │     pack/                  │
    │                          │ │         │       pack-xxx.pack        │
    │                          ▼ │         │     (all objects local)    │
    │                    ┌───────┴───┐     │                            │
    │                    │ MOUNT NOT │     │   No external dependency   │
    │                    │ AVAILABLE │     │                            │
    │                    │   ╳ ╳ ╳   │     └────────────────────────────┘
    │                    └───────────┘
    │   git commands fail!         │
    └────────────────────────────────┘
```

**Use `dissociate: true` when:**
- Running Docker-based actions that don't mount the cache volume
- Building container images that include the git repository
- Needing a fully self-contained checkout

**Trade-off:**
- Slower checkout (must copy all objects)
- Larger workspace (objects duplicated)
- But works in isolated environments

## Drop-in Compatibility

This action is a **drop-in replacement** for `actions/checkout@v6`:

```yaml
# Before (standard GitHub Action)
- uses: actions/checkout@v6

# After (Blacksmith-optimized - just change the org)
- uses: useblacksmith/checkout@v6
```

**Compatibility guarantees:**
- All existing inputs work identically
- Only addition: optional `dissociate` input
- Non-Blacksmith environments fall back to standard behavior
- Cache failures fall back to standard clone
