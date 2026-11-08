// SYNTHETIC LOCAL DEMO ONLY. This file is outside src/ and never built into
// the portal API package. Do not use with institutional accounts or real data.
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, Client } from "pg";
import Fastify from "fastify";
import { createApp as portalApp } from "../dist/index.js";
import { migrateFoundation } from "../dist/migrate.js";
import { closeExpiredPolls } from "../dist/expiry.js";
import { createApp as respondApp } from "../../respond-api/dist/index.js";
import { localOrigins, DEFAULT_LOCAL_ORIGINS } from "../../../packages/config/dist/local-dev.js";

const repo = resolve(import.meta.dirname, "../../..");
const localAdmin = "postgres://feedback_local_admin:feedback_local_only_not_for_production@127.0.0.1:55432/feedback_local";
const adminUrl = process.env.FEEDBACK_DEMO_DB_ADMIN_URL ?? localAdmin;
const origins = localOrigins();
if (process.env.FEEDBACK_ENABLE_SYNTHETIC_DEMO !== "yes-synthetic-only" ||
    process.env.NODE_ENV === "production" ||
    origins.portal.origin !== DEFAULT_LOCAL_ORIGINS.portal ||
    origins.respond.origin !== DEFAULT_LOCAL_ORIGINS.respond ||
    adminUrl !== localAdmin) {
  throw new Error("SETUP ERROR: synthetic demo requires an explicit flag, exact local .test origins and disposable local DB");
}

const actorNames = ["organiser", ...Array.from({length:10},(_,i)=>`student${i+1}`), "ineligible"];
const secrets = new Map();
const until = () => Date.now()+8*60*60*1000;
const session = (request) => {
  const token = /(?:^|; )__Host-session=([A-Za-z0-9_-]+)/.exec(request.headers.cookie??"")?.[1];
  const state = token && secrets.get(token);
  if (!state || Date.now()>=state.expiresAt) return null;
  return state;
};

