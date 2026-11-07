# Private native RSA-RAW signer (SPEC.md §6). Loopback only; no outbound network.
# Override the listen address with `--socket-addr http=127.0.0.1:<port>`; never bind a public interface.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "signer", worker = .signerWorker),
    (name = "no-network", network = (allow = [])),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8790", http = (), service = "signer"),
  ],
);

const signerWorker :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "dist/worker.js")],
  compatibilityDate = "2026-10-01",
  globalOutbound = "no-network",
  bindings = [(name = "SIGNER_SERVICE_TOKEN", fromEnvironment = "SIGNER_SERVICE_TOKEN")],
);
