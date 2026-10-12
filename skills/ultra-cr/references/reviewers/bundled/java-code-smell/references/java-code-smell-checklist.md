# Java Review Checklist

Use these questions to guide inspection. A matched pattern is not itself a finding.

## Concurrency and lifecycle

- Who owns each executor, thread, connection and disposable resource? Which success, failure and cancellation paths release it?
- Can multiple execution paths mutate the same state? Identify the synchronization or confinement contract and a concrete conflicting schedule.
- What happens when an asynchronous stage fails, times out or is cancelled? Inspect callers before concluding an error is lost.
- Does blocking work interfere with other users of the executor? Establish the configured executor and actual workload.
- Does context stored in a thread-local reach the intended task, and is it cleared before worker reuse?

## Randomness and cryptography

- Does the use case require unpredictability, uniqueness, reproducibility or only distribution? Check the chosen API against that requirement.
- Confirm the implementation's documented concurrency and lifecycle contract before recommending reuse, pooling or thread-local caching.
- Report allocation or initialization costs only with relevant evidence. Do not replace a security requirement with a speculative performance optimization.

## Dependencies and serialization

- Compare declared and resolved dependency versions. Identify the actual missing or incompatible symbol and the affected execution path.
- Does an exclusion remove a required runtime dependency? Check the resolved build before reporting.
- Check serializer configuration, concurrent mutation and compatibility at the boundary. Prefer the project's established library when appropriate; do not mandate an organization-specific wrapper.

## Performance

- Inspect measured hot paths and realistic data sizes. Connect cost to a specific operation, call frequency and impact.
- Large methods can justify inspection; length alone cannot prove JIT failure or CPU spikes.
- Record runtime and library versions when their behavior is material to the claim.