async function privateBytes(path) {
  try {const bytes=await readFile(path);if(bytes.length!==32) throw new Error("invalid local key");return bytes;}
  catch (cause) {
    if (cause.code!=="ENOENT") throw cause;
    const bytes=randomBytes(32);
    const file=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try {await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    const dir=await open(resolve(path,".."),constants.O_RDONLY|constants.O_DIRECTORY);
    try{await dir.sync();}finally{await dir.close();}
    return bytes;
  }
}

async function start() {
  const keysDir=resolve(repo,".certs/demo-keys");
  await mkdir(keysDir,{recursive:true,mode:0o700});
  const [master,cursorKey]=await Promise.all([
    privateBytes(resolve(repo,".certs/demo-master.key")),
    privateBytes(resolve(repo,".certs/demo-cursor.key")),
  ]);
  await migrateFoundation(adminUrl); // bootstrap-only migration owner, never an API pool
  const admin=new Client({connectionString:adminUrl});await admin.connect();
  const password=randomBytes(32).toString("hex");
  const publicPassword=randomBytes(32).toString("hex");
  const closerPassword=randomBytes(32).toString("hex");
  const actors=new Map();
  try {
    for (const [role,pass,grant] of [
      ["feedback_demo_portal",password,"feedback_portal_admin"],
      ["feedback_demo_respond",publicPassword,"feedback_response_public"],
      ["feedback_demo_closer",closerPassword,"feedback_closer"],
    ]) {
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN
        CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
      END IF; END $$`);
      await admin.query(`ALTER ROLE ${role} PASSWORD '${pass}'`);
      await admin.query(`GRANT ${grant} TO ${role}`);
    }
    for (const name of actorNames) {
      const organiser=name==="organiser";
      const email=`demo-${name}@iitgn.ac.in`;
      const {rows}=await admin.query(`INSERT INTO identity.users(id,issuer,subject,email,is_organiser)
        VALUES($1,'https://accounts.google.com',$2,$3,$4)
        ON CONFLICT (issuer,subject) DO UPDATE SET email=EXCLUDED.email,is_organiser=EXCLUDED.is_organiser
        RETURNING id`,[randomUUID(),`synthetic:${name}`,email,organiser]);
      actors.set(name,{id:rows[0].id,email,isOrganiser:organiser});
    }
  } finally {await admin.end();}
  const url=(role,pass)=>`postgres://${role}:${pass}@127.0.0.1:55432/feedback_local`;
  const portalPool=new Pool({connectionString:url("feedback_demo_portal",password),max:4});
  const publicPool=new Pool({connectionString:url("feedback_demo_respond",publicPassword),max:4});
  const closerPool=new Pool({connectionString:url("feedback_demo_closer",closerPassword),max:1});
  let closing=false;
  const materialize=async()=>{
    if(closing)return;
    closing=true;
    let client;
    try {client=await closerPool.connect();await closeExpiredPolls(client);}
    finally {client?.release();closing=false;}
  };
  await materialize();
  const interval=setInterval(()=>{void materialize().catch(()=>console.error("Synthetic deadline closer unavailable"));},60_000);
  interval.unref();
  const acquire=(pool)=>async()=>{
    const client=await pool.connect();return {client,release:async()=>client.release()};
  };
  const portal=portalApp({origin:origins.portal.origin,keyDirectory:keysDir,encryptionKey:master,cursorKey,
    authenticate:async(request)=>session(request),acquireClient:acquire(portalPool)});
  const respond=respondApp({acquireClient:acquire(publicPool)});
  const demo=Fastify({logger:false,bodyLimit:128});
  demo.addHook("onRequest",async(_req,reply)=>{reply.header("Cache-Control","no-store");});
  demo.post("/__demo/login",async(request,reply)=>{
    if (request.headers.origin!==origins.portal.origin ||
        request.headers["content-type"]?.split(";")[0]!=="application/json" ||
        !request.body || typeof request.body!=="object" || Array.isArray(request.body) ||
        Object.keys(request.body).length!==1 || typeof request.body.account!=="string") {
      return reply.code(400).send({error:{code:"invalid_request",message:"invalid request"}});
    }
    const actor=actors.get(request.body.account);
    if (!actor) return reply.code(404).send({error:{code:"not_found",message:"not found"}});
    const token=randomBytes(32).toString("base64url");
    secrets.set(token,{...actor,csrfToken:randomBytes(32).toString("base64url"),expiresAt:until()});
    reply.header("Set-Cookie",`__Host-session=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
    return reply.code(204).send();
  });
  demo.post("/__demo/logout",async(request,reply)=>{
    const state=session(request);
    if (!state || request.headers.origin!==origins.portal.origin ||
        request.headers["x-csrf-token"]!==state.csrfToken) return reply.code(403).send({error:{code:"forbidden",message:"forbidden"}});
    const token=/(?:^|; )__Host-session=([A-Za-z0-9_-]+)/.exec(request.headers.cookie??"")?.[1];
    if(token) secrets.delete(token);
    reply.header("Set-Cookie","__Host-session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return reply.code(204).send();
  });
  const servers=[portal,respond,demo];
  try {
    await portal.listen({host:"127.0.0.1",port:5183});
    await respond.listen({host:"127.0.0.1",port:5184});
    await demo.listen({host:"127.0.0.1",port:5185});
  } catch(cause) {
    clearInterval(interval);
    await Promise.allSettled(servers.map((server)=>server.close()));
    await Promise.allSettled([portalPool.end(),publicPool.end(),closerPool.end()]);
    throw cause;
  }
  console.log("Synthetic-only loopback APIs ready (portal 5183, response 5184, demo auth 5185). No real participants.");
  const stop=async()=>{clearInterval(interval);await Promise.allSettled(servers.map((server)=>server.close()));
    await Promise.allSettled([portalPool.end(),publicPool.end(),closerPool.end()]);process.exit(0);};
  process.once("SIGINT",()=>{void stop();});process.once("SIGTERM",()=>{void stop();});
}
await start();
