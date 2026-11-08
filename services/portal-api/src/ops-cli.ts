// Operator command line (SPEC.md §5 organiser provisioning, §15 withdrawal,
// retention and recovery). Not a network endpoint. Prints counts and poll IDs
// only, never identities, answers or key material.
//
//   node dist/ops-cli.js migrate                         (deployment-only migration-owner credential)
//   node dist/ops-cli.js init-journal
//   node dist/ops-cli.js check-sync
//   node dist/ops-cli.js withdraw <pollId> <reason>
//   node dist/ops-cli.js check-keys [--withdraw]
//   node dist/ops-cli.js provision-organiser <google-subject> | revoke-organiser <google-subject>
//   node dist/ops-cli.js retention
//   node dist/ops-cli.js recover [--withdraw-closed]     (offline, ingress disabled, migration-owner credential)
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Client } from "pg";
import { assertJournalInSync, readJournal, WITHDRAW_REASONS } from "./journal.js";
import { migrateFoundation } from "./migrate.js";
import { findMissingKeys, recoverDeployment, runRetention, setOrganiser, withdrawPoll, type WithdrawReason } from "./operations.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`SETUP ERROR: ${name} is required`);
  return value;
}
async function connect(variable: string): Promise<Client> {
  const client = new Client({ connectionString: required(variable) });
  await client.connect();
  return client;
}
const usage = () => { throw new Error("usage: ops-cli <migrate|init-journal|check-sync|withdraw|check-keys|provision-organiser|revoke-organiser|retention|recover> …"); };

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === "migrate") {
    await migrateFoundation(required("FEEDBACK_MIGRATION_DB_URL"));
    console.log("migrations applied");
    return;
  }
  const journalPath = required("FEEDBACK_JOURNAL_PATH");
  const keyDirectory = () => required("FEEDBACK_KEY_DIRECTORY");
  switch (command) {
    case "init-journal": {
      // A new deployment starts with an empty journal; an existing one is never replaced.
      const file = await open(journalPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.sync(); } finally { await file.close(); }
      console.log("recovery journal created (empty)");
      return;
    }
    case "check-sync": {
      const client = await connect("FEEDBACK_OPERATOR_DB_URL");
      try { await assertJournalInSync(client, journalPath); console.log(`in sync at entry ${(await readJournal(journalPath)).seq}`); }
      finally { await client.end(); }
      return;
    }
    case "withdraw": {
      const [pollId, reason] = args;
      if (!pollId || !(WITHDRAW_REASONS as readonly string[]).includes(reason)) {
        throw new Error(`usage: withdraw <pollId> <${WITHDRAW_REASONS.join("|")}>`);
      }
      const client = await connect("FEEDBACK_OPERATOR_DB_URL");
      try { console.log(`${pollId}: ${await withdrawPoll({ client, journalPath, keyDirectory: keyDirectory() }, pollId, reason as WithdrawReason)}`); }
      finally { await client.end(); }
      return;
    }
    case "check-keys": {
      const client = await connect("FEEDBACK_OPERATOR_DB_URL");
      try {
        const context = { client, journalPath, keyDirectory: keyDirectory() };
        const missing = await findMissingKeys(context);
        for (const { pollId, state } of missing) console.log(`missing private key: ${pollId} (${state})`);
        if (args.includes("--withdraw")) {
          for (const { pollId } of missing) console.log(`${pollId}: ${await withdrawPoll(context, pollId, "key_loss")}`);
        }
        console.log(`${missing.length} live poll(s) with a missing key`);
        if (missing.length > 0 && !args.includes("--withdraw")) process.exitCode = 2;
      } finally { await client.end(); }
      return;
    }
    case "provision-organiser":
    case "revoke-organiser": {
      if (args.length !== 1) usage();
      const client = await connect("FEEDBACK_OPERATOR_DB_URL");
      try {
        const found = await setOrganiser(client, args[0], command === "provision-organiser");
        console.log(found ? "organiser flag updated" : "no account with that Google subject has signed in yet");
        if (!found) process.exitCode = 2;
      } finally { await client.end(); }
      return;
    }
    case "retention": {
      const client = await connect("FEEDBACK_RETENTION_DB_URL");
      try { console.log(JSON.stringify(await runRetention({ client, journalPath, keyDirectory: keyDirectory() }))); }
      finally { await client.end(); }
      return;
    }
    case "recover": {
      const client = await connect("FEEDBACK_MIGRATION_DB_URL");
      try {
        const report = await recoverDeployment({ client, journalPath, keyDirectory: keyDirectory() },
          { withdrawClosed: args.includes("--withdraw-closed") });
        console.log(JSON.stringify(report));
      } finally { await client.end(); }
      return;
    }
    default: usage();
  }
}

main(process.argv.slice(2)).catch((cause: unknown) => {
  // Generic message only: database errors can carry statement parameters.
  console.error(cause instanceof Error && /^(SETUP ERROR|usage|recovery journal|database and)/.test(cause.message)
    ? cause.message : "operation failed");
  process.exitCode = 1;
});
