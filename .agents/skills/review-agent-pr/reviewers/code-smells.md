# Brief: code-smells reviewer

**Question you answer:** will this code be harder to change, understand or trust than it
needs to be?

You look for structural problems the PR introduced or made worse. Judge against the norms of
this codebase, not against absolute thresholds: a 60-line function is a smell where its
neighbours average 15, and ordinary where they average 80. Formatting and anything
machine-enforced are out of scope.

Finding prefix: `SMELL`. Category is the smell name from the lists below.

"Measured against" for a smell is the smell's definition plus the codebase evidence: the
existing function that was duplicated, the sibling files that show the norm, the call sites
that prove something is unused.

## Method

Read each changed file in full at the PR head. Then work through every family below and
record one ledger row per family per area of the diff, including the ones that pass.

### 1. Duplication (check this first and most carefully)

Reimplementing something that already exists is the most common failure of a coding agent,
because the agent did not find, or did not look for, the existing code.

For every function, class, component, hook, type, constant, query and helper the PR adds:

1. Search the codebase for an existing equivalent. Search by likely names and synonyms, by
   the signature (input and output types), and by a distinctive fragment of the logic (a
   regex, a magic number, an API path, an error string).
2. Check the shared locations the project uses: `utils`, `lib`, `common`, `shared`, `core`,
   and the dependency list for a library that already does it.
3. Look for duplication inside the PR itself: the same block pasted into several files.

Record every search under "Searches run", with its hit count, whether or not it found
anything. A duplication finding cites both locations.

### 2. Bloaters

- **Long method / large class or file:** compare what the PR added or grew to neighbouring
  code.
- **Long parameter list**, **data clumps** (the same group of values passed together
  repeatedly), **primitive obsession** (strings and numbers standing in for a domain type the
  codebase already has).

### 3. Change preventers

- **Shotgun surgery:** the PR had to make the same kind of edit in many files to achieve one
  thing. That signals a missing abstraction and predicts the next change will be as wide.
- **Divergent change:** one module now changes for unrelated reasons because the PR put a
  second responsibility in it.
- **Parallel hierarchies:** adding one thing required adding a matching thing elsewhere by
  hand.

### 4. Couplers

- **Feature envy:** new code that mostly reads or manipulates another module's data.
- **Inappropriate intimacy:** reaching into another module's internals, private fields or
  non-exported paths.
- **Message chains**, **middle man**.
- New circular dependencies, or a new dependency from a lower layer on a higher one.

### 5. Dispensables

- **Dead code:** unused functions, parameters, exports, imports, branches that cannot be
  reached. Confirm with a search for call sites before reporting.
- **Speculative generality:** options, parameters, abstractions, interfaces or config that
  nothing in the PR or the spec uses.
- **Lazy class / needless wrapper.**
- **Noise comments:** comments that restate the code or narrate the edit ("added per
  request", "new helper function", "updated to fix the bug").
- Commented-out code, leftover debug output, `TODO` and `FIXME` placeholders the PR added.

### 6. Object-orientation abusers

Switches on a type code where the codebase uses polymorphism or a lookup; refused bequest;
temporary fields; alternative classes with different interfaces for the same job.

### 7. Patterns typical of agent-written code

- **Placeholder behaviour in a production path:** stubs, hardcoded sample data, mocked
  responses, `return true`, "not implemented" branches. Severity is blocker when it sits on
  the path the spec asked for.
- **Swallowed errors:** a broad catch that logs and continues, or returns a default, to make
  a failure disappear.
- **Defence against impossible states:** null checks, fallbacks and try/catch around values
  the types or the callers already guarantee.
- **Unrequested compatibility shims:** old and new code paths both kept alive, re-exports of
  renamed things, feature flags nobody asked for.
- **Unrelated churn:** reformatting, renames or reordering in code the task did not need to
  touch. Report once, with the file list.
- **Weakened types:** `any`, casts, non-null assertions, ignore directives or lint
  suppressions added to get past a checker.

## Ledger requirements

- One "Checks performed" row per smell family, per area.
- Every duplication search under "Searches run".
- The neighbouring files you used as the norm, under "Sources read".
