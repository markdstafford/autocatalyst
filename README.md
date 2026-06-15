# Autocatalyst

Autocatalyst runs an AI-led loop from a filed issue to a merged pull request, reserving human
attention for the decisions that compound: what to build, whether the spec is right, and whether the
result works.

## Status

Pre-implementation. The architecture decisions and concept docs are settled, and the build proceeds as
a sequence of issues, each a vertically complete capability that lands as one pull request.

## Documentation

`AGENTS.md` is the entry point and map. From it:

- [`context-human/spec.md`](context-human/spec.md) — the central technical overview.
- [`context-human/app.md`](context-human/app.md) — the product overview: what the system is and why.
- [`context-human/concepts/`](context-human/concepts/index.md) — the architectural contracts.
- [`context-human/adrs/`](context-human/adrs/index.md) — the architecture decision records.

## Real runner dispatch

Real runner dispatch is opt-in for the control-plane entrypoint. See
[`docs/operators/real-dispatch.md`](docs/operators/real-dispatch.md) for startup flags, environment
variables, and a Grove-backed Claude Agent SDK provider-profile example.

## Contributing

Autocatalyst is in early development and is not accepting external contributions yet. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

No license is granted yet; all rights reserved. A license will be added before the project opens to
outside use or contribution.
