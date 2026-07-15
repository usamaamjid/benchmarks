// Measures how $in degrades as the ObjectId array grows, against a real mongod.
// Captures explain() plans — the mechanism, which is hardware-independent — plus
// wall-clock timings, which are not (noted as such in the writeup).
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, ObjectId } from "mongodb";

const MONGO_VERSION = "8.2.6";
const DOCS = 500_000;
const SIZES = [10, 100, 1_000, 5_000, 10_000, 50_000, 100_000];
const REPEATS = 3;

const log = (...a) => console.log(...a);

async function seed(col) {
  log(`Seeding ${DOCS.toLocaleString()} docs...`);
  const t0 = Date.now();
  const merchants = Array.from({ length: 500 }, () => new ObjectId());
  let batch = [];

  for (let i = 0; i < DOCS; i++) {
    batch.push({
      _id: new ObjectId(),
      merchantId: merchants[i % merchants.length],
      status: ["pending", "paid", "refunded", "failed"][i % 4],
      amount: Math.round(Math.random() * 100000),
      createdAt: new Date(Date.now() - Math.random() * 3.15e10),
    });
    if (batch.length === 10_000) {
      await col.insertMany(batch, { ordered: false });
      batch = [];
    }
  }
  if (batch.length) await col.insertMany(batch, { ordered: false });

  await col.createIndex({ merchantId: 1 });
  await col.createIndex({ merchantId: 1, status: 1 });
  log(`  seeded + indexed in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

// Pull real _ids so the $in actually matches — a $in of random ObjectIds would
// short-circuit on empty index bounds and measure nothing.
async function sampleIds(col, n) {
  const docs = await col.find({}, { projection: { _id: 1 } }).limit(n).toArray();
  return docs.map((d) => d._id);
}

function planOf(explain) {
  const stages = [];
  let s = explain.executionStats?.executionStages || explain.queryPlanner?.winningPlan;
  // Walk down whichever nesting this server version uses.
  const walk = (node) => {
    if (!node) return;
    if (node.stage) stages.push(node.stage);
    walk(node.inputStage);
    (node.inputStages || []).forEach(walk);
  };
  walk(s);
  return stages.join(" ← ") || "?";
}

async function timeQuery(col, filter) {
  const runs = [];
  let ex;
  for (let i = 0; i < REPEATS; i++) {
    const t0 = process.hrtime.bigint();
    await col.find(filter).toArray();
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  ex = await col.find(filter).explain("executionStats");
  return { ms: Math.min(...runs), explain: ex };
}

async function run() {
  log("Starting real mongod (mongodb-memory-server)...");
  // Pinned: the published numbers came from 8.2.6, and mongodb-memory-server's
  // default version drifts between releases. Reproducing the post's results
  // means reproducing its engine.
  const mongod = await MongoMemoryServer.create({ binary: { version: MONGO_VERSION } });
  const client = await MongoClient.connect(mongod.getUri());
  const col = client.db("bench").collection("orders");
  log(`  mongod ${await client.db("admin").command({ buildInfo: 1 }).then((b) => b.version)}\n`);

  await seed(col);

  const results = [];
  log("=== $in on _id (primary index) ===\n");
  log("  IDs        ms    keysExam  docsExam  returned  plan");
  log("  " + "─".repeat(78));

  for (const n of SIZES) {
    const ids = await sampleIds(col, n);
    const { ms, explain } = await timeQuery(col, { _id: { $in: ids } });
    const st = explain.executionStats;
    log(
      `  ${String(n).padStart(7)}  ${ms.toFixed(1).padStart(7)}  ${String(st.totalKeysExamined).padStart(8)}  ` +
        `${String(st.totalDocsExamined).padStart(8)}  ${String(st.nReturned).padStart(8)}  ${planOf(explain)}`
    );
    results.push({ field: "_id", n, ms, keys: st.totalKeysExamined, docs: st.totalDocsExamined, plan: planOf(explain) });
  }

  log("\n=== $in on merchantId (secondary index, low cardinality) ===\n");
  log("  IDs        ms    keysExam  docsExam  returned  plan");
  log("  " + "─".repeat(78));

  const merchants = await col.distinct("merchantId");
  for (const n of [10, 100, 500]) {
    const ids = merchants.slice(0, n);
    const { ms, explain } = await timeQuery(col, { merchantId: { $in: ids } });
    const st = explain.executionStats;
    log(
      `  ${String(n).padStart(7)}  ${ms.toFixed(1).padStart(7)}  ${String(st.totalKeysExamined).padStart(8)}  ` +
        `${String(st.totalDocsExamined).padStart(8)}  ${String(st.nReturned).padStart(8)}  ${planOf(explain)}`
    );
  }

  // Does chunking a big $in actually beat one big $in?
  log("\n=== 10k IDs: one $in vs chunked ===\n");
  const big = await sampleIds(col, 10_000);
  const one = await timeQuery(col, { _id: { $in: big } });
  log(`  single $in (10,000):        ${one.ms.toFixed(1)} ms`);

  for (const chunk of [500, 1_000, 2_500]) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < big.length; i += chunk) {
      await col.find({ _id: { $in: big.slice(i, i + chunk) } }).toArray();
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    log(`  chunked @ ${String(chunk).padStart(5)} (${String(Math.ceil(big.length / chunk)).padStart(2)} queries): ${ms.toFixed(1)} ms`);
  }

  // Where does the query document itself hit the 16MB BSON ceiling?
  log("\n=== BSON query-document size ===\n");
  for (const n of [10_000, 100_000, 1_000_000]) {
    const bytes = n * 12 + n * 8 + 64; // ObjectId payload + per-element array overhead
    log(`  ${String(n).padStart(9)} ObjectIds ≈ ${(bytes / 1e6).toFixed(2)} MB ${bytes > 16e6 ? "❌ over 16MB limit" : "✅"}`);
  }

  log("\n=== RAW explain() — _id $in with 10,000 ===\n");
  const ids10k = await sampleIds(col, 10_000);
  const ex = await col.find({ _id: { $in: ids10k } }).explain("executionStats");
  log(JSON.stringify({
    winningPlan: ex.queryPlanner.winningPlan,
    executionTimeMillis: ex.executionStats.executionTimeMillis,
    totalKeysExamined: ex.executionStats.totalKeysExamined,
    totalDocsExamined: ex.executionStats.totalDocsExamined,
    nReturned: ex.executionStats.nReturned,
  }, null, 1).slice(0, 2200));

  await client.close();
  await mongod.stop();
  log("\nDone.");
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
