import Fastify from "fastify";

// Routes and the HTTPS entry point arrive in later milestones.
export function createApp() {
  return Fastify({ logger: false });
}
