# IITGN Anonymous Feedback & Polls

**Current status: Milestone 0.1 scaffold only. Not ready for participants or deployment.** There is no authentication, signing, submission, HTTPS setup, database, or results endpoint yet.

- [`SPEC.md`](SPEC.md): product, privacy, protocol, and release contract.
- [`PLAN.md`](PLAN.md): milestone sequence and test-first workflow.

## Prerequisites

Node.js 24 and npm. From the repository root:

```sh
npm ci
npm run typecheck
npm run build
```

The workspace has two separate browser packages (`apps/portal` and `apps/respond`) and two API packages (`services/portal-api` and `services/respond-api`). The browser pages display scaffold notices; API packages export empty Fastify app factories without starting listeners. The private native signer and local HTTPS/PostgreSQL environment belong to later work packages; none of these scaffolds establish the privacy guarantees in `SPEC.md`.
