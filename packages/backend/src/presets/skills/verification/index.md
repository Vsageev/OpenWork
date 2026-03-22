# Verification

Verify your work before reporting completion. Do not rely on assumptions:
confirm the behavior through the same surface the user depends on.

- **User-facing surface first**: if the change is exposed through an HTTP API,
  UI, or CLI, verify through that surface before treating file inspection or
  direct service calls as evidence.
- **API endpoints**: hit every changed or relied-on endpoint with real requests.
  Check status codes and response bodies.
- **Data mutations**: after a create, update, attach, detach, or delete, fetch
  the same resource again through the API to confirm the live system sees the
  change.
- **Layered state**: when the system has multiple copies of similar data, such
  as preset files, persisted store entries, and per-agent copies, verify the
  live layer separately and say which layer was checked.
- **Scripts / CLI tools**: run with real or realistic arguments and inspect the
  output, not only the exit code.
- **File generation**: verify files exist, contain the expected content, and
  are in the correct location.
- **Edge cases**: test at least one invalid input and confirm the expected
  error response.
- **Blocked verification**: if the preferred verification path is unavailable,
  say exactly what could not be verified and why. Do not present a file diff as
  proof of live behavior.

If any check fails, fix the issue and re-verify before reporting done.
