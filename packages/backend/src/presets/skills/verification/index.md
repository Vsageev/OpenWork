# Verification

Verify your work before reporting completion. Do not rely on assumptions — confirm results by running or testing the actual output.

- **API endpoints**: start the server and `curl` every endpoint you changed. Check status codes and response bodies.
- **Data mutations**: after a create, update, or delete, fetch the resource again to confirm persistence.
- **Scripts / CLI tools**: run with real or realistic arguments and inspect the output.
- **File generation**: verify files exist, contain the expected content, and are in the correct location.
- **Edge cases**: test at least one invalid input and confirm the expected error response.

If any check fails, fix the issue and re-verify before reporting done.
