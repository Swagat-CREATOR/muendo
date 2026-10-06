Read @plot.md at the start of every session and follow its rules.

# Mewndo version 1

The product spec is docs/spec.md and is the source of truth. Sections 21 to 31 describe version 1.
These rules add to the ones in plot.md:

1. The v0 Node engine stays as the reference until the new Rust core passes every v0 test.
2. Never weaken or delete an existing test to make something pass.
3. Every network call to a model has a deadline and a rule-based fallback, as in spec section 29.4.
4. Never store passwords, keys or secret files.
5. Every feature states honestly what it can't do, matching spec section 28.10.
6. Free tiers first; no paid service without asking the user.
