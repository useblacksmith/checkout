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
