# Comment and naming guidelines

This repository uses English for identifiers and developer documentation. Existing
comments were removed in the cleanup. These rules apply when documentation is
introduced again; they do not require a comment above every function.

## What to document

Document public contracts and details a caller cannot infer from a name or type:
units, limits, side effects, ownership, cancellation, timeout behavior and errors.
Keep implementation explanations beside the relevant code. Explain the constraint
or reason, not the statement that follows.

A private helper, straightforward accessor or thin delegation method does not need
a comment that repeats its name. Prefer a better name when that resolves the
ambiguity. Keep long architecture explanations in visible documentation rather than
repeating them across modules.

Use short, factual sentences. Do not add section banners, change histories,
self-evaluations, prompts or claims such as production-ready and bulletproof. Terms
such as fail-closed are appropriate only when the precise rejected input and
resulting behavior matter. Do not claim device testing or upstream verification
without evidence. Identify the upstream version and source when a workaround
actually depends on it.

## TypeScript and JavaScript

Use JSDoc for exported contracts and public APIs. Put the documentation immediately
before the declaration. Begin with a short description, then add separate paragraphs
for constraints that affect callers.

Use parameter, return and exception tags only when they add information beyond the
type signature. Do not repeat TypeScript types inside documentation tags. Mention
promise rejection and cancellation when they are part of the contract. Use ordinary
single-line comments for implementation explanations. Keep multiline explanations
as consecutive single-line comments, not decorative block comments.

## Python

Use triple-double-quoted docstrings for public modules, classes and callable
contracts. Start callable descriptions with an imperative verb. A short docstring
fits on one line; a longer one starts with a summary, a blank line and the details.

Use Google-style Args, Returns, Yields and Raises sections only where needed, with
four-space hanging indentation. Document accepted values and units rather than
repeating type annotations. Describe externally relevant side effects and resource
ownership. Do not duplicate a base contract in every implementation.

Use ordinary single-line comments for non-obvious implementation decisions.
Docstrings are runtime metadata, so check introspection, command help and documentation
consumers before changing or removing them.

## Tests, configuration and documentation

Test names describe the observed behavior and relevant condition. Keep assertions,
fixtures and expected values explicit. Do not add routine arrange/act/assert labels
or narrate each assertion. Explain an unusual fixture or regression only when its
reason would otherwise be lost.

Apply the same standard to scripts, workflow commands and documentation examples.
Markdown headings and visible prose are documentation, not comments. Do not hide
requirements in HTML comments. Preserve license notices, interpreter directives and
actual data containing comment-like characters.

A compiler, formatter, coverage or linter directive changes tool behavior. Prefer a
real type or code correction. When unavoidable, use the narrowest supported
configuration and explain its scope in visible documentation. Do not disable checks
globally just to make a cleanup pass.

## Naming

Keep the established conventions of each language and directory:

- TypeScript uses PascalCase for types, classes and React components, camelCase for
  functions and values, and UPPER_SNAKE_CASE for shared constants. Preserve the
  existing PascalCase module names and lowercase utility/configuration names.
- Python uses snake_case for modules, functions and variables, PascalCase for
  classes, and UPPER_SNAKE_CASE for constants. A leading underscore marks an
  internal implementation detail.
- Names describe the domain: recording, transcript, model, runtime, clipboard and
  settings. Include units where ambiguity matters, such as timeoutMs or timeout_s.
  Do not rename API fields, event names, settings keys or paths for cosmetic reasons.

## Existing tooling exceptions

Ruff permits E402 only in main.py and tests/backend/conftest.py. Both establish the
repository import path before importing backend modules; moving those imports
above the path setup breaks the isolated loader or test entrypoint.

Mypy permits missing imports only for decky_plugin and helpers. Decky supplies these
modules at runtime; they are not local dependencies. Their existing guarded import
behavior remains in place. No other missing-import policy is changed.

## Review

Before merging, check that each comment adds information, matches the implementation
and has a clear reader. Remove stale explanations when behavior changes. Run the
existing formatting, lint, type, test and package checks. Keep naming migrations and
behavioral refactoring separate from comment-only changes.

## References

These are project conventions informed by the following guides, not a claim that
all software companies use one format. The local formatter configuration takes
precedence for line width and indentation.

- [Google TypeScript Style Guide: comments and documentation](https://google.github.io/styleguide/tsguide.html#comments-and-documentation)
- [Google Python Style Guide: comments and docstrings](https://google.github.io/styleguide/pyguide.html#38-comments-and-docstrings)
- [PEP 257: docstring conventions](https://peps.python.org/pep-0257/)
- [Microsoft C# conventions: comment style](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/coding-style/coding-conventions#comment-style)

Microsoft's guide is a comparison for comment style, not a reason to use C# XML
documentation in Python or TypeScript.
